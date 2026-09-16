# Setting up Cloudflare R2 for Rescript Interviews

From nothing to a verified bucket. About twenty minutes, most of it waiting
for a card to be accepted.

You will end up with **two buckets** — production and development — one API
token scoped to both, and eight environment variables in Vercel. At the end
you run one command that proves it all works, rather than finding out from a
candidate who could not upload.

> **I never see your keys, and nothing here asks you to paste one into a chat.**
> The secret goes from Cloudflare's screen straight into Vercel's, and the
> verifier reads it from your own shell.

---

## Part 1 — The Cloudflare account

1. Go to **dash.cloudflare.com/sign-up**. Email and a password; confirm the
   email.
2. You will be asked to add a website. **Skip it** — R2 does not need one.
   If the flow insists, there is a "Continue without a website" / "I'll do
   this later" link at the bottom.
3. In the left sidebar under **Build**, choose **Storage & databases → R2 Object Storage**.
   (It used to be a top-level item; the current dashboard nests it.)
4. Click **Purchase R2** / **Enable R2**. It asks for a payment card.

   R2's free tier is 10 GB of storage, 1 million writes and 10 million reads
   per month, and it does not expire. Cloudflare still requires a card on
   file to turn the product on. Nothing is charged until you pass those
   limits, and there are **no egress fees at all** — which is the reason to
   use R2 rather than S3 for video, and is worth roughly the whole bill at
   any real volume.

   A rough sense of scale: a five-minute interview answer at the bitrate this
   product records is about 36 MB, so 10 GB is around 280 answers. Past that
   it is **$0.015 per GB per month** — 100 GB of recordings is $1.50 a month.

5. Note your **Account ID**. It is on the R2 overview page on the right, and
   in the URL: `dash.cloudflare.com/<account-id>/r2`. It is a 32-character
   hex string. This is not a secret — it goes in `R2_ACCOUNT_ID`.

---

## Part 2 — The buckets

Create two. §30 of the brief is explicit that production buckets must not be
used for development, and two buckets is the cheapest way to make that true —
R2 bills by what is stored, not per bucket, so an empty second bucket costs
nothing.

1. **R2 → Create bucket**
2. Name: **`rescript-interviews-prod`**
3. Location: **Automatic**, unless you have a legal reason to pin a
   jurisdiction — if candidate recordings must stay in the EU, choose
   **European Union (EU)** here. This cannot be changed later.
4. Default storage class: **Standard**.
5. Create. Then repeat for **`rescript-interviews-dev`**.

### Leave public access OFF

On each bucket: **Settings → Public access**. It should say *Not allowed* for
both `r2.dev` and any custom domain. Do not turn it on.

Every recording is reached through a short-lived signed URL minted after an
authorization check. A publicly readable bucket would make every candidate's
interview one guessed URL away from anybody, and the verifier in Part 6
checks for exactly this.

### Abort incomplete uploads automatically

On each bucket: **Settings → Object lifecycle rules → Add rule**.

- Name: `abort-incomplete-uploads`
- Apply to: all objects
- Action: **Abort incomplete multipart uploads** after **7 days**

The application aborts its own abandoned uploads, but a browser that closes
mid-transfer sends no request to tell anybody. Without this rule those parts
sit in the bucket being billed for, invisibly, for ever.

### Delete old recordings automatically (optional, recommended)

A second rule on the production bucket, as a backstop under the application's
own retention policy:

- Name: `belt-and-braces-retention`
- Action: **Delete objects** after **400 days**

The product deletes on its own schedule from `interview_projects.retention_days`.
This rule exists so that a bug in that sweep cannot mean recordings are kept
for ever — it is deliberately much longer than any retention policy you would
set, so it never fires in normal operation.

---

## Part 3 — CORS

This is the step people skip, and it is the one that produces the strangest
bug: short answers upload fine and long ones fail silently.

On **each** bucket: **Settings → CORS policy → Edit → paste**:

```json
[
  {
    "AllowedOrigins": [
      "https://interviews-lemon.vercel.app",
      "http://localhost:3002"
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 86400
  }
]
```

Replace the first origin with your actual Vercel URL once you know it. Keep
`http://localhost:3002` on the **dev** bucket only; take it off production.

**`ExposeHeaders: ["ETag"]` is not optional.** A multipart upload is completed
by naming each part and the ETag the store issued for it. Browsers hide every
response header except a short safelist unless the server says otherwise — so
without this line the browser reads no ETag, the completion names no parts,
and a long answer fails while a short one (a single PUT, no parts, no ETags
needed) works perfectly. That asymmetry is why it is so hard to diagnose.

