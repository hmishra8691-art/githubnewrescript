# Alerts and panel recruitment — 2026-10-22

Engineer G3. Migration **0072**. No new npm dependency (Slack, Teams, webhooks and Resend are reached with `fetch`
through the existing endpoint guard; signing and sealing use `node:crypto`).

Two gaps from the AI-interview work (`docs/AI-INTERVIEWS-2026-10-22.md` §8): a distress flag was shown in the live
view only ("no e-mail/Slack alert"), and panels were "only `pid` in and a redirect out". This adds:

- an **alert service** (e-mail, in-app bell, Slack, Microsoft Teams, a signed generic webhook) with organisation and
  study rules, quiet hours, dedupe and an hourly cap, digests, retries with backoff and a delivery log;
- a **panel framework** (entry parameters, per-outcome end links, signed redirects, one entry per panel id, a
  completes target per panel, test links, a reconciliation CSV) with presets for Prolific, Cint / Lucid, PureSpectrum,
  Dynata, Toluna, CloudResearch Connect, MTurk-style codes and a custom panel, wired into the AI-interview link,
  text group sessions, live sessions and the survey link;
- **Intelligent Mode** actions `connect_panel`, `disconnect_panel` and `configure_alerts`, through the gate.

> **Honest status.** Everything ran against the sandboxes (no database, the fake provider) and a local HTTP server
> standing in for Slack and a webhook receiver. No real Slack / Teams workspace, no Resend account and no panel account
> was used; the presets come from each panel's public integration material as known in 2026 and **must be verified
> with the panel's current docs** (the UI and the copilot say so on every preset). E-mail alerts were exercised only
> to "not configured" here (no `RESEND_API_KEY`); the mail path is the existing `lib/mail.ts`.

## Where to find it

| What | Where |
|---|---|
| A study's alert rules, the delivery log, "Try the rules" | Studio → a project → Research Tools → **Qualitative → Alerts & panels** (`?tab=qualitative&qual=alerts`) |
| The organisation's channels (Slack / Teams / webhook / e-mail list), **Send test** | the same tab (Channels box), and **Settings → Alerts** (`/settings/alerts`, account menu → Alerts) |
| The organisation's own rules (every study) | **Settings → Alerts** → Organisation rules |
| The bell (my in-app alerts, unread count) | the Studio top bar (🔔) and the Projects / Analytics header |
| Panels: connect from a preset, signing secret, test links, entry link, signed survey exits, entries, CSV | **Qualitative → Alerts & panels → Panels** |
| Panel ids and outcomes beside each AI interview | **Qualitative → AI interviews** → the Interviews table (under the participant) |
| Reconciliation CSV | Panels → **Reconciliation CSV**, or `GET /api/surveys/<id>/panels?export=reconciliation` |
| An alert's link | opens the AI interview's live view (`?tab=qualitative&qual=ai&interview=<id>`) |
| Intelligent Mode | "connect this study to Prolific with completion code ABC123", "send distress alerts to #research-ops on Slack and to me by email" |

**Environment variables** (names only; see also `capabilities.md`):

