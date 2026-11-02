# Import: dynamic reconstruction (carry forward, masking, loops, piping), checked and simulated (2026-11-02)

Patch 0057. This builds on the I1–I8 import engine. It does not replace it. There is still one pipeline:

1. `readSource`
2. the canonical model
3. `mapCanonical`
4. `reconstruct`
5. `buildReport`
6. `verifyImport`

It still produces one survey definition.

## 1. Audit: what was wrong

The audit used four new synthetic files: Word 08–10 and QSF 05 (see §4). It ran them through the importer **as committed** (HEAD `1611daa`).

### Word / document path

On these patterns the Word path reproduced **no** dynamic behaviour.

| Source wording | What happened | Root cause |
|---|---|---|
| `[CARRY FORWARD BRANDS SELECTED AT Q1]` | Dropped silently, not even reported | The instruction regex only knew IF / ONLY / SKIP / TERMINATE wording, so the line was neither read nor listed as unread |
| `[SHOW ONLY BRANDS NOT SELECTED AT Q2]` | Reported as an unread instruction | "SHOW ONLY …" was taken for display logic and failed to parse as a condition |
| `[ASK FOR EACH BRAND SELECTED AT Q1]` | Misread as display logic | The same |
| `[BRAND]`, `[INSERT ANSWER FROM Q1]`, `[Q5 ANSWER]`, `{Q4}` | Left in the text, so the respondent would see the brackets | Nothing converted placeholders to piping tokens |
| A question whose list is carried (no options written) | Became an open-text question, with a "lists no options" issue | Kind inference saw no options |

### QSF path

| Pattern | What happened | Root cause |
|---|---|---|
| A condition on a carried choice (`q://QID2/SelectableChoice/x1`) | The whole display logic was dropped | `x1` is not a choice of QID2 (it has none of its own), so the code lookup failed |
| `${e://Field/panel}` in an end-of-survey redirect | Kept as `${…}` text | The QSF end node's URL was not passed through `qsfPiping` |
| Piping in instructions, descriptions and validation messages | Not converted | The mapper piped question text and options only |
| Lint on a loop over a carried question | False warning "has no options" | The lint read the loop source's own options; the runtime uses `effectiveQuestion` |

### Verification and data (found while testing)

- **A carried multi-select had no columns in the data.**
  - The variable dictionary declared the per-option 0/1 columns from `q.options` only, and the flattener wrote them the same way.
  - A pure carry-forward has no options of its own, so CSV, SPSS, Stata and SAS had no column for it at all. A carried single-select had no value labels.
  - The answers were collected but never delivered. This affects any survey with a pure carry-forward, imported or not.
  - The lifecycle test caught it: 3 files failed "every answered question has a CSV column".
- **The verifier's walker answered from `q.options`.**
  - A required pure carry-forward was therefore "unanswerable", a loop over it ran zero times, and its questions were reported unreachable.
  - For QSF 05 that was 6 of 8 questions reached and NOT OK, although the survey is fine.

### One audit claim withdrawn

During the audit I believed the engine did not pipe an end node's `redirectUrl`, and I changed `compileFlow`. That was wrong:

- `advance()` already resolves an end step's redirect, with quota counts.
- I reverted the change.
- I added a test proving the existing path: `flowEmbeddedPiping.test.ts`, "an end node's redirect pipes embedded data …".

## 2. What changed

### Reading (deterministic first)

`packages/import/src/adapters/dynamics.ts` runs in the document reader before the conditional-logic reader.

**Carry forward, masking, same list and loops** are read from both formal and informal wording:

- carry forward / carry over / show only … selected / take the list from;
- … NOT selected / mask out whatever they chose;
- same list as / use the same answer list as;
- ask for each / repeat this question for every … selected.

Their source is either named ("Q1") or "the previous question". The second is marked *inferred*.

- A carried question with no written options takes its kind from the wording: multi if "select all", else single.
- Consecutive looped questions share one loop. The block is split around it, titled "… — for each brand".

**Placeholders** become the engine's tokens:

| Source | Becomes |
|---|---|
| `[BRAND]`, `<BRAND>`, `{BRAND}`, `[THIS BRAND]`, `[ITEM]` inside a loop | `{{loop.label}}` |
| `[INSERT ANSWER FROM Q1]`, `[Q5 ANSWER]`, `[PIPE Q2]`, `[INSERT Q2 RESPONSE]`, `{Q4}`, `<Q4>` | `{{@Q1}}` → `{{Q1}}` |
| `[INSERT FIELD]` for an embedded field | `{{ed.field}}` |

**What no rule can read is never guessed.**

- Wording that sounds dynamic but names no source becomes an open question for the person. Example: "Only show the supermarkets they like".
- An `[INSERT …]` that resolves to nothing stays as text and is reported.

