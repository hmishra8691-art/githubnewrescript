---
summary: Values that come with the respondent — from the link, a panel, a fixed value or an expression — used in text, logic and data
related: url-parameters, redirects, piping, conditional-logic
status: available
---
# Embedded variables

Embedded data are **values the survey carries without asking for them**: a panel ID or a membership tier from the link, a fixed wave number, a value computed from answers. They are used in text, logic and redirects, and exported as columns.

## When to use it

- Information you already have about the respondent: tier, region, customer segment, panel ID.
- Values to pass on: a redirect with the panel ID.
- Fixed survey-level values: wave, version, market.

## Set it up in the builder

::: steps Capture TIER from the link and use it
1. **Create the field** — in **Programming → Survey Flow**, **+ Add element** → **Embedded data** at the start (or **Programming → Variables**). Name it `TIER`, source **URL**.
2. **Give it a type (optional)** — string, integer, decimal, boolean, date, datetime or URL; and a default value.
3. **Use it in text** — `As a {{ed.TIER}} member, …`.
4. **Use it in logic** — `ed.TIER = "Gold"`.
5. **Test with the link** — `…/s/<survey>?TIER=Gold`.
:::

::: example embedded-variables

## How it is stored

```json
"embeddedData": [ { "name": "TIER", "source": "url" } ]
```

Sources: `url`, `panel`, `static`, `expression`. In logic: `ed.TIER` (or `embedded.TIER`); in text: `{{ed.TIER}}`. An `embedded_data` flow element sets fields at that point of the flow.

## What the respondent sees and the data you get

Nothing directly — only the effects: the piped tier and the Gold-only question. The export has a `TIER` column.

## Common mistakes

- **Trusting a URL value blindly** — anyone can edit a link; do not use URL values for anything that must be secure.
- **Case differences** — `gold` and `Gold` are different values in a comparison.

## Troubleshooting

- *The value is empty* — the parameter name in the link must match the field name exactly.
