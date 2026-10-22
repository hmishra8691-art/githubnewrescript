# AI-moderated interviews at scale — 2026-10-22

Engineer F1. Weakness #6: Rescript could plan a moderated study and record what happened, but it could not run the interview. This adds an AI moderator. It runs an interview guide one participant at a time, asynchronously, from a public link. Participants can answer by text, by voice, or by voice with the camera on. The moderator works in the participant's language, asks follow-up questions, and covers the study's objectives. The researcher watches the interviews arrive, and the finished transcripts go into the existing qualitative coding workspace.

Everything is additive:
- one optional field on the definition (`qualStudy.aiModeration`)
- one engine action (`configure_ai_interviews`)
- migration **0069**
- new runtime routes and a page (`/i/<token>`)
- one new Studio tab: Research Tools → Qualitative → **AI interviews**

No new npm dependency. `@rescript/storage` (a workspace package) is now declared by the runtime for the recording uploader.

> **Honest status.** Everything was exercised here with the **fake** provider: unit tests, the SQL test on Postgres 16, the service replayed through the memory store, and the moderator eval on the stand-in model. **No real model was called.** The quality of probing with a real model, its cost and its latency will come from the first `scripts/eval-moderator.mjs` run with `EVAL_AI_*` set. The browser suites ran against the orchestrator's live Studio and runtime, also on the fake provider.

## 1. What it does

### Setup (Studio → Qualitative → AI interviews)

An interview guide (`kind: "interview"`) becomes an AI-moderated study through these settings:

- **Modes:** text, voice, voice + camera.
- **Time and length:** target minutes and a cap on moderator turns.
- **Probing:** none, light (1 follow-up) or deep (up to 3), set overall and per question.
- **Objectives** to cover. By default these are the guide's objectives.
- **Languages.** Empty means the participant's own language, any language the provider handles.
- **Screener:** simple questions, or questions copied from a survey question (`fromQuestion`). Some answers screen people out, and answers can assign a segment.
- **Quotas** by segment, and a number of completes wanted.
- **Persona:** name and tone.
- **Stimuli:** image or video (https only) or concept text, matched by name to the guide sections' `stimuli`.
- **After the interview:** incentive, thank-you text, and a redirect URL. The redirect must be https, and only `{{pid}}` may be piped into it.
- **Recording consent** for voice and video: optional or required.
- **Cost caps:** per interview and per study.

The **Simulate** panel lets the researcher talk to the moderator in the page. It uses the engine with the stand-in model: no cost, nothing stored.

**Launch** takes a *snapshot* of the guide and its settings. Editing the guide later never changes a running study; **Relaunch** closes the old study and opens a new one.

Launch is **refused** in these cases:
- there is no consent statement
- voice or video is enabled without a recording disclosure
- the guide is not an interview guide
- a URL is not https

Each launch creates two links:
- a participant link, `/i/<36-hex>`
- a test link, `?test=<36-hex>`, which uses the real provider. Test interviews are labelled, never counted, never coded, and are TEST usage on the meter.

### The participant (runtime `/i/<token>[?pid=…]`)

1. **Consent screen.** It shows the statement, the recording disclosure and the data use, and says the interviewer is an AI. "I agree" is required, and recording is a separate choice.
2. **Screener.** Which answers qualify is decided on the server; the page is never told. People who are screened out, or arrive when their quota is full, are recorded as `screened_out` and thanked.
3. **The interview,** on a phone-first, accessible page: a live `role=log` region, labelled controls, keyboard sending.
   - **Text:** Enter sends.
   - **Voice:** tap to speak. The answer is recorded in standalone pieces of up to 55 seconds and sent to `/api/ai-interview/transcribe`, which uses the existing `transcribe()` through the configured STT, metered per minute. The words are shown so the participant can **correct them before sending**. The original STT output is kept on the turn.
   - **Moderator replies** stream as text (NDJSON) and are spoken: first through the configured TTS (`synthesizeSpeech`, metered per character), otherwise through the browser's own voice.
   - **Voice + camera:** with consent, each answer's recording is stored through the existing upload pipeline (ticket → parts → confirm) in the private uploads bucket.
