# Translation as a complete, batched, resumable task (2026-10-29)

Branch `feat/persistent-execution-engine`, step 3 of the P0 close-out (commits `0e283b2` … this doc). K3's
translation work (`k-work-2026-10-25`) PORTED onto the one engine: the base's tables, store, slice runner, cron
and panel; the translation family registers through `lib/tasks/handlers/index.ts` like generation does. The
production evidence this answers: "सर्वे को उर्दू में ट्रांस्लेट कर दो" on a 78-question survey ran as ONE model
call (163 s timeout); "translate the first 10 questions into Urdu" came back as prose.

## What changed

**Engine — `packages/engine/src/translationTask.ts` (+ test), the deterministic half.** Every decision that does
not need a model is made here, once: `maskText` / `unmaskTranslation` (piping, `${var}`, `[[loop]]`, `{param}`,
question codes, HTML tags and attributes, inline `<script>`/`<style>`, entities, URLs, e-mail addresses and
do-not-translate glossary terms become `{n}` sentinels the model never sees inside; every sentinel must come back
exactly once, byte-identical, or the string is refused); `translationInventory` (every respondent-facing string
by its stable element key — the same addressing the runtime's `localizeDefinition` reads — with the source hash;
strings with nothing to translate are copy-through, never sent); `planTranslationBatches` (adaptive: ≤ 120
unique strings / ≤ 4,000 source characters a batch, a question's elements together, an identical wording sent
ONCE and written to every key that carries it — translation memory inside the survey); `checkTranslationBatch` /
`validateTranslatedUnit` (missing, empty, corrupted, untranslated — identical to the source —, the wrong script
for the language, a glossary term lost, two answers of one question that read the same); `translationCoverage`
(100 % of a scope current and valid, the RTL flag); `pendingTranslationKeys` (resume: a key with a current, valid
translation is never sent again; a source edited later invalidates exactly that key by its hash);
`translationTaskActions` (`set_translations` with `sourceHash`, or `replace_wording`); `surveyStructureHash` (the
survey with every translatable text blanked — logic, piping, scripts, ids, codes must hash the same before and
after); `pseudoTranslate` (the fake provider's stand-in: letters mapped onto the target script, sentinels
untouched). With it the K changes its tests need: scale-point labels, the words beside a number and a rating's
comment prompt as translatable elements, `setSourceText` (the inverse of the addressing), `replace_wording` and
`TranslationSpec.sourceHash` in `localizationActions.ts` (a translation of words the element no longer has is
stored OUTDATED, never stamped current; a replacement of changed wording is refused), scripts / URLs ignored by
`wrongScript`. `DEFAULT_NUMBER_LOCALE` kept. Exported from `index.ts`; `actions-reference.md` regenerated.

**Studio — one gate, no duplicated logic.** `lib/copilot/translationTask.ts` keeps its names for the base's
callers and tests but every decision is the engine's: `translationInventory(def, lang)` = the engine's masked
inventory + each unit's state in the language (`missing` / `outdated` / `invalid` — stored but refused by the
engine's validator — / `translated`); `translationBatches(units, size)` = `planTranslationBatches` capped at
`size` unique strings; `checkTranslationBatch(units, answered, lang?, glossary?)` = `validateTranslatedUnit` per
key, worded for the panel; `translationComplete(def, lang, { units? })` = THE ONE GATE: without a scope the
language's launch-readiness (`lintLanguage(def, lang).ready` + the configured-language rule, what
`checkDeliverable` asks of a whole-survey task); with a scope the engine's `translationCoverage` over it (100 %
current and valid — a partial scope is not asked to make the language ready). `translationQueue` is exported once
(routing's private copy removed). `translationRouting.ts` keeps the pure predicate (`routeTranslation`, the two
named numbers `LARGE_TRANSLATION_KEYS` = 150 and `SEVERAL_LANGUAGES` = 2) — the planner's `matches` reads them.

