# S0a — Security and response integrity, part A (2026-10-30)

Branch `feat/persistent-execution-engine`, from `2c46e57`. Motivated by the Script Studio audit of 2026-10-30
(`SCRIPT-STUDIO-AUDIT-2026-10-30.md` §4, defects D1, D4, D5, D6, D12). Part B (S0b) is listed at the end.

**Owner decisions taken for S0**

1. The server replay never executes author code (decision 2 = "skip on the server").
2. `RUNTIME_SERVER_VALIDATION` keeps its default (`log`). Nothing in this step changes it.

## What changed

### D1 — no author JavaScript on the server (Critical)

Before this change, the save route's replay (`checkSubmission` → `validatePage` → `validate.ts` `custom_script` → `runScript`) ran
the author's script with `new Function` in the server's own realm. The script could read `process`, an endless
loop hung the save route, and a script switched off in the editor still ran. The file header said it did not run
scripts.

- `EvalContext` gains `scripts?: "run" | "skip"` and `skippedScripts?`. The browser keeps the default (`run`).
  `checkSubmission` passes `scripts: "skip"`. A `custom_script` rule is then never executed on the server. The
  replay records it as a **soft** problem with code `client_only` (one per page, question and script), so on its
  own it cannot refuse a save. The rule still runs in the browser before the page is left.
- A script with `enabled: false` no longer runs as a `custom_script` rule anywhere, including the browser. The
  server does not record a note for it either.
- The `serverValidation.ts` header now matches what the code does.

### D6 — saves can never go backwards (Critical)

Every page the respondent leaves (Next and Back) saves the whole state. When two of these saves were in flight,
they could arrive out of order, and the older snapshot then overwrote the newer one. This was reproduced on the 0077
navigation trail (section-nav G).

- **Migration `0078_response_save_seq.sql`** adds `responses.save_seq bigint not null default 0` with the check
  `responses_save_seq_nonneg`. The migration can be run more than once. RLS does not change: only the service role
  writes to the column.
- **Client (`apps/runtime/components/Runner.tsx`).** Every save carries `seq`, a number per session that only goes
  up. It comes from `saveSeqRef`.
  - On resume, the sequence continues from `max(saved.saveSeq, pending.seq)`. The pending cache
    (`lib/resume.ts` `PendingAnswers.seq`) stores the seq that carried each snapshot, so a reload carries on past it.
  - The save body is built when the save is requested (`saveBody`).
  - Intermediate saves are chained, so they leave in the order they were made. Each has a 20-second abort, so one
    stalled save cannot block the queue; the pending cache keeps its work.
  - Final saves take the next seq, and retries reuse that seq.
- **Server (`app/api/session/save/route.ts`).**
  - An intermediate save that carries a seq is written with a conditional update:
    `.eq("status","in_progress").lt("save_seq", seq)`.
  - When no row changes and the row is still in progress, the save was stale. The route answers 200
    `{ ok: true, stale: true, seq }` and writes nothing.
  - The final save is not checked against seq. The status condition already makes it finalise exactly once (Y11),
    and refusing a completion would leave a respondent stuck.
  - A client that sends no seq (a page opened before this deploy) is saved as before.
  - Before 0078 is applied, the route retries without the column and logs once: `responses.save_seq missing`.
- **Start route.** On resume, the start route returns `saved.saveSeq` for both the database and the sandbox. Its
  read has a fallback for databases without 0078.
- **Sandbox store (`lib/sessionSandbox.ts`).** The in-memory store follows the same rule. It also has a test-only
  seam: the save body field `sandboxDelayMs`. The seam works only on the sandbox path (no database) with
  `AI_API_URL=fake:`, and is capped at 5 seconds. The sandbox `row` action reports `saveSeq`.
- **Shared helper.** The rule is in `apps/runtime/lib/saveSeq.ts` (`parseSaveSeq`, `isStaleSave`, `resumeSeq`).

### D4 — no network through CSS set by scripts (Critical)

- `checkDeclarations(…, { origin: "script" })` refuses any value that can make the browser fetch, and states the
  reason. The refused forms are `url(`, `image-set(` (including `-webkit-`), `@import`, `expression(`, `image(`,
  `cross-fade(` and `src(`. The helpers are `scriptStyleRefusal` and `SCRIPT_STYLE_FETCH` in `engine/src/ux.ts`.
