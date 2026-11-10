---
summary: One answer from a list — the most common question type, with its variants (radio, dropdown, buttons, cards, images)
related: multi-select, other-specify, answer-randomization, display-logic
status: available
---
# Single select

A single-select question asks the respondent to choose **exactly one** answer from a list of options. Choosing another option replaces the first. It is the question type behind most screening, classification and preference questions.

## When to use it

- The answers are **mutually exclusive** — gender, age band, the brand used *most often*, yes / no.
- You want one clean code per respondent for crosstabs, quotas and logic.
- Use a [multi-select](multi-select) instead when several answers can be true at once, and a [rating scale](rating-scales) when the options are points on a scale.

## Set it up in the builder

::: steps Create a single-select question
1. **Add the question** — In **Programming → Questions**, press **+ Add question** (or **+ Question** inside a block) and choose the family **Single Select**. The default type is **Radio Button**.
2. **Write the question text** — Type it in the rich-text editor. Use **+ Piping** to insert an earlier answer.
3. **Add the options** — Each row is a code and a label. Press **+ option** (or Enter) for the next one, or **paste a list** to add many at once. Codes are numbered for you (1, 2, 3…) and can be changed — 98 and 99 are common for "Don't know" and "Other".
4. **Set Required** — The **REQUIRED** drop-down makes the respondent answer before moving on.
5. **Choose a presentation** — Change **Question type** to Dropdown, Searchable Dropdown, Button Select, Card Select, Image Select and others; the answer stored is the same single code.
:::

::: example single-select

## How it is stored

The question is `type: "single_select"` with a `variant` that names its presentation. Each option has a `code` (what is stored) and a `label` (what is shown):

```json
{ "code": "Q1", "variableName": "BRAND", "type": "single_select", "variant": "single_select.radio",
  "text": "Which brand of smartphone do you use most often?", "required": true,
  "options": [ { "code": 1, "label": "Apple" }, { "code": 2, "label": "Samsung" },
               { "code": 3, "label": "Google" }, { "code": 4, "label": "OnePlus" } ] }
```

In logic you refer to an option by its code or its label — both compile to the code:

```logic
Q1 = 2
Q1 = Samsung
Q1 in [1, 3]
```

## What the respondent sees and the data you get

The respondent sees round radio buttons (or the presentation you chose) and can pick one. The answer is stored as **one code** and exported as one column named after the variable — `BRAND = 2` for Samsung. Labels go into the value labels of the SPSS, Stata and SAS exports.

## Variants

| Question type (variant) | What the respondent sees |
|---|---|
| Radio Button | a vertical list of radio buttons (columns optional) |
| Dropdown / Searchable Dropdown | a select box; searchable for long lists |
| Button Select / Card Select / Tile & Icon Select | large tappable buttons or cards, good on phones |
| Image Select | an image per option |
| Cascading Dropdown | a second list filtered by the first |

The complete list, with what each variant supports, is in [Question types](question-types).

## Common mistakes

- **Using a single-select for "select all that apply".** If two answers can both be true, the respondent is forced to pick one and you lose data — use a multi-select.
- **Changing codes after fieldwork starts.** Codes are the data. Relabel freely, but keep codes stable once responses exist.
- **An "Other" option without a text box.** Mark it *other/specify* (see [Other, specify](other-specify)) if you want to know what "other" was.

## Troubleshooting

- *The option order changes for each respondent* — randomization is on; see [Answer randomization](answer-randomization).
- *An option is missing on the live survey* — check the option's own logic and any [masking](masking) or [carry-forward](carry-forward) on the question; the **option preview — why is an option shown or hidden?** button under the options explains each one.
