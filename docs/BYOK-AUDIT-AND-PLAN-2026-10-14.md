# User-owned AI providers (BYOK) — audit, risks and implementation plan (2026-10-14)

Status: **audit complete, plan proposed, nothing implemented.** Four decisions are needed before code (end of this document).

## 1. The existing AI architecture (what is there today)

**One global configuration, read from `process.env` inside every call.** `packages/ai/src/index.ts` reads `AI_API_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_MODEL_SMALL`, `AI_WORKSPACE_ID`, `AI_API_HEADERS`, `AI_EMBEDDINGS_MODEL`, `AI_VISION_MODEL`, `AI_STT_API_URL/KEY/MODEL`, `AI_TTS_MODEL`, `AI_FALLBACK_*`, `AI_MAX_CONCURRENCY`, `AI_MAX_OUTPUT_TOKENS` at call time. There is no notion of "whose" key; every user, project and respondent shares one provider. `AI_API_URL=fake:` selects in-process stand-ins (tests).

**Request manager (new this week).** `packages/ai/src/provider.ts`: classification, Retry-After, jittered bounded retries inside a deadline, per-provider *lane* (cool-down, concurrency; keyed by host + hash of the key — already safe for several keys), fallback provider (`AI_FALLBACK_*`, operator-level), `redact()`.

**Capabilities and who calls them**

| Capability | Entry points (`@rescript/ai`) | Callers |
|---|---|---|
| Chat / structured JSON | `completeJson`, `complete`, `classify`, `sentiment`, `rephraseForSpeech`, `writeProbe` | Studio: copilot turn/ask/workflow/output/documents, ai/logic, ai/rephrase, import/analyze, import/custom-logic, import/quotas, analyticsAsk, analyticsBuilder, storyService, AiConversationPanel; analytics package (`findings`, `synthesis`, callback-injected); interviews runner (analysis); runtime `session/ai` (probing) |
| Embeddings / OCR / vision | `embedTexts`, `ocrImage` | copilot research store |
| Speech-to-text | `transcribe` (OpenAI-compatible `/audio/transcriptions`; Anthropic host refused with a reason) | Studio `ai/transcribe` (voice input), `surveys/[id]/media/transcript`; **runtime** `session/media/transcript` (respondents); **interviews** runner |
| Text-to-speech | `synthesizeSpeech` | Studio `ai/tts`, `analyticsBuilder` (report narration); browser speech provider in `renderer` is separate and local |
| Translation | `translationAdapter()` → **Google v2** (`GOOGLE_TRANSLATE_API_KEY`, `GOOGLE_TRANSLATE_ENDPOINT`), **LLM** (the chat provider), **fake**; `TRANSLATION_PROVIDER` picks; cache (memory + DB), placeholder/tag protection, friendly error vocabulary | Studio `ai/translate`, `translation/{languages,status,memory}` |

**Billing door.** Studio `lib/metering.ts`: `meteredAi`, `meteredStt`, `meteredTranslation` → `aiAllowed` (project AI switch, `settings.ai.mode/disabled`, `aiPolicy.ts`; a repository test fails if a provider-reaching file skips a gate) → `meter.reserve` → run inside `collectUsage` (AsyncLocalStorage usage sink) → `meter.settle` (priced from the rate registry: `ai.chat.<model>.in/out`, `google|deepl|microsoft.translate.*`, STT per minute) or `release` on throw. `usage_events` already carries `user_id, provider, service, model, quantity, input/output_units, provider_cost, customer_charge, metadata`. DeepL and Microsoft rate rows already exist in the registry.

**Credentials today.** Only server environment variables. **No encryption code, no secret store, no per-user key exists anywhere.** `profiles` holds identity only (`name, organization, jobTitle` editable). Account area: `AccountHeader` nav (Profile, Security, My usage, Administration, Billing). Project creation: `POST /api/surveys` (`title`, `code`, `definition`, `strict`); project AI switch lives in `surveys.settings.ai`.

**SSRF tooling that can be reused:** `lib/brandScrapeCore.ts` has a private/loopback/link-local/metadata address classifier (tested incl. `169.254.169.254`, IPv4-mapped IPv6). It is not yet DNS-resolution-aware or redirect-aware.

