# AI interviews: real-time voice with interruption, and the participant page in every language — 2026-10-22

Engineer G1. This builds on F1's AI-moderated interviews (`docs/AI-INTERVIEWS-2026-10-22.md`). Two things change:

1. **Voice can be a real conversation.** The participant talks hands-free and can interrupt the moderator. The moderator starts speaking before its reply is fully written. A realtime speech-to-speech provider is supported as an option.
2. **The participant page speaks the participant's language.** That covers every label, button and message, right-to-left layout for Urdu and Arabic, and a scripted fallback in each study language.

No migration and no new npm dependency. Everything is additive. Existing studies and guides read exactly as before.

> **Honest status.** All of this was exercised with the **fake** providers: the fake model, fake speech-to-text, fake text-to-speech and the fake translator. Chromium's fake microphone played a generated WAV. **No real model, STT, TTS, translation or realtime provider was called.** Real latency will be higher than the figure measured here, which includes no network or model time. The realtime path is unit-tested against a fake provider only, because no provider was available. Its browser half (WebRTC) has not run against a real provider.

## Where to find it

| Feature | Where | Env |
|---|---|---|
| Voice styles per study (tap to talk / hands-free conversation / realtime) | Studio → Research Tools → **Qualitative** → **AI interviews** → **Setup**: the **Voice** row appears when the *voice* mode is ticked. Realtime is greyed out, with the reason, when no provider is configured | Realtime needs `AI_REALTIME_API_URL`, `AI_REALTIME_API_KEY`, `AI_REALTIME_MODEL` (optional: `AI_REALTIME_VOICE`, `AI_REALTIME_TRANSCRIBE_MODEL`, `AI_REALTIME_PROTOCOL=openai`) on the **runtime** (and on the Studio, for its readiness display) |
| Intelligent Mode | “run it as AI voice interviews, hands-free” → `configure_ai_interviews` `voiceStyles: ["conversation","turn_based"]` | — |
| Languages and fallback wording (status, **Translate now**, **Review**, **Save wording**, **Save and apply to the running study**) | Same tab → **Languages** card (under Setup) | Translation: `TRANSLATION_PROVIDER` / `GOOGLE_TRANSLATE_API_KEY`, else the AI model (`AI_API_URL`) |
| Wording translated at launch | **Launch** / **Relaunch** in the same tab: missing or out-of-date languages are translated first, and the wording travels with the snapshot | as above |
| The participant page in their language | `/i/<token>`: picked from the study's languages, then the browser (`navigator.languages`, `Accept-Language`); a **Language** selector; `?lang=xx` forces one | — |
| Hands-free conversation (participant) | `/i/<token>` → “Talk naturally, hands-free (you can interrupt)” → Start. A status bar shows listening / hearing you / thinking / speaking, with a **Pause** button | STT (`AI_STT_API_URL` or `AI_API_URL`), TTS (`AI_API_URL`, `AI_TTS_MODEL`, `AI_TTS_VOICE`); without TTS the browser's own voice speaks |
| Realtime (participant) | “Talk naturally — low latency”, offered only when the runtime has a gateable provider | `AI_REALTIME_*` |
| Interruptions and latency (researcher) | Live view **Interviews** table: the chip next to the mode reads *conversation · N interruptions · ⏱ median*. **Open** an interview: the moderator turn the participant spoke over shows the unheard part struck through, with an *interrupted* badge. The participant's turn shows *spoke over the moderator* and the previous reply's latency | — |
| Readiness | `/platform` and the capability registry: `qualitative:ai_interview_realtime` (service `realtime_voice`) says which variable is missing, or why the protocol is refused | — |

## 1. Voice conversation with barge-in (the default voice style)

The style works with any configured STT and TTS. If TTS is not configured, the browser's own voice is used.

**In the browser** (`apps/runtime/lib/voice/`; no dependencies)

