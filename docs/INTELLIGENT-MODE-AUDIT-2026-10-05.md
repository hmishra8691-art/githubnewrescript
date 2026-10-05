# Intelligent Mode — complete audit, root causes, and the plan

*Audit of 2026-10-05, the first step of the brief "Intelligent Mode Complete Audit, Engine Integration & Intelligent Research Suite Upgrade". Read-only: every claim below points at code as it is today (file:line), nothing was changed to make it. Where a behaviour is marked (probed) it was exercised against a fixture survey, not inferred from reading.*

The question the brief asks is whether Intelligent Mode is the Studio's intelligence layer or a prompt box in front of a cloud model. The answer today is: it is a well-built cloud copilot (closed action vocabulary, execution on a clone, one undoable apply) sitting next to a smaller deterministic grammar, with the two never speaking to each other — and the cloud goes first. Most of what the brief wants already exists as engine capability; it is unreachable from the sentence a researcher types, unwired from the proposal the researcher reviews, or thrown away between the two.

## 1. The pipeline as it is

```
sentence ─► parseIntent (grammar, app) ──► find/explain/diagnose/screening with no errors ──► answered locally
   │                                                        │ anything else, and a model is configured
   ▼                                                        ▼
POST /api/copilot/turn ── classifyRequest ── copilotOutline ── model ── coerceCopilotReply ── applySurveyActions (clone)
   │                                                                                            │ refused? one repair round
   ▼                                                                                            ▼
browser: Proposal {base, steps[]} ── evaluateProposal (applySurveyActions AGAIN, per step + whole) ── Changes panel
   │ "empty" reply only
   ▼
grammar planProposal ── unknown / "could not find"? ── POST /api/ai/logic (second model call) ── applyLogicProposal
   ▼
Apply ── store.replace (one undo step) ── toast "Applied" ── POST /api/copilot/record ── … 900 ms later: PUT draft (may 409)
   ▼
runtime: preview postMessage (250 ms) · test link reads draft_definition per request · live needs version + deploy
```

Sources: `apps/studio/components/intelligent/IntelligentView.tsx:199-243`, `apps/studio/components/intelligent/copilot/useCopilot.ts:180-267`, `apps/studio/app/api/copilot/turn/route.ts:51-204`, `apps/studio/lib/copilot/client.ts:39-62`, `apps/studio/components/studio/store.tsx:457-460, 602-618`, `apps/studio/components/studio/Studio.tsx:647-662`, `apps/runtime/lib/deployment.ts:112-138`.

## 2. Classification of findings

### 2.1 What already works

- Reasoning is separated from execution: the model emits only a closed `SurveyAction` vocabulary; `coerceSurveyActions` gates shape and `applySurveyActions` executes on a clone with per-action snapshot rollback, schema validation of the result, named destructive changes, and reasons for every refusal (`packages/engine/src/surveyActions.ts:191-394`).
- One automatic repair round when actions are refused, adopted only if it accepts more (`turn/route.ts:165-189`).
- Proposals are chains (revise before applying), rebased onto a changed survey with an explicit "review again" (`client.ts:39-67`, `useCopilot.ts:244-248`).
- Apply is one labelled, undoable `store.replace`; ⌘Z undoes the whole operation (`useCopilot.ts:254-255`, `store.tsx:602-646`).
- Exact read-only questions ("what depends on Q3?", "why is Q4 not showing?") are answered from the dependency index with no model (`IntelligentView.tsx:199-200`, `apps/studio/lib/intelligent/proposal.ts:496-605`).
- The condition model is one canonical tree with AND/OR/NOT nesting to any depth, count sources, cross-question and per-option right-hand sides, loop/calc/embedded/quota sources (`packages/schema/src/conditions.ts:268-416`); the expression language parses, prints and canonicalises option labels to codes, refusing unknown labels with the codes listed (`packages/engine/src/logicExpression.ts`, `optionCodes.ts:68-170`).
- Rich impact tooling exists: a typed dependency index with 19 edge kinds (`dependencyIndex.ts:54-74`), reference pruning with consequence sentences (`references.ts`), rename impact with blockers (`variableUsage.ts`), static "why not shown" diagnosis (`diagnose.ts`), cycle detection (`dependencies.ts:414-443`).
- Analysis planning is deterministic and level-aware (`analysisFramework.ts:117-131, 253-308`); plan → runnable analyses → run → structural findings → verdicts → report draft, with milestone auto-runs (`planBridge.ts`, `findings.ts`, `findingsReport.ts`).
- Translation enumerates every translatable element keyed by stable ids/codes, refuses placeholder/HTML/glossary breakage at write time, tracks `sourceHash` staleness, gates readiness (`localization.ts`, `localizationActions.ts`).
- Runtime synchronisation is sound: no stale cache can serve a draft; the test link reads the draft per request; open test tabs poll a build stamp every 4 s; live is version + deploy by design (`deployment.ts:112-138`, `Runner.tsx:637-668`, `packages/quality/src/server.ts:201-224`).

