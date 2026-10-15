# BYOK 8 — Fallbacks and failure behaviour

## Principles

1. **Never silent platform spend.** A person's own provider failing does not move the call to the platform unless they ticked **Platform last resort**, and then it is billed to their wallet as platform usage.
2. **Never another person's key.** Fallbacks are the person's own list.
3. **Never the operator's fallback.** `AI_FALLBACK_*` is unreachable inside a person's scope (verified in `packages/ai/src/index.ts`; tested).
4. **Say whose problem it is.** Failures on the person's provider are worded as theirs to fix; platform failures keep operator wording.

## The ladder

primary (person's provider) → fallback 1 → fallback 2 → fallback 3 (all the person's, each with its own key, max three) → platform **only if allowed**.

A hop is taken only for a failure another provider can cure: auth/key, quota/credit, rate limit, overload/outage, network, timeout — and for translation, "language not supported". A request the provider found **malformed**, or silence (speech), is **not** forwarded. A recording the provider cannot take (Google: too long / wrong format) is refused before any request and a listed fallback may take it. Quota and auth errors are never retried on the same provider; bounded jittered retries apply to transient errors inside a deadline (request manager).

## What the platform hop costs

Reserved as a hold **before** the call. If the wallet cannot fund it, the backstop is dropped for that call (the person gets their own provider's failure, in words). Only usage the platform served is settled; otherwise the hold is returned. Its usage rows are marked `source: platform`/`platform_fallback`.

## Refusals (no call is made)

`no_connection`, `credential_missing` (key deleted), `credential_unreadable` (cannot be opened: wrong/rotated-away master key or tampering), `invalid_config` (saved address no longer passes validation), `capability_missing` (e.g. speech synthesis on Anthropic — done by the platform only in hybrid mode), `byok_blocked`, `vault_unavailable`, `unsupported_feature`. Each has a sentence and a route to fix it; HTTP via `connectionRefusalStatus` (403/409/503) with code `ai_connection`.

## Partial results

Translation returns what was translated before a failure beside the error (`TranslationProviderError.partial`); it is cached and only the remainder is offered to a fallback. Placeholder/tag damage drops the string rather than storing it broken.

## Failure wording examples

"Your AI provider rejected your key (401) — check it in Settings → AI & Integrations → AI Provider Configuration." · "Your translation provider (DeepL API Pro) rejected the API key (403)." · "Your speech-to-text provider reports a usage limit." Provider text and keys are never included.

## Operator-level behaviour unchanged

With no user configuration, behaviour is exactly what it was before BYOK, including the operator fallback for platform calls.