- **Capture.** `getUserMedia` opens the microphone with `echoCancellation`, `noiseSuppression` and `autoGainControl`. Web Audio feeds 20 ms frames to a pure **voice-activity detector** (`vad.ts`):
  - Energy is measured in dBFS over an adaptive noise floor, with **hysteresis**: speech starts at +14 dB and holds down to +7 dB.
  - The zero-crossing rate must fall inside a band. Broadband hiss crosses zero too often and mains hum too rarely.
  - A turn starts after 140 ms of voiced frames, dated at its onset; a 400 ms pre-roll keeps the first syllable. It ends after **800 ms of silence**, dated at the last voiced frame.
  - The floor is calibrated from the first 240 ms. One utterance can run for at most 60 s.
- **Utterances are recorded by the page itself, as 16 kHz WAV** (`wav.ts`). No MediaRecorder codec is needed, which is what lets this work in Safari and Firefox. Each utterance is sent to `/api/ai-interview/transcribe` and then to the turn route automatically, with no button. The consented recording is the same WAV, uploaded alongside. It is attached to the turn if the upload finishes before speech-to-text does; otherwise the turn goes without it.
- **Turn-taking** is a pure state machine (`bargeIn.ts`): listening → user speaking → processing → speaking.
  - **Barge-in:** speech while the moderator is speaking stops playback at once and opens a new utterance. The page records how many characters of the turn had been played.
  - The **first 300 ms** of each playback are ignored, while the echo canceller converges. While the moderator speaks, the start threshold rises by 10 dB.
  - Speech while a reply is still being prepared means that reply is not played when it arrives. It is recorded as interrupted, with nothing heard.
  - A new utterance waits for the turn in flight. Turns therefore stay in order, and a resend still replays rather than answering twice.
- **Playback** (`duplex.ts`) plays the reply's sentences in order **as they arrive**. Each sentence plays from the server's audio, or from the browser's voice when the server has none for it. The **headphone hint** is on the consent screen.
- **Latency** runs from the end of speech (the last voiced frame) to the first audio of the reply. It is measured per reply, shown on the page (`data-latency-ms`), and sent with the next turn. The live view shows the median.

**On the server** (`apps/runtime/lib/aiInterview/{voice,speech}.ts`, `service.ts`)

