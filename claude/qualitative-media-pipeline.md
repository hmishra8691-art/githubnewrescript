# Recording, storing and transcribing a qualitative interview

Migration `0027_media_objects_and_transcripts.sql`, package `@rescript/media`.

## What was actually wrong

### 1. "Exceed limit" was not a limit being too low

The recorder asked the browser for `{video: true}` and whatever bitrate it
felt like. On a 1080p webcam that is 2.5–5 Mbps, so a five-minute take was
95–190 MB — held in the tab as an array of Blobs *and* a concatenated copy
*and* a third copy inside a `FormData` — and then POSTed **through the
application** to storage.

Four things went wrong at once, and the deployment target decides which one
you hit first:

| | |
|---|---|
| Serverless request body | Vercel refuses over **4.5 MB**. A twenty-second take is already over. |
| Function timeout | `media/route.ts` had no `maxDuration`, so 10s. Parsing 100 MB of multipart, buffering it into the Node heap, and pushing it to Supabase does not happen in 10s. |
| Browser memory | Three copies of a 190 MB recording on a low-RAM laptop crashes the tab before any request is made. |
| **The project's own ceiling** | A Supabase project has a GLOBAL upload limit — 50 MB by default — and no bucket may declare one above it. |

The message a researcher saw — `The video could not be saved (413)` — came
from `r.json().catch(() => ({}))` falling through, because a platform error
page has no JSON body. The route's own carefully worded 200 MB message was
unreachable on the deployment it was written for.

The fourth one outlived the first three and is worth its own paragraph,
because it produced the most misleading error in the whole feature. Creating
`rescript-video` with a 150 MB `fileSizeLimit` was refused with **"The object
exceeded the maximum allowed size"** — a sentence about a *bucket* that reads
exactly like a sentence about a *file*. The bucket therefore never existed, so
every upload died before it started, and a researcher recording a one-second
0.2 MB clip was told their recording was too big.

The fix is to stop asserting a ceiling and start asking for one.
`ensureBucket` now treats its limit as a preference: if the project refuses
it, the bucket is created without one and inherits the project's, and the
value read back is what everything downstream measures against.
`GET …/media/ticket` returns that ceiling and the take length that fits inside
it, the recorder fetches it before opening the camera, shows it on the clock,
and stops there. A limit discovered at upload time is a limit discovered after
the interview.

Video is recorded at 900 kbps rather than 1.2 Mbps for the same reason: five
minutes must fit inside a *default* 50 MB project with margin for a
variable-bitrate encoder overshooting on a take with movement in it. Five
minutes is ~36 MB; a default project offers about 5:41.

### 2. Media had no identity

Every object was known only by a string inside a jsonb blob:
`settings.interviewVideo` inside `surveys.draft_definition`, and
`responses.answers -> <qid> -> audio`. There was no table, so nothing could be
found from SQL. Four consequences, all the same consequence:

- Deleting a survey left its videos in the bucket forever. The only cleanup
  that existed walked `responses.session_id`, so it reached `rescript-uploads`
  and neither of the other two buckets.
- Purging a respondent for an erasure request deleted the row that was the
  *only* key from a bucket folder back to a survey — so the voice recording
  became permanently unreachable **and** permanently retained, behind a
  year-long signed URL.
- Deleting a question, or re-recording it, dropped the reference and kept the
  file. Every take anyone ever recorded was still there.
- A transcript had nowhere to live but the answer blob, so a failed
  transcription could not be found again, let alone retried.

### 3. Transcription could not finish, and could not say so

One inline call inside the request the respondent was waiting on:

- `transcribe()` aborted at a flat **30s**. Whisper takes 20–60s on five
  minutes of speech.
- The route had **no `maxDuration`**, so the platform killed it at 10s —
  *before* the 30s abort, and *after* the clip had been safely uploaded. The
  renderer turned that into "Your recording could not be saved", which was
  false, and invited the respondent to record five minutes again.
- Every failure wrote `{source: "none", failed: true}` — the same value as "no
  provider is configured". Nothing could distinguish a timeout from an empty
  wallet from a missing provider, so nothing could be re-driven.
- `TRANSCRIBING` existed as a state but was reachable only from an in-memory
  flag. A refresh lost it.
- The researcher's own question video was **never transcribed at all**. There
  was exactly one call site of `transcribe()` in the repository.

## What it is now

```
record → PUT direct to storage → confirm → queue → claim → transcribe → row
```

### Recording

`RECORDING_CONSTRAINTS` in `@rescript/media` is the single place that says how
big a recording should be: 720p/30fps, 900 kbps video, 96 kbps audio, a
5-second timeslice, and a 10-minute ceiling. Five minutes is **~36 MB**. The
chunk array is released once the take is assembled instead of being held
alongside it.

That 10-minute figure is a preference, not a promise. `secondsThatFit` derives
the real one from the ceiling the server discovered, holding back 15% for the
encoder, and the recorder uses the smaller of the two — so on a default 50 MB
project it offers 5:41 and says so, rather than letting somebody record ten
minutes they cannot keep.