### 2.2 What is incorrectly implemented (root causes, not symptoms)

| # | Finding | Evidence | Layer |
|---|---|---|---|
| R1 | **Two unconnected action vocabularies.** The grammar produces `Intent` → `ProposalChange` (13 kinds) → `applyLogicProposal`; the copilot produces `SurveyAction` (20 core ops + ux/analysis/localization/quota) → `applySurveyActions`. Nothing bridges them, so every capability built in `surveyActions.ts` is unreachable from a typed sentence without a model. | `proposal.ts:34-59`, `logicProposal.ts:38-71`, `surveyActions.ts:78-106` | architecture |
| R2 | **The cloud goes first.** Every sentence that is not an exact read-only question goes to the model whenever one is configured; the grammar is the no-model fallback. Header comments still describe the opposite. "Make Q5 required" costs a full copilot turn. | `IntelligentView.tsx:43-45` vs `:199-205` | prompt/intent, API |
| R3 | **One sentence can be charged twice**: an unusable copilot reply falls through to the grammar and, if unknown, to `/api/ai/logic` — a second metered call with a different context builder and a different output vocabulary. | `IntelligentView.tsx:207-233`, `lib/intelligent/ai.ts:53-147` | API |
| R4 | **The deterministic planner lives in the app, not the engine** (`planProposal`, 617 lines, resolving codes and parsing expressions in `apps/studio/lib`). | `apps/studio/lib/intelligent/proposal.ts` | architecture |
| R5 | **Validation is post-hoc and demoted.** `applySurveyActions` keeps only quality-check issues at `error` level, so forward references, operator/type mismatches, stale option codes and cycles are applied and reported as warnings or not at all; `validateProposal` (the grammar path) blocks several of these, but the model path does not. | `surveyActions.ts:391-392`, `lintLogic.ts:324-359`, `logicProposal.ts:108, 153-172` | validation |
| R6 | **Parser accepts silent nonsense.** An unresolvable right-hand word becomes a string literal (`Q9 > Q99` → `Q9 > "Q99"`); strings against numeric sources pass; the grammar's comparator rewrites miss "over/under/above/below/older than", so "Q9 is over 25" becomes `Q9 = "over 25"` — a never-true rule applied without error (probed). | `logicExpression.ts:714, 856`, `proposal.ts:136-142, 162-168` | logic engine |
| R7 | **Structured conditions bypass canonicalisation when `ref` is a code**: `domainOf` looks up by id only, so `{ref:"Q5", eq, "Pepsi"}` is stored as `Q5 = Pepsi` (probed). | `optionCodes.ts:108`, `surveyActions.ts:914-927` | logic engine |
| R8 | **Renames and removals do not propagate**: `update_question.variable/code` leave pipes and calculation expressions dangling while `applyRename` sits unused; `removeOptions` deletes options that other logic compares against with no warning; `move_question` has no order check and is not even diffed. | `surveyActions.ts:490-498, 512-522, 545-553, 1161`, `variableUsage.ts:595, 709` | dependency resolution |
| R9 | **Impact is computed and thrown away.** `delete_question` reduces `referencesTo` to a count; option removal, type change, variable rename, logic replacement compute none; `diffSurveys` has no "dependents affected" section; `find` answers list keys without edge kinds. | `surveyActions.ts:536-544, 1128-1227`, `proposal.ts:508-518` | dependency resolution |
| R10 | **The dependency index does not know analysis or translation**: no node/edge kind for plan items, constructs, hypotheses or translation entries, so "what depends on Q7" understates the blast radius. | `dependencyIndex.ts:40-74` | dependency resolution |
| R11 | **False success.** The card flips to "APPLIED", the toast says "Applied as one change", History gains an entry and the audit row is posted — all synchronously, before the 900 ms debounced autosave; a 409/lock/401 later changes only the header indicator, and the audit POST swallows its own failures. | `useCopilot.ts:254-266`, `IntelligentView.tsx:178, 256-268`, `store.tsx:361-407, 457-460` | state management |
| R12 | **History is page-lifetime only**, numbering restarts at #001 per reload (colliding `n` in `audit_logs`), records lack intent/targets/refused/warnings/actions/API calls, and there is no view/compare/reapply though before/after are held in memory. | `useCopilot.ts:49-71, 251`, `client.ts:73-86`, `record/route.ts:26-32`, `CopilotPanel.tsx:362-389` | state management |
| R13 | **The review is flat and all-or-nothing**: one destructive checkbox, no per-change selection, no expand/collapse, no question type, no option-level itemisation (option lists are diffed as whole joined strings), no affected logic/dependencies per change, no per-change status — although the server's per-action `validation.results` carries exactly that and the client discards it. | `CopilotPanel.tsx:91-163`, `useCopilot.ts:197-200`, `surveyActions.ts:1150` | UI, state |
| R14 | **Horizontal scrolling** comes from the 10-tab strip (`overflow-x:auto` + `nowrap` in a 360 px panel) and the modified-questions table (no `table-layout:fixed`, no `overflow-wrap`, unbounded joined strings). | `apps/studio/app/design-system.css:1554-1556, 1635-1640`, `CopilotPanel.tsx:147-153` | UI |
| R15 | **No option-level selection or option context anywhere** in Intelligent mode; no context actions on a selected object beyond example sentences; the dependency view is behind an unsignalled Inspector tab. | `StructurePane.tsx:32-40`, `client.ts:155-161`, `IntelligentView.tsx:612-619` | missing |
| R16 | **No suggested-fix mechanism**: refusals are boilerplate ("I did not understand that", "I could not find “X”") with no candidates, no nearest code, no corrected proposal. | `grammar.ts:254`, `proposal.ts:321` | validation |
| R17 | **No sample size or design in analysis planning**; `reason` is a label, not an explanation; no deterministic explanation object; derived variables and segments are declared but never executed. | `analysisFramework.ts:258-308`, `planBridge.ts:78-96`, `common.ts:6` | logic engine (analysis) |
| R18 | **Verdicts ignore direction**: a hypothesis "trust increases intent" is "supported" by a significant negative β. | `findings.ts:279` (direction available at `:196`) | logic engine (findings) |
| R19 | **Placeholder protection is three unreconciled regexes** none of which is `pipingTokens.ts`; `{label}` in a system string is unprotected in the engine; orphaned translation keys after option removal are never pruned or reported; no wrong-language detection; the translation impact of a change is a count, not a report. | `localization.ts:97, 634`, `translation.ts:69`, `ai/index.ts:356`, `surveyActions.ts:379` | logic engine (translation) |
| R20 | **Failed grammar proposals still consume an undo step and dirty the editor**; a mid-batch `rename_variable` failure leaves a half-applied draft committed. | `store.tsx:598-600`, `IntelligentView.tsx:256-264`, `logicProposal.ts:379-407` | state management |
| R21 | **Store undo is invisible to Intelligent history**: ⌘Z after an AI apply leaves the entry "not undone"; `revert` compares with `rec.after` by JSON after `replace` may have canonicalised codes, giving a false "survey has changed". | `useCopilot.ts:275-288`, `store.tsx:613, 625-646` | state management |

