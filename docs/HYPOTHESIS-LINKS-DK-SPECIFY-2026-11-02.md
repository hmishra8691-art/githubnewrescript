# Hypothesis → construct → question links, "Other — specify", "I don't know" (2026-11-02)

Patch 0056. Three requests, built in the existing architecture: the engine's action vocabulary, the question settings, the renderer's central controls, the variable dictionary.

## 1. What the audit found

### "Hypothesis Humanization Mode"

No feature has that name in the code. The workflow that matches the description is the one that turns a hypothesis statement into its structured reading (`hypotheses.ts`: type, direction, the construct on each side). That workflow runs in four places:

- the Research design editor ("+ hypothesis");
- Intelligent mode (`add_hypothesis`, `set_hypothesis`, `set_research`);
- the research planner's workflow;
- document merges.

This is what was changed. If "Humanization Mode" names something else, it was not found and was not changed.

**Root causes:**

1. `add_hypothesis` recorded the statement and nothing else. The constructs its sides name were never created.
2. `set_hypothesis` refused a side that named a construct the design did not have yet. A capitalised single word such as "Trust" got "there is no construct …".
3. The construct ↔ question relationship lived in two stores that nothing reconciled:
   - `research.constructs[].questionIds`, which the coverage and the traceability read;
   - `question.analysis.construct` / `.hypotheses`, which the analysis plan reads.

   Linking a question by hand in the editor wrote only the first.
4. The planner proposed the constructs as a separate, later "framework" step, with up to three questions each. That is the "revisit the hypothesis later" the request describes.

### "Other — specify"

The runtime was correct for a flagged option: the box shows and hides with the selection, is required, and is stored per option. Single, multi and every other variant draw it, centrally.

The root cause was upstream: an option got the `other_specify` flag only in two cases:

- someone set it by hand;
- the copilot's action path matched a narrow label pattern (`^other … specify|please`, `^other (`).

The Studio's option rows, paste box and `update_option` never set the flag. So "Please specify", "Something else" and "Other – Specify" typed in the editor were plain choices with nowhere to type.

### "I don't know"

It did not exist for open text or numbers. The old option flag `dont_know` had been folded into `exclusive` on choice questions.

## 2. What changed

### Constructs and links (`packages/engine/src/researchLinks.ts`)

`linkHypothesisConstructs(def, { hypotheses? })` handles each hypothesis in three steps:

1. **Sides to constructs.** Each side of the reading resolves to a construct (`constructFor`). When none exists, one is created:
   - named as a noun with the planner's naming, now shared from this module (`constructName`, `groupingName`): "satisfied" → Satisfaction, women / men → Gender;
   - with the side's role and `origin: "hypothesis"`.
2. **Groups to answer options.** A difference between groups also records the question whose answer options define the groups, with the codes on each side (`hypothesisDetails[i].groupOptions`).
3. **Questions to constructs.**
   - Linked: a question is linked when it **certainly** measures the construct. Every meaningful word of the name must be in its text, variable or rows (as the word, or its family plus at least one literal word), or the question is already tagged with the construct. The link is written in both stores: `questionIds`, `analysis.construct` (when it has none) and `analysis.hypotheses`.
   - Listed for review: **possible** matches go to `constructs[].review`, never linked. These are matches with half of the words or more, or a one-word construct that more than six questions mention. A dismissed question goes to `dismissed` and is not suggested again.

It runs **inside** `add_hypothesis`, `set_hypothesis` and `set_research`, so the links are saved in the same change. It also runs on demand as `link_constructs` (one hypothesis or all; `review` answers a suggestion).

Running it again creates nothing new.

`set_hypothesis` now creates a missing side. It still refuses a near-miss of an existing name, and names the one it probably meant ("did you mean “Price perception”").

**Studio (Research design):**

- "+ hypothesis" links in the same edit and toasts what it did.
- Each hypothesis has **link constructs**, and there is a **Link all constructs** button.
- Each construct lists "Possibly measured by — not linked until you confirm", with **link** and **dismiss**.
- A question picked by hand now gets the question's tags too.
- Constructs made from a hypothesis are marked "from a hypothesis".

**Intelligent mode:**

- These sentences work: "link the constructs" and "link H2 to its constructs [and questions]".
- The analysis guide documents `link_constructs`, and the research guide says recording a hypothesis links.

### "Other — specify" (`otherSpecify.ts` `looksLikeOtherSpecify`)

One detector is used everywhere options are made from words:

- the copilot's `create_question` / `addOptions`;
- `update_option` relabels;
- the Studio's option rows (typing, pasting, the paste box);
- the Word / document importer.

It gives the box to "Other (please specify)", "Other – Specify", "Other, specify", "Please specify", "Something else", "Other (write in)", "Other:" and similar. A plain "Other" stays a closed answer.

The editor sets the flag only when a label **starts** to read like one, so a flag the researcher removes stays removed.

Saved surveys are never re-flagged on their own, because a live study's validation would change under its respondents. Instead, Review lists each such option with a one-click fix (`update_option … other: true`).

### "I don't know" (`dontKnow.ts`)

