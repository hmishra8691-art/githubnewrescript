---
summary: Read ?NAME=value parameters from the survey link into embedded fields — for panels, sources, segments and languages
related: embedded-variables, redirects, quotas
status: available
---
# URL parameters

A survey link can carry values after a `?`: `…/s/abc?SRC=newsletter&PID=A123`. Each parameter you want to keep is an **embedded field with source URL** — captured when the respondent arrives, available in text and logic, and saved with the response.

## When to use it

- Panel and respondent IDs for redirects and reconciliation.
- Traffic source, campaign, segment, region known before the survey starts.
- Skipping screener questions whose answers you already have.

## Set it up in the builder

::: steps Capture SRC and LANG_HINT from the link
1. **Add one embedded field per parameter** — Survey Flow → **+ Add element** → **Embedded data** (or Programming → **Variables**), source **URL**, name exactly as in the link (`SRC`).
2. **Place it at the start** of the flow, before anything that uses it.
3. **Use the values** — `{{ed.SRC}}` in text, `ed.SRC = newsletter` in logic, `{{ed.PID}}` in a redirect.
4. **Share the link with the parameters** — **Management → Distribution** gives the survey link; append `?SRC=…`.
:::

::: example url-parameters

## How it is stored

```json
"embeddedData": [ { "name": "SRC", "source": "url" }, { "name": "LANG_HINT", "source": "url" } ]
```

## What the respondent sees and the data you get

The welcome text pipes `newsletter`. The export has `SRC` and `LANG_HINT` columns for every response.

## Common mistakes

- **A parameter with no embedded field** — declare every parameter you need as an embedded field, so it is captured, typed, usable in logic and exported as its own column.
- **Sensitive data in links** — URLs are logged by browsers and servers; never put personal data in them.

## Troubleshooting

- *A parameter is not captured* — check the spelling and case in both the link and the field name.
