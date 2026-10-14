# "THE AI SERVICE COULD NOT PROCESS THIS REQUEST" — root cause and fix (2026-10-14)

**Symptom.** A Hindi voice prompt ("design a small research study, five questions, left / right / centre") ended on the card *THE AI SERVICE COULD NOT PROCESS THIS REQUEST — try rephrasing … tell your administrator, the Studio's log has the details.* The log had no details.

## What the card proves (and what it does not)
The card is the failure code `provider`. In the code it is reached only by (a) a provider refusal classed `bad_request` (HTTP 400/422/other 4xx the old classifier did not recognise), or (b) an exception whose text matched nothing. It is **not** auth (401), forbidden (403), quota-by-429, not-found (404), capacity, timeout or network — each of those has its own card, and the same screen showed none of them. So the key authenticated and the model name resolved; the provider answered **HTTP 400**.

## Root cause (two defects, one visible symptom)
1. **A 400 that means "your account has no credit" was read as "your request is malformed".** Anthropic answers an empty balance with `HTTP 400 invalid_request_error: "Your credit balance is too low to access the Anthropic API…"` (and a disabled organization with 400 too). `classifyResponse` read out-of-credit wording only for 429/403/402, so these fell to `bad_request` → the `provider` card, which tells the researcher to *rephrase* a request that was never the problem. The Studio had just been re-pointed at a fresh Anthropic key/workspace, which is exactly when a balance is zero.
2. **The provider's own words were thrown away.** `managedSend` deliberately skipped logging `bad_request` (JSON-mode probing would flood the log) and the route's failure log omitted `ProviderError.detail`, so for this class of error the log "had no details" — the card's promise was false.

Confirmed in the code and by test over real HTTP (a local server answering exactly as Anthropic does); *not* confirmed against the live provider from here — that needs the one log line / the new check below.

## What changed
- `packages/ai/src/provider.ts` — `classifyResponse` reads the body's words for every 4xx: spent credit / billing limit → `quota_exhausted` (not retried, remembered 30 s, "add credit" card); "organization disabled" → `forbidden`; "model … does not exist" on a 400 → `not_found`; context-too-long stays `bad_request` (+ compact retry). A genuine malformed request stays `bad_request`. New `redact()` (keys, bearer tokens, `x-api-key`, credentials in URLs) applied to every stored provider message; `providerHealth(now, {detail})`; `said` added to `refused`/`gave_up` log lines.
- `packages/ai/src/index.ts` — a refused request (`bad_request`) is now logged once, redacted, with `said`, status, max_tokens and whether a schema was sent; `probeProvider()` asks the provider three miniature questions (plain, JSON schema, the output ceiling) and names the one refused.
- `apps/studio/app/api/copilot/turn/route.ts` — failure log carries `said`.
- `apps/studio/app/api/ai/health/route.ts` — `POST` (platform admin): runs the check; `GET` for admins shows the last provider words.
- `apps/studio/components/AiConnectionPanel.tsx` + Administration → **AI connection** tab: "Check the AI connection" → verdict + table (plain / schema / ceiling) + what the provider said.
- `failure.ts` — the `provider` card now has a "For your administrator" line pointing at that check and the `said` log field.

## How to resolve it for good
1. Administration → AI connection → **Check the AI connection**. If it says out of credit: add credit / raise the spend limit in the Anthropic Console (Plans & Billing) for the **workspace the key belongs to**; researchers press **Resume** — nothing is retyped. If it names the key, model, schema or ceiling, it says which variable (`AI_API_KEY`, `AI_MODEL`, `AI_MAX_OUTPUT_TOKENS`).
2. Optional: `AI_FALLBACK_API_URL/KEY/MODEL` — a second provider takes over when the first is out of credit or refusing the key.

## Tests
`packages/ai` 68 (new: 400 credit/disabled/model/malformed/context classification; redaction; credit 400 → one request, not re-asked, logged; malformed 400 logged with `said`; probe verdicts). `apps/studio` 386 (new `providerCredit.test.ts`: real HTTP server answering like Anthropic → card `quota`; a malformed 400 → `provider` card with admin pointer and the provider's words in the log). `packages/interviews` 177; `auth-guard-audit` 0 problems; browser: provider-resilience 16, copilot 11, ux 13, phase1 9, phase2 13, intelligent-mode (see run).

## Limits
Lane/health state is per server instance. The check costs a few tokens. Whether *this* deployment's refusal was the credit balance is inferred from the card and Anthropic's documented behaviour; the check, or the `[rescript:ai] refused … said` log line on the next failure, settles it in one click.
