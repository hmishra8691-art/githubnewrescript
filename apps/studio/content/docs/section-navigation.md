---
summary: Section navigation — a navigator listing the survey's sections with answered counts, letting respondents jump back to visited sections (visited) or anywhere reachable (free), as a bar or a side rail
related: buttons-and-navigation, survey-flow, mandatory-optional
status: available
---
# Section navigation

The **section navigator** lists the survey's sections — its blocks — with how many questions in each are answered, and lets respondents move between them. Three modes:

| Mode | What respondents can do |
|---|---|
| **off** (default) | Next and Back only |
| **visited** | Jump back to any earlier section, and forward only to sections already visited |
| **free** | Jump anywhere reachable with the current answers; required questions skipped this way are checked at **Submit**, which lists them by section with a button to go to each |

The navigator sits as a **bar above the page** or a **side rail** on wide screens. A section that cannot be reached stays in the list as **locked**, and clicking it says why. Every jump goes through the engine: logic, quotas and terminations still decide what a respondent can reach.

## When to use it

- Long surveys in sections, where respondents want to review or correct an earlier part.
- Forms filled in over several sittings (free mode).
- Assessments, where candidates move between sections and confirm unanswered questions at the end.

## Set it up in the builder

::: steps Let respondents return to visited sections
1. **Put the survey in blocks** — each block is a section; its title is the section's name.
2. **Open Branding → Buttons & navigation**.
3. **Section navigation → visited** (or free).
4. **Position → top** (or side).
5. **Preview** — answer two sections, then jump back.
:::

::: example section-navigation

## How it is stored

```json
{ "navigation": { "sectionNav": "visited", "position": "top" } }
```

In Intelligent Mode the change is the `set_navigation` action.

## Common mistakes

- **No blocks** — the navigator lists sections; a survey with one block has nothing to navigate.
- **Free mode with strict ordering needs** — when later answers must not influence earlier ones, use visited (or off).

## Troubleshooting

- *A section is locked* — it has not been reached yet (visited mode), or the answers so far skip it.
- *Submit lists unanswered questions* — in free mode, required questions skipped by jumping are checked at the end.
