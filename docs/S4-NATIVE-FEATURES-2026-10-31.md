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

---

# S4b — Native features, part B: timers and behaviour conditions (2026-11-01)

Branch `feat/persistent-execution-engine`, from `6183cee`. Audit: `SCRIPT-STUDIO-AUDIT-2026-10-30.md` §4 D15 and rows GA-05, IM-19, LO-07, TE-06, TE-11.

- No new npm dependencies. No migrations.
- Schema changes are optional fields only (`question.timer`, flow `page.timer`, condition source kind `behavior`).

## 1. GA-05 / IM-19 — native timers on any question and any page

**Schema** (`packages/schema/src/timer.ts`): `timer { limitSeconds?, show: countdown | hidden, onTimeout: advance | lock | message, warnAtSeconds?, minSeconds?, message? }` on a question and on a flow page node. A timer needs a limit or a minimum (else it does nothing and the lint says so).

**One clock per page, kept by the Runner** (`apps/runtime/lib/timerClock.ts` `PageClock`; the pure half in `packages/engine/src/timers.ts`):
- every timer on a page (the page's own and each shown question's) counts from the page's arrival on the same clock — never one clock per renderer;
- **decision: it keeps counting while the tab is hidden** (wall clock, the research norm for timed tasks); a hidden tab gets no ticks, the next tick sees the real time;
- a reload restarts the page's clock (honest limit, below);
- the Runner ticks every 500 ms only when the page has a timer or the survey has a time behaviour condition.

| onTimeout | what happens |
|---|---|
| `advance` | the normal Next path (`handleNextInner`). **Defined for an invalid page:** questions *not yet answered* are skipped (their errors dropped, `timed_out` recorded); an *answered* question that fails its rules **still stops the page** — the error is shown and focused (D19); once fixed, Next goes through (the unanswered ones are still skipped). Soft warnings are not shown at timeout. An invalid value is never stored because time ran out. |
| `lock` | the question (or, for a page timer, every question on the page) is wrapped in a `<fieldset disabled>` — every control inside is disabled natively; Next works as usual |
| `message` | the timer's `message` (else the localized default) is shown as a status note |

**minSeconds**: Next is `disabled` until the page has been open that long, with `aria-describedby` to a note: the ticking "You can continue in N s." is `aria-hidden`; the sentence "Next becomes available after N seconds on this page." is for screen readers; "You can continue now." is announced once.

**Accessibility**: the visible clock is `role=timer` with `aria-live=off` (not read every second). One polite `role=status` region says the warning ("N seconds left.", once per timer at `warnAtSeconds`), "Time is up." and "You can continue now." The warning state is a colour change plus a 3-cycle pulse that `prefers-reduced-motion: reduce` turns off.

**Paradata** (in the response and every export — embedded data, no new column): `TIMER_<REF>_ELAPSED` (seconds on the page when it was left by Next, one decimal) and `TIMER_<REF>_TIMED_OUT` (0 | 1, written the moment the timer runs out). `<REF>` is the question code or the page node id, upper-cased, with the loop iteration appended (`p1@apple` → `TIMER_P1_APPLE`). A fresh visit to the page resets `_TIMED_OUT` to 0 — the paradata describe the last visit.

**Server replay** (`serverValidation.ts`): a page whose advance timer posted `TIMER_<REF>_TIMED_OUT = 1` is not refused for missing answers (soft `timed_out` per question); an invalid answer is still a hard `invalid_answer`; a *lock* timer never excuses a missing answer. The timeout itself is client-asserted (the server cannot see the clock) — the soft line lets an analyst see it.

**`gamified.timed` — left as it is** (its own renderer clock and `__rt`): it is the reaction-time single choice. A `timer` on the same question runs on the page clock beside it; `lintTimers` warns that two clocks run.

**Studio**: Properties → **Timer** (`question-timer-*`); Survey Flow → a block → each page's **Timer** (`page-timer-<page id>-*`); the flow page node editor too (`page-timer-*`). The engine lint is shown as chips.

