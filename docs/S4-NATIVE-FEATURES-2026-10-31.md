# S4a — Native features, part A: what the respondent sees (2026-10-31)

Branch `feat/persistent-execution-engine`, from `643a2dc`. Audit: `SCRIPT-STUDIO-AUDIT-2026-10-30.md` §4 D14, D19, D20 and rows VA-06, AQ-08, AQ-11, GA-01, GA-03. Auditor notes: S2 §1.6 (validation focus), S4 §2 A (AQ-08, AQ-11) and §2 L (GA-03).

- No new npm dependencies.
- Schema changes are optional fields only (backward compatible).
- No migrations.

## What changed

### 1. D19 / VA-06 — focus the first error

**When it happens.** Any refused Next or Submit now moves focus and scrolls (`block: center`) to the first invalid question's first focusable control. This covers:
- built-in rules;
- a soft warning on its first Next;
- `custom_script` rules;
- a logic script's `error()`;
- sandboxed `rs.error`;
- conversational mode;
- a follow-up probe;
- the Submit gate's "go".

**How "first" is chosen** (`apps/runtime/lib/errorFocus.ts`):
- `firstInvalidTarget` counts blocking errors first. It uses warnings only when they alone refused the page.
- Errors are ranked in **page order** (the questions as drawn), not in the order the errors were produced.
- An error that names no question on the page focuses the banner. A question error wins over a page-level message.

**How focus moves** (`focusErrorTarget`):
- It finds the first visible `input`, `select`, `textarea`, `button`, link or `[tabindex]` in the card. If there is none, the card itself gets `tabindex=-1`.
- Scrolling uses `behavior: "auto"` under `prefers-reduced-motion: reduce`, and `"smooth"` otherwise.
- Focus is set with `preventScroll`.

**What stays the same.**
- The banner stays (`role=status`). It is now focusable (`tabIndex=-1`, `data-testid="rs-error-banner"`).
- The per-question `role=alert` stays.

**Submit gate (free section navigation).**
- The gate panel already took focus.
- "Go to History: 1 unanswered" now lands on that page with the reason shown on each listed question ("This question is required.").
- Focus goes to the first listed question.
- The jump can be deferred behind the double-submit latch, so the reasons travel in `gateLandRef` and are applied once the page has landed.

**Accessibility fix in the renderer.** An author's own `settings.accessibility.describedBy` used to *replace* the error id. A described question was then `aria-invalid` with nothing pointing at its message. `describedByWithErrors` now gives both, error id first.

### 2. D20 / AQ-11 — progress "bottom" and "steps"

- `packages/renderer/src/ProgressIndicator.tsx` + `progress.ts`: one component, used by the runtime (`Runner.tsx`) and the Studio Branding preview.
- **bar / percent.** The fill is wrapped in `role=progressbar` with `aria-valuemin`, `aria-valuemax` and `aria-valuenow` from 0 to 100. The formula is unchanged: current / (N + 1).
- **steps.** Shows "Page n of N" (the existing localized `page_of` string). The wrapper is `role=progressbar` with `aria-valuemin=1`, `aria-valuemax=N`, `aria-valuenow=n` and the text as `aria-valuetext`.
  - Dots are drawn one per page, `aria-hidden`, with done and current states.
  - Above 12 pages (`STEP_DOTS_MAX`) only the text is shown.
- **N** is the existing logic-aware count of pages on the compiled path.
- **top** draws the indicator above the page, as before.
- **bottom** draws it after the page body and its Back/Next row, before the footer.
  - **Choice: not sticky.** A sticky bar on a phone covers the Next button and the on-screen keyboard.
- The UX target `progress` / `progress.fill` / `progress.label` now also reaches the steps parts (`:is(...)` selectors in `engine/ux.ts`).

### 3. AQ-08 — visible option groups and the cascading dropdown

#### (a) Option groups

**Schema.** `OptionGroup.label` is the respondent heading. `OptionGroup.display` is `heading | collapsible | none`. The default is none, which is how every survey worked until now.

**Engine.** `optionGroups.groupSegments` cuts the already-ordered shown items into runs by group. Ordering, randomization, the group invariant and visibility are untouched. With no visible group it returns a single flat segment, so the renderer draws exactly what it drew before.

**Renderer** (`OptionGroups.tsx`):
- **heading:** a heading with the members in a `role=group` named by it (`aria-labelledby`).
- **collapsible:** a `<button aria-expanded aria-controls>` (Enter and Space work) that shows or hides the members. It starts closed unless a member is selected. Collapsed members are not rendered.
- **Where groups are drawn:**
  - single choice and multiple choice;
  - the plain dropdown, as `<optgroup>` (a native select cannot collapse, so collapsible reads as a heading there);
  - matrix rows, as a header row `th scope=rowgroup` spanning the grid, with the disclosure button inside it for collapsible.
- The wrappers are `display: contents`, so multi-column option grids keep flowing.

**Studio.** Properties → Option groups → each group has **"Respondents see"** (no heading / a heading / a collapsible group) and **"Heading shown to respondents"**. Column groups are never drawn.

