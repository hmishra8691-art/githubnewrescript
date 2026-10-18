# Copilot response streaming — 2026-10-18

Weakness #4: `/api/copilot/turn` answered with one JSON body after the whole model call. During long work the researcher saw nothing for many seconds, and on weak networks idle connections dropped. Staged generation (90 s checkpoints, auto-resend, Resume) limited the damage but did not fix it. `INTELLIGENT-ENGINE-RELIABILITY-2026-10-17.md` §"not done" named streaming as the next step. This document describes what was built.

## What changed, in one paragraph

The route can now answer as a stream of NDJSON events: heartbeats, progress, the reply text as the model writes it, and each plan item as it is built. The stream ends with exactly one terminal event, which carries the JSON the old path returns. The provider layer (`@rescript/ai`) can stream from Anthropic (Messages SSE) and from OpenAI-compatible APIs (chat SSE). Usage and cache tokens are reported exactly as before. The page asks for a stream, shows the text live in the pending card, shows the current step, and stores each built item in its checkpoint as soon as it arrives. If the stream breaks, the existing recovery takes over (auto-resend, Resume). Without the header, everything is byte-for-byte as before.

## Protocol

**Opt-in:** the request header `Accept: application/x-ndjson`. `application/json` may also be listed; `*/*` does not count. There is no body flag.

**Response when streaming:** HTTP 200 with these headers:

- `Content-Type: application/x-ndjson; charset=utf-8`
- `Cache-Control: no-cache, no-transform`
- `X-Accel-Buffering: no`
- `X-Copilot-Stream: 1`

The body is one JSON object per line:

| event | when |
|---|---|
| `{"type":"start","v":1,"heartbeatMs":8000}` | right before the first model call (this is when the response becomes a stream) |
| `{"type":"heartbeat","at":…}` | every `heartbeatMs` (8 s) until the terminal event |
| `{"type":"progress","stage":"plan"\|"turn"\|"item"\|"gate"\|"repair"\|"coverage", "item","of","id","label"}` | a stage begins; `item`/`of`/`id`/`label` are set for plan items |
| `{"type":"text","delta":"…","part":"reply"}` | the readable field as the model writes it: `reply`, a plan's `summary`, or `item:<id>` while building. A `…:compact` part is the compact retry; the page replaces its text and does not append. |
| `{"type":"checkpoint","id":"p2","raw":{…}}` | a plan item was built. The page adds it to its checkpoint immediately. |
| `{"type":"result","status":200,"body":{…}}` | **terminal**: the exact body the JSON path returns (status < 400) |
| `{"type":"error","status":503,"body":{…},"retryAfter":5}` | **terminal**: the JSON path's failure body and status, plus Retry-After in seconds |

Rules:

- **Before `start`, nothing is streamed.** Auth, bad JSON, a missing definition, the 413 too-long refusal, the unsupported/ambiguous scope answer, capability refusals, "no model configured" (501), wallet and meter refusals at reservation time, and a cache hit all come back as plain JSON with their usual HTTP status. A client must accept either form.
- **Exactly one terminal event.** A stream that ends without one is a dropped connection. The page treats it as status 0.
- **Crash after `start`:** the terminal event is `{"type":"error","status":500,"body":null}`. The page reads this exactly like today's non-JSON 500: temporary, resend.
- **Actions** are still validated and applied only from the terminal result, through the existing gate (`coerceCopilotReply` → `applySurveyActions`). Streamed text is a preview only.

## One code path

The old `POST` body is now `turn(req, authed, sink)`. `POST` does three things: authenticates (the guard is still the first statement), refuses a signed-out caller as before, and then either:

- returns `turn(req, authed, null)` (JSON), or
- returns `streamTurn((sink) => turn(req, authed, sink))`.

`streamTurn` (`apps/studio/lib/copilot/stream.ts`) waits until the turn calls `sink.start()`. This happens in the `model()` wrapper, after the meter has reserved the call. If the turn finishes first, `streamTurn` returns the turn's own `Response` object untouched. After `start`, it streams, and the turn's eventual `Response` becomes the terminal event. Metering, reservations, single-flight, the cache, refusals and error mapping are therefore the same code on both paths.

**Streaming changes one behaviour.** If the page disconnects mid-stream, the stream's `cancel()` fires. The build loop then starts no further plan items, and the optional repair and coverage passes are skipped. The item in flight finishes and is metered as always. Without streaming, the route keeps building for nobody. Every item already built was sent as a `checkpoint`, so the resend does not pay for it again. (Whether Next/Vercel reports the disconnect is platform behaviour; see Risks.)

