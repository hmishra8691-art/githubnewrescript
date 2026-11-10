---
summary: Colours — the primary, secondary, background and surface colours, the text and border colours, and separate colours for buttons, progress, links, headings and inputs
related: branding-overview, typography, backgrounds
status: available
---
# Brand colours

Four colours set the whole look — **primary** (selected answers, focus, and by default buttons and the progress bar), **secondary**, **background** (the page) and **surface** (the question cards). The text, subtle-text, border and error colours complete the palette.

Under **More** you can separate individual elements from the primary colour: **button background** and **button text**, **progress**, **accent**, **link**, **heading** and **input background**. Each is optional — left empty, it follows its fallback (the button background follows the primary; the progress and links follow the accent, which follows the primary; headings follow the text colour), so you only set the ones that must differ.

## When to use it

- Matching a client's brand palette.
- Making buttons or the progress bar a different colour from selected answers.
- Fixing contrast: the **contrast check** under Colours warns about pairs that are hard to read.

## Set it up in the builder

::: steps Set your brand colours
1. **Open Branding → Colours**.
2. **Set the four main colours** — type a hex value or pick it.
3. **Open More** — set **Button background** and **Progress** if they should differ from the primary.
4. **Read the contrast check** — fix any pair it flags.
5. **Check the preview** — select answers and look at the buttons.
:::

::: example theme-colours

## How it is stored

```json
{ "branding": { "colors": { "primary": "#0f766e", "secondary": "#134e4a", "background": "#f0fdfa", "surface": "#ffffff",
  "text": "#0f172a", "border": "#99f6e4", "buttonBackground": "#134e4a", "progress": "#14b8a6" } } }
```

Accepted values: hex (`#0f766e`), `rgb()` / `rgba()`, `hsl()` / `hsla()` and colour names.

## Common mistakes

- **Light text on a light surface** — set **text** for the cards' colour, not the page's.
- **Setting every element colour** — leave the optional ones empty unless they must differ; they then follow the primary when it changes.

## Troubleshooting

- *A colour is refused* — it must be hex, rgb(), hsl() or a colour name; CSS variables and gradients are not colours (a gradient goes under **Background**).
