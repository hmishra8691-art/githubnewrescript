import type { UsageEvent } from "@rescript/billing";

/**
 * WHAT THE SETTINGS SCREEN'S USAGE SECTION SAYS — computed from the usage
 * events the metering door already writes, never from a second ledger.
 *
 * Two kinds of AI work, never added together:
 *
 *   OWN PROVIDER (`AI_REQUEST_BYOK`) — the person's own provider key paid for
 *   it. The platform neither charged nor paid, and does not know what that
 *   provider charges, so NO MONEY is shown for these rows: volumes only
 *   (calls, tokens, characters, minutes) and which provider and model.
 *
 *   PLATFORM-MANAGED — AI, translation and speech that ran on the platform's
 *   providers and were charged to the person's wallet. Those rows carry a
 *   customer charge, the same number the My usage page shows; nothing else
 *   about cost (provider cost, fees, margin) is read here.
 *
 * A fallback hop onto the platform (allowed by the person, billed as the
 * platform's) is a platform row; a call on the person's provider that was
 * served by a listed fallback is an own-provider row with `viaFallback`.
 */

export type UsageService = "chat" | "stt" | "translate" | "tts" | "other";
const SERVICES: UsageService[] = ["chat", "stt", "translate", "tts"];
const serviceOf = (e: UsageEvent): UsageService => (SERVICES.includes(e.service as UsageService) ? (e.service as UsageService) : "other");

export interface OwnRow {
  service: UsageService; provider: string; model: string | null;
  calls: number; viaFallback: number;
  /** chat: tokens in / out */
  inputTokens: number; outputTokens: number;
  /** translation / text-to-speech: characters; speech-to-text: minutes (seconds are not invented) */
  characters: number; minutes: number;
  lastAt: string;
}
export interface PlatformRow { service: UsageService | "translate"; label: string; calls: number; charge: number; unit: string; quantity: number; lastAt: string }

export interface AiUsage {
  days: number;
  since: string;
  own: OwnRow[];
  ownTotals: { calls: number; viaFallback: number };
  platform: PlatformRow[];
  platformTotals: { calls: number; charge: number };
  /** the sentence the screen shows about cost, so it is said once and the same everywhere */
  costNote: string;
}

export const OWN_COST_NOTE = "Work on your own provider is paid to that provider, under your agreement with them. The Studio does not charge for it and does not know your price, so no cost is shown here — only how much was sent.";

const asNumber = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function summariseAiUsage(events: UsageEvent[], opts: { days?: number; now?: Date } = {}): AiUsage {
  const days = opts.days ?? 30;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const own = new Map<string, OwnRow>();
  const platform = new Map<string, PlatformRow>();

  for (const e of events) {
    if (e.createdAt < since) continue;
    if (e.adjustsEventId) continue; // a reversal corrects another row; it is not work
    if (e.eventType === "AI_REQUEST_BYOK") {
      const service = serviceOf(e);
      const provider = String((e.metadata?.providerId as string | undefined) ?? e.provider ?? "unknown");
      const key = `${service}|${provider}|${e.model ?? ""}`;
      const r = own.get(key) ?? { service, provider, model: e.model ?? null, calls: 0, viaFallback: 0, inputTokens: 0, outputTokens: 0, characters: 0, minutes: 0, lastAt: e.createdAt };
      r.calls += 1;
      if (e.metadata?.usedFallback === true) r.viaFallback += 1;
      if (service === "chat") { r.inputTokens += asNumber(e.inputUnits); r.outputTokens += asNumber(e.outputUnits); }
      else if (e.unit === "character") r.characters += asNumber(e.quantity);
      else if (e.unit === "minute") r.minutes += asNumber(e.quantity);
      if (e.createdAt > r.lastAt) r.lastAt = e.createdAt;
      own.set(key, r);
      continue;
    }
    if (e.category !== "ai" && e.category !== "translation" && e.category !== "voice") continue;
    if (e.eventType === "AI_INPUT_TOKEN" || e.eventType === "AI_OUTPUT_TOKEN") continue; // components of an AI_REQUEST row, not requests
    const label = e.category === "translation" ? "Translation" : e.category === "voice" ? "Speech" : "AI model";
    const key = e.category;
    const r = platform.get(key) ?? { service: (e.category === "translation" ? "translate" : e.category === "voice" ? "stt" : "chat") as PlatformRow["service"], label, calls: 0, charge: 0, unit: e.unit, quantity: 0, lastAt: e.createdAt };
    r.calls += 1; r.charge = Math.round((r.charge + e.customerCharge) * 1e6) / 1e6; r.quantity += asNumber(e.quantity);
    if (e.createdAt > r.lastAt) r.lastAt = e.createdAt;
    platform.set(key, r);
  }

  const ownRows = [...own.values()].sort((a, b) => b.calls - a.calls || (a.provider < b.provider ? -1 : 1));
  const platformRows = [...platform.values()].sort((a, b) => b.charge - a.charge);
  return {
    days, since,
    own: ownRows,
    ownTotals: { calls: ownRows.reduce((s, r) => s + r.calls, 0), viaFallback: ownRows.reduce((s, r) => s + r.viaFallback, 0) },
    platform: platformRows,
    platformTotals: { calls: platformRows.reduce((s, r) => s + r.calls, 0), charge: Math.round(platformRows.reduce((s, r) => s + r.charge, 0) * 1e6) / 1e6 },
    costNote: OWN_COST_NOTE,
  };
}