### 2.3 What partially works

- `set_validation` replaces every rule where the grammar merges by kind; `custom_expression` is in the schema but not in `VALIDATION_KINDS`; exact-selections has no kind (`surveyActions.ts:145, 587-592`).
- `set_research` replaces whole arrays (no add/remove of a single hypothesis) (`surveyActions.ts:677-692`).
- `update_question.options` rebuilds options from labels, losing ids, values, `visibleIf` and option logic, reported only as "replaces the N options" (`surveyActions.ts:500-505, 980-1002`).
- `create_question` with a taken code is silently renumbered (`surveyActions.ts:942-943`).
- `removeOptions` matches code or label case-insensitively and removes every match; duplicate labels cannot be disambiguated (`surveyActions.ts:516-517`).
- Explainability of the analysis plan is model-driven from structured facts; `analysisIntent` does not match a bare "why?" (`prompt.ts:226-239, 314`).
- Analysis impact of type and option changes is caught after the fact by the review, not at the change (`surveyActions.ts:473-519` vs `analysisFramework.ts:481-486`).
- Hypothesis ↔ construct linkage is by word matching (`analysisFramework.ts:169-175`; `findings.ts:245-250`).
- The 15-minute copilot response cache is keyed on the prompt only; outline-invisible changes (UX items beyond 40, translations beyond 400 elements) can return a stale reply (`turn/route.ts:47-48, 128`).
- Availability flags are page-lifetime globals: one 501 pins "grammar only" until reload (`IntelligentView.tsx:109-111`, `useCopilot.ts:59`); the badge reads "grammar" before the first request even when a model is configured (`:585-587`).
- A `?v=` pinned test tab never learns newer work exists (`Runner.tsx:641`).
- A resumed in-progress session runs the new definition against a row stamped with the old version (`start/route.ts:75`, `packages/quality/src/server.ts:300-313`).