**IM.** A new action, `set_option_groups {target, scope options|rows|columns, groups [{name, label, display, members}] | clear}` (`engine/optionGroupActions.ts`, in the Options and design vocabulary).
- Members are codes or labels. A code that is already in a group stays in the first one.
- Existing group ids are kept by name, so a group's randomization seed survives a re-set.
- It is documented in the UX guide and is allowed in a look-only request (`UX_ACTION_OP`).

#### (b) Cascading dropdown — `single_select.cascading_dropdown`

**Data model** (chosen to fit the schema without a new answer shape):
- The **parent list** is `settings.cascadeParents [{code, label}]`.
- The **child list** is the question's own `options`, each naming its parent in `meta.parent`.
- The prompts are `settings.cascadeParentLabel` and `settings.cascadeChildLabel`.
- **The stored answer is the child code.** Every reader of a single choice (logic, piping, quotas, analytics) works on it unchanged.
- The parent is **derived**:
  - it is written beside the answer as `<answer key>__parent` while the respondent picks;
  - it is re-derived from the definition on export as `VAR_PARENT`, so a tampered side value never reaches the data.

**Validation** (`engine/cascade.ts`, `validateQuestion`). The answer is refused when:
- the child does not exist;
- the child names no listed parent;
- the child does not belong to the `__parent` posted beside it ("That choice does not belong to “India”.").

`lintCascade` flags orphan options, parents with no children and duplicate parent codes.

**Export and dictionary.** `VAR` is the child and `VAR_PARENT` is derived. Both are declared in the variable dictionary. The raw `__parent` key is not exported.

**Renderer** (`variants/cascade.tsx`):
- two labelled native selects;
- the second is disabled until a parent is chosen;
- changing the parent clears a child that no longer belongs;
- the children still go through the normal option pipeline (masks, display logic, carry-forward, sorting).

**Studio** (`variantConfig/cascade.tsx`). In the question editor's Cascading dropdown block:
- the first list, as code/label rows with + and ×;
- the two prompts;
- the engine's lint problems as chips;
- a **"parent"** column on every option.

**IM.** `create_question` with `"type": "single_select.cascading_dropdown"`, settings `{cascadeParents, cascadeParentLabel, cascadeChildLabel}`, and options `[{code, label, parent}]`.
- `OptionSpec.parent` is stored as `meta.parent`.
- `settingsIn` now accepts shallow record lists; the schema field still decides their shape.

#### Registry and docs

Registry entries:
- `capabilityRegistry.ts`: NATIVE_FEATURES `option_groups` → `set_option_groups`, `cascading_dropdown` → `create_question`, and `progress_indicator` → `set_theme`.
- `capabilities.ts`: platform entries for all three.

Public docs regenerated:
- `actions-reference.md` has a new "Option groups (set_option_groups)" section;
- `capabilities.md`;
- `question-types.md`;
- `survey-definition.md` has the progress settings.

### 4. D14 / GA-03 — one answer key

`question.assessment` is the key (`engine/quizKey.ts`):

| function | what it does |
|---|---|
| `quizKey(q)` | returns the assessment key; else the legacy `option.meta.correct`; and says `withheld` when the respondent's copy was stripped |
| `migrateQuizKeys(def)` | moves a quiz's `meta.correct` into `assessment.correct` (an existing assessment key wins). It returns the same object when nothing changes, so it is idempotent, and it never touches a withheld copy. It runs: when the Studio loads a survey (`app/studio/[id]/page.tsx`, beside `migrateRetiredVariants`); in `respondentDefinition` before stripping (live, test link, `/x/`, preview as a respondent); and in `scoreForSubmission` |
| `quizCorrectValue` | the `_CORRECT` export, graded **on the server** (`flatten.ts`) from the stored definition's key. The browser's `__correct` is used only when there is no key. The dictionary declares `_CORRECT` for an assessment-keyed quiz |

**Stripping** (`stripAssessmentSecrets`):

| survey | quiz key in the respondent's copy |
|---|---|
| scored paper, not `per_question` | withheld (plain single choice) |
| scored paper, `per_question` | kept (instant feedback, by design) |
| ordinary survey (not a paper), quiz with feedback on | kept, as the legacy quiz always shipped it |
| ordinary survey, quiz with feedback off | withheld (nothing in the browser needs it) |

**Renderer quiz** (`variants/gamified.tsx`):
- A withheld key → an ordinary `SingleSelect`: no verdict, no `__correct` guess, no hint.
- With no key at all, no "Not quite" is shown against an empty key.
- The author hint "No correct answer is marked yet…" appears **only with `programmerView`** (preview or test, not "as a respondent", never live).

**Studio.** The quiz editor's answer-key ticks (testids `option-meta-correct-<i>` kept) write `question.assessment.correct` and drop any `meta.correct`. The per-option explanation stays in `option.meta.explanation`.

**IM.** `set_answer_key` already wrote `question.assessment`. The quiz now reads it. The assessment guide and the registry line say so ("no second key in option meta").

## Where to find it

