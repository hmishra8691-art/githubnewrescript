---
summary: The actions every change goes through — a closed vocabulary shared by the builder's commands, Intelligent Mode and imports — and how the gate checks them
related: intelligent-review, intelligent-validation, actions-reference, behaviours
status: available
---
# Actions

Every change to a ResLens.ai survey can be written as an **action** — `create_question`, `update_question`, `set_display_logic`, `add_skip`, `set_validation`, `create_quota`, `create_conjoint`, `connect_panel`… Intelligent Mode proposes actions, the model's answers are actions, and imports are checked the same way. One vocabulary means one set of checks.

## Available action types

| Area | Actions (examples) |
|---|---|
| Questions and blocks | `create_question`, `update_question`, `delete_question`, `move_question`, `duplicate_question`, `create_block` |
| Options | `update_option`, `reorder_options`, `set_option_randomization`, `set_mask` |
| Logic and flow | `set_display_logic`, `add_skip`, `set_validation`, `add_punch`, `create_branch`, `create_loop`, `create_randomizer` |
| Data | `create_embedded`, `create_calculation` |
| Quotas | `create_quota`, `update_quota`, `set_quota_check` |
| Designs | `create_maxdiff`, `create_conjoint`, `create_experiment`, `add_method_template` |
| Look and code | `create_style`, `create_animation`, `create_behavior`, `set_theme`, `set_custom_code` |
| Integrations | `connect_panel`, `disconnect_panel`, `configure_alerts` |
| Research and analysis | `set_research`, `add_crosstab`, analysis plan actions |
| Languages | localization actions (add a language, translate, glossary) |

Every field of every action is listed in the [actions reference](actions-reference), generated from the code.

## How actions are applied

::: flow The action gate
1. **Coerce** — the action's fields are read and normalised (codes, labels, text conditions)
2. **Apply to a copy** — the survey is never touched directly
3. **Validate** — each action against the survey as the batch leaves it
4. **Report** — what the batch newly breaks elsewhere
5. **Approve** — shown in Changes; Apply writes it as one undoable change
:::

**Conditional execution.** Actions themselves are not conditional — what they *create* can be: display logic, skips, validation rules with `when`, behaviours with conditions, punches. **Triggers** are the events those features listen to (a page submit, an answer, a selected option).

## Set it up in the builder

::: steps See the actions behind a change
1. **Make a change in Intelligent Mode** — e.g. "make Q1 and Q2 required".
2. **Open the proposal's actions** — the card and Changes list them.
3. **Apply** — History records the actions with the prompt.
4. **Reuse them** — an action list can be pasted back (e.g. by an integration or another survey) and goes through the same gate.
:::

::: example actions-in-practice

## What the respondent sees

The survey the actions produce — actions are how changes are written, not something respondents see.

## Common mistakes

- **Naming by id in hand-written actions** — actions take codes (Q7) and variable names; ids are internal.

## Troubleshooting

- *An action is refused* — the reason names the field and the object; see [Validation and error correction](intelligent-validation).
