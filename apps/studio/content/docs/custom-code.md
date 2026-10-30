# Custom code

Four surfaces take code: HTML in questions and blocks, per-question CSS, survey scripts with an event and an API, and the UX layer — styles, animations and **scripts**. There is exactly one place survey JavaScript lives: a script in the UX layer (Properties → **Styles, animations & scripts**). The old per-question and branding "Custom JavaScript" fields are gone — a saved survey that had one is moved there on load, unchanged. This page says which surface to use. (Logic scripts in the **Scripts** panel and **Custom Component** code run in the same kind of sandboxed frame: no author code runs on the respondent's page itself. Their writes are requests the survey checks, like a UX script's — see below.)

## HTML

An `html` question (`content.html`) is a block of text or HTML with no answer. Any question's `text`, `instruction` and option labels take HTML too. Author HTML is sanitised: scripts, event handlers and `javascript:` URLs are removed; a `<style>` block inside the HTML is scoped to the question it belongs to (so `body { … }` in a block styles that block, not the page). Piping tokens work inside HTML.

A `custom_component` question renders `customHtml` (piped, and sanitised like any author HTML) and runs `customJs` against it — see below. A survey's branding header and footer HTML are sanitised the same way when they are drawn: scripts and event handlers are removed, inline styles and classes are kept.

## Per-question CSS, and component code

```json
{ "id": "q_slider", "code": "Q8", "variableName": "MOOD", "type": "custom_component", "text": "How do you feel today?",
  "customHtml": "<div class=\"mood\"><button data-v=\"1\">😞</button><button data-v=\"3\">😐</button><button data-v=\"5\">😀</button></div>",
  "customJs": "el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { api.setValue(Number(b.dataset.v)); el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); }));",
  "customCss": ".mood button.on { outline: 3px solid #2563eb; }" }
```

`customCss` is injected as a `<style>` inside the question card and is **not scoped** (a rule in it applies to the whole page): prefix your selectors with the card's attribute, `[data-qid="q_slider"] .mood button { … }`, to keep them to the question. It lives in Properties → Styles, animations & scripts → Custom CSS.

A **Custom Component** (`type: "custom_component"`) is the one question type whose `customJs` is not a script attached to something: it *is* the component. Its sanitised `customHtml` is drawn on the page; its code runs (strict mode) in a **sandboxed frame** whose document is a mirror of the component's element only: `el` is that element and `api` is `{ getValue(), setValue(v), onChange(fn) }`. `setValue(v)` is a request to store `v` as the component's answer — checked by the survey like `rs.setAnswer` on the component's own question (allowed while it is on screen; any plain value up to the size limits) and resolving `{ ok, reason }`; `getValue()` returns it at once; `onChange(fn)` calls `fn(value)` whenever the answer changes. Class, style and allowed attribute changes on `el` and elements the code creates appear on the real page; listeners on the component's own elements receive the respondent's clicks, typing and other events. **What does not work in the mirror:** layout measurement (`getBoundingClientRect`, `offsetWidth` are 0), drawing on a `<canvas>`, and replacing the text of the HTML the component was drawn with (create your own element for changing text) — such a component cannot run as written; the preview shows what failed in the inspector. Use a component only for an answer control the platform has no variant for.

**The component check.** Component code is checked when it is saved (Properties → Component code shows the reasons and does not save refused code), when Intelligent mode writes it (`set_custom_code` on a component is refused with the reasons), and again before it runs. It works on `el` and `api` only: `document` may be used to create nodes (`createElement`, `createTextNode`, `createDocumentFragment`), but not `window`, `self`, `top`, `parent`, `location`, `document.cookie` or other page globals; not `constructor`, `__proto__`, `prototype`, `globalThis`, `Function`, `eval`, `import`, `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator`, `sendBeacon`, storage, `postMessage`, `Reflect`, `Proxy`, `with`, `setInterval`; not `ownerDocument` / `defaultView` / `contentWindow` (the way from an element to its window); not computed access on a name the code did not declare (`navigator["send" + "Beacon"]`, `this[k]`) or a property name built by joining strings (`el["owner" + "Document"]`). Loops need braces and stop after 100,000 rounds. Refused code does not run: preview and test show "This component could not run: …" under the component, and every mode writes `[rescript:component] <code>: refused, not run — <reason>` to the browser console. Everything else — a look, a reaction, a counter, a nudge — is a script (below). In Properties it has its own "Component code" section.

