"use client";
import React from "react";
import type { AnalysisDefinition, ChartSpec, DatasetSpec, ReportTheme, VariableMeta } from "@rescript/analytics";
import { ANALYSIS_KINDS } from "@rescript/analytics";
import { AxApi, type Row, type RunResult, timeAgo } from "./api";
import { AnalysisBuilder } from "./AnalysisBuilder";
import { ResultView } from "./ResultView";
import { SegmentsPanel } from "./SegmentsPanel";
import { ThemesPanel } from "./ThemesPanel";
import { ReportsPanel, ExportDialog } from "./ReportsPanel";
import { SharingPanel } from "./SharingPanel";
import { Chart, ResultTableView } from "./charts/Chart";

/**
 * THE DATA ANALYTICS WORKSPACE (§2, §40). Survey and dataset selectors on top;
 * Home · Analysis · Charts · Tables · Segments · Filters · Reports · Themes ·
 * Exports · Sharing beneath. Everything it shows is fetched from the analytics
 * API; the browser never holds response rows.
 */

export type WsTab = "home" | "analysis" | "charts" | "tables" | "segments" | "filters" | "reports" | "themes" | "exports" | "sharing";
const TABS: { key: WsTab; label: string }[] = [
  { key: "home", label: "Home" }, { key: "analysis", label: "Analysis" }, { key: "charts", label: "Charts" }, { key: "tables", label: "Tables" }, { key: "segments", label: "Segments" }, { key: "filters", label: "Filters" },
  { key: "reports", label: "Reports" }, { key: "themes", label: "Themes" }, { key: "exports", label: "Exports" }, { key: "sharing", label: "Sharing" },
];

export interface WorkspaceProps { surveyId: string; surveyTitle: string; canEdit: boolean; canPublish: boolean; canExport: boolean; initialTab?: WsTab }

