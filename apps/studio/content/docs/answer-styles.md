---
summary: Style and answers — the theme style (motif, illustrations, motion), how answer options look (default, cards, pills, minimal, tiles), radio and checkbox style, input style, shadow and the selected tint
related: branding-overview, brand-colours, single-select, multi-select
status: available
---
# Answer styles and theme style

Under **Branding → Style & answers**:

- **Option style** — **default** (bordered rows), **cards** (raised), **pills**, **minimal**, or **tiles**: selection cards with no visible radio button or checkbox (a check badge marks the choice; grids become selectable boxes). New surveys start with tiles. The input stays in the page for keyboards and screen readers, and **the stored answer is the same** whatever the style.
- **Radio buttons and checkboxes** — the browser's own (**native**) or drawn in the theme's colours (**custom**).
- **Inputs** — outlined, filled or underline; the **focus colour**.
- **Motion** — none, **subtle** (default) or **lively** (a small pop when an answer is selected).
- **Theme style (motif)** — peach, kids, robotics or creative: typography accents, backgrounds, decorations and how selection looks and moves; **illustrations** (original artwork drawn in CSS and SVG) come with a motif and can be switched off.
- **Shadow** (none to strong), **card padding**, **border width**, **gap between options**, **selected tint** (how strongly a selected answer is tinted with the primary colour, 0–40%), **button radius**, **progress height** and **logo height**.

## When to use it

- Touch-friendly surveys: tiles or cards give a large target on a phone.
- A calmer look for long B2B surveys: default rows, motion off.
- Playful or premium studies: a motif (the Kids & Cartoon and Premium Peach presets use one).

## Set it up in the builder

::: steps Selection cards with lively motion
1. **Open Branding → Style & answers**.
2. **Option style → Tiles**.
3. **Motion → Lively**.
4. **More** — **shadow** medium, **selected tint** 18, **inputs** filled.
5. **Check the preview** — select answers on the sample page.
:::

::: example theme-answers

## How it is stored

```json
{ "branding": { "appearance": { "optionStyle": "tiles", "motion": "lively", "shadow": "medium", "selectedTint": 18, "inputStyle": "filled" } } }
```

## Common mistakes

- **Hiding the controls with CSS** — use **tiles**; it keeps the input for keyboards and screen readers.
- **Expecting the style to change the data** — option style, motion and motif change only how answers look; codes and stored values are the same.

## Troubleshooting

- *Options still show radio buttons* — check that the option style is **tiles** (not cards or pills), and whether a scoped style on the question (Properties → Styles, animations & scripts) changes it.
