import { createHmac, randomBytes } from "node:crypto";
import { fenceUntrusted, type FenceOptions } from "@rescript/engine";

/**
 * UNTRUSTED TEXT IN PROMPTS — the server half (prompt-injection audit, 2026-10-18).
 *
 * The pure tools (fence, neutralise, scan, the probe check, the standard
 * instruction) live in @rescript/engine so the analytics and interviews
 * packages can use them too; they are re-exported here, where every model
 * call starts.
 *
 * What only a server can do is a nonce that is unpredictable AND stable: a
 * fresh random fence id on every call would change the prompt of two
 * identical requests, and with it the copilot's reply cache key, its
 * single-flight key and the provider's prompt cache for everything after the
 * fence. `fenceNonceFor(seed)` is an HMAC of the request (survey, person,
 * message) under a secret drawn once per process: the same request gets the
 * same fence, a document's author cannot know it, and no two processes share
 * it. It is still only ever placed in the user part of a call, never in a
 * cached system block.
 */
export { DEFAULT_PROBE, defaultProbeFor, FENCE_CLOSE, FENCE_OPEN, INJECTION_NOTICE, INJECTION_WARNING, MAX_PROBE_CHARS, UNTRUSTED_DATA_RULE, fenceUntrusted, neutralizeUntrusted, newFenceNonce, probeProblems, scanUntrusted, withoutInstructionLines, type FenceOptions, type InjectionKind, type InjectionScan, type InjectionSignal } from "@rescript/engine";

const PROCESS_SECRET = randomBytes(32);

/** a fence id for this request: unpredictable outside this process, the same for the same seed within it */
export function fenceNonceFor(seed: string): string {
  return createHmac("sha256", PROCESS_SECRET).update(String(seed)).digest("hex").slice(0, 12);
}

/** fence `text` with the keyed nonce of `seed` */
export function fenceFor(seed: string, text: string, opts: Omit<FenceOptions, "nonce">): string {
  return fenceUntrusted(text, { ...opts, nonce: fenceNonceFor(seed) });
}
