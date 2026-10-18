import { capabilityReadiness, serviceReadiness, SERVICES, type EnvLike } from "@rescript/engine";

/**
 * WHAT THIS INSTALLATION CAN DO, FOR AN ADMINISTRATOR (§11 / §10, 2026-10-18).
 *
 * The capability registry's readiness, read from the SERVER environment —
 * presence only: every row is a name and a yes / no, never a value. Shown on
 * the platform page (`/api/platform` → `/platform`), so missing critical
 * configuration (the language model, speech-to-text, translation, storage)
 * is an administrator's diagnostic, not a researcher's broken screen: the
 * researcher sees a refusal that names what is missing (Intelligent Mode,
 * `capabilityRefusal`), the administrator sees here what to set.
 *
 * Pure (no `server-only`): tested with a made-up environment.
 */

export interface CapabilityStatusReport {
  services: { id: string; name: string; purpose: string; ready: boolean; missing: string[]; reason?: string; apps: string[] }[];
  /** the capabilities that depend on configuration, ready or not */
  capabilities: { id: string; name: string; status: string; ready: boolean; missing: string[]; reason?: string }[];
  /** one sentence per critical gap, for the platform page's warnings */
  warnings: string[];
}

/** the services whose absence a researcher would hit as a broken feature */
const CRITICAL: Record<string, string> = {
  ai_chat: "Intelligent Mode is engine-only and AI probes, classification and document cards are off",
  speech_to_text: "recorded and video answers are not transcribed and spoken Intelligent-Mode requests cannot be read",
  translation: "the Studio's translate button and batch translation are off (Intelligent Mode can still write translations itself)",
  media_storage: "recordings and uploaded media cannot be stored",
};

export function capabilityStatusReport(env: EnvLike): CapabilityStatusReport {
  const svc = serviceReadiness(env);
  const services = Object.values(SERVICES).map((s) => ({ id: s.id, name: s.name, purpose: s.purpose, ready: svc[s.id].ready, missing: svc[s.id].missing, ...(svc[s.id].reason ? { reason: svc[s.id].reason } : {}), apps: [...s.apps] }));
  const capabilities = capabilityReadiness(env)
    .filter((r) => r.status !== "not_supported" && (r.missing.length > 0 || r.status === "requires_configuration"))
    .map((r) => ({ id: r.id, name: r.name, status: r.status, ready: r.ready, missing: r.missing, ...(r.reason ? { reason: r.reason } : {}) }));
  const warnings: string[] = [];
  for (const [id, effect] of Object.entries(CRITICAL)) {
    const s = svc[id];
    if (s && !s.ready) warnings.push(`${s.name} is not configured (${s.missing.map((m) => m.replace(/ \| /g, " or ")).join(", ")}${s.reason ? `; ${s.reason}` : ""}): ${effect}.`);
  }
  return { services, capabilities, warnings };
}
