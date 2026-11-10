---
summary: Respondent experience — auto-advance on single-choice pages, question numbers (code or 1. 2. 3.), answer letters or numbers, and block headings
related: branding-overview, buttons-and-navigation, single-select
status: available
---
# Respondent experience: auto-advance and numbering

Under **Branding → Respondent experience**:

- **Auto-advance** — on a page whose only answerable question is a single choice, choosing an answer moves on by itself after a short beat, so the choice is seen. It never moves on when the choice opens an "Other" box, has an error, or the page holds anything else to answer. Off unless switched on; a question can override it (its own auto-next setting).
- **Question numbers** — **none** (default), **code** (the question's code: "Q7.") or **sequence** (1., 2., 3. in survey order, counting only questions a respondent answers — not text blocks, hidden or calculated questions). The numbers are static.
- **Answer numbering** — none (default), **letters** (A. B. C.) or **numbers** (1. 2. 3.) before each choice of a list question.
- **Block headings** — whether block names are shown to respondents (on by default; each block can override it).

## When to use it

- Quick screeners and short polls: auto-advance saves a click per question.
- Paper-like questionnaires, or interviews read aloud: question numbers and answer letters.
- Hiding internal block names ("Screener", "Section B") from respondents.

## Set it up in the builder

::: steps Number questions and auto-advance
1. **Open Branding → Respondent experience**.
2. **Auto-advance → on**.
3. **Question numbers → 1. 2. 3.** (sequence).
4. **Answer numbering → letters**.
5. **Check the preview** — choose an answer on a single-choice page.
:::

::: example theme-experience

## How it is stored

```json
{ "branding": { "layout": { "autoAdvance": true, "questionNumbers": "sequence", "optionNumbering": "letters", "showBlockTitles": true } } }
```

## Common mistakes

- **Expecting auto-advance on every page** — only pages whose one answerable question is a single choice move on by themselves.
- **Numbering by code in a survey with internal codes** — respondents see "S3B." — use sequence.

## Troubleshooting

- *A page does not move on* — the choice opens an "Other" box, the page has another question, or the question's own auto-next is off.