**Two data planes call AI without a signed-in researcher:** `apps/runtime` (respondent audio transcription, AI probing, rephrase) and `apps/interviews` (transcription, analysis). They resolve the *survey's customer* for billing, never a user.

## 2. Environment variables, classified

| Class | Variables | In the new UI? |
|---|---|---|
| Platform-owned secrets | `AI_API_KEY`, `AI_STT_API_KEY`, `AI_FALLBACK_API_KEY`, `GOOGLE_TRANSLATE_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `RESEND_API_KEY`, `R2_*`, `GEOCODE_API_KEY` | Never shown; stay server-side. They remain the "platform-managed" source. |
| User-configurable AI settings (per user, per feature) | provider, base URL, model(s), key, workspace/org/project id, extra headers (whitelisted), STT language, translation source/target defaults, fallback policy | Yes — as per-user records, not env vars |
| Public config | `NEXT_PUBLIC_*` | No |
| Internal infrastructure | `SUPABASE_URL`, `BILLING_*`, `AI_MAX_CONCURRENCY`, `AI_MAX_OUTPUT_TOKENS` (operator ceiling), `AI_FALLBACK_*` (operator fallback) | No |
| NEW (operator) | `AI_CREDENTIAL_KEY` (master key for the vault), `AI_BYOK_ALLOW_PRIVATE_ENDPOINTS` (default off) | No |

## 3. The design

**Provider registry** (`packages/ai/src/registry/`): one typed entry per provider — id, label, capabilities (`chat`, `json_schema`, `embeddings`, `vision`, `stt`, `tts`, `translate`), default base URL, auth scheme, required/optional extra fields (workspace, project, org, deployment, region), request format (adapter id), model source (`discover` via the provider's list endpoint, or `curated`), per-model capability flags, endpoint policy (fixed / custom allowed), validation rules. Only providers with a working, tested adapter are listed. Model entries are never advertised unless discovered from the provider or verified by the Test Connection probe.

**Adapters behind one interface** — `ChatAdapter`, `SttAdapter`, `TranslateAdapter`. Planned set (each ships only with tests): chat — OpenAI, Anthropic (OpenAI-compatible endpoint, as now), Google Gemini (its OpenAI-compatible endpoint), generic OpenAI-compatible (OpenRouter, Groq, Mistral, DeepSeek, Together, self-hosted behind a public HTTPS URL); STT — OpenAI-compatible (OpenAI, Groq, others), Google Cloud Speech-to-Text (own adapter); translation — Google Cloud Translation (exists), DeepL (new), Microsoft Azure Translator (new), LLM translation (reuses the chat configuration). *Not* planned in this build: Azure OpenAI deployments (different URL scheme), native non-OpenAI chat protocols.

**Credential vault** (migration 0054): `user_ai_credentials` (user_id, slot, ciphertext, nonce, key_id, mask, created/rotated) and `user_ai_settings` (per feature: mode `platform|user`, provider, base URL, model, extra ids, fallback policy, test status). RLS enabled with **no** policies for the anon/authenticated roles (deny by default); only the Studio server (service role) reads them. AES-256-GCM, a random data key per credential wrapped by the master key (`AI_CREDENTIAL_KEY`, versioned `key_id` for rotation), AAD = user id + slot (a ciphertext cannot be replayed under another user). The browser receives `{hasKey: true, mask: "sk-…abcd"}` only. Replace = new ciphertext; Remove = row deleted and lanes for that key forgotten. Decrypt exists in exactly one module, called only by the resolver.

**Resolver** (`apps/studio/lib/aiConfig/`): `resolveConnection({user, project, feature, capability})` → `{source: "platform"|"user"|"project", provider, baseUrl, model, headers, key (in memory only), fallback}` using precedence project override → user setting for that feature → platform default; validates capability support; refuses (never silently switches) when a user connection is broken and platform fallback is not explicitly enabled. Result is placed in an `AsyncLocalStorage` scope (`withAiConnection`) that the `@rescript/ai` functions consult before `process.env` — so the ~40 call sites keep their signatures and nothing can forget to pass it. With no user configuration, behaviour is byte-for-byte today's.

**Endpoint safety:** HTTPS only; no credentials in URLs; DNS resolved and every address checked against private/loopback/link-local/metadata/CGNAT/ULA ranges; the connection pinned to the checked address (defeats DNS rebinding); redirects not followed; port allow-list; response size/time caps; extra headers whitelisted (never `authorization`/`host`). Reuses and extends `brandScrapeCore`'s classifier.

**Billing:** `executionSource: "user"` events are written through the same meter with `customer_charge = 0`, `provider_cost` null unless the provider reports it, metadata `{executionSource, provider, model, units}`; no wallet debit and no reservation block for the external AI cost. Platform fees (storage, responses, exports) are untouched. Platform-managed calls follow today's rules exactly. The usage view separates *Paid to your provider (not billed here)*, *Platform AI usage*, *Platform service fees*, and never shows an invented cost.

**Fallbacks:** explicit, per feature, ordered: user primary → user secondary → platform (only if the user ticked "allow platform AI as last resort", and then billed as platform usage). Bounded retries/backoff come from the request manager; quota and auth errors are never retried; the model/provider actually used is recorded on every event. Never another user's key, by construction (the resolver is keyed by the acting user id).

## 4. Risks and how each is closed

1. **Cross-user contamination.** In-flight call sharing (`singleFlight`), the copilot reply cache and the output-ceiling/JSON-mode memories are keyed without the credential. A shared reply could cross users. → every such key gets the connection's identity (provider + base + hash(key)); regression tests prove user B never receives user A's cached reply.
2. **No master-key infrastructure.** An env master key protects against database leaks but not against a compromised server. → documented honestly; vault interface is KMS-ready (wrap/unwrap are the only operations).
3. **Runtime / interviews separation.** Decrypting a researcher's key inside the public respondent app would widen the blast radius. → respondent-facing and interview AI stay on the *project's* platform/BYOK choice but are executed by a Studio-side signed gateway that returns results only, in a later phase; until then those features remain platform-managed and the UI says so.
4. **SSRF / rebinding / redirect abuse** on custom endpoints → §3 above, with tests including `169.254.169.254`, IPv4-mapped IPv6, decimal/octal IPs, `localhost`, redirect to internal, DNS answering a private address.
5. **Key leakage** through provider errors, logs, analytics, history rows (`recordOp`), health endpoint → `redact()` at the boundary, a repository test that greps for key-bearing fields in logs/responses, the existing log-has-no-secrets tests extended with a user key.
6. **Governance in shared workspaces.** A collaborator's key would receive an organisation's survey content. → per-workspace switch for administrators (allow/forbid user-managed AI), and the acting user's identity is on every event.
7. **Model quality.** A small model may not follow the copilot's JSON/action contract. → "suitable for Intelligent Mode" requires `json_schema` or JSON mode + context ≥ a stated minimum and is verified by a capability probe; unsuitable models are shown but marked.
8. **Billing under/over-charge.** The wallet gate must not block a user spending their own provider's money, and must not waive platform fees. → separate event class, tests over the ledger.
9. **Catalog rot.** Hard-coded model lists go stale. → discovery where the provider has a list endpoint, a small curated "recommended" set with a last-verified date, manual model id entry always allowed for compatible endpoints.
10. **Existing deployments.** No user config ⇒ no behaviour change; migration is additive; tests pin this.

## 5. Phases (each tested, committed, delivered, with a note — then I stop for your go-ahead)

- **A — Foundation:** registry, vault + migration 0054, endpoint guard, resolver + `withAiConnection`, redaction, cache/lane keying, account API (masked CRUD, test-connection), unit + security tests. No UI yet beyond a minimal account route.
- **B — Intelligent Mode & all chat features** on the resolver; byok billing events; fallback policy; "which configuration will be used" shown on the card; project-level selection at project creation.
- **C — Speech-to-text:** adapters (OpenAI-compatible, Google), per-user resolution for voice input, media transcription; runtime/interviews decision from risk 3.
- **D — Translation:** shared service resolving the user's config; Google (own key), DeepL, Azure adapters; no silent paid fallback.
- **E — Settings UI:** Settings → AI & Integrations → AI Provider Configuration (all seven sections), masked key, test buttons, unsaved indicators, usage and cost view.
- **F — Regression sweep and the 12 deliverables.**

(UI is Phase E in the order of dependency; I can pull a thin UI forward into A/B if you want to dogfood earlier.)
