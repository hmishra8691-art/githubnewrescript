# User-owned AI providers — Phase A: foundation (2026-10-14)

Scope: everything underneath the feature — nothing yet changes which provider a request goes to. Phase B wires `meteredAi` to the resolver; until then every request is still platform-managed, so Phase A is safe to deploy on its own.

## What exists now

| Layer | File | What it does |
|---|---|---|
| Network safety | `packages/ai/src/netguard.ts` | `validateEndpoint` (https only, no credentials/query, no localhost/.local/.internal/single-label, ports 443/8443, ≤300 chars) and `guardedFetch` (DNS answer checked and **pinned** into the socket lookup, any private/loopback/link-local/CGNAT/ULA/mapped/6to4/Teredo/NAT64 answer refuses, redirects refused, response size capped, abortable). |
| Whose provider | `packages/ai/src/connection.ts` | `withAiScope` (AsyncLocalStorage). Inside a user scope the base, key, model, headers and fallbacks come from the scope; the installation's environment is not consulted, the operator fallback is unreachable, and requests go through `guardedFetch`. `aiIdentity()` names a connection (hash, no secret) for cache/in-flight keys. |
| Catalog | `packages/ai/src/registry.ts` | OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Mistral, DeepSeek, Together, xAI, and an OpenAI-compatible custom endpoint; per-provider optional identifiers (organization, project, workspace) sent as whitelisted headers; `validateConnection` forces a fixed provider's address from the registry; `discoverModels` lists the models **this key** can use and says in words why it could not. |
| Vault | `apps/studio/lib/byok/vault.ts` | AES-256-GCM envelope encryption: a random data key per credential, wrapped by `AI_CREDENTIAL_KEY`; AAD binds the blob to `user id | credential id`; rotation via `AI_CREDENTIAL_KEY_PREVIOUS` + `rewrap`; no master key ⇒ nothing is stored. `wrapKey/unwrapKey` are the only master-key operations (KMS seam). |
| Store | `apps/studio/lib/byok/store.ts` + migration `0054` | Every method takes the acting user's id; memory and Supabase implementations. RLS forced, **no policies**, all privileges revoked from `anon`/`authenticated`. |
| Resolver | `apps/studio/lib/byok/resolve.ts` | project → user → platform. User-managed **never** silently becomes platform: any unusable state is a `refused` with a sentence. Fallbacks are the user's own list (max 3); a broken one is skipped and reported; the platform only if the user allowed it. |
| Service + API | `lib/byok/service.ts`, `app/api/account/ai/**` | Overview (masked), save per feature, save/rotate/remove a key, **Test Connection** (real one-token request, provider text never returned), model discovery; per-user rate limit on the two probes; audit events `user.ai_credential_saved / removed / ai_connection_changed` (never the key, not even its mask). |

## Security properties, and the test that holds each

- A stored blob contains neither the key nor a fragment of it — `vault.test.ts`.
- A blob copied to another user's row, another credential's row, or with one tampered byte does not open — `vault.test.ts`.
- No master key ⇒ saving is refused with a sentence; the key is never stored unencrypted — `vault.test.ts`, `service.test.ts`.
- Another user can never use, rotate, list, delete, test with, or name as a fallback Alice's key — `service.test.ts`, `resolve.test.ts`.
- A key saved for Anthropic is never sent to OpenAI (provider mismatch refused on save and on resolve) — both.
- A fixed provider's address cannot be redirected by the request body — `service.test.ts`.
- A private-address custom endpoint is refused on save, on test, and again on every use — `netguard.test.ts`, `service.test.ts`, `resolve.test.ts`.
- A user's provider never receives the platform's workspace id/headers/key, and its failure never reaches the operator fallback — `connection.test.ts`.
- 30 concurrent scopes do not swap keys — `connection.test.ts`.
- Test Connection and model listing never return the provider's body or the key — `service.test.ts`.
- `openSecret` is called in the resolver and the service only; the ciphertext and the master key appear nowhere else; the credential tables are queried only from the store; every account route is behind `requireUser` — `containment.test.ts` + `scripts/auth-guard-audit.mjs`.

## Operator action before BYOK can be used

1. Apply migration `0054_user_ai_providers.sql`.
2. Set `AI_CREDENTIAL_KEY` (32 random bytes, 64 hex characters or base64) in the Studio's environment, e.g. `openssl rand -hex 32`. Without it the API answers "not enabled on this installation".
3. Rotation later: set the new key as `AI_CREDENTIAL_KEY` and keep the old one in `AI_CREDENTIAL_KEY_PREVIOUS`.
4. Optional: `AI_BYOK_ALLOW_PRIVATE_ENDPOINTS=1` permits custom endpoints on private networks (self-hosted gateways). It is an operator switch, never a user input; leave it unset on a public deployment.

## Verification run

`pnpm typecheck` clean · `pnpm -r test` all green (studio 414, ai 86, engine 1788, interviews 177, analytics 465 …) · `auth-guard-audit` 183 handlers, 0 problems. No UI exists yet, so no browser regression applies to this phase.

## Known gaps carried to the next phases

- `meteredAi` does not resolve a scope yet (Phase B) — nothing changes for any request today.
- Cache and single-flight keys inside `@rescript/ai`/the copilot must include `aiIdentity()` when scopes are first used (Phase B, with a test that two users asking the same question never share an answer).
- STT and translation resolve to "unsupported" for user-managed mode until Phases C and D (the API refuses to save them as user-managed).
- Project-level selection storage and the settings UI are Phases B and E.
