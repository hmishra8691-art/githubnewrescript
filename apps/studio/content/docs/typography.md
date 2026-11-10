---
summary: Text — the font family, base size and heading weight, and the heading font, line height, letter spacing and question size
related: branding-overview, brand-colours, phone-and-tablet
status: available
---
# Typography

Under **Branding → Text**: the **font family** respondents read in, the **base size** (every size in the survey scales from it) and the **heading weight**. Under **More**: a separate **heading font**, the **line height**, **letter spacing** and the **question size** (relative to the base size; the default is 1.08em).

The font family is a CSS font list, e.g. `Georgia, 'Times New Roman', serif`. The respondent's device draws the first font it has — so end the list with a generic family (`serif`, `sans-serif`).

## When to use it

- A brand typeface, or an editorial look with a serif face.
- Readability: a larger base size for older audiences (16px or more is recommended on phones).
- Stronger questions: a larger question size or heavier headings.

## Set it up in the builder

::: steps Set the survey's type
1. **Open Branding → Text**.
2. **Font family** — type the font list, ending with a generic family.
3. **Base size** — e.g. `17px`.
4. **More → Question size** — e.g. `1.25em`; **Line height** — e.g. `1.6`.
5. **Check the preview** on a phone as well.
:::

::: example theme-typography

## How it is stored

```json
{ "branding": { "typography": { "fontFamily": "Georgia, 'Times New Roman', serif", "baseSize": "17px", "headingWeight": 700,
  "questionSize": "1.25em", "lineHeight": "1.6" } } }
```

Sizes are lengths (`px`, `em`, `rem`, `%`); the heading weight is 100–900.

## Common mistakes

- **A font the device does not have** — without a fallback the browser picks its default; always end with `serif` or `sans-serif`.
- **A small base size** — the accessibility check warns below 16px.

## Troubleshooting

- *The font does not change* — the name must match the installed font exactly; quotes around names with spaces.
