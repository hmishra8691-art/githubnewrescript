---
summary: Background — an image or a gradient behind the survey, how the image fits, and an overlay colour that keeps text readable
related: branding-overview, brand-colours, page-layout-and-logo, phone-and-tablet
status: available
---
# Backgrounds

Under **Branding → Background**: an **image** (uploaded to Assets, or an https link) with its **fit** (cover, contain, auto), **position**, **repeat** and **attachment** (fixed or scroll); a **gradient** (linear, radial or conic), on its own or under the image; and an **overlay** — a translucent colour laid over both so text stays readable. Without a background, the page is the **background colour** from Colours.

The layers are drawn overlay over image over gradient. On phones or tablets, **Phone & tablet → hide background image** removes the background layers (image, gradient and overlay) on that device, leaving the plain background colour.

## When to use it

- Brand imagery behind a short consumer survey.
- A gradient for a modern look without an image to load.
- An overlay when the image is busy or dark.

## Set it up in the builder

::: steps A gradient with an overlay
1. **Open Branding → Background**.
2. **Gradient** — e.g. `linear-gradient(135deg, #1e3a8a 0%, #7c3aed 100%)`.
3. **Overlay** — e.g. `rgba(255,255,255,0.12)`.
4. **Page & logo → card style → card** — so the questions sit on cards over the background.
5. **Check the preview** on a phone.
:::

::: example theme-background

## How it is stored

```json
{ "branding": { "background": { "gradient": "linear-gradient(135deg, #1e3a8a 0%, #7c3aed 100%)", "overlay": "rgba(255,255,255,0.12)" },
  "layout": { "cardStyle": "card" } } }
```

## Common mistakes

- **Text directly on an image** — use card style **card**, or an overlay.
- **A large photo on phones** — switch on **hide background image** for phones (it removes the gradient and overlay there too).

## Troubleshooting

- *The gradient is refused* — it must be a `linear-gradient(…)`, `radial-gradient(…)` or `conic-gradient(…)` of colours and positions.
