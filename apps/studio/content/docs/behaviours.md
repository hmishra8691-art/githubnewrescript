---
summary: Behaviours — when an event happens on a question, option, page or button, run effects such as show, hide, message, focus, animate or popup, optionally only when a condition holds
related: custom-javascript, custom-css, auto-punch, actions
status: available
---
# Behaviours: triggers and effects

A **behaviour** is a small rule in the UX layer: *when* something happens on a target (an option is selected, a page is entered, a button is clicked), *do* one or more effects (show a message, focus a box, animate, open a popup). No code is needed; a behaviour can also run a script.

## Available triggers and effects

| Triggers (`on`) | Effects (`do`) |
|---|---|
| `answer`, `change`, `select_option`, `deselect_option` | `show_message`, `hide_message`, `show_popup`, `hide_popup` |
| `page_enter`, `page_complete`, `block_complete` | `show`, `hide`, `focus`, `scroll_into_view` |
| `appear`, `click`, `hover` | `add_class`, `remove_class`, `toggle_class`, `set_style`, `animate` |

**Targets** use the UX grammar: `Q5`, `Q5.option:3`, `Q5.other_text`, `block:Brand`, `page:3`, `next`, `back`. A behaviour can be limited to some options (`options`) and run **only when** a condition holds (the same [condition language](conditional-logic)).

## When to use it

- Guiding the respondent: a message or popup when a particular answer is picked.
- Focus and attention: open and focus the "Other" box, scroll to a follow-up.
- Light interactivity without writing JavaScript.

## Set it up in the builder

::: steps Guide the "Other" answer
1. **Open the question** → Properties → **Styles, animations & scripts**.
2. **Add a behaviour** — target the **Other** option.
3. **Choose the trigger** — **select option**.
4. **Add effects** — **show message** ("please tell us where") on the question, then **focus** on its Other text box.
5. **Add the reverse (optional)** — on **deselect option**, **hide message**.
6. **Limit it (optional)** — **Only when** a condition holds.
:::

::: flow A behaviour
1. **Trigger** — Other is selected
2. **Only when** — (optional) a condition holds
3. **Effects** — show a message, then focus the box
:::

::: example behaviours

## How it is stored

```json
{ "label": "Guide the Other answer", "target": { "kind": "option", "questionId": "q_1", "code": "99" }, "on": "select_option",
  "effects": [ { "do": "show_message", "target": { "kind": "question", "questionId": "q_1" }, "message": "Thanks — please tell us where, in a few words." },
               { "do": "focus", "target": { "kind": "question", "questionId": "q_1", "part": "other_text" } } ] }
```

## Common mistakes

- **Using a behaviour to change answers** — behaviours change the page, not the data; use [auto-punch](auto-punch) to set answers.
- **No reverse rule** — a message shown on select stays until something hides it.

## Troubleshooting

- *Nothing happens* — check the target (the option's code) and the trigger; Preview shows the UX layer exactly as live.