- Every style operation that comes from a script uses this check:
  - DomBridge style operations, which includes the mirrored `el.style.*` (`renderer/src/uxDom.ts` `sty`);
  - the `style` attribute of elements a script creates (`build`), which is now also logged;
  - `rs.setStyle` (`UxLayer.tsx`).
- Static styles that authors write (the compiled `def.ux.styles` and behaviour effects) keep the existing rule:
  https `url()` and inline raster images are allowed.
- The authoring check (`uxScriptGuard.ts` `exfiltrationProblems`, used by `validateUxScript` and option-action JS)
  refuses a `url()` or `image-set()` that is built in code: by concatenation, by `${}` inside a template, or with
  `.concat(`.

### D5 — author HTML is sanitised at render (Critical)

- `engine/src/piping.ts` gains `resolveAuthorHtml(template, ctx)`, which is `sanitizeHtml(resolvePiping(…))`.
  `sanitizeHtml` is the same sanitiser that option labels use. It removes scripts, `on*` handlers and
  `javascript:` URLs, and keeps inline styles and classes.
- It is used for:
  - `branding.headerHtml` and `footerHtml` (`apps/runtime/components/Runner.tsx`);
  - `custom_component` `customHtml` (`packages/renderer/src/QuestionRenderer.tsx`).

### D12 — a script cannot lock a respondent out of an answer (High)

`packages/renderer/src/answerLock.ts` (`answerLockReason`, `HIDING_STYLE`) protects two kinds of element:

- **Answer inputs inside a question card.** These are:
  - an option (`[data-rs-el="option"]`), or anything inside one;
  - `input` (except `type="hidden"`), `select`, `textarea`, editable elements, and elements with the roles
    radio, checkbox, slider, option or spinbutton;
  - an element that contains any of these.
- **Whole question cards that are required.** This covers a question card, or an element holding several cards,
  when any question in it is required. `QuestionRenderer` now draws `data-rs-required="1"` on the card, and scripts
  cannot write `data-rs-*` attributes. Hiding a card that is *not* required is still allowed.

On these elements:

- **The DomBridge allow-list (`uxDom.ts`)** refuses `hidden` and `disabled`. It also refuses `display:none`,
  `visibility:hidden|collapse` and `pointer-events:none` in style operations. Each refusal gives its reason in the
  script console. Classes and all other styles still apply. Elements the script created itself are not restricted.
- **`rs.hide`** is refused on the same targets. On an *answered* question it hides the question but warns that the
  answer stays stored and is still validated.
- **`rs.setStyle`** drops the hiding properties and gives a warning.

The existing Next/Back/`.rs-nav` protection (RUNTIME-08) is unchanged.

## Where to find it

| Defect | Code | Tests |
|---|---|---|
| D1 | `packages/engine/src/serverValidation.ts`, `validate.ts` (`custom_script`), `evaluate.ts` (`EvalContext.scripts`) | `packages/engine/src/serverScriptsSkip.test.ts` (6 tests, one ports `ssa/s1-probe4.mjs`) |
| D6 | `supabase/migrations/0078_response_save_seq.sql`; `apps/runtime/lib/saveSeq.ts`; `app/api/session/save/route.ts`, `start/route.ts`, `sandbox/route.ts`; `lib/sessionSandbox.ts`; `lib/resume.ts`; `components/Runner.tsx` (`saveBody`, `persist`, `checkpoint`) | `scripts/response-save-seq-sql-test.sql`; `apps/runtime/lib/saveSeq.test.ts` (3); `scripts/section-nav-test.mjs` §G overlapping-saves check |
| D4 | `packages/engine/src/ux.ts` (`checkDeclarations` origin, `scriptStyleRefusal`), `uxScriptGuard.ts`; `packages/renderer/src/uxDom.ts`, `UxLayer.tsx` | `packages/engine/src/scriptStyleFetch.test.ts` (3, ports probe 2) |
| D5 | `packages/engine/src/piping.ts` (`resolveAuthorHtml`); `Runner.tsx`; `QuestionRenderer.tsx` | `packages/engine/src/authorHtml.test.ts` (3) |
| D12 | `packages/renderer/src/answerLock.ts`, `uxDom.ts`, `UxLayer.tsx`, `QuestionRenderer.tsx` (`data-rs-required`) | `packages/renderer/test/answerLock.test.ts` (4); `scripts/ux-script-dom-test.mjs` check 7b |

