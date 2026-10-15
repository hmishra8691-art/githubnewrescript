# BYOK 4 — API reference

All routes are `force-dynamic`, answer `cache-control: no-store`, and take **the acting person from the session** — never from the request. Errors are `{ error, code, problems? }`; `problems` maps field → sentence. A key is accepted and never returned.

## Account (signed-in person; `requireUser`)

### `GET /api/account/ai`
What the screen shows. Returns `vault {ready, reason?}`, `workspaceAllows`, `platformFallbackAvailable`, `platformSttFallbackAvailable`, `platformTranslateFallbackAvailable`, `catalog`, `sttCatalog`, `translateCatalog`, `credentials[]` (id, provider, label, mask, created/rotated, last test) and `features[]` for `intelligent`, `additional`, `stt`, `translation`: `{feature, kind, supported, mode: "platform"|"user", config, credential, fallbacks[], allowPlatformFallback, lastTest, updatedAt}`.

### `PUT /api/account/ai`
Save one feature.
```json
{ "feature": "intelligent", "mode": "user",
  "config": { "provider": "openai", "model": "…", "organizationId": "…" },
  "apiKey": "typed once", "credentialId": "or a saved key's id", "label": "optional",
  "fallbacks": [ { "credentialId": "…", "config": { "provider": "…", "model": "…" } } ],
  "allowPlatformFallback": false }
```
`mode: "platform"` clears the feature's configuration (keys are kept). Up to three fallbacks. Translation service: no `model`/`base` (ignored). *My AI model* needs *Other AI features* set to own provider first and takes no fallbacks.
Returns `{ ok: true, …overview }`. Audit: `user.ai_credential_saved` (if a key was saved), `user.ai_connection_changed`.

### `POST /api/account/ai/credentials`
Save or replace a key (used for fallbacks): `{ provider, apiKey, label?, credentialId? }` → `{ ok, credential }`. Replace keeps the same id so features keep working and clears the test.

### `DELETE /api/account/ai/credentials/{id}`
Remove a key. Features using it return to the platform's AI; fallbacks using it are dropped. → `{ ok, …overview }`.

### `POST /api/account/ai/test`
Test Connection: `{ feature, config, apiKey? | credentialId? }`. One real tiny request (chat: a one-token completion plus a JSON-mode probe; speech: one second of silence; translation: translates "OK"). → `{ ok, result: { ok, status, message, latencyMs, model, provider, jsonMode? } }`. The provider's own text and the key never come back. The result is stored as the feature's *last test*.

### `POST /api/account/ai/models`
`{ provider, base?, apiKey? | credentialId?, extra? }` → the models this key can use, or suggestions plus a sentence when the provider lists none; translation: "no model to choose".

### `GET /api/account/ai/usage?days=7|30|90`
Own-provider volumes (calls, tokens/characters/minutes, calls served by a fallback — **no money**) and platform charges (customer charge only), never summed. `501 billing_unavailable` when metering is not installed.

## Project (`requireProject`)

### `GET /api/surveys/{id}/ai-source` (project.read)
`{ source: "platform"|"user"|null, canChange, youWouldUse }` — what the project chose and what it means for the caller right now (provider/model or the refusal reason; no key).

### `PUT /api/surveys/{id}/ai-source` (owner; capability `billing.set_budget`)
`{ source: "platform" | "user" | null }`. Audit `project.ai_source_changed`. Also accepted at creation: `POST /api/surveys { aiSource }`.

## Administration (platform administrator; `requireAdmin`)

### `GET /api/admin/ai-policy`
`{ ok, workspaces: [{ id, name, slug, allowed }] }`. `501 byok_unavailable` when migration 0054 is not applied.

### `PATCH /api/admin/ai-policy`
`{ customerId, allowed: boolean }`. Audit `workspace.ai_byok_policy_changed`. Off: members cannot save a user-managed setting and a saved one is refused at use with a sentence; nothing is deleted.

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_feature`, `invalid_mode`, `unsupported_feature` | 422 | Unknown feature/mode; feature not supported for own provider |
| `invalid_config` | 422 | `problems` names the fields (key format, model, address, Azure region, …) |
| `key_required`, `provider_mismatch` | 422 | No key, or a saved key from another vendor family |
| `too_many_fallbacks`, `invalid_fallback`, `chat_required` | 422 | Fallback list / My-AI-model rules |
| `byok_blocked` | 403 | Workspace administrator turned user-managed AI off |
| `vault_unavailable` | 503 | No `AI_CREDENTIAL_KEY` on this server |
| `too_many_tests` | 429 | More than 12 test/model-listing requests in a minute |
| `not_found` | 404 | That saved key was not found (replace/remove another person's key looks the same) |
| `ai_connection` | 403 (`byok_blocked`), 503 (`vault_unavailable`), 409 (others) | At use: the person's chosen provider cannot be used; `why` is the refusal code (`no_connection`, `credential_missing`, `credential_unreadable`, `invalid_config`, `capability_missing`, `byok_blocked`, `vault_unavailable`, `unsupported_feature`); `source` is `user` or `project` |
| `stt_unconfigured`, `stt_unavailable` | 501 | No platform speech provider / format impossible |
| `wallet_*` | 402/423/503 | Platform AI refused on the wallet (own-provider calls never get these) |
