# Intelligent Mode, Phase 3 — the engine reads the sentence first

*Intelligent Mode upgrade, Phase 3. Built 2026-10-05 on Phase 2 (INTELLIGENT-MODE-ENGINE-2026-10-05.md). It fixes the audit's root causes R1–R4 and the routing half of R16: the cloud no longer goes first, a sentence is never charged twice, and the deterministic interpretation lives in the engine and speaks the one action vocabulary.*

## The route now

```
sentence ─► engine interpretRequest(def, text, selection)            no network, no charge
   ├─ actions   ─► the same proposal chain as a model's: Changes panel, Apply, undo, history
   ├─ answer    ─► the survey's own graph: sections with navigable references
   ├─ clarify   ─► one choice per candidate; choosing one re-asks with it
   ├─ refused   ─► what was asked, what was detected, why, and a checked fix ("Preview the suggested fix")
   └─ model     ─► reason "defer:grammar": the grammar's read-only answers (explain, diagnose, screening)
                   otherwise: the copilot — once; /api/ai/logic only when there is no copilot
```

Every edit the engine returns has already been applied to a clone by `applySurveyActions` — with Phase 2's pre-apply validation — inside the interpreter; an edit that would be refused comes back as `refused` with the engine's reason and its suggested action, never as actions that fail later.

## The engine's interpreter

| File | What |
|---|---|
| `packages/engine/src/naturalCondition.ts` | `normaliseConditionText` — everyday operators into the parser's, moved from the Studio so the grammar and the engine read conditions the same way; it now knows "is over / under / above / below / older than / younger than", "N or more", "exceeds", "neither … nor", "none of". `conditionFromText` normalises and parses strictly. |
| `packages/engine/src/nlTargets.ts` | what a sentence names: a question by code, variable, selection or description (several matches → candidates; none → did-you-mean); ranges ("Q8 through Q12", "Q8–Q12", "Q8, Q9 and Q10", "the next five questions" from an anchor, "these questions"); an option ("option 3", "the third option", a label, "None", "the Other option", "the last option"); the question after a range. |
| `packages/engine/src/nlIntent.ts` | `interpretRequest` and the intent taxonomy (`INTENT_CATEGORIES`: survey creation and editing, question creation and modification, option modification, logic, validation, randomization, masking, variables, calculations, translation, analysis, findings, research design, quality control, data cleaning, reporting, visualization, export, debugging, dependency analysis, impact analysis). |

What it recognises, deterministically:

