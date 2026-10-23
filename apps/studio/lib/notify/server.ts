import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { emptyPanelState, memoryPanelStore, supabasePanelStore, type MemoryPanelState, type PanelStore } from "@rescript/analytics";
import type { PanelHasher } from "@rescript/engine";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiProviderName, deriveKey, envelopeStatus, guardedFetch, maskSecretUrl, openEnvelope, sealEnvelope, signedHeader, validateEndpoint } from "@rescript/ai";
import { supabaseService } from "@/lib/authServer";
import { sendMail } from "@/lib/mail";
import { dbNotifyStore } from "./dbStore.ts";
import { emptyNotifyState, memoryNotifyStore, type MemoryNotifyState } from "./memoryStore.ts";
import type { ChannelRec, NotifyStore } from "./types.ts";
import type { NotifyDeps } from "./service.ts";

/**
 * THE NOTIFICATION SERVICE'S WIRING (2026-10-22, G3): the store (database, or the sandbox's memory), the sender
 * (the endpoint guard: https, public addresses only, no redirects, size- and time-capped), the mailer (lib/mail.ts),
 * and the envelope that seals webhook URLs (INTEGRATIONS_SECRET_KEY).
 *
 * THE SANDBOX — a Studio with NO database on the FAKE provider and not in production (a laptop, the browser
 * suites): channels, events and deliveries live in this process and in a file in the OS temp directory (a dev
 * server restarting under memory pressure keeps a test's channels); secrets are sealed with a random key kept in
 * that file, and endpoints on the local network are allowed (the suites' test server is on 127.0.0.1). Nothing of
 * this path runs anywhere else.
 */

export function notifySandbox(): boolean {
  return aiProviderName() === "fake" && !process.env.SUPABASE_URL && process.env.NODE_ENV !== "production";
}

const SANDBOX_KEY = "__rescriptNotifySandbox";
const SANDBOX_FILE = join(tmpdir(), "rescript-notify-sandbox.json");
type SandboxBox = { state: MemoryNotifyState; key: Buffer; store: ReturnType<typeof memoryNotifyStore>; panels: Record<string, unknown> };
function sandboxBox(): SandboxBox {
  const g = globalThis as unknown as Record<string, SandboxBox>;
  if (!g[SANDBOX_KEY]) {
    let state = emptyNotifyState(), key = randomBytes(32), panels: Record<string, unknown> = {};
    try {
      const saved = JSON.parse(readFileSync(SANDBOX_FILE, "utf8")) as { state?: MemoryNotifyState; key?: string; panels?: Record<string, unknown> };
      if (saved.state) state = { ...emptyNotifyState(), ...saved.state };
      if (saved.key && /^[0-9a-f]{64}$/.test(saved.key)) key = Buffer.from(saved.key, "hex");
      if (saved.panels) panels = saved.panels;
    } catch { /* none yet */ }
    const box = { state, key, panels } as SandboxBox;
    box.store = memoryNotifyStore(state, { onChange: () => persistSandbox() });
    g[SANDBOX_KEY] = box;
  }
  return g[SANDBOX_KEY];
}
export function persistSandbox(): void {
  const b = (globalThis as unknown as Record<string, SandboxBox>)[SANDBOX_KEY];
  if (!b) return;
  /* keep the file bounded: the newest deliveries / events / bell rows */
  b.state.deliveries = b.state.deliveries.slice(-500); b.state.events = b.state.events.slice(-500); b.state.inApp = b.state.inApp.slice(-300);
  try { writeFileSync(SANDBOX_FILE, JSON.stringify({ state: b.state, key: b.key.toString("hex"), panels: b.panels }), { mode: 0o600 }); } catch { /* best effort */ }
}
/** the sandbox's panel settings, sealed secrets and entries (the definition lives in the browser there) */
export function sandboxPanelState(): MemoryPanelState {
  const b = sandboxBox();
  const p = b.panels as unknown as Partial<MemoryPanelState>;
  if (!p.entries || !p.panels || !p.secrets) { const fresh = { ...emptyPanelState(), ...p }; b.panels = fresh as unknown as Record<string, unknown>; }
  return b.panels as unknown as MemoryPanelState;
}
/** the panel store: the database (0072, the saved definition's panels), or the sandbox's memory (secrets sealed with the sandbox key) */
export function panelStore(): PanelStore {
  if (notifySandbox()) {
    const st = sandboxPanelState();
    const mem = memoryPanelStore(st, { onChange: () => persistSandbox() });
    return { ...mem, async secret(surveyId, key) { const sealed = st.secrets[`${surveyId}|${key}`]; if (!sealed) return null; try { return openSealed(sealed, panelAad(surveyId, key)); } catch { return null; } } };
  }
  return supabasePanelStore(supabaseService() as never, { openPanelSecret: (sealed, aad) => openSealed(sealed, aad) });
}
/** the signer's digests (node:crypto) */
export const panelHasher: PanelHasher = (alg, data, secret) => (alg === "hmac-sha256" || alg === "hmac-sha1" ? createHmac(alg === "hmac-sha256" ? "sha256" : "sha1", secret).update(data, "utf8").digest() : createHash(alg).update(data + secret, "utf8").digest());

