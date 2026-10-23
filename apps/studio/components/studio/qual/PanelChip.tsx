"use client";
import React from "react";
import { PANEL_OUTCOME_LABELS } from "@rescript/engine";
import type { PanelOutcome } from "@rescript/schema";
import { useStudio } from "../store";

/**
 * PANEL IDS IN THE LIVE VIEW (2026-10-22, G3): which panel a participant came from, their panel id and the outcome
 * sent back to the panel — beside each AI interview in Research Tools → Qualitative → AI interviews. Read from the
 * study's panel entries (`/api/surveys/[id]/panels`, the project's responses.read), refreshed every 6 seconds.
 */
export interface PanelEntryView { panel: string; pid: string; outcome: string | null; signed: boolean | null }

export function usePanelEntries(): Map<string, PanelEntryView> {
  const s = useStudio();
  const [map, setMap] = React.useState<Map<string, PanelEntryView>>(new Map());
  React.useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/surveys/${s.surveyDbId}/panels`, { cache: "no-store" });
        if (!r.ok) return;
        const b = (await r.json()) as { entries?: { session: string | null; panel: string; pid: string; outcome: string | null; signed: boolean | null }[] };
        const m = new Map<string, PanelEntryView>();
        for (const e of b.entries ?? []) if (e.session) m.set(e.session, { panel: e.panel, pid: e.pid, outcome: e.outcome, signed: e.signed });
        if (live) setMap(m);
      } catch { /* no panels */ }
    };
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 6000);
    return () => { live = false; clearInterval(t); };
  }, [s.surveyDbId]);
  return map;
}

/** the entry for a session id (the list carries its first 12 characters) */
export function entryFor(map: Map<string, PanelEntryView>, sessionId: string): PanelEntryView | undefined { return map.get(sessionId.slice(0, 12)); }

export function PanelChip({ e }: { e: PanelEntryView | undefined }) {
  if (!e) return null;
  return <div className="ql-muted" style={{ fontSize: 11 }} data-testid="ai-panel" data-panel={e.panel} data-pid={e.pid} data-outcome={e.outcome ?? ""}>{e.panel} · <span className="mono">{e.pid}</span>{e.outcome ? ` · ${PANEL_OUTCOME_LABELS[e.outcome as PanelOutcome] ?? e.outcome}${e.signed ? " (signed)" : ""}` : ""}</div>;
}