4. **Resilience:**
   - A reload resumes the interview. The page keeps a resume token; only its SHA-256 is stored.
   - A dropped reply is asked for again from the same position, and the server replays its stored answer instead of answering twice.
   - Silence gets a nudge, then the moderator moves on, then the interview closes as `abandoned`.
   - The Stop button ends the interview politely.
5. **At the end:** a thank-you, the incentive text, and the redirect with the panel's `pid`.

### The moderator (engine `aiModerator.ts`; pure and unit-tested)

The guide is flattened into a **plan**: section → question, exercise or stimulus, each with its probes, conditional probes, depth and follow-up cap, and stimuli. The opening script loses any "may I record?" sentence, because the consent screen already asked.

Each participant input goes through these steps:

1. **Safety, by rule, before any model** (`aiInterviewSafety.ts`, English / Hindi / Hinglish):
   - **Distress:** a gentle check-in, an offer to stop, and an **alert** flag. Stopping ends the interview as `flagged`; "I'm ok" resumes it.
   - **Abuse:** one calm boundary; a second instance ends the interview.
   - **"I want to stop":** the interview closes.
   - **Text that reads like instructions to the AI** (`scanUntrusted`): flagged `manipulation` and **never sent to the model**. The guide carries on.
   - **Contact details the participant volunteers:** masked before any AI call (the same patterns as `qual/redact.ts`, pinned by a parity test) and flagged `pii_shared`.
   - **Quality signals**, flagged only, never refused: gibberish, pasted or implausibly fast long answers (`ai_generated`), repeated one-word answers, and speeders (a finish under 25% of the time).
2. **Caps:**
   - The turn cap closes the interview.
   - Past 150% of the time budget, the interview closes.
   - Past the per-interview AI cost cap, **only the guide's scripted questions** are used.
   - Behind schedule: deep probing becomes light. In the last 10% of the time there is no probing. Over 105%, the remaining non-closing steps are skipped (flagged `over_time`).
3. **Conditional probes from the guide** (`ifMentions → ask`), by rule, each once.
4. **The model** chooses among the **allowed intents** the rules compute: `probe` / `clarify` / `next` / `check_in`, or `close` at the end. It writes `say` in the participant's language, names the objectives covered, may raise flags, and returns a translation of the answer when the participant is not using the guide's language. Where `next` leads is the rules' decision. Before the closing, one **coverage question** is asked for an uncovered objective.
5. **Output checks** on the model's reply (`moderatorReplyProblems`). A reply fails if it:
   - uses an intent that is not allowed now
   - is over 700 characters
   - contains links, e-mails or phone numbers
   - asks for contact or identity details, or about other participants
   - talks about its instructions or the system prompt (leak markers)
   - is off topic (for a probe)
   - is not in the participant's language (a script check across about 40 languages)
   - asks no question when one is due

   A failed check, or a failed provider, falls back to the deterministic reply prepared beforehand: the guide's next unused probe for a thin answer, otherwise the next guide question. These rules speak English and Hindi. The **problems are recorded**. Three provider failures in a row stop model calls for that interview.

Every turn stores a **decision record**: intent, source (model / rules / fallback), reason, step, follow-up count, depth, allowed intents, covered objectives, flags, problems found, elapsed time, and the budget at that moment.

**Prompt caching.** The system blocks are `[MODERATOR_RULES, moderatorGuideBlock(plan)]`. The rules are static and the guide block is byte-identical for every turn of every interview in a study, so the provider caches the prefix. Only the turn's state and the fenced answers go in the user part, with a fresh nonce on each call.

**Metering.**
- Each model call goes through `meteredSessionAi` as operation `qual_ai_interview`, charged to the study's project. Test interviews are TEST usage.
- STT is metered as `qual_ai_interview_stt` and TTS as `qual_ai_interview_tts`. The runtime had no TTS meter, so `meteredSpeech` was added.
- The cost is added atomically to the session and to the study (`spent_usd`).
- The study budget stops admissions.

## 2. Data — migration 0069 (re-runnable; applied twice on Postgres 16)