What respondents and authors see:

- **Respondents.** No visible change, except that a script can no longer hide or disable their answers, and branding
  HTML can no longer run handlers.
- **Authors.** Refusals appear in the browser console and in the preview inspector as
  `[rescript:script] <name>: …` or `[ux script "<name>"] …`. A `url()` built from code is refused on the script card
  in the Studio (Properties → Styles, animations & scripts) and on the Intelligent-mode proposal card.
- **Operators.**
  - Server logs show `[rescript:save] stale save ignored` (database) and `sandbox stale save ignored`.
  - Until 0078 is applied, the log shows `responses.save_seq missing (migration 0078 not applied)` once.
  - The submission-check log line now includes soft `client_only` entries for `custom_script` rules.
- **Public docs.** `apps/studio/content/docs/custom-code.md` previously said, wrongly, that a `custom_script` rule
  "runs the same way" (implying it also runs on the server) and that the script frame has "no network". It now says
  that the rule runs in the browser only, that `enabled:false` is never run, and that the frame is not a network
  boundary (the runtime has no CSP yet). It also describes the script-style fetch ban, the answer-input / required-
  card protection, and that header, footer and component HTML are sanitised. `node scripts/gen-public-docs.mjs
  --check` reports that the generated pages are current.

## Migration and deploy order

`0074 → 0076 → 0077 → 0078`. (`0075` is already applied in production.) Each migration can be run more than once.
The route tolerates a database without 0078: the save retries without the column and logs once, and the resume
read falls back. This means the code can be deployed before the migration is applied; saves are simply unordered
until it is.

## Verification (commands and counts)

| Check | Result |
|---|---|
| Engine units: `cd packages/engine && pnpm -s build && node --test dist/*.test.js` | **2426/2426** (12 new: D1 6, D4 3, D5 3) |
| Schema units: `cd packages/schema && pnpm -s build && node --test dist/*.test.js` | 18/18 |
| Renderer units (new runner): `node --experimental-strip-types --no-warnings --test packages/renderer/test/*.test.ts` | 4/4 |
| Runtime lib: `cd apps/runtime && node --experimental-strip-types --no-warnings --test 'lib/*.test.ts'` | 41/41 (3 new) |
| Studio lib: `cd apps/studio && node --experimental-strip-types --no-warnings --test 'lib/**/*.test.ts'` | 1046/1046 |
| `tsc --noEmit` studio / runtime / renderer | 0 / 0 / 0 errors |
| `node scripts/gen-public-docs.mjs --check` | current |
| `node scripts/dependency-boundaries.mjs` | 0 violations (1970 files) |
| `node scripts/auth-guard-audit.mjs` | 0 problems (256 handlers) |
| SQL: scratch PG16 (copy of `/tmp/rescript-g2-pg/data`, port 55478, `-k /tmp`), apply 0071–0078, then 0078 again; `scripts/response-save-seq-sql-test.sql` twice | all exit 0; 4/4 notices on both runs; server stopped |
| Probe 4 (`/tmp/p0/ssa/s1-probe4.mjs`) | `ok:true`, one soft `client_only`, author code not run |
| Probe 2 (`/tmp/p0/ssa/s1-probe2.mjs`) | `css_exfil`, `mirror_exfil` and `tpl` are now refused by the authoring check. The `decl` line (an author-origin `checkDeclarations` call) is unchanged, by design |
| Browser `ux-script-dom-test.mjs` | **16/16** (15 + the new D12 check) |
| Browser `section-nav-test.mjs` | **20/20** (19 + the D6 overlapping-saves check) in two full runs, plus a G-only run of 4/4 after the wait fix |
| Browser `style-script-p0-test.mjs` | 11/11 |
| Browser `hidden-autopunch-test.mjs` | 9/9 (via `fresh.sh`) |
| Browser `qa-fixes-test.mjs` | all 18 checks ("ALL QA FIX CHECKS PASSED", via `fresh.sh`) |

Out-of-memory deaths, recorded as such:

- **First `ux-script-dom` run.** The runtime `next-server` was killed by the memory cgroup (pid 2467). The dev
  server had also cached the engine dist from before `resolveAuthorHtml` existed. After a restart the suite passed.
- **First sequential runs of `hidden-autopunch` and `qa-fixes`.** Both failed because the Studio `next-server` was
  OOM-killed four times while both servers were up (Studio at 3–4 GB). Both suites passed when re-run through
  `fresh.sh`.
- **No test logic failed in these runs.**

One failure was a real defect in the new check: the first section-nav G run closed device B's browser context
before its Back save had left. The check now waits for the row to show the save before it closes the context.

## Honest limits

- **D1.** A `custom_script` rule is now enforced only in the browser. A crafted client can skip it, and the server
  logs that as `client_only`. This is the owner's decision ("skip on the server"). Moving such checks to
  `custom_expression` or `condition` rules makes them enforceable on the server.
- **D6.** Ordering is per session and per row. Two devices writing the same session at the same time are ordered by
  seq, so the device that continued from the higher number wins. A final save is not seq-checked: it always lands
  once, even if an intermediate save with a higher seq from another device had arrived first. That cannot happen
  from a single device. A page opened before this deploy saves without seq (unordered) until it is reloaded. The
  20-second abort applies to intermediate saves only.
- **D4.**
  - The host gates now cover every style a script sets on the real page. The sandboxed frame itself can still
    fetch: there is no CSP, and Manual component `customJs` runs unsandboxed. That is D2/D3, in S0b.
  - The authoring check for "url() built from code" is a regular expression. A deliberately obfuscated spelling can
    pass the authoring check, but it is still refused at run time.
- **D5.** The sanitiser is the regex-based `sanitizeHtml`, the same one that already protects question text and
  option labels. Branding `customCss` is not covered by this step.
- **D12.**
  - Protection follows the DOM markers (`data-qid`, `data-rs-el="option"`, form controls).
  - A custom component that draws its answer UI with plain `div`s and no roles is not recognised as an answer
    input. Only its card is protected, and only if the question is required.
  - Opacity, size and off-screen positioning are not treated as hiding.
- **Renderer unit tests** use a minimal fake DOM, because there is no DOM library and no new dependencies were
  allowed. Real-browser coverage is the `ux-script-dom` check 7b.
- **Browser coverage** is headless Chromium only.

## What S0b still covered (done in part B, below)

- **D2/D3 containment:**
  - check Manual component code and imported or Scripts-panel code on save;
  - ban the `constructor` escape;
  - honour `enabled` for page and survey scripts in the remaining paths.
- **A runtime Content-Security-Policy** on respondent pages, at least `connect-src 'self'`.
- **D8:** a heartbeat and wall-clock limit for sandbox frames (a frame watchdog).
- **D7:** recompute punches and calculations on the server, then move production to `enforce` after a period of
  logging.

---

# Part B — S0b (2026-10-30)

Branch `feat/persistent-execution-engine`, from `2118eb6` (the S0a docs fix). Defects D2, D3, D7 and D8 of the
audit, plus the runtime Content-Security-Policy. This is **containment**: S1 moves Custom Component code and
Scripts-panel code into the sandboxed frame; nothing here builds that.

## What changed (part B)

### D3 — one code gate for logic scripts (`def.scripts`)