### 2.4 What unnecessarily uses cloud APIs, and what must be internal

Every provider call goes through `packages/ai` (one client; metered; `fake:` stand-ins). Full table of the 19 call sites is in §5. The classification:

**Must be internal (engine) — and today either goes to the model first or is not reachable at all:** selecting an object and its valid operations; dependency and reference questions; "what will break if I delete X"; "which logic references X"; "which questions are untranslated"; required/optional; display, skip, branch, AND/OR/NOR and nested conditions when the sentence names its objects; masking and carry-forward; randomization with anchors; option add/remove/rename/reorder/exclusive/other; validation rules; variable and code renames; page breaks; moving and duplicating questions; impact analysis; change application; history. Of these, only find/explain/diagnose/screening bypass the model today (`IntelligentView.tsx:200`); every edit sentence goes to the model first (R2).

**May use AI:** survey generation from a brief; ambiguous or novel phrasings the deterministic layer does not parse; research synthesis and document summaries; OCR of scanned pages; qualitative interpretation; narrative findings and executive summaries (bound to the run); methodological recommendation in prose; translation text (engine-checked); speech-to-text and spoken-instruction normalisation.

**Internal already:** survey import analysis, quota sheets, review facts (`reviewSurvey`), analysis planning, findings, verdicts, report assembly, translation enumeration/lint/staleness.

### 2.5 What is missing

Option-level operations on existing options (rename, code/value, position, visibility condition, exclusive, other, anchor, option logic) in both vocabularies; `duplicate_question`; mask/carry-forward as a copilot op; randomization anchors on existing options; `set_survey_settings`; update/remove embedded; add/remove a single hypothesis; `customJs`/`customCss`; exact selections; range and relative-target resolution ("Q8 through Q12", "the next five questions", "option 3 of Q7"); the intents "what will break if I delete", "which logic references", "which questions are untranslated", "add an Other option", "rename option", "make None exclusive", "reorder options", "randomize keeping None last", "mask … from …", "delete/duplicate/move/change type"; a suggested-fix mechanism; a persisted operation history with view/compare/revert/reapply; a hierarchical, selectable change review; a dependency view with navigation; context actions per object; a deterministic analysis explanation object; sample-size-aware planning; executed derived variables; direction-aware verdicts; a translation impact report; wrong-language detection; a unified knowledge-graph query layer.

### 2.6 Not persisted / not reflected / not propagated

- Not persisted: Intelligent history (R12); the audit row when `record` fails (R11); drafts after a lost edit lock are not retried until the next keystroke (`store.tsx:371-388, 565-574`).
- Not reflected: save failures in the copilot card and History (R11); store undo in History (R21); server `validation.results` in the review (R13); the saved/deployed status anywhere in Intelligent mode.
- Not propagated: variable/code renames into pipes and calculations (R8); translation orphaning on option removal (R19); analysis impact of type/option edits (§2.3). Runtime propagation itself is correct (§2.1): preview ≈250 ms, test link on next request, live on deploy.

## 3. Cloud API audit (every call site)