| table | what |
|---|---|
| `ai_interview_studies` | the launched study: `link_token`, `test_token` (36 hex, unique), `guide` snapshot (QualStudy + aiModeration), status live / paused / closed, `spent_usd`. At most one open study per survey (partial unique index) |
| `ai_interview_quotas` | (study, segment) → target |
| `ai_interview_participants` | P\<number\>, segment, screener answers, consent `{statement, recording, at}`, language, `external_ref` (pid), `is_test` |
| `ai_interview_sessions` | `token_hash` (sha-256, unique), mode, language, status (`in_progress` / `completed` / `screened_out` / `abandoned` / `flagged` / `ended`), `excluded` (+ reason), moderator `state`, `flags`, `turns_count`, `cost_usd`, optimistic `version`, `qual_session_id` / `qual_transcript_id` |
| `ai_interview_turns` | seq (unique per session), speaker, text, `original_text` (STT before correction), language, translation, audio/video media ids, `offset_ms`, `duration_ms`, `decision` |

Two functions make the concurrency-sensitive steps atomic. Both are service-role only (revoked from anon and authenticated).

`rescript_ai_interview_begin` admits a participant under a lock on the study row:
- An interview idle for 30 minutes is swept to abandoned first.
- Admission checks the completes target, a 120% "full for now" ceiling, the study budget, and the segment's quota (completed plus in-progress interviews count against it).
- A paused study admits only test interviews.
- Called with `p_screened_out`, it records a screened-out participant.

`rescript_ai_interview_record_turn` writes one exchange:
- the new state, only at the expected version
- the turns
- the cost, added to both the session and the study
- the completion time

A stale version (a double submit) writes nothing and returns null. A duplicate seq rolls back the whole exchange. A finished interview takes no more turns.

**RLS and grants:**
- RLS works like 0065: roles that read responses may SELECT; custom members, vendors, interviewers and strangers see nothing; nobody but the service role writes.
- **Tokens are never readable by members:** the table-level SELECT is replaced by column grants without `link_token`, `test_token` or `token_hash`.
- 0069 also **widens the 0065 checks**: `qual_transcripts.source` and `format` now accept `ai_interview`. The writers fall back to `import` / `speaker` if a later migration re-tightens them. F2's 0070 does not touch these checks.

`/api/platform` probes 0069. **Order:** apply 0069, then deploy. Without it, the AI interviews tab says that migration 0069 is needed, and the guide's AI settings still work.

## 3. Where the transcript goes (the contract for F2's synthesis)

When an interview completes, the runtime writes the rows itself. When the researcher ends an interview, the Studio writes them. Test interviews are never written. Both writers use the same builder (`qualRowsForInterview`), so the rows are identical. Each interview becomes:

- **`qual_sessions`:** kind `interview`, title `AI interview — P<n> (<segment>)`, `scheduled_at` = the start time, moderator `AI moderator (<persona>)`, participants `[{id: "p<n>", label: "P<n>", segment}]`, consent `{captured: true, recording, method: "AI interview consent screen", at}`, status `completed`, and notes with the mode, the language and the warning-level flags.
- **`qual_transcripts`:** `source = format = "ai_interview"`, `session_id` set, and these fields:
  - `segments`: `[{id: "t<i>", index, speaker: "Moderator" | "P<n>", start (s), end?, text}]`. The participant's text is **their own words**, as they corrected them.
  - `speakers`: `{Moderator: {role: "moderator"}, "P<n>": {role: "participant", group: <segment>}}`.
  - `meta`: `{origin: "ai_interview", studyId, interviewId, mode, participant, segment, translations: {t<i>: "…"}, media: {t<i>: {audio?, video?}}, flags, turns, durationSeconds, moderator, covered, warnings}`.
- **`qual_events`:** `ai_interview.completed`.

Coding, quotes, kappa, themes and the report read these rows unchanged. Moderator turns carry role `moderator`, so they are never coded as a participant's view. In the workspace the transcript shows as "AI interview".

**Excluding an interview** removes its transcript from the workspace, unless coded excerpts already cite it. In that case the transcript is kept and the reply says why.

## 4. The researcher's live view

