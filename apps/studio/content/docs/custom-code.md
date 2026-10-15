# Custom code

Four surfaces take code: HTML in questions and blocks, per-question CSS, survey scripts with an event and an API, and the UX layer — styles, animations and **scripts**. There is exactly one place survey JavaScript lives: a script in the UX layer (Properties → **Styles, animations & scripts**). The old per-question and branding "Custom JavaScript" fields are gone — a saved survey that had one is moved there on load, unchanged. This page says which surface to use.

## HTML

An `html` question (`content.html`) is a block of text or HTML with no answer. Any question's `text`, `instruction` and option labels take HTML too. Author HTML is sanitised: scripts, event handlers and `javascript:` URLs are removed; a `<style>` block inside the HTML is scoped to the question it belongs to (so `body { … }` in a block styles that block, not the page). Piping tokens work inside HTML.

A `custom_component` question renders `customHtml` (piped) and runs `customJs` against it — see below.

## Per-question CSS, and component code

```json
{ "id": "q_slider", "code": "Q8", "variableName": "MOOD", "type": "custom_component", "text": "How do you feel today?",
  "customHtml": "<div class=\"mood\"><button data-v=\"1\">😞</button><button data-v=\"3\">😐</button><button data-v=\"5\">😀</button></div>",
  "customJs": "el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { api.setValue(Number(b.dataset.v)); el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); }));",
  "customCss": ".mood button.on { outline: 3px solid #2563eb; }" }
```

`customCss` is injected as a `<style>` inside the question card and is **not scoped** (a rule in it applies to the whole page): prefix your selectors with the card's attribute, `[data-qid="q_slider"] .mood button { … }`, to keep them to the question. It lives in Properties → Styles, animations & scripts → Custom CSS.

A **Custom Component** (`type: "custom_component"`) is the one question type whose `customJs` is not a script attached to something: it *is* the component. It runs as `new Function("el", "api", code)` against its own `customHtml`: `el` is the container and `api` is `{ getValue(), setValue(v) }`; whatever `setValue` is given is the stored answer. That code runs with full access to the page, so use it only for an answer control the platform has no variant for. Everything else — a look, a reaction, a counter, a nudge — is a script (below). In Properties it has its own "Component code" section.

### Moved from the old Custom code

Surveys saved before the consolidation are migrated on load (and idempotently — a second load changes nothing):

- a question's `customJs` becomes a script on that question (`source: "question_custom_js"`), wrapped so `el` is still the question card and `api.getValue()` still reads the answer. `api.setValue` cannot be kept (scripts never write answers — use a default value or a punch rule) and logs why when called;
- `branding.customJs` becomes a survey-level script (`source: "branding_custom_js"`);
- code the script sandbox will not run as written (it calls `fetch`, touches `window`, writes an answer…) is **still moved, never dropped or run unsandboxed**; its script shows the reason in Properties and the browser console names it at run time. Code over 20,000 characters stays in its original field and is listed as blocked.

## Survey scripts

Scripts live in `scripts[]` with a scope and an event:

```json
{ "id": "s1", "name": "Derive segment", "scope": "page", "ref": "p3", "event": "on_submit", "enabled": true,
  "code": "const n = Number(get('Q5.count')); set('SEGMENT', n >= 3 ? 'heavy' : 'light'); if (get('Q1') < 18) error('Under 18 — this should have screened out', 'Q1');" }
```

`scope` is `survey`, `page` or `question` (with `ref`); `event` is `on_load`, `on_change`, `on_submit`, `on_validate` or `on_complete`; `when` gates it. The body runs in strict mode with these destructured names available: `get(ref)`, `set(ref, v)`, `getCalc(name)`, `setCalc(name, v)`, `getEmbedded(name)`, `setEmbedded(name, v)`, `expr(expression)` (evaluate a calculation), `pipe(text)` (resolve piping), `flag(name)`, `log(...)`, `error(message, questionRef?)` (fails validation with the message), the loop helpers `loop`, `getCurrentLoopItem(scope?)`, `getCurrentLoopIndex(scope?)`, `getLoopCount(scope?)`, `getCurrentLoopReference(name, scope?)`, `getLoopItems(scope?)`, `getLoopAnswer(ref, itemCode, scope?)`, and the lookups `getElement(id)`, `getQuestion(ref)`, `getOption(id)`, `getRow(id)`, `getColumn(id)`, `getGroup(id)`. A `custom_script` validation rule runs the same way with `value` as the answer under test.

