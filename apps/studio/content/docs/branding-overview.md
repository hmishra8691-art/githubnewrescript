---
summary: The Branding workspace — start from a preset, your brand or a description, then fine-tune colours, text, page, answers, background, buttons, devices and code, with a live preview
related: brand-colours, typography, answer-styles, page-layout-and-logo
status: available
---
# Branding: themes and the Branding workspace

**Branding** decides how respondents see the survey — never what it asks or stores. It lives in the survey definition as `branding`, so the look travels with the survey: into Preview, the test link, the live link and every language version.

Open it from **Research Tools → Branding**. The workspace has three parts:

- **Start from** — four ways to get a whole look at once: **A preset** (eight ready-made looks), **Your brand** (colours read from your website, a brand-guidelines PDF, your logo, or one brand colour), **Describe it** (tell the AI the look you want) and **Workspace theme** (your team's saved looks; not in the sandbox).
- **The setting groups** — Colours, Text, Page & logo, Style & answers, Background, Buttons & navigation, Respondent experience, Phone & tablet, AI interviewer, and Code & custom. One group is shown at a time; **Show everything** lays them all out on one page, and **Find a setting** searches them.
- **The live preview** — a sample page (or this survey) on a computer, tablet or phone. Pointing at a setting outlines what it affects; every change is listed under **Just changed**, with **Undo**.

## Supported presets

| Preset | The look |
|---|---|
| Corporate | Professional blue, card layout — B2B and corporate research |
| Luxury | Dark, serif, gold accents — premium brand studies |
| Healthcare | Calm teal, large type, high accessibility |
| Gen-Z | Bold gradients, pill buttons, playful |
| Premium Peach | Warm peach, soft cards, elegant type, selection cards |
| Kids & Cartoon | Bright and friendly — big answer cards, cartoon characters, bouncy feedback |
| AI & Robotics | Futuristic and glowing — dark glass cards, circuit lines |
| Creative Studio | Gradient accents, crisp cards, smooth motion — consumer and marketing research |

A preset is **written into the survey**: after applying it, every value it set is an ordinary setting you can change. Applying another preset replaces the look; **Undo** puts the previous one back.

## When to use it

- Every survey that respondents see under your client's or your own brand.
- Quick, consistent looks across studies: a preset, or a workspace theme your team saved.
- Accessibility: Healthcare's large type, the contrast check under Colours, larger sizes on phones.

## Set it up in the builder

::: steps Apply a preset, then make it yours
1. **Open Branding** — Research Tools → **Branding**.
2. **Start from → A preset** — point at a preset to preview it; click to apply.
3. **Adjust the groups** — e.g. **Colours** for your primary colour, **Page & logo** for the logo.
4. **Check the preview** — switch between computer, tablet and phone; read **Just changed**.
5. **Save a version** — the look is part of the survey and ships with it.
:::

::: example theme-preset

## How it is stored

```json
{ "branding": {
    "colors": { "primary": "#e5734a", "background": "#fff6f0", "...": "..." },
    "typography": { "fontFamily": "'DM Sans', 'Inter', system-ui, sans-serif", "headingFont": "'Fraunces', Georgia, serif" },
    "buttons": { "style": "pill", "nextLabel": "Continue" },
    "appearance": { "optionStyle": "tiles", "motif": "peach", "illustrations": true, "motion": "subtle" },
    "background": { "gradient": "linear-gradient(160deg, #fff8f3 0%, #ffe9dc 100%)" } } }
```

In Intelligent Mode, theme changes are the `set_theme` action ("make the buttons pills", "put the progress bar at the bottom"); every value passes the same checks as the workspace.

## Common mistakes

- **Expecting a preset to stay linked** — it is copied in. Changing the preset list later does not change your survey; a **workspace theme** is the shared, reusable look.
- **Styling with custom CSS first** — colours, fonts, background and answer styles are settings; CSS is for what the settings cannot do.

## Troubleshooting

- *“Your brand” says to save first* — brand analysis needs a saved survey; save, then analyse.
- *The live survey looks different from the preview* — check the device: phone and tablet sizes come from **Phone & tablet**.
