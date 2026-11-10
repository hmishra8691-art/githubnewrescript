---
summary: Page and logo — full or contained width, alignment, card style, corner radius, spacing, the progress indicator (bar, steps or percent, top or bottom) and the logo
related: branding-overview, backgrounds, phone-and-tablet, assets
status: available
---
# Page layout, progress and logo

Under **Branding → Page & logo**:

| Setting | Values | What it does |
|---|---|---|
| Width | **full** (default) or **contained** | Full fills the window (with a small gutter); contained caps it at the **max width** |
| Alignment | left, center, right | Where the survey sits when it is narrower than the window |
| Card style | **card**, flat, line | Questions on raised cards, on the page, or separated by lines |
| Corner radius | a length, e.g. `12px` | Rounding of cards, options and inputs |
| Spacing | compact, regular, relaxed | Space between and inside questions |
| Progress | top, bottom, none · **bar**, **steps**, **percent** | Steps shows "Page n of N" with dots (up to 12 pages, then the text alone); n and N follow the respondent's path through the logic |
| Logo | an uploaded image or a link · left, center, right | Shown above the survey on every page; its size and fit are set with controls, not CSS |

## When to use it

- A centred, contained layout for short consumer surveys; full width for grids and long matrices.
- Telling respondents how far they are (steps or percent), or hiding progress where it would discourage them.
- Putting the client's logo on every page.

## Set it up in the builder

::: steps A contained, centred survey with a logo
1. **Open Branding → Page & logo**.
2. **Width → contained**, **max width** `620px`, **alignment → center**.
3. **Card style → line**, **corner radius** `6px`.
4. **Progress → top, steps**.
5. **Logo** — choose an image from **Assets** (or paste an https link), position **center**.
:::

::: example theme-page-logo

## How it is stored

```json
{ "branding": { "logoUrl": "/docs-media/logo-example.png", "logoPosition": "center",
  "layout": { "widthMode": "contained", "maxWidth": "620px", "contentAlign": "center", "cardStyle": "line", "radius": "6px",
              "progressBar": "top", "progressStyle": "steps" } } }
```

A logo must load from `https:`, be uploaded (Assets), or be an inline PNG, JPEG, GIF or WebP image.

## Common mistakes

- **A max width with full width on** — the max width applies in **contained** mode.
- **A huge logo file** — upload it to Assets; set its displayed size with the logo controls.

## Troubleshooting

- *The logo does not show* — the link must be `https:`; an `http:` link or a page (not an image) is refused.
- *Steps shows only text* — the survey has more than 12 pages; the dots are left out.
