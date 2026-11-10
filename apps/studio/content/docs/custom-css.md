---
summary: Style questions, options and the whole survey — scoped UX-layer styles with states and breakpoints, per-question CSS and survey CSS
related: custom-javascript, custom-html-components, custom-code
status: available
---
# Custom CSS

ResLens.ai styles a survey in three layers: the **theme** (Branding — colours, fonts, layout), **scoped styles** in the UX layer (a target such as `Q1.options` with CSS declarations, per state and per screen size), and raw CSS (survey-wide in Branding, or per question).

## When to use it

- Making one question look different — options as cards, a highlighted selected answer, a larger input.
- Responsive tweaks — stack options on phones.
- Survey-wide polish the theme does not cover.

## Set it up in the builder

::: steps Style each option as a card that lights up when chosen
1. **Open the question** → Properties → **Styles, animations & scripts**.
2. **Add a style** — target **Q1 options** (the rules apply to every option of Q1).
3. **Add declarations** — `border: 2px solid #c7d2fe; border-radius: 14px; padding: 14px 16px; background: #f5f7ff`.
4. **Add a selected rule** — state **selected**: `border-color: #4f46e5; background: #e0e7ff`.
5. **Add a phone rule (optional)** — media **mobile**: `padding: 12px`.
6. **Preview** — the style is compiled and scoped to the target, so it cannot leak to other questions.
:::

::: example custom-css

## How it is stored

```json
{ "label": "Plan cards", "target": { "kind": "question", "questionId": "q_1", "part": "options" },
  "rules": [ { "declarations": { "border": "2px solid #c7d2fe", "border-radius": "14px", "padding": "14px 16px", "background": "#f5f7ff" } },
             { "state": "selected", "declarations": { "border-color": "#4f46e5", "background": "#e0e7ff" } },
             { "media": "mobile", "declarations": { "padding": "12px" } } ] }
```

The `options` part styles **each option** of the question; a declaration such as `display: grid` there lays out the inside of every option, not the list.

Targets: `Q5`, `Q5.options`, `Q5.option:3`, `Q5.row:r1`, `Q5.title`, `block:Brand`, `page:3`, `next`, `back`, `buttons`, `progress`, `survey`. States: `hover`, `focus`, `selected`, `answered`, `disabled`. Media: `mobile`, `tablet`, `desktop`, `reduced_motion`. Declarations are checked against the CSS grammar; external `url()`, `expression()` and `behavior` are refused.

Raw CSS: **Branding** → custom CSS for the whole survey, and per-question **Custom CSS** — not scoped, so prefix selectors with the question, e.g. `[data-qid="q_1"] .rs-option { … }`.

## What the respondent sees

Each plan as a rounded card; the chosen one turns indigo.

## Common mistakes

- **Unscoped per-question CSS** — a rule like `.rs-option { … }` in a question's Custom CSS styles every question on the page; use a UX style or prefix the selector.
- **`!important` everywhere** — it is accepted with a warning and makes later changes harder.

## Troubleshooting

- *A declaration is ignored* — it was refused by the CSS check (an external `url()`, for example); the style editor lists the reason.
