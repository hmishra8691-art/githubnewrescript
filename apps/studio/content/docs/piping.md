---
summary: Insert earlier answers, calculations, embedded data and loop items into any text with {{ }} tokens
related: carry-forward, loops, embedded-variables, text-entry
status: available
---
# Piping

Piping inserts a value — usually an **earlier answer** — into question text, instructions, option labels, HTML, end messages and redirect URLs. "How satisfied are you with your **Samsung** phone?" uses the brand chosen a page earlier.

## When to use it

- Personalise follow-ups with an earlier answer: the brand, the product, the respondent's name.
- Show computed values: a score (`{{calc.SCORE}}`), a value from the link (`{{ed.PANEL_ID}}`).
- Inside loops: the current item (`{{loop.label}}`).

## Set it up in the builder

::: steps Pipe an answer into a question
1. **Ask the source question first** — the value must exist before the page that shows it.
2. **Open the target question** and place the cursor in the text.
3. **Press + Piping** in the editor toolbar and pick the source and what to insert (the selected label, the code, a count…). The pipe appears as a chip, e.g. *BRAND → Selected option label*.
4. **Or type the token** — `{{Q1}}` works in any text box, including option labels, instructions and HTML (switch the editor to **HTML** to see the raw tokens).
:::

::: example piping

## How it is stored

The text keeps the token; the engine stores it against the question's **variable name**, so renumbering questions does not break it:

```json
{ "code": "Q2", "text": "How satisfied are you with your {{BRAND}} phone?" }
```

Useful tokens:

```logic
{{Q4}}                  the answer's label(s)
{{Q4.value}}            the code(s)
{{Q3.labels|and}}       all selected labels as "A, B and C"
{{Q3.count}}            how many were selected
{{Q3.other}}            the "other, specify" text
{{Q7[r2].label}}        a grid row's answer
{{calc.SCORE}}          a calculation
{{ed.PANEL_ID}}         embedded data
{{loop.label}}          the current loop item
{{expr: Q1 + Q2}}       an inline expression
```

Formats after `|`: comma (default), and, or, bullets, numbered, lines, upper, lower, title, join:<separator>. The full list is in the [logic reference](logic-reference).

## What the respondent sees

The value in place of the token, resolved when the page is drawn. If the respondent goes back and changes the source answer, the piped text follows.

## Common mistakes

- **Piping from a later question** — it renders empty; Review flags a token that names a question asked later.
- **Piping from an optional question** — if it was skipped, the sentence has a gap. Make the source required, or word the text so it reads well empty.
- **Piping a multi-select with the default format into a sentence** — use `|and` for "A, B and C".

## Troubleshooting

- *The token shows as typed (`{{Q9}}`)* — the name does not match a question, calculation or embedded field; check the variable name.
- *The piped value is empty* — the source was not answered on this respondent's path.
