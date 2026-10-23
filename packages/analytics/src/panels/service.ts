import type { PanelConfig, PanelOutcome, PanelTarget } from "@rescript/schema";
import { PanelConfig as PanelConfigSchema } from "@rescript/schema";
import { capturePanelEntry, panelRedirect, type PanelHasher, type PanelParams, type PanelRedirect } from "@rescript/engine";

/**
 * PANEL ENTRIES AND EXITS — THE ORCHESTRATION (2026-10-22, G3), shared by the respondent runtime (AI interviews
 * /i/, group sessions /g/, live sessions, the survey link) and the Studio's sandbox, over any store (the database:
 * `storeDb.ts`, migration 0072; memory: `storeMemory.ts`). The pure rules are the engine's (`panels.ts`).
 *
 *   enterPanel   an arrival: which panel, its id, the kept parameters → admitted (an entry row), or REFUSED
 *                (no id, a placeholder still in the link, the panel paused), or a DUPLICATE (the same panel id
 *                already took part — atomic in the database), or OVER QUOTA (the panel's completes target is met:
 *                sent straight back with the over-quota link). No panel configured: the legacy `pid` passes through.
 *   exitPanel    an outcome → the end link (signed with the panel's secret when it signs), recorded once on the
 *                entry (the first outcome stands: a later call returns the same link), never for a test entry's
 *                reconciliation counts
 *
 * The secret is opened by the store's caller-supplied `secret()` (the envelope, INTEGRATIONS_SECRET_KEY) for the
 * one call that signs, and never returned.
 */

export interface PanelEntryRec {
  id: string;
  surveyId: string;
  panelKey: string;
  pid: string;
  target: PanelTarget;
  targetRef: string | null;
  sessionRef: string | null;
  isTest: boolean;
  captured: Record<string, string>;
  outcome: PanelOutcome | null;
  status: string | null;
  signed: boolean | null;
  startedAt: string;
  endedAt: string | null;
}

export interface PanelStore {
  kind: "db" | "memory";
  /** the study's panels (its saved definition) */
  panels(surveyId: string): Promise<PanelConfig[]>;
  /** the panel's signing secret, opened — null when none is set (or it cannot be opened here) */
  secret(surveyId: string, panelKey: string): Promise<string | null>;
  /** insert, or the existing entry when this panel id already took part (dedupe) */
  enter(a: { surveyId: string; panelKey: string; pid: string; target: PanelTarget; targetRef: string | null; isTest: boolean; dedupe: boolean; captured: Record<string, string> }): Promise<{ entryId: string; duplicate: boolean; outcome: PanelOutcome | null; sessionRef: string | null }>;
  entry(id: string): Promise<PanelEntryRec | null>;
  entryBySession(sessionRef: string): Promise<PanelEntryRec | null>;
  update(id: string, patch: Partial<Pick<PanelEntryRec, "sessionRef" | "outcome" | "status" | "signed" | "endedAt">> & { redirectedAt?: string }): Promise<void>;
  /** completes recorded for this panel (not tests) */
  completes(surveyId: string, panelKey: string): Promise<number>;
  list(surveyId: string, limit?: number): Promise<PanelEntryRec[]>;
}

export type PanelEntryResult =
  | { kind: "none"; pid: string | null }
  | { kind: "admitted"; entryId: string; panel: PanelConfig; pid: string; captured: Record<string, string> }
  | { kind: "refused"; panel: PanelConfig; message: string; reason: string }
  | { kind: "duplicate"; panel: PanelConfig; entryId: string; message: string; outcome: PanelOutcome | null; sessionRef: string | null }
  | { kind: "over_quota"; panel: PanelConfig; entryId: string; message: string; redirect: PanelRedirect };

export const PANEL_DUPLICATE_MESSAGE = "Our records show you have already taken part in this study, so we can't let you in again. Thank you for your interest.";
export const PANEL_OVER_QUOTA_MESSAGE = "Thank you for your interest — we already have all the people we need from your panel, so we won't continue.";

export async function enterPanel(store: PanelStore, a: { surveyId: string; target: PanelTarget; targetRef: string | null; params: PanelParams; isTest: boolean }, sign: { hasher: PanelHasher | null }): Promise<PanelEntryResult> {
  const configs = (await store.panels(a.surveyId)).map((c) => PanelConfigSchema.safeParse(c)).filter((r) => r.success).map((r) => r.data!);
  const cap = capturePanelEntry(configs, a.params ?? {}, a.target);
  if (!cap.ok) return { kind: "refused", panel: cap.panel, message: cap.message, reason: cap.reason };
  if (!cap.panel) return { kind: "none", pid: cap.pid };
  const panel = cap.panel;
  const r = await store.enter({ surveyId: a.surveyId, panelKey: panel.key, pid: cap.pid, target: a.target, targetRef: a.targetRef, isTest: a.isTest, dedupe: panel.dedupe, captured: cap.captured });
  if (r.duplicate) return { kind: "duplicate", panel, entryId: r.entryId, message: PANEL_DUPLICATE_MESSAGE, outcome: r.outcome, sessionRef: r.sessionRef };
  /* quota sync: the panel's completes target met → back to the panel as over quota (tests are never sent away) */
  if (panel.completesTarget && !a.isTest && (await store.completes(a.surveyId, panel.key)) >= panel.completesTarget) {
    const redirect = await exitPanel(store, { entryId: r.entryId, outcome: "over_quota", status: "over_quota" }, sign);
    return { kind: "over_quota", panel, entryId: r.entryId, message: PANEL_OVER_QUOTA_MESSAGE, redirect: redirect! };
  }
  return { kind: "admitted", entryId: r.entryId, panel, pid: cap.pid, captured: cap.captured };
}

/** link the entry to what it became (an interview session, a group participant, a survey response) */
export async function attachPanelSession(store: PanelStore, entryId: string, sessionRef: string): Promise<void> {
  await store.update(entryId, { sessionRef: sessionRef.slice(0, 200) });
}

/**
 * The end link for an entry's outcome. The FIRST outcome recorded stands (a complete is never turned into a
 * screen-out by a later call, and a reload gives the same link). Returns null when the entry is unknown or its
 * panel is no longer configured.
 */
export async function exitPanel(store: PanelStore, a: { entryId?: string | null; sessionRef?: string | null; outcome: PanelOutcome; status?: string | null }, sign: { hasher: PanelHasher | null }, nowIso: string = new Date().toISOString()): Promise<(PanelRedirect & { entryId: string; pid: string; panel: string }) | null> {
  const entry = a.entryId ? await store.entry(a.entryId) : a.sessionRef ? await store.entryBySession(a.sessionRef) : null;
  if (!entry) return null;
  const config = (await store.panels(entry.surveyId)).map((c) => PanelConfigSchema.safeParse(c)).find((r) => r.success && r.data.key === entry.panelKey)?.data;
  if (!config) return null;
  const outcome = entry.outcome ?? a.outcome;
  const secret = config.signing.algorithm !== "none" ? await store.secret(entry.surveyId, config.key).catch(() => null) : null;
  const r = panelRedirect(config, outcome, { pid: entry.pid || null, captured: entry.captured }, { secret, hasher: sign.hasher });
  if (!entry.outcome) await store.update(entry.id, { outcome, status: a.status ?? outcome, endedAt: nowIso, signed: r.signed, ...(r.url ? { redirectedAt: nowIso } : {}) });
  return { ...r, entryId: entry.id, pid: entry.pid, panel: config.label };
}
