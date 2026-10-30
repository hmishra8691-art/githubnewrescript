# S1a — One script engine, part A: an engine-checked write channel and lifecycle events in the sandbox (2026-10-30)

Branch `feat/persistent-execution-engine`, from `a4deb64` (S0b). Audit: `SCRIPT-STUDIO-AUDIT-2026-10-30.md` §2.1, §4
D2 / D3 / D11, §11 step S1.

## The owner's decision

**Decision 1 of the audit = move into the sandbox (not retire).** Scripts-panel logic scripts (`def.scripts`) and
Custom Component code will run in the same sandboxed frame as UX scripts. S1a builds the engine-side channel and the
lifecycle that make that possible; **S1b moves the two code paths onto it**. Nothing in S1a removes the old paths: logic
scripts and component code still run on the respondent's page behind the S0b code gate.

## The rule every write follows

A script never writes state. It sends a **request**; the host decides with the engine — exactly like `rs.goToPage`
(`UxLayer` → `Runner.jumpTo` → engine). An accepted write goes through **the same code path as the respondent's own
input** (`setAnswer` → on_change calculations and "Other" text tidy-up → `recomputePunchesAfterChange`, then in the
Runner `pruneHiddenSelections`, the page's on_change logic scripts and a re-render), so punches, calculations,
validation and the save/replay behave as if the respondent had given the value.

## What changed

### 1. Engine — `applyScriptWrite(def, state, write, ctx)` (`packages/engine/src/scriptWrites.ts`)

Write kinds: `answer` (question by code, variable or id, value, optional loop key), `embedded` (name, value),
`calculated` (name, value), `flag` (name). Returns `{ ok, reason?, target? }`; never throws; a refused write changes
nothing.

**Scope rule** (`ctx.scope` is what the script is attached to — a UX behaviour's target in S1a, a logic script's
scope in S1b; `ctx.shown` is what the respondent is looking at):

| Script attached to | May write |
|---|---|
| any scope | hidden targets: a `hidden` / `embedded_data` / `experiment` question or one set `settings.hidden`; a declared embedded field; a calculated variable of its own |
| any scope (question, page, block, survey) | any question that is **not** on screen at the moment of the write, wherever it is in the survey |
| a question | also **its own question, even on screen** |

*(Relaxed in S1b, 2026-10-30: S1a also limited page / block scripts to their own page / block. That refused a
production page script — beverage/mask demo, `p_brand_depth` in `blk_brand_funnel`, on_submit — setting the
single_select `q_seg` on a later page of another block. The only refusal of the scope rule is now the one below.)*

Never a question the respondent is looking at unless it is the script's own question. **Why:** the respondent is the
author of what they see; a value changing under their eyes, put there by code they cannot see, is a silent overwrite
of their answer. A script attached to that question is the explicit exception — its author wrote it for that question,
and the change happens where the respondent is looking.

Always refused, with the reason: a calculated question with an expression, a hidden question whose punch rule says
`recompute: "always"`, a declared calculation's variable (all three would be overwritten by the engine), engine
variables (`LOOP_…`, `MASK_…`), a name that is a question (`setCalc`) or an embedded field (`setCalc`), an undeclared
embedded field, and the answer shapes only a respondent can give (choice tasks, points on a stimulus, places, uploads,
recorded interviews, display-only items).

**The value must fit the response model** (`effectiveResponseModel`): single choice — a real option code (as defined
or as the option pipeline resolves it; stored as the definition spells it); multiple choice and ranking — an array of
distinct real codes; numeric — a finite number (numeric strings are converted); text — a string ≤ 10,000 characters;
grids (`per_row`) — an object keyed by real row codes (codes, code arrays for `matrix_multi`, numbers for
`matrix_numeric`, text for `matrix_text`); cells — row → real column id → value; fields — row-keyed values (numbers
for `numeric_list`), a repeating group an array of row-keyed entries (≤ 50); allocation — numbers keyed by real option
codes; a hidden variable with a code list — its codes; without one — a scalar or a list of scalars. `null` / `""` / `[]`
clears. Limits (`SCRIPT_WRITE_LIMITS`): 50,000 characters of JSON per value, 500 items, names ≤ 64 characters
(`[A-Za-z_][A-Za-z0-9_.-]*`), 100 script-created variables, 200 flags. Embedded values are coerced to the field's
declared type (`coerceEmbedded`).

**Loops.** Without a loop key the page's iteration is used (a question in an enclosing loop resolves through the
iteration chain); `loopKey` names another (`"apple"`, `"apple@pro"`, `"@apple"`). A question inside a loop written
from outside it without a key is refused ("name the iteration").