Every reading is recorded in `canonical.dynamics` with the source's words.

**QSF:**

- `optionCode` resolves an `x<id>` choice, or a choice missing on a carried question, through the carry chain to the source's code (and its recode).
- End-of-survey redirects are piped.
- Instructions, descriptions, validation messages and end redirects are piped like question text.

### The native capability registry

`packages/import/src/nativeRegistry.ts` has 23 entries. Each entry gives:

- the feature;
- where its JSON lives;
- a **sample** of the native JSON;
- the required properties;
- its dependencies;
- the **engine function that runs it**;
- how it is validated;
- its limits.

`nativeRegistry.test.ts` parses every sample through the survey schema. It fails if the schema strips any key (an invented property), and fails if the engine does not export the runtime function. The registry therefore cannot describe something the platform does not do.

### Reconstruction: check → correct → re-check

`packages/import/src/reconstruct.ts` runs after mapping. It makes at most 3 passes and stops when nothing changes. It applies only corrections built from registry capabilities:

| Situation | Correction | Category |
|---|---|---|
| A document writes Q1's brands **and** says "carry forward from Q1", so both lists would show | The written copy goes: the carried options keep Q1's codes. What Q1 lacks stays as the question's own (`keepOwn`) | alternative |
| The same in a QSF | Kept as the source has it, because Qualtrics shows both | confirm |
| A loop over a **single**-choice source | Unwrapped. `{{loop.label}}` becomes `{{SRC}}` | alternative |

It then explains every relationship in one of five categories, each with the source's words, the reading, the native implementation (from the registry) and why:

- **reconstructed**
- **alternative**
- **confirm:** inferred, or an unread instruction
- **partial:** for example a source asked later, a non-choice target, a forward pipe, or `{{loop.…}}` outside a loop
- **unsupported:** for example a missing source

### Decisions: the mapping is editable

`clarify.ts` adds two question kinds:

- **`dynamic_list`:** an unread instruction. Alternatives are built from the three closest earlier choice questions: selected, NOT selected, a loop, or leave it. No recommendation is made.
- **`confirm_dynamic`:** an inferred source. "Keep" is recommended; the other sources and "drop" are alternatives.

It also adds four decisions: `carry_forward`, `loop`, `drop_dynamic` and `keep`.

- They are applied with the existing decisions route, and the import is re-analysed.
- Untrusted client decisions are validated. The route refuses:
  - an unknown filter;
  - a self-reference;
  - a missing question;
  - a source asked later.
  The unit test checks all four.

### AI

The suggestion prompt (`SUGGEST_SYSTEM_PROMPT`) now lists the registry's native capabilities. The model's role is unchanged: it may only pick one of the engine's numbered, already-checked choices, or none.

**No model writes survey JSON.** That is deliberate, so that no property can be invented. The "self-correction" above is deterministic. AI is used only where the source is ambiguous, to suggest an answer among valid choices, and the suggestion is labelled and never applied by itself.

### Synthetic respondents

`packages/import/src/dynamicSim.ts` runs as `verifyImport` → `verification.dynamics`, on the engine the runtime uses:

| What is tested | Scenarios | Expected |
|---|---|---|
| Each carried / masked / same list | The source answered with one answer, several, none, then changed | The filter **the source states** applied to the source's answer. This comes from the canonical model, so a mapping that changed the filter, the source, or dropped the carry **fails** (tested) |
| Each loop | Two answers selected; "none of these" where the source has an exclusive answer | Each looped question asked and stored once per item (`<id>@<code>`); nothing asked for none |
| Each pipe | The source answered | The resolved text carries the answer's label or value |

The verifier's walker now answers a carried or masked question from what the respondent is shown. Every other question is answered exactly as before; the QSF corpus 01–04 shows no drift.

### Data export

`packages/engine/src/optionUniverse.ts` gives a question with a carried list the **option universe**: its own options, then the source's, followed through a chain of carries, each code once. The dictionary (`variables.ts`) and the flattener (`flatten.ts`) both use it, so the declared and written columns stay identical:

- a carried multi-select gets `Q2_10`, `Q2_20`, … with the source's codes;
- a carried single-select gets the source's value labels.

### Review screen

The card shows "dynamic lists, loops and piping: N of M respondent scenarios behave as expected". The Fidelity report lists each scenario: expected against engine.

The import review has a new **Reconstruction** tab:

- **C · Requires attention:** the confirm, partial and unsupported items. Each has the source's words, the reading, the native implementation, why, and what to do. "Change this reading…" opens the decision that edits it; where the source left no choice, the tab says to edit the question after it is created.
- **B · Rebuilt with another native feature:** the alternative items.
- **A · Mapped natively:** counts by feature, each item with its respondent results.

