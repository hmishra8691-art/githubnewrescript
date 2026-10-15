# BYOK 1 — Architecture

How a person's own AI provider is chosen, kept safe, called and accounted for. Everything here is in the repository; file names are given so each claim can be checked.

## The one-paragraph version

A researcher may connect their own AI provider for four features — **Intelligent Mode**, **Other AI features**, **Speech-to-text** and **Translation**. The key is encrypted at rest with a master key held in the server's environment. Every AI call the Studio makes on that researcher's behalf passes through one billing door (`meteredCore`), which asks one resolver *whose AI this call uses*: project choice → the acting person's choice → the platform. A user-managed choice that cannot be honoured is a **refusal in words**; it never becomes the platform's AI. Calls on a person's own provider are recorded at zero charge and never touch a wallet.

## Layers

| Layer | Where | Responsibility |
|---|---|---|
| Provider registry | `packages/ai/src/registry.ts` | The catalog: provider id, label, kind (chat / stt / translate), protocol, fixed address (or custom allowed), optional identifiers, key family, limits. Only providers with a tested adapter are listed. |
| Endpoint guard | `packages/ai/src/netguard.ts` | `validateEndpoint` and `guardedFetch`: https only, no credentials or query in the address, DNS answer checked and pinned into the socket, private/loopback/link-local/CGNAT/ULA/mapped ranges refused, redirects refused, response size capped. |
| Connection scope | `packages/ai/src/connection.ts` | `withAiScope` (AsyncLocalStorage). Inside a scope, `@rescript/ai` reads base, key, model, headers and fallbacks from the scope, not from `process.env`; the operator fallback (`AI_FALLBACK_*`) is unreachable; calls use `guardedFetch`. `aiIdentity()` is a hash that names a connection for cache and in-flight keys. |
| Adapters | `packages/ai/src/index.ts`, `translateServices.ts` | Chat (OpenAI-style), speech (OpenAI-style multipart, Google `speech:recognize`), translation (Google v2, DeepL, Azure v3, chat-reuse). One driver per kind; the platform's Google adapter runs on the same driver. |
| Vault | `apps/studio/lib/byok/vault.ts` | AES-256-GCM envelope encryption; `seal`, `openSecret`, `rewrap`; `wrapKey/unwrapKey` are the only master-key operations (the seam for a KMS). |
| Store | `lib/byok/store.ts`, migration `0054` | `user_ai_credentials` (sealed blobs + masks) and `user_ai_settings` (choices, no secret). Every method takes the acting user's id. Memory and Supabase implementations. |
| Resolver | `lib/byok/resolve.ts` | `resolveConnection`: project → user → platform; produces a target (chat / stt / translate) or a refusal with a sentence. |
| Service | `lib/byok/service.ts` | Overview (masked), save a feature, save/replace/remove a key, Test Connection, model discovery. |
| Billing door | `apps/studio/lib/meterRun.ts` (`meteredCore`) | Project AI switch → resolver → platform hold/settle **or** own-provider zero-charge record **or** hybrid. |
| Routes | `app/api/account/ai/**`, `app/api/surveys/[id]/ai-source`, `app/api/admin/ai-policy` | All behind `requireUser` / `requireProject` / `requireAdmin`. |
| Screen | `components/settings/AiProviderConfig.tsx` | Account → AI & Integrations. Reads and writes only `/api/account/ai…`. |

## One call, end to end

1. A route authenticates the person (`requireUser` or the project gate).
2. The route calls `meteredAi` / `meteredStt` / `meteredTranslation` / `meteredTts` → `meteredCore` with an **operation** name. `features.ts` maps the operation to a setting: `copilot_*` → Intelligent Mode; `intelligent_voice`, `transcribe_question` → Speech-to-text; `translate…` → Translation; everything else → Other AI features.
3. **Project switch** is asked first (Internal / feature list), unchanged from before BYOK. (Speech and translation *services* are not language models, so "Internal" does not stop them.)
4. **Resolver**: project choice (`settings.ai.source`) → the acting user's setting for that feature → platform. Output is a platform target, an own-provider target, a hybrid, or `refused`.
5. **Platform** → reserve a hold → run → settle (as it always was).
6. **Own provider** → no wallet; the call runs inside `withAiScope` with the person's key; recorded as `AI_REQUEST_BYOK`, customer charge 0, tokens/characters/minutes and provider kept for attribution.
7. **Hybrid** (the person allowed the platform as last resort) → a hold is reserved first; only usage the platform actually served is settled.
8. Failures are worded as the person's own to fix ("Your AI provider rejected your key — check it in Settings → AI & Integrations"), not as an operator problem.

## What deliberately does not use a person's key

- **Respondent- and interview-facing AI** (`apps/runtime`, `apps/interviews`, `packages/interviews`, `packages/media`): no acting researcher exists, and decrypting a researcher's key inside the public respondent app would widen the blast radius. A containment test fails if those apps import the vault, enter a user scope, read the master key or touch the credential tables.
- **Background narration renders** in the story service stay on the platform's speech service.
- **The operator's fallback provider** (`AI_FALLBACK_*`) is never used inside a person's scope.

## Invariants (each held by a test; see 11 — Test report)

1. A key is never returned by any route, logged, cached or placed in a URL; the screen sees a mask.
2. A stored blob is bound to its user and credential (AAD); copying it elsewhere does not open it.
3. Only the acting user's key is ever used — never the project owner's, never another member's.
4. User-managed never silently becomes platform-managed.
5. A key is only sent to a provider of its own vendor family.
6. A custom endpoint is validated on save, on test and again on every use.
7. Own-provider work is never charged and never blocked by a wallet; platform work is unchanged.
8. Cache and in-flight keys carry the connection identity; user B never receives user A's cached reply.