- The model is told to write its JSON with **`intent` first** (the schema order and the rules' REPLY line). The intent is therefore known before the words.
- **The speech gate** (`packages/engine/src/aiInterviewVoice.ts`) cuts the streamed `say` into sentences, with sentence ends for Latin, Devanagari `।`, Urdu `۔`, Arabic `؟` and CJK `。！？`, abbreviations, and very short and very long sentences handled.
  - Each sentence is **released for speech only after the per-sentence output checks**: no link, e-mail or phone; no request for contact or identity details; nothing about the AI's instructions; the participant's language for sentences of 15 letters or more.
  - It is released only while the intent is one the rules allow.
  - A sentence that fails **closes the gate**: nothing more of that reply is spoken. The whole-reply check (`finishTurn`, which now takes the gate's problems) then replaces the reply with the guide's scripted turn, and that turn is spoken **after** what was already said. The stored moderator turn is what the participant actually heard: the spoken prefix, then the scripted turn.
  - Rules replies (safety, caps, conditional probes, fallbacks) are final before they are spoken, so they are spoken whole, sentence by sentence.
- Each cleared sentence goes out in the turn's NDJSON stream as `{type:"speak", i, text}`. It is synthesized **in parallel**: `synthesizeSpeech` in the participant's language with `AI_TTS_VOICE`, metered per character as `qual_ai_interview_tts`. Its audio follows as `{type:"audio", i, mime, b64}`, or `{type:"audio", i, none:true}`. The first sentence plays while the model is still writing the rest. Only gated text is ever synthesized.
- **Interruptions reach the moderator.** The next turn carries `voice.interrupted.heardChars`. The server measures it against the **stored** last moderator turn, never against text from the page.
  - If the participant cut the turn off **before its question** and said too little to be an answer (fewer than 4 words), the rules ask the question again with a new intent, `repeat` (“Sorry — let me ask that again. …”). This is not counted as a follow-up.
  - Otherwise the model's turn context says: *“INTERRUPTED: the participant spoke over your last turn; they heard only: … They did (NOT) hear your question …”*.
  - Every reply's decision record carries `interrupted: {heardChars, heardQuestion}`. The participant's turn records `voice: {interrupted: {seq, heardChars, of}, previousReplyLatencyMs}`. The moderator state counts `voice.interruptions` and keeps up to 200 `latenciesMs`.
- **Nothing is spoken that did not pass the gates.** Injection fencing, distress rules, caps and the scripted fallback all run before the model exactly as before. The per-sentence output checks run before speech, and the whole-reply checks run before the turn is recorded.

**Fallbacks** (said to the participant in their language, and recorded in `state.voice.fallback`)

| Situation | What happens |
|---|---|
| No Web Audio, an insecure page, or no `getUserMedia` (`conversationSupport()`) | The consent screen says “Hands-free conversation isn't available here (reason), so you'll tap to speak instead”. The interview runs turn-based, and the first turn records the fallback |
| The microphone is refused at Start | The same, with the reason “no microphone access” |
| No MediaRecorder | Turn-based voice says “Voice is not available — please type your answer” instead of throwing |
| A realtime connection fails | Falls back to the hands-free conversation (“The low-latency voice could not connect…”), else turn-based |

**Browser behaviour, as far as can be said without the devices:**
- **Chrome and Edge** (desktop and Android): full support. This is what the browser suite runs.
- **Firefox:** Web Audio and `getUserMedia` behave the same, so it should work. Not run here.
- **Safari and iOS:** `webkitAudioContext` is supported, and the AudioContext is created inside the Start click, as iOS requires. iOS routes playback to the earpiece and lowers its volume while the microphone is open, so the headphone hint matters most there. Not run here.

`createScriptProcessor` is deprecated but is still the one capture path every browser has. An AudioWorklet port is listed under not done.

## 2. Realtime (optional; `AI_REALTIME_*`)

**Server** (`apps/runtime/lib/aiInterview/realtime.ts`, `app/api/ai-interview/realtime/session`):
- `POST /realtime/session {sessionToken}` mints a **10-minute client secret** for one WebRTC session. It uses plain fetch to `POST <AI_REALTIME_API_URL>/realtime/client_secrets` with:
  - `session.type: "realtime"`, the model, and `instructions` = the moderator rules + spoken-reply rules + the guide (`realtimeSessionInstructions`)
  - the four **tools**: `probe`, `next_question`, `check_in`, `end_interview` (with `covered` and `reason`)
  - input transcription in the participant's language, the voice, near-field noise reduction
  - **`turn_detection: {type: "server_vad", create_response: false, interrupt_response: true}`**
- The key is only in the server's Authorization header. The GA answer (`{value, expires_at}`) and the beta answer (`{client_secret: {value}}`) are both read. Errors are mapped without echoing the key.
- 501 with the reason when the provider is not configured or cannot be gated.

**Browser** (`lib/voice/realtimeClient.ts`, plain `RTCPeerConnection`): it sends an SDP offer to `<base>/realtime/calls` with the secret, uses the data channel `oai-events`, and reads both GA and beta event names.

**Gating.** `create_response: false` means the provider **never answers by itself**. Each participant transcript goes through `POST /api/ai-interview/turn` with `realtime.prepare`, so the engine's rules decide first:
- **A rules turn** (check-in, boundary, stop, conditional probe, caps, scripted fallback) is recorded and comes back to be **spoken verbatim** (`response.create` with exact-words instructions and `tool_choice: none`). The provider's transcript of it is sent with the next turn and compared (`spokeVerbatim`, 70% word overlap). A mismatch is flagged `realtime_unchecked`.
- **A model turn** comes back as the provider's instructions for this turn: the same rules, guide, turn context and allowed tools as a written turn, with the participant's words fenced. The provider speaks and calls a tool. Its **transcript and tool call** are posted (`realtime.transcript` + `call`) and checked by `finishTurn` like a written reply. They are recorded as said.
- **A reply that fails a check** is flagged `realtime_unchecked` (warning). The guide's scripted turn is then spoken verbatim as a **correction**, and the transcript holds both.

**Why it is not gated as well, and what is refused:**
- The provider speaks the model's words **before** they can be checked. In this style, output checks are **post hoc**, not preventive. That is why realtime is off by default per study, greyed out without a provider, and has a tooltip in Setup saying so. For sensitive topics, use the hands-free conversation, which checks every sentence before it is spoken.
- Only `AI_REALTIME_PROTOCOL=openai` is accepted. Another protocol is refused, because these properties could not be checked: no automatic response (manual response control), input transcription, function tools, and ephemeral secrets. The registry and `/platform` say this.
- The transcripts reach the server **through the participant's browser**. A participant who tampers with their own page can affect only their own interview.
- Realtime audio minutes are **not metered** on the project meter. Usage is not observable without a server-side connection to the session. Each realtime model turn records cost 0.

## 3. The participant page in every language

**The catalog** (`packages/engine/src/aiInterviewMessages*.ts`):
- **77 messages**: loading, link errors, paused or closed, screened out, full, the test badge, the about line, consent, the AI notice, modes, voice and recording texts, language, the screener heading, start, the chat header, mute, stop and its confirmation, you, done, continue, codes, every voice prompt, the conversation states, the headphone hint, fallbacks, ended by the team, and errors.
- **Built in for 20 languages:** English, Hindi, Marathi, Bengali, Tamil, Telugu, Gujarati, Kannada, Malayalam, Punjabi (Gurmukhi), **Urdu (RTL)**, **Arabic (RTL)**, Spanish, Portuguese, French, German, Indonesian, Japanese, Chinese (Simplified) and Korean.
- They were written and reviewed by me (an AI) for meaning, register and natural phrasing. They have **not** been reviewed by native speakers. Have them checked before a production study in those languages.
- Server errors are mapped by `code` to the catalog, so the participant never sees English in another language's page.

**The moderator's rule words** (`aiInterviewWords*.ts`) are built in for the same 20 languages: opening, thanks, nudge, the **distress check-in**, resume, boundary, the six closings, the default probes, coverage, “please look”, “let's stay with the interview” and `repeat`. Before this change they existed in English and Hindi only. The safety-critical check-in in every language offers stop or continue and points to local emergency services or someone the participant trusts.

**Choosing the language.** `pickInterviewLanguage` takes the first of the participant's preferences that the study offers, then the study's first language, then the participant's first preference when the study is open to any language. Preferences are `?lang=`, then `navigator.languages`, then `Accept-Language` (read by the page's server component). The **Language** selector lists the study's languages, or the 20 built-in ones, by their own names. The interview runs in the chosen language and the page follows it.

**RTL.** For Arabic, Urdu, Persian, Hebrew, Pashto and Sindhi:
- `dir="rtl"` is set on the shell and on `<html>`, and `lang` is set.
- Bubbles mirror: the moderator's is on the right and the participant's on the left, through flex start and end and logical corners.
- `dir="auto"` is set on every user and moderator text, so mixed scripts render correctly.
- An Arabic-script font stack is used (Noto Naskh Arabic / Noto Nastaliq Urdu when installed).

**Any other language the study selects** gets the catalog machine-translated at launch. It is stored in the study's language pack (`ui`) and edited like the rest. A missing key falls back to English per key, never to an empty button.

## 4. The scripted fallback in any language

**The language pack.** For each study language other than the guide's, `aiModeration.translations[lang]` (schema `AiLanguagePack`; optional, so no migration) holds:
- `texts`: the guide's own words by key. These are the title, questions, section leads, probes, the conditional probes' triggers and asks, opening, closing, thank-you, incentive, objectives, text stimuli, the consent statement / recording disclosure / data use, and the screener questions and options.
- `words`: the moderator's rule words. Only for languages without built-in ones.
- `ui`: the page's labels. Only for languages without built-in ones.
- `source`: `machine` or `edited`.
- `sourceHash`: a fingerprint of the guide wording. A changed guide marks the pack *out of date*.

**Made at launch.** **Launch** first translates every language that has no pack, is out of date, or is missing keys (`translatePacks`), then launches with the packs. That goes through the Studio's metered `/api/ai/translate`, with the project's provider, the cache, placeholders such as `{name}` kept verbatim, and links refused. The packs are written to the guide (an undoable edit, “AI interview wording”) and sent with the launch request, so the **snapshot** has them even before autosave runs (`parsePacks` validates and bounds them; `withPacks` merges them). The tab's **Translate now** does the same ahead of time.

**Reviewed and edited.** **Review** lists every key: the source on the left, the wording on the right. **Save wording** stores it as `edited`; a re-translation keeps edited wording unless the guide changed. **Save and apply to the running study** also updates the launched snapshot through the route action `translations` (`ai_interview_studies.guide`, audited as `qual_events` `ai_interviews.translations`). In the sandbox it updates the runtime's in-memory study. Questions and logic are untouched.

**Used by the runtime.**
- `planFor(study, language)` localizes the moderator's plan with the pack (`localizePlan`). The rules, the scripted fallback, conditional probes (their triggers in the participant's language), coverage questions and the opening all speak the participant's language.
- With a pack, the opening needs no model call: it is the reviewed wording.
- The model still gets `GUIDE LANGUAGE` and returns `answerTranslation`, so coding keeps the participant's own words with a translation beside them.
- The public view adds `i18n`: the localized title, consent, screener and labels per language. The screener's options are displayed translated, but the value sent is the guide's label, which the server checks.