| what | where |
|---|---|
| focus on error | any runtime page; Next on an invalid page (keyboard or mouse); free section navigation → Submit → gate → "go" |
| progress | Studio → Branding → Layout "Progress bar" (top / bottom / none; `data-testid=branding-progress-bar`) and Typography "Progress" (bar / percent / steps; `branding-progress-style`); the preview on the same screen (`theme-preview-progress`). IM: "show the progress as page dots at the bottom" → `set_theme` |
| option groups | Studio → Questions → a question → Properties → Option groups → "Respondents see" / "Heading shown to respondents" (`group-display-<id>`, `group-label-<id>`). IM: "put the fruit options under a Fruit heading and make the vegetables collapsible" → `set_option_groups` |
| cascading dropdown | Add question → Single Select → **Cascading Dropdown**; question editor → Cascading dropdown block + "parent" option column. IM: "a cascading dropdown: country, then state" → `create_question` type `single_select.cascading_dropdown` |
| quiz key | quiz question editor → Quiz → Answer key ticks; Properties → Assessment (in an assessment survey); IM `set_answer_key` |

## Verification

Units:

| suite | command | result |
|---|---|---|
| engine | `cd packages/engine && pnpm -s build && node --test dist/*.test.js` | 2541/2541 (new: `s4aOptionGroups.test` 6, `quizKey.test` 5, capabilityRegistry +1) |
| schema | `node --test dist/*.test.js` | 18/18 |
| templates | `node --test dist/*.test.js` | 111/111 |
| access | `node --test dist/*.test.js` | 123/123 |
| renderer | `node --experimental-strip-types --test packages/renderer/test/*.test.ts` | 11/11 (new: `progress.test` 3) |
| runtime lib | `node --experimental-strip-types --test 'lib/*.test.ts'` | 65/65 (new: `errorFocus.test` 8) |
| studio lib | `node --experimental-strip-types --test 'lib/**/*.test.ts'` | 1132/1132 |

Typechecks and checks:
- `npx tsc --noEmit` for runtime, renderer and studio: 0 errors each.
- `node scripts/gen-public-docs.mjs --check`: current.
- `node scripts/dependency-boundaries.mjs`: 0 violations (2063 files).
- `node scripts/auth-guard-audit.mjs`: 0 problems (259 handlers).

Browser (`flock -o /tmp/p0/heavy.lock /tmp/p0/fresh.sh <suite>`, Studio from `studio-sup-4600.sh`):

| suite | result |
|---|---|
| `scripts/s4a-respondent-test.mjs` (new) | 24 passed: A focus 7 (keyboard only), B progress 4, C groups + cascade 5, D quiz key 4, E Studio 4 |
| `section-nav-test.mjs` | 20 passed |
| `matrix-a11y-test.mjs` | 19 passed |
| `validation-kinds-test.mjs` | all passed (6 groups) |
| `variants-g6-test.mjs` | all passed (26 groups; its Studio quiz-key assertions now read `question.assessment`) |
| `theme-voice-test.mjs` | 8 passed |
| `assessment-test.mjs` | 7 passed on the 3rd run. Run 1 failed at §5, after §1–§4 passed (`net::ERR_EMPTY_RESPONSE`: the Studio next-server was OOM-killed, dmesg uptime 3366/3394). Run 2 failed at §4 (`Target page… closed`: Studio OOM-killed at uptime 4030). Both are OOM deaths, not assertions |

No existing suite exercised `progressBar` / `progressStyle` (grep). `theme-voice-test` ran as the Branding-panel regression; s4a B and E cover progress.

## Honest limits

- **Focus.**
  - The gate's "go" in conversational mode lands on the page's first question. The reasons for questions not yet on screen show in the banner, and the banner gets focus.
  - Focus is not moved for a media hold ("watch to continue") or a navigator refusal. Those are not validation.
- **Progress.**
  - Not sticky.
  - N can change as answers change branching (the existing computation).
  - The Studio preview shows a fixed "page 3 of 7".
- **Option groups.**
  - Drawn by the base single, multi, dropdown and matrix renderers only. Buttons, cards, images, swipe and other styled variants still use groups for order and visibility only.
  - Column groups are never drawn.
  - The heading is plain text. HTML is stripped and piping is not resolved.
  - The heading is not yet a translation key.
- **Cascading dropdown.**
  - Two levels only. A third level is a second cascading question with display logic.
  - The prompts and parent labels are not translation keys yet.
  - The server re-validates the child-belongs-to-parent rule through the ordinary validation path. There is no separate server-side recompute of `__parent`; the export re-derives it.
- **Quiz key.**
  - An instant-feedback quiz in a survey that is *not* a scored paper still sends its key to the browser. That is by design, as before (GA-01); turning feedback off withholds it.
  - The per-option explanation stays in `option.meta.explanation`. It is not merged into `assessment.optionExplanations`.
  - `migrateQuizKeys` runs on Studio load and on respondent payloads. The Studio `/sandbox` page does not load through the migrating route, so a quiz there keeps a legacy `meta.correct` until its tick is used. The renderer's fallback covers it.
- Item 4's live check uses the sandbox **test link** (`/n/<token>`, mode test, the same `respondentDefinition` as live). A `/s/` live link needs a database and was not run here.