`api.md` documents `report.reconstruction`, `verification.dynamics` and the new decisions.

## 3. Tests

| What | Result |
|---|---|
| `packages/import` unit tests | 100/100. New: `dynamics.test.ts` (8), `nativeRegistry.test.ts` (1). `i8Corpus` now expects 10 Word files |
| `packages/engine` unit tests | 2,655/2,655. New: `optionUniverse.test.ts` (2) and the end-redirect test |
| `packages/exporters` | 146/146 (2 skipped: pyreadstat not installed) |
| `packages/analytics` | 738/738 |
| Studio lib tests | 1,143/1,143 |
| `scripts/import-lifecycle-test.mjs` (import → schema → deliverable → walks → CSV and SAV) | 144/144. Before the data-export fix: 141/144 |
| `scripts/qsf-fidelity.mjs` | 01–04: no drift. 05 recorded (new file; the `--update` diff is additions only) |
| `scripts/import-dynamics-fidelity.mjs` | See §4 |
| Browser, runtime preview (`scripts/import-dynamics-browser-test.mjs`), Word 08 and 09 imported and answered as a respondent | 24/24. Covered: carried list, masking, same list, the duplicate shown once, codes stored, Back → change Q1 → Q2 follows, loop over two brands in order with the brand piped, answers stored per brand, piped answers, no placeholder visible, completion |
| Browser, Studio (`scripts/import-reconstruction-studio-test.mjs`) | 6/6. Covered: the card's respondent line; Reconstruction A 4 / B 0 / C 2; "Change this reading…" → Questions; answering Q7 and confirming Q2 → A 6 / C 0; Word 08 → B lists Q6 with the reason |
| Typecheck (Studio), auth guard (266, 0 problems), dependency boundaries (0), public docs | Clean / current |

## 4. Accuracy, measured, and what the figures mean

`scripts/import-dynamics-fidelity.mjs` checks each file against expectations **written by hand from the source documents**, not copied from the output. The same checks were run against the importer as committed (HEAD), in a separate worktree:

| Dimension | Before (HEAD) | After |
|---|---|---|
| Questions (present, right kind) | 29/32 (90.6%) | 32/32 |
| Options (source codes and labels; a carried list not duplicated) | 4/5 (80.0%) | 5/5 |
| Logic (display logic on carried choices; redirect piping) | 1/5 (20.0%) | 5/5 |
| Dependencies (carry source and filter, loop source and members, unreadable instruction asked) | 7/23 (30.4%) | 23/23 |
| Piping (each placeholder → right token; none left as text) | 7/17 (41.2%) | 17/17 |
| Runtime (synthetic respondents) | not measured (did not exist) | 56/56 |

**This is not a claim of 100% import fidelity.** The four files are synthetic, and I wrote them alongside this code to cover these patterns. The figures say the importer handles **these** patterns as tested. They do not measure real questionnaires, whose wording varies more than any rule set covers. The QSF corpus's general fidelity is unchanged:

| File | As-is |
|---|---|
| 01 | 93.3% |
| 02 | 84.4% |
| 03 | 75.9% |
| 04 | 92.9% |

### Not verified

- **Real questionnaires.** No real Word document or Qualtrics export with these patterns was available.
- **A real AI model.** The fake provider only. The prompt contains the registry, but no model reply was observed.
- **Persistence against a database.** The Studio sandbox keeps import sessions in memory.
- **Phone viewport, Safari and Firefox** for the new browser tests. Desktop Chromium only.
- **`scripts/phase1-reliability-test.mjs`** was not re-run. It did not complete last time because the Studio dev server restarts for memory. The dev server restarted for memory during this work too; the Studio test passed on the second run.

## 5. Limitations

- **Masking** is imported as a carried list with `filter: not_selected`. The schema's richer `mask` (set expressions, preselect / disable) is not produced by the importer.
- **Loops** are read from Word over the answers **selected** at a question. Not covered:
  - "for each brand **shown**" or "for every brand in the list": the loop node supports these, but the reader always uses selected;
  - a loop over a fixed list written in the document ("for each of these five items");
  - nested loops in Word;
  - loops over a carried list in a grid.
- **Carry forward into a grid's rows** is mapped (`into: rows`) but no corpus file tests it.
- **The Word rules read English wording.** Other languages fall to "unread instruction". That is reported, never guessed.
- **Informal wording beyond the patterns listed in §2** is reported and asked, not read.
- **A QSF question that carries forward AND lists the same choices** is kept as Qualtrics has it (both lists show) and flagged to confirm. The importer does not decide that the duplicate was unintended.
- **Synthetic respondents test one path per scenario.** They are not exhaustive. A loop's "none" case is run only when the source has an exclusive answer.
