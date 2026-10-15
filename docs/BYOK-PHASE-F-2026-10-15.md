# User-owned AI providers — Phase F: regression sweep and the twelve deliverables (2026-10-15)

Phases A–E built and surfaced the feature. Phase F re-examined everything for gaps, closed the ones found, and wrote the deliverables. No engine rule changed.

## Sweep: found and fixed

1. Story design assistant offered only when the platform had a model → now follows the acting person's AI (own or platform) through the metering door; background narration stays platform-only.
2. No product control to turn user-managed AI off per workspace → `GET/PATCH /api/admin/ai-policy`, an Administration → AI panel, audit event `workspace.ai_byok_policy_changed`.
3. Operator environment undocumented → `.env.example` block.
4. No master-key rotation → `scripts/byok-rotate-keys.mjs` (+ `lib/byok/rotate.ts`, `AiStore.listCredentialsPage`), never decrypts a secret.
5. A containment test caught the rotation tool naming the master-key variable (the vault is meant to be its only reader) → reworded.
Verified clean: operator fallback unreachable inside a user scope; no key-bearing logging; no client file knows the vault/tables; only three files open a stored key.

## The twelve deliverables (`docs/byok/`)

1. `01-architecture.md` 2. `02-provider-catalog.md` 3. `03-security-and-vault.md` 4. `04-api-reference.md` 5. `05-settings-guide.md` 6. `06-billing-and-usage.md` 7. `07-project-level-selection.md` 8. `08-fallbacks-and-failure-behavior.md` 9. `09-operator-setup.md` 10. `10-migration-and-rollout-runbook.md` 11. `11-test-report.md` 12. `12-known-limits-and-live-checklist.md`

**The list is my proposal** (the original wording did not survive a session break; you chose "use my proposed 12"). Tell me the real list and I will rename/reshape — content moves, the engine does not.

## Verification

`pnpm typecheck` clean · `auth-guard-audit` 188 handlers/pages, 0 problems · unit suites all green (studio 513: +3 rotation, +7 sweep) · browser: byok-settings, dashboard ×2, menubar, speech-input, localization, provider-resilience, copilot group, story-report, analytics-ask, intelligent-runtime, history pass; ai-conversation and intelligent-mode each failed once inside the long batch and passed alone; `billing-test.mjs` red on the repository's known-red list (not re-run on the pre-BYOK commit).

## Honest limits

Nothing has run against a live provider account; the browser suite stubs only sign-in; the admin policy panel has no browser test. See `docs/byok/12-known-limits-and-live-checklist.md`.