| # | Call site | Sends | Asks | Deterministic instead? | Class |
|---|---|---|---|---|---|
| 1 | `api/ai/logic/route.ts:38` | survey listing (`surveyContext`), selected code, sentence | one `Intent` | partly — same shape the grammar makes; only called after grammar `unknown`/not found | MAY (NL fallback) — but duplicates #2 |
| 2 | `api/copilot/turn/route.ts:138` | `copilotOutline` (≤150 Q, logic of named Qs, UX, research, plan, translations, live quota counts, latest run), research passages, memory, review facts | one JSON reply with `SurveyAction[]` | partly — the engine gates and executes; NL→structure for novel phrasing is not derivable | MAY — must not be first for deterministic edits |
| 3 | `turn/route.ts:171` repair | prompt + previous answer + refusal reasons | corrected actions | partly | MAY |
| 4 | `turn/route.ts:103` | the message | query embedding | no (BM25 fallback is deterministic) | MAY (optional) |
| 5 | `api/copilot/documents/route.ts:93` | page images | OCR | no | MAY |
| 6 | `documents/route.ts:111` | passages | embeddings | no | MAY (optional) |
| 7 | `documents/route.ts:123` | ~20k chars of a document | research card | no | MAY |
| 8–9 | `api/ai/transcribe/route.ts:65, 81` | recording; transcript | STT; normalise to English | no | MAY |
| 10 | `api/ai/rephrase/route.ts:38` | one question text | spoken rewording | no | MAY |
| 11 | `api/ai/translate/route.ts:44` | ≤100 strings + glossary | translations (Google or LLM) | no | MAY (engine-checked) |
| 12 | `api/ai/tts/route.ts:28` | one string | audio | no | MAY |
| 13 | `api/import/custom-logic/route.ts:38` | listing + one imported script | explanation + Intent | partly | MAY (explicit click, cost shown) |
| 14–15 | `api/import/analyze`, `api/import/quotas` | files | — | **yes, no model call** | INTERNAL |
| 16–19 | media transcript, interviews runner, runtime `session/ai`, `session/probe` | recordings, open ends | STT, claims, classify, probe | no | MAY (respondent-facing, out of scope) |

`packages/engine/src/aiConversation.ts` and `aiFunctions.ts` are the respondent-facing conversational interviewer and the `ai_classify()` calc functions; neither calls a provider and neither is used by Intelligent Mode. `completeJson` throws while `complete` returns null, and callers handle this inconsistently (`ai/index.ts:912-914` vs `:1043-1046`).

## 4. Architecture rules in force

There are no ADR files or lint boundaries; the rules are the workspace graph and the README. `@rescript/engine` depends on `schema` only and is network-, env- and Node-free (verified: no `fetch`, `process.env`, `node:` in `packages/engine/src`); `analytics`, `ai`, `import`, `quality` depend on `engine` — the engine may never import them back. Supabase clients are constructed only in `apps/*/lib`; packages take an injected client. The runtime never imports the Studio; the Studio reaches the runtime by URL and the runtime polls a build stamp — authoring and execution stay uncoupled (`build-stamp/route.ts:18-27`). Every Studio API handler starts with a guard (`scripts/auth-guard-audit.mjs`). The copilot rule: the model's output is data in a closed vocabulary, the engine executes on a clone, only Apply writes (`docs/INTELLIGENT-COPILOT.md`).

Consequence for this work: the deterministic natural-language layer, option-level operations, validation, impact and the knowledge-graph queries belong in `packages/engine` beside `surveyActions.ts`; persistence of history belongs in `apps/studio/lib` + a migration; nothing new may call a provider from the engine.

## 5. The redesign

One execution path. The engine's `SurveyAction` vocabulary becomes the single contract; the grammar's 13 `ProposalChange` kinds are bridged into it so nothing existing breaks, and the deterministic layer moves into the engine and grows to the brief's taxonomy. Routing inverts: engine first, model only for what the engine marks `unknown`, `ambiguous` or `research`. The second model path (`/api/ai/logic`) stops being called from Intelligent mode (the route stays; the import engine's deep custom-logic still uses the same prompt family).

