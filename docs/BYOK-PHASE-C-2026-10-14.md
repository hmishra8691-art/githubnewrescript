# User-owned AI providers — Phase C: speech-to-text (2026-10-14)

Phase B made a person's own provider serve their chat requests. Phase C does the same for **transcription the Studio runs on a researcher's behalf**: spoken instructions to Intelligent Mode (voice input) and recordings in the media pipeline (a question's video/audio take). Respondent and interview audio is **not** in scope and stays platform-managed (below). Translation is Phase D; the API still refuses to save it as user-managed.

## What a researcher can now choose

Three speech providers, and any compatible gateway (registry entries of kind `stt`, each with an adapter and tests):

| Provider | Protocol | Notes |
|---|---|---|
| OpenAI (`openai-stt`) | OpenAI `/audio/transcriptions` | `whisper-1` (segment timings), `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` (text only). Recordings up to 25 MB. Organization / project ids supported. |
| Groq (`groq-stt`) | same | `whisper-large-v3`, `whisper-large-v3-turbo`. Up to 25 MB. |
| Other OpenAI-compatible (`openai-compatible-stt`) | same | Any public https endpoint (hosted gateway, own Whisper server); passes the same endpoint guard as chat (no private addresses, https only, no redirects). |
| Google Cloud Speech-to-Text (`google-stt`) | Google `speech:recognize` | Own adapter: key in `x-goog-api-key`, model `latest_long`/`latest_short`/`default`. Takes **WebM/Opus, WAV, FLAC up to 60 seconds / 10 MB** — enough for voice instructions, not for long interviews. |

An optional saved **language** (BCP-47) is the default hint; a per-call hint wins. Google needs a region, so a bare language is mapped (`pt` → `pt-BR`, default `en-US`).

**One key, one vendor family.** The OpenAI key saved for chat can be chosen for OpenAI speech (and Groq's for Groq, a custom gateway's for a custom gateway) — but a key is only ever used with a provider of its own family: an Anthropic key is never sent to OpenAI, an OpenAI key never to Groq, a Gemini key is not a Cloud Speech key. The choice of a saved key is **explicit** (`credentialId`); nothing is picked up silently.

## How a transcription is decided now

Same door as every model call (`meteredCore`, `kind: "stt"`); `meteredStt` no longer reserves by hand.

1. **Project switch.** Speech is not a language model, so a project that runs **Internal** ("nothing is sent to a language model") still transcribes, as it always did. What a project can really turn off — the feature list (`settings.ai.disabled`) — still stops it, and a project setting that cannot be read fails closed (retryable; the recording stays stored).
2. **Whose provider.** Project choice → the acting user's *Speech-to-text* setting → platform. A user-managed choice that cannot be honoured is a refusal in words (no key, key cannot be opened, workspace policy, address no longer valid), **never** the platform's provider. A *chat* setting does not make transcription user-managed: the two are separate settings.
3. **Platform provider** → reserve minutes, run, settle (unchanged); a meter outage still runs the call unmetered rather than lose a recording.
4. **User's own provider** → **no wallet**. Runs inside the user's STT scope (their address, key, model, headers, language — no platform headers, no operator fallback) and is recorded as `AI_REQUEST_BYOK` in **minutes**, customer charge 0, provider and seconds kept for attribution.
5. **Fallbacks.** Only a failure another provider can cure (rate limit/credit/auth/outage/network) moves on — and only to the fallbacks the user listed, in order, then to the platform **only if they allowed it** (that hop is billed as the platform's through a hold reserved up front; unfunded, it is dropped for that call). A request the provider found malformed, or silence, is not forwarded. A recording the provider cannot take (Google: too long / not WebM-WAV-FLAC) is refused **before** any request, and a listed fallback may take it.

Failures are told as the user's own: "Your speech-to-text provider rejected the API key (401) — check it in Settings → AI & Integrations → AI Provider Configuration"; Google's 400-for-a-bad-key is understood as auth; a disabled API says to enable Cloud Speech-to-Text. The platform's own failures keep their operator wording.

## Routes

- `POST /api/ai/transcribe` (voice input), `POST /api/surveys/{id}/media/transcript` (media pipeline) and `…/media/confirm` (queues a job only if *this researcher* could run it) all ask one function, `sttPrecheck` (`lib/byok/connect.ts`): the user's own provider when resolved, a refusal with the reason (`ai_connection`, 403/409/503) when it is not, else the platform's (`stt_unconfigured` / `stt_unavailable` 501, unchanged). No route asks the platform directly any more (a structural test fails if one does).
- The voice route's **fake-provider test seam** (`hint` field) applies to the platform's fake provider only, never to a user's own.
- The transcript row records which provider answered (registry id, never a key) when it was the researcher's own.
- The English reading of a spoken instruction (`intelligent_voice_normalise`) now follows the *Intelligent Mode* setting (it is a chat call that was filed under Additional AI).

## Settings API additions (UI is Phase E)

`GET /api/account/ai` lists `sttCatalog` and `platformSttFallbackAvailable` and gives each feature its `kind`; `PUT` saves the `stt` feature; **Test Connection** for speech sends one second of silence the way the Studio sends a recording (OpenAI-compatible multipart, or Google JSON) and says in words whether it works — the provider's own text and the key never come back; model discovery lists only transcription models (Google has no list: suggestions are shown).

## Respondent and interview audio stays platform-managed

`apps/runtime` and `apps/interviews` have no acting researcher; decrypting a researcher's key inside the public respondent app would widen the blast radius (risk 3 in the plan). A static containment test now fails if either app, `packages/interviews` or `packages/media` ever imports the vault, enters a user's connection scope, reads the master key or touches the credential tables. The shared media runner only learned to record `result.provider`.

## Verification

- `pnpm typecheck` clean; unit suites all green: studio 459 (+24), `@rescript/ai` 97 (+11), media 162, billing 44, engine 1788, analytics 465, interviews 177 …; `auth-guard-audit`: 185 handlers, 0 problems.
- New tests — `packages/ai/stt.providers.test.ts` (11, real local HTTP providers): speech catalog and key families; kind enforcement; discovery filter; a user's call goes to their address with their key/model/language/headers and none of the platform's; GPT-4o transcribe asks for json only; fallback ladder (only curable failures, only listed fallbacks, platform only when listed, usage marked platform/fallback, all-failed message); user-worded failures; vendor with no speech endpoint refused before the call; Google request/response/limits/format checks/bad-key/disabled-API/silence; endpoint guard; per-connection identity. `meterRun.test.ts` (+7), `resolve.test.ts` (+4), `service.test.ts` (+6: family-shared key, kind enforcement, both test probes, discovery, WAV), `wiring.test.ts` (+3), `containment.test.ts` (+1), and `stt.flow.test.ts` (3, saved setting → resolver → metering door → real `transcribe` → HTTP provider → ledger: Alice on her key at zero charge and Bob on the platform at the same moment; provider down with and without backstop; project chose user-managed for a user with none).
- Browser regression (fake provider, dev servers): 19 suites pass — the speech ones (speech-input, video-interview, intelligent-mode, intelligent-runtime, ai-conversation, chain, presentation) and the surrounding corpus (copilot ×5, provider-resilience, variants-g5, variants-g6, acbc, history, analytics-ask, story-report). Four copilot-group suites (quota, translation, ux, provider-resilience) failed once when the kernel killed the dev server for memory while two browser runs overlapped, and passed on a rerun on their own. Postgres-only suites are not run, by declaration.

## Honest limits

- **Nothing was run against a live OpenAI, Groq or Google account** — there are no keys in this environment, by design. The OpenAI-compatible and Google adapters follow those services' documented request/response shapes and are exercised end to end against local HTTP servers that speak them. Google's recognize endpoint, in particular, should be tried once with a real key (Phase E's Test Connection button does exactly that).
- Google: one-minute / 10 MB / WebM-Opus-WAV-FLAC only (Ogg-Opus needs a sample rate this adapter cannot read from the file; MP3/MP4 are refused with a reason). No speaker separation (said truthfully on the transcript).
- The GPT-4o transcribe models return text only: no segment timings, no diarization.
- Behaviour changes to be aware of: transcription now reads the project's AI settings (fail-closed when unreadable); the voice route's wallet refusal now uses the standard refusal codes (`wallet_*`, 402/423/503) instead of the old generic `wallet_refused`; `intelligent_voice_normalise` moved to the Intelligent Mode setting.

## Not in this phase

- Translation (Phase D), Settings UI + usage/cost view (Phase E), sweep + deliverables (Phase F).
- The story-service design assistant gating noted in Phase B.
