---
summary: Distribution and fieldwork — access modes, personal links for a live and a test list, the QR code, and fieldwork by source with declared sources and supplier links
related: panel-integrations, url-parameters, versions-and-deploy, quotas
status: available
example: none
---
# Distribution and fieldwork

**Who can open the link** is the survey's **access mode** (Survey Settings): **open** (anyone with the link), **password**, **unique links** or **invitation** — the last two need a personal link for each respondent.

**Management → Distribution** holds those personal links:

- **Live list and test list** — kept apart: live tokens only open the live link, so you can rehearse with a few rows of the client's file without using their real invitations.
- **One link per person** — the token is generated inside the database; nobody, including the application, can guess or reconstruct another respondent's link. Links are not shown on screen; download the list to send them.
- **Progress** — people, links sent, not sent, **still waiting** (invited, sent, not opened), started and completed. Where no mail is configured, the links come out as a file and **mark sent** records that they went.
- **QR code** — for a poster or a card: it encodes the open live link and carries no token. It is SVG, sharp at any size.

**Results → Fieldwork** shows where respondents came from, per **source**, captured from the link when the session starts: completes against target, starts, in progress, screened, quota full, incidence, completion, median time and the last response. **Declare a source** to give it a name, a completes target and its own link; a source that arrives undeclared is still recorded. Each source link carries `src=` for the source and `pid=` for the supplier's own respondent ID (replace the placeholder with the supplier's macro). The source is recorded once, at the first page.

## When to use it

- Customer lists and panels of your own: unique links or invitations, with progress per person.
- Several sample suppliers: one declared source each, with its target and link.
- Events and print: the QR code.

## Set it up in the builder

::: steps Send personal links
1. **Survey Settings → access mode → unique links** (or invitation).
2. **Management → Distribution → Live list → Add people** — upload the list.
3. **Download the list** with each person's link and send it.
4. **Mark sent** (when mail is not configured here), then watch **still waiting**.
5. **Rehearse first** on the **Test list** with a few rows.
:::

::: screen distribution

## Common mistakes

- **Uploading people while the access mode is open** — the list is not consulted; set unique links or invitation.
- **Sharing a personal link publicly** — it is a credential for one person; use the open link or the QR code for the public.

## Troubleshooting

- *A respondent's link does not open the survey* — a test token opens only the test link, a live token only the live link.
- *A supplier's completes are missing* — their link must carry `src=`; check the source code in Fieldwork.
