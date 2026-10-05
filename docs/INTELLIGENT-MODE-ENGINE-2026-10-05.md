# Intelligent Mode, Phase 2 — the engine's vocabulary, validated before it is accepted, with its impact

*Intelligent Mode upgrade, Phase 2. Built 2026-10-05 on the audit (INTELLIGENT-MODE-AUDIT-2026-10-05.md). It fixes, in the engine, the audit's root causes R5–R10 and the engine half of R16, and adds the option-level and missing operations of §2.5.*

## What changed

**One vocabulary, now complete enough to program with.** The copilot's `SurveyAction` vocabulary gained a module of its own, `optionActions.ts`, plugged in exactly like the quota, translation and analysis modules:

| Op | What it does |
|---|---|
| `update_option` | one option of one question, addressed by id, code, unique label, "option 3" / "#3" / position: label, code (recode), export value, exclusive, other-specify, anchor top/bottom/none, display condition, position. A recode rewrites every condition in the survey that compared the question with the old code — display logic, skips, quota cells, punch code lists, randomization groups, a ranking's code (not its rank), a `between`'s second bound, a COUNT's `where` — and says how many, as destructive. |
| `reorder_options` | an explicit (partial) order or a sort (alphabetical, Z→A, numeric, reverse); anchored options stay at their edge. |
| `set_option_randomization` | randomize options (or a matrix's rows), keep named options first/last, pick N; an anchor in the middle is refused with the question to answer. |
| `set_mask` / `clear_mask` | a SET expression (`Q5.Selected`, `A DIFFERENCE B`, …) as the mask on options, rows or columns, with its action; a source asked at or after the target is refused, naming both. |
| `duplicate_question` | the engine's own duplicate, placed after the original or a named question. |
| `set_survey_settings` | title, description, code. |
| `update_embedded` / `remove_embedded` | rename (rewriting the conditions and pipes that read it), source, value, type; removal refused while anything reads it unless forced. |
| `add_hypothesis` / `remove_hypothesis` | one at a time; removal drops the label from the questions' analysis and the plan and renumbers the later ones (H3 → H2). |
| `set_custom_code` | a question's custom JavaScript and CSS. |

`set_validation` also takes `exact_selections` (stored as the min and max the engine checks).

**Validated before it is accepted** (`actionValidation.ts`). Every action is now applied to the clone and then checked *before* it is kept; an error rolls it back and refuses it with the object named and, when one is safe and obvious, the corrected action (`suggestion`) for the Studio to offer as "Apply suggested fix". Previously these were post-hoc quality-check warnings, or nothing:

| Check | Example refusal |
|---|---|
| `forward_reference` | "Q5 is asked after Q1, so Q1 cannot be shown on Q5's answer — move …, or put the condition on … instead." |
| `self_reference` | display logic, a display rule or a mask reading the question itself |
| `operator_mismatch` | "Q12 is a single-select question, so this condition must compare one option value; the requested condition reads Q12 as a number (>)." + the `eq` version as the suggestion |
| `literal_type` | a numeric question compared with words; a choice question (or a grid read without its row) compared with a value that is not one of its codes, the codes listed |
| `stale_option` | "Removing option 3 “Canada” from Q7 leaves Q9's display logic and quota “Region” cell 2 comparing Q7 with a value that no longer exists …" |
| `cycle` | a dependency cycle the action introduced |
| `validation_fit` | a rule that does not fit the type (min value on text, max selections above the option count, min above max) + the action without it |
| `move_order` | a move that puts a question before what it reads, or after what reads it |
| `type_change_breaks` | a type change whose dependents' conditions no longer fit |
| `dangling_reference` (warning) | a pipe that resolved before and resolves to nothing now |
| `contradiction` (warning) | a condition that can never be true (`> 25 AND < 10`, two equalities on a single answer) |

**Renames follow their references.** A variable rename and a code rename now go through `applyRename` — the Variables panel's own walk — so conditions, calculations, pipes, quota cells and the analysis plan are rewritten, not left dangling.

**The parser stops storing silent nonsense** (`logicExpression.ts`, `optionCodes.ts`): `A NOR B` is a real operator (stored as NOT (A OR B)); a bare right-hand word that names nothing is an error with a did-you-mean (`Q9 > Q99` → "did you mean Q9?") and the corrected text as `suggestion`; in strict mode — the action layer's — a numeric question compared with a word is refused; bare ISO dates are literals; structured conditions keyed by code or variable are canonicalised (option labels become codes) like text ones.

**Impact, computed and carried** (`impact.ts`, `dependencyIndex.ts`). The dependency index now knows the analysis plan (one node per crosstab, test, derived variable and segment), constructs and translations (one node per language). `impactOf(def, scope, { change })` lists everything a deletion, recode, type change, move, rename or edit reaches — direct and indirect — with a severity (`breaks` / `changes` / `informs`) and a summary line ("Impact: 5 dependent objects — Q9 display logic, Q11 skip logic, calculation SCORE, construct Satisfaction, German translations"). `applySurveyActions` attaches it to every result whose action removes, recodes, retypes, moves or renames something.

**Per-change records for the review** (`changeItems.ts`). `changeItems(before, after, { results })` is the hierarchical change list the new review renders: one item per change at its level (survey, block, page, question, option, logic, flow, research, analysis, language, ux), with the question's code, type and text, the option's code, label and position, the category (from a closed list), old and new values formatted for a person (never JSON — the trees go in `technical`), the dependents it affects, the destructive note and the action that made it. Options are paired by id, then code, then a lone same-label pair (a recode); moves are found by the longest common subsequence of the order, so a swap names one question. `diffSurveys` also gained `questionsMoved` (and a "Move Q1 (…)" summary line) — a reorder used to read as "nothing changed".

## Where

| File | What |
|---|---|
| `packages/engine/src/optionActions.ts` (+ test, 20) | the new ops |
| `packages/engine/src/actionValidation.ts` (+ test, 28) | `validateActionOutcome`, `ActionIssue`, the walkers |
| `packages/engine/src/impact.ts` (+ test, 21) | `impactOf`, `impactOfAction`, `ImpactReport` |
| `packages/engine/src/changeItems.ts` (+ test, 26) | `changeItems`, `ChangeItem`, `CHANGE_CATEGORIES` |
| `packages/engine/src/dependencyIndex.ts` | analysis, construct and translation nodes and edges |
| `packages/engine/src/surveyActions.ts` | the module wired in; validation hook; impact; renames; exact selections; moves in the diff |
| `packages/engine/src/logicExpression.ts`, `optionCodes.ts` | NOR, did-you-mean, strict numeric literals, ISO dates, canonicalisation by code |
| `apps/studio/lib/copilot/prompt.ts` | the new actions in the model's action language (one line each) |

## Tests

Engine: 1588 tests, all passing (1439 before this phase). Mutation-checked: 196 mutations across the new modules and the edits; 113 caught at first; the 83 survivors closed with 49 new tests (75), documented as equivalent (7, each with its reason), or revealing a real bug (1, plus two found beside survivors) — all three fixed in `actionValidation.ts` and themselves mutation-checked (3 / 3):

- a grid read without a row was never checked against its scale (`GRID = 7` on a 5-point grid was accepted and never true);
- a suggested fix was attached to rules it did not fix;
- the contradiction check treated two different counts on one question as one number.

Studio unit tests: 223, passing (the system-prompt budget is 13,800 characters, for the new action lines).

## Not done here (later phases, or open)

- The deterministic interpretation of sentences into these actions and the engine-first routing are Phase 3; the review UI that renders `changeItems` is Phase 4.
- The contradiction check can still warn falsely on reads that cover several cells (a grid without a row, a constant sum), and does not look at text, dates or multi-selects; the expression editor still stores a label for a grid read without its row (the action layer refuses it now).