## Provider streaming (`packages/ai`)

`completeJson(system, user, max, { onText })`: when `onText` is set, the call is streamed:

- **Anthropic native** (`/v1/messages`): the same request (`cache_control` breakpoints unchanged) with `stream: true`. The reader takes the input and cache usage from `message_start` and the output usage and stop reason from `message_delta`. It merges them into the usage object a whole response carries, so `chatUsageFrom` and `reportUsage` see identical numbers (input, output, `cachedInputTokens`, `cacheWriteTokens`).
- **OpenAI-compatible** (including BYOK and gateways): `stream: true` and `stream_options: { include_usage: true }`. The last chunk carries `usage` with `prompt_tokens_details.cached_tokens`.
- **Continuations** (`finish_reason: length`) are streamed too, so the text arrives in order. The "reply again with only the JSON" retry is not streamed.
- **Fallbacks:**
  - A 400 that mentions `stream` → the same call is sent without streaming, and that base is not asked to stream again for the life of the process (`resetStreamRefusals()` for tests).
  - A provider that ignores the flag and answers whole → read as before, and the whole text is handed to `onText` once.
  - A provider-fallback hop streams like the primary.
- **Failures inside a stream:** an `error` event becomes the `ProviderError` the whole-response path would raise (overloaded, rate limited, auth…). A stream cut off before `message_stop`, `[DONE]` or a finish reason becomes a retryable `network` error. As before, a failed call reports **no** usage.
- **The fake provider** streams only when given `fakeStream: { text, chunkChars, delayMs, failAfterChars, failKind }`. Without it, it returns `{}` exactly as before.

Pure helpers, all in `packages/ai/src/stream.ts`:

- `SseDecoder`, `readAnthropicSse`, `readChatSse`
- `JsonTextExtractor`: an incremental, tolerant extractor of top-level string fields from partial JSON. It handles escapes, `\uXXXX`, surrogate pairs split across chunks, prose or a code fence before the object, and nested keys of the same name (which it ignores).
- `fakeStreamText`

## The page

`useCopilot` → `send()`:

- Sends `Accept: application/x-ndjson, application/json` unless switched off.
- Reads the response with `readTurnResponse` (`lib/copilot/stream.ts`), which returns the same `{ status, ok, d }` the resume logic always read. JSON (an older server, a proxy that rewrote the response, any pre-model answer) is read as before.
- `text` → `entry.live` (patched at most every 60 ms). `CopilotCard` shows it in the pending card (`data-testid="cp-live"`). The result or failure clears it, and every resend starts it empty.
- `progress` → `entry.progress.step` ("Item 2 of 5: Screener", "Checking the proposal", `cp-progress-step`).
- `checkpoint` → `cp.built` (`mergeBuilt`, idempotent by item id) and `saveCheckpoint`, immediately.
- `heartbeat` → liveness only. The reader's idle clock (45 s without a byte) breaks the stream as status 0.
- A stream that breaks before its result → `{ status: 0 }` → the existing path: auto-resend with the same words and checkpoint, then Resume. The resend carries every item the broken stream delivered in `done`, so the server does not build them again. Items are applied only from the final proposal, once.

## Switches

- **Server:** `COPILOT_STREAMING`
  - `off`: never stream; every client gets JSON.
  - `on`: stream whenever asked, including with the fake provider.
  - `auto` (default): stream when asked, except that with `AI_API_URL=fake:` the request must also carry the `fakeStream` test seam. The 14 browser suites written before streaming read the turn's response as JSON and keep working unchanged.
- **Page:** `localStorage["rescript.copilot.stream"] = "off"` or `NEXT_PUBLIC_COPILOT_STREAMING=off` (build time) sends plain JSON requests. A stored `on` overrides the build flag.
- **Provider:** `completeJson(…, { stream: false })` per call. Streaming is never used without `onText`, so every non-copilot caller is unchanged.

## Test seams (fake provider only)

- **Request body `fakeStream`:** `true`, or `{ chunkChars, delayMs, failAfterChars, failKind, heartbeatMs, dropAfterCheckpoints, dropAfterMs }`. The scripted `fake` reply is what the stand-in model "writes". `dropAfter*` ends the stream without a terminal event, as a proxy dropping the connection would.
- **Page:** `window.__rescriptCopilotStream(cfg | [cfg1, cfg2, …] | null)`. With a list, each request takes one config and the last one is kept.

