# Custom code

Four surfaces take code: HTML in questions and blocks, per-question CSS and JavaScript, survey scripts with an event and an API, and the UX layer — styles, animations and behaviours with a sandboxed script API. They differ in power and in what they can reach; this page says which to use.

## HTML

An `html` question (`content.html`) is a block of text or HTML with no answer. Any question's `text`, `instruction` and option labels take HTML too. Author HTML is sanitised: scripts, event handlers and `javascript:` URLs are removed; a `<style>` block inside the HTML is scoped to the question it belongs to (so `body { … }` in a block styles that block, not the page). Piping tokens work inside HTML.

A `custom_component` question renders `customHtml` (piped) and runs `customJs` against it — see below.

## Per-question CSS and JavaScript

```json
{ "id": "q_slider", "code": "Q8", "variableName": "MOOD", "type": "custom_component", "text": "How do you feel today?",
  "customHtml": "<div class=\"mood\"><button data-v=\"1\">😞</button><button data-v=\"3\">😐</button><button data-v=\"5\">😀</button></div>",
  "customJs": "el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { api.setValue(Number(b.dataset.v)); el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); }));",
  "customCss": ".mood button.on { outline: 3px solid #2563eb; }" }
```

`customJs` runs as `new Function("el", "api", code)`: `el` is the container (`customHtml` rendered, for a custom component; the question card for any other type) and `api` is `{ getValue(), setValue(v) }` — plus `api.question = { id, code, type }` on ordinary questions. Whatever `setValue` is given is the stored answer. `customCss` is injected as a `<style>` inside the question card and is **not scoped** (a rule in it applies to the whole page): prefix your selectors with the card's attribute, `[data-qid="q_slider"] .mood button { … }`, to keep them to the question. In Intelligent mode: "set the custom code of Q8 to …" (`set_custom_code`).

This code runs with full access to the page. Use it for a component the platform has no variant for; for look and behaviour, prefer the UX layer below, which is sandboxed and reviewable.

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

A behaviour's `script` runs in a sandboxed iframe (`sandbox="allow-scripts"`, no network, no DOM) as `new Function("rs", code)` with a frozen `rs`: `rs.listen(event, target | "self", fn)`, `rs.getAnswer(code)`, `rs.getQuestion(code)`, `rs.getBlock()`, `rs.getPage()`, `rs.addClass`, `rs.removeClass`, `rs.toggleClass`, `rs.animate`, `rs.setStyle`, `rs.clearStyle`, `rs.show`, `rs.hide`, `rs.showMessage`, `rs.hideMessage`, `rs.scrollTo`, `rs.focus` (each takes a target first), `rs.after(ms, fn)`, `rs.log(...)`. Events: `answer, change, select, deselect, click, hover, page, complete` (with aliases such as `page_enter` → `page`, `select_option` → `select`). The script cannot set answers, loop, or reach `document`, `window`, `fetch` or `eval`; those are refused when it is saved, and commands are rate-limited.

```js
rs.listen("answer", "Q5", ({ value }) => {
  if (Number(value) <= 6) rs.showMessage("Q5", "Sorry to hear that — the next question asks why.");
  else rs.hideMessage("Q5");
});
```

The engine reviews the UX layer (`reviewUx`): a target that names nothing, a declaration outside the allow-list, an animation on a reduced-motion setting, a behaviour that would never fire.

## Branding code

`branding.headerHtml` and `footerHtml` wrap every page; `branding.customCss` styles the whole survey; `branding.customJs` runs once per session with full page access. Theme colours, typography, layout, buttons and voice settings are structured fields (`branding.colors`, `typography`, `layout`, `buttons`, `voice`) — Intelligent mode edits them with `set_theme` ("change the theme to dark blue", "use a warmer palette like this logo").

## Which surface to use

For a look or a behaviour a researcher will want to review and a translator will not need to touch: the UX layer. For a component the platform has no variant for: `custom_component` with `customHtml` / `customJs`. For data derived at a point in the flow: a calculation or a punch before a script. For a check across several questions at submit: a `custom_script` validation rule or a page script with `error(...)`.
