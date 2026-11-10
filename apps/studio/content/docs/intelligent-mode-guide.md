---
summary: What Intelligent Mode is — programming a survey in plain sentences, read by the engine first and a language model second, applied only on your approval
related: intelligent-editing, intelligent-logic, intelligent-review, intelligent-mode
status: available
---
# Intelligent Mode: an overview

Intelligent Mode lets you **program the survey by saying what you want** — "make Q7 required", "terminate if Q4 < 18", "randomize Q1 keeping Other last". Every sentence is read, turned into a precise change, checked against the whole survey, and shown to you as a proposal. Nothing changes until you press **Apply**.

## When to use it

- Routine edits that are faster to say than to click: required, logic, skips, validation, randomization, renaming, reordering.
- Questions about the survey: "what will break if I delete Q15?", "review my survey".
- Writing tasks a language model is good at: a questionnaire from a brief, rewording, translation — the result goes through the same checks.

## How a sentence becomes a change

::: flow From a sentence to the survey
1. **You** — type (or dictate) a sentence in the Intelligent Mode box
2. **The engine reads it** — without a language model, when it names its objects
3. **Actions** — the change as a batch of actions from a closed vocabulary
4. **The gate** — applied to a copy and checked: logic, references, options
5. **You approve** — the diff in Changes; Apply makes it one undoable step
6. **History** — every change kept, with how it was read and what it cost
:::

**The engine first.** ResLens.ai's own engine reads most edits that name their objects, with no model call and no charge. **The model second.** What needs writing (new question wording, a questionnaire from a brief, rewording, translation) goes to a language model; its answer comes back as actions through the same gate and the same approval.

## Set it up in the builder

::: steps Make your first change in Intelligent Mode
1. **Switch mode** — on the Studio's menu bar, open **Mode** and choose **Intelligent**.
2. **Type a sentence** — e.g. "show Q3 only if Q2 is 1 or 2", and press Enter.
3. **Read the card** — it says how the sentence was read ("Show Q3 only when Q2 in [1, 2]").
4. **Check Changes** — the proposed change, as a diff; untick anything you do not want.
5. **Apply** — the change is made as one step; **⌘Z / Ctrl+Z** undoes it and **History** keeps it.
:::

::: example im-overview

## What the respondent sees

Exactly what the same change made in the builder would produce — Intelligent Mode writes the same survey definition. In the live example, Q3 appears only for low ratings and under-18s are terminated.

## Common mistakes

- **Expecting it to guess codes.** Name questions by code (Q7) or variable name and options by label or code; the card always says what it understood.
- **Applying without reading the card.** The card is the contract — read it before Apply.

## Troubleshooting

- *"There is no Q9 in this survey"* — the code is wrong; the card suggests the nearest one.
- *The card says it goes to the language model* — the sentence needs writing or was not in a form the engine reads; see [Troubleshooting](intelligent-troubleshooting).
