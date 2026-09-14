# Qualitative media delivery

A researcher needs the original recording — the pauses, the tone, the thing
the respondent picked up mid-sentence. A transcript is the datum, not the
evidence. But a platform that keeps every respondent's video forever is
holding, indefinitely, the most identifying material a research project
collects.

So the bytes are treated as a **delivery** rather than as storage: held long
enough to be fetched, then gone. What makes that safe rather than lossy is the
ordering established by migration 0028 — the transcript becomes the **answer
value** inside `responses.answers` before anything here runs. When the
recording goes, the response is still a complete research record.

## The shape of it

```
respondent records  →  media_objects (existing pipeline, untouched)
                          ↓
        cron: discover completed responses with media
                          ↓
        build manifest → mint token → Resend → status "sent"
                          ↓
        researcher opens /d/<id>?k=<token> → ZIP streamed on demand
                          ↓
        48h: kill the link, then delete the bytes → status "deleted"
                          ↓
        transcript, answers, response, exports: all still there
```

## What was reused rather than rebuilt

| Need | Existing thing used |
|---|---|
| Storage, signed URLs, purge | `packages/media/store.ts`, `removeMedia` |
| Transcription | untouched — it already writes the answer value |
| Email transport | `apps/studio/lib/mail.ts` → Resend over `fetch` |
| Templates | `packages/mail/templates.ts`, same `shell()`/`linkBlock()` |
| Send log + idempotency | `mail_deliveries`, its `dedupe_key` unique index |
| Authorization | `requireProject`, `project.read` / `responses.manage` |
| Project settings | `surveys` columns + `/api/surveys/[id]/config` |

New: one migration, one module (`packages/media/delivery.ts`), a
dependency-free ZIP writer, one template, two routes, one panel section.

## The decisions worth knowing

**Discovery, not enqueueing.** Nothing was added to the route that finalises a
response. That route is the last thing between a respondent and a finished
survey; an insert there that failed would either lose the delivery silently or
fail somebody's submission over an email. The cron finds completed responses
that have media and no delivery row — which also means a response completed
before this feature existed, or while the cron was down, is picked up on the
next run rather than lost.

**The link dies on the clock, not on the sweep.** `linkUsable()` compares
`expires_at` to `now()`. A cron that has not run yet cannot extend a link past
48 hours; the sweep only cleans up after a link that is already dead.

**Expire before deleting.** If storage refuses the delete, the promise in the
email is still kept and the next run tries the bytes again. The other order
leaves a window where a link that should have expired still works.

**`retry_after` is a column, not arithmetic on `updated_at`.** The touch
trigger rewrites `updated_at` on every write, so a backoff derived from it is
reset by anything that happens to touch the row — a delivery to a dead address
would be retried forever. Found by a test that failed; the SQL test still
pins it.

**The ZIP is built per request.** A pre-built archive is a second copy of the
most sensitive bytes in the system, with its own lifetime and its own way of
being orphaned. Building on demand means there is exactly one copy, and when
it is deleted nothing survives it. STORE method, no compression: audio and
video are already compressed, so DEFLATE would spend CPU to make the file
slightly larger. That removes the only reason to take a zip dependency.

**`@rescript/media/delivery` is a separate entry point.** The barrel is
imported by `packages/renderer`, which is bundled for the browser. Putting
`node:crypto` behind the main export broke the respondent's survey with a
webpack `UnhandledSchemeError`. The boundary now lives in the import path.

## Security, stated honestly

The download link is a **bearer credential**: whoever holds it can download
the recordings until it expires. That is inherent to emailing a link, not a
shortcut. What narrows it:

- 32 random bytes — not guessable
- stored only as SHA-256, so a database leak yields no working links
- dead after 48 hours, judged against the clock
- destroyed at expiry, not merely marked
- `noindex, nofollow`, `no-store`, never a public bucket URL
- the address is re-read at send time, so switching delivery off stops work
  already queued

What it is **not**: restricted to the recipient's mailbox. The brief asked for
"access restricted to the configured researcher email"; a link in an email
cannot enforce that without making the researcher hold an account and sign in,
which is a different product decision. If that is wanted, the change is a
sign-in gate on `/d/[id]` plus an invitation — the token machinery stays.

`RESEND_API_KEY` is read only in `apps/studio/lib/mail.ts`, which is
`server-only`. It is never in a client bundle, a survey definition, or a log.

## Configuration

| Variable | Why |
|---|---|
| `CRON_SECRET` | The cron **refuses to run without it**. Vercel sends it as a bearer token. |
| `STUDIO_PUBLIC_URL` | The link is built from it. Unset, the delivery is marked failed rather than sending a broken link. |
| `RESEND_API_KEY`, `MAIL_FROM` | Already required for every other email. |

`apps/studio/vercel.json` schedules `/api/cron/media-delivery` every 10
minutes. **On a Vercel plan with only daily crons this promise breaks**:
delivery would be up to 24 hours late and deletion up to 24 hours overdue,
while the email still says 48 hours. Check the plan before switching delivery
on for real fieldwork.

## What is verified

- `packages/media` — 57 tests, including `unzip -t` against a real archive,
  the clock, the token, path traversal, loop-iteration collisions, the backoff
- `packages/mail` — 5 new template tests: the deadline appears in both parts,
  no research content, no markup injection
- `scripts/media-delivery-sql-test.sql` — 32 checks in a rolled-back
  transaction, including **the transcript surviving the deletion**
- 1,464 package tests, both apps typecheck, the interview and speech browser
  suites pass, the runtime preview still renders

## Known gap

**Nothing retries transcription server-side.** That predates this work: a
respondent who closes the tab mid-upload leaves a `waiting` job nothing picks
up, because transcription is driven entirely by the browser. The cron is now
the obvious home for it, and the open question is whose wallet a system-run
transcription is metered against. Until that is answered, a recording whose
transcription never ran is delivered as media and deleted at 48 hours with no
transcript — the recording is delivered either way, but the datum is lost.
