"use client";
import { TableDialog } from "../TableViews";
import React from "react";
import type { AnalysisDefinition, ChartSpec, DatasetSpec, ReportTheme, VariableMeta } from "@rescript/analytics";
import type { AxApi, CataloguePayload, Row } from "../api";
import { Explorer } from "./Explorer";
import { Workspace, specFor, type FocusView, type WorkspaceView } from "./Workspace";
import { Properties } from "./Properties";
import { useResults } from "./useResults";
import { useSelection } from "../selection";
import { useDetail } from "../detail";
import { DEFAULT_PANES, PANES_KEY, clampPane, explorerEntries, readPanes, selectionSummary, type ExplorerCategory, type Panes, type Selection } from "@/lib/analyticsArchitect";

/**
 * ANALYTICS ARCHITECT MODE (2026-11-06) — a research environment over the analytics engine.
 *
 *   ┌──────────────────┬──────────────────────────────────┬──────────────────┐
 *   │ ANALYSIS EXPLORER│ LIVE WORKSPACE  combined · focus │ PROPERTIES       │
 *   └──────────────────┴──────────────────────────────────┴──────────────────┘
 *
 * The Explorer is the catalogue (packages/analytics catalogue.ts) — every hypothesis, crosstab, test, model,
 * correlation, chart, theme, report and dashboard, labelled in research terms. The Workspace shows what is
 * ticked together (Combined) or one entry in full (Focus). Properties says what the entry in focus answers,
 * why it exists, which charts fit it, how it is configured, and — folded away — its technical identity.
 *
 * Same engine, same stored analyses, same permissions as Classic: this is a view, not a second system. Panes
 * resize by their dividers; widths are remembered per browser (the Programming Studio's Architect does the
 * same).
 */
export interface FocusRequest { analysisId: string | null; planned: string | null; nonce: number }