export function notifyStore(): NotifyStore { return notifySandbox() ? sandboxBox().store : dbNotifyStore(supabaseService()); }
export function sandboxMemory(): MemoryNotifyState { return sandboxBox().state; }
const sandboxKey = (): Buffer | null => (notifySandbox() ? sandboxBox().key : null);

/* ------------------------------------------------------------ secrets */

export const channelAad = (c: Pick<ChannelRec, "customerId" | "id">) => `notify-channel|${c.customerId}|${c.id}`;
export const panelAad = (surveyId: string, key: string) => `panel|${surveyId}|${key}`;
export function secretsStatus(): { ready: boolean; reason?: string } { return envelopeStatus(process.env, sandboxKey()); }
export function sealSecret(plain: string, aad: string): { sealed: string; keyId: string } { return sealEnvelope(plain, aad, process.env, sandboxKey()); }
export function openSealed(sealed: string, aad: string): string { return openEnvelope(sealed, aad, process.env, sandboxKey()); }
export { maskSecretUrl };

/** may the alert sender reach a private address? the operator's own network (server env), or the local sandbox */
export const allowPrivate = () => process.env.NOTIFY_ALLOW_PRIVATE_ENDPOINTS === "1" || notifySandbox();

/** a webhook URL as typed: https, a public host (query strings allowed — Teams Workflows and Slack-compatible tools use them) */
export function checkWebhookUrl(raw: string): { ok: true; url: string } | { ok: false; message: string } {
  const t = String(raw ?? "").trim();
  if (t.length > 2000) return { ok: false, message: "That address is too long." };
  const base = t.replace(/[?#].*$/, "");
  const v = validateEndpoint(base, { allowPrivate: allowPrivate(), ports: [443, 8443] });
  if (!v.ok) return { ok: false, message: v.message.replace("The address must start with https:// — keys are never sent over an unencrypted connection.", "The address must start with https://.") };
  return { ok: true, url: t };
}

/** the key that authenticates the runtime's alert events to the Studio (a sub-key of INTEGRATIONS_SECRET_KEY) */
export function ingestKey(): Buffer | null { return deriveKey("notify-ingest", process.env, null); }

/* ------------------------------------------------------------ the dependencies */

export function notifyDeps(store: NotifyStore = notifyStore()): NotifyDeps {
  const studioUrl = (process.env.STUDIO_PUBLIC_URL ?? "").trim().replace(/\/+$/, "") || (notifySandbox() ? "http://localhost:3000" : null);
  return {
    store,
    now: () => Date.now(),
    studioUrl,
    async post(url, body, headers) {
      const res = await guardedFetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(10_000) }, { allowPrivate: allowPrivate(), maxResponseBytes: 64 * 1024, ports: [443, 8443] });
      const text = await res.text().catch(() => "");
      return { status: res.status, text: text.slice(0, 200) };
    },
    async mail(m) {
      const r = await sendMail({ to: m.to, subject: m.subject, text: m.text, html: m.html, kind: m.kind, stream: "transactional", dedupeKey: m.dedupeKey, surveyId: m.surveyId && /^[0-9a-f-]{36}$/i.test(m.surveyId) ? m.surveyId : null, customerId: m.customerId && /^[0-9a-f-]{36}$/i.test(m.customerId) ? m.customerId : null });
      if (r.sent) return { status: "sent" };
      return { status: r.reason === "not_configured" ? "not_configured" : r.reason === "duplicate" ? "duplicate" : r.reason === "suppressed" || r.reason === "invalid_recipient" ? "suppressed" : "failed", detail: r.reason === "provider_error" ? r.detail : undefined };
    },
    openChannel(c) {
      if (!c.sealed) throw new Error("the channel has no stored address");
      const v = JSON.parse(openSealed(c.sealed, channelAad(c))) as { url: string; signingSecret?: string };
      return v;
    },
    signWebhook: (secret, body, nowMs) => signedHeader(secret, body, nowMs),
  };
}

/** sign a body for the ingest route (used by tests and by anything server-side posting to it) */
export function signIngest(body: string, nowMs = Date.now()): string | null { const k = ingestKey(); return k ? signedHeader(k, body, nowMs) : null; }
