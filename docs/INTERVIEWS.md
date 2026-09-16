# Rescript Interviews — Phase 1 & 2

A second product in the Rescript ecosystem: recorded interviews, stored in
Cloudflare R2, transcribed and reviewed. Independently deployable, sharing the
account, the tenant and the wallet with Rescript Studio and nothing else.

This document covers what exists after Phases 1 and 2 of the brief's own
implementation order — **Foundation** and **Recording** — and says exactly
what is not built yet.

---

## What was reused rather than rebuilt

The audit came first, and it changed the plan. Four things already existed and
are used as they are:

| | |
|---|---|
| **Authentication** | The Studio's opaque `rescript_session` cookie, verified server-side on every request against `user_sessions`. Interviews has no sign-in of its own — a second authentication system is a second place to get authentication wrong. |
| **Tenancy** | `customers` and `profiles`. An interview project belongs to a workspace exactly as a survey does. |
| **Wallet and metering** | `packages/billing` entire: wallets, reserve/settle, the rate card, TEST/LIVE pricing, per-project budgets. |
| **The upload shape** | `packages/media`'s ticket → direct browser upload → **verify before believe**, and its transcription job claimed with `for update skip locked`. The pattern is reused; the code is not, because the storage layer is different. |

Three things did not fit and were changed rather than worked around. Each is
documented at the point of change.

---

## 1. `@rescript/storage` — the provider abstraction

Everything the product knows about object storage is one interface with
thirteen methods (`MediaStorageProvider`). Three implementations of the
contract exist: R2, an in-memory double, and nothing else — and no route
imports a provider class directly, only `lib/storage.ts`.

**SigV4 is hand-rolled** on `node:crypto`, ~180 lines, no `@aws-sdk`. The
repository has no HTTP client at all and `packages/media` has zero runtime
dependencies; ten megabytes of SDK to do two screens of arithmetic would be
the largest thing in the package. It is checked against **AWS's four published
test vectors** — canonical request, string-to-sign and signature each asserted
separately, because a bug in canonicalisation produces a wrong signature and a
test that only checked the signature against our own canonicalisation would
agree with the bug.

**Signed URLs cap at 7 days.** The survey product hands out one-year and
five-year Supabase URLs; S3-compatible stores cannot express that, and the
limit is a better design than the permission. Playback URLs are minted on
demand behind an authorization check and live 15 minutes. There is no
`getPublicUrl` method, and its absence is load-bearing: §13 says no
predictable permanent public URL may exist, and the cheapest way to keep that
promise is to give the application no way to break it.

**The in-memory provider speaks HTTP.** It is not a mock — it issues real
etags, refuses a completion naming an etag it did not issue, refuses an
unsigned or expired URL, and can be told to fail every Nth write. A browser
can upload to it. That is what makes the upload path testable without a
Cloudflare account.

66 tests.

---

## 2. The billing subject — `(subject_kind, subject_id)`

Money, rates, wallets and ledgers were never survey-specific. Three things
were, and all three named the survey directly:

1. `project_spending.survey_id` was a primary key **referencing** `surveys`,
   so an interview project could not have a spending policy at all;
2. `rescript_billing_wallet_for` read `public.surveys` to find the owner whose
   personal wallet funds the work;
3. `usage_reservations` / `usage_events` recorded `survey_id` with no way to
   say what kind of thing it was.

Migration `0031` makes the subject a pair. Every existing function keeps its
name and its signature — `rescript_billing_wallet_for` is now one line
delegating to `rescript_billing_subject_wallet_for` — so every existing call
site is untouched. The column is **renamed** rather than reused, because
letting `survey_id` quietly hold an interview id is the one-value-two-meanings
mistake this codebase keeps removing.

The foreign key had to go (a column that points at two tables cannot have
one); the CASCADE it provided is restored as an after-delete trigger on each
subject table, and tested.

**An idempotency key was added to `usage_events`** while the surgery was open.
There was no protection against double-charging on retry anywhere in billing —
`Meter.record` double-charged by construction — which was survivable while
every meter was driven by a person waiting for a page, and is not survivable
for a job queue where retrying is the normal case.

Proof that survey billing is unchanged: `billing-sql-test.sql`,
`billing-central-wallet-sql-test.sql`, `billing-transfer-sql-test.sql` and
`access-sql-test.sql` all pass unmodified against a database with the new
migrations, and `packages/billing`'s 31 unit tests are green.

---

## 3. The schema — `0030_interviews.sql`