`GET /api/surveys/[id]/ai-interviews` (Data view) returns:
- **counts:** started, in progress, completed (excluded interviews never count), screened out, abandoned, flagged, ended, excluded, tests, and alerts
- **quotas:** completed and in progress against target
- **AI spend** against the study budget
- **the interviews:** participant, segment, mode, language, status, flags, turns, minutes, and cost

The tab polls every 5 seconds while the study is live. Opening an interview shows its **live transcript** (polled every 3 seconds while it is in progress) with the moderator's reason for each turn, what speech-to-text heard, and translations. The transcript is redacted for members without contact-details access.

Actions (Data edit):
- **End interview:** the participant's page then says the research team ended it, and what was said is written to coding.
- **Exclude** / **Include again**.
- **Pause / Resume / Close** the study, and **Relaunch**.

Access is the qualitative workspace's (`qualAccess.ts`): there is no second permission model. The guard is the first statement in every handler (the auth-guard audit passes).

**Sandbox.** An unsaved project has no database. With the fake provider, the runtime keeps launched studies in memory (`memoryStore.ts`, which follows the same rules as the SQL), and the Studio reaches them through `/api/ai-interview/sandbox` (an observer key). Completed transcripts are imported into the sandbox's in-page coding workspace.

## 5. Intelligent Mode

`configure_ai_interviews` is a patch on `qualStudy.aiModeration` that passes through the gate, the preview diff and the change list. The change list gets a new "AI-moderated interviews" field in the Qualitative guide category. The action is refused without an interview guide, and refused for a focus-group guide. Language names are accepted ("Hindi" → `hi`), and URLs must be https. The provenance gate holds an external or piped redirect URL that came from document content.

For example, "run this guide as AI voice interviews with 50 people in Hindi and English, 20 minutes, deep probing" becomes:

`{"op":"configure_ai_interviews","modes":["voice","text"],"targetCompletes":50,"languages":["Hindi","English"],"targetMinutes":20,"defaultProbing":"deep"}`

**Guide:** `lib/copilot/aiInterviewGuide.ts`, about 2.4k characters. It is sent only when `aiInterviewIntent` matches and is cached like every other guide; the system prompt is untouched. It tells the model never to say that a study is launched or live.

**The qualitative guides now say exactly this:**
- **Not supported:** live HUMAN-moderated sessions, multi-party video calls or live focus groups, and a real-time video conversation. Voice is turn-based.
- **Supported:** AI-moderated 1:1 interviews.

**Capability registry:**
- `qualitative:ai_interviews` is **supported**. Its only service is `ai_chat`, so a database-less sandbox is not refused.
- `qualitative:ai_interview_voice` **requires configuration** (STT, TTS, media storage).
- `qualitative:moderated` is renamed to "Live human-moderated sessions / multi-party video conferencing" and stays **not supported**. Its alias no longer catches "AI moderated".
- `capabilities.md` is regenerated.

## 6. Compared with Outset, Listen Labs, Glaut, Conveo and Qualtrics/Voxpopme-style AI interviewers

This comparison is based on their public material up to mid-2026; it could not be re-checked here.

| | they offer | here |
|---|---|---|
| Async 1:1 AI interviews from a link | yes | **yes** |
| Text / voice / video answers | yes (video with camera on most) | **text, voice (turn-based, with transcript correction), voice + camera recording per answer.** No continuous real-time voice conversation (full-duplex, barge-in); several offer that |
| Dynamic follow-ups, guide-following | yes | **yes, with explicit per-question depth, the guide's conditional probes, objective coverage, time-budget pacing, and a recorded reason for every turn.** Most do not expose the moderator's reasoning |
| Participant's language | many languages | any language the model handles. The scripted fallback speaks English and Hindi; other languages fall back to the guide's own words. **The participant page's chrome (buttons, consent labels) is English only** |
| Screener, quotas, consent | yes | **yes. Quotas are held atomically; launch refuses without consent text** |
| Researcher live view | yes | **yes (polling)**, with distress / abuse / manipulation / quality flags and alerts, End and Exclude |
| Themes, quotes, highlight clips | yes, AI-generated | transcripts land in the existing coding (AI-suggested codes, verbatim-checked quotes, κ, reports). F2 is building synthesis and highlights. **No highlight video clips** (timestamps are stored, but clips are not cut) |
| Panel sourcing / recruitment | some (built-in panels) | **no.** Bring your own panel: `?pid=` in, a redirect with `{{pid}}` out |
| Safety | varies | **rules before the model** (distress, abuse, stop, injection in EN/HI/Hinglish), PII masked before any AI call, output checks on every reply, a deterministic fallback, hard cost and turn caps |
| AI-moderated group sessions | Remesh-style (separate product) | F2's area (0070) |

