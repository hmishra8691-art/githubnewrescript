---
summary: Options that cannot be combined with others on a multi-select — how the exclusive flag behaves and how to anchor it
related: multi-select, none-of-the-above, dont-know, other-specify
status: available
---
# Exclusive options

An **exclusive** option on a multi-select cannot be combined with any other answer: selecting it clears every other selection, and selecting anything else clears it. "None of these", "Don't know" and "Prefer not to say" are exclusive options.

## When to use it

- Any answer that contradicts the rest of the list — "None of these", "I don't watch TV shows".
- Only on **multi-select** questions (and multi-select matrices). On a single-select every option is already exclusive, so the flag is not offered there.

## Set it up in the builder

::: steps Make an option exclusive
1. **Open the option's properties** — on the multi-select, press **properties…** beside the option.
2. **Tick exclusive** — the option now clears the others when it is picked.
3. **Tick anchor bottom** — so randomizing the list never moves it from the end.
:::

::: example exclusive-options

## How it is stored

```json
{ "code": 5, "label": "I don't watch TV shows", "flags": ["exclusive", "anchor_bottom"] }
```

In ResLens.ai, "None of the above", "Don't know" and "Refused" are not separate behaviours: they are all the **exclusive** flag (older surveys that used separate flags are read as exclusive). The label is what tells them apart.

## What the respondent sees and the data you get

Ticking the exclusive option unticks the others instantly, and vice versa — the respondent can never submit a contradictory answer. In the export it is one more 0/1 column (`DEVICES_5`).

## Common mistakes

- **Leaving it unanchored on a randomized list** — "None of these" in the middle of the list looks odd and is missed.
- **Making a real answer exclusive** — only answers that rule out all the others should be exclusive.

## Troubleshooting

- *Two options keep clearing each other* — both are exclusive; usually only one should be.
