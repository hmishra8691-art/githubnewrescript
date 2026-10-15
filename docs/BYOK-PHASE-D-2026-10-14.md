# User-owned AI providers — Phase D: translation (2026-10-14)

Phase B made a person's own provider serve their chat requests, Phase C their speech-to-text. Phase D does the same for **translation**: the Translation Manager's strings (`/api/ai/translate`) are now translated by the provider the acting person chose — a translation service on their own key, or their own AI model — with the same guarantees as the platform's provider, the same single billing door, and no silent platform spend. The Settings UI is Phase E (the API accepts and tests all of it now); the sweep and the twelve deliverables are Phase F.

## What a researcher can now choose

Registry entries of kind `translate`, each with a wire protocol, an adapter and tests:

| Provider | Protocol | Notes |
|---|---|---|
| Google Cloud Translation (`google-translate`) | Basic v2 (`POST …/language/translate/v2`) | Own API key in the `x-goog-api-key` header — **never in a URL** (the platform's own key keeps its documented query position). The same Google Cloud key can also serve Cloud Speech-to-Text (one `google-cloud` family); an AI Studio (Gemini) key cannot. |
| DeepL (`deepl`, `deepl-free`) | `POST /v2/translate`, `Authorization: DeepL-Auth-Key` | Pro and Free are two entries (Free keys end in `:fx`; picking the wrong one is the classic 403 and the message says so). Regional variants (`EN-GB`/`EN-US`, `PT-BR`/`PT-PT`, `ZH`/`ZH-HANT`) follow the survey's locale. 50 strings per request. |
| Microsoft Azure Translator (`azure-translator`) | v3 `POST /translate?api-version=3.0` | `Ocp-Apim-Subscription-Key` plus the resource **region** header (field in the registry; empty for a global resource). Script variants (`zh-Hans`/`zh-Hant`, `pt-pt`) from the locale. |
| My AI model (`llm`) | the chat connection | No key of its own: it is the connection saved under **Other AI features** (key, model, fallbacks), asked to translate. If that setting is not the person's own provider, saving is refused (`chat_required`) and using is refused (`no_connection`) — never the platform's model. |

A translation service has **no model to choose and no address to aim**: both are the registry's, whatever a form sends (the API ignores a typed model/base for these). Model discovery for translation answers "no model to choose".

**One key, one vendor family.** DeepL Pro/Free share a key family; Google Translate and Google Speech share `google-cloud`; nothing crosses vendors (an OpenAI key is never sent to DeepL, a DeepL key never to Azure). A saved key is chosen explicitly by `credentialId`.

## How a translation is decided now

`/api/ai/translate` authenticates first (`requireTranslationSession`, the guard), then reads the body, then resolves whose provider runs it (`session.resolve(surveyId)` → `connectionFor`, operation `translate:src->tgt` → feature **translation**): project choice → the acting user's *Translation* setting → platform. Then it walks the same door as every model call, `meteredCore`, with `kind: "translate"`; `meteredTranslation` no longer reserves by hand.

1. **Project switch.** A translation **service** is not a language model, so a project that runs **Internal** still translates with one, exactly as before. When a **language model** is what will translate — the platform's model (when it is the platform's provider) or the person's *My AI model* — the project's full AI switch applies before anything is reserved. The feature list and an unreadable project setting still stop everything (fail closed).
2. **Whose provider.** A user-managed choice that cannot be honoured is a refusal in words (`ai_connection`, 403/409/503) — **never** the platform's provider. A *chat* or *speech* setting does not make translation user-managed: three separate settings.
3. **Platform provider** → reserve characters (a language model is reserved as a chat call), run, settle (unchanged).
4. **User's own service** → **no wallet**. Runs inside the user's `translate` connection scope (their key, their registry address, region header; no platform key, no operator fallback) and is recorded as `AI_REQUEST_BYOK` in **characters**, customer charge 0, provider id kept for attribution. **My AI model** records the chat tokens the same way as any own-provider chat call.
5. **Fallbacks.** Only a failure another provider can cure (auth, quota/credit, rate limit, outage, network, timeout, **a language this provider lacks**) moves on — and only to the fallbacks the user **listed**, in order, then to the platform's translation provider **only if they allowed it** (that hop is billed as the platform's through a hold reserved up front; unfunded, it is dropped for that call; its usage is re-marked `source: platform` so only that is settled against the hold). A request the provider found malformed is not forwarded. Fallbacks are services with their own keys; *My AI model* cannot be a fallback and carries its own fallbacks from *Other AI features*.

Failures are told as the user's own: "Your translation provider (DeepL API Pro) rejected the API key (403) — check it in Settings → AI & Integrations → AI Provider Configuration." Each protocol classifies its own statuses (DeepL 456 = quota; Azure 403001 = free quota; Google's 400-for-a-bad-key = auth; "target language not supported" = unsupported language), never exposing provider text or the key.

## One driver, every provider held to the same line

The platform's Google adapter was refactored onto the same driver the user's services use (`packages/ai/src/translateServices.ts`), so there is no second implementation of the guarantees:

