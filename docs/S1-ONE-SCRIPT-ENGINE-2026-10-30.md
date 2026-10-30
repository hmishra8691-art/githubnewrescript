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
| a question | **its own question, even on screen** |
| a page / block | the questions of its page / block that are **not** on screen |
| the survey | any question that is **not** on screen |

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
