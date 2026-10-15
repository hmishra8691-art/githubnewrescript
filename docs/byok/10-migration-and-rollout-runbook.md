# BYOK 10 — Migration and rollout runbook

## What changes in the database

Migration `0054_user_ai_providers.sql`: `user_ai_credentials`, `user_ai_settings` (RLS enabled and forced, **no policies**, all privileges revoked from `anon`/`authenticated`, `on delete cascade` from `profiles`), and `customers.ai_byok_allowed boolean default true`. Additive; no existing row changes. Code tolerates the migration being absent (since the Phase F follow-up fix): the account API answers `501 byok_unavailable` with the instruction to apply 0054, every AI call behaves exactly as before (a missing table means nobody has chosen their own provider), a project that demanded each person's own AI is refused in words, and the workspace policy defaults to allowed. Any other storage fault is a `503 byok_storage_error`, logged for the operator without a key. (Found in practice: the settings page showed "Request failed (500)" on a database without 0054.)

## Order

1. **Staging first** (`RESCRIPT_ENV=staging`). Apply 0054. Set `AI_CREDENTIAL_KEY` (a staging-only key).
2. Deploy the Studio build. Confirm no behavioural change for users with no configuration (platform AI as before).
3. Walk the live-account checklist in 12 with real keys, one provider at a time.
4. **Production**: apply 0054, set `AI_CREDENTIAL_KEY` (back it up in your secrets manager **before** the first user saves a key), deploy.
5. Decide the workspace policy per customer: leave allowed, or turn off for workspaces whose content must not leave the platform's providers.
6. Announce: Settings → AI & Integrations; respondent/interview AI stays platform-managed; own-provider work is paid to the provider and not billed here.

## Staged enablement (optional)

- Keep `AI_CREDENTIAL_KEY` unset in production at first → the feature is dark (screen explains; API answers "not enabled").
- Or deploy with the key set and turn user-managed AI **off** for every workspace, then enable per customer.

## Rollback

- **Soft:** unset nothing; turn the workspace policy off — saved settings are refused with a sentence and no AI moves to the platform silently, but also nobody is billed platform money for their calls. (Users see "turned off"; they can switch features back to the platform themselves.)
- **Code rollback:** redeploy the previous build. Data is inert: the tables are unread; nothing else references them. Do not drop them (users' keys would be lost).
- **Key loss:** if `AI_CREDENTIAL_KEY` is lost, saved keys cannot be opened: features resolve to a refusal `credential_unreadable`; users re-enter keys (Replace). Nothing is exposed.
- **Suspected key leak of one user's provider key:** the user replaces it at the provider and in Settings (Replace). Operator can ask the user; there is no operator view of keys by design.
- **Suspected master-key leak:** rotate (3), then ask users to rotate provider keys if the database was also exposed.

## Existing deployments

No user configuration ⇒ no behaviour change; tests pin this (platform path unchanged in `meterRun.test.ts`).

## Communication points for support

"My AI stopped working" → Settings → AI & Integrations → Test connection for that feature; the reason is spelled out. "I was charged" → Usage & cost; own-provider rows show no money; platform rows show the charge.