- **`packages/engine/src/codeGate.ts`** — `codeGate(code, "logic" | "component")`, on the shared tokenizer of
  `scriptAst.ts` (`tokenize`, `declaredNames` — now exported; no second lexer). It refuses, with a reason each:
  - `constructor`, `__proto__`, `prototype`, `globalThis`, `Function`, `eval`, `import`, `fetch`, `XMLHttpRequest`,
    `WebSocket`, `EventSource`, `navigator`, `cookie`, storage, `postMessage`, `sendBeacon`, `Reflect`, `Proxy`,
    `with`, `setInterval`, `getPrototypeOf`/`setPrototypeOf`, `__defineGetter__` and kin, `ownerDocument`,
    `defaultView`, `contentWindow`, `contentDocument`, `opener`, and the loop counter `__g` — as a name or as a
    property (`ctx.get.constructor`), and as a whole string literal (`o["constructor"]`);
  - per flavour, bare globals (`window`, `document`, `self`, `top`, `parent`, `location`, `process`, `setTimeout`…
    for logic scripts);
  - computed access `X[…]` whose object is a bare name the script did not declare and is not one of its roots
    (`navigator["send"+"Beacon"]`, `Math[k]`, `this[k]`), and any computed key built by joining strings;
  - loops the existing `guardScriptLoops` cannot instrument (braceless); instrumented loops are bounded at
    100,000 iterations per run (`loopCounter`);
  - `exfiltrationProblems` (the regex check) is kept as an extra signal: its findings are reasons too;
  - a parse check in the exact wrapper the code runs in (so `const get = …` is refused on save, not in a
    respondent's browser).
  Verdicts are memoised per (flavour, code), 400 entries.
- **Run time** — `runScript` refuses code that fails the gate (`result.refused`, `failed: "refused: …"`) and runs
  the loop-guarded form; `runScripts` logs `[name] refused: reason` (preview inspector) and lists
  `refusedScripts`; the runtime's `Runner.tsx` wraps `runScripts` and `console.warn`s `[rescript:script] [name]
  refused: …` in every mode (the only trace in live). A refused `custom_script` validation rule does not hold the
  respondent. A page-scoped on_load that only produced refusals still shows them.
- **Save** — the Scripts panel (`BrandingPanel.tsx` `ScriptsPanel` → `ScriptCodeField`) edits a draft and saves on
  blur / "Save code" only when the gate passes; refused code is not saved and the reasons are listed. A refused
  script cannot be switched on.
- **Import** — QSF/Decipher/legacy imports (`packages/import/src/map.ts`) keep custom code `enabled:false`
  ("pending review") and now start its notes with `Script check: passes.` or `Script check: refused — <reason>.`
  `gateSurveyScripts(def)` switches off any failing script with the reason in its notes; it runs on the JSON view's
  "validate & apply" (`JsonPanel.tsx`, with a toast naming the refused scripts) and on project creation from a
  definition payload (`POST /api/surveys`).
- **`applySurveyActions`** — no action writes `def.scripts` (only the `custom_script` rule names one), so there is
  nothing to gate there.

### D2 — Custom Component code through the same gate

- Component flavour: roots `el` and `api`; `document` only for `createElement` / `createElementNS` /
  `createTextNode` / `createDocumentFragment`; no `window`/`self`/`top`/`parent`/`location`/`Image`; everything in the
  common list above.
- **Manual Mode** — Properties → Component code (`PropertiesPanel.tsx` `ComponentJsField`): draft + gate on blur /
  "Save code", refused with the reasons, not saved.
- **Intelligent Mode** — `set_custom_code` on a component decides with `codeGate(…, "component")`
  (`optionActions.ts`); the regex check is now one of its signals, not the decision.
- **Run time** — `QuestionRenderer.tsx` `CustomComponent` runs only gated code, in strict mode (a top-level `this`
  is no longer the window), with the loop counter. Refused code does not run: preview/test show "This component
  could not run: refused by the script check — …" (`data-testid="rs-component-failed"`); every mode warns
  `[rescript:component] <code>: refused, not run — …`. A component that throws shows the same notice with the error.

### Runtime Content-Security-Policy (`RUNTIME_CSP`)

- `apps/runtime/lib/csp.ts` builds the policy from the environment at boot; `apps/runtime/middleware.ts` sends it on
  every runtime response except Next's static assets.
- **Enforced:** `connect-src 'self'` + `SUPABASE_URL` (https, wss) + R2 storage (`R2_ENDPOINT` or
  `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, plus `<bucket>.<host>` when `R2_FORCE_PATH_STYLE=0`) or
  `MEDIA_STORAGE_URL` (memory store) + `AI_REALTIME_API_URL` + `LIVEKIT_URL` (https, wss; `*.livekit.cloud` for
  LiveKit Cloud) + `RUNTIME_CSP_CONNECT` (operator list, scheme required); `form-action 'self'`; `base-uri 'self'`;
  `object-src 'none'`. `frame-ancestors` is not set (the Studio frames the runtime; nothing set it before).
- **Report-only twin:** the same plus `img-src`/`media-src 'self' data: blob: <storage>` and `script-src 'self'`.
  There is no report endpoint, so no `report-uri`; findings are console-only. In `next dev` it reports every inline
  and eval'd script (hundreds of console lines per page — expected; production has fewer).