**Paradata.** Every accepted write is appended to `state.scriptWrites` — `{ script, kind, target, at }`, **never the
value** — capped at 1,000 records (`scriptWritesDropped` counts what was dropped). Embedded / calculated writes then
run the on_change calculations and the derived punches (`punchDerivedQuestions`).

### 2. Sandbox API

New in the frame (`packages/renderer/src/uxSandbox.ts`): `rs.setAnswer(ref, value, loopKey?)`,
`rs.setEmbedded(name, value)`, `rs.setCalc(name, value)`, `rs.flag(name)` — each posts a request with an id and
returns a **promise of `{ ok, reason }`** that never rejects (a host that does not answer in 5 s resolves it as
refused); `rs.getEmbedded(name)`, `rs.getCalc(name)` (synchronous, from data the host sends with every answer update);
and **`rs.getAnswer` is loop-aware** (audit SE-03): the Runner's `allValues` now use `lookupAnswer(answers, id,
pageLoop)` instead of the bare key, and `rs.getAnswer(code, loopKey)` reads another iteration.

Host (`UxLayer.tsx`): the four write commands go to the new prop `onScriptWrite(write, { id, label, target })`; the
reply is posted back to the frame; an accepted write is logged `rs.setAnswer("H_SEG") — written`, a refusal
`rs.setAnswer("Q2") refused: Q2 is on screen — …` to the inspector and `console.warn` (every mode). Without the prop
(the Studio canvas) every write is refused as "not available here". Rate limit and op caps are the existing ones (200
commands a second, then the frame is stopped).

Runner (`apps/runtime/components/Runner.tsx`): `onScriptWrite` derives the scope from the behaviour's target, calls
`applyScriptWrite` with the page's shown questions, loop, page questions and quota counts, then does what a respondent
`onChange` does next (prune, on_change logic scripts, re-render). The save body carries `scriptWrites`.

Authoring gate (`engine/ux.ts`): the new names are in `UX_SCRIPT_API` (+ `UX_SCRIPT_WRITES`); `rs.setAnswer` is no
longer in the refused "fill" names and its first argument must be a question of the survey. Writing the mirror
(`.value =`, `.checked =`, `dispatchEvent`) **stays refused** with the same message, plus a warning naming
`rs.setAnswer` as the sanctioned path. Intelligent Mode's authoring check (`scriptAuthoringProblems`) refuses
`rs.setAnswer` with a **fixed** value — that is a default value or a punch rule — and keeps accepting a computed one.

Guide and docs: the Intelligent-Mode UX guide (`apps/studio/lib/copilot/prompt.ts`) documents the requests, the
lifecycle events and **"NATIVE FIRST: a starting answer is set_default_value, an answer that follows other answers is a
punch rule, a computed value is a calculation — rs.setAnswer only for what only code can know …"**;
`apps/studio/content/docs/custom-code.md` has a "Writing from a script" section (who may write what, what fits, native
first, an example) and no longer says scripts can never write; `logic-reference.md` regenerated.

**Corpus (`scriptChecks.test`, 491 scripts) — the intended changes only, snapshot updated for them:** 13 runtime
verdicts change only by the longer api list inside the existing "rs.X is not part of the survey api (…)" message
(still refused); 3 only by the longer event list inside "rs.listen("…") — the events are …" (still refused); 2 scripts
from `defaultValue.test.ts` (`rs.setAnswer("Q2", 19)` on page open) now pass the runtime gate and are refused at
authoring instead ("scripts cannot fill in a fixed answer … set its default value"). No other verdict changed.

### 3. Lifecycle events — `validate` and `submit`

`rs.listen("validate", fn)` and `rs.listen("submit", fn)` (added to `UX_SCRIPT_EVENTS`). In a validate handler
`rs.error(message, ref?)` raises an error, synchronously or later inside a promise the handler returns. (`complete`
already existed and is unchanged: it is **page-complete** — every question on the page answered — not survey
completion.)

On **Next**, after built-in validation and the logic scripts' `on_validate` pass, the Runner calls
`runScriptLifecycle` (`apps/runtime/lib/scriptLifecycle.ts`), which asks every frame of the page that registered
`validate` (via the UxLayer's `lifecycleRef`) and waits for all replies with a **hard 1,500 ms bound** — per frame in
the UxLayer, and for the whole round in the helper. A frame that does not answer in time is "no error" and logged
(`[ux script “…”] validate: no answer within 1500 ms — treated as no error`); the respondent is never held. Errors are
shown exactly like built-in validation errors: on the question when `ref` names one on the page (id, code or
variable), otherwise as a page message under the error banner (`data-testid="rs-page-error"` — which now also shows a
logic script's `error()` without a question, previously invisible). Up to 20 errors per page. Then, after the
warning acknowledgement and the submit gate, the `submit` handlers run (bounded the same way; their writes go through
item 1; `rs.error` there is ignored and logged) before the page is left. **Back and jumps run neither.**

### 4. Server replay

The replay still never runs scripts (S0a). Script-made values arrive as posted answers and are validated like any
answer. `checkSubmission` now reads `posted.scriptWrites`: a derived value the recompute (S0b D7) cannot match, or an
answer the replay never showed (`not_asked`), whose key a script wrote is reported as **`script_written`** (soft,
informational, summarised — never an open end's text), and under `RUNTIME_SERVER_RECOMPUTE=store` the posted value is
kept. A claim is believed only for targets the channel could ever write (`scriptMayWriteAnswer` /
`scriptMayWriteVariable`): forged paradata on a calculated question, a punch-owned hidden variable, a declared
calculation or an engine variable stays a `server_mismatch` and the server's value still wins.

The save route sanitises the posted list (`sanitizeScriptWrites`), passes it to the replay and stores it — sandbox
store: `script_writes` on the row (shown by the sandbox `row` action with the values of those targets); database:
inside the `telemetry` jsonb as `scriptWrites` when the survey keeps telemetry (no migration in S1a).

## Where to find it

| Item | Code | Tests |
|---|---|---|
| 1 | `packages/engine/src/scriptWrites.ts`, `state.ts` (`scriptWrites`) | `packages/engine/src/scriptWrites.test.ts` (6) |
| 2 | `packages/renderer/src/uxSandbox.ts`, `UxLayer.tsx` (`onScriptWrite`), `apps/runtime/components/Runner.tsx`, `packages/engine/src/ux.ts`, `uxScriptGuard.ts`, `apps/studio/lib/copilot/prompt.ts`, `apps/studio/content/docs/custom-code.md` | `defaultValue.test.ts` (updated), `scriptChecks.test.ts` (corpus), `apps/studio/lib/copilot/copilot.test.ts` (updated) |
| 3 | `uxSandbox.ts` (lifecycle), `UxLayer.tsx` (`lifecycleRef`), `apps/runtime/lib/scriptLifecycle.ts`, `Runner.tsx` (`handleNextInner`) | `apps/runtime/lib/scriptLifecycle.test.ts` (4); browser B/C |
| 4 | `packages/engine/src/serverValidation.ts`, `apps/runtime/app/api/session/save/route.ts`, `lib/sessionSandbox.ts`, `app/api/session/sandbox/route.ts` | `scriptWrites.test.ts` (replay test) |
| 5 | — | `scripts/script-writes-test.mjs` (10 checks) |

What people see: **respondents** — nothing new for existing surveys; a script's validate message looks like any
validation message. **Authors** — the preview inspector and the browser console show `rs.setAnswer("…") — written` /
`refused: <reason>` and lifecycle timeouts. **Operators** — `script_written` entries in the submission-check log line.
No new environment variable.

## Verification

| Check | Result |
|---|---|
| Engine units: `cd packages/engine && pnpm -s build && node --test dist/*.test.js` | **2446/2446** (6 new in `scriptWrites.test.ts`; `defaultValue.test.ts` and the corpus snapshot updated as above) |
| Schema units: `cd packages/schema && node --test dist/*.test.js` | 18/18 |
| Renderer units: `node --experimental-strip-types --no-warnings --test packages/renderer/test/*.test.ts` | 8/8 |
| Runtime lib: `cd apps/runtime && node --experimental-strip-types --no-warnings --test 'lib/*.test.ts'` | **48/48** (4 new: `scriptLifecycle.test.ts`) |
| Studio lib: `cd apps/studio && node --experimental-strip-types --no-warnings --test 'lib/**/*.test.ts'` | 1046/1046 (`copilot.test.ts` assertion updated for the guide) |
| Templates (targeted): `cd packages/templates && node --test dist/serverCheck.test.js dist/scriptGate.test.js` | 7/7 (zero `server_mismatch` still) |
| `scriptChecks.test` (491-script corpus) | passes with the 18 intended verdict updates listed in §2 |
| `tsc --noEmit` studio / runtime / renderer | 0 / 0 / 0 errors |
| `node scripts/gen-public-docs.mjs --check` (after regenerating `logic-reference.md`) | current |
| `node scripts/dependency-boundaries.mjs` | 0 violations (1981 files) |
| `node scripts/auth-guard-audit.mjs` | 0 problems (256 handlers) |
| Browser `script-writes-test.mjs` (new, via `/tmp/p0/fresh.sh`) | **10/10** — A: hidden H_SEG punched by a question script (state, promise `{ ok: true }`), Q2 (on screen, not the script's) and Q1 = 9 (no such option) refused with the reason in the console, paradata of 3 writes without values, setEmbedded/setCalc read by the next page's display logic; B: Back does not run validate, validate stops Next with the message on Q3, with Blue Next goes on and the submit handler's write landed; C: a never-settling validate released after 1,853 ms, logged; D: `rs.getAnswer("QL")` / `rs.getAnswer("QL", "a")` in iteration Google; E: test link — the saved sandbox row holds `h_seg = "N"`, `SOURCE = panel` and the paradata |
| Browser `ux-script-dom-test.mjs` | **16/16** on a re-run alone. The first run (in a batch of five) failed in its Studio half: the first Intelligent-Mode turn was not seen finishing within the suite's 40 s wait (no out-of-memory line in `studio-dev.log`; the Studio had just been restarted cold by `fresh.sh`) |
| Browser `style-script-p0-test.mjs` | 11/11 |
| Browser `age-script-p0-test.mjs` | 10/10 |
| Browser `hidden-autopunch-test.mjs` | 9/9 |
| Browser `section-nav-test.mjs` | 20/20 |

No out-of-memory death was recorded in these runs (the "Killed" lines in `fresh.sh`'s output are `fresh.sh` restarting
the runtime between suites).

**Not run:** the full templates and import package suites (only the two template files above); the other browser
suites that carry scripts (`ux-copilot`, `runtime-csp`, `wave1`, `master-demo`, `assessment`, `validation-kinds`,
`ux-heartbeat`, `stage-cap-api`, `engine-11-14`, `conjoint-p2`, `production-intents`, `demo-survey`,
`loading-deadlock`, `listfill-intelligent`, `matrix-a11y`, `maxdiff-p1`, `popup-p3`); the database save path (no
Supabase here — `telemetry.scriptWrites` storage is type-checked, not exercised); SQL (no migration); Safari/Firefox;
the lifecycle in conversational mode (not implemented, see limits).

## Honest limits

- **Old paths unchanged.** `def.scripts` and Custom Component code still run on the page (S0b gate, CSP). Their
  `ctx.set` / `api.setValue` still write without the scope rule; S1b moves them onto this channel.
- **One heartbeat caveat carries over (S0b D8):** a frame sharing the page's thread can still freeze the page; the
  lifecycle bound cannot help there because the page's own timer is frozen too.
- **Paradata storage on the database path rides in `telemetry`** — absent when a survey turns telemetry off. A column
  (migration) belongs to S1b/S1c. The value is never recorded, so an analyst knows *that* a script wrote a field, not
  what it overwrote.
- **The scope rule is about the page shown.** A survey script may write a question on a LATER page; when the
  respondent reaches it, it shows the script's value as if pre-filled (the respondent can change it). Writes to a
  question on an EARLIER page are allowed for survey scripts; going Back shows them.
- **Script-created calculated variables** are created by their first write (the legacy Scripts-panel contract S1b must
  keep); they are not declared anywhere the Studio lists yet.
- **Not every option source is re-checked for "real".** Codes are accepted from the definition, the option pipeline
  as resolved now, and a grid's scale; a list built only later in the interview is not.
- **The lifecycle runs on Next of paged surveys.** The conversational one-question-at-a-time mode (`convoNext`) and
  the probe step do not ask the frames yet.
- **Submit runs after the submit gate and before the "on Next" option popups**; a popup that keeps the respondent on
  the page means submit handlers have already run once.

## What S1b and S1c do

- **S1b** — move `def.scripts` (Scripts panel, imported logic scripts, `custom_script` validation in the browser) and
  Custom Component code (`api.setValue` → `rs.setAnswer` on its own question; its HTML as the frame's own element) onto
  this channel and lifecycle, then drop the main-thread `new Function` paths.
- **S1c** — live script-error telemetry, a script health view, a script-level audit log, legacy migration visibility
  (D17), and the remaining docs corrections (D23).

---

# S1b — One script engine, part B: Scripts-panel logic scripts and Custom Components run in the sandbox (2026-10-30)

Branch `feat/persistent-execution-engine`, from `ad676c1` (S1a). Commits `cea81fc` (item 1), `abf4a23` (2), `090ad42` (3),
`48113e3` (5a, suite + the fixes it found), `3cf42f9` (4), the item 5 test update and the item 6 commit that adds this part. **After S1b no author code runs on the respondent's
main page**: logic scripts and component code run in sandboxed frames and change state only through the S1a request
channel (`applyScriptWrite`). The old main-thread runner remains behind `RUNTIME_LEGACY_SCRIPTS=main` for one release.

## What moved

| Path (audit §2.1) | Before | After |
|---|---|---|
| **B. Logic scripts** (`def.scripts`: Scripts panel, imports) | `runScripts` → `new Function` on the page, direct mutation of `state` | one sandboxed **logic frame per page** (made only when the page has a logic script to run); `ctx` is a shim over a per-run snapshot; writes are requests applied by the host through `applyScriptWrite` with the script's declared scope |
| `custom_script` validation rules (browser) | `validatePage` → `runScript` on the page (also on the Studio canvas) | `validatePage(…, { scripts: "skip" })` lists the rules; the Runner runs each rule's script in the logic frame with `value`; the Studio canvas no longer runs them at all |
| **C. Custom Component** `customJs` | `new Function("el","api",…)` on the page | a runtime-only UX behaviour (`withComponentBehaviors`) run in the UX sandbox with the **component's element as the mirror root**; `api.setValue` → `rs.setAnswer(own question)` |

`new Function` remains on the main page only in (a) the code gate's parse check — compiled, never called — and (b) the legacy
runner behind the flag.

## The shim (`packages/engine/src/logicSandbox.ts`, item 1)

- `LOGIC_SHIM` (source text; the unit test runs exactly it in a `vm` context) builds the same `ctx` as `ScriptCtx`:
  `get set getCalc setCalc getEmbedded setEmbedded expr pipe flag loop log error getCurrentLoopItem/Index/Reference
  getLoopCount getLoopItems getLoopAnswer getElement getQuestion getOption getRow getColumn getGroup value`, with the
  engine's loop-key rules (`@a@b` suffixes, innermost-first lookup) re-stated in the frame.
- `logicStatics(def)` (sent once per frame): question id/code/variable for addressing, element views for the getters.
  `logicSnapshot(def, state, loop, codes, value?)` (sent per run): answers incl. loop keys, calculated, embedded, flags,
  the loop chain, every iteration of each loop in the chain (`getLoopItems`, only when the code mentions it), and the
  host-evaluated **literal** `expr('…')` / `pipe("…")` arguments.
- `prepareLogicScripts` selects with the same function as `runScripts` (`selectScripts`: enabled, event, scope,
  `when`) and runs `codeGate(code, "logic")` **before anything is sent**; a refused script is logged, never sent.
- Frame host: `packages/renderer/src/logicFrame.ts` `LogicFrameHost` — `sandbox="allow-scripts"` (opaque origin),
  CSP `default-src 'none'`, runs serialised (one at a time, in order), each bounded; a frame that does not answer is
  removed and the next run gets a fresh one; `retire()` lets in-flight runs (a Next's on_submit, on_complete) finish
  when the page is left.

## Ordering and async semantics — what differs from the old synchronous runner

1. **Writes are queued and applied after the body returns**, in call order, through `applyScriptWrite` (scope rule,
   response model, limits, paradata `state.scriptWrites`). The lifecycle continues only after they are applied.
2. **Overlay.** Inside one run a later `get` / `getCalc` / `getEmbedded` sees the run's own writes — and so does the
   next script of the same event (one overlay per batch). Difference: a write the host then **refuses** was visible to
   the rest of the batch; the refusal is logged (`[name] set("Q2") refused: Q2 is on screen — …`).
3. **The scope rule now applies to logic scripts** (it never did): a script may not overwrite a question the
   respondent is looking at unless it is the script's own question; any other question (any page, any block) and any
   hidden target it may write. All 14 production scripts pass it (unit test; `scriptWrites.test.ts` holds the
   production case — a page script on one block setting a single_select on a later page of another block).
4. **`when` is evaluated once per event** for the whole batch, against the state before the batch (before: per
   script, after the earlier scripts had mutated the state).
5. **Timing.** survey `on_load` runs once the first position is known; the first page waits for it (boot card, ≤ 3 s)
   and the position is re-settled if it wrote anything. Page `on_load` runs when the page is shown (≤ 3 s; the page is
   not held). `on_change` runs after the respondent's change has been applied, **debounced 120 ms per question**; Next
   flushes pending ones first. `on_validate` / `on_submit` run on Next through the S1a lifecycle helper
   (`runScriptLifecycle`, **1.5 s** bound; a frame that does not answer is "no error" and logged); `error(message,
   ref)` maps `ref` by id, code or variable name to a question on the page (before: only an exact id matched; a code
   fell through to the page banner), else the page banner. `on_complete` runs before the final save (≤ 3 s).
   `custom_script` rules: ≤ 1.5 s, a rule whose script did not answer does not hold the respondent.
6. **A logic script's `set` does not trigger `on_change` scripts** (it never did); a sandboxed UX script's
   `rs.setAnswer` does (debounced).
7. `expr()` / `pipe()` with a computed argument return `null` / the text and log why (literal arguments work as before).
8. Calculated variables may hold a list or a record (`setCalc('INVALID_BRANDS', [{code,label}])`, the master demo's
   loop source) within the S1a limits; the engine-variable refusal is narrowed to the shapes the engine computes
   (`LOOP_<VAR>_COUNT`, `LOOP_<VAR>_ITEM_<n>[_…]`, `MASK_…_COUNT|LIST|SOURCE|OPERATION|ITEM_<n>`), because production
   scripts write `LOOP_PROGRESS` and `LOOP_001_VISITED_<code>`.

Conversational mode and the probe step (S1a left them out): each one-question Next runs `custom_script` rules in the
frame and asks the S1a `validate` handlers, keeping errors on that question (the page's last question goes through
the page's Next, which runs the whole page lifecycle); a probe's Next asks `validate` for the probe question. `submit`
is not asked again on a probe — it ran when the page was left.

## The legacy flag

`RUNTIME_LEGACY_SCRIPTS=main` (runtime environment; `apps/runtime/next.config.mjs` inlines it into the client bundle,
so it is read when the runtime is **built** or the dev server **started**) restores every `runScripts` call exactly as
before S1b. Default off. A temporary escape hatch for one release — remove it in S2/S3.

## Custom Components (item 3)

`withComponentBehaviors(def)` (engine `legacyScripts.ts`) adds, at run time only, one behaviour per component with code
(`uxb_component_<id>`; never saved, never in the editor). Its script wraps the author's code: `el` = the mirror of the
component's element (`[data-rs-component]`, the sanitised `customHtml` the host drew), `api.getValue()`,
`api.setValue(v)` (→ `rs.setAnswer(<own code>, v)`, a request; resolves `{ok, reason}`; a component's answer accepts
any plain value within the size limits), `api.onChange(fn)`. The UxLayer checks the author's code with the code gate's
**component** flavour (not the UX gate) and gives that frame a `DomBridge` rooted at the component element, so events
on the component's own elements are forwarded and only the component is mirrored. `QuestionRenderer` no longer runs
code; it keeps the "This component could not run" notice for gate-refused code. The suite found and S1b fixed a bug
that predates it: the `{__html}` object was new on every render, and the React build Next ships compares that prop by
identity, so **every answer anywhere on the page re-set the component's innerHTML** and dropped its listeners (memoised).

## Engine / Studio consistency (item 4)

- The Studio preview is the runtime `/preview` (same Runner) — covered by the suite's preview half.
- Scripts panel (`BrandingPanel.tsx`): the gate note stays; new note `script-sandbox-note` (sandboxed, requests,
  applied after the run, overlay, timing, literal `expr`/`pipe`). `custom-code.md` describes the new execution, the
  component mirror and its limits, and the flag.
- `scripts.ts` header: the main-thread runner is for the legacy flag and unit tests only.
- Intelligent Mode: `copilotOutline` lists Scripts-panel scripts (name, event, scope, guard, excerpt; read only) — audit
  IM-D5; the UX guide says they exist, run in the sandbox and cannot be edited by IM yet (no new action — S2).

## Where to find it

| Item | Code | Tests |
|---|---|---|
| 1 | `packages/engine/src/logicSandbox.ts`, `scripts.ts` (`selectScripts`, `loopItemView`), `packages/renderer/src/logicFrame.ts` | `packages/engine/src/logicSandbox.test.ts` (7) |
| 2 | `apps/runtime/components/Runner.tsx`, `apps/runtime/lib/logicScripts.ts`, `apps/runtime/next.config.mjs`, engine `validate.ts`/`evaluate.ts` (`skippedScripts` carries value/severity/message), Studio `LiveCanvas.tsx` | `apps/runtime/lib/logicScripts.test.ts` (5) |
| 3 | engine `legacyScripts.ts` (`withComponentBehaviors`), `scriptWrites.ts` (component values), renderer `UxLayer.tsx`, `QuestionRenderer.tsx` | `logicSandbox.test.ts` (component test) |
| 4 | `apps/studio/lib/copilot/outline.ts`, `prompt.ts`, `components/studio/BrandingPanel.tsx`, `content/docs/custom-code.md` | studio lib suite |
| 5 | — | `scripts/logic-scripts-sandbox-test.mjs` (10) |

What people see: **respondents** — nothing new, except a page with a survey `on_load` script shows "Loading survey…" a
moment longer, and a component keeps working after other answers change. **Authors** — refusals of logic-script
writes in the inspector / console with the reason; the Scripts panel's new note. **Operators** — `RUNTIME_LEGACY_SCRIPTS`.

## Verification (S1b)

| Check | Result |
|---|---|
| Engine units `cd packages/engine && pnpm -s build && node --test dist/*.test.js` | **2453/2453** (new `logicSandbox.test.ts` 7, incl. parity with the main-thread runner on all 14 production scripts inside and outside a loop; `scriptWrites.test.ts` updated for list/record calcs and the narrowed engine-variable rule; `serverScriptsSkip.test.ts` updated for the richer skipped entry) |
| Schema units | 18/18 |
| Renderer units | 8/8 |
| Runtime lib `node --experimental-strip-types --no-warnings --test 'lib/*.test.ts'` | **53/53** (new `logicScripts.test.ts` 5) |
| Studio lib | 1046/1046 |
| Templates (full) `cd packages/templates && node --test dist/*.test.js` | 111/111 |
| `tsc --noEmit` studio / runtime / renderer | 0 / 0 / 0 errors |
| `node scripts/gen-public-docs.mjs --check` | current |
| `node scripts/dependency-boundaries.mjs` | 0 violations (1986 files) |
| `node scripts/auth-guard-audit.mjs` | 0 problems (256 handlers) |
| Browser `logic-scripts-sandbox-test.mjs` (new) | **10/10** — survey on_load before page 1 (BUILD_TAG piped), on_change debounced (SPEND_BAND_TEXT, FREQ_BAND), on_submit hidden list source `h_lf_source = [1,2,3]` piped on the next page, loop helpers (LAST_RATED_BRAND, "1 of 3", Client_Code), component click → `c1 = 7`, on_submit `error()` ×3 on their questions, on_complete before the save, paradata for 14 script/kind pairs, **0 main-thread calls** of a function built from the scripts' text (a `Function` spy in the top window; 6 built only for the gate's parse check), saved row (test link) with BUILD_TAG, NPS_MEAN = 8.3, c1 = 7, h_lf_source |
| Browser regressions via `fresh.sh` | `master-demo` 15/15 (the master demo's 8 scripts, List Fill from the script-made `h_lf_source`), `script-writes` 10/10, `runtime-csp` 7/7 (components), `wave1` 9/9 (components, on_validate, on_complete), `age-script-p0` 10/10, `validation-kinds` 6/6, `section-nav` 20/20, `ux-script-dom` **16/16 on a re-run alone** — in the batch its runtime half passed 11/11 and the Studio half timed out waiting 40 s for the first Intelligent-Mode turn after `fresh.sh` restarted the Studio cold (identical to S1a's first run) |

No out-of-memory death was recorded (`studio-dev.log`, `runtime-dev.log`: 0 heap lines; the "Killed" lines in
`fresh.sh`'s output are `fresh.sh` restarting the runtime between suites).

**Not run:** the browser suites that were not in the list (`ux-copilot`, `assessment`, `ux-heartbeat`, `engine-11-14`,
`conjoint-p2`, `production-intents`, `demo-survey`, `loading-deadlock`, `listfill-intelligent`, `matrix-a11y`,
`maxdiff-p1`, `popup-p3`, `style-script-p0`, `hidden-autopunch`); the legacy flag `RUNTIME_LEGACY_SCRIPTS=main` in a
browser (type-checked; its branches are the pre-S1b calls unchanged); conversational mode and the probe step in a
browser (unit-level only); the two production demo surveys themselves (the 14 scripts are covered verbatim by the unit
parity test and the new suite; the beverage/mask demo is not in `packages/templates`, its 6 scripts were taken from
`/tmp/p0/prodcheck/run.mjs`); the database save path; Safari/Firefox; SQL (no migration).

## Honest limits (S1b)

- **Async is a behaviour change.** A survey that relied on an on_change write being visible in the very same render, or
  on a logic script running longer than the bounds (1.5 s on Next, 3 s otherwise), behaves differently; a run that
  does not answer writes nothing and is logged. The first page waits up to 3 s for survey on_load.
- **on_complete has no loop context** (as before) — a **pre-existing authoring issue**, left as it is: the beverage/mask
  demo's NPS script `k` is attached on_complete, survey scope (confirmed in the production database), so
  `getLoopItems('brand')` is empty there and it has never produced NPS_MEAN, before S1b or after. The new suite places
  `k` on the loop page's on_submit to exercise the loop helpers.
- **The scope rule refuses only a write to a question the respondent is looking at** that is not the script's own (the
  old runner made such writes silently). Writes to questions on other pages and blocks are accepted (relaxed
  2026-10-30 after the production check: the beverage demo's `set('q_seg', 'light')`, `q_seg` a visible single_select
  on `p_derived` written from `p_brand_depth`'s on_submit, is written).
- **`expr()` / `pipe()` only with literal text.** None of the 14 production scripts uses them.
- **Components in the mirror:** no layout measurement, no canvas, no rewriting of the HTML's own text; listeners on
  `document` are refused by the component gate as before. A component must create its own elements for changing text.
- **Dev-only:** under React StrictMode (dev) the first boot effect's logic frame is disposed by the immediate remount;
  that run is logged `[l] on_load: not run — the frame was closed (the page was left or re-mounted); nothing written`,
  not as a timeout, and the second mount runs the scripts. Production builds do not double-mount.
- **The legacy flag is build-time** (inlined by Next): changing it needs a rebuild/restart of the runtime.
- Paradata storage on the database path still rides in `telemetry` (S1a limit, unchanged).

## What S1c does next

Live script-error telemetry and a script health view (refusals, timeouts and failures of logic scripts are now
structured lines in the inspector/console), a script-level audit log, legacy migration visibility (D17), the remaining
docs corrections (D23), and removing `RUNTIME_LEGACY_SCRIPTS` after one release. S2: an Intelligent-Mode write action
for Scripts-panel scripts.
