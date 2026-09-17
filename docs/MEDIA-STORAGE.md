# Media storage: Cloudflare first

Every recording, upload and attached file the Studio and the survey runtime
store now goes to Cloudflare R2, directly from the browser, and is served
back through a short-lived signed URL the application redirects to after
checking who is asking. Nothing already stored is moved.

Migration `0039_media_cloudflare_first.sql`. Packages `@rescript/storage`
(the provider, the uploader, the completion rules) and `@rescript/media` (the
lifecycle, now over an `ObjectStore` seam).

## What was wrong

The survey product had two storage worlds. The interviews app used R2 through
`@rescript/storage`: browser-direct multipart uploads, resume, 15-minute
signed URLs, verified deletion. Studio and runtime used Supabase Storage
through a six-method shim, and around it had grown:

| Path | Problem |
|---|---|
| `POST /api/upload` (respondent files) | the whole file POSTed **through** the serverless function — 25 MB allowed by the route, 4.5 MB allowed by Vercel — and **no session check at all** |
| `POST /api/surveys/[id]/audio` (localization audio) | the same, 20 MB, with a five-year signed URL back |
| `/d/[id]` delivery link | read every recording out of storage into the function and built a ZIP in memory — the largest origin-transfer path in the product |
| question video, answer audio | one PUT, no resume, no retry beyond "try the whole thing again"; 150 MB question videos on a 50 MB default Supabase project ceiling |
| signed URLs | **one and five years**, baked into survey definitions, answers and every CSV export — a bearer credential to a respondent's voice in a file that leaves the platform |
| deletion | `remove()` returned 200 and the row was deleted; nothing checked the object was gone, and a store outage orphaned bytes for ever |
| survey clone | the copy pointed at the original's video file; deleting the original broke the clone |
| images, PDFs, documents | pasted URLs to somewhere else |

## What it is now

```
browser ──PUT (signed, 8 MB parts, resumable)──▶ Cloudflare R2
browser ◀──302 to a 15-minute signed URL──── /api/media/<id>  (access check, no bytes)
```

- **`ObjectStore`** (`packages/media/src/objectStore.ts`) is the vocabulary
  the lifecycle needs — grant an upload, prove an object landed, sign a
  download, read, remove-and-verify, copy. Two adapters: `providerObjectStore`
  over `@rescript/storage` (R2, or the in-memory double), and
  `supabaseObjectStore` over the Supabase client.
- **`media_objects.storage_provider`** says which store holds each row:
  `supabase` for everything before 0039, `cloudflare-r2` for everything after.
  Reads, deletes and download URLs dispatch on it. The legacy long-lived URLs
  keep working because their objects are exactly where they were.
- **Buckets became prefixes.** `rescript-video` → `video/…`,
  `rescript-uploads` → `uploads/…`, `rescript-audio` → `audio/…`,
  `rescript-assets` → `assets/…`, inside one R2 bucket per environment.
- **Stable URLs.** A provider-stored object is kept in the definition or
  answer as `/api/media/<id>/<file name>`. Both apps host that route: the
  Studio gates on `project.read`; the runtime serves stimulus kinds for any
  live survey and a respondent's own recording only to the session that made
  it (`?s=<sessionId>`, appended by the renderer at play time, never stored).
  Exports make it absolute with `STUDIO_PUBLIC_URL`; behind a sign-in, not a
  bearer credential.
- **One uploader for every product.** `RecordingUploader` moved from
  `@rescript/interviews` to `@rescript/storage/uploader`. Studio's question
  video recorder, the localization audio studio, the new asset upload button,
  the renderer's interview recorder and its file/photo/signature uploads all
  use it: parts of 8 MB, six attempts each, resume from what the store has,
  a `clientToken` so a retried or refreshed take is the same upload, and a
  confirm that asks the store before anything is called saved. Objects up to
  16 MB go as one PUT.
- **Ticket / parts / confirm** in both apps speak the uploader's protocol.
  `media/parts` is new (resume). `confirm` assembles a multipart upload from
  its etags, then HEADs the object; the recorded size is the store's.
