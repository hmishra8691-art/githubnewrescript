# BYOK 12 — Known limits and the live-account checklist

## The most important limit

**Nothing in this feature has been run against a live OpenAI, Anthropic, Google (Gemini, Cloud Speech, Cloud Translation), Groq, DeepL or Azure account.** There are no provider keys in the build environment, by design. Every adapter follows the service's documented request/response shape and is exercised end to end against **local HTTP servers that speak that contract** (real service code, real `guardedFetch` path with the private-endpoint switch on for loopback). The settings screen's browser suite stubs only the sign-in. So: correct against the contract as written; **unproven against the real services' quirks** until the checklist below is done.

## Live-account checklist (run once per provider, staging first)

For each: Settings → AI & Integrations → feature → choose the provider → paste a real key → **Find models** → **Test connection** → Save → exercise the feature → confirm Usage & cost.

| # | Provider | Check | Expect |
|---|---|---|---|
| 1 | OpenAI chat | Find models; Test (JSON mode line); an Intelligent Mode turn | models listed; "Connection works"; JSON mode accepted; own-provider row, no money |
| 2 | OpenAI with organization/project ids | Test with and without ids | ids sent as headers; bad id → words, not provider text |
| 3 | Anthropic (OpenAI-compatible endpoint) | Test; one copilot turn | works; speech synthesis refused (hybrid only) |
| 4 | Google Gemini (AI Studio key) | Test; one turn; confirm the key is **refused** for Cloud Speech/Translation | works; family mismatch message |
| 5 | Custom OpenAI-compatible (public https gateway) | Test; try a private address | works; private address refused on save |
| 6 | OpenAI / Groq speech | Voice instruction (≤25 MB); whisper-1 segments; gpt-4o-transcribe text-only | transcript; provider recorded |
| 7 | Google Cloud Speech | 5–10 s WebM/Opus; also a >60 s file | transcript; long file refused before request, fallback may take it |
| 8 | Google Cloud Translation | Test; translate a survey with `{{pipes}}`, `${vars}` and HTML | key in header (not URL); placeholders intact |
| 9 | DeepL Pro **and** Free | Right key on the right entry; deliberately the wrong one | 403 message names the Pro/Free mix-up; `EN-GB`/`PT-BR` variants correct; **ignore-tag handling around placeholders** |
| 10 | Azure Translator | Regional resource with region; global resource with none | works; `notranslate` class honoured (else string dropped, not broken) |
| 11 | My AI model translation | With *Other AI features* on an own key | uses that key; refused if that is on the platform |
| 12 | Fallbacks | Primary with a bad key, one listed fallback good | served by fallback, row marked "served by a fallback" |
| 13 | Last resort | Primary bad, no fallback, "platform last resort" ticked, funded wallet; then unfunded | platform row billed to wallet; unfunded → own failure in words |
| 14 | Workspace policy | Turn off for a test workspace | saving blocked, saved setting refused with sentence, nothing moved to platform; on → restored |
| 15 | Project choice `user` | Member with and without a key | own key used; member without told so |
| 16 | Rotation | Rotate master key on staging with the tool | report shows all re-wrapped; features still work |
| 17 | Billing | Empty the wallet | platform AI refused (402); own-provider calls still work |

## Known limits of the build

- **Browser suite scope.** The environment has no database, so the settings suite stubs `/api/auth/me` and the thin route wrappers and runs the **real service code** in the test process. Routes are covered by the auth-guard audit and service tests; a signed-in click-through on a real installation has not been done. The new admin panel (workspace policy) has no browser test; its route and audit event are covered by unit/structural tests.
- **The seven settings sections and this twelve-document list are my reading** of requirements whose original wording did not survive a session break. Headings/grouping can be reshaped without touching the engine.
- **`billing-test.mjs` is red** at "insufficient balance → 402" (the fake provider answers 200). It is on the repository's known-red list (`docs/BROWSER-CORPUS.md`) from before this work; its other checks pass. I did not re-run it on the pre-BYOK commit, so "pre-existing" rests on that record and a direct check that `meter.reserve` returns `insufficient_balance` for large character counts.
- Postgres-only suites are not run in this environment, by declaration.
- **Environment master key** protects database leaks, not a compromised server process; no KMS is implemented (the seam exists).
- **Respondent and interview AI** is platform-managed, always.
- **Story narration renders** (background) stay on the platform speech service; the story design assistant follows the person's choice.
- **Google speech** takes WebM/Opus, WAV, FLAC up to 60 s / 10 MB; no speaker separation. GPT-4o transcribe models return text only.
- **Not exposed:** DeepL formality and provider-side glossaries; Azure custom categories; Azure OpenAI deployments; regional/custom translation endpoints (a new registry entry each).
- **The cache identifies a translation by the primary's provider**, so a string served by a fallback is cached under the primary's id.
- **Own-provider cost** is never shown (the Studio does not know the person's price).
- **Model suitability** (★) is a hint from discovery and the JSON-mode probe, not a guarantee the copilot's contract holds for every model.
- **Usage window** reads at most 5000 events per request (90-day maximum).
- Per-project choice is set at creation and via the API, not on the account screen.