**Setting:** `settings.dontKnow` (default off) and `settings.dontKnowLabel`, on open text, long text and numeric only.

- In the Studio: *Enable “I don't know” option* plus *Its label*.
- In Intelligent mode: `update_question` / `create_question` `settings`, or the sentence "allow don't know on Q5". On a choice question the same sentence still adds an exclusive "Don't know" answer.
- On import: a Word / document instruction "[ALLOW DON'T KNOW]", "[DK ALLOWED]" or "[INCLUDE A DON'T KNOW OPTION]" turns it on for an open or numeric question. On a choice question the import says so in the report.
- The setting survives a text ↔ number type change and is dropped on a choice type.

**Storage:** beside the answer, at `<answer key>__dk` = true. It is never written into the answer.

**Mutual exclusivity** is enforced in the engine, not just the page:

- `setAnswer` clears the choice when a value is written;
- `setDontKnow` empties the answer;
- the validator refuses a submission holding both.

**Validation:**

- Required is met by the choice.
- Min, max, integer, decimal and length rules apply to typed values only.
- The server's replay accepts `__dk` as a companion key.

**Response status:** `responseStatus(state, q)` returns `answered`, `dont_know` or `unanswered`.

**Data:** `VAR_DK` is declared in the variable dictionary as numeric, with labels 0 = Answered and 1 = Don't know. Its values are 1 / 0 / blank, so CSV, Excel, SPSS, Stata and SAS carry it, and so do the analytics dataset (a categorical variable), crosstabs and AI insights. `VAR` stays a clean text or number column.

**Respondent page:** one central control under every eligible question, whatever its variant. Behaviour:

- ticking it clears the box;
- typing unticks it;
- the box stays usable, because typing is how a respondent changes their mind.

**Localization:**

- default label: the interface string `ui:dont_know`;
- a custom label: translatable as `q:<id>:dk`;
- the conflict message: `ui:dont_know_conflict`.

### Supporting changes

- `capabilityRegistry.settableSettings(variant, baseType)` takes the base type, so "I don't know" is settable on any open-text or numeric question, including one with no variant.
- The planner's hypotheses step now records a reading whose type and direction were only parsed. It used to treat a reading as done only when nothing at all had been recorded.

## 3. Tests

| What | Result |
|---|---|
| `packages/engine` unit tests | 2,652/2,652. New: `dontKnow.test.ts` 6, `researchLinks.test.ts` 8, `otherSpecifyLabels.test.ts` 4. Changed: `hypotheses.test.ts` (a new side is created; a near-miss is refused) and `researchPlanner.test.ts` (the framework exists as soon as the hypotheses are recorded) |
| `packages/import` unit tests | 91/91 (new: `dkImport.test.ts`) |
| `packages/exporters` unit tests | 146/146 (2 skipped: pyreadstat not installed) |
| `packages/analytics` unit tests | 738/738 |
| Studio lib tests | 1,143/1,143. `mergeDoc.test.ts` changed: a merged hypothesis also creates its dependent construct |
| Browser: `scripts/dont-know-specify-test.mjs` (runtime preview, the Runner used by test and live links) | 50/50, desktop 1100×1000 and phone 390×844 (touch): Other on single and multi, select / deselect / reselect, empty box refused, text stored against question and option; "I don't know" on text and numeric, both orders, mutual exclusivity, required, min / max / integer, completion |
| Browser: `scripts/research-links-studio-test.mjs` (Studio sandbox) | 5/5: "+ hypothesis" links both ways; groups and codes; review link / regenerate without duplicates; the "I don't know" setting and label; "Please specify" typed as an option gets its box |
| `scripts/import-lifecycle-test.mjs` | 108/108 |
| QSF fidelity | No drift |
| Typecheck (Studio), auth guard (266, 0 problems), dependency boundaries (0), public docs | Clean / current |

### Not verified

- **`scripts/phase1-reliability-test.mjs`** (the older research-editor and copilot suite): it did not complete. The Studio dev server restarted for memory twice during it. Its research-editor part overlaps `research-links-studio-test` A–C, which passed.
- **Persistence after a reload against a database.** The sandbox has none. A link is saved in the same definition edit as the hypothesis; nothing is deferred.
- **A real live link.** The runtime preview runs the same Runner and engine; the server path is covered by the unit test of `checkSubmission`.
- Safari and Firefox.
- Intelligent mode with a real model. Only the deterministic sentences and the actions were run; the guides tell the model, but no model reply was observed.

## 4. Limitations

- Linking reads words and the engine's word families; it does not ask a model. What it cannot be sure of is listed for review, never linked.
- In the editor, the automatic pass runs on "+ hypothesis" and on the link buttons. Editing a statement or a reading field does not re-link on every keystroke. Intelligent mode's `set_hypothesis` re-links automatically.
- A plain "Other" option is not given a box automatically.
- Saved surveys are not changed automatically. Review lists unflagged "specify" options.
- Conditions cannot yet test "Q5 is don't know". `Q5 answered` is false for it, and so is the section-navigation map's "answered".
- The analytics question tables do not fold the `_DK` count into the question's own table. It is its own variable.
- No Qualtrics (QSF) pattern is mapped to "I don't know".
