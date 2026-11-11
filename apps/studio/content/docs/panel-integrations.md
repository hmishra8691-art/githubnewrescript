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

## Add a vendor from its four redirect links

When a vendor sends you its four redirect links, paste them into **Intelligent Mode** — for example *"Add vendor Acme with these redirect links:"* followed by the links.

::: steps Add a vendor
1. **Paste the four links** — complete, screened out, quota full, and quality check / termination. Order does not matter, and labels ("Complete: https://…") are read if you give them.
2. **Review the proposal** — which link was read as which outcome and why, the vendor's code, the parameter that carries the respondent's ID, the link to give the vendor, and the checks.
3. **Test the redirects** — every vendor's four exits, resolved for a test ID.
4. **Apply** — the vendor is added. Nothing is written before this.
5. **Launch study** — saves a version, publishes it, and shows the survey link and each vendor's link with **Copy**.
:::

- **Recognition is by evidence, never by position.** A link is given an outcome when its own words say so (`status=complete`, `/quotafull`), when it matches a preset's documented link, or when you labelled it. A link that cannot be told apart — four links that differ only by a number — is a question, with the answer one click away.
- **Each vendor is independent.** A new vendor gets a code no other vendor has (it travels as `rp=<code>` on that vendor's link and is recorded as the response's source). Adding a vendor never changes another vendor, an end, a quota or a skip rule; the change is refused if it would.
- **Each vendor's respondents leave by that vendor's links** — at an end of the survey, on a full quota, and when a skip rule screens somebody out. Respondents who came from no vendor leave exactly as they did before.
- **A vendor that already exists is not touched** until you say whether to update it or add a separate entry; an update is shown and confirmed before it is applied.

## How it is stored

`panels[]` on the survey definition: the preset, the ID parameter, extra parameters, the redirect per outcome with `{{code}}`, the codes, signing settings (never the secret), de-duplication. Connecting a preset adds the embedded fields and fills ends that have no redirect. A vendor added from its links adds only its own embedded fields (`rp` and its ID parameter): the ends are left as they are, and the vendor's link is chosen when its respondent leaves.

## Common mistakes

- **Testing without the ID** — a required ID that is missing is refused; test with `?PROLIFIC_PID=test`.
- **Giving two vendors the same link** — each vendor's link carries its own `rp=<code>`; without it, two vendors that use the same ID parameter cannot be told apart.
- **A screen-out with no end for it** — make sure screeners end at a terminate so the provider gets the screen-out code.

## Troubleshooting

- *The provider does not credit completes* — compare the redirect with the provider's documentation (the code and the parameter name).