export function AnalyticsWorkspace(p: WorkspaceProps) {
  const api = React.useMemo(() => new AxApi(p.surveyId), [p.surveyId]);
  const [tab, setTab] = React.useState<WsTab>(p.initialTab ?? "home");
  const [env, setEnv] = React.useState<DatasetSpec["environment"]>("LIVE");
  const [quality, setQuality] = React.useState<DatasetSpec["dataset"]>("all");
  const [vars, setVars] = React.useState<VariableMeta[]>([]);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
  const [surveyVersion, setSurveyVersion] = React.useState<string | null>(null);
  const [home, setHome] = React.useState<{ analyses: Row[]; charts: Row[]; reports: Row[]; shares: Row[] } | null>(null);
  const [analyses, setAnalyses] = React.useState<Row[]>([]);
  const [charts, setCharts] = React.useState<Row[]>([]);
  const [segments, setSegments] = React.useState<Row[]>([]);
  const [themes, setThemes] = React.useState<Row[]>([]);
  const [reports, setReports] = React.useState<Row[]>([]);
  const [shares, setShares] = React.useState<Row[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [builder, setBuilder] = React.useState<{ key: number; initial?: { analysis?: Row; definition?: AnalysisDefinition; kind?: AnalysisDefinition["kind"] } }>({ key: 0 });
  const [pendingAdd, setPendingAdd] = React.useState<{ analysis: Row; spec: ChartSpec } | null>(null);
  const dataset: DatasetSpec = React.useMemo(() => ({ environment: env, dataset: quality }), [env, quality]);

  const refresh = React.useCallback(async () => {
    try {
      const [h, a, c, s, t, r, sh] = await Promise.all([api.home(), api.list("analyses"), api.list("charts"), api.list("segments"), api.list("themes"), api.list("reports"), api.list("shares")]);
      setHome(h); setAnalyses(a.items); setCharts(c.items); setSegments(s.items); setThemes(t.items); setReports(r.items); setShares(sh.items); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [api]);
  React.useEffect(() => { void refresh(); api.variables().then((v) => { setVars(v.variables); setCounts(v.counts); setSurveyVersion(v.surveyVersion); }).catch((e) => setError((e as Error).message)); }, [api, refresh]);

  const openBuilder = (initial?: { analysis?: Row; definition?: AnalysisDefinition; kind?: AnalysisDefinition["kind"] }) => { setBuilder({ key: Date.now(), initial }); setTab("analysis"); };
  const themeList = themes.map((t) => ({ id: t.id as string, name: t.name as string, theme: t.theme as ReportTheme }));

  return (
    <div className="ax-ws" data-testid="ax-workspace">
      <div className="ax-ws-head">
        <div>
          <div className="ax-ws-title">Data Analytics</div>
          <div className="muted" style={{ fontSize: 13 }}>{p.surveyTitle}{surveyVersion ? ` · survey v${surveyVersion}` : ""}</div>
        </div>
        <label className="ax-field" style={{ minWidth: 220 }}><span>Dataset</span><select className="select" value={env} onChange={(e) => setEnv(e.target.value as DatasetSpec["environment"])} data-testid="ax-dataset"><option value="LIVE">Production responses ({counts.LIVE ?? "…"})</option><option value="TEST">Test responses ({counts.TEST ?? "…"})</option><option value="ALL">All responses</option></select></label>
        <label className="ax-field"><span>Quality</span><select className="select" value={quality} onChange={(e) => setQuality(e.target.value as DatasetSpec["dataset"])}><option value="all">All complete responses</option><option value="clean">Clean only (quality engine)</option></select></label>
        <span className="grow" />
        <div className="muted" style={{ fontSize: 12.5, textAlign: "right" }}>Analyses run server-side on stored responses.<br />Only results reach this page.</div>
      </div>
      <div className="ax-ws-tabs">{TABS.map((t) => <button key={t.key} className={`ax-wstab ${tab === t.key ? "on" : ""}`} onClick={() => setTab(t.key)} data-testid={`ax-tab-${t.key}`}>{t.label}</button>)}</div>
      {error && <div className="ax-error" style={{ margin: "6px 0" }}>{error}</div>}
      <div className="ax-ws-body">
        {tab === "home" && <Home home={home} analyses={analyses} onOpen={(a) => openBuilder({ analysis: a })} onNew={(kind) => openBuilder(kind ? { kind } : undefined)} onTab={setTab} canEdit={p.canEdit} api={api} refresh={refresh} />}
        {tab === "analysis" && <AnalysisBuilder key={builder.key} api={api} variables={vars} counts={counts} segments={segments} themes={themes} dataset={dataset} initial={builder.initial} onSaved={() => void refresh()} onChartSaved={() => void refresh()} onAddToReport={(a, spec) => { setPendingAdd({ analysis: a, spec }); setTab("reports"); }} />}
        {tab === "charts" && <ChartsLibrary api={api} charts={charts} analyses={analyses} themes={themeList} refresh={refresh} onOpen={(a) => openBuilder({ analysis: a })} />}
        {tab === "tables" && <TablesLibrary api={api} analyses={analyses} onOpen={(a) => openBuilder({ analysis: a })} onNew={() => openBuilder({ kind: "crosstab" })} />}
        {tab === "segments" && <SegmentsPanel api={api} variables={vars} items={segments} kind="segment" onChange={() => void refresh()} />}
        {tab === "filters" && <SegmentsPanel api={api} variables={vars} items={segments} kind="filter" onChange={() => void refresh()} />}
        {tab === "reports" && <ReportsPanel api={api} analyses={analyses} themes={themes} items={reports} onChange={() => void refresh()} pendingAdd={pendingAdd} clearPending={() => setPendingAdd(null)} surveyTitle={p.surveyTitle} />}
        {tab === "themes" && <ThemesPanel api={api} items={themes} onChange={() => void refresh()} />}
        {tab === "exports" && <ExportsPanel api={api} reports={reports} analyses={analyses} themes={themes} />}
        {tab === "sharing" && <SharingPanel api={api} shares={shares} reports={reports} onChange={() => void refresh()} />}
      </div>
    </div>
  );
}

function Home({ home, analyses, onOpen, onNew, onTab, canEdit, api, refresh }: { home: { analyses: Row[]; charts: Row[]; reports: Row[]; shares: Row[] } | null; analyses: Row[]; onOpen: (a: Row) => void; onNew: (kind?: AnalysisDefinition["kind"]) => void; onTab: (t: WsTab) => void; canEdit: boolean; api: AxApi; refresh: () => Promise<void> }) {
  return (
    <div className="ax-home" data-testid="ax-home">
      <div className="ax-home-col">
        <h3>Recent analyses</h3>
        {(home?.analyses ?? []).map((a) => <div key={a.id} className="card selectable" onClick={() => onOpen(a)} data-testid="ax-home-analysis"><div className="card-title">{a.name}</div><div className="muted" style={{ fontSize: 13 }}>{ANALYSIS_KINDS.find((k) => k.kind === a.kind)?.label ?? a.kind} · v{a.version} · updated {timeAgo(a.updated_at)}</div>{canEdit && <div className="card-actions" style={{ marginTop: 6 }}><button className="btn small danger" onClick={async (e) => { e.stopPropagation(); if (confirm(`Delete analysis “${a.name}”? Charts linked to it are removed; reports keep their published snapshots.`)) { await api.remove("analyses", a.id); await refresh(); } }}>Delete</button></div>}</div>)}
        {home && !home.analyses.length && <div className="muted">No analyses yet — start with a quick action.</div>}
        {!home && <div className="muted">Loading…</div>}
      </div>
      <div className="ax-home-col">
        <h3>Saved reports</h3>
        {(home?.reports ?? []).map((r) => <div key={r.id} className="card selectable" onClick={() => onTab("reports")}><div className="card-title">{r.kind === "dashboard" ? "▦" : "▤"} {r.name}</div><div className="muted" style={{ fontSize: 13 }}>{r.mode} · {r.published_version ? `published v${r.published_version}` : "draft"} · updated {timeAgo(r.updated_at)}</div></div>)}
        {home && !home.reports.length && <div className="muted">No reports yet.</div>}
        <h3 style={{ marginTop: 14 }}>Active shares</h3>
        {(home?.shares ?? []).map((s) => <div key={s.id} className="card" onClick={() => onTab("sharing")} style={{ cursor: "pointer" }}><div className="card-title">{home?.reports.find((r) => r.id === s.report_id)?.name ?? "Report"}</div><div className="muted" style={{ fontSize: 13 }}>{s.access === "link" ? "Anyone with link" : s.access === "users" ? "Specific users" : "Private"} · {s.permission} · {s.view_count} views{s.expires_at ? ` · expires ${new Date(s.expires_at).toLocaleDateString()}` : ""}</div></div>)}
        {home && !home.shares.length && <div className="muted">Nothing shared yet.</div>}
      </div>
      <div className="ax-home-col">
        <h3>Quick actions</h3>
        <div className="ax-quick">
          <button className="btn primary" onClick={() => onNew()} data-testid="ax-quick-analysis">Create analysis</button>
          <button className="btn" onClick={() => onNew("crosstab")} data-testid="ax-quick-crosstab">Create crosstab</button>
          <button className="btn" onClick={() => onNew("descriptive")}>Create chart</button>
          <button className="btn" onClick={() => onNew("nps")}>NPS / CSAT</button>
          <button className="btn" onClick={() => onTab("reports")} data-testid="ax-quick-report">Create report</button>
          <button className="btn" onClick={() => onTab("reports")}>Open dashboard</button>
          <button className="btn" onClick={() => onTab("segments")}>Define segments</button>
          <button className="btn" onClick={() => onTab("themes")}>Report themes</button>
        </div>
        <h3 style={{ marginTop: 14 }}>Analysis types</h3>
        <div className="ax-kind-mini">{ANALYSIS_KINDS.map((k) => <button key={k.kind} className="ax-chip" onClick={() => onNew(k.kind)} title={k.description}>{k.label}</button>)}</div>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>{analyses.length} saved analyses in this survey.</div>
      </div>
    </div>
  );
}

function ChartsLibrary({ api, charts, analyses, themes, refresh, onOpen }: { api: AxApi; charts: Row[]; analyses: Row[]; themes: { id: string; name: string; theme: ReportTheme }[]; refresh: () => Promise<void>; onOpen: (a: Row) => void }) {
  const [results, setResults] = React.useState<Record<string, RunResult>>({});
  const [editing, setEditing] = React.useState<Row | null>(null);
  const [spec, setSpec] = React.useState<ChartSpec | null>(null);
  const load = React.useCallback(async (analysisId: string) => { if (results[analysisId]) return; const a = analyses.find((x) => x.id === analysisId); if (!a) return; try { const { result } = await api.run({ ...(a.definition as AnalysisDefinition), name: a.name }); setResults((r) => ({ ...r, [analysisId]: result })); } catch { /* shown as missing */ } }, [api, analyses, results]);
  React.useEffect(() => { for (const c of charts.slice(0, 12)) void load(c.analysis_id); }, [charts, load]);
  return (
    <div className="ax-panel" data-testid="ax-charts">
      <div className="row" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}>Saved charts</h2><span className="muted" style={{ fontSize: 13 }}>Each chart is linked to its analysis definition — the data is recomputed, the styling is yours.</span></div>
      {editing && spec && results[editing.analysis_id] && (
        <div className="card">
          <ResultView result={results[editing.analysis_id]} recommendations={results[editing.analysis_id].recommendations} spec={spec} onSpec={setSpec} theme={themes.find((t) => t.id === spec.themeId)?.theme ?? null} themes={themes}
            actions={<><button className="btn primary small" onClick={async () => { await api.update("charts", editing.id, { spec, themeId: spec.themeId ?? null, name: spec.options.title ?? editing.name }); setEditing(null); await refresh(); }}>Save styling (v{editing.style_version + 1})</button><button className="btn small" onClick={() => setEditing(null)}>Cancel</button></>} />
        </div>
      )}
      <div className="ax-chart-grid">
        {charts.map((c) => { const r = results[c.analysis_id]; const a = analyses.find((x) => x.id === c.analysis_id); return (
          <div key={c.id} className="card ax-chart-card" data-testid="ax-chart-card">
            <div className="card-title">{c.name}<span className="grow" /><span className="muted" style={{ fontSize: 12.5 }}>style v{c.style_version}</span></div>
            <div className="muted" style={{ fontSize: 13 }}>{a?.name ?? "analysis removed"} · {(c.spec as ChartSpec).type}</div>
            {r ? <Chart result={r} spec={c.spec as ChartSpec} theme={themes.find((t) => t.id === c.theme_id)?.theme ?? null} compact /> : <div className="muted" style={{ padding: 20 }}>{a ? "Computing…" : "The linked analysis no longer exists."}</div>}
            <div className="card-actions" style={{ marginTop: 6 }}><button className="btn small" onClick={() => { setEditing(c); setSpec(c.spec as ChartSpec); }} disabled={!r}>Customize</button>{a && <button className="btn small" onClick={() => onOpen(a)}>Open analysis</button>}<button className="btn small" onClick={() => api.export({ format: "pptx", analysisId: c.analysis_id, chart: c.spec, themeId: c.theme_id })}>PPT</button><button className="btn small danger" onClick={async () => { if (confirm("Delete this saved chart?")) { await api.remove("charts", c.id); await refresh(); } }}>Delete</button></div>
          </div>); })}
        {!charts.length && <div className="muted">No saved charts yet. Run an analysis and click “Save chart”.</div>}
      </div>
    </div>
  );
}

function TablesLibrary({ api, analyses, onOpen, onNew }: { api: AxApi; analyses: Row[]; onOpen: (a: Row) => void; onNew: () => void }) {
  const [sel, setSel] = React.useState<string>("");
  const [res, setRes] = React.useState<RunResult | null>(null);
  const [tableId, setTableId] = React.useState<string>("");
  const [sort, setSort] = React.useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [filterText, setFilterText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const tableAnalyses = analyses.filter((a) => ["crosstab", "descriptive", "topbox", "segmentation", "test", "nps", "csat", "ranking", "allocation", "turf", "brand", "conjoint", "maxdiff", "quality", "weighting"].includes(a.kind));
  React.useEffect(() => { if (!sel) return; const a = analyses.find((x) => x.id === sel); if (!a) return; setBusy(true); api.run({ ...(a.definition as AnalysisDefinition), name: a.name }).then(({ result }) => { setRes(result); setTableId(result.tables[0]?.id ?? ""); }).finally(() => setBusy(false)); }, [sel, analyses, api]);
  const table = res?.tables.find((t) => t.id === tableId) ?? res?.tables[0];
  const view = React.useMemo(() => {
    if (!table) return table;
    let rows = table.rows;
    if (filterText) rows = rows.filter((r) => Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(filterText.toLowerCase())));
    if (sort) rows = [...rows].sort((a, b) => { const x = a[sort.key], y = b[sort.key]; return (typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""))) * sort.dir; });
    return { ...table, rows };
  }, [table, filterText, sort]);
  return (
    <div className="ax-panel" data-testid="ax-tables">
      <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Table builder</h2>
        <select className="select" value={sel} onChange={(e) => setSel(e.target.value)} data-testid="ax-table-analysis"><option value="">Choose a saved analysis…</option>{tableAnalyses.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.kind})</option>)}</select>
        {res && res.tables.length > 1 && <select className="select" value={tableId} onChange={(e) => setTableId(e.target.value)}>{res.tables.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select>}
        {table && <input className="input" placeholder="Filter rows…" value={filterText} onChange={(e) => setFilterText(e.target.value)} style={{ maxWidth: 200 }} />}
        <span className="grow" />
        <button className="btn small" onClick={onNew}>New crosstab</button>
        {sel && <button className="btn small" onClick={() => onOpen(analyses.find((a) => a.id === sel)!)}>Edit definition</button>}
        {sel && <button className="btn small" onClick={() => api.export({ format: "xlsx", analysisId: sel })}>Excel</button>}
      </div>
      {busy && <div className="muted">Computing…</div>}
      {view && (
        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}><div className="card-title">{view.title}</div><span className="grow" /><span className="muted" style={{ fontSize: 13 }}>click a column header to sort</span></div>
          <div className="ax-table-wrap"><table className="ax-table" data-testid="ax-builder-table"><thead><tr>{view.columns.map((c) => <th key={c.key} className={c.type && c.type !== "text" ? "num sortable" : "sortable"} onClick={() => setSort(sort?.key === c.key ? { key: c.key, dir: sort.dir === 1 ? -1 : 1 } : { key: c.key, dir: -1 })}>{c.label}{sort?.key === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}</th>)}</tr></thead>
            <tbody>{view.rows.map((r, i) => <tr key={i}>{view.columns.map((c) => { const v = r[c.key]; const sig = r[`${c.key}__sig`]; const ct = (r.__format as string | undefined) ?? c.type; return <td key={c.key} className={typeof v === "number" ? "num" : ""}>{v == null ? "" : typeof v === "number" ? (ct === "pct" ? `${v.toFixed(c.decimals ?? 1)}%` : ct === "count" ? Math.round(v).toLocaleString() : v.toLocaleString("en-US", { maximumFractionDigits: c.decimals ?? 2 })) : String(v)}{sig ? <sup className="ax-sig">{String(sig)}</sup> : null}</td>; })}</tr>)}</tbody></table></div>
          <div className="ax-table-notes">{view.base ? `Base: n = ${view.base.n}${view.base.weightedN != null && view.base.weightedN !== view.base.n ? ` · weighted n = ${view.base.weightedN}` : ""}` : ""}{view.notes?.map((n, i) => <div key={i}>{n}</div>)}{res?.warnings.map((w, i) => <div key={`w${i}`}>⚠ {w}</div>)}</div>
        </div>
      )}
      {!sel && <div className="muted">Pick a saved analysis to build a frequency, crosstab, banner, means or significance table from it. Tables can be added to reports and exported to PowerPoint and Excel.</div>}
      {sel && !busy && res && !res.tables.length && <ResultTableView />}
    </div>
  );
}

