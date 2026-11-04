import "server-only";
import { sealEnvelope, openEnvelope, envelopeStatus } from "@rescript/ai";

/**
 * VENDOR API CREDENTIALS (Phase 6b).
 *
 * The same envelope encryption the BYOK vault and the alert channels use, under
 * `INTEGRATIONS_SECRET_KEY` — not a second scheme invented for this one table. 0081 reserved
 * `credentials_sealed` and `credentials_key_id` for exactly this, and revoked the column from the
 * `authenticated` grant so a member reading an integration gets the masked hint and never the blob.
 *
 * The AAD binds the ciphertext to the integration row it belongs to. Without it a sealed credential lifted from
 * one organisation's row and written into another's would open perfectly well, which is the difference between
 * encryption and encryption that is actually load-bearing.
 */

export const credentialAad = (customerId: string, integrationId: string) =>
  `vendor-integration|${customerId}|${integrationId}`;

export interface SealedCredentials {
  sealed: string;
  keyId: string;
  /** what a screen may show: never the token, only enough to recognise which one it is */
  hint: string;
}

/**
 * A hint that identifies a token without weakening it: the last four characters only, and only when the token
 * is long enough that four characters are a negligible share of it. A short secret shows nothing at all.
 */
export function credentialHint(token: string): string {
  const t = token.trim();
  if (t.length < 12) return "••••";
  return `••••${t.slice(-4)}`;
}

export function sealCredentials(
  customerId: string, integrationId: string, credentials: Record<string, string>,
): SealedCredentials {
  const token = credentials.token ?? credentials.apiKey ?? "";
  const { sealed, keyId } = sealEnvelope(
    JSON.stringify(credentials), credentialAad(customerId, integrationId),
  );
  return { sealed, keyId, hint: credentialHint(token) };
}

/** Opened only on the server, only when a call is about to be made, and never returned to a client. */
export function openCredentials(
  customerId: string, integrationId: string, sealed: string,
): Record<string, string> {
  const plain = openEnvelope(sealed, credentialAad(customerId, integrationId));
  const parsed: unknown = JSON.parse(plain);
  if (!parsed || typeof parsed !== "object") throw new Error("the sealed credentials are not an object");
  return parsed as Record<string, string>;
}

/** Whether a key is configured at all, so the route can refuse with a useful reason rather than throw. */
export function credentialsKeyReady(): { ok: boolean; reason?: string } {
  const status = envelopeStatus();
  return status.ready
    ? { ok: true }
    : { ok: false, reason: status.reason ?? "INTEGRATIONS_SECRET_KEY is not configured, so vendor credentials cannot be sealed." };
}
