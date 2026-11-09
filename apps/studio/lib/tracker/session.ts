import type { TrackerKpi, WaveData, WaveMapping } from "@rescript/analytics";
import { mapWave } from "@rescript/analytics";

/**
 * THE WAVE TRACKER'S STATE IN THE STUDIO (2026-11-09). One place both modes read: the Results → Wave tracker panel
 * (Manual) edits it, Intelligent Mode answers from it. On a saved project the panel loads it from
 * /api/surveys/[id]/tracker and writes every change back; in the sandbox, or before migration 0093, it lives here for
 * the session only and the panel says so.
 */
export interface TrackerState {
  kpis: TrackerKpi[];
  composition: string[];
  segment: string | null;
  alpha: number;
  /** waveId → base variable → the wave's variable (null: not asked in that wave) */
  manual: Record<string, Record<string, string | null>>;
}
export interface TrackerSession { surveyId: string; waves: WaveData[]; state: TrackerState; persisted: boolean; note: string | null }

export const EMPTY_STATE: TrackerState = { kpis: [], composition: [], segment: null, alpha: 0.05, manual: {} };
let session: TrackerSession = { surveyId: "", waves: [], state: EMPTY_STATE, persisted: false, note: null };
const listeners = new Set<() => void>();

export function trackerSession(surveyId: string): TrackerSession {
  if (session.surveyId !== surveyId) session = { surveyId, waves: [], state: EMPTY_STATE, persisted: false, note: null };
  return session;
}
export function updateTracker(surveyId: string, patch: Partial<Omit<TrackerSession, "surveyId">>): void {
  session = { ...trackerSession(surveyId), ...patch };
  for (const l of listeners) l();
}
export function subscribeTracker(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }

/** the waves in order, the baseline first, and each later wave mapped to it (manual choices applied) */
export function orderedWithMappings(s: TrackerSession): { waves: WaveData[]; mappings: Record<string, WaveMapping> } {
  const waves = [...s.waves].sort((a, b) => a.order - b.order);
  const mappings: Record<string, WaveMapping> = {};
  for (const w of waves.slice(1)) mappings[w.id] = mapWave(waves[0], w, s.state.manual[w.id] ?? {});
  return { waves, mappings };
}

/** a TrackerState from whatever the store returned — only the fields this build understands */
export function readState(raw: unknown): TrackerState {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kpis = Array.isArray(o.kpis) ? (o.kpis as TrackerKpi[]).filter((k) => k && typeof k.variable === "string" && ["share", "top_box", "mean", "nps"].includes(k.measure)).slice(0, 30) : [];
  return {
    kpis,
    composition: Array.isArray(o.composition) ? (o.composition as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 8) : [],
    segment: typeof o.segment === "string" ? o.segment : null,
    alpha: typeof o.alpha === "number" && o.alpha > 0 && o.alpha < 0.5 ? o.alpha : 0.05,
    manual: o.manual && typeof o.manual === "object" ? (o.manual as TrackerState["manual"]) : {},
  };
}