function ExportsPanel({ api, reports, analyses, themes }: { api: AxApi; reports: Row[]; analyses: Row[]; themes: Row[] }) {
  const [target, setTarget] = React.useState<{ reportId?: string; analysisId?: string } | null>(null);
  return (
    <div className="ax-panel" data-testid="ax-exports">
      <div className="row" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}>Exports</h2><span className="muted" style={{ fontSize: 13 }}>Presentation-ready PowerPoint with native charts and tables, or structured Excel workbooks — themed with your report branding.</span></div>
      <div className="ax-home">
        <div className="ax-home-col"><h3>Reports</h3>{reports.map((r) => <div key={r.id} className="card"><div className="card-title">{r.name}</div><div className="muted" style={{ fontSize: 13 }}>{r.published_version ? `published v${r.published_version}` : "draft only"}</div><div className="card-actions" style={{ marginTop: 6 }}><button className="btn primary small" onClick={() => setTarget({ reportId: r.id })}>Export…</button></div></div>)}{!reports.length && <div className="muted">No reports.</div>}</div>
        <div className="ax-home-col"><h3>Analyses</h3>{analyses.map((a) => <div key={a.id} className="card"><div className="card-title">{a.name}</div><div className="muted" style={{ fontSize: 13 }}>{a.kind} · v{a.version}</div><div className="card-actions" style={{ marginTop: 6 }}><button className="btn small" onClick={() => setTarget({ analysisId: a.id })}>Export…</button></div></div>)}{!analyses.length && <div className="muted">No saved analyses.</div>}</div>
      </div>
      {target && <ExportDialog api={api} reportId={target.reportId} analysisId={target.analysisId} themes={themes} onClose={() => setTarget(null)} />}
    </div>
  );
}