- **Delivery link** (`/d/<id>?k=…`) is a page of direct download links, each
  a 15-minute signed URL from whichever store holds the file. Bytes never pass
  through Vercel. `?zip=1` still builds the archive for anyone who needs one
  file.
- **Deletion is verified and written down.** `removeMedia` deletes, HEADs,
  and only then drops the row; a row whose object is still there is kept for
  the next sweep, and `media_deletions` records every removal with its
  verification. A delivery is marked `deleted` only when every object went;
  otherwise it stays `expired` and `rescript_media_deliveries_expiring` offers
  it again.
- **Clone copies media.** `copyMedia` duplicates the object inside the store
  (R2 `CopyObject`; Supabase `copy`) and the clone names its own row.
- **`survey_asset`** is a new kind — images, PDFs, documents up to 50 MB —
  behind an **Upload** button on every media URL field in the builder.
- **Retired:** `POST /api/upload` and `POST /api/surveys/[id]/audio` answer
  410 with a sentence.

## Deploying it

### The bucket

One bucket per environment, separate from the interviews buckets so the two
products keep their own CORS and lifecycle settings:

- `rescript-media-prod`, `rescript-media-dev`
- Public access **off**. Lifecycle rule: abort incomplete multipart uploads
  after 7 days.
- CORS on each bucket, with **both** the Studio and the runtime origins:

```json
[{
  "AllowedOrigins": ["https://<studio>.vercel.app", "https://<runtime>.vercel.app"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["content-type"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 86400
}]
```

`ExposeHeaders: ["ETag"]` is what makes multipart work; without it long
uploads fail and short ones succeed. Add `http://localhost:3000` and
`http://localhost:3001` to the **dev** bucket only.

- An R2 API token with Object Read & Write scoped to these two buckets.
  `claude/r2-setup.md` in the project walks through the Cloudflare screens.

### The variables

On **both** the Studio and the runtime Vercel projects:

| Variable | Value |
|---|---|
| `R2_ACCOUNT_ID` | the account id |
| `R2_BUCKET` | `rescript-media-prod` (Production) / `rescript-media-dev` (Preview, Development) |
| `R2_ACCESS_KEY_ID` | from the token |
| `R2_SECRET_ACCESS_KEY` | from the token — Sensitive |
| `R2_REGION` | `auto` |
| `STUDIO_PUBLIC_URL` | Studio only; makes exported media links absolute |

`MEDIA_STORAGE=memory` selects the in-memory double for local work with no
Cloudflare account (refused in production unless `MEDIA_ALLOW_MEMORY_STORAGE=1`).

### The order

1. Apply `0039`. Additive; the app keeps working on Supabase.
2. Deploy. With no `R2_*` set, `buildMediaStores` logs
   `Supabase Storage is primary — R2 is not configured` and behaves as before.
3. Set the variables and redeploy. From then on new uploads go to R2; the log
   line says so.
4. `node scripts/r2-check.mjs https://<studio>` against each bucket proves
   CORS, multipart and the public-access setting from your own machine.

### Watching it

`media_objects.storage_provider` counts tell you the split;
`media_deletions` with `verified = false` is what to look at when storage was
down. The delivery cron's JSON reply now says how many objects it could not
yet remove.

## Not moved, deliberately

Objects already in Supabase Storage stay there, readable and deletable through
the legacy store. A one-off copy to R2 is possible later — `copyMedia` and the
`storage_provider` column are what it would use — and would be a script, not
a code change. The legacy `apps/studio/lib/surveyUploads.ts` sweep still
cleans the old `rescript-uploads` bucket for objects that predate
`media_objects`.

## Tests

- `packages/storage` — 93: the uploader and completion rules (moved with
  their tests), plus `copy`.
- `packages/media` — 88: the legacy path unchanged (57), and 31 over the real
  in-memory store: single PUT, multipart assembled at confirm, resume finds
  the same row, verified deletion written to the audit, clone copies, legacy
  rows dispatch to the legacy store while new rows go to the primary.
- `0039` exercised on a fresh Postgres: default provider, token uniqueness
  and its release on failure, the deletions table, the claim returning the
  store.
