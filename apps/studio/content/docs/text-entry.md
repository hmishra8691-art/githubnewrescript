---
summary: Short typed answers — names, emails, phone numbers, ZIP codes — with format checks built in
related: open-ended, question-validation, piping, dont-know
status: available
---
# Text entry

A text-entry question collects a **short typed answer** on one line: a name, a city, an email address, a code. Its subtypes (Email, Phone Number, URL, ZIP / Postal Code, Masked / Regex Text…) add the right format check automatically.

## When to use it

- Short facts that do not fit a list: a name, a job title, a reference number.
- Contact details with a built-in format check — **Email**, **Phone Number**, **ZIP / Postal Code**, **URL**.
- For longer, open answers (opinions, explanations) use an [open-ended](open-ended) question instead.

## Set it up in the builder

::: steps Create a text-entry question
1. **Add the question** — **+ Add question** → family **Text / Open End**, type **Single-Line Text**.
2. **Pick a subtype if the answer has a format** — change **Question type** to Email, Phone Number, URL, ZIP / Postal Code or Masked / Regex Text. The matching check is added to Validation rules.
3. **Add a placeholder (optional)** — the **Placeholder** box shows grey hint text inside the empty field.
4. **Limit the length (optional)** — Properties → **Validation rules** → minimum / maximum length, or a character range.
5. **Allow "I don't know" (optional)** — tick **Enable “I don't know” option** under the response field; see [Don't know](dont-know).
:::

::: example text-entry

## How it is stored

`type: "open_text"` with the variant `text.single_line` (or `text.email`, `text.phone`, `text.zip`, `text.url`…). Format checks are validation rules:

```json
{ "code": "Q2", "variableName": "EMAIL", "type": "open_text", "variant": "text.email",
  "text": "And your email address, {{FNAME}}?", "validation": [ { "kind": "email" } ] }
```

The answer is the text as typed. Conditions can test it:

```logic
Q1 answered
Q1 starts with "Dr"
CONTAINS(Q1, "price")
```

## What the respondent sees and the data you get

A single text box. A failed format check shows its message under the question when Next is pressed. The export has one text column, `EMAIL`.

Available format checks: `email`, `phone` (by country), `url`, `zip` (by country), `us_state`, `date_format`, `number_only`, `text_only`, `pattern` (a regular expression), `min_length`, `max_length` and `length_range`.

## Common mistakes

- **Asking for a number in a text box.** Use [Numeric entry](numeric-entry) so the column is numeric and ranges can be checked.
- **A regular expression that is too strict** — international phone numbers and postcodes vary; prefer the Phone and ZIP subtypes, which read the question's country setting.

## Troubleshooting

- *A format message on an answer you think is valid* — open Properties → Validation rules to see exactly which check the subtype added (for example the phone or postal country), and change the country or the rule there.
- *The piped name is empty* — the source question was not answered (or is asked later); a pipe to an unanswered question renders empty.
