---
summary: Gamification — points per answered and correct question, badges earned by rules, levels by points, and a points display; stored as calculated variables
related: respondent-experience, embedded-variables, conditional-logic
status: available
---
# Points, badges and levels

**Gamification** adds points, badges and levels to a survey (**Survey Settings → Gamification**):

- **Points** — per answered question (questions a respondent sees and answers; not hidden, calculated or text blocks), per correct answer (by the survey's answer key), and optionally a calculated variable whose value is added.
- **Badges** — each with a title, an icon (star, trophy, medal, rocket, fire, heart, lightbulb, target, crown, check) and a rule (e.g. `POINTS >= 20`); earned once, the first time the rule holds, and shown in a popup.
- **Levels** — names with a minimum number of points.
- **Points display** — the points in a corner (top-right, top-left, bottom-right, bottom-left), or hidden.

Everything gamification produces is a **calculated variable** — `POINTS`, `POINTS_ANSWERED`, `POINTS_CORRECT`, `LEVEL`, `LEVEL_NAME`, `BADGES` — recomputed with the survey's other calculations and exported with them. It can be used in logic like any other variable.

## When to use it

- Long or repetitive surveys, where progress rewards keep respondents going.
- Quizzes and knowledge checks, with points per correct answer.
- Communities and panels, where levels and badges are part of the experience.

## Set it up in the builder

::: steps Points, a badge and two levels
1. **Open Survey Settings → Gamification** and tick it on.
2. **Points per answered question** — 10.
3. **+ Badge** — "Halfway there", star, rule `POINTS >= 20`.
4. **+ Level** — Starter at 0, Insider at 30.
5. **Points display** — on, top-right; then preview.
:::

::: example gamification

## How it is stored

```json
{ "gamification": { "enabled": true, "points": { "perAnswer": 10, "perCorrect": 0 },
  "badges": [{ "id": "halfway", "title": "Halfway there", "icon": "star", "when": "POINTS ≥ 20 (a condition)" }],
  "levels": [{ "name": "Starter", "minPoints": 0 }, { "name": "Insider", "minPoints": 30 }],
  "hud": { "show": true, "position": "top-right" } } }
```

In Intelligent Mode the change is the `set_gamification` action.

## Common mistakes

- **Points per correct answer without an answer key** — correct answers are judged by the survey's answer key; without one, they score nothing.
- **A badge rule that can never hold** — e.g. more points than the survey can give; check the maximum.

## Troubleshooting

- *Points do not change* — the question was not answered, or it is hidden, calculated or a text block.
- *A badge appeared only once* — badges are earned once, the first time the rule holds.
