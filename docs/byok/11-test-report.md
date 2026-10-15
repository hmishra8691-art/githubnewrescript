# BYOK 11 — Test report (Phase F, 2026-10-15)

## Method

One regression sweep over the whole repository after Phases A–F: type check, every package's unit suite, the auth-guard audit, and the real browser corpus (real Studio + runtime dev servers started by `scripts/verify-browser.mjs` with a fake AI provider, `AI_API_URL=fake:`). Provider adapters are tested against **local HTTP servers that speak each service's contract**, not live accounts (see 12).

## Results

| Check | Result |
|---|---|
| `pnpm typecheck` (workspace) | clean |
| `node scripts/auth-guard-audit.mjs` | 188 handlers and pages, 0 problems (the admin policy route is guarded by `requireAdmin`) |
| Unit suites (`pnpm -r test`) | studio **513**, 0 failing (503 after Phase E + 3 rotation + 7 sweep; one containment test failed mid-phase and was fixed, see below), `@rescript/ai` 111, engine 1788, analytics 465, interviews 177, media 162, storage 104, exporters 102, access 99, templates 98, quality 51, import 49, designs 45, billing 44, mail 33, schema 11, reportvideo 6 — all green |
| Browser: new `byok-settings` (24 checks) | pass |
| Browser: dashboard, dashboard-overview, menubar, speech-input, localization, provider-resilience | pass |
| Browser: copilot, findings-copilot, quota, translation-copilot, ux (group of 5), story-report, analytics-ask, intelligent-runtime, history | pass |
| Browser: ai-conversation | failed once inside the long batch (55 s), **passed on its own rerun** (35 s) — a load/timing flake, as in earlier phases |
| Browser: intelligent-mode | failed once inside the long batch (197 s), **passed on its own rerun** (7.3 min) — same load/timing pattern |
| Browser: `billing-test.mjs` | **red** at "insufficient balance → 402" (fake provider answers 200) — on the repository's known-red list since before this work; its other four checks pass |

## What each area is held by

| Property | Held by |
|---|---|
| No key/fragment in a stored blob; copied/tampered blob does not open; no master key ⇒ nothing stored | `vault.test.ts` |
| Rotation re-wraps without decrypting; unreadable rows counted and untouched; dry-run writes nothing; pagination | `rotate.test.ts` |
| Other users can never use/list/delete/test/name Alice's key; key families; fixed address not redirectable; private endpoint refused on save/test/use | `service.test.ts`, `resolve.test.ts`, `netguard.test.ts` |
| Own scope never sees platform headers/key; no operator fallback; 30 concurrent scopes don't swap keys | `packages/ai` `connection.test.ts` |
| Own-provider calls: zero charge, no wallet, no read-only gate; platform unchanged; hybrid hold/settle/release; 40-call isolation; refusal runs nothing | `meterRun.test.ts` |
| Chat, speech, translation end to end (saved setting → resolver → door → real adapter → HTTP provider → ledger); Alice on her key and Bob on the platform at once | `stt.flow.test.ts`, `translation.flow.test.ts`, `wiring.test.ts` |
| Provider protocols (Google v2, DeepL, Azure v3, Google Speech, OpenAI speech) incl. placeholder protection and failure classification | `packages/ai` `translate.providers.test.ts`, `stt.providers.test.ts` |
| Respondent/interview apps never import the vault, enter a user scope or touch the credential tables | `containment.test.ts` |
| Settings screen: seven sections; password inputs; no storage/console/URL for values; calls only `/api/account/ai…`; double confirmation; unsaved indicators; no cost field read | `settingsUi.test.ts`, `settingsModel.test.ts`, `usage.test.ts`, browser `byok-settings` (incl. "no key or ciphertext in any response of the run", 390 px width) |
| **Sweep (this phase):** story design assistant follows the person's choice and stays inside the metering door; admin policy route admin-only + audited + sentence; operator env documented; credential tables deny-by-default and no client file knows the vault; only three files open a stored key; every account route authenticates before reaching the store; rotation has no HTTP route and never decrypts | `sweep.test.ts` (7) |
| Master key is read in one place only | `containment.test.ts` (caught a regression in this phase: the rotation tool named the variable; reworded and re-run) |

## Findings of the sweep and what was done

1. **Story design assistant** was gated on the platform's model only → now offered when the person has an AI of their own, through the metering door (fixes the gap noted in Phases B–E).
2. **No way to switch user-managed AI off per workspace** from the product (only the column existed) → admin route, panel, audit event.
3. **Operator environment undocumented** → `.env.example` block for `AI_CREDENTIAL_KEY`, `AI_CREDENTIAL_KEY_PREVIOUS`, `AI_BYOK_ALLOW_PRIVATE_ENDPOINTS`.
4. **No master-key rotation tooling** → `scripts/byok-rotate-keys.mjs` + `rotate.ts` + tests.
5. Verified: operator fallback unreachable inside a user scope; no key-bearing logging in byok/account code; no client file references the vault or credential tables.

## Not run, by declaration

Postgres-only suites (4: auth-collaboration, listfill-allocation, lock-concurrency, version-scoped-export) need a database that this environment does not have.
