# Qualitative research — moderated interviews, focus groups, AI-assisted coding — 2026-10-18

Engineer E3. Brief §6 (moderated interviews & focus groups) and §7 (AI-assisted qualitative coding): a first
milestone that is validated end to end, and honest about what it is not. Everything is additive: one optional
field on the definition (`qualStudy`), new tables (0065), one new media kind, new routes, one new Studio tab.
No new dependency.

## 1. Audit — what existed (before today)

| Area | What | Status |
|---|---|---|
| Respondent audio / video answers | `video_interview` question (plays a stimulus, records a spoken answer, transcribed); file-upload question (`uploadTypes.ts`: audio .mp3/.wav/.m4a, video .mp4/.mov) into the private `rescript-uploads` bucket; `answer_audio` media kind | implemented (survey answers only) |
| Researcher recordings | `@rescript/media`: signed direct upload (single or multipart, resumable by client token), verify-on-confirm, 15-min signed playback; kinds for question video/audio, localisation audio, assets | implemented — no kind for a session recording |
| Transcription | `/api/ai/transcribe` (a spoken Intelligent-Mode instruction, ≤ 8 MB); media transcript jobs (`media_transcripts`, `runTranscription`: text only, timings discarded, 25 MB cap); `transcribe()` in `@rescript/ai` can return timed segments and diarization; AI_STT_API_URL / AI_STT_API_KEY / AI_STT_MODEL or the member's own STT provider (BYOK) | provider-dependent |
| Participant management | Interviews app: candidates, interview people (0030/0033) — a **hiring** product; Studio: respondents, distribution | not implemented for research |
| `text_themes` | word / phrase counts, lexicon sentiment, keyword coding frame (`analyses/business.ts`) | partial — no AI coding, no quotes |
| AI conversation probes | `question.probe`, runtime `/api/session/probe`, `set_probe` action, `lintProbes` | implemented (self-completion) |
| Open-end export | CSV / SPSS / SAS / Stata include open text | implemented |
| Moderated guides, sessions, transcripts, coding, quotes in reports | — | not implemented (registry: not supported) |

## 2. What is implemented today, and tested

**Planning (§6 A/B)** — `def.qualStudy` (`packages/schema/src/qualStudy.ts`): kind (interview | focus_group),
objectives, protocol, duration, ground rules, screening (include/exclude, quota), consent (statement, recording
disclosure, data use), participant segments, session plan, and timed sections (opening / warm-up / topic /
exercise / concept / closing) with scripts, moderator instructions, questions, probes, **conditional probes**
(`ifMentions → ask`), exercises and stimuli. Stored on the definition (versioned, cloned, undone with it) because
the definition is what Intelligent Mode edits through its gate, preview and replay.
Engine `qualActions.ts`: `create_qual_guide` (refused when a guide exists unless `replace: true`, then marked
destructive) and `update_qual_guide` (**patch-only**: scalars replace; list add/remove forms; sections by id or
title, patched field by field; questions by id or text; new topics go before the closing). Deterministic ids, so
preview = replay. `lintQualStudy` (timing vs duration, no opening/closing, no ground rules, no recording disclosure,
empty sections, leading or duplicate questions); `qualGuideDiff` feeds the proposal's summary, `changeItems` lists the guide item by item (category "Qualitative guide": fields, then sections added / removed / changed, destructive notes on removals), `SurveyDiff.qualGuide` names the sections touched, and the proposal's Before / after view shows the guide's sections (`structureRows`).
Copilot: `lib/copilot/qualStudyGuide.ts` rides at the end of `COPILOT_QUAL_GUIDE` (so prompt wiring is unchanged);
`qualIntent` also matches moderated / transcript / codebook / thematic. The guide's NOT SUPPORTED line now says
"running live sessions", not "moderated interviews".

**Execution (§6 C)** — real, not simulated:
- Session records (`qual_sessions`): date, moderator, participants and segments, consent captured / to record,
  notes, observations, status.
- Recording upload: new media kind `qual_recording` (private bucket `rescript-qual`, 500 MB ceiling or the store's
  lower one) through the existing `RecordingUploader` (signed PUT or multipart, resumable, confirmed by the store).
- Playback / download: 15-minute signed URL after the access check (Data view **and** contact details — a voice
  cannot be redacted); every play / download in the history.
- Transcription: `recordings/transcribe` through the configured STT provider with `segments` + `diarize`, whether
  speakers were separated recorded truthfully; metered per minute; one transcript per recording (unique index).
  **Limit:** 25 MB of audio per request (≈ 50 min at 64 kbps) — recordings are not split (would need re-encoding);
  a larger one is refused with that sentence and the advice to import a .vtt / .srt.
