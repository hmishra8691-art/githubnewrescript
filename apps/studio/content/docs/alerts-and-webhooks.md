---
summary: Alerts to email, in-app, Slack, Teams or a webhook for study events, and per-response webhooks with answers by variable name and PII withheld
related: panel-integrations, actions, quotas
status: available
---
# Alerts, webhooks and response events

Alerts send **study events** — a quota filling, an AI interview's distress flag, the cost cap — to **channels**: email, the in-app bell, Slack, Teams or a signed webhook. **Response events** add one event per finished response, so another system (a CRM, a data warehouse) can react to each complete.

## Channels and events

| Channels | Who / where |
|---|---|
| email | an address, `@me` or `@team` |
| in-app | `@me`, `@team` or a user |
| Slack / Teams / webhook | your organisation's channel by name — the URL is a secret, stored sealed, never in the survey |

Events are named like `survey.quota_full` or `ai_interview.distress`; a rule can list events, a category (`ai_interview.*`) or `*`. **Response events**: `response.completed` (and optionally `response.screened_out`, `response.quota_full`).

## How it works

::: flow From an event to a channel
1. **Event** — a quota fills, a response completes
2. **Rule** — which events go to which channels
3. **Delivery** — immediately or in an hourly / daily digest; quiet hours and rate limits apply
4. **Webhook payload** — response id, survey, status, times; answers by variable name if allowed
:::

## Set it up in the builder

::: steps Send each complete to a webhook
1. **Open Alerts** — **Research Tools → Qualitative → Alerts & panels** (or ask Intelligent Mode — the `configure_alerts` action).
2. **Add a rule** — events **response.completed**, channel **webhook** `#crm-sync`.
3. **Choose the payload** — include answers (by variable name); likely-personal fields — typed text, email, phone, postal, places, files, embedded data — are left out unless you allow them by name.
4. **Test responses** — off by default; switch on to include sandbox and test links.
5. **Delivery** — immediate or digest, quiet hours, at most N messages an hour per channel.
:::

::: example alerts-webhooks

## How it is stored

`alerts` on the survey: `rules[]` (events, channels, digest), `responses` (enabled, events, includeAnswers, allowFields, includeTest), `quietHours`, `maxPerHour`, `dedupeMinutes`. Delivered messages are data in their own tables, not in the survey.

## Common mistakes

- **Expecting answers in Slack or email** — answers go only to webhook channels; the others get a one-line notice.
- **Personal data in the payload** — allow a field by name only if the receiving system may hold it.

## Troubleshooting

- *No message during testing* — response events skip test responses unless **include test** is on.
