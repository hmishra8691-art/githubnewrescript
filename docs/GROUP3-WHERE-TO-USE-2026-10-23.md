# Group 3 — what was built and where to use it (2026-10-23)

This covers the four interview gaps and engine items 11–19. Each row says where in the product the feature lives. Detail docs, each with its own "Where to find it" section:

- `AI-INTERVIEW-VOICE-I18N-2026-10-22.md`
- `LIVE-SESSIONS-2026-10-22.md`
- `ALERTS-AND-PANELS-2026-10-22.md`
- `ENGINE-11-14-2026-10-22.md`
- `ENGINE-15-19-2026-10-22.md`

## Interviews

| Feature | Where to use it | Needs |
|---|---|---|
| **Hands-free voice with interruption** (the participant can talk over the AI; it stops and listens) | Studio → Research Tools → **Qualitative → AI interviews → Setup** → tick *voice* → **Voice** row: "conversation". Participants use `/i/<token>` → "Talk naturally, hands-free" | Speech-to-text and text-to-speech provider (`AI_STT_*`, `AI_TTS_*` or `AI_API_URL`) |
| **Realtime low-latency voice** (OpenAI Realtime over WebRTC) | Same Voice row: "realtime". It is greyed out with the reason until configured | `AI_REALTIME_API_URL`, `AI_REALTIME_API_KEY`, `AI_REALTIME_MODEL` on the runtime and the Studio |
| **Participant page in any language** (20 built in, including Hindi, Marathi, Tamil, Telugu, Bengali, Urdu and Arabic, with right-to-left layout; others are machine-translated at launch) | Setup → **Languages** card → *Translate now* / *Review* / *Save*. Participants get the page in their browser's language, or with `?lang=xx` | A translation provider (`TRANSLATION_PROVIDER` / `GOOGLE_TRANSLATE_API_KEY`) or the AI model |
| **Scripted fallback in any language** (when the AI provider fails) | Automatic; the wording is in the Languages card | as above |
| **Live human-moderated interviews and focus groups (video)** | Research Tools → **Qualitative → Live sessions**: schedule → **Moderate** → camera check → **Enter the room** → open the waiting room → admit → start. Participants and clients join from their `/live/<token>` link | `WEBRTC_TURN_*` strongly recommended (without TURN, some office and mobile networks cannot connect); `LIVEKIT_*` optional for groups larger than 6 |
| **Back room for clients/observers**, chat, timestamped notes, stimuli push, AI probe suggestions for the moderator | The live console's right-hand panels; observers use **Observe** or an observer link | — |
| **Recording → transcript per speaker → coding** | Console → **Finalize → transcript**. The transcript then appears in Transcripts, Coding, Synthesis and Highlights | Speech-to-text provider, storage, migration 0071 |
| **Distress / abuse / quota / cost alerts** by e-mail, Slack, Teams, webhook or the in-app bell | Studio top bar 🔔; **Settings → Alerts** (organisation channels and rules); **Qualitative → Alerts & panels** (study rules, delivery log, *Send test*) | `INTEGRATIONS_SECRET_KEY` (for Slack/Teams/webhook), `RESEND_API_KEY` + `MAIL_FROM` (for e-mail), `CRON_SECRET` (for retries and digests), `STUDIO_PUBLIC_URL` |
| **Panel recruitment** (Prolific, Cint/Lucid, PureSpectrum, Dynata, Toluna, CloudResearch, MTurk, custom): entry IDs, signed end links per outcome, duplicate block, reconciliation CSV | **Qualitative → Alerts & panels → Panels**. This works for AI interviews, group sessions, live sessions and surveys | `INTEGRATIONS_SECRET_KEY` for signed links. Check each preset against the panel's current docs |
| **In words** | Intelligent Mode: "run this guide as AI voice interviews, hands-free, in Hindi and English"; "schedule two focus groups of 6 next Tuesday 6 pm IST"; "connect this study to Prolific with completion code ABC123"; "send distress alerts to #research-ops on Slack and to me by email" | — |

## Engine items 11–19

| # | Fixed | Where you see it |
|---|---|---|
| 11 | Each staged step now gets only the guides it needs. Simulated on a 12-step plan: guide text per step 39,768 → 10,342 characters; total sent −41 %; cost without caching −22 %, with caching −4.5 % (the guides were already cached) | Automatic. `COPILOT_ITEM_GUIDES=off` turns it off |
| 12 | Incomplete analysis-plan items are refused when proposed, naming what is missing, and the AI repairs them | Intelligent Mode card; Data Analytics never receives an invalid item |
| 13 | Refused MaxDiff/conjoint designs are corrected by the Studio where only one fix exists, or repaired by the AI | Card assumptions: "Corrected by the Studio …" |
| 14 | Duplicate behaviours are found by meaning, hand-built overlays in any spelling are caught, and popup "Close" comes in 35 languages | Intelligent Mode refusals; Studio → Localization → Translations |
| 15 | Randomizers and design versions are exactly balanced (an atomic least-filled claim; counted arms differ by at most 1) | Survey Flow → randomizer → *even presentation* → **Exact balance**. Questions → design question → Design file → **Exact balance**. New designs have it on; running studies are unchanged |
| 16 | Firefox (and any browser without speech recognition) uses server transcription; a microphone appears in matrix and table text cells | Respondent page 🎤. Survey Settings → server transcription switch. Needs `AI_STT_*` on the runtime |
| 17 | Long recordings in any browser-playable format are split in the browser; word timings give clips of exactly the excerpt | Qualitative → Transcripts → **Transcribe a recording in this browser…**; Coding/Highlights → **▶ Play clip** |
| 18 | Section order can be set for every document type, and theme changes preview live | Survey Settings → Documents → **Section order for …**, and the report theme's live preview; Data Analytics → report → **Order** |
| 19 | At 1024 px the conversation is 618 px wide (was 418); panes collapse to rails and drawers, and splitters can be resized | Intelligent mode at any screen width |

## Deploy

1. **SQL before the code.** Run `0071-0073-group3.sql` (0071 live sessions, 0072 alerts and panels, 0073 exact balance) in the Supabase SQL editor. It is safe to run twice.
2. **Install.** Run `pnpm install`, then push.
3. **Optional environment variables:**
   - `INTEGRATIONS_SECRET_KEY` (32 random bytes)
   - `CRON_SECRET`
   - `STUDIO_PUBLIC_URL`
   - `WEBRTC_TURN_*`
   - `AI_REALTIME_*`
   - `LIVEKIT_*`

   `/platform` shows which ones are missing.

## Honest limits

**Testing**

- Everything was tested with fake AI, speech and translation providers, in headless Chromium only.
- Not yet tried: a real realtime provider, a real TURN or LiveKit server, real Slack/Teams/Resend, real panels, real Firefox, Safari or phones.
- The 19 built-in non-English interview packs have not been checked by native speakers.

**Interviews**

- Live video groups are capped at 6 participants and 3 observers without LiveKit. The LiveKit browser client is not bundled.
- Live transcription advances while the moderator console is open, or at Finalize.

**Integrations**

- Panels are redirect-based: no panel APIs, no payments.
- There are no SMS alerts.

**Respondent voice and recordings**

- Server dictation stops at 60 seconds per press.
- AAC .m4a cannot be decoded by Chromium builds without proprietary codecs, so such files are refused with a message. WebM, OGG, FLAC, WAV and MP3 work.