## 7. Tests

- **Engine:**
  - `aiModerator.test.ts` (20): the plan; the opening; caching (byte-identical system blocks); probing with scripted replies; the follow-up cap; `next` and coverage; conditional probes; the time budget; provider failure and `modelOff`; injection in EN/HI/Hinglish; output checks; PII masking; distress (check-in, stop, continue, model-raised); abuse; stop and silence; the cost and turn caps; quality flags; Hindi; the readers; launch / screener / quota / URL / public view; the qual transcript shape.
  - `aiInterviewActions.test.ts` (7): coerce, apply, diff, change items, patching, refusals, provenance, registry, readiness.
  - `aiModeratorEval.test.ts` (2).
  - Full engine suite: **2198/2200**. The two failures are F4's in-progress rating-based conjoint and, before regeneration, the stale public docs, which are now current.
- **Analytics:** `qual/moderatorRedact.test.ts`, parity of `maskContactDetails` with `redactText`.
- **Runtime:** `lib/aiInterview/service.test.ts` (6) and `ndjson.test.ts` (1). With the existing tests, **27/27**. Runtime `tsc` is clean.
- **Studio:**
  - `lib/aiInterviews/view.test.ts` (5)
  - `lib/copilot/aiInterviewGuide.test.ts` (2)
  - updated: `qualStudyGuide.test.ts`, `aiPromptCache.test.ts`, `copilot.test.ts`
  - copilot / qual / eval / aiInterviews lib tests: all pass
  - Studio `tsc`: no error in these files. The remaining errors are in `qual/coding/route.ts` and `analysisPlanCore.ts`, other engineers' work in progress.
- **Audits:** `dependency-boundaries` 0 violations; `auth-guard-audit` 0 problems; `gen-public-docs --check` current.
- **SQL:** `scripts/ai-interviews-sql-test.sql`, 8 groups, run on a private copy of the scratch cluster (Postgres 16, port 55469, stopped afterwards) after 0066–0068 and **0069 applied twice**. `qual-research-sql-test.sql` (0065) still passes.
- **Eval:**
  - The copilot harness has a new case, `qual-ai-interviews` (create guide + configure; "never says launched"): `pnpm eval:ai --filter qual-` gives 2/2.
  - The moderator harness `scripts/eval-moderator.mjs` (14 cases) gives 14/14 on the stand-in. Run it with `EVAL_AI_API_URL` / `EVAL_AI_API_KEY` / `EVAL_AI_MODEL` (`--max-cost`, `--filter`) for a real model. The report goes to `eval-reports/moderator-*.md`.