- What the runtime client connects to was enumerated by grep (`fetch(`, `new WebSocket`, `EventSource`,
  `sendBeacon`, `RTCPeerConnection` in `apps/runtime` and `packages/renderer`): own-origin `/api/*`; signed storage
  PUTs; the realtime SDP post; the LiveKit signalling socket. `GEOCODE_API_URL` is called by the server only. The
  `livekit-client` module (from `LIVEKIT_CLIENT_URL`) is a script import, not restricted. WebRTC media/TURN is not
  governed by `connect-src`.
- `RUNTIME_CSP=enforce` (default) | `report` (the enforce policy as Report-Only) | `off`. Documented in
  `.env.example`. There is no runtime readiness list on `/platform` (it reads the Studio's environment), so it is
  not listed there.

### D8 — sandbox frame watchdog

- **(a) Bounded promise chains** — inside the frame only (`uxSandbox.ts` `UX_MICROTASK_GUARD`),
  `Promise.prototype.then` (so `catch`/`finally`) and `queueMicrotask` count their callbacks per slice; the same
  `slice()` that resets the loop counter resets it. Past 10,000 the callbacks are dropped until the next entry and
  one error, worded like the loop guard's, reaches the inspector. (A throw was tried first: promise adoption
  re-enters `then`, so the error cascaded into unhandled rejections — dropping ends the chain cleanly.) `then` is
  made non-writable. `await` on a native promise is not counted.
- **(b) Heartbeat** — the host (`UxLayer.tsx`) pings each frame every 2 s once it is ready; the frame answers
  `pong`. Three missed pings in a row while the page is visible: the frame is disposed, the host undoes its effects
  and the DomBridge its DOM changes, and `stopped: not responding (no answer to 3 heartbeats in 6 s) — its changes
  were undone` is logged (inspector + `console.warn`). Hidden pages do not count. **This only helps when the
  browser runs the sandboxed frame out of process.** Verified: in headless Chromium with default flags the frame
  shares the page's renderer (a spinning frame froze the page; an allocating `await` recursion crashed the tab), so
  nothing on the page can interrupt it; with `--site-per-process --enable-features=IsolateSandboxedIframes` the
  spinning frame was stopped after ~8 s and the page kept answering. All sandboxed frames of one page share one
  process there, so the other scripts' frames on the same page starve too and are stopped by the same rule.
- **(c) Skipped** — refusing regexes with nested quantifiers: the 491-script corpus has two honest
  `/^\d+(,\d+)*$/` that a simple nested-quantifier detector flags. Corpus verdicts are unchanged
  (`scriptChecks.test` 21/21).

### D7 — the save replay recomputes what it can

- `checkSubmission` (`serverValidation.ts`) already replays from the row's seed and the posted answers, and that
  replay applies derived punches on arrival and runs the calculations on submit — the result was discarded. It is
  now compared with what was posted (`compareDerived`):
  - answer keys of derived questions (hidden type or `settings.hidden` with punch rules; calculated type with an
    expression, except AI-resolved ones) and of questions with a `recompute: "always"` punch rule;
  - every calculated variable the replay wrote (calculations, loop and masking variables; a value only a script
    sets stays as posted — the server runs no author code);
  - exact-balance assignments (`RANDOMIZER_<ID>`, `<VAR>_VERSION`) against `balanceClaims`, the claims the server
    stored (save route: `balance_claims` rows of the session, `active`/`completed`, mapped by the new
    `balanceVariableForKey`).