The microphone is recorded **twice** — once into the video, once alone at 64
kbps. That second track *is* the audio extraction. Transcription services
accept 25 MB and a 36 MB video is not something to hand them; doing it in the
browser costs nothing because the track is already there, and avoids ffmpeg in
a serverless function. Five minutes of it is 2.4 MB.

### Upload

The bytes never touch the application. `POST …/media/ticket` writes a
`media_objects` row at `pending` and returns a signed upload URL good for one
object at one path; the browser PUTs to it; `POST …/media/confirm` **lists the
object** before agreeing it exists, because "the client reported success" and
"the object exists" are different facts.

Writing the row *before* the upload is the point: a row still at `pending` an
hour later is a browser that closed mid-transfer, and is the only evidence
that would otherwise exist. `sweepAbandonedUploads` clears them.

The take is kept in a ref, so **Retry sends the same recording again** rather
than asking anyone to repeat five minutes because a network blipped.

### Transcription

`media_transcripts` is one durable job per recording:
`waiting → processing → transcribing → completed | failed`, with an attempt
count. `rescript_claim_transcription` does the claim in SQL with `for update
skip locked`, so two runners racing on one clip cannot both bill for it, and a
job stuck in flight for more than 180s — the serverless failure this table
exists for — is reclaimable.

`transcribe()`'s timeout now scales with the clip: ~0.4s per second of audio,
floor 30s, ceiling 240s. The ceiling sits under the routes' `maxDuration =
300`, so the abort is ours and produces a message rather than the platform
killing the function and producing none.

A failure leaves the audio in the bucket and the attempt count unexhausted.
That is what makes **Retry** a button rather than an apology — and the retry
reads the stored clip, not a recording the respondent no longer has.

### Identity and retention

```
Project → Survey → Question → Recording → Transcript
Project → Survey → Response → Question  → Recording → Transcript
```

`media_objects` carries customer, survey, question, response, session, kind,
bucket, path, original filename, mime type, bytes, duration, dimensions,
status and timestamps. The definition and answer blobs keep their own url and
path — the runtime must not need a join to play a video — so this table is the
*inventory*, not a second source of truth for the answer.

Completed:

| event | what happens now |
|---|---|
| survey deleted | `purgeSurveyMedia` — every bucket, not just `rescript-uploads` |
| question video deleted | the object goes, not only the reference |
| video re-recorded | the take it replaced is removed, *after* the new one is stored |
| response purged | `purgeSessionMedia`, **before** the cascade destroys the rows that name the objects |
| response soft-deleted | nothing removed — it is reversible, and the recording must survive it exactly as the row does |
| `saveAnswerAudio: false` | the clip is stored (there is nothing to transcribe otherwise) and removed once the transcript exists |

### Logging

`MEDIA_STAGES` names eleven stages, and both halves log the same words against
the same media id:

```
recording_started → recording_completed → blob_created → upload_url_issued →
upload_started → upload_completed → storage_confirmed → audio_extracted →
transcription_queued → transcription_started → transcription_completed
```

"Where did it fail" is the last stage that appears for a recording id.

## What this replaced rather than added

The brief asked for no parallel architecture. Four routes each had their own
copy of the bucket-existence dance, the name sanitiser, the upload-and-sign
pair and the usage call, and returned four different envelopes for the same
operation. `@rescript/media` is one copy; `POST /api/surveys/[id]/media`
(multipart) and `POST /api/session/transcribe` (store-then-transcribe inline)
are **deleted**, not left alongside.

`@rescript/media` takes the database as an argument and imports neither Next
nor `@supabase/supabase-js`, so the whole lifecycle is proven against a stub —
including that a second runner does not bill the provider twice, which no
browser test could assert.

## Deliberate limits

- **Not resumable.** Supabase's TUS endpoint needs a bearer token in the
  browser; this platform's auth is an httpOnly opaque cookie and there is no
  JWT to give it. A failed PUT retries the whole object, which at ~49 MB is
  seconds, not minutes.
- **No background worker.** There is no cron, queue or webhook infrastructure
  in this repository and adding one for this would be the largest change in
  the brief. The job row is driven by the client that created it and by the
  status poll; both claim through the same SQL function, so a killed runner is
  picked up by the next poll rather than lost.
- **Preview no longer transcribes.** It used to, against the fake provider,
  because storing and transcribing were one request. They are two now, and a
  preview has no respondent whose recording it would be — so the ticket route
  refuses it and the renderer keeps the clip as an object URL, as the other
  upload variants already did.

## Still open

- **Exports still carry signed URLs.** `flatten.ts` writes
  `<VAR>_AUDIO_URL` into every CSV and SPSS export — a year-long
  unauthenticated link to a respondent's voice, in a file that leaves the
  platform. The `mediaId` is now on the answer, so the export could carry that
  instead and mint a URL on demand behind an access check. Not changed here:
  it alters an export column that existing analyses depend on.
- **Cloning copies media references.** `cloneSurveyDefinition` re-ids
  entities but not `interviewVideo.url`/`.path`, so a cloned survey plays the
  original's file. Now fixable, because the objects have rows to copy.
- **`/api/upload` is still ungated.** The respondent file-upload route
  accepts any content type from anyone with no session check. Out of scope
  here; it should move onto the same ticket flow.
