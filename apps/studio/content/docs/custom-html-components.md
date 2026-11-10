---
summary: HTML blocks with piping and scoped styles, HTML in any text, the header and footer, and Custom Component questions with their own code
related: custom-javascript, custom-css, piping
status: available
---
# Custom code: HTML and components

HTML can go anywhere text goes — question text, instructions, option labels — and into **Text / HTML blocks**, the survey header and footer, and **Custom Component** questions that bring their own HTML, CSS and JavaScript.

## When to use it

- Instructions, section intros and consent text with formatting (an HTML block).
- A widget the platform has no question type for (a Custom Component).
- Branded headers and footers (Branding).

## Set it up in the builder

::: steps Add an HTML block with a pipe
1. **Add the block** — **+ Add question** → family **Content / Hidden** → **Text / HTML Block**.
2. **Write the content** — in the rich-text editor, or switch to **HTML** to write markup.
3. **Pipe answers** — `{{Q1}}` works inside HTML.
4. **Style just this block** — a `<style>` element inside the HTML is scoped to the block.
5. **Need a widget?** — use a **Custom Component** question: its HTML is drawn on the page and its code runs in a sandboxed frame with `el` (its element) and `api.getValue()` / `api.setValue(v)` / `api.onChange(fn)`.
:::

::: example custom-html-components

## How it is stored

```json
{ "code": "INFO", "type": "html", "variant": "content.html",
  "text": "<h3>Thanks, {{NAME}}!</h3><p>The next section is about <b>your last purchase</b>.</p><style>h3 { color: #4f46e5; }</style>" }
```

A Custom Component: `{ "type": "custom_component", "customHtml": "…", "customJs": "…", "customCss": "…" }` — its code is checked when saved and runs sandboxed.

## What the respondent sees and the data you get

The formatted text with the name piped in. An HTML block stores no answer; a Custom Component stores what its code sets with `api.setValue`.

::: note Sanitised by design
Author HTML is sanitised when it is drawn: `<script>` elements, event handlers (`onclick`…) and `javascript:` links are removed. Use a UX-layer script for behaviour.
:::

## Common mistakes

- **Putting scripts in HTML** — they are removed; put JavaScript in a UX script or a Custom Component.
- **Unscoped styles in a component's Custom CSS** — prefix them with the question's selector.

## Troubleshooting

- *Markup shows as text* — the editor was in Visual mode; switch to **HTML** before pasting markup.