**The task family — `lib/tasks/handlers/translation.ts` (+ test).** `parseTranslationRequest` reads the
language(s), the mode and the scope deterministically (English, Hindi, Urdu, French cues; "the first 10
questions", "पहले 5 सवाल", "Q3 to Q6", a named block; "replace the wording", "इसे ही … कर दो" → replace mode;
questions ABOUT translations are never a task). The planner scores **0.95** when the strings still to translate
in the scope (read OFF THE SURVEY, pending by source hash) are ≥ `LARGE_TRANSLATION_KEYS` or several languages
are named — a task whatever `estimateTaskSize` says — and **0.5** for a small one (this planner when the size
estimate decides on a task — `TASK_MIN_TRANSLATE` = 10 questions — never the generic planner answering a
translation in words; otherwise the in-turn path exactly as before). Steps, per language:
`tr.<lang>.prepare` (deterministic: the inventory, `add_language` when the version is missing, copy-through
strings written without a model) → `tr.<lang>.bNN` × N (`translation.batch`: ONE structured call through `ctx.ai`,
`tier: "small"`, the batch fenced as untrusted data; memory first; every returned string unmasked + validated;
refusals → ONE targeted repair step `…-r1` / `…-r2` with the reason per string, ≤ 2 rounds; `output_limit` /
`context_limit` → split in halves `…a` / `…b`; transient failures → the runner's bounded retry; auth / config /
budget → blocked, Resume carries on) → `tr.<lang>.verify` (deterministic: 100 % of the scope covered by current,
valid translations, a gap translated here and re-checked ≤ 2 rounds, the structure hash unchanged, the RTL flag,
a "worth a look by a person" list; a whole-survey replacement makes the language the source). Output actions
`add_language` / `set_translations` (with `sourceHash`) / `replace_wording` are replayed into `ctx.draft` through
the engine's own gate and open as one proposal through the ordinary review → Apply. `registerCompletionValidator
("translation", …)` judges every `translation:<lang>:<mode>:<scope>` line of the plan with `translationComplete`
(the scope's units): the task is `completed` only when every language's scope is 100 % covered. Fake responder
`"translation."` (pseudo-translation in the target script, so the script check is real). Several languages
("traduire … en français et en arabe") are ONE task with a prepare / batches / verify and a gate per language.

**The turn route.** The `startBatchedTranslation` early return (its own step rows, kind "translation") is gone
from `app/api/copilot/turn/route.ts`; the plan-first path (`lib/tasks/turnTask.ts`) picks the translation planner.
`deliverableOf` (`lib/tasks/engine.ts`) reads the language as a CODE and the scope off the planner's completion
line (the sentence's own words need no second reader); `DeliverableSpec.scopedQuestions` (additive) tells
`checkDeliverable` that a partial scope is not asked for launch-readiness. The client view carries a step's
`modelTier`. `replace_wording` is documented in the copilot's translation guide (`copilot.test.ts` enforces it).

## Where to find it

- **Intelligent Mode** (Studio → Questions → Intelligent): "translate the survey into Urdu", "सर्वे को उर्दू में
  ट्रांस्लेट कर दो", "translate the first 10 questions into Hindi", "traduire le questionnaire en français et en
  arabe", "replace the wording with Urdu". A request past the line answers at once with the task card
  (`[data-testid="cp-task"]`, planner `translation`) — steps "Inventory N strings", "Translate batch i of N into
  Urdu (k strings)", "Check every Urdu string (N) and the structure" — driven by the page, carried on by the cron
  when the page is gone; **Review the result** opens the proposal; **Apply** writes the language version. A small
  request stays in the turn as before.
- **Localization → Translations** (Studio → Localization → the language's Translations): the counts the task
  writes — every string of the scope with status `ai`, the language `complete` when `lintLanguage` is ready; a key
  whose source was edited after translation shows as **outdated** and is the only one the next run sends again.
- **Routes**: `POST /api/copilot/turn` → `stage: "task"` (`task.planner: "translation"`, `task.deliverable:
  { kind: "translation", language: "ur", scopedQuestions? }`, `task.completion: ["translation:ur:version:all"]`);
  `GET /api/copilot/tasks/[id]?surveyId=&steps=1&result=1` (fake provider: the rows with `usage`, `output.data` —
  the verify step's `coverage`, `rtl`, `structureHash`, `review`).
- **Flags / env**: none new. The family uses the engine's `COPILOT_TASKS` (default on), `COPILOT_TASK_ADVANCE_MS`,
  `AI_MODEL_SMALL` (every batch is `tier: "small"`), `CRON_SECRET` for the background. The batch policy is
  `TRANSLATION_POLICY` in `handlers/translation.ts` (≤ 120 unique strings / ≤ 4,000 characters / tail < 40
  merged); the routing lines are `LARGE_TRANSLATION_KEYS` = 150 and `SEVERAL_LANGUAGES` = 2 in
  `translationRouting.ts`.
- **Files**: `packages/engine/src/translationTask.ts` (+ `.test.ts`), `localization.ts`, `localizationActions.ts`,
  `placeholders.ts`, `execPlan.ts`; `apps/studio/lib/copilot/translationTask.ts`, `translationRouting.ts` (+ tests),
  `prompt.ts` (the guide), `deliverable.ts`, `taskStore.ts`; `apps/studio/lib/tasks/handlers/translation.ts`
  (+ `.test.ts`), `handlers/index.ts`, `engine.ts`; `app/api/copilot/turn/route.ts`;
  `scripts/translation-task-test.mjs`.

## Verification (2026-10-29, sandbox, fake provider)

- Engine: `cd packages/engine && pnpm -s build && node --test dist/*.test.js` → **2,379 pass / 0 fail**
  (`translationTask.test.js` 10: inventory, masking round trip, batches with memory, validation kinds, resume + a
  source edit invalidating one key, structure hash, replace_wording, setSourceText, language names, outdated).
- Studio lib: `cd apps/studio && node --experimental-strip-types --no-warnings --test 'lib/**/*.test.ts'` →
  **1,023 pass / 0 fail**: `lib/tasks/handlers/translation.test.ts` 9 (parse; the planner's score by the survey's
  count; the turn decision for the two production sentences; C: 78 questions → Urdu in 2 batches to 100 %, RTL,
  structure unchanged, one small-tier call per batch, memory once; resume without re-sending a completed batch;
  "the first 10 questions" = scope, a prose answer retried; refusals → one repair step; output limit → split, a
  source edit → one key; fr + ar one task, replace mode makes the language the source);
  `lib/copilot/translationTask.test.ts` 9 and `translationRouting.test.ts` 9 — adapted where the merge changed
  semantics (batch counts are the adaptive planner's; the placeholder wording is the engine's "{{Q1}} is
  missing"); `copilot.test.ts` (every action documented) green.
- `npx tsc --noEmit -p .` clean (studio); `node scripts/gen-public-docs.mjs --check` current;
  `node scripts/dependency-boundaries.mjs` 0 violations; `node scripts/auth-guard-audit.mjs` 254 handlers, 0 problems.
- Browser / API, `/tmp/p0/fresh.sh` (servers restarted before each suite, the sandbox task dump removed):
  `translation-task-test.mjs` **6/6** in 165 s (C1 the Hindi sentence → `stage: "task"` in 4 s, prepare + 2
  batches + verify, small tier; the panel's card; C2 reload after 2 steps → reattached, completed, completed steps
  `retryCount` 0, every batch with its own cost, verify persisted coverage 100 % / RTL / structure hash; C3 Apply →
  354/354 strings in Urdu, pipes / `${total}` / the link and its attribute / `<b>` intact, structure hash equal,
  the language RTL; C4 runtime `?lang=ur` `dir=rtl`; C5 "the first 10 questions into Hindi" → a 3-step task, 42
  strings of Q1–Q10 in Devanagari, nothing outside the scope). The Studio dev server was restarted by its
  supervisor 3× during that run (memory) and the suite still passed; the three earlier runs were one OOM at the
  panel step and two suite fixes (the editor normalises the loaded definition — the hash must be the editor's;
  the sandbox editor does not keep its survey across a reload — the fixture is put back before Apply; a legacy
  `customJs` is migrated into a script behaviour on load). Regressions: `localization-test.mjs` **all checks
  passed** (94 s), `translation-copilot-test.mjs` **11/11** (62 s).

## Honest limits

- **Scripts checked.** The wrong-script check is `expectedScripts` (`packages/engine/src/placeholders.ts`): Latin,
  Cyrillic, Greek, Arabic (Urdu, Arabic, Persian), Hebrew, Devanagari (Hindi, Marathi, Nepali), Bengali, Gurmukhi,
  Gujarati, Tamil, Telugu, Kannada, Malayalam, Sinhala, Thai, Lao, Khmer, Myanmar, Hangul, Kana, Han, Georgian,
  Armenian, Ethiopic. A language the table does not know gets no script check (the other checks still apply).
  The fake provider's `pseudoTranslate` has stand-in alphabets for Arabic, Devanagari, Cyrillic, Hebrew, Greek,
  Bengali, Tamil, Han, Hangul; a Latin-script target gets a `[xx]` prefix.
- **Language names in a sentence**: the library's English and native names, the Hindi / Urdu / Marathi spellings
  (`languageFromName`, `spoken.ts`) and a short French / Spanish / German / Portuguese table in the handler. A
  name outside those is not a translation request (the in-turn path then reads the sentence as before).
- **Batch size is a policy, not a measurement**: ≤ 120 unique strings / ≤ 4,000 characters a batch is K's
  estimate of what the small tier answers well inside a 90 s step (≈ 3,500 Urdu output tokens); an answer over
  the output limit halves the batch, but a real provider's timing was not measured on this branch (fake provider
  only). `TRANSLATION_POLICY` is one constant to tune.
- **A partial scope** ("the first 10 questions") completes when ITS strings are 100 % covered; the language is
  then still not launch-ready (the rest of the survey) — Localization → Translations says so, the task does not.
- **The old rows** (`createTranslationTask` / `startBatchedTranslation` in `translationRouting.ts`, kind
  "translation" steps `tr-N` without a handler kind) are no longer created by any route; they stay for their unit
  tests and for a task row that may already exist. `refreshOutdated` stays as the one-line wrapper it was; the
  inventory's state now reads the source hash itself.
- **Memory**: the dev server under a browser suite can be OOM-killed; the suite result above names where that
  happened and never calls a killed run a pass.
- **Migration 0074 is applied nowhere but scratch** (unchanged by this step): a real project runs the in-turn path
  until it is.