- Import: plain text, WebVTT (voice tags), SubRip, .docx (read on the server), "Speaker: text" with timestamps before
  or after the name. Speaker ids and timestamps kept verbatim; moderator role suggested from the label, participant
  segment from the session; both editable (speaker map). Open-ended survey answers can be snapshotted as a source.
- PII redaction (`qual/redact.ts`): e-mails, phones, a names list; applied before **every** AI call and for members
  without `responses.read_pii`; spans map back to the original.

**Coding (§7)** — `packages/analytics/src/qual/*` (pure, browser-safe):
- Segments (source / session / speaker / timestamp / response) and excerpts with evidence links (source, segment,
  speaker, time, response, exact `charStart/charEnd`, quote). **Invariant:** `quote === segment.text.slice(start,end)`.
- AI codebook proposal + coding, inductive or deductive (framework or current codebook): redacted, batched
  (≤ 12,000 chars / 80 segments a batch, ≤ 10 batches a run), **one metered call per batch** (`meteredAi`,
  AI_REQUEST, `qual_coding`, ≤ 2,500 output tokens, JSON schema sent), reply read defensively: codes need a
  definition; each excerpt's quote is located in its segment (`locateQuote` forgives case / whitespace / curly
  quotes only and stores the **source's** span) — paraphrases, ellipses, stitched quotes, moderator turns, unknown
  codes are **rejected and listed**. Everything lands `ai_suggested`. Cost ≈ (chars/4) input + 2.5k output tokens per batch, shown as an estimate.
- Human review (`applyQualOp`): accept / reject / edit / merge / split codes, add / rename / delete themes and
  subthemes, relationships, reassign excerpts, negative cases, manual codes and excerpts (verbatim-checked); one
  history entry per change (who / when / what); optimistic concurrency (409 on a stale version).
- Inter-coder agreement: Cohen's κ per code over the segments both coders coded (AI may be a coder), disagreements
  listed, κ undefined when no variation; unit-tested against the hand-computed 10-segment example (po .7, pe .5, κ .4).
- Analysis: theme × group frequency (excerpts / segments / sources / share) **labelled "frequency is not importance"**,
  negative / contradictory cases, representative quotes (reviewed first, one per source), evidence-based summaries
  (every claim cites excerpt ids; `validateClaims` drops uncited ones), lexicon sentiment labelled indicative.

**Report (§7 F)** and guide — Word editions of the existing exporter kit (`export/qualDocx.ts`, `docKit`,
`checkDocx` at the route): guide (protocol, screening, consent, ground rules, timed sections with probes and
conditional probes, pre-fieldwork notes) and qualitative report (objectives, method and coding incl. AI role and
review counts, κ table, codebook, themes with cited claims and verbatim excerpts, contradictory evidence, group
differences, the researcher's interpretation — never the engine's — limitations, review status and history;
redacted copy for members without contact details).

**Studio** — Research Tools → **Qualitative** (`components/studio/qual/*`): Guide · Sessions · Transcripts ·
Coding · Themes · Report. Saved projects use the routes; the sandbox runs the same pure functions in the page
and the sandbox branches of the coding / export routes (fake provider only).

**Access** (`lib/qual/qualAccess.ts`, Data module — no second model): read = `responses.read` (redacted without
`responses.read_pii`); manage sources = `responses.manage`; code = `responses.read` + `analytics.edit`; report =
`responses.read` + `analytics.export`; playback = `responses.read` + `responses.read_pii`; redaction list =
`responses.manage` + `responses.read_pii`; guide export = `project.read`. A member without Data gets **403**.

