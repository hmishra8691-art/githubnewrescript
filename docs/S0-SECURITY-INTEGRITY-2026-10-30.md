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

## What S0b still covers

- **D2/D3 containment:**
  - check Manual component code and imported or Scripts-panel code on save;
  - ban the `constructor` escape;
  - honour `enabled` for page and survey scripts in the remaining paths.
- **A runtime Content-Security-Policy** on respondent pages, at least `connect-src 'self'`.
- **D8:** a heartbeat and wall-clock limit for sandbox frames (a frame watchdog).
- **D7:** recompute punches and calculations on the server, then move production to `enforce` after a period of
  logging.
