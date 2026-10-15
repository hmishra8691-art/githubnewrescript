# BYOK 2 — Provider catalog

The catalog lives in `packages/ai/src/registry.ts` and is what the settings screen lists (`GET /api/account/ai` returns `catalog`, `sttCatalog`, `translateCatalog`). A provider is listed only when it has an adapter and tests. Models are **not** hard-coded as promises: they are discovered from the provider with the person's own key, or suggested where the provider lists none, or typed.

## Chat (Intelligent Mode and Other AI features) — protocol `openai-chat`

| Id | Provider | Address | Notes |
|---|---|---|---|
| `openai` | OpenAI | `https://api.openai.com/v1` | Organization and project ids supported. |
| `anthropic` | Anthropic | `https://api.anthropic.com/v1` | Through Anthropic's OpenAI-compatible endpoint. No speech or embeddings. |
| `google-gemini` | Google Gemini (AI Studio key) | `https://generativelanguage.googleapis.com/v1beta/openai` | Through Gemini's OpenAI-compatible endpoint. An AI Studio key is **not** a Cloud Speech or Cloud Translation key. |
| `openai-compatible` | Other (OpenAI-compatible) | custom, public https | Any hosted gateway or self-hosted server. Passes the endpoint guard. Private/loopback addresses only when the operator sets `AI_BYOK_ALLOW_PRIVATE_ENDPOINTS`. |

Optional per feature: a small model, an embeddings model, a vision model. Test Connection reports whether JSON mode is accepted (Intelligent Mode needs it); models suited to Intelligent Mode are starred.

## Speech-to-text — kind `stt`

| Id | Provider | Protocol | Limits |
|---|---|---|---|
| `openai-stt` | OpenAI | `/audio/transcriptions` | up to 25 MB; `whisper-1` (segments), `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` (text only) |
| `groq-stt` | Groq | same | up to 25 MB; `whisper-large-v3`, `whisper-large-v3-turbo` |
| `openai-compatible-stt` | Other (OpenAI-compatible) | same | custom public https endpoint |
| `google-stt` | Google Cloud Speech-to-Text | `speech:recognize` | WebM/Opus, WAV, FLAC only, up to 60 s / 10 MB — voice instructions, not long interviews |

A saved language (BCP-47) is the default hint; a per-call hint wins.

## Translation — kind `translate`

| Id | Provider | Protocol | Notes |
|---|---|---|---|
| `google-translate` | Google Cloud Translation | Basic v2 | Key sent in `x-goog-api-key`, never in a URL. One `google-cloud` key family with Cloud Speech. |
| `deepl` / `deepl-free` | DeepL API Pro / Free | `/v2/translate` | Two entries: Free keys end in `:fx` and use a different host. Regional variants follow the survey's locale. 50 strings per request. |
| `azure-translator` | Microsoft Azure Translator | v3 | Key plus the resource **region** (empty for a global resource). |
| `llm` | My AI model | chat-reuse | No key of its own: it is the connection saved under *Other AI features*. Cannot be a fallback. |

A translation service has **no model to choose and no address to aim**; both are the registry's.

## Key families

A key is used only with a provider of its own vendor family (`sameKeyFamily`): OpenAI (chat + speech), Groq, Google Cloud (speech + translation), DeepL (Pro + Free), Azure, Anthropic, Gemini, and each custom gateway for itself. Choosing a saved key is explicit (`credentialId`); nothing is picked up silently.

## Not in the catalog (and why)

Azure OpenAI deployments (different URL scheme), native non-OpenAI chat protocols, DeepL formality/glossaries and Azure custom categories (the Studio's own glossary applies), Google speech for long audio. Adding a provider means a registry entry, an adapter, and tests; see 12 for the live-account checks still owed.