export function ArchitectAnalytics(p: {
  api: AxApi; dataset: DatasetSpec; analyses: Row[]; charts: Row[]; variables: VariableMeta[]; themes: { id: string; name: string; theme: ReportTheme }[];
  /** the Classic lists are read again after a save here */
  onChanged: () => void;
  canEdit: boolean; canExport: boolean; onOpenInBuilder: (analysis: Row) => void;
  /** bumps when the Classic side changed something (a save, a delete) so the catalogue is read again */
  refreshKey: number;
  /** the entry in focus, for Ask */
  onFocusChange?: (focus: { key: string; label: string; analysisId: string | null; advice?: { type: string; reason: string; denominator?: string; notes?: string[] } | null } | null) => void;
  /** a drill-down from elsewhere (Overview): open this analysis in Focus once the catalogue is loaded */
  focusRequest?: FocusRequest | null;
}) {
  const [payload, setPayload] = React.useState<CataloguePayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [category, setCategory] = React.useState<ExplorerCategory>("all");
  const [filter, setFilter] = React.useState("");
  /* the ticks are the workspace-wide selection (M6); the focus is this pane's own */
  const basket = useSelection();
  const { level } = useDetail();
  const [focusedKey, setFocusedKey] = React.useState<string | null>(null);
  const selection = React.useMemo<Selection>(() => ({ keys: basket.items.map((i) => i.key), focus: focusedKey }), [basket.items, focusedKey]);
  const [view, setView] = React.useState<WorkspaceView>("focus");
  const [focusView, setFocusView] = React.useState<FocusView>("combined");
  /* the All view's sections that are on screen — what gets computed */
  const [visible, setVisible] = React.useState<Set<string>>(() => new Set());
  const onVisible = React.useCallback((id: string, on: boolean) => setVisible((v) => { if (v.has(id) === on) return v; const n = new Set(v); if (on) n.add(id); else n.delete(id); return n; }), []);
  const [spec, setSpec] = React.useState<ChartSpec | null>(null);
  const [panes, setPanes] = React.useState<Panes>(DEFAULT_PANES);
  React.useEffect(() => { try { setPanes(readPanes(window.localStorage.getItem(PANES_KEY))); } catch { /* fine */ } }, []);

  const load = React.useCallback(async () => {
    try { const d = await p.api.catalogue({ environment: p.dataset.environment, dataset: p.dataset.dataset }); setPayload(d); setError(null); setFocusedKey((f) => (f && d.catalogue.all.some((e) => e.key === f) ? f : null)); }
    catch (e) { setError((e as Error).message); }
  }, [p.api, p.dataset.environment, p.dataset.dataset]);
  React.useEffect(() => { void load(); }, [load, p.refreshKey]);

  const catalogue = payload?.catalogue ?? null;
  const entries = React.useMemo(() => (catalogue ? explorerEntries(catalogue, category, filter) : []), [catalogue, category, filter]);
  const focused = catalogue && selection.focus ? catalogue.all.find((e) => e.key === selection.focus) ?? null : null;

  /* what to compute: the entry in focus, and the All view's sections on screen */
  const wanted = React.useMemo(() => {
    const ids = new Set<string>(view === "all" ? visible : []);
    if (focused?.analysisId) ids.add(focused.analysisId);
    return [...ids];
  }, [visible, focused, view]);
  const results = useResults(p.api, p.analyses, wanted);
  React.useEffect(() => { results.invalidate(); }, [p.dataset.environment, p.dataset.dataset]); // eslint-disable-line react-hooks/exhaustive-deps

  const focus = (key: string | null) => {
    setFocusedKey(key);
    if (key) { setView("focus"); const e = catalogue?.all.find((x) => x.key === key); setSpec(e ? specFor(e, p.charts, e.analysisId ? results.results[e.analysisId] : undefined) : null); }
  };
  /* the focused entry's spec follows its result once it arrives (the recommendation is only known then) */
  const focusedResult = focused?.analysisId ? results.results[focused.analysisId] : undefined;
  React.useEffect(() => { p.onFocusChange?.(focused ? { key: focused.key, label: focused.label, analysisId: focused.analysisId ?? null, advice: focusedResult?.advice ? { type: focusedResult.advice.type, reason: focusedResult.advice.reason, denominator: focusedResult.advice.denominator, notes: focusedResult.advice.notes } : null } : null); }, [focused, focusedResult]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (focused && focusedResult && !spec) setSpec(specFor(focused, p.charts, focusedResult)); }, [focused, focusedResult, spec, p.charts]);

  const served = React.useRef(0);
  React.useEffect(() => {
    const r = p.focusRequest; if (!r || !catalogue || served.current === r.nonce) return;
    const e = catalogue.all.find((x) => (r.analysisId && x.analysisId === r.analysisId && x.category !== "charts") || (!r.analysisId && r.planned && x.planned === r.planned));
    served.current = r.nonce;
    if (e) focus(e.key);
  }, [p.focusRequest, catalogue]); // eslint-disable-line react-hooks/exhaustive-deps

  const savePanes = (n: Panes) => { setPanes(n); try { window.localStorage.setItem(PANES_KEY, JSON.stringify(n)); } catch { /* fine */ } };
  const startDrag = (which: keyof Panes) => (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX; const start = panes[which];
    const onMove = (ev: PointerEvent) => { const dx = ev.clientX - startX; setPanes((c) => ({ ...c, [which]: clampPane(which === "explorer" ? start + dx : start - dx) })); };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); setPanes((c) => { savePanes(c); return c; }); };
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  };

  /* a table opened large (from Combined, the Table view or Properties) — one dialog for the shell */
  const [tableOpen, setTableOpen] = React.useState<{ analysisId: string; tableId?: string } | null>(null);
  const createTable = async (rows: string[], columns: string[], name: string) => {
    const d = { name, kind: columns.length ? "crosstab" : "descriptive", dataset: p.dataset, variables: [...rows, ...columns], rows, columns, measure: "pct_col", options: { significance: true } } as unknown as AnalysisDefinition;
    await p.api.create("analyses", { name, definition: d });
    p.onChanged();
  };
  const openInBuilder = (analysisId: string) => { const a = p.analyses.find((x) => x.id === analysisId); if (a) p.onOpenInBuilder(a); };
  /* a configuration saved from Properties: the builder's route, then the result again and the catalogue again */
  const saveDefinition = async (analysisId: string, d: AnalysisDefinition) => {
    await p.api.update("analyses", analysisId, { name: d.name, definition: d });
    results.invalidate(analysisId);
    setSpec(null);
    p.onChanged();
  };

  return (
    <div className="ar axa" data-testid="axa-view" style={{ gridTemplateColumns: `min(${panes.explorer}px, 24vw) 6px minmax(0, 1fr) 6px min(${panes.properties}px, 26vw)` }}>
      <aside className="ar-map axa-pane">
        <div className="ar-pane-head"><span className="ar-pane-title">Analysis Explorer</span><span className="ar-pane-meta">{catalogue ? `${catalogue.all.length} entries` : "…"}</span></div>
        <Explorer catalogue={catalogue} category={category} onCategory={setCategory} filter={filter} onFilter={setFilter} entries={entries} selection={selection}
          onToggle={(k) => { const e = catalogue?.all.find((x) => x.key === k); basket.toggle(k, e?.label ?? k); }} onFocus={focus}
          onSelectAll={() => basket.addMany(entries.map((e) => ({ key: e.key, label: e.label })))} onSelectNone={() => basket.clear()} />
      </aside>
      <div className="ar-divider" onPointerDown={startDrag("explorer")} role="separator" aria-orientation="vertical" data-testid="axa-divider-explorer" />
      <main className="ar-work axa-pane">
        <div className="ar-pane-head">
          <span className="ar-pane-title">Workspace</span>
          <div className="axa-seg" role="tablist" aria-label="Workspace view">
            <button role="tab" aria-selected={view === "focus"} className={`axa-seg-btn ${view === "focus" ? "on" : ""}`} onClick={() => setView("focus")} data-testid="axa-view-focus">Focus</button>
            <button role="tab" aria-selected={view === "all"} className={`axa-seg-btn ${view === "all" ? "on" : ""}`} onClick={() => setView("all")} data-testid="axa-view-all">All</button>
          </div>
          {view === "focus" && (
            <div className="axa-seg" role="tablist" aria-label="Focus view">
              {(["combined", "table", "chart", "details"] as const).filter((v) => level !== "simple" || v !== "details").map((v) => <button key={v} role="tab" aria-selected={focusView === v} className={`axa-seg-btn ${focusView === v ? "on" : ""}`} onClick={() => setFocusView(v)} data-testid={`axa-focus-${v}`}>{v[0].toUpperCase() + v.slice(1)}</button>)}
            </div>
          )}
          <span className="axa-summary" data-testid="axa-summary">{catalogue ? selectionSummary(catalogue, selection) : ""}</span>
          <span className="grow" />
          {catalogue?.objective && <span className="axa-objective" title={catalogue.objective}>Objective: {catalogue.objective}</span>}
        </div>
        {error && <div className="ax-error" style={{ margin: 8 }}>{error}</div>}
        <div className="ar-work-body">
          <Workspace api={p.api} nonce={`${p.dataset.environment}:${p.dataset.dataset}:${p.refreshKey}`} catalogue={catalogue} charts={p.charts} selection={selection} view={view} focusView={focusView} shown={entries} results={results} retry={results.retry} themes={p.themes}
            onFocus={focus} onOpenInBuilder={openInBuilder} canEdit={p.canEdit} spec={spec} onSpec={setSpec} onVisible={onVisible} onExpandTable={(analysisId, tableId) => setTableOpen({ analysisId, ...(tableId ? { tableId } : {}) })} />
        </div>
      </main>
      <div className="ar-divider" onPointerDown={startDrag("properties")} role="separator" aria-orientation="vertical" data-testid="axa-divider-properties" />
      <aside className="ar-inspector axa-pane">
        <div className="ar-pane-head"><span className="ar-pane-title">Properties</span></div>
        <div className="ar-inspector-body">
          <Properties onOpenTable={focused?.analysisId && focusedResult ? (tableId) => setTableOpen({ analysisId: focused.analysisId!, ...(tableId ? { tableId } : {}) }) : undefined} onCreateTable={p.canEdit ? createTable : undefined} entry={focused} result={focusedResult} analysis={focused?.analysisId ? p.analyses.find((a) => a.id === focused.analysisId) : undefined} spec={spec} onSpec={setSpec} canEdit={p.canEdit} onOpenInBuilder={openInBuilder} variables={p.variables} onSaveDefinition={saveDefinition} api={p.api} nonce={`${p.dataset.environment}:${p.dataset.dataset}:${p.refreshKey}`} />
        </div>
      </aside>
      {tableOpen && results.results[tableOpen.analysisId] && (
        <TableDialog title={catalogue?.all.find((e) => e.analysisId === tableOpen.analysisId)?.label ?? "Table"} result={results.results[tableOpen.analysisId]} initialTable={tableOpen.tableId} onClose={() => setTableOpen(null)}
          actions={p.canEdit ? <button className="btn small" onClick={() => { const id = tableOpen.analysisId; setTableOpen(null); openInBuilder(id); }}>Edit in builder</button> : undefined} />
      )}
    </div>
  );
}
