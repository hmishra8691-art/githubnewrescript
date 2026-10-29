# Assessments — part A (schema, scoring, the hidden key, results) and part B (Studio screens, exam task, browser proof) — 2026-10-29, steps 4A and 4B

K4's assessment work (branch `k-work-2026-10-25`, never merged, never SQL- or browser-tested) ported by hand onto
`feat/persistent-execution-engine`. This is the first half of the assessments goal (`/tmp/p0/E3-TASK.md`). The Studio
screens, Intelligent Mode's exam planner and the browser suite are step 4B — see "Part B" at the end.

Production case: a 104-question UPSC General Studies paper exists with no scoring, and "for every question show
what was correct, what I selected, explanations and weak areas" timed out twice (164 s) because it was sent to the
model. None of that needs a model: after 4A the key lives in the question, never reaches the respondent, and the
result is computed on the server, deterministically.

## What changed

**Schema** (`packages/schema/src/assessment.ts`, optional fields, backward compatible)
- `question.assessment` (`QuestionAssessment`): `correct` (option codes; several = multi-answer), `marks`,
  `negativeMarks` (deducted, positive), `partialCredit` (`none` | `proportional` | `proportional_no_wrong`), `topic`,
  `subtopic`, `difficulty`, `explanation`, `optionExplanations` (per option: why it is wrong), `ungraded`, `withheld`
  (set by the stripper).
- `def.assessment` (`AssessmentSettings`): `enabled`, `title`, `defaultMarks` (1), `defaultNegativeMarks` (0),
  `partialCredit`, `passPercent` | `passMarks`, `showResults` (`after_submit` default | `never` | `per_question`),
  `report` sections (summary, perQuestion, explanations, topicBreakdown, weakAreas, recommendations), `weakThreshold`
  (60 %), `weakCountsUnattempted`, `maxWeakAreas`, `reportQuestionIds`, `expectedQuestions`.
- A survey without them parses exactly as before.

**Engine** (`packages/engine/src/assessment.ts`, `assessmentActions.ts`)
- `scoreAssessment(def, answers)`: pure, deterministic. Negative marking, multi-answer credit, totals, percentage
  (can be negative), pass/fail, topic breakdown, weak areas, revision recommendations, `keyFingerprint`.