### Preview deployments

Vercel gives every preview deploy a different random URL, so a fixed origin
list cannot match them. Two honest options:

- **Do nothing.** Preview deploys cannot upload. Fine if you test on
  localhost and production.
- Add `"https://*.vercel.app"` to the **dev** bucket's origins only. Never on
  production — it would let any site on `vercel.app` make credentialed
  requests to your candidate recordings.

---

## Part 4 — The API token

**R2 → API → Manage API tokens.** Two buttons appear, and the choice matters:

- **Create Account API token** ← use this one
- Create User API token — bound to your personal login. Cloudflare's own
  wording: *"become inactive if you leave the organization."* If that account
  is ever removed or renamed, every candidate upload fails at once, mid
  interview, with a 403 that looks exactly like a code bug. Use it only for
  throwaway local experiments.

- Token name: `rescript-interviews`
- Permissions: **Object Read & Write**
- Specify bucket: **Apply to specific buckets** → tick
  `rescript-interviews-prod` and `rescript-interviews-dev`
- TTL: **Forever** (or set a reminder to rotate)
- Client IP filtering: leave empty — Vercel's egress addresses are not fixed.

Create it. The next screen shows, once and never again:

| Cloudflare shows | Goes into |
|---|---|
| **Access Key ID** | `R2_ACCESS_KEY_ID` |
| **Secret Access Key** | `R2_SECRET_ACCESS_KEY` |
| Endpoint for S3 clients | you only need the account id from it |

**Copy both now.** Closing that page means creating a new token.

Choose **Object Read & Write**, not Admin. Admin can create and delete
buckets; the application never needs to, and a token that cannot delete a
bucket is a token that cannot be used to delete one.

---

## Part 5 — The variables, in Vercel

Create the Vercel project first if you have not: **Add New → Project**, import
the repo, and set **Root Directory** to `apps/interviews`. Vercel will detect
Next.js. It will fail its first build until the variables below exist — that
is expected.

**Project → Settings → Environment Variables.** Ten of them:

| Name | Value | Environments |
|---|---|---|
| `SUPABASE_URL` | the same as your Studio project | all |
| `SUPABASE_SERVICE_ROLE_KEY` | the same as your Studio project | all |
| `R2_ACCOUNT_ID` | your 32-char account id | all |
| `R2_BUCKET` | `rescript-interviews-prod` | **Production** |
| `R2_BUCKET` | `rescript-interviews-dev` | **Preview** and **Development** |
| `R2_ACCESS_KEY_ID` | from Part 4 | all |
| `R2_SECRET_ACCESS_KEY` | from Part 4 | all — tick **Sensitive** |
| `R2_REGION` | `auto` | all |
| `INTERVIEWS_PUBLIC_URL` | `https://interviews-lemon.vercel.app` | Production |
| `NEXT_PUBLIC_STUDIO_URL` | `https://rescriptstudio.vercel.app` | all |

`R2_BUCKET` is deliberately listed twice with different scopes — that one
line is what keeps preview deploys out of the production bucket. Vercel lets a
variable have a different value per environment; set it as two entries.

Tick **Sensitive** on `R2_SECRET_ACCESS_KEY` and `SUPABASE_SERVICE_ROLE_KEY`
so they cannot be read back out of the dashboard afterwards.

`INTERVIEWS_PUBLIC_URL` is what the invite route builds candidate links from,
and what a sign-in code is bound to. Get it wrong and the links point somewhere
that does not exist and nobody can sign in.

### One more, on the STUDIO project

Interviews cannot read the Studio's session cookie — it is host-only, and
`vercel.app` is on the Public Suffix List, so no shared cookie domain is
possible. Sign-in goes through a single-use code instead, and the Studio must
be told which application may receive one:

| Name | Value | Environments |
|---|---|---|
| `AUTH_HANDOFF_ORIGINS` | `https://interviews-lemon.vercel.app` | all |

Exactly that string, no trailing slash. Redeploy the Studio afterwards.
[AUTH-HANDOFF.md](./AUTH-HANDOFF.md) explains the mechanism.

Then **Deployments → Redeploy**. Environment variables are baked in at build
time; changing one does nothing until you redeploy.

### The database migrations

Before the first real interview, run against your Supabase project, in order:

```
supabase/migrations/0030_interviews.sql
supabase/migrations/0031_billing_subject.sql
```

**0031 alters live billing.** Run `scripts/billing-sql-test.sql` and
`scripts/billing-central-wallet-sql-test.sql` against a copy of the database
first. Both pass here against PostgreSQL 16 with the full chain applied.

---

## Part 6 — Prove it works

From the repo on your own machine, with the dev bucket:

Put the four settings in a file at the top of the repo — no shell quoting to
get wrong, and a 64-character secret does not end up in your shell history:

```bash
cd ~/Downloads/rescript-push
cat > .env.r2 <<'EOF'
R2_ACCOUNT_ID=your-32-character-account-id
R2_BUCKET=rescript-interviews-dev
R2_ACCESS_KEY_ID=your-access-key-id
R2_SECRET_ACCESS_KEY=your-secret-access-key
EOF

node scripts/r2-check.mjs http://localhost:3002
```

`.env.r2` is in `.gitignore`, so it cannot be committed by accident. Delete it
when you are done, or keep it for the next time you rotate the token.

On a fresh clone the script builds `@rescript/storage` for you the first time
— `dist/` is not committed. It needs `pnpm` on your PATH
(`npm install -g pnpm` if not).

Exported environment variables still win over the file, so a one-off
`R2_BUCKET=rescript-interviews-prod node scripts/r2-check.mjs …` works without
editing anything.

It does the real thing, against the real bucket: a signed PUT, a HEAD, a
presigned GET fetched over the network, a two-part multipart upload assembled
and size-checked, an abort, a prefix listing, a CORS preflight shaped exactly
as a browser sends it, a check that an **unsigned** request is refused, and a
delete of everything it made.

```
  credentials reach the bucket                  ok   authenticated
  upload an object                              ok   1024 bytes
  read it back with HEAD                        ok   etag 9f2c1ab4e…
  presign a download URL                        ok   5 minutes
  fetch that URL over the network               ok   bytes match
  presign an upload URL and PUT to it           ok   2048 bytes, verified
  multipart: create, two parts, complete        ok   2 parts, 6 MiB assembled
  multipart: abandon one cleanly                ok   parts released
  list objects under a prefix                   ok   3 objects
  CORS preflight, as a browser sends it         ok   origin allowed, ETag exposed
  public access is OFF                          ok   unsigned request refused (401)
  delete everything this check created          ok   bucket is clean
```

Then repeat against production:

```bash
R2_BUCKET=rescript-interviews-prod node scripts/r2-check.mjs https://your-app.vercel.app
```

**Run it on your Mac, not in a Claude session** — this container's network
allowlist does not include Cloudflare, so it would fail for reasons that have
nothing to do with your configuration.

### What the failures mean

| It says | It is |
|---|---|
| `NoSuchBucket` | the name in `R2_BUCKET` is not the name of a bucket. Check it character by character. |
| `AccessDenied` on the first check | the token is not scoped to this bucket. Cloudflare's "specific buckets" list must include it by name. |
| `SignatureDoesNotMatch` | usually a truncated secret from a copy-paste, occasionally a machine clock more than 15 minutes out. |
| CORS: no `Access-Control-Allow-Origin` | the policy is not saved on **this** bucket. It is per bucket, not per account. |
| CORS: `ExposeHeaders does not include ETag` | Part 3's line is missing. Long answers will fail and short ones will not. |
| `an UNSIGNED request read the object` | public access is on. Turn it off before any real candidate records anything. |
| `export: not an identifier:` from your shell | a pasted `export` line wrapped. Use the `.env.r2` file above instead — that is what it is for. |

---

## Running it locally with no R2 at all

You do not need Cloudflare to develop:

```bash
INTERVIEWS_STORAGE=memory pnpm --filter @rescript/interviews-app dev
```

That selects the in-memory provider — a real object store that issues real
etags, refuses unsigned URLs, and speaks enough S3 over HTTP that a browser
can upload to it. It is refused in production unless you explicitly override
it, because a deployment that silently kept every recording in a process's
heap would lose them all on the next deploy and nobody would find out until a
candidate asked.

---

## Rotating the token

Cloudflare tokens cannot be edited, only replaced.

1. Create a second token with the same permissions.
2. Update `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in Vercel, redeploy.
3. Run the verifier against both buckets.
4. Delete the old token.

In that order. Deleting first means every upload in flight fails, and an
upload in flight is somebody's interview answer.