### Moved from the old Custom code

Surveys saved before the consolidation are migrated on load (and idempotently — a second load changes nothing):

- a question's `customJs` becomes a script on that question (`source: "question_custom_js"`), wrapped so `el` is still the question card and `api.getValue()` still reads the answer. `api.setValue` is not carried over (it logs why when called — use a default value, a punch rule or `rs.setAnswer`, below);
- `branding.customJs` becomes a survey-level script (`source: "branding_custom_js"`);
- code the script sandbox will not run as written (it calls `fetch`, touches `window`, writes an answer…) is **still moved, never dropped or run unsandboxed**; its script shows the reason in Properties and the browser console names it at run time. Code over 20,000 characters stays in its original field and is listed as blocked.

## Survey scripts

Scripts live in `scripts[]` with a scope and an event:

```json
{ "id": "s1", "name": "Derive segment", "scope": "page", "ref": "p3", "event": "on_submit", "enabled": true,
  "code": "const n = Number(get('Q5.count')); set('SEGMENT', n >= 3 ? 'heavy' : 'light'); if (get('Q1') < 18) error('Under 18 — this should have screened out', 'Q1');" }
```

`scope` is `survey`, `page` or `question` (with `ref`); `event` is `on_load`, `on_change`, `on_submit`, `on_validate` or `on_complete`; `when` gates it. The body runs in strict mode with these destructured names available: `get(ref)`, `set(ref, v)`, `getCalc(name)`, `setCalc(name, v)`, `getEmbedded(name)`, `setEmbedded(name, v)`, `expr(expression)` (evaluate a calculation), `pipe(text)` (resolve piping), `flag(name)`, `log(...)`, `error(message, questionRef?)` (fails validation with the message), the loop helpers `loop`, `getCurrentLoopItem(scope?)`, `getCurrentLoopIndex(scope?)`, `getLoopCount(scope?)`, `getCurrentLoopReference(name, scope?)`, `getLoopItems(scope?)`, `getLoopAnswer(ref, itemCode, scope?)`, and the lookups `getElement(id)`, `getQuestion(ref)`, `getOption(id)`, `getRow(id)`, `getColumn(id)`, `getGroup(id)`. A `custom_script` validation rule runs the same way with `value` as the answer under test — **in the respondent's browser only**.

**Where they run (since S1b).** Logic scripts run in a sandboxed frame — one per page, created only when the page has scripts to run — never on the respondent's page itself. The frame gets the code (after the script check below) and a copy of what the helpers read; the helpers behave as they always did, with three differences:

- **Writes are requests, applied after the script returns.** `set`, `setCalc`, `setEmbedded` and `flag` are collected while the script runs and then applied in order by the survey with the same checks as `rs.setAnswer` (below): who may write what, values that fit the question (real option codes, numbers…), size limits. A refused write is logged with the reason (`[<script name>] set("Q2") refused: Q2 is on screen — …`). Inside the run a later `get` / `getCalc` sees the script's own earlier writes (and so does the next script of the same event), even one the survey then refuses. A calculated variable may hold a list or a record (`setCalc('INVALID_BRANDS', [{ code, label }])`).
- **Events are asynchronous and bounded.** `on_change` runs a moment (about 0.1 s) after the question stops changing, and before Next is handled; `on_validate` and `on_submit` run on Next and may take at most 1.5 s (a script that does not answer in time counts as "no error" and is logged); survey `on_load` runs before the first page is shown (at most 3 s); `on_complete` before the final save (at most 3 s). `error(message, ref)` is shown like a built-in validation message, on the question `ref` names (id, code or variable name) or as a page message.
- **`expr()` and `pipe()` need their text written out** (`expr('Q1 + Q2')`, `pipe("Hi {{Q1}}")`): the survey evaluates literal arguments before the run. A computed argument returns `null` / the text unchanged, logged.

