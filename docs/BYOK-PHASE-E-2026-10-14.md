# User-owned AI providers — Phase E: the settings screen (2026-10-14)

Phases A–D built the engine: a vault, a resolver, one billing door, and provider adapters for chat, speech-to-text and translation, all reachable only through `/api/account/ai…`. Phase E gives a person the screen for it: **Account → AI & Integrations** (`/settings/ai`, titled *AI Provider Configuration*). No engine rule changed; the screen reads and writes through the same account API and shows the server's rules instead of restating them.

## Where it is

- Account navigation: a new **AI & Integrations** tab beside Profile, Security and My usage; and an *AI & Integrations* item in the account menu.
- Page: `app/settings/ai/page.tsx` → `components/settings/AiProviderConfig.tsx`.

## The seven sections

The plan said "all seven sections" without listing them; the original list was not in the notes that survived the session, so these are the seven chosen. **If your list differs, tell me and I will reshape it — only the headings and grouping move, not the engine.**

1. **Overview** — one row per feature: who provides it (*Platform AI* / *Your own provider*), the configuration in words, the last test (passed / failed / not tested), a *Configure* link. States, without being asked, that respondent-facing and interview AI always runs on the platform's AI and never uses these keys; that nothing switches silently; that a project can also choose how its AI is provided. Shows why own-provider is unavailable (workspace administrator turned it off; the installation has no vault key).
2. **Intelligent Mode** · 3. **Other AI features** · 4. **Speech-to-text** · 5. **Translation** — one connection editor each (below).
6. **Saved API keys** — every key as a mask, the provider, which features use it (fallbacks included), its last test, when it was added/replaced; **Add**, **Replace**, **Remove**.
7. **Usage & cost** — two tables, never added together (below).

A sticky section strip links to each; a dot on a section's link marks unsaved work.

## One connection editor, four times