A language the study did **not** list (when languages are open) has no pack. Its rules speak the built-in wording if it is one of the 20; otherwise English. The guide's questions stay as written, and the model translates when it is available. This is as before.

## 5. Researcher setup and live view

- **Setup.** Modes (text / voice / voice + camera) as before, plus the **Voice** row: tap to talk, hands-free conversation (interruptible), realtime (low latency).
  - Absent `voiceStyles` means tap-to-talk and conversation, so existing voice studies gain the conversation option.
  - Voice + camera stays turn-based.
  - Saved through `configure_ai_interviews` `voiceStyles` (coerced from words such as “hands-free” and “low latency”). The change list says “voice: conversation / turn-based”.
- **The participant's choices** are “Type my answers”, “Talk naturally, hands-free (you can interrupt)”, “Speak my answers” (tap to talk), “Talk naturally — low latency” (only when the runtime has a gateable provider) and “Speak, with my camera on”.
  - The session's `mode` stays `voice`, because 0069's check allows only text / voice / video. The style lives in the moderator state (`state.voice.style`), so **no migration**.
- **The live view** shows a voice chip per interview: style, interruptions, median latency, and *fell back* when the participant fell back. The transcript marks interrupted moderator turns (the unheard part struck through) and the participant's voice bookkeeping. A new flag kind, `realtime_unchecked`, appears as “Realtime words failed a check”.

