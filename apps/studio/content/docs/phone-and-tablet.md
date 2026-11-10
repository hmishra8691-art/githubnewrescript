---
summary: Phone and tablet — per-device text size, question size, width, card padding, gap between options, corner radius, and hiding the background image
related: branding-overview, typography, page-layout-and-logo, backgrounds
status: available
---
# Phone and tablet sizes

Under **Branding → Phone & tablet**, set sizes that change on smaller screens: **base text size**, **question size**, **max width**, **card padding**, **gap between options**, **corner radius**, and **hide background image**. An empty field means "the same as on a computer".

The phone sizes apply up to 640px wide, the tablet sizes from 641px to 1024px. The Studio's preview (and the respondent view below) can show either device.

## When to use it

- Larger text and touch targets on phones.
- Less padding on phones so more of the question fits on screen.
- Dropping a heavy background image on mobile data.

## Set it up in the builder

::: steps Phone sizes
1. **Open Branding → Phone & tablet**.
2. **Phone → base size** `18px`, **question size** `1.3em`.
3. **Phone → gap between options** `14px`, **card padding** `12px`.
4. **Switch the preview to phone** to check.
:::

::: example theme-devices

## How it is stored

```json
{ "branding": { "responsive": { "mobile": { "baseSize": "18px", "questionSize": "1.3em", "optionGap": "14px", "cardPadding": "12px" } } } }
```

## Common mistakes

- **Setting the same sizes as on a computer** — leave fields empty; they inherit.
- **Checking only on a computer** — the overrides do not apply on a wide screen; use the phone preview.

## Troubleshooting

- *Nothing changes on my phone* — the device is wider than 640px (many tablets in landscape); set the tablet sizes too.