- **Browser** (orchestrator's live Studio :3000 and runtime :3001, fake provider, no database): `scripts/ai-interview-test.mjs` **9/9** and `qual-research-test.mjs` **9/9**. The first live run found two bugs:
  - **In the suite:** it read the turn element, which includes the visually hidden screen-reader label "Maya:", and it clicked an interview's row instead of its Open button.
  - **In the product:** `/api/ai-interview/transcribe` read `.text` off `transcribe()`'s `{ok, value}` outcome, so voice answers came back empty. It is fixed, and a failed transcription now answers 502 ("type it instead"). The screen-reader label also gained its missing space ("Maya: ").

**Orchestrator must run:**
1. Build schema, engine, ai, analytics, media and storage.
2. Start the Studio on :3000 and the runtime on :3001, both with `AI_API_URL=fake:` and **no** `SUPABASE_*` on the runtime (the sandbox store).
3. Run `node scripts/ai-interview-test.mjs` (or via chunk: `ONLY=ai-interview-test.mjs node /tmp/p0/chunk.mjs`).
4. Also run `qual-research-test.mjs` and `research-intelligence-test.mjs`: the qualitative tab bar and the registry changed.
5. SQL: `psql -v ON_ERROR_STOP=1 -f scripts/ai-interviews-sql-test.sql` against a database with every migration.

## 8. Not done, and why

- **Real-time full-duplex voice** (talking over the moderator, sub-second turn-taking). This would need a realtime SDK or WebRTC, which the brief rules out. Voice is turn-based.
- **Live multi-party video, or human-moderated live sessions.** There is still no media server. The registry and the guides say so.
- **Highlight video clips** cut at excerpt timestamps, and in-app playback of the per-answer recordings (they are stored privately; playback reuses nothing yet). **Recordings in the sandbox** are not stored, because there is no storage.
- **Participant-page UI in other languages.** The moderator speaks the participant's language, but buttons and labels are English.
- **Scripted fallback beyond English and Hindi.** In other languages, a provider failure gives the guide's own wording.
- **Push alerts** (e-mail or Slack) for distress flags. The alert is shown in the live view only.
- **Panel integration / recruitment.** Only `pid` in and a redirect out.
- **Live view by polling,** not streaming.
- **Studio tab: stimuli, screener and quota editing.** Stimuli are edited in Intelligent Mode, and screener and quotas use a plain-text form.
- **Screener reuse from survey questions** copies a question's text and options at configure time. It is not linked: a later edit to that question is not followed.
- **Translations** come only from the model's `answerTranslation`, which is not verified. Coding uses the participant's own words.
- **Quality flags are heuristics:** typing speed, paste, gibberish and speed. AI-written answers are not detected by a classifier.
- **Real-model numbers** for pass rate, cost and latency per interview: none yet (see the status note at the top).

## 9. Files

**New:**
- `packages/schema/src/aiInterview.ts`
- engine `aiInterviewSafety.ts`, `aiModerator.ts`, `aiInterviewStudy.ts`, `aiInterviewActions.ts`, `aiModeratorEval.ts` (with tests)
- analytics `qual/moderatorRedact.test.ts`
- `supabase/migrations/0069_ai_interviews.sql`
- runtime:
  - `lib/aiInterview/{types,memoryStore,supabaseStore,service,runtimeDeps,gate,ndjson}.ts` (with tests)
  - `app/api/ai-interview/{study,begin,session,turn,transcribe,speak,sandbox,media/[action]}/route.ts`
  - `app/i/[token]/page.tsx`
  - `components/AiInterview.tsx`, `components/aiInterview.css`
- Studio:
  - `lib/aiInterviews/{view,store,sandboxProxy}.ts` (with test)
  - `app/api/surveys/[id]/ai-interviews/route.ts`, `…/[interviewId]/route.ts`
  - `components/studio/qual/{AiInterviewsTab.tsx,aiInterviewApi.ts}`
  - `lib/copilot/aiInterviewGuide.ts` (with test)
- `scripts/ai-interviews-sql-test.sql`, `scripts/ai-interview-test.mjs`, `scripts/eval-moderator.mjs`

**Changed (small, anchored):**
- schema `qualStudy.ts` (+`aiModeration`), `index.ts`
- engine `surveyActions.ts` (wiring), `index.ts`, `qualActions.ts` (diff line), `changeItems.ts` (one field), `capabilities.ts` (two entries; `moderated` renamed / narrowed)
- Studio:
  - `QualPanel.tsx` (tab, intro sentence, source chip)
  - `lib/qual/qualWorkspace.ts` (the `ai_interview` source)
  - `lib/copilot/{prompt.ts,qualStudyGuide.ts,researchGuide.ts}`
  - `lib/aiPromptCache.ts`
  - `lib/eval/cases.ts`
  - tests `aiPromptCache.test.ts`, `copilot.test.ts`, `qualStudyGuide.test.ts`
  - `app/api/platform/route.ts` (0069 probe)
  - `content/docs/*.md` (regenerated)
- runtime `package.json` and `pnpm-lock.yaml` (`@rescript/storage` declared)
