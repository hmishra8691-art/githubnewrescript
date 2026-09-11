# Credit transfers by their owner · Matrix axes · Display-logic scopes · Other-Specify isolation

*Four fixes on top of `02e2fb3`. Engine 915 tests (+29), billing 17 (+1); new suite `scripts/logic-fixes-test.mjs`; `scripts/billing-test.mjs` extended; guard audit 126/126.*

Two of the four reported problems were not where the report placed them, and finding that out changed what got fixed. Both are recorded here, because the wrong diagnosis is the expensive part.

## 1. A person moves their own credits

Transfers existed but only an administrator could reach them. The engine did not need changing — the same atomic SQL function, the same two ledger lines under one transfer id — only a door for the person whose balance it is.

**Who may spend what.** A person's own wallet is theirs, and needs no capability. A project's wallet needs **`billing.transfer`** on that project, a new capability granted to the **owner** only: an editor programs the survey, the owner decides what the budget is for. `POST /api/billing/transfer` resolves the source through `requireProjectFor(user, id, "billing.transfer")`, so a project someone merely collaborates on is refused with a sentence that says what to do instead.

**What may move.** `balance − reserved`, enforced by `Meter.transfer` and nowhere re-implemented — money an operation in flight is holding is not theirs to give away, and neither is overdraft room. The screen shows the same number the server will check, so a refusal is never a surprise.

**Who receives.** Another person **by User ID** (`USR-10482`, or their email), resolved within the sender's workspace — the same reach project sharing already has, not a lookup oracle for the installation. Or one of the sender's own projects. A transfer to oneself is refused (`self_transfer`), as is any transfer whose source and destination are the same wallet.

**The confirmation** resolves the User ID first, so a typo is caught before anything moves, and names the recipient: *"You are about to transfer $25.00 to User USR-10482 (Ana Costa). This amount will be deducted from your available credits and added to the recipient's credits."*

**History** is per person and from their point of view: Date · Transfer ID · Type (Sent / Received) · Recipient or sender · Amount · Status, covering their own wallet and the projects they own. Administrators keep the system-wide view. `GET /api/billing/transfer`.

UI: a **Transfer credits** card on `/billing` (My usage). Tests: the brief's cases A–D in `packages/billing/src/billing.test.ts` — $100 → $25 → $75/$45; $20 attempting $25 refused with no balance change and no ledger line; $100 with $40 reserved attempting $70 refused and the available $60 accepted; both ledger lines sharing one transfer id.

## 2. Matrix / grid: what a reference actually names

**The model was already right; the tooling around it was not.** A grid has two axes and the condition has always had two fields — `rowCode` and `columnId` — and `evaluate.ts` has always resolved both correctly. What nothing else knew is that **`columnId` means two different things**:

| | rows | columns | `columnId` holds |
|---|---|---|---|
| `matrix_single` / `_multi` / `_dropdown` (`per_row`) | the statements | **the answer scale, kept in `q.options`** | an **option code** |
| `composite` / `custom_table` (`cells`) | the statements | real `QuestionColumn`s with their own types and options | a **column id** |

Everything around the evaluator assumed the second. So the lint validated `columnId` against `q.columns` and reported *every* supported matrix reference as a mistake; the Logic Builder drew a column picker only when `q.columns` was non-empty, which is never true of a Likert grid — **"any row rated Excellent" could not be authored at all**, only hand-written; and the value picker always listed `q.options`, so a composite cell fell through to a free-text box.

**`packages/engine/src/gridAxes.ts`** is now the one answer to "what are this question's axes and what does a reference to each mean", read from the response model rather than a hand-written base-type list:

- `gridAxes(q)` → `{ model, isGrid, rows, columns, columnMeaning: "option_code" | "column_id" | "none" }`
- `gridScaleOptions(q)` — the scale wherever the question keeps it, including the `columns[0].options` spelling the renderer accepts and nothing else knew about
- `valueChoicesFor(q, ref)` / `authoringValueChoicesFor(q, def, ref)` — the values *this* reference can hold: a flat question's options, a grid's scale, or the named column's own list
- `referenceShape(q, ref)` → `cell | row | column | whole`
- `describeReference(q, ref)` → `Q5[Product A].Excellent`