```
sentence ──► engine nl.parse(def, text, selection) ──► { actions | query | ambiguous | unknown | research }
   │ actions ──► engine validate (pre-apply: exists, type fit, forward ref, cycles, stale refs, targets) ──► refused with precise reason + suggested fix
   │          ──► engine impact (dependents by kind, incl. analysis + translation) ──► proposal (per-change records: level, object, field, from, to, affected, status)
   │ query   ──► engine graph.ask(def, query) ──► answer with navigable references
   │ ambiguous ──► one clarifying question with the candidates (no model)
   │ unknown / research ──► model (same vocabulary) ──► the same validate/impact/proposal path
   ▼
review (hierarchical, selectable) ──► Apply(selected) ──► replace ──► await flushDraft ──► status = saved | failed ──► history row persisted
```

Validation before apply is the point of the design, not a lint afterwards: `applySurveyActions` grows a pre-apply check per action that refuses — with the object named and the fix proposed — instead of applying and warning. The existing lint stays for what it does today.

## 6. The phases (one commit each; unit + browser + mutation checks; saved to the Mac on request)

| Phase | Scope | Fixes |
|---|---|---|
| **1 — Audit** (this document) | The audit, root causes, the plan. | — |
| **2 — Engine vocabulary, validation, impact** | Option-level ops (`update_option`: label, code, value, exclusive, other, anchor, visibility condition, position; `reorder_options` incl. alphabetical and anchored randomization), `duplicate_question`, `set_mask` (carry-forward / list fill), `set_survey_settings`, update/remove embedded, add/remove hypothesis, exact selections, `customJs/customCss`. Pre-apply validation (exists, option-belongs, type/operator fit, forward reference, cycles, stale option refs, targets) with precise reasons and a `suggestion` action. Rename/code propagation via `applyRename`. Structured-condition canonicalisation by code. Parser: comparator words, literal type check with did-you-mean, NOR. `impactOf(def, actions)` with dependency kinds, and analysis + translation edges in the dependency index. Per-change diff records (level/object/field/from/to/affected/status), moves diffed. | R5 R6 R7 R8 R9 R10 R16 (engine half) + §2.5 ops |
| **3 — Engine natural-language layer and routing** | `packages/engine/src/nl/`: intent taxonomy → `SurveyAction[]`; object, option, range and relative-target resolution; read-only graph queries (depends/references/breaks-if-deleted/untranslated/measures/analyses-available/segment-variables); ambiguity → clarifying candidates; grammar `ProposalChange` bridged to actions. Studio: engine first, model for unknown/research only, no second model call, availability re-probed; honest "not understood" with what was detected. | R1 R2 R3 R4 R16 |
| **4 — Change review, context actions, dependency intelligence** | Hierarchical review (survey/block/question/option) with expand/collapse, per-change selection and partial apply, question code/type/text, old → new, affected logic and dependencies, status; hover preview of an option's properties and dependents; semantic preview with technical details collapsed; tab strip and tables that never scroll sideways. Selecting a question or option exposes only its valid operations. A dependency view (direct, conditional, calculation, piping, masking, randomization, analysis, translation) with click-to-navigate; impact count before apply. | R13 R14 R15 |
| **5 — History, honest completion, state sync** | Persisted operation history (migration + route): timestamp, prompt, intent, targets, proposed/applied/rejected/failed, warnings, engine ops, model calls, before/after, status; view, expand, compare, restore where safe, reapply. Apply awaits the save and reports saved/failed; failed applies are not "applied"; audit failures surface; store undo updates history; failed grammar proposals do not dirty the editor. | R11 R12 R20 R21 |
| **6 — Analysis, findings, translation intelligence** | `explainPlanItem` (objective, variables and levels, the rule that chose the method, expected output, required base, limitations) answering "why this analysis?" deterministically; sample-size-aware planning and review; executed derived variables; direction-aware verdicts; analysis impact at type/option changes; one placeholder grammar on `pipingTokens`, `{label}` closed, orphan translation keys pruned/reported, per-change translation impact report, wrong-script detection; framework → affected components when the survey changes. | R17 R18 R19 + §2.3 |
| **7 — Tests, runtime verification, final audit** | The brief's §27 matrix as unit, browser and mutation tests (question/option/logic/dependency/translation/analysis/history/runtime); a runtime check that every applied change appears in the preview and test build; the final end-to-end audit. | — |

Each phase keeps the rules of §4: engine pure, one vocabulary, model output as data, only Apply writes, nothing removed.