Fifteen tables, all new, nothing existing altered. RLS deny-all, service role
only, `REVOKE` on every function — the arrangement `0026_least_privilege`
arrived at after a `SECURITY DEFINER` function callable with the anon key
turned out to be a complete authentication bypass.

Two rules the schema exists to enforce:

**No binary lives here.** `interview_media` holds a provider, a key and the
**store's own** byte count. The bytes are in R2.

**A randomised sequence is recorded, not recomputed.** §8 asks that a
completed interview's question order be reproducible for audit. Storing a seed
and re-running the draw is reproducible *until somebody edits the pool*, and
then the audit record quietly becomes fiction. So `interviews.question_sequence`
is written once, at start, and `explainDraw` compares it against the bank as it
stands today — reporting a difference rather than hiding one.

The candidate's link is stored as a **SHA-256 hash** with an 8-character
prefix for support conversations. It is shown once and cannot be recovered;
losing one is a re-issue.

---

## 4. `@rescript/interviews` — the domain, with no database in it

| File | What it owns |
|---|---|
| `selection.ts` | The reproducible draw. xoshiro128** seeded from the interview id — not `Math.random`, which promises nothing across machines. Fisher–Yates, not `sort(() => r - .5)`, which is measurably lopsided and would make the same two questions come up more often than the rest. |
| `flow.ts` | The interview and response state machines. `stored` is reachable **only** from `uploading`, and the test asserts that every other transition into it throws — that is §9's "do not allow the user to believe an answer is safely stored", made impossible to express. |
| `telemetry.ts` | 38 event kinds, each with a **neutral** sentence. No `suspicious`, no score, no aggregate. A test asserts none of the wording contains a judgement. |
| `evidence.ts` | The hallucination check (below). |
| `limits.ts` | §22's caps, the warning at four fifths, retention arithmetic, job backoff. |
| `uploader.ts` | The upload protocol, browser-safe and testable. |

### The hallucination check

§15 says the system must never invent candidate evidence. That cannot be a
phrase in a prompt — a model asked "does this person have AWS experience?"
will produce a confident paragraph either way. So it is a check on the output
that fluency cannot satisfy:

> every claim carries a quote, and every quote must appear **verbatim** in the
> transcript it is attributed to.

`verifyEvidence` downgrades anything that fails to `insufficient` with a
reason, and does not show the fabricated quote. Matching survives tidied
punctuation, curly quotes and case; it does **not** survive a paraphrase or a
reordered sentence, which are exactly the fabrications it exists to catch.

The third verdict is `insufficient`, not `not_met`. "We did not find enough in
this interview to say" and "this person does not have this skill" are different
claims, and only the first is supportable from twenty minutes of answers.

---

## 5. The recording path

```
candidate's browser
   │  MediaRecorder, 5s timeslice, 720p @ 900 kbps + 96 kbps audio
   │  plus a SECOND audio-only recorder at 64 kbps — that companion is what
   │  gets transcribed, because a 36 MB video is not something to hand a
   │  provider that accepts 25 MB
   ▼
PartAccumulator ── 8 MiB ──▶ PUT direct to R2   (signed, one part, one key)
   │                                              parts go WHILE recording
   ▼
/api/candidate/upload/complete
   │  assemble, then HEAD the object
   ▼
interview_media.upload_status = 'stored'   ← the only thing that says "Saved"
```

**The bytes never touch the application server.** It authorizes, writes the
row, signs URLs and verifies.

**The row is written before the URL is issued.** If the browser closes
mid-transfer there is no request to tell us — the `pending` row is the only
evidence the upload was ever begun, and `rescript_interview_abandoned_uploads`
reads exactly that.

**Resume asks the store.** There is no client-side ledger of parts sent. A
part the browser believes it sent that never arrived is precisely the case
that must not be skipped.

### A real bug the tests caught

The first version of `finish()` verified against the store **only when it
believed a part was missing**. A part that returned 200 and then was not there
is a part we believe we sent, so the check never fired, the completion
assembled whatever the store actually had, and the candidate got "Saved" for
two thirds of their answer. Nobody would have found out: a truncated video
plays.

Now the client always asks the store before completing, and the server refuses
to assemble fewer parts than the declared size implies. Both, because the
route must not depend on the client being correct.

---

## Deploying it

A separate Vercel project, on `apps/interviews`, port 3002 in development.

### Environment

