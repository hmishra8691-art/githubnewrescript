# One script pipeline — Styles, animations & scripts (2026-10-15)

Priority bug: *"Resolve conflicts between Style Animation Scripts and Custom Code in Rescript Studio."*
The Studio showed two places for JavaScript — a SCRIPT card under **Styles, animations & scripts** and a separate
**Custom code → Custom JavaScript (question scope)** field — and code that worked in one did nothing in the other.

## 1. Root cause (reproduced, not assumed)

There were two script engines with different lifecycles and different views of the page.

| | Script behaviour (`ux.behaviors[].script`) | Custom code (`question.customJs`, `branding.customJs`) |
|---|---|---|
| Runs | sandboxed `iframe` (opaque origin, CSP `default-src 'none'`) | `new Function("el","api",…)` against the live page |
| Sees | only the frozen `rs` api — **no `document`** | the real `document` |
| Lifecycle | one frame per script per page, torn down on page leave | none: run from an effect, never torn down |
| Errors | validated on save, logged | `console.error` only; invisible in the live survey |
| Duplicates | no | listeners accumulated on every re-run, and ran **twice** under React StrictMode |

What the screenshot's snippet hit: `document.querySelector('.next-button, butto…` was written in Custom code, so it
did run against the real page — but `.next-button` does not exist in the survey (the real hook is
`[data-testid="rs-next"]`), so `querySelector` returned `null` and the next line threw into a console nobody reads. The
same snippet in a Style script was refused outright (`document is not available`). Moving between the two silently
changed what the code could see. Reproductions: `/tmp/p0/repro/r1–r3` (kept out of the repo; the permanent versions are
in `scripts/ux-script-dom-test.mjs`).

Contributing defects fixed on the way:

- no teardown → listeners accumulated across Next/Back and StrictMode double-mount;
- errors were swallowed (and `new Function` errors in the live runner were never shown to the author);
- guessed selectors were never called out;
- the script gate banned *all* loops (so `for (const el of document.querySelectorAll(...))` could not be written) but
  did nothing about a `while(true){}` inside a callback;
- Intelligent mode's `set_custom_code` wrote `question.customJs`, i.e. into the unsandboxed engine, bypassing the gate
  that `create_behavior` uses.

## 2. The design: one pipeline

**Styles, animations & scripts is the only place survey JavaScript lives.** A script runs in the existing sandboxed
frame, but now against a *mirror of the page's DOM* instead of nothing:

- `packages/renderer/src/uxDom.ts` (`DomBridge`, host side) takes a sanitised snapshot of the question shell with stable
  node ids, forwards real events (only the types a script listened for), and applies the script's changes through an
  allow-list: classes (never `rs-…`), inline styles (through the CSS gate), `hidden/disabled/title/role/tabindex/aria-*/data-*`
  attributes, and plain elements the script created itself. It records what it changed and **undoes it** on dispose, and
  re-asserts script-owned classes/attributes after React re-renders.
- `packages/renderer/src/uxSandbox.ts` (frame side) morphs by id so node identity and listeners survive re-renders, observes
  mutations with a `MutationObserver` and turns them into ops, bounds loops, refuses `<script>`/`<iframe>`/`on*`, and
  makes `querySelector`/`querySelectorAll` say when they match nothing.
- `UxLayer.tsx`: one frame per script per page; on page leave a 150 ms grace (a Next click already on its way is handled
  once), then dispose + undo. A new page's frame first finishes any frame still closing, so two pages' scripts never
  fight over the same element. A frame that was never started (StrictMode's first mount) is disposed immediately.
- `packages/engine/src/uxScriptGuard.ts`: `guardScriptLoops` — loops are **bounded, not banned**: each braced loop body
  counts iterations (limit 100 000 per entry); braceless loops are refused with the fix. `selectorGuesses` flags
  `.next-button`, `#next`, `.question`, … with the real hook.
- `packages/engine/src/ux.ts` (`validateUxScript`): `document` is allowed; `window`, `fetch`, `eval`, `Function`,
  `constructor`, bare `parent/top/self`, `cookie`, answer writes (`.value/.checked/…=`, `dispatchEvent`) stay refused.

`rs.listen(...)` and the DOM api are two views of the same events and cannot double-fire: the host forwards each real
event once; `rs.listen` is the host's own dispatch, DOM listeners get the forwarded event inside the frame.

## 3. Retiring Custom code — without breaking saved surveys

Confirmed redundant first (a script can now do everything `customJs` did except write answers, which was never a
supported feature). Then:

