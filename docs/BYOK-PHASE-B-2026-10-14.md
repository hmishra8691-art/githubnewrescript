# User-owned AI providers — Phase B: Intelligent Mode and every chat feature (2026-10-14)

Phase A built the foundation; nothing used it. Phase B connects it: **a person's chosen provider now serves their requests**, billing follows who actually served them, and the project can choose whose AI it uses. STT and translation are still platform-managed (Phases C and D); the API refuses to save them as user-managed until then.

## How a model call is decided now

One door — `meteredCore` (`lib/meterRun.ts`), used by `meteredAi` and the new `meteredTts`, which replaced the two sites that used to reserve a wallet by hand (story narration, speech preview):

1. **Project switch** (Internal / feature off) — asked first, unchanged.
2. **Whose AI** — `resolveConnection`: project choice → the acting user's choice → platform. A user-managed choice that cannot be honoured (no key, key cannot be opened, workspace policy, provider lacks speech) is a **refusal in words**, never the platform. `copilot_*` operations follow the *Intelligent Mode* setting; every other model operation follows *Additional AI features*.
3. **Platform AI** → reserve a hold, run, settle (unchanged).
4. **User's own AI** → **no wallet**. The call runs inside the user's connection scope (their key and model, none of the platform's headers, no operator fallback) and is recorded as `AI_REQUEST_BYOK`: customer charge 0, platform cost 0, tokens and provider kept for attribution. No reservation, no balance test, no read-only/suspended gate — no platform money is at stake. Platform fees and platform AI stay refused on an empty wallet.
5. **Hybrid** (user ticked "allow the platform as a backstop"): a hold is reserved first; if the wallet cannot fund it, the backstop is simply not offered for that call. Only usage the platform actually served is settled against the hold (billed as platform, `source: platform_fallback`); otherwise the hold is returned. A capability the user's provider lacks (speech synthesis on Anthropic, say) is done by the platform only in this mode.

Usage on the user's primary and on each of their own fallbacks is recorded as separate rows, each under the provider that served it.

## No cross-contamination

- The copilot's reply cache and single-flight keys now carry the connection (`source:identity`, a hash — no secret); the platform's keys are unchanged. Stored AI replies (narrative, interpretation) are keyed the same way, so an answer is only reused under the connection that wrote it.
- 40 interleaved calls by two users never see each other's key or model (`meterRun.test.ts`).
- The user's TTS model never falls back to the platform's `AI_TTS_MODEL`.

## Project-level choice

Stored in the existing `surveys.settings.ai.source` ("platform" | "user" | absent) — no new column. Set at creation (`POST /api/surveys` accepts `aiSource`) and changed by the owner at `PUT /api/surveys/{id}/ai-source` (capability `billing.set_budget`, the owner's decision about what the project's money is for; audited as `project.ai_source_changed`). `GET` tells any member what the project chose and what it means for *them* right now (provider and model, or the reason it cannot be used) — no key, no header.
- `platform`: everyone uses the platform's AI whatever they set up.
- `user`: everyone uses **their own** provider (the acting user's key — never the owner's, never another member's); a member with none is told so and no call is made.
- absent: each person's own setting decides; with none, the platform.

## What a person sees

- A failure on their own provider is theirs to fix in Settings — "Your AI provider rejected your key", "usage limit reached", "model not found" — never "ask your administrator" or the platform's environment variables.
- A refused connection is its own card ("Your AI provider is not ready") with the reason and where to fix it.
- Cost previews show 0 for own-provider calls (the provider bills them directly).
- Routes that asked "is a model configured?" now ask "is there an AI for this person?", so a user with their own key works on an installation with no platform model.

## Verification

`pnpm typecheck` clean · all unit suites green (studio 435, ai 86, billing 38+, access 99, engine 1788, interviews 177, analytics 465 …) · `auth-guard-audit` 185 handlers, 0 problems · browser regression (fake provider, dev servers): copilot, findings-copilot, quota-copilot, translation-copilot, ux-copilot, provider-resilience, intelligent-mode, intelligent-runtime, history, analytics-ask, story-report, ai-conversation — 12 of 12 pass (story-report and ai-conversation timed out once on a cold dev-server compile and passed on rerun with fresh servers). Postgres-only suites are not run, by declaration.
New tests: `meterRun.test.ts` (13: platform path unchanged; own provider records at zero charge and never touches the wallet; empty/read-only wallet; refusal runs nothing; switch before resolver; hybrid hold/settle/release; unfunded backstop dropped; fallback usage grouped; throw releases; 40-call isolation; TTS; no report no record), `byok/wiring.test.ts` (8), billing (2), plus the existing structural tests updated to follow the logic into the core.

## Not in this phase (and why)

- **Respondent/interview AI** stays platform-managed (decision from the plan): there is no acting user.
- **STT / translation** — Phases C and D.
- **Story-service design assistant** is still offered only when the platform has a model (`storyService.ts` gates on `aiConfigured()` at construction); nothing spends wrongly, the feature is just not offered to a BYOK-only user on a platform with no model. Noted for the sweep.
- **Settings UI and usage/cost view** — Phase E. Until then the settings are reachable by API only.
