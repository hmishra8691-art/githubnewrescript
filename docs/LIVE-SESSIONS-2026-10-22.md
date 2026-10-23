# Live human-moderated sessions and multi-party video — 2026-10-22

Engineer G2. Until today the capability registry said "live human-moderated sessions and multi-party video: not
supported". Rescript could plan a focus group or an IDI (the guide), record what happened elsewhere (session
records, uploaded recordings, transcripts) and run AI-moderated 1:1 interviews — but a researcher could not
moderate a live session with people. This adds that, in the browser, with no SDK and no media server of our own.

Migration **0071**. No new npm dependency (WebRTC, MediaRecorder, `fetch` and `node:crypto` only).

> **Honest status.** The built-in mesh works end to end here: four Chromium contexts with fake cameras and
> microphones (moderator, two participants, an observer) connect, exchange audio and video (inbound RTP checked
> with `getStats`), record, upload, transcribe (fake speech-to-text) and become one transcript — see §9. **Not
> exercised here:** a real TURN server, a real LiveKit server (and its browser client), a real speech-to-text
> provider, a real model for the assist panel, real networks (NAT, mobile, corporate firewalls) and real devices.
> **Without TURN some corporate and mobile networks will fail to connect** — the Studio says so.

## 1. What it does

### The session room

| Who | Where | What they can do |
|---|---|---|
| **Moderator** (a researcher with Data: Edit) | Studio → Research Tools → Qualitative → **Live sessions** → *Moderate* | camera / microphone check; open the waiting room; **admit / not admit**; **mute**, **spotlight**, **remove** a participant; **push a stimulus** from the guide (image, video or concept text) to everyone, or share the screen; start a **timer per guide section**; **back-room chat** with observers; see observers' **timestamped notes**; the recording's progress; the **rolling transcript**; the **AI assist** panel; start / end the session; **Finalize → transcript** |
| **Participants** | their own link, in the respondent app: `/live/<token>` | **consent screen** (the guide's statement, recording disclosure and data use — "I agree" and, when recorded, "I agree to the recording" are both required: **no consent → no room**, refused by the API, not only the page); **device check** (camera preview, microphone level, device choice, camera-off, listen-only); **waiting room**; then the room: the moderator and the other participants (by handle — P1, P2 …, never a name), the stimulus, the spotlight; mute / camera / share screen / leave |
| **Observers** ("back room") | a project member: Studio → *Observe*; a client without an account: an **observer link** (`/live/<token>`) | confidentiality confirmation; watch and hear the room (receive-only); chat with the moderator; write notes stamped with the session second. **Participants never see them**: not in the roster, not as a connection, not in any reply the participant API sends, and a participant's signal to an observer is refused |

**Reconnection.** A reload, a crash or a new device: the same link takes the same place back (same handle, a fresh
member token; the old tab is told it moved). A connection that fails restarts ICE by itself; a poll that fails backs
off and retries; a peer that comes back with a new browser session gets a fresh connection.

### Media transport — a provider abstraction

- **Built-in mesh WebRTC** (default; `RTCPeerConnection`, no SDK). Moderator ↔ every participant, participant ↔
  participant, observer ↔ moderator only. The **moderator's browser relays** its own camera and every participant's
  stream to each observer (at ≤ 350 kbit/s of video per stream), which is what keeps observers out of participants'
  browsers entirely. Limits: **6 participants and 3 observers** (each browser uploads one stream per peer).
  - **Signalling** through our own authenticated routes, by **HTTP long-polling** (≤ 8 s per poll, Vercel-compatible;
    no websocket server): `signal` posts offers / answers / ICE candidates / stream names (batched every ~100 ms; each message carries the id of
    the connection it comes from and the one it is meant for, so a peer that reloads or reopens its side gets a fresh
    connection instead of a renegotiation onto new DTLS keys, and stale messages are dropped),
    `poll` returns the messages addressed to this member plus the room. Messages live **two minutes** and are swept
    (`rescript_live_sweep`). Negotiation is the W3C "perfect negotiation" pattern (either side may renegotiate — a
    camera, a screen share, an ICE restart; a collision is settled by the polite side, chosen by member id).
  - **STUN**: Google's public STUN by default (`WEBRTC_STUN_URLS` overrides, `none` disables).
  - **TURN** via env: `WEBRTC_TURN_URLS` with static `WEBRTC_TURN_USERNAME` / `WEBRTC_TURN_CREDENTIAL`, or —
    better — `WEBRTC_TURN_SECRET`, from which a **time-limited credential is minted per person** with `node:crypto`
    (the TURN REST scheme coturn implements as `use-auth-secret`: username `<expiry>:<member>`, credential
    `base64(HMAC-SHA1(secret, username))`, `WEBRTC_TURN_TTL_SECONDS`, default 6 h). **Without TURN, people behind
    strict corporate firewalls or on some mobile networks will not be able to connect** — stated on the Live
    sessions tab, in the console, on the platform readiness and in the registry.
- **LiveKit (SFU) option** for larger groups (up to 30 participants, 20 observers) when `LIVEKIT_URL`,
  `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are set: **access tokens are minted server-side** as HS256 JWTs with
  `node:crypto` (`iss` = API key, `sub` = member, a `video` grant with the room; observers `canPublish: false,
  hidden: true`), handed to each member once admitted. **Honest limit:** LiveKit's client protocol (protobuf over
  its own websocket signalling) cannot reasonably be spoken without its SDK, so **the browser side is not bundled**:
  an operator who wants it sets `LIVEKIT_CLIENT_URL` to an ESM build of `livekit-client` they host. The token
  minting is tested; the browser adapter and a real LiveKit server were **not exercised here**. Without the client
  module an SFU room cannot carry media. The room logic (waiting room, admit, stimuli, chat, notes, recording) is
  Rescript's either way. The mesh needs no provider at all.

### Recording and transcription

With consent, **each person's own browser records their own microphone** (and, when the session records video,
their camera) with `MediaRecorder`, in **standalone chunks of 30 s** (the recorder restarts each chunk, so every
chunk is a complete, playable WebM/Opus file). Each chunk is **uploaded as it ends** through the existing media
upload (`ticket` → PUT to a signed URL of the **private `rescript-qual` bucket**, kind `qual_recording` → `confirm`,
verified by the store; resumable by the same client token; retried until it lands; kept in the browser's IndexedDB
until confirmed, so a reloaded or reopened tab of the same person sends what the last one could not). A chunk's
number is the session second it started at, so a reload never reuses one.

Each chunk is **transcribed on its own** (metered per minute, `qual_live_transcription`) — so **attribution is
perfect** (one speaker per chunk; no diarization needed) — while the moderator's console is open (a few chunks per
8 s) and by **Finalize**. Finalize moves every chunk's timed segments onto the session clock and **merges them by
time** into **one transcript** (`qual_transcripts`, source `stt`, `meta.origin = "live_session"`): Moderator and
P1…Pn as speakers, participants' segments as groups, consecutive pieces of one speaker in one chunk joined into a
turn, overlapping speech kept as separate turns in start order (warned). Each segment keeps a pointer to its chunk
(`meta.media[segment] = { audio, video?, offset }`), so **highlight clips** play the right file from the right
second. The `qual_sessions` record (created "planned" at booking) becomes **completed** with participants, no-shows,
consent ("accepted on the live-session consent screen before joining") and the observers' notes as timestamped
observations; **auto-coding** is queued. Coding, synthesis, highlights and reports read it unchanged.

**Long recordings:** a chunk is ≤ 2 minutes of Opus (well under the 25 MB a speech-to-text request takes), so the
long-audio splitter is never needed for live sessions; a full recording uploaded on the Sessions tab still uses it.

### AI assist for the human moderator (optional, live)

A side panel on the console, for the moderator only: the **rolling transcript** (from the per-speaker chunks),
**guide progress computed by code** (which guide questions the moderator has asked — ≥ 60 % of a question's
content words in one moderator turn — and the section timer, over time or not), and on request (or every 90 s if
ticked) **one metered call** (`qual_live_assist`) for **suggested probes / follow-ups** and **objectives not covered
yet**. The transcript tail reaches the model **PII-redacted** (e-mails, phones, the names list) and **fenced** as
data; a suggestion is shown only if it passes the probe checks (no contact requests, no links, nothing about the AI,
on topic, a question, citing a real turn) — the rest are held back and counted; objectives are named only by their
number in the guide. **The AI never speaks in a human-moderated session**: nothing it writes reaches participants.

### Scheduling and invitations

Session time in a time zone, duration, maximum participants, segment, recording (audio / also video), AI assist,
waiting room. **Participant slots with unique join links** (one per person) and **observer links**: each link's token
is **derived from a server secret** (`LIVE_LINK_SECRET`, else a key derived from the service-role key) and the
invitation id + version — the database keeps **only its SHA-256**, and the Studio can show the link again later;
"New link" bumps the version (the old link stops working), "Revoke" kills it. **E-mail** invitations and reminders
through the existing sender (`lib/mail.ts`, kind `respondent_invitation`, bulk stream, de-duplicated) when
`RESEND_API_KEY` / `MAIL_FROM` are set — otherwise the links are copied by hand (said on the tab). Reminders go out
when someone presses *E-mail reminders* (there is no background scheduler). G3's alert / Slack sender was not present
when this was written; `send` is the one function to switch to it. **Waiting room**, **no-show tracking** (a link never
used is marked no-show at Finalize, and listed on the session record), status into `qual_sessions` (planned →
completed / cancelled).

## 2. Intelligent Mode and the registry

"**schedule two focus groups of 6 next Tuesday 6 pm IST with Mumbai and Delhi segments**" → engine
`interpretLiveSchedule` (pure, deterministic: count, kind, size, day, time, zone — IST → Asia/Kolkata, EST →
America/New_York with daylight saving, IANA names — segments, duration, parallel or one after the other, recording)
→ a **preview card**: each session's local date and time in its zone, its UTC instant, links, segment, what is
missing ("Which day?" / "What time?"), a time already passed, a guide without consent, a group bigger than the mesh
carries. **Run** creates exactly what the card showed. Design talk ("run two moderated focus groups before the
survey") is not intercepted — no scheduling verb, no day or time.

Registry (`packages/engine/src/capabilities.ts`, `content/docs/capabilities.md` regenerated):

- `qualitative:moderated` — "Live moderated video sessions (focus groups, IDIs)": **partial**
  (limitations: mesh 6 + 3; no TURN → some networks fail; LiveKit browser client not bundled; long-polling; browser
  recording; no background worker).
- `qualitative:video_conferencing` — **partial**, pointing to the above (text group sessions stay text).
- new `qualitative:live_recording` (requires media storage, speech-to-text, database), `qualitative:live_assist`
  (requires a language model), `qualitative:live_turn` (requires `webrtc_turn`), `qualitative:live_sfu` (requires
  `sfu`), `qualitative:live_scheduling` (supported).
- new services `webrtc_turn` and `sfu` on `/platform` readiness.
- The model's capability brief (capped at 2,200 characters) names the live feature once (`qualitative:moderated`); its
  facets (recording, assist, TURN, SFU, the video-group alias) stay in the registry, on `/platform` and in
  `capabilities.md`, and an unconfigured one is still named as "not configured" from readiness (`BRIEF_FACETS`).

The copilot guides now say live sessions exist (and that booking is a preview card): `qualStudyGuide.ts`,
`researchGuide.ts` (qualitative guide), `aiInterviewGuide.ts` (the AI moderator does not run multi-party video),
`qualSynthesisGuide.ts`.

## 3. Data — migration 0071 (re-runnable; applied twice on Postgres 16)

| table | what |
|---|---|
| `live_rooms` | one session: `state` (status, settings, the guide snapshot — consent, stimuli, sections, questions, objectives — the stage, the moderation log), `version` (compare-and-set), `rev` (bumped on any change; long-polls wake on it), `qual_session_id`, `transcript_id` |
| `live_room_invites` | participant slots and observer links: label, e-mail, segment, status (pending / joined / no_show / revoked), `link_version`, **`token_hash`** (unique; the token is never stored) |
| `live_room_members` | role, handle (`P<n>` / `Moderator` / `Observer n` — a name is refused by a CHECK), state (waiting / admitted / left / removed / denied), recording consent, media state, **`token_hash`** of the member token |
| `live_room_signals` | offer / answer / candidate / meta / bye between two members, never to oneself; `expires_at` (2 min) |
| `live_room_notes` | the back room: `chat` and `note` (with `offset_seconds` from the start) |
| `live_room_tracks` | each recorded chunk: member, audio / video, `seq` (unique per room, member, kind), `start_ms` (server clock), duration, `media_id`, status (uploading → stored → transcribing → transcribed / empty / failed), the chunk's transcript, a lease |

Functions (service role only; revoked from anon and authenticated): `rescript_live_save` (compare-and-set + rev),
`rescript_live_touch`, `rescript_live_poll` (rev + signals after a cursor in one round trip),
`rescript_live_sweep` (TTL), `rescript_live_claim_track` (one transcriber per chunk).

**RLS** like 0065 / 0070: roles that read responses may SELECT rooms, members, notes and tracks; **invites (e-mails,
link hashes) and signals have no member policy at all**; the members' `token_hash` is not selectable (column grants);
nobody but the service role writes. `/api/platform` probes 0071. **Order:** apply 0071, then deploy (without it the
Live sessions tab answers "Live sessions need database migration 0071"; everything else works).

## 4. Access (the Data module, `lib/qual/qualAccess.ts` — no new permission)

Schedule, invite, e-mail, cancel, **moderate**, finalize = Data: Edit; **observe** and read the list = Data view;
names and e-mails of invitees only with contact details; links only to Data: Edit. Every Studio request passes the
guard (the auth-guard audit stays at 0 problems) **and** carries a member token of a room in that project;
moderation, transcription and assist need the moderator's seat. The respondent app's routes take a member token
(participants and external observers) and never serve the moderator. Recordings play through the existing playback
check (Data view + contact details).

## 5. Where to find it

| Feature | Where |
|---|---|
| Schedule, links, observer links, e-mail invitations / reminders, cancel | Studio → **Research Tools → Qualitative → Live sessions** (form at the top; *Details* on a session) |
| Run the session (moderator) | Live sessions → a session → **Moderate** → camera check → **Enter the room** → *Open the waiting room* → *Admit* → *Start the session* |
| Waiting room, mute / spotlight / remove, stimuli, section timers, back-room chat, notes, recording progress, rolling transcript, **AI assist** | the console (right-hand panels; *Suggest probes*) |
| Observe as a project member | Live sessions → **Observe** (while the room is open or live) |
| Observe as a client | the observer link (*Add observer link (client)*) → `/live/<token>` |
| Join as a participant | their link → `/live/<token>` (consent → device check → waiting room → room) |
| Turn the session into a transcript | the console's **Finalize → transcript** (or the session row's button) → Transcripts / Coding / Synthesis / Highlights |
| Schedule in words | Intelligent Mode: "schedule two focus groups of 6 next Tuesday 6 pm IST with Mumbai and Delhi segments" → preview card → **Schedule** |
| Readiness | `/platform` (services *TURN relay*, *SFU*; migration 0071) |

## 6. Environment

| Variable | App | Purpose |
|---|---|---|
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` | Studio, runtime | Cloudflare TURN (added 2026-10-23): credentials are minted per person through Cloudflare's API (`…/credentials/generate-ice-servers`, TTL from `WEBRTC_TURN_TTL_SECONDS`, port-53 addresses dropped); takes precedence over the settings below; if Cloudflare does not answer in 8 s the session falls back to them, with a warning |
| `WEBRTC_TURN_URLS` | Studio, runtime | `turn:` / `turns:` URLs, comma-separated |
| `WEBRTC_TURN_SECRET` | Studio, runtime | shared secret → time-limited credentials per person (recommended) |
| `WEBRTC_TURN_USERNAME`, `WEBRTC_TURN_CREDENTIAL` | Studio, runtime | static TURN credentials (instead of the secret) |
| `WEBRTC_TURN_TTL_SECONDS` | Studio, runtime | credential lifetime, 600–86400 (default 21600) |
| `WEBRTC_STUN_URLS` | Studio, runtime | STUN servers (default `stun:stun.l.google.com:19302`; `none` disables) |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Studio, runtime | the SFU option (token minting) |
| `LIVEKIT_CLIENT_URL` | Studio, runtime | an https URL of an ESM build of `livekit-client` (the browser side; not bundled) |
| `LIVE_LINK_SECRET` | Studio | ≥ 16 characters; the secret invitation links are derived from (default: derived from `SUPABASE_SERVICE_ROLE_KEY`) |
| `RESEND_API_KEY`, `MAIL_FROM` | Studio | invitation / reminder e-mails (existing) |
| `AI_STT_API_URL` / `AI_STT_API_KEY` / `AI_STT_MODEL` | Studio | per-speaker transcription (existing) |
| `AI_API_URL` / `AI_API_KEY` / `AI_MODEL` | Studio | the assist panel (existing) |
| `R2_*` or Supabase Storage | Studio, runtime | the private recordings bucket (existing) |
| `NEXT_PUBLIC_RUNTIME_URL` | Studio | the base of participant links (existing) |

## 7. Files

**New:** `packages/analytics/src/live/{room,merge,assist,service,storeDb,chunks,session,client,livekitAdapter,credentials,server,index}.ts`
(+ `liveRoom.test.ts`, `liveCredentials.test.ts`; subpaths `@rescript/analytics/live` and `/live/server`);
`packages/engine/src/liveSchedule.ts` (+ test); `supabase/migrations/0071_live_sessions.sql`;
Studio `lib/live/liveServer.ts`, `lib/live/liveCard.test.ts`, `app/api/surveys/[id]/qual/live/route.ts`,
`…/live/room/route.ts`, `…/live/media/[action]/route.ts`, `components/studio/qual/{LiveSessionsTab,LiveConsole}.tsx`,
`liveApi.ts`, `live.css`; runtime `lib/live.ts`, `app/api/live/route.ts`, `app/api/live/media/[action]/route.ts`,
`app/live/[token]/page.tsx`, `components/LiveSession.tsx`, `components/liveSession.css`;
`scripts/live-sessions-sql-test.sql`, `scripts/live-session-test.mjs`.

**Changed (small, anchored):** engine `qualIntent.ts` (the `schedule_live` request), `index.ts`, `capabilities.ts`
(entries, services) and tests `capabilities.test.ts`, `capabilitiesReadiness.test.ts`, `aiInterviewActions.test.ts`;
analytics `package.json` (exports, test glob); Studio `QualPanel.tsx` (tab), `lib/copilot/qualCard.ts`,
`components/intelligent/copilot/qualTurn.ts`, the four guides and `qualStudyGuide.test.ts`,
`lib/qual/synthesisWorkspace.test.ts`, `app/api/surveys/[id]/qual/highlights/route.ts` (clips of live transcripts),
`app/api/platform/route.ts` (0071 probe), `components/studio/qual/GroupsTab.tsx` (`data-id` on items); `scripts/research-intelligence-test.mjs` (the registry status), `scripts/group-session-test.mjs` (two race fixes); `content/docs/capabilities.md`;
`content/docs/*.md` (regenerated).

## 8. Not done, and why

- **LiveKit browser client** — not bundled (no SDK dependency; its protocol is not reasonably spoken without it).
  Tokens are minted and tested; set `LIVEKIT_CLIENT_URL` to use it — the adapter and a real server are untested here.
- **Server-side recording / composite recording** — none (no media server): each person records themselves. A tab
  closed mid-chunk loses at most that chunk (≤ 30 s); someone without `MediaRecorder` support or a microphone is
  not recorded (said on the transcript).
- **Background worker** — chunks are transcribed while the moderator console is open or by Finalize; reminders are
  sent by a button. A Vercel cron could drive both; it needs a billing identity without a user (as F2 noted).
- **Websockets / streaming** — signalling is long-polling (≤ 8 s polls; a few hundred ms of latency per message).
- **Mesh size** — 6 participants + 3 observers; the moderator's uplink carries the observer relay.
- **Participant names** — participants see each other as P1, P2 …; the moderator sees the invite's label.
- **The participant page's chrome is English only** (as for AI interviews).
- **Video stitching** of clips (unchanged from F2), **word-level** clip timings for live chunks.
- **Real-network testing**: NAT traversal, TURN, mobile browsers (Safari's `MediaRecorder` writes MP4/AAC — accepted
  and transcribed, not split), bandwidth adaptation beyond the relay's bitrate cap.
- **G3's sender** for e-mail / Slack reminders was not present; the existing mail sender is used.

## 9. Verified here (2026-10-22 / 23)

Everything on the fake provider (`AI_API_URL=fake:`), the sandbox (no database: the runtime forwards to the Studio's
sandbox), Chromium headless with fake camera and microphone. No real TURN, LiveKit, STT provider or model.

| What | Command | Result |
|---|---|---|
| live unit tests (room, roles and permissions, who may signal whom, consent gating, the service over the memory store incl. long-poll / reconnection / removal / TTL sweep, transcript merge by timestamps and clip pointers, the assist checks, perfect negotiation against a fake peer connection, connection pairing ids, TURN REST vs an openssl vector, the LiveKit JWT shape / signature / expiry / tamper, derived links) | `cd packages/analytics && pnpm -s build && node --test dist/live/*.test.js` | **15 / 15** |
| analytics (all) | `node --test dist/*.test.js dist/*/*.test.js` | **744 / 744** |
| engine (all; new `liveSchedule.test.ts` 6) | `cd packages/engine && node --test dist/*.test.js` | **2280 / 2280** |
| Studio lib (new `lib/live/liveCard.test.ts` 3) | `cd apps/studio && node --experimental-strip-types --no-warnings --test "lib/**/*.test.ts"` | 829 / 830 — the one failure is `copilot.test.ts` "every action the engine accepts" on `connect_panel`, G3's action in progress |
| SQL | 0071 applied **twice** on a private copy of the scratch cluster (Postgres 16, port 55471, stopped after); `psql -v ON_ERROR_STOP=1 -f scripts/live-sessions-sql-test.sql` | 5 groups pass; `qual-research-sql-test`, `qual-synthesis-sql-test` still pass |
| tsc | Studio / runtime `nice -n 10 npx tsc --noEmit -p .`; analytics / engine build | no error in G2 files (engine errors seen belong to other engineers' work in progress) |
| audits | `auth-guard-audit`, `dependency-boundaries`, `gen-public-docs --check` | 0 problems, 0 violations, current |
| corpus | every quoted sentence of the production-intents, injection, eval and copilot suites through `interpretLiveSchedule` | 3,290 sentences, 0 intercepted |
| **browser** | `flock /tmp/p0/heavy.lock node --experimental-strip-types --no-warnings scripts/live-session-test.mjs` | **11 / 11** (moderator + 2 participants + 1 observer; consent gate; device check; mesh with inbound audio + video RTP growing on every expected connection; relay to the observer; observer invisible; stimulus; timer; mute; back room; reconnection; recording; assist; Finalize → transcript) |
| regression browser | `qual-research-test.mjs`, `group-session-test.mjs`, `research-intelligence-test.mjs` | **9 / 9**, **7 / 7**, **4 / 4** |

Fixed on the way (found by the browser suite): a peer that dropped and reopened its side was renegotiated onto the
other side's old connection (ICE connected, DTLS never completed) — now each connection has its own id; a chunk
interrupted by a reload was lost — now kept in IndexedDB; Finalize waited 15 minutes for a chunk whose upload had
died — now it waits only for the final chunk window (2 minutes) and marks the rest; the Studio's own list refresh
cleared the "now a source" note. In others' suites: `group-session-test` picked an earlier run's "Auto group" from the
persisted sandbox (now by id; `GroupsTab` items carry `data-id`) and read a rating sample before the last answer
landed (now waits for the full sample); `capabilitiesReadiness.test.ts`'s "full environment" lacked G1's realtime
voice variables.

**Environment note:** the Studio dev server is repeatedly OOM-killed at ~4.3 GB (`dmesg`: "Memory cgroup out of
memory: Killed process … next-server"); the suites retry around it, but runs take long.
