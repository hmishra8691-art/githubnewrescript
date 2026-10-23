import type { PanelConfig, PanelOutcome, PanelTarget } from "@rescript/schema";
import type { PanelEntryRec, PanelStore } from "./service.js";

/**
 * THE PANEL STORES (2026-10-22, G3).
 *
 *   supabasePanelStore   migration 0072 (service role): entries through `rescript_panel_enter` (atomic dedupe), the
 *                        panels from the project's SAVED definition (the draft the Studio saved, else the current
 *                        version) — so a corrected end link applies to links already in the field — and the secret
 *                        from `panel_secrets`, opened by the caller's `openPanelSecret` (the envelope; this package holds no key)
 *   memoryPanelStore     tests and the Studio's sandbox; the same rules
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any;
export interface PanelSupabase { from(table: string): Q; rpc(fn: string, args: Record<string, unknown>): Q }

const toEntry = (r: Record<string, unknown>): PanelEntryRec => ({ id: String(r.id), surveyId: String(r.survey_id), panelKey: String(r.panel_key), pid: String(r.pid ?? ""), target: r.target as PanelTarget, targetRef: (r.target_ref as string) ?? null, sessionRef: (r.session_ref as string) ?? null, isTest: !!r.is_test, captured: (r.captured as Record<string, string>) ?? {}, outcome: (r.outcome as PanelOutcome) ?? null, status: (r.status as string) ?? null, signed: (r.signed as boolean) ?? null, startedAt: String(r.started_at), endedAt: (r.ended_at as string) ?? null });
const ENTRY_COLS = "id, survey_id, panel_key, pid, target, target_ref, session_ref, is_test, captured, outcome, status, signed, started_at, ended_at";

export function supabasePanelStore(db: PanelSupabase, opts: { openPanelSecret: (sealed: string, aad: string) => string | null; panelsOverride?: (surveyId: string) => Promise<PanelConfig[] | null> }): PanelStore {
  const cache = new Map<string, { at: number; panels: PanelConfig[] }>();
  return {
    kind: "db",
    async panels(surveyId) {
      const hit = cache.get(surveyId);
      if (hit && Date.now() - hit.at < 5_000) return hit.panels;
      const o = opts.panelsOverride ? await opts.panelsOverride(surveyId) : null;
      let panels: PanelConfig[] = o ?? [];
      if (!o) {
        const { data: s } = await db.from("surveys").select("draft_definition, current_version_id").eq("id", surveyId).maybeSingle();
        let def = (s?.draft_definition ?? null) as { panels?: PanelConfig[] } | null;
        if (!def?.panels && s?.current_version_id) { const { data: v } = await db.from("survey_versions").select("definition").eq("id", s.current_version_id).maybeSingle(); def = (v?.definition ?? null) as typeof def; }
        panels = Array.isArray(def?.panels) ? def!.panels! : [];
      }
      cache.set(surveyId, { at: Date.now(), panels });
      return panels;
    },
    async secret(surveyId, panelKey) {
      const { data } = await db.from("panel_secrets").select("secret_sealed").eq("survey_id", surveyId).eq("panel_key", panelKey).maybeSingle();
      if (!data?.secret_sealed) return null;
      try { return opts.openPanelSecret(String(data.secret_sealed), `panel|${surveyId}|${panelKey}`); } catch { return null; }
    },
    async enter(a) {
      const { data, error } = await db.rpc("rescript_panel_enter", { p_survey: a.surveyId, p_panel: a.panelKey, p_pid: a.pid, p_target: a.target, p_target_ref: a.targetRef, p_is_test: a.isTest, p_dedupe: a.dedupe, p_captured: a.captured });
      if (error) throw new Error(`panel entry: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as { entry_id: string; duplicate: boolean; outcome: PanelOutcome | null; session_ref: string | null };
      return { entryId: row.entry_id, duplicate: !!row.duplicate, outcome: row.outcome ?? null, sessionRef: row.session_ref ?? null };
    },
    async entry(id) { const { data } = await db.from("panel_entries").select(ENTRY_COLS).eq("id", id).maybeSingle(); return data ? toEntry(data) : null; },
    async entryBySession(sessionRef) { const { data } = await db.from("panel_entries").select(ENTRY_COLS).eq("session_ref", sessionRef).order("started_at", { ascending: false }).limit(1); return data?.[0] ? toEntry(data[0]) : null; },
    async update(id, p) {
      const patch: Record<string, unknown> = {};
      if (p.sessionRef !== undefined) patch.session_ref = p.sessionRef; if (p.outcome !== undefined) patch.outcome = p.outcome; if (p.status !== undefined) patch.status = p.status;
      if (p.signed !== undefined) patch.signed = p.signed; if (p.endedAt !== undefined) patch.ended_at = p.endedAt; if (p.redirectedAt !== undefined) patch.redirected_at = p.redirectedAt;
      let q = db.from("panel_entries").update(patch).eq("id", id);
      /* the first outcome stands, in the database too */
      if (p.outcome !== undefined) q = q.is("outcome", null);
      const { error } = await q;
      if (error) throw new Error(`panel entry: ${error.message}`);
    },
    async completes(surveyId, panelKey) { const { count } = await db.from("panel_entries").select("id", { count: "exact", head: true }).eq("survey_id", surveyId).eq("panel_key", panelKey).eq("outcome", "complete").eq("is_test", false); return count ?? 0; },
    async list(surveyId, limit = 5000) { const { data } = await db.from("panel_entries").select(ENTRY_COLS).eq("survey_id", surveyId).order("started_at", { ascending: false }).limit(limit); return (data ?? []).map(toEntry); },
  };
}

