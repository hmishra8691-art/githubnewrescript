import "server-only";
import { deriveKey, signedHeader } from "@rescript/ai";

/**
 * PORTAL EMAIL (phase 1, 2026-11-20). The respondent app has no mail transport of its own — and should not grow a
 * second one, with a second set of safety rules. A password-reset email is handed to the Studio, which sends it
 * through the platform's one mailer (de-duplication, non-production redirect, the delivery log). The hand-over is a
 * signed server-to-server call, exactly as the runtime's alert events are (lib/notifyEmit.ts): HMAC-SHA256 with a
 * sub-key of INTEGRATIONS_SECRET_KEY, five-minute window. Without the key or the Studio's address nothing is sent,
 * and the caller is told so.
 */
const studioBase = () => (process.env.STUDIO_INTERNAL_URL ?? process.env.STUDIO_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");

export function portalOrigin(fallback: string): string {
  const raw = (process.env.NEXT_PUBLIC_RUNTIME_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return fallback.replace(/\/+$/, "");
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export async function sendResetMail(m: { to: string; name: string | null; respondentId: string; link: string; minutes: number }): Promise<boolean> {
  const key = deriveKey("portal-mail");
  const base = studioBase();
  if (!key || !base) {
    console.warn("[rescript:portal] reset email not sent: INTEGRATIONS_SECRET_KEY and STUDIO_INTERNAL_URL (or STUDIO_PUBLIC_URL) are needed");
    return false;
  }
  const body = JSON.stringify({ kind: "portal_reset", ...m });
  try {
    const r = await fetch(`${base}/api/portal-mail`, { method: "POST", headers: { "content-type": "application/json", "x-rescript-portal-mail": signedHeader(key, body) }, body, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    return r.ok;
  } catch (e) {
    console.warn("[rescript:portal] reset email not handed over", JSON.stringify({ error: (e as Error).message.slice(0, 160) }));
    return false;
  }
}