## 6. Tests

**Engine:**
- `aiInterviewI18n.test.ts` (7):
  - **catalog completeness**: every key in every built-in language, non-empty, placeholders kept, and the text in the language's script (60% or more of its letters)
  - the rule words complete and passing the moderator's own language check, with questions that end in `?`, `？` or `؟`
  - RTL, native names, Accept-Language parsing and language picking
  - packs: their keys, status, stale detection, the launch warning, and the public text in a language
  - **the fallback in a third language** (Spanish, with the fake translator): the opening with no model call, then `Gracias.` plus the next Spanish question when the provider fails, and the Spanish scripted probe
  - a language without built-in wording (Swahili): the pack's words, a conditional probe on the Swahili trigger, the closing
  - the old behaviour without a pack
- `aiInterviewVoice.test.ts` (6):
  - **TTS chunking**: sentence ends in English, Hindi, Japanese and Arabic, abbreviations, short merges, long splits, streamed equals whole
  - **the speech gate**: cleared sentences, a phone-number sentence closing the gate, a disallowed intent speaking nothing
  - **interruption**: the repeat rule, the model told, the decision record, the counts
  - intent-first JSON and `extraProblems`
  - realtime: instructions, tools, tool-call mapping, verbatim comparison
- AI interview engine tests together, with `aiModerator`, `aiInterviewActions` and `aiModeratorEval`: **41/41**.