**IM**: `set_timer {target, scope question | page, page, limitSeconds, show, onTimeout, warnAtSeconds, minSeconds, message, clear}` (`engine/timerActions.ts`, in the Options and design vocabulary, public docs "Timers (set_timer)"). Recognisers without a model: "give respondents 30 seconds on this page", "allow 2 minutes on this page and lock the answers", "at least 10 seconds before Next", "keep Next disabled for 5 seconds on the page of Q1"; "add a 30-second countdown to Q4" on a non-single-choice question is now `set_timer` (it was a script). Registry: `timers` → `set_timer`, the `press_next` and `long_timer` routes name the native timer; UX guide line updated (no growth of the system prompt).

## 2. LO-07 — behaviour conditions

A condition source `{ kind: "behavior", ref, scope? }`:

| ref | value | live in the browser | server replay |
|---|---|---|---|
| `time_on_page` | seconds on the current page (the page clock) | re-evaluated every tick | client-asserted: unknown, soft `client_asserted` |
| `elapsed` | seconds since the interview started | re-evaluated every tick | client-asserted |
| `device` | `mobile` / `tablet` / `desktop` (`detectDevice`; in the preview the device switch when it is not the default) | yes | replayed from the stored device class (the save's telemetry device type); none stored → client-asserted |
| `timed_out` | a timer ran out; `scope` names one (`timed_out.Q5`, `timed_out.p1`), absent = any so far | yes | replayed from the posted `TIMER_*_TIMED_OUT` |

- **Where**: every caller of `evaluateCondition` — display, skip, branch, validation `when`, punch `when`, UX `when`, option logic, quotas — because the value is read from `state.meta.behavior` (set by the Runner before the page's questions are decided; `meta` is never posted).
- **Replay rule**: a question decided by a behaviour value the server cannot know is never refused for a missing answer (soft `client_asserted`), and the survey-level note says which values are client-asserted.
- **Text grammar**: `time_on_page > 20`, `elapsed >= 600`, `device = mobile`, `device in [mobile, tablet]`, `timed_out`, `timed_out.Q5`; `behavior.device` when a question owns the bare word. Round-trips through `formatCondition`.
- **Studio**: every condition builder lists **Respondent behaviour** (time on this page, time since the start, device with a mobile/tablet/desktop picker, a timer has run out). Operators follow the type (seconds numeric, timed out yes/no, device a word).
- **IM**: registry feature `behaviour_conditions`; the UX guide line names the grammar.

## 3. D15 / TE-11 — `SYSTEM_*` only where computed

- `ConditionEditor` takes `systemVariables` (a context): the "Quality scores (SYSTEM_*)" group is offered **only** in Quality → Custom rules (`QualitySettings`). Everywhere else a stored `SYSTEM_*` rule is shown under "Other" (readable, kept on re-save).
- **Lint** (`engine/behaviorLint.ts`, registered in the survey logic check): a display / skip / quota / UX / punch / flow / calculation / named-expression condition that reads `SYSTEM_*` is a review warning naming it, with the behaviour condition that fits — speeder / duration → `time_on_page` or `elapsed`; device / browser / OS → `device`; out-of-focus / tab switch → `time_on_page`; otherwise "move it to Quality → Custom rules". Custom quality rules themselves are not flagged. The same lint flags an unknown behaviour ref and a device value that is not a device class.

## Verification (S4b)

Units:

| suite | command | result |
|---|---|---|
| engine | `cd packages/engine && pnpm -s build && node --test dist/*.test.js` | 2550/2550 (new `s4bTimers.test` 9; `ownerIntents.test` and `gateAccuracy.test` updated: a countdown on a non-single question and the press-Next route now name `set_timer`) |
| schema | `node --test dist/*.test.js` | 18/18 |
| templates | `node --test dist/*.test.js` | 111/111 |
| quality | `node --test dist/*.test.js` | 61/61 |
| renderer | `node --experimental-strip-types --test packages/renderer/test/*.test.ts` | 11/11 |
| runtime lib | `node --experimental-strip-types --test 'lib/*.test.ts'` | 72/72 (new `timerClock.test` 7) |
| studio lib | `node --experimental-strip-types --test 'lib/**/*.test.ts'` | 1132/1132 |

Typechecks and checks: `npx tsc --noEmit -p .` runtime, renderer, studio — 0 errors each; `gen-public-docs.mjs --check` current; `dependency-boundaries.mjs` 0 violations (2071 files); `auth-guard-audit.mjs` 0 problems (259 handlers).

Browser (`flock -o /tmp/p0/heavy.lock /tmp/p0/fresh.sh <suite>`, Studio from `studio-sup-4600.sh`):

| suite | result |
|---|---|
| `scripts/s4b-timers-conditions-test.mjs` (new) | 10 passed: A timers 5 (advance with an unanswered required question + paradata; invalid at timeout stays with focus, then goes through; lock / message / timed_out note; minSeconds; warning once + reduced motion), B behaviour 2 (message after 5 s; mobile-only at a phone viewport, not on desktop), C Studio 3. The first full run passed A and B and failed C at `page.goto` — the Studio next-server was OOM-killed (dmesg uptime 3146); section C then passed alone and the full suite passed on the next run |
| `s4a-respondent-test.mjs` | 24 passed |
| `section-nav-test.mjs` | 20 passed |
| `validation-kinds-test.mjs` | all passed |
| `quality-test.mjs` | all passed (the custom rule still shows its SYSTEM_* source) |
| `logic-builder-test.mjs` (the condition-builder suite) | all passed |
| `variants-g6-test.mjs` | all passed |

## Honest limits (S4b)

- **The clock restarts on a reload** (a fresh page visit); the time already spent is not carried across a reload, and `TIMER_*_TIMED_OUT` is reset to 0 on each fresh visit (the paradata describe the last visit). `_ELAPSED` is written when the page is left by Next — not by Back or a section jump.
- **Timeouts are client-asserted.** The server sees `TIMER_<REF>_TIMED_OUT = 1` and believes it for missing answers on an advance page (soft `timed_out` lines show it); it cannot verify the clock. `time_on_page` / `elapsed` likewise.
- Advance-on-timeout in **conversational mode** presses the conversational Next path of the page as a whole; it was not browser-tested there. A follow-up probe pauses the clock's actions (no auto-advance while a probe is on screen).
- A **question** timer's `advance` advances the whole page (one clock per page).
- `device` in the preview: the device switch wins when it is not "desktop"; otherwise the detected class (user agent).
- The new respondent strings ("Time left", "N seconds left.", "Time is up.", "You can continue now.", the minimum-wait sentence) use `uiText` with English fallbacks — they are **not yet in the translation catalogue**.
- `gamified.timed` is unchanged (its own clock); it is not mapped onto the page clock.
- The flow page node editor and the Survey Flow block card both edit `page.timer`; a page created implicitly inside a block by page breaks is a page node too and is covered.

---

# S4c — Native features, part C: randomization and lists (2026-11-01)

Audit rows RA-05, RA-06, RA-07, RA-08, RK-04, PU-13, SM-10 and D21 (`SCRIPT-STUDIO-AUDIT-2026-10-30.md`). Every new
setting is optional: a survey written before this compiles, draws and exports exactly as before, with one deliberate
exception — every randomizer now stores the order it showed (`ORDER_<ID>`, item 3).

## 1. RA-05 — weighted randomizer

- **Schema** `randomizer.weights: { <child id>: weight > 0 }` (absent = 1).
- **Seeded** (no exact balance): `show` N of M draws N children WITHOUT replacement in proportion to the weights —
  Efraimidis–Spirakis (`weightedSample`, the N largest u^(1/w) from the respondent's seed) — then a seeded order. Equal
  weights take the old path unchanged (`randomizerWeights` returns null). With weights, `rotation` / even presentation
  is not used for the window (a rotation cannot honour weights).
- **Exact balance**: the least-filled claim becomes weighted — the arm furthest below its target share
  (weight / total) goes first, ordered by Sainte-Laguë's (count + ½) / weight, ties in the deterministic order.
  `pickLeastFilled` (the sandbox and preview store) and the SQL use the same rule; equal weights = the old rule.
  10,000 simulated respondents at 2:1:1 → exactly 5,000 / 2,500 / 2,500, every prefix within one claim of target.
- **Migration `0079_weighted_balance.sql`**: `rescript_claim_balance` gains `p_weights numeric[] default null`. The old
  8-argument signature is dropped first (two overloads would make a named 8-argument call ambiguous) — one function
  serves old and new callers. The route sends `p_weights` only when weights differ, so an unweighted claim works on a
  database without 0079; a weighted claim there fails over to the seed-derived window and logs `needsMigration: 0079`.
  Re-runnable (applied twice on scratch Postgres). SQL test `scripts/weighted-balance-sql-test.sql` (8 checks);
  `exact-balance-sql-test.sql` B13 now names the 9-argument signature (19 checks).

## 2. RA-06 — Latin square and Williams designs

- **Schema** `randomizer.order: "random" | "rotation" | "latin_square" | "williams"`. Absent = `rotation` when
  `evenPresentation` (old surveys), else `random`.
- `latin_square`: the cyclic square, row r = (r, r+1, …) mod n — every child in every position once per n rows.
  `williams`: first row 0, 1, n−1, 2, n−2, …, row r adds r — every child in every position AND every ordered pair
  adjacent equally often (first-order carryover balanced); odd n uses 2n rows (the rows and their mirrors). Proven in
  `s4cRandomization.test` for n = 2…10.
- The respondent gets one ROW: claimed exactly (least-filled over rows; slot `latin:<id>`, stored in
  `RANDOMIZER_<ID>_ROW`) when `balance.exact` is on, else from the seed. `show` N keeps the row's first N (still
  position-balanced). Rows index the authored children; a child hidden for this respondent is dropped from the row
  (the design is exact only when all are eligible). Weights do not apply to a design.

## 3. RK-04 / RA-07 / SM-10 — the order each respondent saw, stored

- `ORDER_<RANDOMIZER ID>[_<loop codes>]` = the children's ids in the order shown — **default ON for every randomizer**
  (`recordOrder: false` turns it off). A sequential monadic test therefore records its concept order with no embedded
  variable; the `sequential_monadic` capability note says so.
- `<VAR>_ORDER` / `<VAR>_ROW_ORDER` / `<VAR>_COL_ORDER` = option / row / column codes as displayed — **opt-in per
  question** (`settings.recordOrder`; Studio Randomization → "store the order shown"; IM `set_option_randomization
  "recordOrder": true`) so the exports of surveys already in the field do not gain columns. Recorded for the
  randomized axes (options when nothing is randomized).
- Written by the Runner each time a page is shown (`recordDisplayOrders`): the stored value is the order of the page
  as last shown. The **server replay** calls the same function at every page it walks, so the posted order is derived
  identically, and a forged one is a soft `server_mismatch` with the server's value stored (D7).
- The variable dictionary declares `ORDER_*`, `RANDOMIZER_<ID>_ROW` (exact designs), `<VAR>_ORDER…` and `<VAR>_ARM`
  for elements outside loops, with labels, so CSV, SPSS (variable labels), Stata, SAS and the Excel matrix carry them.

## 4. RA-08 — experiment arms with exact balance

- `settings.armBalance` (the shared `ExactBalance`) on an `experiment` question. The arm is a balance slot
  (`arm:<qid>`) on the experiment's page, so the Runner claims it BEFORE the page is shown — the same
  `/api/session/balance` claim, weighted by the arms' weights (0079), a weight of 0 parks an arm — stores it in
  `<VAR>_ARM`, and writes it as the answer at page entry (`applyClaimedArms`). The renderer only shows the claimed arm
  and never draws one when `armBalance.exact` is on. A client-written `_ARM` is cleared and re-claimed by the server.
  Without `armBalance` nothing changes (the renderer's seeded draw; `seededExperimentArm` reproduces it exactly and is
  the claim's fallback).
- Studio: "Exact balance" in the experiment arms editor. IM: `update_question "settings":{"armBalance":{"exact":true}}`
  (coercion admits one shallow record only for this key).

## 5. D21 / PU-13 — List Fill `method: "custom"`

- `selection.scriptId` names a Scripts-panel **logic script** (id or name); `selection.customList` the calculated list
  it writes (default `LISTFILL_<NAME>_CUSTOM`). The Runner runs the script in the logic sandbox (S1, `runLogicEvent`
  with its id) just before the List Fill decides; the script writes `setCalc("LISTFILL_BRANDS_CUSTOM", ["D", "B"])`
  (an array, "D,B" or JSON).
- The engine keeps the script's order, **drops and logs** codes that are not this respondent's candidates or were
  rejected (ineligible, quota full, at maximum), applies quotas and position-sensitive limits after it, and never tops
  the script's selection up from the fill-to-count fallback.
- Only when the script wrote **nothing** does priority + quota decide — with `trace.note` (preview / test traces, the
  Studio simulator) and the soft response variable `LISTFILL_<NAME>_CUSTOM_FALLBACK = 1` (0 when the script decided).
- Studio List Fill panel: script picker, list name, a warning when the script is missing or off. IM: `create_list_fill`
  / `update_list_fill` `"method":"custom","script":"<name>"` (refused when the script does not exist); List Fill guide
  line; registry feature `list_fill_custom`. `source.kind: "script"` is unchanged (still reads `calculated[scriptId]`).

## IM, registry and docs (S4c)

New action `set_randomizer {randomizer, show, weights, order, exact, recordOrder, title}`; `create_randomizer` takes
`weights`, `order`, `exact`. UX guide line (randomizer designs, recordOrder, armBalance); List Fill guide line
(custom); capability registry: randomizer summary, `experimental` family setting `armBalance`, feature
`list_fill_custom`; `sequential_monadic` capability. Public docs regenerated (actions-reference, capabilities).

## Verification (S4c)

| package | command | result |
|---|---|---|
| engine | `cd packages/engine && pnpm -s build && node --test dist/*.test.js` | 2584/2584 (new s4cRandomization 16, s4cDisplayOrder 8, s4cExperimentArm 5, s4cListFillCustom 5) |
| schema / designs / analytics / quality | `node --test dist/*.test.js` | 18/18, 124/124, 396/396, 61/61 |
| templates | `node --test dist/*.test.js` | 111/111 (serverCheck "honest completion of master-demo" first failed on a soft ORDER_* mismatch — fixed: an order the client did not post is filled in by the replay without a mismatch line) |
| renderer | `node --experimental-strip-types --test packages/renderer/test/*.test.ts` | 11/11 |
| studio lib | `node --experimental-strip-types --test 'lib/**/*.test.ts'` | 1132/1132 |
| runtime lib | `node --experimental-strip-types --test 'lib/*.test.ts'` | 75/75 (balanceClaim +3: weighted 300/100, Williams row, experiment arm 30/10 + forged `_ARM`) |
| exporters | `node --test dist/*.test.js` | 141/141 (new s4cDisplayOrderExport 2) |
| studio copilot | `node --experimental-strip-types --test lib/copilot/*.test.ts` | 427/427 |
| SQL | `0079` applied twice; `weighted-balance-sql-test.sql`; `exact-balance-sql-test.sql` | 8/8; 19/19 |

Typechecks: studio, runtime, renderer `npx tsc --noEmit -p .` — 0 errors. `gen-public-docs.mjs --check` current;
`dependency-boundaries.mjs` 0 violations (2078 files); `auth-guard-audit.mjs` 0 problems (259 handlers).

Browser (`flock -o /tmp/p0/heavy.lock /tmp/p0/fresh.sh <suite>`, Studio from `studio-sup-4600.sh`):

| suite | result |
|---|---|
| `scripts/s4c-randomization-test.mjs` (new) | 9 passed: A sandbox claim 2 (weighted 3:1 → 150/50 under 200 parallel claims; Williams row 3/3/3/3), B preview 2 (Q0_ORDER = DOM order; 6 runs → each Williams row once, pages in row order, ORDER_R1), C experiment 1 (4 runs → 2/2, arm = answer = EXP_ARM), D List Fill custom 2 (script list decides, foreign code dropped; empty → priority + fallback flag), E Studio 2. The first full run passed A–D (7) and lost E to an OOM kill of the Studio next-server; E then passed alone (`SECTIONS=E`, `--no-runtime`) |
| `engine-15-19-test.mjs` `SECTIONS=15` | all 9 passed |
| `listfill-test.mjs` / `listfill-least-test.mjs` | 23 / 9 passed |
| `listfill-intelligent-test.mjs` / `variants-g6-test.mjs` / `logic-scripts-sandbox-test.mjs` / `methods-intelligent-test.mjs` | 9 passed / all G6 checks passed / 10 checks passed / 14 passed |
| `listfill-allocation-test.mjs` | NOT RUN — needs the `pg` module (not installed in this workspace) |

## Honest limits (S4c)

- Weighted + `show` N > 1: weights are relative selection weights; an arm cannot be shown more than once per
  respondent, so a very heavy child saturates at "every respondent" (the exact claim then spreads the rest evenly).
- A design (Latin / Williams) is exact only when every child is eligible; a hidden child is dropped from the row.
  Designs ignore weights.
- `ORDER_*` / `<VAR>_ORDER` / `<VAR>_ARM` inside **loops** carry the iteration codes in their names and are exported
  from the response like any calculated value, but are **not declared** in the variable dictionary (no fixed columns,
  no labels).
- Stored order = the order of the page as last shown (Back + a changed answer can change it, as it changes what is
  shown). A save that posts no `ORDER_*` (an old cached client) gets the replay's value stored with no mismatch line;
  a posted order that differs is a soft `server_mismatch`.
- The custom List Fill script is client-run (sandbox); the server re-checks its codes against eligibility, quotas and
  caps but cannot verify that the script produced them (as for every script write).
- The trace `note` travels to the browser in test and preview only; in live the soft note is the response variable.

---

# S4 complete — summary (2026-11-01)

| part | items | audit rows |
|---|---|---|
| A — what the respondent sees | focus the first error; progress bottom / steps; visible option groups + cascading dropdown; one answer key | D19 / VA-06, D20 / AQ-11, AQ-08, D14 / GA-03 |
| B — timers and behaviour | native question / page timers; behaviour conditions; `SYSTEM_*` only where computed | GA-05 / IM-19, LO-07, D15 / TE-11 |
| C — randomization and lists | weighted randomizer (+ migration 0079); Latin square / Williams; stored display order; exact experiment arms; List Fill custom script | RA-05, RA-06, RK-04 / RA-07 / SM-10, RA-08, D21 / PU-13 |

Every S4 feature is optional in the schema, editable in the Studio, reachable from Intelligent Mode (actions or
settings checked by the engine gate), described in the capability registry and the public docs, and covered by unit
and browser tests. The one behaviour that changes for existing surveys: randomizers now store `ORDER_<ID>` (a new
export column). The one migration: `0079_weighted_balance.sql` (re-runnable; unweighted claims keep working
without it). Not done in S4: the jQuery-in-frame / approved-library mechanism from the audit's P1 list.