- `migrateLegacyCustomCode(def)` (`packages/engine/src/legacyScripts.ts`) moves `question.customJs` → a script on that
  question (`source: "question_custom_js"`, wrapped so `el`/`api.getValue()` still work) and `branding.customJs` → a
  survey script (`source: "branding_custom_js"`). Idempotent; never mutates its input; the code is wrapped, never
  rewritten. Applied in the **Runner** (so every already-published survey keeps working with no republish) and in the
  **Studio store** (initial state, on-load repair, every edit), so the author sees and edits the script.
- A script the sandbox will not run as written (it calls `fetch`, `window`, writes an answer…) is *still moved* — never
  dropped, never run unsandboxed — with the reason shown in Properties (`ux-script-moved` note) and in the console.
  Over 20 000 characters: left where it is and listed as blocked.
- `custom_component` keeps `customJs`: there it *is* the component, not a script attached to something. It moved to a
  "Component code" section. Custom CSS stays (nothing to conflict with) inside Styles, animations & scripts.
- UI removed: the Custom code section (Properties), the Custom JS field (Branding). Removed: `QuestionScript` and the
  `branding.customJs` effect in the runtime.

## 4. Intelligent mode

- `create_behavior` with a `script` already went through the gate; the gate now accepts the DOM and says why on refusal.
- `set_custom_code` with `js` now **creates or replaces a script behaviour** (`source: "copilot_custom_code"`, label
  `<code> script`), validated by the same gate, warnings and destructive notes propagated, an un-migrated legacy field
  superseded rather than left to run twice. `css` still edits Custom CSS.
- Prompt: the JavaScript section lists the real page hooks, the allowed/forbidden operations and the lifecycle, so
  generated scripts use `[data-testid="rs-next"]`, not `.next-button`. A stray backtick in that prompt (template
  literal) broke the copilot route during development — fixed; the browser suite would have caught it.

## 5. Verification

- Engine: `node --test dist/*.test.js` — 1 855 tests, 0 failures (new: `legacyScripts.test.ts`; updated `ux`,
  `optionActions`, `surveyActions` tests).
- New browser suite `scripts/ux-script-dom-test.mjs` (13 checks, live runtime + Studio with the fake AI):
  rs.listen + `document.querySelectorAll` side by side · `addEventListener` on the real Next button — one click = one
  call · change listener survives React re-render (3 answers → exactly 3 calls) · Next/Back ×3 — every visit starts the
  page's scripts once, none accumulate, nothing left behind · a saved survey's `customJs` and `branding.customJs`
  still run · a guessed selector, a thrown error and `while(true){}` each name their script in the console and the page
  stays responsive · refused: answer writes (static gate and the host's allow-list), `rs-` classes, `<script>`, `on*`
  · leaving a page undoes what its script changed · Studio opens a legacy survey with its code moved into the script
  list and no Custom code section · Intelligent mode's script passes the gate, applies, and **runs in the live
  survey** · `set_custom_code` lands in a behaviour, not `customJs` · a script reaching for `fetch` is refused on the
  card with the reason.
- Updated suites for the removed UI: `wave1`, `canvas`, `codes-sync`, `oct06-review`, `properties-accordion`,
  `ux-copilot` (a braced endless loop is now bounded rather than refused).
- Full browser corpus (148 suites, serial, dev servers restarted every 8 suites because the sandbox OOM-kills a
  long-lived `next dev`): 142 pass. The 6 failures are the pre-existing ones (proved on a stashed baseline before
  this change): analysis-framework, billing, dashboard-outage, picker-taxonomy, qa-fixes, quality. Nine others
  failed on the first pass only because of dev-server crashes or tests of the old behaviour, and pass on a serial
  rerun: analytics-audit, auth-handoff, autopunch-header/-matrix/-media, blocker-fixes, distribution, grid-mode,
  ux-copilot (its two assertions were updated: a braced loop is bounded, not refused; a page's script frame outlives
  the page by ~150 ms). Unit tests: engine 1 855, Studio 517, every other package green.

## 6. Known limits (said plainly)

- Scripts are **page-scoped**: they run when their page is shown and are undone when it is left; state does not carry
  between pages (use embedded data / calculations for that).
- `preventDefault()` has no effect (the event has already happened) — use validation to stop a page being left.
- A script cannot write an answer; `api.setValue` in migrated scripts logs why and does nothing.
- Text the survey itself drew cannot be rewritten (the survey owns it): create your own element or use `rs.showMessage`.
- Layout metrics (`offsetWidth`, `getBoundingClientRect`) read as 0 — the mirror has no layout.
- Legacy code that used `fetch`/`window`/`localStorage` is moved but blocked, with the error shown — by design.
- `document.documentElement`/`body` attributes (allow-listed names only) are the only parts of the page outside the
  survey shell a script can touch.