**Runtime:**
- `lib/voice/vad.test.ts` (8):
  - **VAD on synthetic buffers**: speech and silence with the onset and end dated, white noise, mains hum, a click, speech over noise, hysteresis, the echo ignore window and bias
  - **the barge-in state machine**: turn, reply, latency, echo ignored, barge-in, queued utterance; interruption while preparing; pause; end
  - WAV, resample, pre-roll
- `lib/aiInterview/realtime.test.ts` (3): configuration and refusals; **the minting request shape** (gate, language, tools, instructions, the key only in the header); minting against a **fake provider**, with GA and beta answers and mapped errors.
- `lib/aiInterview/voice.test.ts` (4):
  - styles and realtime availability
  - **the gated speech of a hands-free reply**: the unsafe sentence is never spoken, and the transcript holds what was heard
  - interruption measured on the stored turn, latency, fallback
  - **the realtime two-phase turn**: respond, record, correction plus flag, verbatim mismatch flag
  - the Spanish fallback through the service
- With the existing `service.test.ts` and `ndjson.test.ts`: all pass.

**Studio:** `lib/aiInterviews/voiceI18n.test.ts` (2): batched translation through the door, kept edits, pack validation and bounds, snapshot merge, realtime readiness, the voice summary. With `view.test.ts` and `aiInterviewGuide.test.ts`: all pass.

**Browser:** `scripts/ai-interview-voice-test.mjs`, run on Chromium with a fake microphone playing a generated WAV of speech-like voiced bursts (gliding pitch, harmonics, syllables) between silences. It covers:
- Studio voice styles, and realtime off with the reason
- **Languages**: Translate now, review and edit Swahili, launch with the wording
- **a hands-free conversation with an interruption**: the spoken opening in sentences, barge-in, an utterance sent with no button, streamed speech with audio, **latency printed**
- the live view's voice chip and the interrupted turn
- **the fallback in Spanish**, with the page in Spanish from Accept-Language
- the Swahili page from the pack, with the researcher's edit
- **the Urdu RTL page**: document and shell `dir`, the labels, mirrored bubbles, a screenshot
- no Web Audio leading to tap-to-talk with the reason
- no page errors

**Results (2026-10-23, fake providers, headless Chromium):**
- `scripts/ai-interview-voice-test.mjs`: **8 passed**. Latency from the end of speech to the first audio was **1054 ms** (an earlier run measured 1284 ms). This includes no network or model time.
- `scripts/ai-interview-test.mjs`, the existing suite: **9 passed**. The text, voice, live view and Coding flows are unchanged.
- Engine AI-interview tests: 41/41. Runtime: 24/24. Studio: 9/9.
- `scripts/auth-guard-audit.mjs`: 0 problems. `scripts/dependency-boundaries.mjs`: 0 violations.
- Known failure that is not from this work: `capabilities.test` "brief < 2200" (2461). The live-session entries other teams added push it over. The realtime entry adds 43 characters, and without it the brief would still be about 2418.

Run them:
- `flock /tmp/p0/heavy.lock node --experimental-strip-types --no-warnings scripts/ai-interview-voice-test.mjs`
- the same command for `scripts/ai-interview-test.mjs`

## 7. Not done, and why

- **Real providers**: no real STT, TTS, translation, model or realtime provider was called (see the status at the top). Real latency will add network, STT and model time to the figure measured here.
- **Realtime on a real provider**: the WebRTC half has not run. Its output checks are post hoc, by design, and that is stated in Setup. Its usage is not metered.
- **Native-speaker review** of the 19 non-English catalogs and rule words.
- **AudioWorklet** capture. ScriptProcessor is deprecated but universal; a worklet port is a contained change in `duplex.ts`.
- **Voice + camera in the hands-free style**: it stays turn-based.
- **Safari, Firefox and phones**: not run here (only headless Chromium).
- **The latency of the last reply** is reported with the next turn, so a closing reply's latency is not recorded.
- **Studio labels** (the researcher's side) stay English. Only the participant page is translated.