| Variable | For | Notes |
|---|---|---|
| `SUPABASE_URL` | the database | the same project as Studio |
| `SUPABASE_SERVICE_ROLE_KEY` | the database | server only, never in the browser |
| `R2_ACCOUNT_ID` | storage | or `R2_ENDPOINT` in full |
| `R2_BUCKET` | storage | **separate bucket per environment** |
| `R2_ACCESS_KEY_ID` | storage | |
| `R2_SECRET_ACCESS_KEY` | storage | |
| `R2_REGION` | storage | `auto` for R2; a real region for S3 |
| `INTERVIEWS_PUBLIC_URL` | candidate links **and sign-in** | the public origin. A session code is bound to this exact string at both ends |
| `NEXT_PUBLIC_STUDIO_URL` | the sign-in link | where the handoff starts |
| `AI_STT_API_URL` / `AI_STT_API_KEY` / `AI_STT_MODEL` | transcription | Phase 3 |

On the **Studio** project, one variable is needed too:

| Variable | For | Notes |
|---|---|---|
| `AUTH_HANDOFF_ORIGINS` | sign-in | this app's origin, exactly. Unset means nobody may be handed a session |

`rescript_session` is host-only, so the Studio's cookie cannot reach this
origin and a shared cookie domain is not available — `vercel.app` is on the
Public Suffix List. Sign-in therefore goes through a single-use code; see
[AUTH-HANDOFF.md](./AUTH-HANDOFF.md).

Without R2, the app runs and the routes that need storage answer **501 naming
the missing variables**. The candidate's screen says so *before* anybody
records, because a person who has just spoken for four minutes into a product
that was never able to save it is the worst thing this application can do.

### The bucket

Private. No public access, no custom domain serving it directly. CORS must
allow the app's origin for `PUT`, `GET` and `HEAD`, and must **expose
`ETag`** — a browser cannot read the part etag otherwise, and without it a
multipart completion cannot name the parts:

```json
[{
  "AllowedOrigins": ["https://interviews.example.com"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["content-type"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 86400
}]
```

Add a lifecycle rule to abort incomplete multipart uploads after 7 days. The
application aborts its own, but a browser that vanishes cannot.

### Migrations

`0030_interviews.sql` then `0031_billing_subject.sql`, in that order — 0031's
wallet resolution reads `interview_projects`. Both are idempotent.

**0031 alters live billing.** Run `scripts/billing-sql-test.sql`,
`scripts/billing-central-wallet-sql-test.sql` and
`scripts/interviews-sql-test.sql` against a copy first. All three pass here
against a real PostgreSQL 16 with the full migration chain applied.

---

## Tests

| | |
|---|---|
| `packages/storage` | 66 — SigV4 against AWS's vectors, the upload plan, the resume arithmetic, the R2 wire shapes, the double's HTTP surface |
| `packages/interviews` | 48 — the draw and its audit, both state machines, the telemetry vocabulary, the hallucination check, the caps, and the uploader end to end against a real store with injected failures |
| `scripts/interviews-sql-test.sql` | interview billing beside survey billing, idempotency, the cascade, the job queue's `skip locked`, stale-claim recovery, the sweeps, and that nothing is reachable with the anon key |
| Workspace | 14 packages green; `access`, `billing`, `central-wallet` and `transfer` SQL suites pass unmodified |

`scripts/media-delivery-sql-test.sql` fails on a fresh database **before and
after** these changes — it depends on a fixture another suite creates. Not a
regression; worth fixing separately.

---

## What is not built yet

Honestly, because the brief asks for a production launch and this is two of
eight phases.

**Phase 3 — processing.** The `interview_jobs` queue, its claim functions and
its idempotency exist and are tested; there is no runner and no cron yet, so
nothing transcribes. `interview_transcripts` rows are created when an audio
companion is stored, waiting for one.

**Phase 4 — intelligence.** `verifyEvidence` and the requirement vocabulary
are built and tested; the prompt, the provider call and the review interface
are not.

**Phase 5 — telemetry surfaces.** Events are collected and stored; the
reviewer's dashboard that renders them under `SIGNALS_CAVEAT` is not built.

**Phase 6 — billing.** The subject generalisation is done and interview meters
can be added as data. No interview meter is wired to a code path yet — nothing
in Phases 1–2 spends money except storage, which is metered by the retention
sweep that Phase 7 adds.

**Phase 7 — production.** Retention sweep, orphan reconciliation, the
abandoned-upload sweep and observability all have their SQL and their
arithmetic; none has a scheduler.

**Phase 8 — Studio integration.** Not started.

**Also outstanding:** the browser suite. The uploader is tested against a real
object store in Node, which covers the protocol; driving the candidate page in
Chromium with a real `MediaRecorder` needs a PostgREST stub, which is the next
piece of harness work.