For one release, `RUNTIME_LEGACY_SCRIPTS=main` in the runtime's environment (read when it is built or started) brings back the old in-page runner; it is a temporary rollback switch, not a setting. When the server re-checks a saved page it never executes author code: a `custom_script` rule is recorded as a client-only check there and cannot refuse the save on its own. A script with `enabled: false` never runs, as a rule or on its event.

**The script check.** Survey scripts are code from outside the platform, so their code is checked when it is saved (the Scripts panel shows the reasons and does not save refused code, and a refused script cannot be switched on), when it is imported (QSF and other imports keep custom code switched off, "pending review", with `Script check: passes` or `Script check: refused — <reason>` at the start of its notes; a definition pasted in the JSON view or created from a payload has any refused script switched off, with the reason in its notes), and again every time it would run. A script reaches the survey through the helpers above only: no `constructor`, `__proto__`, `prototype`, `globalThis`, `window`, `document`, `self`, `top`, `parent`, `location`, `Function`, `eval`, `import`, `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator`, `document.cookie`, storage, `postMessage`, `Reflect`, `Proxy`, `with`, `setInterval`, `setTimeout`; no computed access on a name the script did not declare (`Math[k]`, `navigator["send" + "Beacon"]`) and no property name built by joining strings. Loops are allowed when their body has braces and are stopped after 100,000 rounds. A refused script does not run: the preview inspector shows `[<script name>] refused: <reason>` and the browser console `[rescript:script] [<script name>] refused: …` (the only place it shows in a live interview); a refused `custom_script` rule does not hold the respondent. The host also shadows `window`, `document`, `fetch`, timers and storage to `undefined`; the sandboxed frame (opaque origin, no network) is the boundary. `on_load` fires once per session for survey scripts and per page for page scripts; `on_change` when a question changes (the question's own scripts and its page's); `on_validate` and `on_submit` when a page is submitted (the page's scripts and those of every question on it, on_validate first); `on_complete` at the end. A survey-scoped script runs on every occurrence of its event.

## The UX layer

The UX layer (`ux` in the definition) changes how the survey looks and behaves without touching questions or logic: it is what Intelligent mode writes for "make the Q4 options look like cards", "fade in each question in Block 2 one at a time", "when someone picks Other, expand the text box smoothly", "on mobile stack Q7's options".

**Targets** name what a style or behaviour applies to, in a small grammar: `"Q5"`, `"Q5.options"`, `"Q5.option:3"`, `"Q5.row:r1"`, `"Q5.title"`, `"block:Brand"`, `"block:2.questions"`, `"page:3"`, `"next"`, `"back"`, `"submit"`, `"buttons"`, `"progress"`, `"progress.fill"`, `"nav"`, `"survey"`, `"questions"`, `"options"`.

In the definition a target is an object — `{ "kind": "option", "questionId": "q_pref", "code": "97" }`, `{ "kind": "question", "questionId": "q_pref", "part": "options" }`, `{ "kind": "button", "button": "next" }` — with kinds `survey, block, page, question, option, row, column, button, progress, navigation, component`, parts `card, title, instruction, options, input, other_text, media, error, fill, label`, and `blockId` / `pageId` to narrow. The actions take the string grammar and resolve it.

**A style** is a target with declarations (CSS property names, kebab or camel case), optionally per state (`hover, focus, selected, answered, disabled`) and per media (`mobile, tablet, desktop, reduced_motion`):

```json
{ "id": "st1", "label": "Card options on Q4", "target": { "kind": "question", "questionId": "q_pref", "part": "options" },
  "rules": [{ "declarations": { "display": "grid", "grid-template-columns": "1fr 1fr", "gap": "12px" } },
            { "media": "mobile", "declarations": { "grid-template-columns": "1fr" } },
            { "state": "selected", "declarations": { "border-color": "#2563eb" } }] }
```

Declarations are checked against the CSS property grammar and a ban-list (no `behavior`, no `expression()`, no external `url()`); `!important` is warned about; the compiled CSS is scoped to the target. A style can also carry raw `css` text, scoped so that `&` is the target.

**An animation** is a preset on a target with a trigger: presets `fade-in, fade-up, fade-down, slide-left, slide-right, scale-in, pop, pulse, shake, bounce, wiggle, highlight, glow, expand`; triggers `appear, page_enter, hover, focus, select, answer`; `durationMs`, `delayMs`, `easing`, `staggerMs`, `iterations`, `media`.

**A behaviour** reacts to an event on a target with effects — `add_class, remove_class, toggle_class, animate, set_style, show, hide, show_message, hide_message, scroll_into_view, focus` — or with a script:

```json
{ "id": "bh1", "label": "Expand the Other box", "target": { "kind": "option", "questionId": "q_pref", "code": "97" }, "on": "select_option",
  "effects": [{ "do": "animate", "target": { "kind": "question", "questionId": "q_pref", "part": "other_text" }, "preset": "expand", "durationMs": 300 },
               { "do": "focus", "target": { "kind": "question", "questionId": "q_pref", "part": "other_text" } }] }
```

A behaviour's `script` is the survey's JavaScript. It runs in one sandboxed iframe per script (`sandbox="allow-scripts"`, opaque origin, no storage, and a frame Content-Security-Policy of `default-src 'none'`, so the frame itself can make no request) against **two things**. What a script changes reaches the real survey page only through the host, and the host refuses any style a script sets that would make that page load something (`url()`, `image-set()`, `@import`, `expression()`) — so a script cannot send data out through the page either:

1. the frozen `rs` api: `rs.listen(event, target | "self", fn)`, `rs.getAnswer(code)`, `rs.getQuestion(code)`, `rs.getBlock()`, `rs.getPage()`, `rs.addClass`, `rs.removeClass`, `rs.toggleClass`, `rs.animate`, `rs.setStyle`, `rs.clearStyle`, `rs.show`, `rs.hide`, `rs.showMessage`, `rs.hideMessage`, `rs.scrollTo`, `rs.focus` (each takes a target first), `rs.after(ms, fn)`, `rs.log(...)`, `rs.popup(text, {title, placement, target, dismiss})`, `rs.closePopup()`, the navigation requests `rs.goToPage(pageIdOrCode)` and `rs.goToSection(blockIdOrTitle)` (below), the reads `rs.getAnswer(code, loopKey?)`, `rs.getEmbedded(name)`, `rs.getCalc(name)`, and the write requests `rs.setAnswer(code, value, loopKey?)`, `rs.setEmbedded(name, value)`, `rs.setCalc(name, value)`, `rs.flag(name)` (below). Events: `answer, change, select, deselect, click, hover, page, complete, validate, submit` (with aliases such as `page_enter` → `page`, `select_option` → `select`);
2. **the page's own DOM** — a live mirror of the page the script is for: `document.querySelector` / `querySelectorAll` / `closest` / `matches`, `classList`, `style`, `dataset`, `getAttribute` / `setAttribute`, `textContent`, `MutationObserver` and `addEventListener` on any element or on `document` all behave as written. Real clicks, input, change, focus and key events are forwarded to the listeners a script registered, **once per event**.

`rs.listen` and the DOM api coexist in the same script; they do not double-fire.

**Navigation from a script.** A script cannot press Next or Back, and never could. It can ASK the survey to go somewhere: `rs.goToPage("p3")` (a page id, one loop iteration `p3@apple`, or the code of a question on the page) and `rs.goToSection("Geography")` (a flow block id or its title). The request goes to the survey, which checks it with **the same rule as the built-in section navigator** (Survey Settings → Navigation): going back to an earlier page is always allowed (unless the survey has no navigator and hides Back); going forward is allowed only to sections already visited (`visited` — every page in between must validate, as if Next were pressed) or, with `free`, to any page reachable with the current answers — never a page hidden by logic, never past an end, a quota check or a skip rule that fires. A refused request leaves the respondent where they are and is logged with the reason (`rs.goToSection("Polity") refused: You can only jump to sections you have already visited.`) to the browser console and the preview inspector. For a bar of section buttons, use the built-in navigator rather than building one in a script.

```js
// a "jump to Geography" link under the History intro
const a = document.createElement("button");
a.textContent = "Go to Geography";
a.addEventListener("click", () => rs.goToSection("Geography"));
document.querySelector('[data-qid="q_hist_intro"]').appendChild(a);
```

**Writing from a script — a request the survey checks.** A script never writes the response itself. `rs.setAnswer("Q7", 3)`, `rs.setEmbedded("SOURCE", "panel")`, `rs.setCalc("CLICKS", 4)` and `rs.flag("speeder")` each ASK the survey, which decides with the engine and answers with a promise of `{ ok, reason }` (it never rejects). An accepted write takes **the respondent's own path**: punch rules and calculations that read the value recompute, validation sees it on Next, and the save and the server's replay treat it like any answer. Each accepted write is recorded with the response (`scriptWrites`: which script, which target, when — never the value), so script-made values can be told from the respondent's. A refused write changes nothing and is logged with the reason (`rs.setAnswer("Q2") refused: Q2 is on screen — …`).

- **Who may write what.** Any script may write hidden targets: a hidden variable (or a question set hidden), an embedded field declared in the flow, a calculated variable. Any script — whatever it is attached to (a question, a page, a block or the survey) — may write any question the respondent is **not** looking at at that moment, on any page or block. A script attached to a question may also write **that question**, even while it is on screen. The one refusal: no script may change a question the respondent is looking at unless it is attached to that question — no silent overwrites of what the respondent sees.
- **What fits.** The value must fit the question: a real option code (a list of distinct codes for a multi-select or a ranking), a number for a number, text for text, an object keyed by real row codes for a grid (cells by real column ids), numbers keyed by option code for an allocation. Choice tasks, points on an image, places, uploads and recorded interviews are the respondent's alone. A calculated question with an expression, a calculation that recomputes on every change and a hidden variable whose punch rule says `recompute: always` are refused — the engine would overwrite the value at once. A text value is at most 10,000 characters. Inside a loop the page's iteration is used; `loopKey` (`"apple"`, `"apple@pro"`) names another.
- **Native first.** A starting answer is a **default value**, an answer that follows other answers is a **punch rule**, a computed value is a **calculation** — the survey applies those itself, on every device and in the server's replay. Use `rs.setAnswer` for what only code can know: seconds spent, a count of clicks, something the script measured. (Intelligent Mode refuses `rs.setAnswer` with a fixed value and proposes the default value instead.)

```js
// count the times the respondent replayed the clip, into the hidden variable PLAYS
let plays = 0;
document.querySelector('[data-qid="q_ad"] video')?.addEventListener("play", () => {
  rs.setAnswer("PLAYS", ++plays).then((r) => { if (!r.ok) rs.log("not stored:", r.reason); });
});
```

Use the real hooks — a selector that matches nothing is logged to the console with the one to use: the Next/Submit button is `[data-testid="rs-next"]`, Back `[data-testid="rs-back"]`, a question's card `[data-qid="<question id>"]`, an option `[data-rs-el="option"]`, the navigation row `.rs-nav`, the progress bar `.rs-progress-fill`. (`.next-button`, `#next` and `.question` do not exist.)

**Lifecycle.** A script runs when the page it is for is shown, after its elements exist, and again after every Next/Back that shows that page. Handlers and changes survive React re-rendering the survey (the mirror keeps node identity; the host re-applies a script's classes and attributes). When the page is left, a click on Next that was already on its way is handled once, then the frame is removed and **everything the script changed is put back** — so scripts do not accumulate across navigation. A script on the survey runs on every page; on a question, on the page that shows it.

**What it may change** (every change is checked by the host, not trusted): add and remove class names (never the survey's own `rs-…` ones), set inline styles through the CSS declaration gate (a style set from a script may not load anything — no `url()`, `image-set()`, `@import` or `expression()`; an image belongs in the Style panel or the question's media), set `hidden`, `disabled`, `title`, `role`, `tabindex`, `aria-*` and `data-*` attributes (never `hidden` / `disabled` — nor `display: none`, `visibility: hidden` or `pointer-events: none` — on an answer input, an option, or a required question's card: the respondent must be able to answer; `rs.hide` on an answered question works but warns that the answer stays stored), and create plain elements of its own (`div`, `span`, `p`, `button`, headings, lists…) that it can later change or remove.

**What it may not** — and the reason is logged: set an answer through the page (`.value`, `.checked`, `dispatchEvent` on a form control change nothing — use a default value, a punch rule, or `rs.setAnswer` above), rewrite text the survey drew (create your own element, or `rs.showMessage`), create `<script>`, `<iframe>`, `<link>`, `<style>` or event-handler attributes, change `href`/`src`, reach `window`, `fetch`, `XMLHttpRequest`, `localStorage`, `eval`, `Function`, `constructor`, bare `parent` / `top` / `self`, or read `document.cookie`. `preventDefault()` has no effect (the event has already happened: use validation to stop a page being left). Layout measurements (`offsetWidth`, `getBoundingClientRect`) read as 0 — the mirror has no layout. Commands are rate-limited (200 a second).

**Promise chains are bounded too, and a frame that stops answering is stopped.** Inside the sandbox, `then` / `catch` / `finally` callbacks and `queueMicrotask` count like loop iterations: a chain that passes 10,000 steps in one go (`function f() { Promise.resolve().then(f); }`) is cut off with an error naming the script (`await` on a native promise is not counted). The page pings each script's frame every 2 seconds; a frame that misses three pings in a row while the page is shown is removed, everything it changed is put back, and `stopped: not responding` is logged. That only helps when the browser runs the sandboxed frame in its own process; a frame that shares the page's thread (headless Chromium by default) freezes the page and its timer alike. Regular expressions are not checked for catastrophic backtracking.

**Loops are bounded, not banned.** `for`, `while`, `do…while`, `for…of` are fine when their body has braces (`for (const el of document.querySelectorAll(…)) { … }`); every loop counts its iterations and a loop that passes 100,000 in one go is stopped with an error naming the script (the rest of the survey is unaffected). A loop without braces (`while (x) y();`) is refused when saved, with the fix.

**Errors say where they came from.** A script that fails the gate (`not run: …`), throws, runs away, or is refused a change logs `[rescript:script] <script name> (<question>): <reason>` to the browser console and to the preview's inspector; in the Studio editor the same checks run as you type, with the warnings (a selector that matches nothing, a handler registered twice, a script that touches neither `rs` nor `document`).

Intelligent mode writes scripts through the same gate: `create_behavior` with a `script`, or `set_custom_code` with `js` (which creates or replaces that question's script; `css` still edits Custom CSS). A script the gate refuses is refused on the proposal card with the reason.

```js
rs.listen("answer", "Q5", ({ value }) => {
  if (Number(value) <= 6) rs.showMessage("Q5", "Sorry to hear that — the next question asks why.");
  else rs.hideMessage("Q5");
});
```

The engine reviews the UX layer (`reviewUx`): a target that names nothing, a declaration outside the allow-list, an animation on a reduced-motion setting, a behaviour that would never fire.

## The respondent page's Content-Security-Policy

Respondent pages are served with a Content-Security-Policy that limits where the page may send anything: `connect-src` is the runtime itself plus the origins it really uses, built from its environment when it starts (the Supabase URL, the media storage endpoint, the realtime-voice provider, the live-session server, and any origin the operator lists in `RUNTIME_CSP_CONNECT`). A `fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket` or `EventSource` to anywhere else — from a script, a component, or anything that slipped past a check — is blocked by the browser. The policy also sets `form-action 'self'`, `base-uri 'self'` and `object-src 'none'`. Images, media and scripts are not restricted (author images from anywhere keep working); a stricter policy for those is sent as report-only, and its findings appear in the browser console only. Operators set `RUNTIME_CSP=enforce` (default), `report` (nothing blocked) or `off`.

## Branding code

`branding.headerHtml` and `footerHtml` wrap every page; `branding.customCss` styles the whole survey; survey JavaScript is a survey-level script in the UX layer (a saved `branding.customJs` was moved there on load). Theme colours, typography, layout, buttons and voice settings are structured fields (`branding.colors`, `typography`, `layout`, `buttons`, `voice`) — Intelligent mode edits them with `set_theme` ("change the theme to dark blue", "use a warmer palette like this logo").

## Which surface to use

For a look or a behaviour a researcher will want to review and a translator will not need to touch: the UX layer. For JavaScript of any kind — listening to the Next button, counting clicks, reacting to an answer — a script in the UX layer. For a component the platform has no variant for: `custom_component` with `customHtml` / `customJs`. For data derived at a point in the flow: a calculation or a punch before a script. For a check across several questions at submit: a `custom_script` validation rule or a page script with `error(...)`.