- `respondentAssessmentReport`: only the report sections the paper shows (`null` when `showResults` is `never`).
- `stripAssessmentForRespondent` (same function as K's `stripAssessmentSecrets`): removes `correct`, `explanation`,
  `optionExplanations`, option `meta.correct` / `meta.explanation` and the translations of explanations, and leaves
  `withheld: true`. Marks and topics stay.
- `assessmentKeyLeaks(def)` is the **one leak check**. It walks what a respondent is actually served (the stripped
  definition) and names key-shaped properties anywhere (settings, `meta_extensions`, …), explanations left behind,
  and scripts that mention an answer key. It merges the base's 25 Oct `examKeyLeaks` walk.
- `validateAssessment`: structured errors that each name a question (count, key on a real option, single vs multi,
  marks, negative marks, explanations/topics required or warned, pass mark, report ids, duplicates, scope per batch).
- Item analysis (`assessmentAnalytics`: p-value, corrected point-biserial, flags) and export column helpers
  (`assessmentColumns`). The columns are **not** written into `calculated` yet; see Honest limits.
- Actions through the engine gate (`surveyActions.ts`): `set_answer_key`, `clear_answer_key` (destructive),
  `set_assessment`. `set_assessment_settings` is read as `set_assessment`, so there is one op and one gate. Options
  can be named by code, by exact label or by letter A–Z. An option that does not exist, two answers on a
  single-choice question, or a non-choice question is refused. Keying a question switches the paper on.
- Capability `platform:assessments` (`capabilities.ts`). Public docs regenerated: `actions-reference.md` lists the
  three actions and `capabilities.md` the capability.

**One scorer, one leak check** (`apps/studio/lib/copilot/deliverable.ts`)
- `scoreExam` is a thin wrapper. It folds an `ExamAnswerKey` into a copy of the definition (`examKeyToAssessment`)
  and calls `scoreAssessment`.
- `examKeyLeaks` is `assessmentKeyLeaks`.
- The `scored_exam` gate takes the key from `ctx.examKey` or, when none is handed over, from the definition's own
  `question.assessment`. It judges the key with `validateAssessment`. It reads the scoring rule from the spec or from
  the paper's settings.
- The exported names are unchanged for callers and tests.

**Intelligent Mode guide** (needed now so `copilot.test.ts` documents every action)
- K's `apps/studio/lib/copilot/assessmentGuide.ts` is wired into `prompt.ts`, `guideSelect.ts` and `aiPromptCache.ts`
  (cached stable guide). The system prompt is untouched.
- The guide tells the model never to write results itself. The 4B work on guide wording and deterministic routing is
  still to do.

**Runtime**
- Every respondent payload is stripped (`apps/runtime/lib/assessmentPayload.ts` `respondentDefinition`):
  - `/api/runtime-definition/[versionId]` (live `/s/…`)
  - the test link `/t/<client>/<study>`
  - the sandbox take page `/x/<token>`
  - Preview "as a respondent".
- The save route (`/api/session/save`) scores a **completed** paper against the server's definition and upserts the
  full result into `assessment_results` (0076), one row per session. The response carries only the report sections
  the paper shows. Scoring never fails the save.
- `/api/session/assessment` (POST `{sessionId}`) serves the report again. It is token-bound: the 128-bit session id is
  the credential, and it answers 409 until the session is complete. It returns the stored result when that result was
  scored against the current key (same fingerprint), and otherwise re-scores the stored answers.
- Sandbox, for a runtime with no database only (403 otherwise):
  - `lib/assessmentSandbox.ts` and `POST /api/assessment/sandbox` with actions `launch`, `submit`, `result` and
    `responses`.
  - `/x/<token>`: take the paper, submit, see the results. `?attempt=<id>` re-scores and shows `data-reproduced`.
  - Attempt ids are 128-bit, and a result needs both the paper token and the attempt id.
- The Runner (`components/AssessmentResults.tsx`) shows the report after the final save, following the show-results
  policy. Preview scores with the programmer's own copy and shows a "PREVIEW — scored in this browser" badge.
- Renderer: `AssessmentReport.tsx` (question text re-sanitised) and `styles/variants/assessment.css` (themed,
  phone-width cards, print stylesheet).

**Migration 0076** (`supabase/migrations/0076_assessments.sql`, K's 0075 renumbered and reshaped into a per-session
table)
- Table `assessment_results`:
  - `session_id`: unique, FK to `responses(session_id)`, on delete cascade
  - `response_id`, `survey_id`, `version_id`, `is_test`
  - `result`: jsonb, must be an object with a version
  - `key_fingerprint`, `score`, `max_score`, `percentage`, `passed`
  - `created_at`, `updated_at` (touch trigger)
- RLS like 0069: roles that read responses can SELECT; vendor, custom member, stranger and anon see nothing; only the
  service role writes.
- `rescript_assessment_distribution(survey, test)` (security invoker) for the 4B analytics card.
- Re-runnable.

**Exporters** (`packages/exporters/src/assessmentDocx.ts`): `exportAssessmentDocx(def, { result?, analytics? })`
- the answer-key sheet: marking scheme, pass mark, and every graded question with its correct answer, marks, topic,
  explanation and mistake notes
- one respondent's results report
- the distribution and item analysis

## Where to find it

| What | Where |
|---|---|
| Respondent results after submitting | live `/s/<client>/<study>` and test link `/t/<client>/<study>`: the end page shows the report, from the save route's answer or `POST /api/session/assessment {sessionId}` |
| Preview / test without a database | `POST <runtime>/api/assessment/sandbox {"action":"launch","definition":…}` → `takeUrl` `/x/<token>`; take it, submit, results; reload with `?attempt=<id>` |
| Programmer preview | Studio Preview → the paper's end page shows the report with the PREVIEW badge; tick "as a respondent" to render exactly the stripped payload |
| Stored scores | table `public.assessment_results` (migration **0076**) |
| Word answer key / results | `exportAssessmentDocx` in `@rescript/exporters`; since 4B: Data Analytics → Assessment results → **Download Word** (`GET /api/surveys/<id>/assessment?format=docx`) |
| Intelligent Mode | single-turn actions `set_answer_key`, `clear_answer_key`, `set_assessment` (guide sent on exam / quiz / answer-key / marks requests) |

**Env vars:** none new. The sandbox routes work only when `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are unset.
Migration 0076 must be applied for stored scores. Before it is applied, the save route logs the failed upsert (the
answers are still saved) and `/api/session/assessment` re-scores from the answers.

## Verification (2026-10-29, main tree)

| Check | Command | Result |
|---|---|---|
| Schema units | `cd packages/schema && pnpm -s build && node --test dist/*.test.js` | 14 / 14 (3 new) |
| Engine units | `cd packages/engine && pnpm -s build && node --test dist/*.test.js` | 2394 / 0 (15 new in `assessment.test.ts`) |
| Studio lib units | `cd apps/studio && node --experimental-strip-types --no-warnings --test 'lib/**/*.test.ts'` | 1028 / 0 (`deliverable.test.ts` 18/18 incl. 2 new; `assessmentGuide.test.ts` 3/3; `copilot.test.ts` green) |
| Runtime lib units | `cd apps/runtime && node --experimental-strip-types --no-warnings --test 'lib/*.test.ts'` | 36 / 0 (`assessmentPayload.test.ts` 5) |
| Exporters units | `cd packages/exporters && pnpm -s build && node --test dist/*.test.js` | 141 / 0 (3 new in `assessmentExport.test.ts`) |
| Typecheck | `npx tsc --noEmit -p .` in apps/studio, apps/runtime; `npx tsc -p tsconfig.json --noEmit` in packages/renderer | clean, clean, clean |
| Public docs | `node scripts/gen-public-docs.mjs --check` | current |
| Auth guards | `node scripts/auth-guard-audit.mjs` | 254 handlers, 0 problems |
| Boundaries | `node scripts/dependency-boundaries.mjs` | 0 violations |
| SQL | scratch Postgres 16 (copy of `/tmp/rescript-g2-pg/data`, port 55476, `-k /tmp`): 0071–0076 applied, 0076 applied again, `scripts/assessments-sql-test.sql` run twice | PASS 1–5 both runs; server stopped |

Not run in 4A: the browser suites. The ported `assessment-test.mjs` and the regressions `properties-accordion`,
`master-demo`, `qa-fixes` and `analytics` come with the UI in 4B. No end-to-end run of `/x/<token>`, the Runner
results page or the save route against a live server or Supabase has been done. Those paths are covered only by
unit and source-shape tests and the typecheck.

## Honest limits

- **Only choice questions are auto-marked** (single / multiple choice, dropdown, image choice). There is no numeric
  exact/range or text-match key yet, though E3's goal lists them for the 4B key editor. Questions inside loops are
  scored once.
- **`showResults: per_question`** necessarily sends the key to the browser. It is not stripped, it is warned in the
  action, and `assessmentKeyLeaks` (so the `scored_exam` gate) flags it.
- **Export columns:** the score columns (`SCORE`, `PCT`, `<VAR>_CORRECT`, …) exist as engine helpers but are not
  written into `responses.calculated` or declared as derived variables. CSV / SPSS exports of an assessment do not
  carry scores yet. The scores live in `assessment_results`.
- **Preview** (not "as a respondent") is the programmer's browser holding their own draft with the key, the same
  decision K made for hidden questions. Its results are computed in that browser and badge-marked.
- **Sandbox store** is in-process memory: a restart forgets papers and attempts, with at most 50 papers and 500
  attempts per paper.
- **Results are re-served** only to the holder of the session id (or of the paper token plus the attempt id in the
  sandbox). There is no researcher-facing results API yet; that is 4B.
- The Studio's own definition routes (editor, preview postMessage) still carry the key, by design: they are the
  programmer's.

## Part B — the Studio screens, the exam task, the browser proof (2026-10-29, step 4B)

### What changed

**Studio**
- `components/studio/AssessmentQuestionSection.tsx`: Properties → **Assessment (answer key)**. It covers the correct
  option(s), marks, negative marks, multi-answer partial credit (on multi-select only), topic / subtopic, difficulty,
  the explanation, a "why this is wrong" note per option, and "not scored". It writes `question.assessment` through
  the panel's ordinary `patch`, which is one undo step and the same shape `set_answer_key` writes. It renders
  **nothing** unless the survey is a test and the question is a choice question (single / multi / dropdown / image
  choice).
- `components/studio/AssessmentSettingsCard.tsx`: Survey Settings → **Assessment**, below Quality.
  - Until the box is ticked, the card is one checkbox, "This survey is a test or quiz".
  - Once ticked:
    - title
    - marks per correct answer, marks deducted per wrong answer
    - multi-answer credit
    - pass % or pass marks
    - **Respondent sees results**: after submitting (the default), never, or per question during the paper. "Per
      question" shows a visible `role="alert"` warning that the key is sent to the browser.
    - the six report sections
    - weak-area threshold, expected number of questions
    - a live validation chip
    - in the sandbox only, **Take the test (sandbox)**
  - Unticking keeps every key (`enabled: false`).
- `components/analytics/AssessmentCard.tsx`: Data Analytics → Home → **Assessment results**. It renders nothing
  unless the survey is a scored paper. It shows:
  - n, mean, median, SD and pass rate
  - the 10-band score distribution
  - the topic table
  - the item analysis (p, corrected r(pb), flags)
  - a Live / Test switch and **Download Word**
- `app/api/surveys/[id]/assessment/route.ts` (pure part in `lib/assessmentResults.ts`):
  - **Gate:** `requireUser` → `requireProjectFor(…, "project.read")`, then `responses.read`, because the scores are
    response data.
  - **Data:** completed, non-deleted responses of the chosen environment. A response's `assessment_results` (0076) row
    is used when it was scored against the current key fingerprint. Otherwise the response is re-scored from its
    answers. Before 0076 is applied, every response is re-scored.
  - **Word:** `?format=docx` returns `exportAssessmentDocx` (answer-key sheet, marking, distribution and item
    analysis).
  - **Sandbox** (no database only, 403 otherwise): `POST {action:"launch", definition}` hands the paper to the
    runtime's in-memory store. `GET ?key=<observer>` reads that paper's attempts, and adding `&format=docx` returns
    its Word file. The runtime sandbox's `responses` action can return the definition for that, bound to the observer
    key.

**Intelligent Mode**
- `lib/tasks/handlers/assessment.ts` registers the `"assessment"` planner (task kind **`scored_exam`**) through
  `registerAssessmentTasks()` in `handlers/index.ts`.
  - **Score:** 0.95 for a new paper of 20 or more questions, which forces a task (the generation planner scores an
    exam at 0.7).
  - **Requests it catches:** "create a 100-question UPSC paper …", the production 650-character Hindi brief, and the
    terse "100 questions, General Studies, UPSC, answer key, 2 marks, −0.66".
  - **Plan:**
    1. `assessment.settings`: a deterministic `set_assessment`. `markingFrom` reads the marking (UPSC Prelims GS
       gives +2 / −0.66; it also reads "+4 / −1", "negative marking of 0.66 for each wrong", "one third" and "pass at
       40 %"). Results are shown after submitting, with every report section on.
    2. The **generation planner's exam batches** (`buildGenerationSteps` with `assessment`). Each batch's own
       actions are `create_question` plus one `set_answer_key` per question. The engine gate and the batch-scoped
       assessment validator check them before they are kept. Batches hold 20 questions or fewer, with codes fixed up
       front.
    3. `gen.validate`, which now waits for the settings.
    4. `assessment.validate` (deterministic): every respondent question keyed, every key on an existing option,
       exactly N graded questions, and explanations and topics present. When it passes, it pins `expectedQuestions`.
  - The same check is registered as the **completion validator `assessment.validate`** (it judges only this
    planner's tasks). The base's `scored_exam` deliverable gate (4A, one scorer and one leak check) also applies.
- "For every question show what was correct, what I selected, explanations and weak areas" (EN / HI) gets **no model
  call and no task**.
  - `assessmentReportTurn` answers it in `/api/copilot/turn` before billing and before the plan-first path, with
    `modelCalled: false` and `charge: 0`.
  - The answer says where the results page and the analytics card are.
  - It proposes only the `set_assessment` that turns the report on, when the report is off.
  - It names questions without a key and never invents keys.
  - Not caught: build requests ("create … and a report of weak areas" goes to the planner), "add …" requests, and
    surveys that are not about a paper.

### Where to find it

| Screen | Where |
|---|---|
| Make a survey a test | Survey Programming → **Survey Settings** → section **Assessment** → tick "This survey is a test or quiz" |
| Answer key per question | Questions → select a choice question → **Properties** → **Assessment (answer key)** (visible only once the survey is a test) |
| Try the paper as a respondent | Preview → tick "as a respondent"; Test Survey link `/t/<client>/<study>`; in the database-less sandbox: Survey Settings → Assessment → **Take the test (sandbox)** → `/x/<token>` |
| Scores across respondents | **Data Analytics** → Home → **Assessment results** card (Live / Test) |
| Word answer key + analysis | that card → **Download Word** (`GET /api/surveys/<id>/assessment?format=docx[&env=test]`) |
| Intelligent Mode | "100 questions, General Studies, UPSC, answer key, 2 marks, −0.66" → a durable `scored_exam` task in the execution panel; "for every question show what was correct, what I selected, explanations and weak areas" → an immediate answer, no model |

No new env vars and no new migration (the card reads 0076 when it is applied).

### Verification (2026-10-29, main tree)

| Check | Command | Result |
|---|---|---|
| Studio lib units | `cd apps/studio && node --experimental-strip-types --no-warnings --test 'lib/**/*.test.ts'` | 1039 / 0. New: `assessmentResults.test.ts` 4, `tasks/handlers/assessment.test.ts` 7, including the acceptance: Hindi UPSC brief → 1 task, 100 questions, 100 keyed, +2 / −0.66. `copilot.test.ts` green. `engine.test.ts` test A now expects planner `assessment` |
| Typecheck | `npx tsc --noEmit -p .` in apps/studio and apps/runtime | clean, clean |
| Public docs | `node scripts/gen-public-docs.mjs --check` | current (no new actions) |
| Auth guards | `node scripts/auth-guard-audit.mjs` | 256 handlers, 0 problems |
| Boundaries | `node scripts/dependency-boundaries.mjs` | 0 violations |
| Browser: assessments | `flock /tmp/p0/heavy.lock /tmp/p0/fresh.sh assessment-test.mjs` | **ok, 7 / 7 checks** (85 s); see below |
| Browser: regressions | the same, one suite each, task file removed first | `properties-accordion-test` ok, `master-demo-test` ok (15 checks), `qa-fixes-test` ok; `analytics-test` **not green**, see below |

What `assessment-test` covered:
- An ordinary survey shows no new section.
- The settings were set, and the per-question warning appeared and cleared.
- Six questions were keyed through the UI.
- `/x/<token>`: the page source and every runtime payload before submission carried no key, explanation or mistake
  note.
- The results page showed the score 4.02 (= 3 × 2 − 3 × 0.66), and selected / correct / explanation for every
  question, topics and weak areas.
- A reload was re-scored identically.
- The analytics card showed n = 1, pass rate 0 %, the distribution, 2 topics and 6 items, and the Word download
  returned a valid `.docx`.

`analytics-test` failed three times, each time memory or a cold compile on this 7 GB box, never an assertion:
- run 1: a 30 s `goto` timeout at §8, while `/share/[token]` was cold-compiling (27.8 s)
- run 2: **OOM at §8** (the cgroup OOM killer killed next-server, 4.4 GB, while compiling `/share`)
- run 3 (runtime stopped to free memory): **OOM at §10** after 91 checks passed (next-server 5.1 GB, Chromium killed)

Not run in 4B: a run against Supabase with 0076 applied (the database path of the route); the Intelligent-Mode
browser suites for the exam task (the task is proven in units through `runTaskInProcess`); the other browser suites.

### Honest limits (part B)

- **The key editor covers choice questions only** (single, multi, dropdown, image choice), as the engine scores only
  those. There is no numeric exact / range or text-match key; E3's goal lists them.
- **The sandbox analytics card** works only in the tab that launched "Take the test", because the observer key is
  kept in sessionStorage. A runtime restart forgets the paper. The browser suite fakes the analytics page's survey
  list and workspace endpoints, as `analytics-test` does, because there is no database. The card, the assessment route
  and the Word export are real.
- **The database path of `/api/surveys/[id]/assessment`** (responses + `assessment_results`) is covered by the pure
  unit (`researcherAssessment`) and the typecheck only. It has not run against Postgres / Supabase.
- **The analytics card is on the Home view only.** It reads at most 5,000 completed responses per environment. The
  CSV score columns (`SCORE`, `PCT`, …) are still not in the response exports (4A limit).
- **The exam task's quality checks are structural.** They confirm 100 keyed questions, keys on real options, and
  explanations and topics present. They do not check whether a key is factually right. The model writes it; the
  programmer reviews it in Properties → Assessment.
- **Recognising the follow-up is a deterministic phrase reader** (`REPORT_FOLLOW_UP` + `assessmentIntent`). A
  phrasing it misses goes to the model as before.
- **Settings card errors:** typing an out-of-range number is clamped (pass %, weak %), not shown as an error.
