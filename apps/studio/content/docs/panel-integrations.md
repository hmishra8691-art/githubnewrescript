---
summary: Connect a sample provider — Prolific, Cint/Lucid, PureSpectrum, Dynata, Toluna, CloudResearch, MTurk-style or custom — with entry IDs captured and outcome redirects, optionally signed
related: redirects, url-parameters, survey-termination, alerts-and-webhooks
status: available
---
# Panel integrations

A panel integration connects the survey to a **sample provider**: respondents arrive with the provider's IDs in the link, and at the end they are sent back with the right **outcome** — complete, screen-out, quota full, terminate or over quota — and the provider's code, optionally **signed**.

## Supported presets

Prolific · Cint / Lucid · PureSpectrum · Dynata · Toluna · CloudResearch Connect · MTurk-style completion codes · a custom panel. Each preset knows the provider's ID parameter and redirect format; a custom panel takes your own.

## How it works

::: flow A panel respondent's journey
1. **Entry** — the provider opens the link with its IDs (e.g. PROLIFIC_PID)
2. **Captured** — the IDs become embedded data, checked and de-duplicated
3. **Survey** — logic, quotas and screeners decide the outcome
4. **Exit** — the end for that outcome redirects to the provider with its code
5. **Signed (optional)** — an HMAC or hash signature added to the redirect
:::

## Set it up in the builder

::: steps Connect Prolific
1. **Open the panels settings** — **Research Tools → Qualitative → Alerts & panels**, or ask Intelligent Mode (the `connect_panel` action).
2. **Choose the preset** — the ID parameters and redirect format are filled in.
3. **Enter the codes** — the completion code, and codes for screen-out / quota full if the provider uses them.
4. **Choose where it applies** — the survey link (and AI interviews, group or live sessions where used).
5. **Signing (optional)** — algorithm, the parameter, what is signed; the secret is stored sealed, never in the survey.
:::

::: example panel-integration

## How it is stored

`panels[]` on the survey definition: the preset, the ID parameter, extra parameters, the redirect per outcome with `{{code}}`, the codes, signing settings (never the secret), de-duplication. Connecting also adds the embedded fields and the end redirects to the flow.

## Common mistakes

- **Testing without the ID** — a required ID that is missing is refused; test with `?PROLIFIC_PID=test`.
- **A screen-out with no end for it** — make sure screeners end at a terminate so the provider gets the screen-out code.

## Troubleshooting

- *The provider does not credit completes* — compare the redirect with the provider's documentation (the code and the parameter name).