The host shadows `window`, `document`, `fetch`, timers and storage to `undefined`; scripts are not time-boxed and this is not a security boundary — the author of a survey is trusted. `on_load` fires once per session for survey scripts and per page for page scripts; `on_change` when a question changes (the question's own scripts and its page's); `on_validate` and `on_submit` when a page is submitted (the page's scripts and those of every question on it, on_validate first); `on_complete` at the end. A survey-scoped script runs on every occurrence of its event.

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

A behaviour's `script` is the survey's JavaScript. It runs in one sandboxed iframe per script (`sandbox="allow-scripts"`, opaque origin, no network, no storage) against **two things**:

1. the frozen `rs` api: `rs.listen(event, target | "self", fn)`, `rs.getAnswer(code)`, `rs.getQuestion(code)`, `rs.getBlock()`, `rs.getPage()`, `rs.addClass`, `rs.removeClass`, `rs.toggleClass`, `rs.animate`, `rs.setStyle`, `rs.clearStyle`, `rs.show`, `rs.hide`, `rs.showMessage`, `rs.hideMessage`, `rs.scrollTo`, `rs.focus` (each takes a target first), `rs.after(ms, fn)`, `rs.log(...)`. Events: `answer, change, select, deselect, click, hover, page, complete` (with aliases such as `page_enter` → `page`, `select_option` → `select`);
2. **the page's own DOM** — a live mirror of the page the script is for: `document.querySelector` / `querySelectorAll` / `closest` / `matches`, `classList`, `style`, `dataset`, `getAttribute` / `setAttribute`, `textContent`, `MutationObserver` and `addEventListener` on any element or on `document` all behave as written. Real clicks, input, change, focus and key events are forwarded to the listeners a script registered, **once per event**.

`rs.listen` and the DOM api coexist in the same script; they do not double-fire.

Use the real hooks — a selector that matches nothing is logged to the console with the one to use: the Next/Submit button is `[data-testid="rs-next"]`, Back `[data-testid="rs-back"]`, a question's card `[data-qid="<question id>"]`, an option `[data-rs-el="option"]`, the navigation row `.rs-nav`, the progress bar `.rs-progress-fill`. (`.next-button`, `#next` and `.question` do not exist.)

**Lifecycle.** A script runs when the page it is for is shown, after its elements exist, and again after every Next/Back that shows that page. Handlers and changes survive React re-rendering the survey (the mirror keeps node identity; the host re-applies a script's classes and attributes). When the page is left, a click on Next that was already on its way is handled once, then the frame is removed and **everything the script changed is put back** — so scripts do not accumulate across navigation. A script on the survey runs on every page; on a question, on the page that shows it.

**What it may change** (every change is checked by the host, not trusted): add and remove class names (never the survey's own `rs-…` ones), set inline styles through the CSS declaration gate, set `hidden`, `disabled`, `title`, `role`, `tabindex`, `aria-*` and `data-*` attributes, and create plain elements of its own (`div`, `span`, `p`, `button`, headings, lists…) that it can later change or remove.

**What it may not** — and the reason is logged: set an answer (`.value`, `.checked`, `dispatchEvent` on a form control — set a default value or a punch rule instead), rewrite text the survey drew (create your own element, or `rs.showMessage`), create `<script>`, `<iframe>`, `<link>`, `<style>` or event-handler attributes, change `href`/`src`, reach `window`, `fetch`, `XMLHttpRequest`, `localStorage`, `eval`, `Function`, `constructor`, bare `parent` / `top` / `self`, or read `document.cookie`. `preventDefault()` has no effect (the event has already happened: use validation to stop a page being left). Layout measurements (`offsetWidth`, `getBoundingClientRect`) read as 0 — the mirror has no layout. Commands are rate-limited (200 a second).

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

## Branding code

`branding.headerHtml` and `footerHtml` wrap every page; `branding.customCss` styles the whole survey; survey JavaScript is a survey-level script in the UX layer (a saved `branding.customJs` was moved there on load). Theme colours, typography, layout, buttons and voice settings are structured fields (`branding.colors`, `typography`, `layout`, `buttons`, `voice`) — Intelligent mode edits them with `set_theme` ("change the theme to dark blue", "use a warmer palette like this logo").

## Which surface to use

For a look or a behaviour a researcher will want to review and a translator will not need to touch: the UX layer. For JavaScript of any kind — listening to the Next button, counting clicks, reacting to an answer — a script in the UX layer. For a component the platform has no variant for: `custom_component` with `customHtml` / `customJs`. For data derived at a point in the flow: a calculation or a punch before a script. For a check across several questions at submit: a `custom_script` validation rule or a page script with `error(...)`.
