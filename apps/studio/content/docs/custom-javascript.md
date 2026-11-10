---
summary: Survey JavaScript as UX-layer scripts — the rs API, the page DOM mirror, events, writes as checked requests — and logic scripts
related: custom-css, custom-html-components, custom-code
status: available
---
# Custom JavaScript

JavaScript in ResLens.ai lives in **scripts in the UX layer** (Properties → **Styles, animations & scripts**) and, for data logic, in the **Scripts panel**. Every script runs **in a sandboxed frame**, never on the respondent's page itself; what it changes reaches the survey only through checked requests.

## When to use it

- Behaviour the built-in effects cannot express: reacting to answers with custom messages, counting clicks, custom widgets.
- First check the no-code options: styles, animations and **behaviours** (show / hide / message / animate effects on events) cover most needs without code.
- Data derivation is usually better as a [calculation or auto-punch](conditional-logic).

## Set it up in the builder

::: steps Add a script that reacts to an answer
1. **Open the question** → Properties → **Styles, animations & scripts**.
2. **Add a behaviour with a script** — give it a label; the script runs for this question.
3. **Write it against the rs API** — `rs.listen('change', 'self', fn)`, `rs.getAnswer('Q1')`, `rs.showMessage('Q1', '…')`.
4. **Save** — the script is checked when it is saved; refused code is not saved, with the reasons shown.
5. **Test it** — in **Preview** or **Test Survey**. Failures in the field appear under script health.
:::

::: example custom-javascript

## How it is stored

```json
{ "label": "Cheer up message", "target": { "kind": "question", "questionId": "q_1" },
  "script": "rs.listen('change', 'self', () => { … })" }
```

```js
rs.listen('change', 'self', () => {
  const a = rs.getAnswer('Q1');
  if (a === 3) rs.showMessage('Q1', 'Sorry to hear that — thanks for still taking part!');
  else rs.hideMessage('Q1');
});
```

The `rs` API includes `listen`, `getAnswer`, `getQuestion`, `addClass` / `removeClass` / `toggleClass`, `animate`, `setStyle`, `show` / `hide`, `showMessage` / `hideMessage`, `scrollTo`, `focus`, `after(ms, fn)`, `popup`, `log`, and the navigation requests `goToPage` / `goToSection`. Where a script may write (`rs.setAnswer`, `rs.setEmbedded`…), the write is a request that the survey checks before applying — the editor shows what each script reads and writes. The page's DOM is available as a live mirror (`document.querySelector`, `addEventListener`…).

**Logic scripts** (Programming → **Scripts**) run on events (`on_load`, `on_change`, `on_submit`, `on_validate`, `on_complete`) with `get`, `set`, `setCalc`, `setEmbedded`, `error(message, ref)` and loop helpers.

## What the respondent sees

Choosing “Not great” shows the message under the question; choosing another answer hides it. The live example runs the script in its sandbox exactly as a survey link does.

::: warning What scripts cannot do
No `fetch`, `XMLHttpRequest`, `window`, `eval`, timers outside `rs.after`, storage or page globals — the script check refuses them, and the respondent page's Content-Security-Policy blocks requests to other sites. Old "Custom JavaScript" from earlier surveys was moved into the UX layer; code the sandbox will not run is listed in **Code that will not run**.
:::

## Common mistakes

- **Using code for what a behaviour does** — a show / hide / message effect needs no code and is easier to review.
- **Writing answers directly** — use `rs.setAnswer` (a request the survey checks) instead of changing inputs in the DOM.

## Troubleshooting

- *The script does nothing* — open **Test Survey**: the inspector and the browser console log script errors and refused writes with the script's name.
