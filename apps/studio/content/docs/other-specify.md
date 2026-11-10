---
summary: An “Other” option with a text box — how it is flagged, required and exported
related: single-select, multi-select, exclusive-options
status: available
---
# Other, please specify

An **other/specify** option opens a text box when it is chosen, so the respondent can say what "other" means. The text is stored with the option it belongs to.

## When to use it

- The list cannot be complete — "Where did you hear about us?", brands, reasons.
- You want to discover answers you missed; frequent "other" texts become new options in the next wave.

## Set it up in the builder

::: steps Add an Other option with a box
1. **Add the option** — add "Other (please specify)" as the last option, often with code 99.
2. **Flag it** — open the option's **properties…** and tick **other/specify**. An option labelled "Other (please specify)", "Please specify", "Something else" or "Other (write in)" gets the flag when it is created; a plain "Other" stays a closed answer unless you set it.
3. **Decide whether the text is required** — **Require the “Other” text** under the options (on by default) means a respondent who picks Other cannot continue until they type something.
4. **Restrict what the box accepts (optional)** — **“Other” accepts** sets what the box takes: any text, numbers only, or letters and numbers.
5. **Keep it last** — tick **anchor bottom** so randomization never moves it.
:::

::: example other-specify

## How it is stored

```json
{ "code": 99, "label": "Other (please specify)", "flags": ["other_specify"] }
```

The text is stored beside the answer, against the option (`<question id>__other__99`) — the answer itself is just the code 99. Pipe it with `{{Q1.other}}`.

## What the respondent sees and the data you get

Choosing Other reveals a text box right under it. The export has the code in `SOURCE` and the text in `SOURCE_other` (further other options export as `SOURCE_other_<code>`).

## Common mistakes

- **"Other" without the flag** — you learn that 8% said other, but not what they meant.
- **Several "other" options sharing one text** — each flagged option has its own box and its own column.

## Troubleshooting

- *The respondent cannot continue after picking Other* — the text is required and empty.
- *Review flags an option* — an option whose label says "please specify" has no box; Review offers a one-click fix.
