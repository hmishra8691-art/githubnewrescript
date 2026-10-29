# Assessments — part A: schema, scoring, the hidden key, results (2026-10-29, step 4A)

K4's assessment work (branch `k-work-2026-10-25`, never merged, never SQL- or browser-tested) ported by hand onto
`feat/persistent-execution-engine`. This is the first half of the assessments goal (`/tmp/p0/E3-TASK.md`). The Studio
screens, Intelligent Mode's exam planner and the browser suite are step 4B.

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
| Word answer key / results | `exportAssessmentDocx` in `@rescript/exporters` (no Studio button or route yet; that is 4B) |
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

## 4B still to do

- Studio key editor (Properties → Assessment)
- settings card (Survey Settings → Assessment)
- analytics card (Data Analytics → Assessment results: distribution, pass rate, item analysis, Word download route)
- Intelligent Mode guide and actions described in words, with "for every question show …" answered without a model
- exam planner (`scored_exam` task kind on E1's registry: content batches with keys, then `assessment.validate`)
- browser suite