**Capabilities** (E1's shape): `analysis:ai_coding` → requires_configuration (ai_chat); `qualitative:moderated`
→ "Running live moderated interviews / focus groups", not supported (aliases narrowed to running / live /
real-time / conferencing); `qualitative:quotes` → partial; new `qualitative:moderated_guide`, `sessions`,
`recordings` (requires media storage), `session_transcription` (requires STT), `transcript_import`, `redaction`,
`review`, `intercoder`, `theme_analysis`; exports `qual_guide_docx`, `qual_report_docx`. `capabilities.md` regenerated.

## 3. Data model — migration 0065 (re-runnable)

`qual_sessions`, `qual_transcripts` (segments jsonb, speakers jsonb, source import|stt|open_ends, unique media_id),
`qual_codings` (one row per survey: codebook, excerpts, version, settings.redactNames), `qual_events` (append-only
history). `media_objects_kind_check` widened with `qual_recording`. RLS on; one SELECT policy each for roles that
read responses (owner, project_admin, editor, programmer, reviewer, viewer, viewer_data, deployment_manager);
custom / vendor / interviewer / strangers see nothing directly (routes decide custom); no write policies.
`/api/platform` probes 0065. **Order:** apply 0065, then deploy (without it the workspace says "needs migration
0065"; the guide still works).

## 4. Environment

AI_API_URL / AI_API_KEY / AI_MODEL (coding; `fake:` → deterministic stand-in `fakeCodingReply`);
AI_STT_API_URL / AI_STT_API_KEY / AI_STT_MODEL (transcription; or the member's own STT provider);
R2_* or Supabase Storage (recordings; Supabase's default global upload limit is 50 MB).

## 5. Verified here

- analytics `pnpm build && node --test dist/*.test.js dist/*/*.test.js` — **588/588** (new: `qual/qual.test.ts` 12, `export/qualDocx.test.ts` 4).
- engine `node --test dist/*.test.js` — **2137/2137** (new `qualActions.test.ts` 6; capabilities tests green).
- media 163/163 (+1); schema 11/11.
- Studio `node --experimental-strip-types --test "lib/**/*.test.ts"` — **667/667** (new: `qual/qualAccess.test.ts` 3,
  `qual/qualWorkspace.test.ts` 4, `copilot/qualStudyGuide.test.ts` 2; `researchGuide.test.ts` cap 3,000 → 5,600 for the
  qualitative guide, which now carries the moderated-study guide).
- `nice -n 10 npx tsc --noEmit -p .` (Studio): no error in E3 files (errors seen belong to `AnalysisBuilder.tsx` and
  `lib/artifacts/artifacts.test.ts`, other engineers' work in progress); runtime and interviews tsc clean.
- `node scripts/dependency-boundaries.mjs` 0 violations; `gen-public-docs --check` current; `auth-guard-audit` — all
  qual handlers pass (one failure in `report-themes/route.ts`, not E3's).
- SQL on Postgres 16 (a private copy of yesterday's scratch cluster at /tmp/rescript-e3-pg): 0062, 0063, **0065
  twice**; `scripts/qual-research-sql-test.sql` 6 groups pass; `media-delivery`, `collaborators-access`, `access`
  SQL tests still pass.
- Browser (orchestrator's live Studio, fake provider): `scripts/qual-research-test.mjs` **9/9**; `research-intelligence-test.mjs` 4/4.

**Orchestrator must run:** build schema, engine, analytics, media; Studio on :3000 with `AI_API_URL=fake:`;
`node scripts/qual-research-test.mjs`; `node scripts/research-intelligence-test.mjs` (the qualitative guide and
registry changed); against a database with every migration: `psql -v ON_ERROR_STOP=1 -f scripts/qual-research-sql-test.sql`.
For the real 403 in the browser: `QUAL_TEST_PROJECT=<uuid> QUAL_TEST_COOKIE_NODATA='<cookie of a Data: None member>'`.

## 6. Not implemented, and why

- **Live conferencing / real-time moderation / live observer streams**: not built — no media server; the registry
  says not supported and the copilot is told so.
- **Recording in the browser** for sessions (upload only), **audio splitting** of recordings over 25 MB (needs
  re-encoding), **speaker separation** when the provider does not diarize, **word-level timestamps**.
- **Transcript editing** in place (re-import instead); **clip playback at an excerpt's timestamp** (the timestamp is
  stored; the player opens the whole file).
- **AI summaries / AI theme interpretation**: the engine writes deterministic, cited summaries; `validateClaims`
  is ready for a model's claims but no model call writes them. Interpretation is the researcher's.
- **Per-excerpt multi-coder workflow** (blind double-coding assignments): κ compares whoever coded the same
  sources; coders are not assigned or blinded.
- **Handing themes to a quantitative phase automatically**, quotes in the survey findings deck: not built.
- The codebook and excerpts are one JSON row per survey (fine to thousands of excerpts; a very large project would
  want an excerpt table).
- Audit log: qualitative history is in `qual_events`, not `audit_logs` (its event vocabulary is `@rescript/access`'s).

## 7. Roadmap

1. Session recorder in the browser (reusing the question recorder) and server-side chunked transcription (ffmpeg worker).
2. Timestamped excerpt playback; transcript correction with span re-anchoring.
3. AI theme summaries through `validateClaims` (each claim must cite excerpts), metered like coding.
4. Blind double-coding assignments and an adjudication view; Krippendorff's α for >2 coders.
5. Qualitative → quantitative hand-off: propositions from reviewed themes into `set_research` hypotheses.