- **Who provides the AI**: *Platform AI* or *My own provider*. Own-provider is disabled with the reason when the workspace forbids it, the vault is not configured, or the feature does not support it.
- **Provider** from the registry's catalog for that kind of feature (chat / speech / translation). Choosing one **resets** what belonged to the previous one — address, model, identifiers, key — so nothing crosses vendors. A fixed provider's address is shown as fixed; only custom providers have an address field.
- **Identifiers** the registry asks for (organization, project, workspace, Azure region) with their help text and format check.
- **API key**: a password field (`autocomplete="new-password"`, no spell-check), **never prefilled**. A saved key is chosen from a list as its **mask** (`sk-proj-••••••••0001`); *Use a different key…* types a new one. Only keys of the same vendor family are offered (a Google Cloud key serves speech and translation; an OpenAI key is never offered to DeepL).
- **Model** (chat/speech): a field with **Find models** (the provider's own list for *this* key) or **Suggestions** (for providers that list none), clickable chips, ★ for models suited to Intelligent Mode. Optional small / embeddings / vision models for chat; usual language for speech. A translation **service has no model field** at all.
- **Fallbacks** (up to three): provider, model, and a key — chosen from saved keys or typed (saved through the credentials route *first*, then named by id; the secret is never inside the setting). *My AI model* translation has none (it uses the fallbacks of Other AI features) and says so.
- **Platform last resort** checkbox: off by default, and it says in the same sentence that the call is **billed to your wallet as platform usage**; disabled with the reason when the platform has no such provider.
- **Test connection**: sends the *draft* (typed key or saved one) and reports in words — "Connection works (84 ms)" or the specific reason (key rejected, no credit, model not found, rate limit, unreachable, …) — never the provider's own text, never the key. For a chat model it also reports whether JSON mode is accepted (Intelligent Mode needs it). The result is stored and shown as *Last test* later.
- **Save** / **Discard changes**. Returning a feature to the platform asks twice (*Confirm: use platform AI*) and says what is cleared and that keys are kept.

### Unsaved changes — three places
Each editor marks every changed field with an amber rule, shows an **Unsaved changes** chip (hover lists what changed), and sets `data-dirty`; the page shows a banner naming the sections with unsaved work, puts a dot on their navigation links, and asks before leaving (`beforeunload`). A refresh of the overview (for example after replacing a key elsewhere) never overwrites a draft that has unsaved work. Save is offered only when the draft differs *and* is locally complete (the server still validates everything).

## Saved API keys
Replace swaps the secret behind the same row (same id, so features keep working) and clears its test; Remove asks, names the features that will return to the platform's AI (and fallbacks that will be dropped), then does exactly that. After Remove the screen shows the features on the platform — the server is the one that reverts them, the screen only reflects it.

## Usage & cost
`GET /api/account/ai/usage?days=7|30|90` (new; the signed-in person only; reads the usage events the metering door already writes — no second ledger):

- **On my own provider · not billed here** — per feature, provider and model: calls, volume sent (tokens in/out, characters, minutes), calls served by a fallback. **No money**: the Studio neither charged for this work nor knows what the person's provider charges, and the screen says so in a sentence rather than invent a number.
- **On the platform's AI · charged to my wallet** — per kind (AI model, translation, speech): calls and the **customer charge** (the same amounts My usage shows, shown to the precision they are recorded in), with a total. Provider cost, fees and margin are never read.
- The two are never summed. Reversals and rows outside the window are excluded; own-provider rows are grouped by the provider id on the row.

## Tests

| Where | What |
|---|---|
| `lib/byok/settingsModel.test.ts` (11) | catalog per kind; no secret in the overview; draft ⇄ saved; every kind of change is named, whitespace is not a change; provider switch resets key/address/identifiers and offers the lone same-vendor key; key families (Google speech⇄translate yes, DeepL/OpenAI no); local problems (key, model, address, Azure region, fallback key/model, no key for My AI model, no model for a service); save bodies (typed key once, saved key by id, fixed address and service model not sent, fallback keys saved first and absent from the setting); test bodies; the words each feature says; why a feature is blocked, in order |
| `lib/byok/usage.test.ts` (4) | grouping, volumes, fallbacks counted, no money on own rows; platform rows carry the charge only and never include own-provider work; reversals and window; provider id fallback |
| `lib/byok/settingsUi.test.ts` (10) | **structural, from source**: seven sections in order; no storage/console/URL for values; every key input is `type="password"` + `autoComplete="new-password"` + no spell-check; no `defaultValue`, drafts built with empty key; the screen calls only `/api/account/ai…`; imports nothing server-side (the model has no imports at all); double confirmation for platform/removal; unsaved chip, banner, dot and leave-guard exist; the usage route and model read no cost field; reachable from the navigation and menu |
| `scripts/byok-settings-test.mjs` (browser, 24 checks) | the real page in Chromium against the **real service code** with local mock providers (wrong key → rejection in our words, provider text not echoed; right key; model discovery; unsaved/discard; save → mask only; DeepL with a fallback saved with its own key; "My AI model" refused in words when chat is on the platform; replace/remove keys with confirmation and the feature returning to the platform; usage tables with no `$` on own rows and no provider cost on platform rows; going back to the platform; a workspace that forbids it; 390 px wide without sideways scroll; **across every response of the run, no key and no ciphertext**; no page errors) |

Mutation checks (each reverted): a key input changed to `type="text"`; own-provider rows leaking into platform rows; a typed key no longer counted as a change; a fixed provider's address sent; reversals counted — each makes a named test fail.

## Verification

- **`pnpm typecheck`:** clean across the workspace. **`auth-guard-audit`:** 186 handlers and pages, 0 problems (the usage route is guarded by `requireUser`).
- **Unit tests (`pnpm -r test`):** studio **503** (+25: 11 + 4 + 10), `@rescript/ai` 111, engine 1788, analytics 465, interviews 177, media 162, storage 104, exporters 102, access 99, templates 98, quality 51, import 49, designs 45, billing 44, mail 33, schema 11, reportvideo 6 — all green.
- **Browser (real Studio + runtime):** `byok-settings` (24 checks, passes directly and through the runner), dashboard + quota-dashboard, dashboard-overview, menubar (the account menu gained an item), the copilot group (copilot, findings, quota, translation, ux), intelligent-mode (8.9 min), speech-input, localization, provider-resilience, ai-conversation — all pass.
- **`billing-test.mjs` fails** at "insufficient balance → 402" (the fake provider answers 200) — the same failure as in Phase D and on the repository's known-red list (`docs/BROWSER-CORPUS.md`); its other four checks pass, including the My usage page that now carries the new navigation tab.
- One process note: the first invocation of the new suite in one batch printed nothing (a cold server start) and a run against a hand-started dev server without the runner's fake-provider settings failed other suites; both were my setup, not the code — every run through the runner's own servers passed.

## Honest limits

- **The browser suite stands in for the sign-in only.** The Studio in this environment has no database, so `/api/auth/me` and the thin route wrappers are stubbed in the test and the real `service.ts` runs in the test process. The routes themselves (`requireUser` → service → audit) are covered by the auth-guard audit (186 handlers, 0 problems) and by Phases A–D's service tests; a signed-in click-through on a real installation has not been done here.
- **Nothing has run against a live OpenAI, Google, DeepL or Azure account** (no keys in this environment). The screen's **Test connection** is the first real check — try each provider once with a real key.
- **The seven-section list is my reading** (see above).
- Usage for a person is read from the meter's events for their user id; on an installation without metering (migration 0023) the section says usage is not enabled and the rest of the page works.
- Not on this screen: per-project provider choice (it is set at project creation, Phase B), workspace administrator controls for allowing user-managed AI, and provider-side DeepL glossaries/formality (see Phase D limits).

## Not in this phase
Regression sweep and the twelve deliverables — Phase F. Noted for the sweep: the story-service design assistant is still gated on `aiConfigured()`; `billing-test.mjs` is red on the repository's known-red list for a reason unrelated to this work.
