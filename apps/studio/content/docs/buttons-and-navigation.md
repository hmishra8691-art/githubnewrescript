---
summary: Buttons and navigation — the button style, the Next, Back and Submit labels, whether respondents can go back, and section navigation
related: branding-overview, respondent-experience, survey-flow
status: available
---
# Buttons and navigation

Under **Branding → Buttons & navigation**:

- **Button style** — solid (default), outline or pill.
- **Labels** — **Next**, **Back** and **Submit** (shown on the last page instead of Next). Translations of these labels live with the survey's other texts in Translation.
- **Show Back** — on by default. Off, respondents cannot return to earlier pages, so answers are final once a page is left.
- **Section navigation** — off (Next and Back only, the default), **visited** (jump back to any earlier section, forward only to sections already visited) or **free** (jump anywhere reachable with the current answers; skipped required questions are checked at Submit), shown as a bar above the page or a side rail on wide screens. Section navigation is a survey behaviour stored in `navigation`, not part of the brand.

## When to use it

- Your own wording: "Continue", "Send my answers".
- Studies where earlier answers must not be changed after later questions are seen: hide Back.
- Long surveys in sections: let respondents move between sections they have visited.

## Set it up in the builder

::: steps Outline buttons with your own labels
1. **Open Branding → Buttons & navigation**.
2. **Style → outline**.
3. **Labels** — Next "Continue", Back "Previous", Submit "Send my answers".
4. **Show Back** — leave on (or switch off to make answers final).
5. **Check the preview** — the last page shows the Submit label.
:::

::: example theme-buttons

## How it is stored

```json
{ "branding": { "buttons": { "style": "outline", "nextLabel": "Continue", "backLabel": "Previous", "submitLabel": "Send my answers", "showBack": true } },
  "navigation": { "sectionNav": "off", "position": "top" } }
```

Labels are at most 60 characters. In Intelligent Mode, "hide the back button" and "show the back button" are read by the engine directly.

## Common mistakes

- **Long labels** — they wrap on phones; keep them to a word or two.
- **Hiding Back to stop straight-lining** — it stops changes, not careless answers; use quality checks for that.

## Troubleshooting

- *The Submit label never shows* — it appears on the last page of the respondent's path; with skips, that may be a different page from the last one in the editor.