- placeholders (`{{pipes}}`, `${variables}`, `{params}`, `[[loop]]`, question codes — the engine's one grammar) are lifted out before the call behind a `translate="no"` span (DeepL: an ignored `<x>` tag) and verified after; a string that lost one is **dropped, never stored broken**; HTML must stay balanced; glossary do-not-translate terms are wrapped, preferred wordings applied afterwards — proved for each of the three protocols (`translate.providers.test.ts`);
- batches respect each service's limits by count and characters; what was translated **before** a failure (and billed) is no longer thrown away — it comes back beside the error (`TranslationProviderError.partial`), is cached, and only the rest is offered to a fallback;
- a user's request only ever leaves through the endpoint guard (pinned address, https, no redirects, no private ranges unless the operator opted in); the platform's own provider keeps the platform `fetch`;
- `llmTranslationAdapter` now batches by 80 (the chat helper silently ignored strings beyond 80 of the route's 100).

## Cache and memory

Cache keys carry the provider that wrote the translation: `google` (platform's Google *and* a user's Google key — same provider, same output), `deepl`, `azure`, `llm` (platform model), `llm-own` (a user's model). A DeepL translation is never served as Google's; no key or user id is in any key. Approved human wordings are remembered for every provider id, so they still win. The memory route needs a person, not a provider: it no longer 501s on an installation with no platform provider.

## Routes and screens

- `POST /api/ai/translate`: authenticate → body → resolve → meter → manager. Refusals use the standard codes.
- `GET /api/translation/languages?surveyId=`: the **resolved** provider's own language list (free to ask; with the user's key when it is theirs), spelled the way that provider spells it (DeepL folds `EN-GB`/`EN-US` into `en`, Azure folds `zh-Hans`/`zh-Hant` into `zh`, Google unchanged).
- `GET /api/translation/status?surveyId=`: reports *this person's* provider (`via: user|platform`), or why their own cannot be used. The Translation tab sends the survey id and says "Provider: DeepL (your own key) · yours", or the refusal sentence. (Settings UI itself is Phase E.)
- `GET /api/account/ai` adds `translateCatalog` and `platformTranslateFallbackAvailable`; `PUT` saves the `translation` feature; **Test Connection** for translation translates the two characters "OK" the way the Studio does and says in words whether it works (the provider's own text and the key never come back); *My AI model* tests the chat connection it uses.

## Respondent and interview paths are untouched

Nothing in `apps/runtime`, `apps/interviews` or the shared packages calls the translation adapters; the containment test now also fails if any of them reference `scopedTranslationAdapter`.

## Verification

- **Unit tests:** studio 478 (+19), `@rescript/ai` 111 (+14, real local HTTP servers speaking the Google v2 / DeepL / Azure v3 contracts); every other package unchanged and green. New end-to-end flow tests (`translation.flow.test.ts`) cover own DeepL key → characters recorded as `AI_REQUEST_BYOK` at zero charge, no wallet, refusal never reaching the platform, fallback only when listed.
- **`pnpm typecheck`:** clean.
- **Auth-guard audit:** 185 handlers, 0 problems (the translate route now authenticates before parsing its body; `requireTranslationSession` / `requireTranslationUser` are registered gates).
- **Browser regression (real Studio + runtime):** localization, translation-copilot, copilot group (copilot, findings, quota, translation, ux), provider-resilience, speech-input, ai-conversation, intelligent-runtime, analytics-ask, history, story-report, acbc, variants-g5 — all pass. `ux-copilot` failed once when run on its own and passed on an immediate re-run and in the group run (flaky timing; the failing line was not captured).
- **`billing-test.mjs` fails** at "insufficient balance → 402" (the fake provider answers 200). This is on the repository's known-red list (`docs/BROWSER-CORPUS.md`, "Known red on 2026-09-25 … `billing-test.mjs` (the fake provider answers 200 where a 402 is expected)"), recorded before this work; its other four checks (wallet card, AI + translation deduction, top-up approval, READ_ONLY transition) pass. I did not re-run it on the previous commit, so "pre-existing" rests on that record plus a direct check that `meter.reserve` for ~17.7k characters at the Google rate returns `insufficient_balance`.

## Honest limits

- **Nothing was run against a live Google, DeepL or Azure account** — there are no keys in this environment, by design, and web search is not enabled for this organisation, so the request/response shapes were written from the services' documented contracts and are exercised end to end against local HTTP servers that speak them. In particular DeepL's `ignore_tags` with HTML tag handling and Azure's `notranslate` class are best-effort: **whatever a provider does with the markers, the Studio verifies the result and drops a damaged string**, so the worst case is a missing translation, not a broken one. Phase E's Test Connection button is the first real-account check; try each provider once with a real key.
- DeepL **formality**, **glossaries on the provider side** and Azure **custom categories** are not exposed; the Studio's own glossary and notes apply (the notes reach only *My AI model*).
- DeepL Pro/Free and Google/Azure's regional endpoints are fixed by the registry; a custom/regional endpoint would be a new registry entry.
- Platform DeepL and Microsoft rate rows stay `active: false`: the platform's own provider is still Google (or its model). Own-provider use never needs a rate row.
- The cache identifies a result by its provider, not its fallback: if a fallback served a string it is cached under the primary's provider id.
- Behaviour changes to be aware of: unauthenticated callers are refused before the request body is parsed; the memory route no longer requires a platform provider; the status/languages routes answer for the signed-in person, not the installation; the DB cache stores new provider ids (`deepl`, `azure`, `llm-own`) in its free-text `provider` column (no migration).

## Not in this phase

- Settings UI (masked keys, test buttons, unsaved indicators, usage/cost view) — Phase E.
- Regression sweep and the twelve deliverables — Phase F. Noted for the sweep: the story-service design assistant is still gated on `aiConfigured()`.
