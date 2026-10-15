# BYOK 3 — Security and the vault

## What is protected, from whom

| Threat | Control |
|---|---|
| A database dump or backup leaks | Keys are stored only as AES-256-GCM envelopes. The master key is **not** in the database. Without it the table is noise. |
| A signed-in user (or a policy mistake) reads another user's keys | RLS forced with **no policy**, all privileges revoked from `anon`/`authenticated`; only the server (service role) reads the tables, and the store takes the acting user's id on every method. |
| A ciphertext copied to another row/user | AAD binds each blob to `user id | credential id`; a copy does not open (`vault.test.ts`). |
| A key leaks through the browser, logs, errors, cache, URLs | Routes never return a key (a mask only, not even in audit events); provider error text is never returned; `redact()` at the boundary; a repository test greps client files for the vault/tables; no key-bearing logging in byok/account code. |
| SSRF through a custom endpoint | https only, no credentials/query, DNS answer checked **and pinned**, private/loopback/link-local/metadata/CGNAT/ULA/mapped ranges refused, redirects refused, ports 443/8443, size and time caps — at save, at test, and at every use. |
| One user's key used for another | The resolver is keyed by the acting user; a project owner's key is never used for a member; 30 concurrent scopes tested for no swap. |
| A key sent to the wrong vendor | Key families; provider mismatch refused on save and on resolve. |
| A user-managed failure silently costing platform money | Refusal-in-words; the platform is used only if the person ticked "last resort", and then it is billed to their wallet as platform usage. |
| Shared-workspace data going to a personal provider | Per-workspace switch (`customers.ai_byok_allowed`), administrator-only, audited. |

## The vault format

- `seal(userId, credentialId, secret)`: a random 256-bit data key encrypts the secret (AES-256-GCM, fresh nonce, AAD = `userId|credentialId`); the data key is wrapped by the master key identified by `key_id`. Stored: `sealed` (ciphertext + nonce + tag + wrapped key + key id), `mask`, `key_id`.
- `openSecret` is called only from `resolve.ts`, `service.ts` and `vault.ts`; a test enumerates callers (`sweep.test.ts`).
- No master key → nothing is stored and the API answers "not enabled on this installation". There is **no unencrypted fallback**.

## Master key and rotation

- `AI_CREDENTIAL_KEY`: 32 random bytes as 64 hex characters or base64 (`openssl rand -hex 32`). Back it up **separately** from the database: lose it and every saved key is unrecoverable (users re-enter them).
- Rotation: (1) generate a new key; (2) set it as `AI_CREDENTIAL_KEY` and move the old one to `AI_CREDENTIAL_KEY_PREVIOUS` (comma-separated list); (3) run `node scripts/byok-rotate-keys.mjs --dry-run`, then without `--dry-run`; (4) when the report shows nothing remaining under old keys, remove them from `AI_CREDENTIAL_KEY_PREVIOUS`.
- The tool (`lib/byok/rotate.ts`) re-wraps data keys only — **it never decrypts a user's secret**. Rows it cannot open (wrong/missing key) are counted and left untouched; nothing is deleted. Exit codes: 0 ok, 1 unreadable rows exist, 2 error.
- Honest limit: an environment master key protects against database leaks, not against a compromised server process. The seam for a KMS exists (`wrapKey/unwrapKey`) but no KMS is implemented.

## Audit trail

`user.ai_credential_saved`, `user.ai_credential_removed`, `user.ai_connection_changed`, `project.ai_source_changed`, `workspace.ai_byok_policy_changed`. Details name the provider/feature/mode, never a key or mask.

## Rate limits

Test Connection and model discovery reach out on a user's say-so: bounded per user (12 per minute).