- **Logic.** Skips with ranges and relative targets ("If Q7 is No, skip Q8 through Q12" → after Q7, when Q7 = 2 (No), go to Q13; "skip the next five questions"), terminate and screen-out, display logic with AND / OR / NOR / unless / "also show", removal; refused when backward, when the condition reads inside the range, or when a shared page would undermine the skip — the latter with the page break added as the fix.
- **Options.** Add Other / None / a list; remove; rename; recode; exclusive and other-specify; sort A→Z, Z→A, by code, reverse; move to the top, bottom, before or after another; anchor; an option's own display condition.
- **Randomization and masking.** Randomize keeping named options first or last, pick N, rows, stop; block randomizers; masks and carry-forward ("Mask all brands selected in Q5 from Q10", "at Q10 show only …", "remove from Q10 the options selected in Q5"), clearing.
- **Questions and survey.** Required / optional (one, a range, the selection), delete, duplicate, move, change type, rename variable or code, validation (ranges, selections incl. exactly N, length, formats — merged with the question's existing rules, since `set_validation` replaces), page breaks, embedded variables, calculations, survey title and description, languages (add / remove), hypotheses (add / remove), the analysis framework (`propose_analysis_plan`).
- **Questions about the survey**, answered from its graph: what depends on Q7 / what Q7 reads (grouped by display, skip, masking, piping, calculations, quotas, randomization, flow, analysis plan, constructs, translations, then indirect), what breaks if Q15 (or an option, or a block) is deleted, retyped or moved (Phase 2's impact, by severity), which questions are untranslated, which questions measure a construct (with the evidence for each: recorded construct, analysis tag, or wording), what analysis the study supports, which variables to cross-tab, which hypotheses can be tested (recorded ones and their coverage; none are invented), which variables a segment uses.
- **Several instructions in one sentence.** "Remove the trust block and make the platforms question optional" is split where "and", "then", a comma or a full stop is followed by a command verb (never inside a condition — "when Q1 > 18 and Q3 = 1" stays whole; "skip Q8 to Q9 and go to Q10" and "… and set it to India" continue their clause; a leading "if …," binds to the clause right after it). Each clause is read against the survey the clauses before it leave, and the whole is applied together after one dry run. A clause the survey already satisfies is left out and said ("Left as it is: Q3 is already optional"); a clause for the model sends the whole sentence to the model; a refused or ambiguous clause is reported for that clause, with the choices and the fix written into the whole sentence.
- **Nothing to change is said, not done.** A rule, flag, position, type or language that is already as asked comes back as "already … — nothing to change", and a suggested fix that would change nothing is not offered.
- **Blocks are named by title** in the actions when the title names one block alone (an id would not survive the replay of an open proposal that created the block), by id otherwise.
- **Handed on.** Generation from a brief, rewording, translation text ("Translate this survey into French" — with "add French first" in what was detected), research synthesis, narrative findings, report structures, look-and-feel, and phrasing it does not parse — each with the category it guessed and the objects it found.

## The Studio

- `IntelligentView.ask` calls `interpretRequest` on the survey as the open proposal would leave it (so a revision builds on what is proposed), with the selection (`selectedId`, and `selectedIds` for a multi-selection).
- `useCopilot.local` turns an interpretation into a copilot turn without a network call; its actions join the open proposal exactly as a model's do. The card says **internal engine · no model call**, lists what was detected (the condition with its option label, the range, the target), and renders the answer's sections (each reference navigates), the choices, and the refusal with **Preview the suggested fix** or **Ask this instead**.
- The grammar's `normaliseExpression` is now the engine's. `/api/ai/logic` is called only when there is no copilot, so one sentence costs at most one model call. The provider badge reads **engine**, **engine + copilot** or **engine only**.
- `diffSurveys` now compares option codes, option flags, option display conditions and export values, masks, custom JavaScript / CSS, and validation values (a range 18–99 → 21–99 kept its kinds and read as nothing); a page break reads as "Add / Remove 1 page break" (it read as a new block and every question on the page moved). The browser suites found each of these as "nothing to apply" or a wrong summary.
- An engine proposal selects its target (the inspector shows it, "this question" follows it); after Apply the first added or modified question is selected. The Changes panel's outline keys rows by position and id (a question in two branch arms gave duplicate React keys).
- Deleting a quota by name ("Delete the gender × age quota") is the engine's `delete_quota`, never a question or a block of that name.

## Tests

- Engine: 1607 tests. The interpreter, its targets and its normaliser have 48, 8 and 7 test blocks, covering the brief's thirteen researcher sentences (each asserting the kind, the category and the content, and for edits that the actions apply cleanly with the expected structure), compound requests, and the edges found by mutation.
- Mutation-checked: the three Phase 3 modules (99 mutations; the survivors closed with 9 tests; one real bug — "jump back to Q9" when Q9 is ahead was refused for the wrong reason); the diff fix (6 / 6); the fixes made while adapting the browser suites (14 / 14, three survivors closed with stronger tests).
- Studio unit: 223 (the grammar's normaliser assertions read the engine's spelling: upper-case connectives, `!=`; "over 25" → `> 25`).
- Browser:
  - `scripts/engine-first-test.mjs` (9): the skip over a range, the display condition with "over 25", the mask and the anchored randomization, the impact answer, the refusal with its fix, the ambiguity as a choice — none calling a model route — and a rewording sent to the copilot once.
  - `scripts/intelligent-mode-test.mjs` (55), adapted behaviour by behaviour: deterministic edits are asserted on the engine card and the Changes panel (what was resolved, the from → to rows, apply, undo as one step), with every assertion on the resulting survey as strict as before; the grammar's card for what it still answers (explain, screening, hidden variables, voice); the "Review Logic" tree of a grammar proposal is replaced, for an engine proposal, by the Changes panel's field-level row.
  - `copilot-test` (11), `quota-copilot-test` (9), `translation-copilot-test` (10), `ux-copilot-test` (13), `findings-copilot-test` (7), `analysis-framework-test` (7), `import-engine-test` (8): all pass. Where a suite's sentence is now the engine's, the suite drops the fake model reply queued for it (`__rescriptCopilotFakeReset`) and asserts on the engine's result.

## Not done here

- The review that renders `changeItems` (hierarchical, selectable, no sideways scrolling), the dependency view and the context actions are Phase 4.
- The engine does not reword questions or write translations; those remain the model's (Phase 6 strengthens the translation checks).