| Variable | App | What |
|---|---|---|
| `INTEGRATIONS_SECRET_KEY` | Studio **and** runtime | 32 random bytes (64 hex or base64). Seals Slack / Teams / webhook URLs and panel signing secrets (the BYOK vault's envelope scheme, its own key); a sub-key authenticates the runtime's events to the Studio. Without it: in-app and e-mail alerts work, Slack / Teams / webhook channels cannot be added, panel end links go unsigned (and say so). |
| `INTEGRATIONS_SECRET_KEY_PREVIOUS` | both | older keys (comma-separated) that can still open what they sealed — rotation |
| `STUDIO_INTERNAL_URL` (else `STUDIO_PUBLIC_URL`) | runtime | where the runtime tells the Studio to deliver an event now; without it the scheduled pass delivers it |
| `STUDIO_PUBLIC_URL` | Studio | absolute links in Slack / Teams / e-mail / webhooks (relative without it — in-app only) |
| `CRON_SECRET` | Studio | `/api/cron/notifications` every minute (retries, digests, undelivered events) — `vercel.json` has the schedule |
| `RESEND_API_KEY`, `MAIL_FROM` (+ `MAIL_DEV_REDIRECT` outside production) | Studio | e-mail alerts and invitations (the existing mailer) |
| `NOTIFY_ALLOW_PRIVATE_ENDPOINTS=1` | Studio | only for an operator's own network: lets channels point at private addresses (never a request parameter) |

## 1. Alerts

### Events (`packages/engine/src/notifyEvents.ts`, `NOTIFY_EVENTS`)

| Event | Severity | Raised by |
|---|---|---|
| `ai_interview.distress` | **critical** (never digested, never held by quiet hours, never rate-limited) | runtime: the moderator's distress flag (rules before the model) |
| `ai_interview.abuse`, `ai_interview.injection` | high | runtime: the abuse / manipulation flags |
| `ai_interview.completed` | low, **digest** (hourly by default) | runtime: an interview completed |
| `ai_interview.quota_full`, `study.target_reached`, `study.cost_cap` | normal / normal / high | runtime: admission refused for a full segment, the completes target, the study budget (once per study) |
| `ai.provider_fallback` | normal | runtime: the provider failed and the scripted path took over |
| `group_session.flag` | high | Runtime: a group-session answer that reads as distress, abuse or instructions to an AI (`apps/runtime/app/api/group/route.ts`, once per participant and kind; handle only, redacted excerpt, link to Qualitative → Groups) |
| `live_session.no_show` | normal | Studio: a live session finalized with no-shows (G2's route) |
| `survey.quota_full`, `survey.milestone` | normal / low | runtime: a respondent ended on quota full (once a day); completes reached 25 / 50 / 75 / 100 % of `research.sampleSize` |
| `panel.target_reached`, `panel.duplicate_entry` | normal / low | catalogue (reserved) |

### Rules

- **Study rules** live on the definition (`definition.alerts`, `AlertSettings` in `packages/schema/src/integrations.ts`):
  events (types, `category.*` or `*`) → channels (`email` to an address / `@me` / `@team` / an e-mail list's name;
  `in_app` to `@me` / `@team`; `slack` / `teams` / `webhook` **by the channel's name**), immediate / hourly / daily,
  plus quiet hours (with a time zone), the hourly cap per destination and the dedupe window.
- **Organisation rules** (`notify_rules`, Settings → Alerts) apply to every study; both apply, so a study cannot switch
  off the organisation's distress alert. The same destination named twice is one message.
- **No rule anywhere**: normal-or-higher events go to the project team's bell (an unconfigured study is never silent
  about distress).
- `@me` is the person who claimed the rule ("“me” is me" in the tab); until then, the project owner.

### Delivery (`apps/studio/lib/notify/service.ts`)

1. **Outbox.** Every event is written to `notify_events` first (idempotency key unique: a replayed request is one
   event; the excerpt stored is already **redacted**). The runtime writes it itself and pings the Studio (signed); the
   cron (every minute) delivers anything a crash left behind (`rescript_notify_claim` leases events so two
   dispatchers never send one twice).
2. **Routing** → destinations → **decision** per destination: *duplicate* (the same event about the same thing within
   the dedupe window → `skipped`), *quiet hours* / *over the hourly cap* / *a digest rule* → `digest_pending` with its due
   time, else **send**.
3. **Send**: Slack (Block Kit — the participant's words only as `plain_text`, so no `<!channel>` or link markup can ride
   in them), Teams (an Adaptive Card), webhook (JSON, `X-Rescript-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "t.body")>`,
   `X-Rescript-Event`, `X-Rescript-Delivery`, `Idempotency-Key`), e-mail (text + escaped HTML through `lib/mail.ts`,
   kind `alert`), in-app (a `notifications` row, action `alert.<severity>`). Endpoints go through `guardedFetch` (https,
   public addresses only, no redirects, 10 s, 64 KB).
4. **Retries**: 408 / 425 / 429 / 5xx / network errors retry at ~30 s, 2 min, 8 min, 32 min (±20 % jitter), then
   `failed`; other 4xx fail at once; every retry carries the same idempotency key. A refused address is not retried.
5. **Digests**: due hourly at the top of the hour, daily at 08:00 (the quiet-hours zone, else UTC), quiet-hours holds when
   the quiet hours end — one message per destination (`renderDigest`).

**What a channel receives**: the study, the event, the participant's **pseudonym** (P3, a panel id) and a **redacted**
excerpt of at most 160 characters (`redactExcerpt`: e-mails and phones masked by the interview's own rules, links,
handles, long digit runs and a self-introduced name removed, markup dropped, one line), details, and a link. Never full
participant text, never a name or an address. The webhook's JSON: `{id, type, severity, occurredAt, test, study:{id,title},
subject, participant, title, text, excerpt, link, detail, delivery}`.

**Verifying the webhook** (receiver side):

```js
import { createHmac, timingSafeEqual } from "node:crypto";
const [t, v1] = [/t=(\d+)/.exec(sig)[1], /v1=([0-9a-f]{64})/.exec(sig)[1]];
const ok = Math.abs(Date.now() / 1000 - Number(t)) < 300
  && timingSafeEqual(Buffer.from(v1, "hex"), createHmac("sha256", SIGNING_SECRET).update(`${t}.${rawBody}`).digest());
```

(`verifySignedHeader` in `packages/ai/src/envelope.ts` is the same check.)

### Secrets

Webhook URLs (and a webhook's signing secret, generated as `whsec_…` and **shown once**) are sealed with
`packages/ai/src/envelope.ts` — the BYOK vault's envelope scheme (AES-256-GCM data key wrapped by the master key, AAD =
the row, key-id fingerprints, rotation by `…_PREVIOUS`) with its **own** key, `INTEGRATIONS_SECRET_KEY`. The BYOK
containment tests keep `AI_CREDENTIAL_KEY` inside the vault, and a panel's secret must be opened by the respondent
runtime, so the key is separate on purpose. The browser only ever sees a masked hint (`hooks.slack.com/…/••••abcd`);
`notify_channels.secret_sealed` and `panel_secrets` are not readable through the API (column grants / no policy).

## 2. Panels

### Configuration (`definition.panels`, `PanelConfig`)

`key`, `preset`, `label`, `idParam` (the panel's id parameter), `params` (kept values), `requireId`, `dedupe`,
`redirects` per outcome (`complete`, `screenout`, `quota_full`, `terminate`, `over_quota`; https; `{{pid}}`, `{{code}}`,
`{{outcome}}` and kept values, URL-encoded), `codes` per outcome, `showCode`, `signing` (`algorithm` none / hmac-sha256 /
hmac-sha1 / sha256 / sha1 — the plain hashes append the secret; `param`; `scope` url / query / chosen `params` with a
`separator`; `encoding` hex / base64 / base64url; `uppercase`), `targets` (ai_interview, group_session, live_session,
survey), `completesTarget`. The secret is never on the definition.

### Presets (`PANEL_PRESETS` — verify each with the panel's current docs)

| Preset | Id parameter (+ kept) | End links | Signing |
|---|---|---|---|
| Prolific | `PROLIFIC_PID` (+ `STUDY_ID`, `SESSION_ID`) | `https://app.prolific.com/submissions/complete?cc={{code}}` per outcome code; code shown | none |
| Cint / Lucid | `RID` | `samplicio.us/router/ClientCallBack.aspx?RIS=10/20/30/40&RID={{pid}}` | HMAC-SHA1 over the URL, base64url, `&hash=` |
| PureSpectrum | `transaction_id` | `spectrumsurveys.com/surveydone?st=21/18/17/20&transaction_id={{pid}}` | none (configurable) |
| Dynata | `psid` | `dkr1.ssisurveys.com/projects/end?rst=1/2/3/4&psid={{pid}}` | none (account-specific; configurable) |
| Toluna | `gid` (+ `sname`) | `ups.surveyrouter.com/…/SOQualified / SOTerminated / SOQuotaFull.aspx?sname=…&gid={{pid}}` | none |
| CloudResearch Connect | `participantId` (+ `assignmentId`, `projectId`) | none by default — the completion code is shown | none |
| MTurk-style | `workerId` (+ `assignmentId`, `hitId`) | none — the completion code is shown | none |
| Custom | `pid` | yours | yours |

No panel API is called (feasibility, quota sync with the panel's own system and payments stay in the panel's dashboard).

### The flow (pure: `packages/engine/src/panels.ts`; orchestration: `packages/analytics/src/panels/service.ts`)

- **Entry** (`capturePanelEntry` / `enterPanel`): the panel by `?rp=<key>`, else by its id parameter, else the only
  panel for this kind of link. Refused without the id (a copied link), refused when the link still holds the panel's
  placeholder, refused when paused; **one entry per panel id per study** (`rescript_panel_enter`, a unique partial
  index — two tabs racing cannot both get in; the same id is refused across AI interviews, group sessions, live sessions
  and the survey); over the panel's `completesTarget` → straight back with the over-quota link. When a study has two or
  more panels and the link names none (no `?rp=`, no panel's id parameter), the participant is treated as not from a
  panel (as before panels existed) — give each panel the link shown on its card ("Give the panel your link with: …"), which carries `rp=`.
  A screened-out participant's row carries the entry too, so the live view shows the panel id and the outcome.
- **Exit** (`exitPanel`): the outcome → the end link, signed with the secret opened for that call; **the first outcome
  stands** (a reload gives the same link; a screen-out is never turned into a complete).
- **AI interviews (/i/)**: the page passes every URL parameter; screened out → the screen-out link; a full quota → the
  quota-full link; completed → the complete link and the code (`ai-code`); flagged / ended / abandoned → terminate.
  Without a panel entry the guide's own redirect (`{{pid}}`) is used as before.
- **Group sessions (/g/)**: the join carries the link's parameters; a duplicate / missing id is refused (409
  `panel_duplicate` / `panel_refused`); once the conversation has closed, the view carries the complete link and code.
- **Live sessions (/live/<invite>)** (G2's links): the join with consent carries the link's parameters; a panel id that
  took part elsewhere is refused (a rejoin through the same invite is welcome); when the session has ended, the page
  asks `/api/live {action:"panel"}` for the complete link and code. Database only (the live sandbox is forwarded to the
  Studio and not wired).
- **The survey link**: `session/start` enters the panel from the **deployed** definition's panels (duplicates refused,
  over quota answered). `connect_panel` with the survey as a target declares the panel's parameters as URL embedded data
  and fills the ends that have **no** redirect with the panel's **unsigned** end link (`{{ed.PROLIFIC_PID}}`). A
  **signing** panel's survey ends use the runtime's **signed exit**, set by "Use signed exits on the survey's ends":
  `<runtime>/api/panel/exit?r={{response.id}}` reads the response's **final status from the database**, maps it to the
  outcome and redirects to the signed link (a code-only panel gets a page with the code).
- **Test links**: Panels → *Test link* (any outcome, any id) — the link a participant would get, signed with the stored
  secret, nothing recorded.

## 3. Intelligent Mode

`connect_panel`, `disconnect_panel` (destructive, confirmed) and `configure_alerts` (engine `integrationActions.ts`) go
through the gate, the preview diff ("Connect the panel Prolific", "Set up the study's alerts") and the change list (new
category **Panels & alerts**). **Secrets are refused**: a webhook URL or a hashing key in an action is rejected with where to
put it instead. The guide (`lib/copilot/integrationsGuide.ts`, ~1.9k characters) is sent only when
`integrationsIntent` matches and is cached like the others; the system prompt is untouched.

- "connect this study to Prolific with completion code ABC123" → `{"op":"connect_panel","panel":"Prolific","completionCode":"ABC123"}`
- "send distress alerts to #research-ops on Slack and to me by email" → `{"op":"configure_alerts","events":["distress"],"slack":"#research-ops","email":["me"]}`

**Registry** (`capabilities.ts`): `platform:panels` (supported; actions connect_panel / disconnect_panel),
`platform:panel_signing` (requires configuration: `INTEGRATIONS_SECRET_KEY`), `platform:alerts` (supported; action
configure_alerts), `platform:alert_channels` (requires configuration), and the service `integrations_vault`.

## 4. Data — migration 0072 (re-runnable; applied twice on Postgres 16)

| Table | What |
|---|---|
| `notify_channels` | an organisation's Slack / Teams / webhook / e-mail channels; `secret_sealed` (never granted to members), `hint`, last test |
| `notify_rules` | the organisation's `AlertSettings` (unique per organisation; `survey_id` reserved) |
| `notify_events` | the outbox: idempotency key unique, redacted payload, status, attempts, lease |
| `notify_deliveries` | the log: event × destination, status, reason, digest, attempts, next attempt, response status, error; idempotency key unique |
| `notifications` (0008) | + `notify_event_id` (in-app alerts are notifications) |
| `panel_secrets` | the signing secret per (survey, panel), sealed — RLS on, **no policy**, no grant |
| `panel_entries` | arrivals: panel, panel id, link kind and ref, session, test flag, kept values, outcome, signed, times; unique partial index for dedupe |

Functions (service role only): `rescript_notify_claim(limit, lease_seconds, event)` and
`rescript_panel_enter(survey, panel, pid, target, target_ref, is_test, dedupe, captured)`. `mail_deliveries.kind` is
widened **by union** with whatever it already allows (`alert`, `live_session_invite`, `live_session_reminder`), so it
composes with any other widening. RLS: organisation members (platform_admin / programmer / researcher) read their
channels and rules (through 0001's security-definer helpers — a subquery on `profiles` would recurse into its policy);
the roles that read the project's responses read events, deliveries and entries; nobody but the service role writes.

## 5. API for other engineers

### Sending a notification (Studio server side) — for G2's invitations / reminders

```ts
import { sendNotification, emitNotifyEvent, studioLink } from "@/lib/notify/service";   // apps/studio/lib/notify/service.ts
import { notifyDeps } from "@/lib/notify/server";

await sendNotification(notifyDeps(), {
  channel: "email",                 // "email" | "in_app" (user id) | "slack" | "teams" | "webhook" (channel id or name)
  to: "participant@example.com",
  template: "live_session_invite",  // "live_session_invite" | "live_session_reminder" | "generic" ({subject, text})
  data: { title, startsAt, joinUrl /* https */, minutes, senderName, note },
  surveyId, customerId,
  dedupeKey: `live:${inviteId}:invite`,   // one message per key, ever
});   // → { status: "sent" | "not_configured" | "failed" | "skipped", reason, deliveryId } — logged in the delivery log

await emitNotifyEvent(notifyDeps(), { type: "live_session.no_show", surveyId, ref: roomId, idempotencyKey: `live_session.no_show:${roomId}`, link: studioLink(surveyId, { tab: "qualitative", qual: "live" }), detail: { no_shows: 2 } });
```

From the runtime: `emitFromRuntime(event)` in `apps/runtime/lib/notifyEmit.ts`. Panels at a join link:
`runtimePanels()` in `apps/runtime/lib/panels.ts` → `enter({ surveyId, target, targetRef, params, isTest })`,
`attach(entryId, sessionRef)`, `exit({ sessionRef, outcome })`.

G2's live sessions use these as described in §2 (join / ended) and §1 (no-shows). Their invitation e-mails still go
through `sendMail` directly (kind `respondent_invitation`, unchanged); `sendNotification` is available when they want the
delivery log and the per-key dedupe.

## 6. Tests

All run on 2026-10-23 after the container restart (heavy commands through `flock /tmp/p0/heavy.lock`).

| Command | Result |
|---|---|
| `node --test packages/engine/dist/{panels,notifyEvents,integrationActions}.test.js packages/ai/dist/envelope.test.js packages/analytics/dist/panels/service.test.js` (after each package's build) | 24 pass (HMAC vectors from RFC 2202 / RFC 4231 / FIPS 180) |
| `node --test packages/access/dist/*.test.js` (audit events) | 123 pass |
| `cd apps/studio && node --experimental-strip-types --no-warnings --test lib/notify/service.test.ts lib/copilot/integrationsGuide.test.ts lib/aiPromptCache.test.ts lib/byok/*.test.ts` (incl. BYOK containment / sweep) | 121 pass |
| `cd apps/runtime && node --experimental-strip-types --no-warnings --test lib/aiInterview/*.test.ts` (incl. `service.panels.test.ts`) | 16 pass |
| `npx tsc --noEmit -p apps/runtime` | clean |
| `npx tsc --noEmit -p apps/studio` | one error, in G2's `app/api/surveys/[id]/qual/recordings/chunk/route.ts` (not this work) |
| `node scripts/auth-guard-audit.mjs` | 249 handlers and pages, 0 problems |
| `node scripts/dependency-boundaries.mjs` | 0 violations |
| `node scripts/gen-public-docs.mjs --check` | current |
| `0072` applied twice + `scripts/alerts-panels-sql-test.sql` (twice) on a scratch Postgres 16 (copy of G2's cluster, port 55472, stopped after) | 6 groups PASS |
| `scripts/alerts-panels-test.mjs` (browser, local stand-in HTTP server for Slack / webhook) | 9 passed (re-run twice in the final verification, 9 passed each, with the Studio dev server restarted under it) |
| `scripts/ai-interview-test.mjs` (re-run) | 9 passed |
| `scripts/group-session-test.mjs` (re-run) | 7 passed |

The browser suite covers: Slack + signed webhook channels (masked, secret shown once), **Send test**, three distress
rules; Prolific + Cint from presets, Cint's secret sealed, signed test link verified; a screen-out back to Prolific with
`cc=SCR9`; a distress answer → Slack (redacted, pseudonym, live-view link), webhook (signature verified) and the bell;
a Prolific completion back with `cc=ABC123`, the same `PROLIFIC_PID` refused, `?rp=prolific` without the id refused;
a Cint completion with an HMAC-SHA1 signed end link that verifies; panel ids and outcomes in the live view, the delivery
log, the entries table and the reconciliation CSV; a group session joined once per panel id (the same id refused) and
the end link once closed; no page errors.

In the final verification this suite failed at step 3 because the sandbox's runtime→Studio panel call timed out after
5 s while the Studio dev server cold-compiled the route after an out-of-memory restart (6–9 s were logged). The arrival then
degraded to "no panel" and the screen-out had no redirect. The sandbox-only timeouts are now 30 s (panels) and 20 s (alert
ingest). The suite's launch and tab helpers also wait out a Studio reload. The database path is unchanged.

## 7. Not done, and why

- **No real channel was exercised**: Slack, Teams and webhooks were tested against a local stand-in server; e-mail only
  to "not configured". The Block Kit and Adaptive Card shapes follow the public formats; a first real send should be
  checked with **Send test**.
- **Presets are unverified against live panel accounts** (no web access here; no accounts). Each says so.
- **No panel API calls** (feasibility, live quota sync with the panel, payment): redirect-based integration only. "Quota
  sync" is the per-panel completes target enforced on our side.
- **Group-session flags** are raised by the runtime's group route from the participant's answer text (the same
  distress / abuse / injection detectors as AI interviews); no browser suite drives that path yet.
- **Live sessions in the sandbox** have no panel wiring (the runtime forwards the live sandbox to the Studio); the
  database path is wired but was not exercised by a browser suite here.
- **The survey link** is wired on the database path only (session start and the signed exit need a database); a
  refused / over-quota survey start shows the runtime's error message rather than redirecting.
- **SMS / phone calls**: no.
- **No background worker** beyond the per-minute cron: without `CRON_SECRET`, retries and digests are sent when the next
  event arrives or when someone's bell polls.