export interface MemoryPanelState { panels: Record<string, PanelConfig[]>; secrets: Record<string, string>; entries: PanelEntryRec[] }
export const emptyPanelState = (): MemoryPanelState => ({ panels: {}, secrets: {}, entries: [] });

let seq = 0;
export function memoryPanelStore(state: MemoryPanelState = emptyPanelState(), opts: { onChange?: () => void; now?: () => string; newId?: () => string } = {}): PanelStore & { state: MemoryPanelState } {
  const changed = () => opts.onChange?.();
  const now = opts.now ?? (() => new Date().toISOString());
  const newId = opts.newId ?? (() => `pe-${Date.now().toString(36)}-${(++seq).toString(36)}`);
  return {
    kind: "memory",
    state,
    async panels(surveyId) { return JSON.parse(JSON.stringify(state.panels[surveyId] ?? [])); },
    async secret(surveyId, panelKey) { return state.secrets[`${surveyId}|${panelKey}`] ?? null; },
    async enter(a) {
      if (a.dedupe && a.pid) {
        const hit = state.entries.find((e) => e.surveyId === a.surveyId && e.panelKey === a.panelKey && e.pid === a.pid && e.isTest === a.isTest);
        if (hit) return { entryId: hit.id, duplicate: true, outcome: hit.outcome, sessionRef: hit.sessionRef };
      }
      const e: PanelEntryRec = { id: newId(), surveyId: a.surveyId, panelKey: a.panelKey, pid: a.pid, target: a.target, targetRef: a.targetRef, sessionRef: null, isTest: a.isTest, captured: { ...a.captured }, outcome: null, status: null, signed: null, startedAt: now(), endedAt: null };
      state.entries.push(e); changed();
      return { entryId: e.id, duplicate: false, outcome: null, sessionRef: null };
    },
    async entry(id) { const e = state.entries.find((x) => x.id === id); return e ? { ...e } : null; },
    async entryBySession(ref) { const e = [...state.entries].reverse().find((x) => x.sessionRef === ref); return e ? { ...e } : null; },
    async update(id, p) {
      const e = state.entries.find((x) => x.id === id);
      if (!e) return;
      if (p.outcome !== undefined && e.outcome) { const { outcome: _o, status: _s, endedAt: _e, signed: _g, ...rest } = p; Object.assign(e, rest); }
      else { const { redirectedAt: _r, ...rest } = p; Object.assign(e, rest); }
      changed();
    },
    async completes(surveyId, panelKey) { return state.entries.filter((e) => e.surveyId === surveyId && e.panelKey === panelKey && e.outcome === "complete" && !e.isTest).length; },
    async list(surveyId, limit = 5000) { return state.entries.filter((e) => e.surveyId === surveyId).slice(-limit).reverse(); },
  };
}