- Each difference is a soft problem `server_mismatch` with `questionId` or `variable`, `posted` and `server`,
  summarised by `summariseValue` (numbers, codes and short code-like strings as they are; other text as
  `<text, N chars>`; never an open end's text). `SubmissionCheck.recomputed` carries the server's values.
- **`RUNTIME_SERVER_RECOMPUTE=off|log|store`** (default `log`), save route, database and sandbox paths: `log` adds
  the mismatches to the existing submission-check log line; `store` writes the server's values for those fields
  into the row instead of the posted ones; `off` skips the comparison. It runs inside the replay, so it needs
  `RUNTIME_SERVER_VALIDATION` other than `off`. `RUNTIME_SERVER_VALIDATION` is unchanged.

## Where to find it (part B)

| Item | Code | Tests |
|---|---|---|
| D3 | `packages/engine/src/codeGate.ts`, `scripts.ts`, `validate.ts`, `scriptAst.ts`; `apps/runtime/components/Runner.tsx`; `apps/studio/components/studio/BrandingPanel.tsx` (Scripts panel), `JsonPanel.tsx`, `app/api/surveys/route.ts`; `packages/import/src/map.ts` | `packages/engine/src/codeGate.test.ts` (5 logic tests), `wave1.test.ts` (updated), `packages/templates/src/scriptGate.test.ts` (1), `packages/import/src/import.test.ts` (verdict) |
| D2 | `codeGate.ts` (component flavour); `packages/renderer/src/QuestionRenderer.tsx` `CustomComponent`; `PropertiesPanel.tsx` `ComponentJsField`; `packages/engine/src/optionActions.ts` | `codeGate.test.ts` (4 component tests incl. the three S4 bypasses); `scripts/runtime-csp-test.mjs` |
| CSP | `apps/runtime/lib/csp.ts`, `apps/runtime/middleware.ts`, `.env.example` | `apps/runtime/lib/csp.test.ts` (3); `scripts/runtime-csp-test.mjs` (7) |
| D8 | `packages/renderer/src/uxSandbox.ts`, `UxLayer.tsx` | `packages/renderer/test/uxMicrotask.test.ts` (4); `scripts/ux-heartbeat-test.mjs` |
| D7 | `packages/engine/src/serverValidation.ts`, `exactBalance.ts` (`balanceVariableForKey`); `apps/runtime/app/api/session/save/route.ts` | `packages/engine/src/serverRecompute.test.ts` (5); `packages/templates/src/serverCheck.test.ts` (now asserts zero mismatches) |

What people see:

- **Authors.** Scripts panel and Component code: "Not saved — the script check refused it:" with the reasons; the
  draft stays until saved or discarded. Imported scripts' notes start with the verdict. JSON view: a toast names
  any script switched off. Preview inspector: `[name] refused: …`; component notice "This component could not
  run: …".
- **Respondents.** No change for honest surveys. A refused script or component simply does not run.
- **Operators.** `RUNTIME_CSP`, `RUNTIME_CSP_CONNECT`, `RUNTIME_SERVER_RECOMPUTE` (all runtime-only); the
  submission-check log line now carries `server_mismatch` entries.

## Verification (part B)

| Check | Result |
|---|---|
| Engine units: `cd packages/engine && pnpm -s build && node --test dist/*.test.js` | **2439/2440** in the full run (14 new: codeGate 9, serverRecompute 5). The one failure, `flowEmbeddedPiping` "C: random values — … fresh per:each", is a random collision (two draws equal); the file re-run alone is 24/24. Not touched by S0b. |
| Schema units | 18/18 |
| Renderer units: `node --experimental-strip-types --no-warnings --test packages/renderer/test/*.test.ts` | **8/8** (4 new: uxMicrotask) |
| Runtime lib: `cd apps/runtime && node --experimental-strip-types --no-warnings --test 'lib/*.test.ts'` | **44/44** (3 new: csp) |
| Studio lib: `cd apps/studio && node --experimental-strip-types --no-warnings --test 'lib/**/*.test.ts'` | 1046/1046 |
| Templates (targeted): `node --test dist/scriptGate.test.js dist/serverCheck.test.js` | 1/1 and 6/6 (serverCheck now asserts zero `server_mismatch` on 5 templates × 3 seeds and the master-demo test paths, complete and partial) |
| Import units: `cd packages/import && node --test dist/import.test.js` | 20/20 |
| `scriptChecks.test` (491-script corpus verdicts) | 21/21 — verdicts unchanged |
| `tsc --noEmit` studio / runtime / renderer | 0 / 0 / 0 errors |
| `node scripts/gen-public-docs.mjs --check` (after regenerating) | current |
| `node scripts/dependency-boundaries.mjs` | 0 violations (1977 files) |
| `node scripts/auth-guard-audit.mjs` | 0 problems (256 handlers) |
| Probes | `(()=>{}).constructor('return process')()`, `ctx.get.constructor(…)`, `globalThis.fetch` alias, `navigator["send"+"Beacon"]` → refused (logic and component flavours); `while(true){}` in a logic script → stopped at 100,000 |
| Browser `runtime-csp-test.mjs` (new, via `fresh.sh`) | **7/7**: CSP + report-only headers; `fetch`/XHR/WebSocket to example.com blocked from the page; own `/api` reached; refused logic script logged and not run, good one ran; bad component shows its notice, good one ran; upload question takes a file (sandbox); page saved |
| Browser `ux-heartbeat-test.mjs` (new, runtime only) | default Chromium: the frame shares the page's thread — the page froze (documented limit; exit 2, "NOTE"); `HB_ISOLATE=1` (`--site-per-process --enable-features=IsolateSandboxedIframes`): **3/3**, spinner stopped after ~8 s, mark undone, frame removed, page answers |
| Browser `ux-script-dom-test.mjs` | 16/16 |
| Browser `style-script-p0-test.mjs` | 11/11 |
| Browser `age-script-p0-test.mjs` | 10/10 |
| Browser `master-demo-test.mjs` | 15/15 |
| Browser `section-nav-test.mjs` | 20/20 |
| Browser `assessment-test.mjs` | 7/7 |
| Browser `wave1-test.mjs` (question customJs) | 9/9 |
| Browser `validation-kinds-test.mjs` (custom_script rule in the editor) | 6/6 |

All browser suites above ran through `/tmp/p0/fresh.sh` with the Studio supervisor up; no out-of-memory death in
these runs (the "Killed" lines in fresh.sh's output are fresh.sh restarting the runtime between suites).

**Not run:** the other suites that carry `scripts:` fixtures (`stage-cap-api`, `engine-11-14`, `conjoint-p2`,
`production-intents`, `demo-survey`, `loading-deadlock`, `listfill-intelligent`, `matrix-a11y`, `maxdiff-p1`,
`popup-p3`) — time; the full templates and import package suites beyond the files listed; SQL (no migration in
part B); a real R2 signed upload under the CSP; Safari/Firefox.

## Honest limits (part B)

- **The gate is static containment, not a boundary.** A forbidden name assembled at run time into a variable and
  used on an object the script declared (`const k = a + b; obj[k]`) is not seen. Logic scripts and components
  still run in the page's realm. The CSP is the backstop for sending data; DOM side effects of component code on
  the page are not prevented. S1 moves both into the sandboxed frame.
- **Refusals are new.** A legitimate script or component using `prototype` (`Array.prototype.slice.call`),
  `window.*`, `document.querySelector` (components), `setTimeout` (logic scripts), braceless loops, or computed
  access on a global is now refused, with the reason. All 16 template/master-demo scripts and the 19 logic-script
  fixtures found in the repository pass unchanged; and so does the component code in the engine tests.
- **CSP.** `connect-src` only — images, media and scripts are not restricted, so an `<img src>` built from data by
  code that slipped through can still leak (the D4 host gates and the gate's `Image`/`.src` refusals cover the
  known paths). The report-only policy is noisy in `next dev`. Operators who add a client-side integration must add
  its origin to `RUNTIME_CSP_CONNECT`. Upload in the sandbox keeps the file in the browser (no storage) — the signed
  PUT to R2 under the CSP was not exercised (no R2 here).
- **D8.** The heartbeat cannot help a frame that shares the page's thread (headless Chromium default). `await`
  chains are not counted. Regex backtracking is not refused.
- **D7.** Only what the replay reaches is compared; it needs `RUNTIME_SERVER_VALIDATION≠off`. Values a script sets
  (`setCalc`, `set`) are not recomputed. Balance claims are compared on the database path only (the sandbox's memory
  store has no per-session lookup). Under `store`, quotas and List Fill still read the posted answers of that save.
  Mismatches are soft: nothing is refused for them.

## What S1 still has to do

- Run Custom Component code and Scripts-panel / imported logic scripts in the sandboxed frame (component: an
  `api.setValue` message channel; logic scripts: data in → `set`/`setCalc`/`error` out), and drop the main-thread
  `new Function` paths.
- Make the heartbeat effective everywhere (a worker or a guaranteed out-of-process frame).
- Decide whether `RUNTIME_SERVER_RECOMPUTE=store` and `RUNTIME_SERVER_VALIDATION=enforce` become production
  defaults after a log period.