Applied: the **lint** validates each axis against the right vocabulary (and says "scale point" when that is what it is), stops treating row codes as answer values, and now warns that a grid rule naming **neither** axis reads the whole `{row: value}` object and can never match — a rule the builder's own defaults used to produce. The **Logic Builder** offers both axes for every grid, labels them for what they are ("rated: Excellent" on a Likert grid), scopes the value list to the chosen cell, and prints the resolved reference beside the rule. The **count editor** calls a grid's options "scale points".

Backward compatible: no schema change, no migration, every existing condition evaluates exactly as before.

## 3. Display logic: the parent scope, stated

**The runtime order was already correct** — `visibleQuestions` filters the page before `effectiveQuestion` is called on anything, so a hidden question's options were never rendered, never validated, never punched. There was no conflict to fix. Two real gaps sat behind the report:

**A selection of something no longer offered stayed a selection.** A respondent picks Blue, changes an earlier answer, and the rule that offered Blue now says no. The renderer stops drawing it and the validator stops counting it as available — but the stored answer still said "Blue", so it counted towards min/max selections, drove other questions' logic, filled a quota cell and left on the export. `pruneHiddenSelections(def, questions, ctx, loop)` intersects every **visible** question's answer with what it actually offers, and runs where auto-punch runs: on page arrival (before prefill, so auto-selection can refill) and as the respondent answers on the same page. A single-select answer that goes takes its Other text with it. **Hidden questions are left alone** — a question the respondent cannot see has not been asked to change anything, and a respondent who goes back must find their answer where they left it.

**What it is allowed to delete took three corrections to get right, and all three were the same mistake**: assuming the definition describes the answer. The regression suite found each one, and the rule that came out of them is narrow on purpose — an answer that should have gone is a stale value in an export, while an answer wrongly deleted is a respondent's work destroyed, and the two are not worth trading against each other.

| what broke | why | the rule now |
|---|---|---|
| a dynamic list came back empty | a `fields` answer is an ARRAY OF RECORDS; walking it as `{row: value}` read the array indices as row codes | the **response model** decides — only `single_choice`, `multiple_choice`, `per_row`, `cells` are touched at all |
| a slider grid came back empty | switching a carousel judge to Slider makes the base type `matrix_numeric` while the old 1–5 options stay on the question; every reading failed a membership test against that stale scale | values are checked only where they ARE codes — `sourceKindForQuestion(q)` is `choice` or `list`, the same classifier the logic operators use |
| an adaptive question lost the answer just given | `adaptedQuestion` substitutes the whole option list at render time, so the code the respondent picked was never in the authored one | the view is `effectiveQuestion(adaptedQuestion(q, ctx).q, ctx)` — the question as the respondent sees it |

And rows, which nothing caught but which follow from the same reasoning: a row is dropped only when **the question itself authors it** and the pipeline has since taken it away. A row the definition does not spell was put there by carry-forward, a list operation or a loop item — provenance this function cannot see — so it stays, and a row carrying `sourceQuestionId` is never touched. `pruneShapes.test.ts` holds one case per non-choice model plus these, so the class cannot come back.

**Nothing said *why*.** The debug panel ran the option pipeline for every question on the page, hidden ones included, and printed a trace of perfectly visible-looking options next to a display-logic verdict of HIDE. `explainVisibility` answers both scopes in the runtime's own order — type → `displayLogic` → named rules → List Fill, and only then the items — and reports a hidden question's items as unavailable **with the question named as the reason** (`decidedBy: "question_hidden"`). The Inspector's "Display logic" section is now **Visibility**, one row per question and one per item, each with its verdict and the reason; the condition trace is still printed underneath.

## 4. Other-Specify: where the text actually leaked

**The runtime was never the problem.** `Runner.tsx` keys every answer and every other-text by `answerKey(q.id, loop)`, the React key is that same string, and the renderer holds no state of its own — text cannot cross questions in a live survey, and the browser suite now proves it with four questions at once. Two other things produce exactly the reported symptom:

**A — the screen.** `LiveCanvas` (the Studio's Live View / canvas preview) held the simulator's answer and other-text in two bare `useState`s keyed by **nothing**, relying on being remounted when the selection changed. That is an accident of the current layout, not an invariant. Both now live in one map keyed by `answerKey(q.id, loop)` — the runtime's own key — and the other text is written into the response state, so the **real validator** can see it (it could not before: "Please specify" stayed on screen while the programmer typed).

**B — the data.** A new question was minted `Q${questions.length + 1}`, so deleting one of three and adding another produced **two questions both coded and variabled Q3**. Ids stay unique, so the Studio and runtime were fine — but both write `Q3` and `Q3_other`, and one respondent's Other text appears under both questions in every export. `nextQuestionNaming(def)` mints the next *free* name; `lintVariables` now compares ownership by question **id** rather than code, so the collision it could previously never see ("Q3 and Q3 — nothing to report") is reported in the words that explain the symptom.

**And three more found along the way**, all in the same feature: abandoned text was never removed when the respondent unticked Other (now `syncOtherText`, called by `setAnswer`, so every surface gets it); the flat export column read an unscoped key while the loop pass read the scoped one; and the button, card and tile select layouts rendered **no Other box at all** — a respondent who chose "Other" on a tile question had nowhere to type, and the validator then refused to let them past a question it gave them no way to answer (`OtherSpecifyBox` renders below the choices, on the same condition and against the same value).

`packages/engine/src/otherSpecify.ts` is now the only place the key `${answerKey(q.id, loop)}__other` is spelled: `otherKey`, `otherTextOf`, `setOtherText`, `otherIsSelected`, `syncOtherText`, `otherSpecifyEntries`. One box per question by design — two flagged options in one question share it, which is what the dictionary (`VAR_other`) and every export already assume.

## Tests

| where | what |
|---|---|
| `packages/engine/src/otherSpecify.test.ts` | four questions (2 single, 2 multi) keep four texts; editing one moves none; unticking clears only its own and removes the key; loop iterations are separate; `nextQuestionNaming` skips a taken name; the duplicate-code lint fires on `Q3`/`Q3` |
| `packages/engine/src/visibility.test.ts` | hidden question + option whose own rule says show ⇒ both hidden, with the question named as the reason; visible question ⇒ A and C, B by its own rule; `settings.hidden` and engine-filled types; pruning of a multi-select, of a single-select with its Other text, idempotence; a hidden question's answer preserved |
| `packages/engine/src/gridAxes.test.ts` | the brief's A/B × Yes/No grid addressed as four distinct cells; composite columns carry their own vocabulary; the scale found on `q.options` or `columns[0].options`; the lint stops reporting the supported matrix form and still catches a bad scale point, a bad column id and a row code used as a value; a rule naming neither axis warned *and* shown not to match |
| `packages/billing/src/billing.test.ts` | the brief's cases A–D |
| `scripts/logic-fixes-test.mjs` | all three engine fixes in the real runtime: four Other boxes typed and cross-checked on screen and in the response; hidden question ⇒ no options; a pruned selection; matrix axes surviving a round trip |
| `packages/engine/src/pruneShapes.test.ts` | one case per response model that is not a choice — repeating group, text list, numeric, open text, ranking, allocation, numeric grid, place — each answer byte-for-byte unchanged; a numeric grid carrying a stale 1–5 scale keeps its 6; a text grid is never measured against an option list; a generated row survives; an authored row the pipeline hid does not |
| `scripts/billing-test.mjs` | `/api/billing/transfer` is session-guarded |

`scripts/blocks-test.mjs` asserted the inspector heading "Display logic"; it now pins "Visibility" with a comment saying why the rename is the contract.

## Three suites that were already red

Found while running the corpus, none of them caused by this work — each verified by running the suite against a clean tree.

**`variants-g5` and `variants-g6` fixed here.** Both asserted that Speech-to-Text Response and Respondent-Specific Options were *still* "coming soon". Both shipped on 2026-09-10, and not as question types: the first is the `speech_input` capability on Multi-Line Text, the second is option `visibleIf` logic on an ordinary choice question, each now offered as a preset under a shorter id (`media.speech_to_text`, `dynamic.respondent_specific`) — so the placeholder ids the suites waited for no longer exist and the waits timed out at 30s. They now assert what shipped, and that the old promises are gone from the picker.

**`speech-input` left alone and reported.** Line 107: dictating a second time into an edited field appends nothing — `"I liked the packaging."` where `"I liked the packaging. Delivery was slow."` is expected, while the first dictation on the same field appends correctly. Either a real defect in restarting dictation over an edited value or a missing wait in the suite; it is not this brief's code, and guessing at a test whose failure may be the product's would hide it.
