---
summary: Send respondents to another URL — panel completes, partner sites — with answers and embedded data piped into the link
related: embedded-variables, url-parameters, survey-termination, piping
status: available
---
# Redirects

A redirect **sends the respondent to another web address** — most often back to a panel provider with their ID and status, so the panel can record the complete.

## When to use it

- Panel completes, screen-outs and quota-fulls, each to its own URL with the respondent's ID.
- Handing over to another survey or site.

## Set it up in the builder

::: steps Redirect to the panel with the respondent's ID
1. **Capture the ID from the link** — add an embedded field `PID` with source URL (see [URL parameters](url-parameters)).
2. **Add the redirect** — in **Programming → Survey Flow**, **+ Add element** → **Redirect** after the last question; or set a redirect URL on an **End of survey** element (one per status).
3. **Write the URL with pipes** — `https://panel.example.com/complete?pid={{ed.PID}}&status=1`.
4. **Choose a new window (optional)** — the redirect can open in a new tab instead of replacing the survey.
5. **Gate it (optional)** — a redirect can have a condition (`when`).
:::

::: example redirects

## How it is stored

```json
{ "type": "redirect", "url": "https://panel.example.com/complete?pid={{ed.PID}}&status=1" }
```

Options: `newWindow`, `when`. Skip logic can also send to a URL (`target.kind: "url"`), and an end node has `redirectUrl`.

## What the respondent sees

After the last page the browser goes to the URL, with the piped values filled in. The response is saved before the redirect.

## Common mistakes

- **Forgetting the ID** — without `{{ed.PID}}` the panel cannot credit the respondent.
- **Not URL-safe values** — pipe IDs and codes, not free text.

## Troubleshooting

- *The URL contains an empty pid* — the link did not carry `PID`; test with `…?PID=test123`.
