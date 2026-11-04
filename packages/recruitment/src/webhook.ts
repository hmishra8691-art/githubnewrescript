import { createHmac, timingSafeEqual } from "node:crypto";
import { PROLIFIC_WEBHOOK } from "./adapters/prolific.js";

/**
 * RECEIVING EVENTS FROM A VENDOR (Phase 6).
 *
 * A webhook endpoint is the one door into this platform that an attacker can knock on directly, and what comes
 * through it moves money: a "complete" event marks a respondent billable. So three separate things must hold
 * before an event is acted on, and each one fails closed:
 *
 *   AUTHENTIC    the HMAC over the exact bytes received matches, compared in constant time.
 *   FRESH        the signed timestamp is inside a short window. Without this a captured request can be replayed
 *                verbatim a month later and still verify perfectly — the signature is valid forever.
 *   NEW          the event id has not been seen before. Vendors deliver at least once and REUSE the id on
 *                retries, which is what makes it usable as the idempotency key 0081 already enforces.
 *
 * An event failing any of these is STORED AND QUARANTINED, never dropped silently and never acted on. A
 * webhook that quietly discards what it cannot verify is indistinguishable from one that is broken, and the
 * first you hear of it is a vendor asking why they have not been paid.
 *
 * ## On verifying the raw bytes
 *
 * Verification runs over the body exactly as it arrived. Prolific's own example re-serialises a parsed body
 * with `json.dumps` before hashing, which works only while both sides serialise identically — one difference in
 * key order or spacing and a genuine event is rejected as a forgery. Reading the raw body has no such failure
 * mode, so the Studio route is careful to take `await req.text()` BEFORE anything parses the request.
 */

export type WebhookVerdict = "verified" | "bad_signature" | "stale" | "no_signature" | "no_secret" | "malformed";

export interface WebhookEnvelope {
  vendor: string;
  eventId: string | null;
  timestamp: string | null;
  signature: string | null;
  verdict: WebhookVerdict;
  /** only ever true for `verified`; every other verdict quarantines */
  actionable: boolean;
  reason?: string;
}

/** How far out of date a signed timestamp may be. Five minutes, the same window 0072 uses for panel callbacks. */
export const WEBHOOK_WINDOW_MS = 5 * 60 * 1000;

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  // length is not secret, and timingSafeEqual throws on a mismatch, so compare it first
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface VendorWebhookSpec {
  signatureHeader: string;
  timestampHeader: string;
  eventIdHeader: string;
  encoding: "base64" | "hex";
  payload: (timestamp: string, rawBody: string) => string;
}

/** Only vendors whose signing scheme is documented appear here. An unknown vendor is refused, not guessed at. */
export const WEBHOOK_SPECS: Readonly<Record<string, VendorWebhookSpec>> = Object.freeze({
  prolific: PROLIFIC_WEBHOOK,
});

export interface VerifyInput {
  vendor: string;
  /** the body exactly as received — not re-serialised */
  rawBody: string;
  headers: Record<string, string | null | undefined>;
  secret: string | null | undefined;
  now?: number;
}

/**
 * Verify one delivery. Returns a verdict; never throws, because a malformed request from the public internet
 * is an expected input, not an exceptional one.
 */
export function verifyWebhook(input: VerifyInput): WebhookEnvelope {
  const spec = WEBHOOK_SPECS[input.vendor];
  const now = input.now ?? Date.now();
  const header = (name: string) => {
    const v = input.headers[name] ?? input.headers[name.toLowerCase()];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };

  const base: WebhookEnvelope = {
    vendor: input.vendor, eventId: null, timestamp: null, signature: null,
    verdict: "malformed", actionable: false,
  };

  if (!spec) {
    return { ...base, reason: `No signing scheme is known for "${input.vendor}", so nothing from it can be trusted.` };
  }

  const signature = header(spec.signatureHeader);
  const timestamp = header(spec.timestampHeader);
  const eventId = header(spec.eventIdHeader);
  const carried = { ...base, eventId, timestamp, signature };

  if (!input.secret) {
    /*
     * No secret configured. Refuse rather than accept: an endpoint that processes unsigned events because
     * nobody set a secret is an open door that looks like a working integration.
     */
    return { ...carried, verdict: "no_secret", reason: "No signing secret is configured for this vendor, so its events cannot be verified." };
  }
  if (!signature || !timestamp) {
    return { ...carried, verdict: "no_signature", reason: "The request carried no signature or no timestamp." };
  }

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) {
    return { ...carried, verdict: "malformed", reason: "The signed timestamp is not a number." };
  }
  /*
   * Both directions. A timestamp far in the FUTURE is as suspicious as an old one — it is how a replay is
   * given a long life — and a small allowance covers ordinary clock drift between two servers.
   */
  const ageMs = now - seconds * 1000;
  if (ageMs > WEBHOOK_WINDOW_MS || ageMs < -WEBHOOK_WINDOW_MS) {
    return {
      ...carried, verdict: "stale",
      reason: `The signature is ${Math.round(Math.abs(ageMs) / 1000)} seconds ${ageMs > 0 ? "old" : "in the future"}; the window is ${WEBHOOK_WINDOW_MS / 1000} seconds.`,
    };
  }

  const expected = createHmac("sha256", input.secret)
    .update(spec.payload(timestamp, input.rawBody))
    .digest(spec.encoding);

  if (!constantTimeEqual(expected, signature)) {
    return { ...carried, verdict: "bad_signature", reason: "The signature does not match the body received." };
  }
  if (!eventId) {
    /*
     * Authentic but unusable: with no event id there is nothing to de-duplicate on, and a retry would be
     * counted a second time. Quarantine it for a human rather than risk double-counting money.
     */
    return { ...carried, verdict: "malformed", reason: "The event is correctly signed but carries no event id, so it cannot be de-duplicated." };
  }

  return { ...carried, verdict: "verified", actionable: true };
}

/**
 * The idempotency key written to `recruitment_events` (0081), whose unique index is the thing that actually
 * prevents double counting. Scoped by vendor so two vendors cannot collide on a shared id format.
 */
export function webhookIdempotencyKey(vendor: string, eventId: string): string {
  return `webhook:${vendor}:${eventId}`;
}

export interface NormalisedEvent {
  kind: "submission" | "study" | "unknown";
  vendorOrderRef: string | null;
  participantId: string | null;
  status: string | null;
}

/**
 * Pull the few fields the orchestrator needs out of a vendor's payload.
 *
 * Deliberately shallow. The raw event is stored whole, so nothing is lost by this reading little; whereas an
 * eager mapper that guesses at a field it has not seen documented produces confident nonsense.
 */
export function normaliseEvent(vendor: string, body: unknown): NormalisedEvent {
  const none: NormalisedEvent = { kind: "unknown", vendorOrderRef: null, participantId: null, status: null };
  if (!body || typeof body !== "object") return none;
  const b = body as Record<string, unknown>;

  if (vendor === "prolific") {
    const resource = (b.resource ?? b) as Record<string, unknown>;
    const topic = typeof b.event_type === "string" ? b.event_type : typeof b.topic === "string" ? b.topic : "";
    const study = resource.study_id ?? resource.study ?? b.study_id;
    const participant = resource.participant_id ?? resource.participant;
    const status = resource.status ?? b.status;
    return {
      kind: topic.includes("submission") ? "submission" : topic.includes("study") ? "study" : "unknown",
      vendorOrderRef: typeof study === "string" ? study : null,
      participantId: typeof participant === "string" ? participant : null,
      status: typeof status === "string" ? status : null,
    };
  }
  return none;
}
