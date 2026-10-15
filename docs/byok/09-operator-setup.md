# BYOK 9 — Operator setup and environment

## Before anyone can use their own provider

1. **Apply migration** `supabase/migrations/0054_user_ai_providers.sql` (additive: two tables, RLS forced with no policies, one column `customers.ai_byok_allowed default true`).
2. **Set `AI_CREDENTIAL_KEY`** in the **Studio's** environment (never the runtime or interviews apps): 32 random bytes as 64 hex characters or base64 — `openssl rand -hex 32`. Mark it Sensitive on Vercel. **Back it up separately from the database.** Without it, nothing is stored and the screen says "not enabled on this installation".
3. Deploy. With no user configuration, behaviour is exactly what it was.

## Environment

| Variable | Where | Meaning |
|---|---|---|
| `AI_CREDENTIAL_KEY` | Studio | Master key of the vault (above). |
| `AI_CREDENTIAL_KEY_PREVIOUS` | Studio | Optional, comma-separated retired master keys that can still **open** what they sealed; set while rotating, drop when `byok-rotate-keys` reports none remaining. |
| `AI_BYOK_ALLOW_PRIVATE_ENDPOINTS` | Studio | Optional, default off. Lets a custom endpoint use plain http or private/loopback addresses (a model server on your own network). **Leave off on a shared installation** — it is the SSRF guard. |
| `AI_API_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_STT_*`, `GOOGLE_TRANSLATE_*`, `AI_FALLBACK_*` | Studio/runtime | Unchanged: the **platform's** providers. Still required for platform AI, for respondent/interview AI, and as the platform "last resort" if you offer it. A BYOK-only installation can leave them unset; platform features then say so. |
| `AI_API_URL=fake:` | tests | In-process stand-ins; never in production. |

## Administration

- **Workspace policy:** Administration → AI tab → *User-managed AI by workspace* (`GET/PATCH /api/admin/ai-policy`). Default allowed. Turning it off blocks saving and using user-managed settings for that workspace's members; nothing is deleted; turning it on restores. Audited as `workspace.ai_byok_policy_changed`.
- **Platform status:** the existing AI connection panel is unchanged.
- **Audit:** events listed in 3.

## Key rotation

`node scripts/byok-rotate-keys.mjs --dry-run` then without `--dry-run`. Needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AI_CREDENTIAL_KEY` (+ `AI_CREDENTIAL_KEY_PREVIOUS`). Prints total / re-wrapped / already current / unreadable / remaining per key. Exit 0 ok, 1 unreadable rows, 2 error. Never decrypts a secret.

## Capacity and limits

Test Connection and model discovery: 12 per user per minute. Per-provider request lanes (cool-down, concurrency) are keyed by host + key hash, so several users' keys do not share a lane. `AI_MAX_CONCURRENCY` and `AI_MAX_OUTPUT_TOKENS` remain operator ceilings.

## Health checks after deploy

1. `GET /api/account/ai` as a test user → `vault.ready: true`.
2. Save a real key for one provider, **Test connection**, expect "Connection works".
3. Run one call of each feature; check Usage & cost shows an own-provider row with no money, and a wallet balance unchanged.
4. Turn the workspace policy off for a test workspace; confirm the saved setting is refused with the sentence, then on again.