## The 90 s stage cap, reconsidered

Kept at 90 s (`STAGE_SOFT_MS`). It still bounds the cost of a request that goes wrong and keeps each request well under `maxDuration = 180`. What changed:

- **Heartbeats flow every 8 s for the whole request,** including through a single long item (an item may take up to `outputBudget("item").timeoutMs`). An idle cut-off can no longer happen while the server is working. Only a real network loss ends a request.
- **Checkpoint granularity is now one item, not one request.** Each item reaches the page the moment it is built. A connection lost after item 3 of a request costs only the item in flight; before, it cost every item of that request.
- **Raising the cap would now be safe for the work,** but it would not help the researcher (the progress is visible either way) and would make each request longer than necessary. Not done.

## Tests

- **`packages/ai/src/stream.test.ts`** (12): SSE decoding (CRLF/CR, split lines, multi-line data); Anthropic and OpenAI stream readers (deltas, stop reasons, usage merge including cache read/write, error events, truncation, UTF-8 split across chunks); the extractor (escapes, `\u` and surrogate pairs split at every chunk size, Devanagari, prose or fence before the object, nested keys ignored); the fake stream; `completeJson` end to end against a stubbed fetch, covering:
  - the Anthropic request keeps `cache_control` and the usage report is identical to the whole-response path
  - OpenAI `stream_options`
  - a streamed continuation
  - stream refusal → resend whole and remember
  - the stream flag ignored
  - an in-stream error or a cut-off stream → `ProviderError` with no usage
  - the fake streaming only when scripted
- **`apps/studio/lib/copilot/stream.test.ts`** (8): NDJSON encode/decode; `wantsStream`, `streamingAllowed` and `clientStreaming`; `streamTurn` returns a pre-start response untouched (same object) and propagates a pre-start exception; started → headers, event order, heartbeats, one terminal `result` with the exact body; an error after start keeps the status, body and Retry-After; a crash becomes a 500 with no body; the drop seam ends without a terminal and marks the turn cancelled; `readTurnResponse` handles JSON, NDJSON, a broken stream and an idle stream; the two paths' bodies are equal.
- **Browser:** `node scripts/copilot-streaming-test.mjs` (Studio on :3000, `AI_API_URL=fake:`):
  1. route protocol and status parity, heartbeats through a slow call
  2. text in the card before the result
  3. streamed staged generation with item steps, applied once
  4. a stream dropped after item 1 → resend builds only items 2–3, applied once
  5. a provider failure mid-stream → resent, the second answer shown whole
  6. streaming switched off, and a JSON answer to a streaming request

The route itself has no unit test: it imports Next and Supabase. Its two paths are exercised by the browser suite against the dev server, and the wrapper is tested in isolation.

## Risks on Vercel

- **Buffering.** Node-runtime route handlers stream a `ReadableStream` body on Vercel. `no-transform` and `X-Accel-Buffering: no` stop proxies (nginx, some CDNs) from buffering or compressing it. A proxy that still buffers delivers the whole stream at the end. The page then reads it as normal, only without the live text.
- **`maxDuration = 180`** still applies to the whole stream. The route's own clock (165 s budget, 90 s stage cap, 15 s gate reserve) is unchanged, so the terminal event is sent before the platform limit. If the platform kills the function anyway, the stream ends without a terminal event, and the page resends. This is better than the old non-JSON 504 page, and every item already built has been kept.
- **Client disconnect detection.** Whether `cancel()` fires when the browser goes away depends on the platform's proxy. If it does not fire, the route behaves as before: it finishes the request for nobody, and the page's resend may build the in-flight items again. Single-flight on the same instance shares an identical in-flight item call.
- **Heartbeats keep the function busy:** no change in billing, since the function was already running for the whole call.
- **Charge shown on the card.** The charge of a request whose stream dropped never reaches the page, so the card's running total can be low. The meter records the true charge.

## Not done

- No resume of a broken stream mid-item. The item in flight is rebuilt.
- Text deltas are not streamed for the plan-retry, repair and coverage calls. Their results replace the reply on the final card.
- When single-flight shares an identical call between two requests, only the first request receives its text deltas. The second still gets heartbeats and the result.
- No route-level unit test (see Tests).
- The capacity notice and "waiting for capacity" waits are still checkpoint responses, not stream events.
