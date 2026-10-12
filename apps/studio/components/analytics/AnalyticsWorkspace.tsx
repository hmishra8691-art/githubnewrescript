"use client";
import { Warnings } from "./Warnings";
import React from "react";
import type { AnalysisDefinition, ChartSpec, DatasetSpec, ReportTheme, VariableMeta } from "@rescript/analytics";
import { ANALYSIS_KINDS } from "@rescript/analytics";
import { AxApi, type Row, type RunResult, timeAgo } from "./api";
import { AnalysisBuilder } from "./AnalysisBuilder";
import { AnalysesRail } from "./AnalysesRail";
import { ResultView } from "./ResultView";
import { SegmentsPanel } from "./SegmentsPanel";
import { ThemesPanel } from "./ThemesPanel";
import { ReportsPanel, ExportDialog } from "./ReportsPanel";
import { SharingPanel } from "./SharingPanel";
import { Chart, ResultTableView } from "./charts/Chart";
import { PlanWorkspace } from "./PlanWorkspace";

/**
 * THE DATA ANALYTICS WORKSPACE (§2, §40). Survey and dataset selectors on top;
 * Home · Analysis plan · Analysis · Charts · Tables · Segments · Filters ·
 * Reports · Themes · Exports · Sharing beneath. Everything it shows is fetched
 * from the analytics API; the browser never holds response rows.
 *
 * ANALYSIS PLAN is where the plan written in Intelligent mode
 * (research.analysisPlan) is reviewed, edited and applied to these outputs —
 * see PlanWorkspace. Home is context-aware: with a plan it leads with the
 * plan's state; without one it offers to create an analysis by hand.
 */

export type WsTab = "home" | "plan" | "analysis" | "charts" | "tables" | "segments" | "filters" | "reports" | "themes" | "exports" | "sharing";
const TABS: { key: WsTab; label: string }[] = [
  { key: "home", label: "Home" }, { key: "plan", label: "Analysis plan" }, { key: "analysis", label: "Analysis" }, { key: "charts", label: "Charts" }, { key: "tables", label: "Tables" }, { key: "segments", label: "Segments" }, { key: "filters", label: "Filters" },
  { key: "reports", label: "Reports" }, { key: "themes", label: "Themes" }, { key: "exports", label: "Exports" }, { key: "sharing", label: "Sharing" },
];

export interface WorkspaceProps { surveyId: string; surveyTitle: string; canEdit: boolean; /** may change the survey definition — the plan lives there */ canEditPlan?: boolean; canPublish: boolean; canExport: boolean; initialTab?: WsTab }

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
  const [notice, setNotice] = React.useState<string | null>(null);
  const [builder, setBuilder] = React.useState<{ key: number; initial?: { analysis?: Row; definition?: AnalysisDefinition; kind?: AnalysisDefinition["kind"] } }>({ key: 0 });
  const [pendingAdd, setPendingAdd] = React.useState<{ analysis: Row; spec: ChartSpec } | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const dataset: DatasetSpec = React.useMemo(() => ({ environment: env, dataset: quality }), [env, quality]);
  /* the plan in brief, for Home: whether there is one, and where it stands — the Analysis plan tab holds the whole of it */
  const [planBrief, setPlanBrief] = React.useState<PlanBrief | null | undefined>(undefined);
  const loadPlanBrief = React.useCallback(async () => {
    try {
      const d = await api.plan({ environment: env, dataset: quality });
      const plan = d.plan;
      if (!plan || (!plan.crosstabs.length && !plan.tests.length)) { setPlanBrief(null); return; }
      setPlanBrief({ items: d.items.length, crosstabs: plan.crosstabs.length, tests: plan.tests.length, hypotheses: d.overview?.hypotheses ?? 0, invalid: d.overview?.invalid ?? 0, stale: d.overview?.stale ?? 0, configured: d.overview?.configured ?? 0, charts: d.overview?.charts ?? 0,
        apply: d.apply ? { status: d.apply.status, startedAt: d.apply.startedAt, current: d.apply.current } : null, run: d.run ? { computedAt: d.run.computedAt, n: d.run.n } : null, dataChanged: d.dataChangedSinceApply, report: !!d.report, dashboard: !!d.dashboard });
    } catch { setPlanBrief(null); }
  }, [api, env, quality]);
  React.useEffect(() => { void loadPlanBrief(); }, [loadPlanBrief]);

  const refresh = React.useCallback(async () => {
    try {
      const [h, a, c, s, t, r, sh] = await Promise.all([api.home(), api.list("analyses"), api.list("charts"), api.list("segments"), api.list("themes"), api.list("reports"), api.list("shares")]);
      setHome(h); setAnalyses(a.items); setCharts(c.items); setSegments(s.items); setThemes(t.items); setReports(r.items); setShares(sh.items); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [api]);
  React.useEffect(() => { void refresh(); api.variables().then((v) => { setVars(v.variables); setCounts(v.counts); setSurveyVersion(v.surveyVersion); }).catch((e) => setError((e as Error).message)); }, [api, refresh]);

  /* leaving an analysis with unsaved changes asks first — the builder is remounted, so the draft would be gone */
  const guard = () => !dirty || window.confirm("This analysis has unsaved changes. Leave without saving?");
  const openBuilder = (initial?: { analysis?: Row; definition?: AnalysisDefinition; kind?: AnalysisDefinition["kind"] }) => { if (tab === "analysis" && !guard()) return; setDirty(false); setBuilder({ key: Date.now(), initial }); setTab("analysis"); };
  const currentAnalysisId = (builder.initial?.analysis?.id as string | undefined) ?? null;

  /* the rail's verbs — every one is a request to the API, then a refresh, so the list is always the server's */
  const railFromPlan = async () => {
    try {
      const r = await api.create("analyses/from-plan", { environment: env, dataset: quality }) as unknown as { created: Row[]; skipped: number; planned: number };
      await refresh();
      setNotice(r.created.length ? `${r.created.length} planned analys${r.created.length === 1 ? "is" : "es"} created${r.skipped ? ` (${r.skipped} already existed)` : ""}.` : `All ${r.planned} planned analyses already exist.`);
      if (r.created[0]) openBuilder({ analysis: r.created[0] });
    } catch (e) { setError((e as Error).message); }
  };
  const railDuplicate = async (a: Row) => { try { const r = await api.create(`analyses/${a.id}/duplicate`, {}); await refresh(); openBuilder({ analysis: r.item }); } catch (e) { setError((e as Error).message); } };
  const railRename = async (a: Row, name: string) => { try { await api.update("analyses", a.id, { name }); await refresh(); if (a.id === currentAnalysisId) setBuilder((b) => ({ ...b, initial: { ...b.initial, analysis: { ...a, name } } })); } catch (e) { setError((e as Error).message); } };
  const railMove = async (a: Row, dir: -1 | 1) => {
    const ids = analyses.map((x) => x.id as string); const i = ids.indexOf(a.id); const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setAnalyses(ids.map((id) => analyses.find((x) => x.id === id)!));
    try { await api.create("analyses/reorder", { ids }); await refresh(); } catch (e) { setError((e as Error).message); }
  };
  const railDelete = async (a: Row) => { if (!window.confirm(`Delete “${a.name}”? Charts saved from it go with it.`)) return; try { await api.remove("analyses", a.id); await refresh(); if (a.id === currentAnalysisId) { setDirty(false); setBuilder({ key: Date.now() }); } } catch (e) { setError((e as Error).message); } };
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
      <div className="ax-ws-tabs">{TABS.map((t) => <button key={t.key} className={`ax-wstab ${tab === t.key ? "on" : ""}`} onClick={() => { if (t.key === tab) return; if (tab === "analysis" && !guard()) return; setTab(t.key); }} data-testid={`ax-tab-${t.key}`}>{t.label}{t.key === "analysis" && dirty ? <span className="ax-dirty" title="Unsaved changes" /> : null}</button>)}</div>
      {error && <div className="ax-error" style={{ margin: "6px 0" }}>{error}</div>}
      {notice && <div className="ax-notice" style={{ margin: "6px 0" }} data-testid="ax-notice" onClick={() => setNotice(null)}>{notice}</div>}
      {tab === "home" && <Kpis env={env} counts={counts} vars={vars.length} analyses={analyses.length} charts={charts.length} reports={reports} shares={shares.length} />}
      <div className="ax-ws-body">
        {tab === "home" && <Home home={home} analyses={analyses} onOpen={(a) => openBuilder({ analysis: a })} onNew={(kind) => openBuilder(kind ? { kind } : undefined)} onTab={setTab} canEdit={p.canEdit} api={api} refresh={refresh} plan={planBrief} surveyId={p.surveyId} />}
        {tab === "plan" && <PlanWorkspace api={api} surveyId={p.surveyId} surveyTitle={p.surveyTitle} dataset={dataset} variables={vars} counts={counts} analyses={analyses} canEdit={p.canEdit} canEditPlan={!!p.canEditPlan} canExport={p.canExport}
          onOpenAnalysis={(a) => openBuilder({ analysis: a })} onTab={(t) => setTab(t)} onApplied={() => { void refresh(); void loadPlanBrief(); }} />}
        {tab === "analysis" && (
          <div className="ax-analysis-layout" data-testid="ax-analysis-layout">
            <AnalysesRail analyses={analyses} currentId={currentAnalysisId} dirty={dirty} canEdit={p.canEdit} onNew={() => openBuilder()} onFromPlan={railFromPlan} onOpen={(a) => { if (a.id !== currentAnalysisId) openBuilder({ analysis: a }); }} onDuplicate={railDuplicate} onRename={railRename} onMove={railMove} onDelete={railDelete} />
            <div className="ax-analysis-main">
              <AnalysisBuilder key={builder.key} api={api} variables={vars} counts={counts} segments={segments} themes={themes} dataset={dataset} initial={builder.initial} canEdit={p.canEdit} canExport={p.canExport} onDirty={setDirty}
                onSaved={(a) => { void refresh(); setBuilder((b) => ({ ...b, initial: { ...(b.initial ?? {}), analysis: a } })); }} onChartSaved={() => void refresh()} onAddToReport={(a, spec) => { setPendingAdd({ analysis: a, spec }); setTab("reports"); }} />
            </div>
          </div>
        )}
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

/**
 * THE METRIC BAND.
 *
 * Every figure here is already in the workspace's state: `counts` comes back
 * with the variable dictionary, and the rest are the lengths of the lists the
 * tabs are rendered from. So the band adds no request, no calculation and
 * nothing the product does not already know — which is the whole constraint.
 * Numbers a research platform would like to show here and this one does not
 * yet compute (completion rate, median duration, a period-over-period trend)
 * are deliberately absent rather than invented.
 */
function Kpis({ env, counts, vars, analyses, charts, reports, shares }: {
  env: DatasetSpec["environment"]; counts: Record<string, number>; vars: number;
  analyses: number; charts: number; reports: Row[]; shares: number;
}) {
  const loading = !Object.keys(counts).length;
  /* ALL is the two environments together — the same sum the dataset selector
     describes, not a third stored number */
  const responses = env === "ALL" ? (counts.LIVE ?? 0) + (counts.TEST ?? 0) : counts[env] ?? 0;
  const envLabel = env === "ALL" ? "all responses" : env === "LIVE" ? "production" : "test";
  const published = reports.filter((r) => r.published_version).length;
  const n = (v: number) => v.toLocaleString();
  const tiles: { label: string; value: string; sub?: string; testid: string }[] = [
    { label: "Responses", value: loading ? "—" : n(responses), sub: `${envLabel} · complete`, testid: "ax-kpi-responses" },
    { label: "Variables", value: loading ? "—" : n(vars), sub: "in the dictionary", testid: "ax-kpi-variables" },
    { label: "Analyses", value: n(analyses), sub: "saved definitions", testid: "ax-kpi-analyses" },
    { label: "Charts", value: n(charts), sub: "saved styling", testid: "ax-kpi-charts" },
    { label: "Reports", value: n(reports.length), sub: published ? `${published} published` : "none published", testid: "ax-kpi-reports" },
    { label: "Shares", value: n(shares), sub: shares ? "live links" : "nothing shared", testid: "ax-kpi-shares" },
  ];
  return (
    <div className="ax-kpis" data-testid="ax-kpis">
      {tiles.map((t) => (
        <div key={t.label} className="metric" data-testid={t.testid}>
          <span className="metric-v">{t.value}</span>
          <span className="metric-l">{t.label}</span>
          {t.sub && <span className="ax-kpi-sub">{t.sub}</span>}
        </div>
      ))}
    </div>
  );
}

/** A section with nothing in it is still a designed section — see `.ax-empty`. */
function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="ax-empty"><div className="ax-empty-t">{title}</div><div className="ax-empty-d">{detail}</div></div>;
}

/** the plan in brief — what Home needs to say where it stands */
interface PlanBrief { items: number; crosstabs: number; tests: number; hypotheses: number; invalid: number; stale: number; configured: number; charts: number; apply: { status: string; startedAt: string; current: boolean } | null; run: { computedAt: string; n: number } | null; dataChanged: boolean; report: boolean; dashboard: boolean }

/**
 * THE PLAN ON HOME — context-aware, not a second plan view. With a plan, the
 * card says whether it is applied, changed since, waiting for data, or has
 * analyses needing attention, and opens the Analysis plan tab; without one,
 * it points at Intelligent mode. "Create analysis" stays beside it either
 * way: a hand-built analysis is still the other way to start.
 */
function PlanCard({ plan, onTab, surveyId }: { plan: PlanBrief | null | undefined; onTab: (t: WsTab) => void; surveyId: string }) {
  if (plan === undefined) return <div className="card ax-plan-card" data-testid="ax-plan-card" data-state="loading"><div className="card-title">Analysis plan</div><div className="muted" style={{ fontSize: 13 }}>Loading…</div></div>;
  if (plan === null) return (
    <div className="card ax-plan-card" data-testid="ax-plan-card" data-state="none">
      <div className="card-title">Analysis plan <span className="badge neutral">none yet</span></div>
      <div className="muted" style={{ fontSize: 13 }}>No analysis plan for this survey. Plan it in Intelligent mode — the crosstabs and tests the research design implies — and apply it here; or start an analysis by hand below.</div>
      <div className="card-actions" style={{ marginTop: 8 }}><a className="btn small primary" href={`/studio/${surveyId}?mode=intelligent`} data-testid="ax-plan-intelligent">Plan it in Intelligent mode</a><button className="btn small" onClick={() => onTab("plan")} data-testid="ax-plan-open">Open the plan workspace</button></div>
    </div>
  );
  const a = plan.apply;
  const state = !a ? { key: "not_applied", label: "Not applied", tone: "warning", text: `Saved with ${plan.crosstabs} crosstab${plan.crosstabs === 1 ? "" : "s"} and ${plan.tests} test${plan.tests === 1 ? "" : "s"} — apply it to create the analyses, charts and dashboard.` }
    : a.status === "failed" ? { key: "failed", label: "Apply failed", tone: "error", text: "The last apply did not finish. Open the plan to see why and try again." }
    : !a.current ? { key: "changed", label: "Changed since applied", tone: "warning", text: `Edited after it was applied ${timeAgo(a.startedAt)} — apply it again to update the outputs.` }
    : a.status === "no_data" ? { key: "no_data", label: "Waiting for data", tone: "neutral", text: "Applied; its outputs fill when complete responses exist in this dataset." }
    : plan.dataChanged ? { key: "data_changed", label: "New data since", tone: "warning", text: `More completes have arrived since the run of ${plan.run ? timeAgo(plan.run.computedAt) : "the apply"} — apply again to refresh.` }
    : a.status === "partial" ? { key: "partial", label: "Some analyses failed", tone: "warning", text: `Applied ${timeAgo(a.startedAt)}; ${plan.invalid} planned analys${plan.invalid === 1 ? "is" : "es"} cannot run — open the plan to fix them.` }
    : { key: "applied", label: "Applied", tone: "success", text: `Applied ${timeAgo(a.startedAt)}${plan.run ? ` · ${plan.run.n} completes` : ""} · ${plan.charts} chart${plan.charts === 1 ? "" : "s"}${plan.report ? " · findings report" : ""}${plan.dashboard ? " · dashboard" : ""}.` };
  return (
    <div className="card ax-plan-card" data-testid="ax-plan-card" data-state={state.key}>
      <div className="card-title">Analysis plan <span className={`badge ${state.tone}`} data-testid="ax-plan-state">{state.label}</span><span className="grow" /><span className="muted" style={{ fontSize: 12.5 }}>{plan.items} planned · {plan.hypotheses} hypothes{plan.hypotheses === 1 ? "is" : "es"}{plan.invalid ? ` · ${plan.invalid} need attention` : ""}{plan.stale ? ` · ${plan.stale} changed` : ""}</span></div>
      <div className="muted" style={{ fontSize: 13 }}>{state.text}</div>
      <div className="card-actions" style={{ marginTop: 8, flexWrap: "wrap" }}>
        <button className="btn small primary" onClick={() => onTab("plan")} data-testid="ax-plan-open">Open the plan</button>
        <a className="btn small" href={`/studio/${surveyId}?mode=intelligent`} data-testid="ax-plan-intelligent">Intelligent mode</a>
      </div>
    </div>
  );
}

function Home({ home, analyses, onOpen, onNew, onTab, canEdit, api, refresh, plan, surveyId }: { home: { analyses: Row[]; charts: Row[]; reports: Row[]; shares: Row[] } | null; analyses: Row[]; onOpen: (a: Row) => void; onNew: (kind?: AnalysisDefinition["kind"]) => void; onTab: (t: WsTab) => void; canEdit: boolean; api: AxApi; refresh: () => Promise<void>; plan: PlanBrief | null | undefined; surveyId: string }) {
  return (
    <div className="ax-home" data-testid="ax-home">
      <PlanCard plan={plan} onTab={onTab} surveyId={surveyId} />
      {/* the two ways to start work, side by side — neither is wide enough to
          deserve a row of its own once the page uses the whole display */}
      <div className="ax-home-start">
        <div className="ax-home-col">
          <div className="ax-sect"><h3>Start something</h3></div>
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
        </div>
        <div className="ax-home-col">
          <div className="ax-sect"><h3>Analysis types</h3><span className="ax-sect-note">{ANALYSIS_KINDS.length} available — each opens the builder on that kind</span></div>
          <div className="ax-kind-mini">{ANALYSIS_KINDS.map((k) => <button key={k.kind} className="ax-chip" onClick={() => onNew(k.kind)} title={k.description}>{k.label}</button>)}</div>
        </div>
      </div>

      <div className="ax-home-split">
        <div className="ax-home-col">
          <div className="ax-sect"><h3>Recent analyses</h3><span className="ax-sect-note">{analyses.length} saved in this survey</span></div>
          {(home?.analyses ?? []).length > 0 && (
            <div className="ax-home-list">
              {(home?.analyses ?? []).map((a) => <div key={a.id} className="card selectable" onClick={() => onOpen(a)} data-testid="ax-home-analysis"><div className="card-title">{a.name}</div><div className="muted" style={{ fontSize: 13 }}>{ANALYSIS_KINDS.find((k) => k.kind === a.kind)?.label ?? a.kind} · v{a.version} · updated {timeAgo(a.updated_at)}</div>{canEdit && <div className="card-actions" style={{ marginTop: 6 }}><button className="btn small danger" onClick={async (e) => { e.stopPropagation(); if (confirm(`Delete analysis “${a.name}”? Charts linked to it are removed; reports keep their published snapshots.`)) { await api.remove("analyses", a.id); await refresh(); } }}>Delete</button></div>}</div>)}
            </div>
          )}
          {home && !home.analyses.length && <Empty title="No analyses yet" detail="An analysis is a saved definition — variables, filters, weighting — recomputed against the current data every time it runs. Start one on the left." />}
          {!home && <div className="muted">Loading…</div>}
        </div>

        <div className="ax-home-col">
          <div className="ax-sect"><h3>Saved reports</h3></div>
          <div className="ax-home-list">
            {(home?.reports ?? []).map((r) => <div key={r.id} className="card selectable" onClick={() => onTab("reports")}><div className="card-title">{r.kind === "dashboard" ? "▦" : "▤"} {r.name}</div><div className="muted" style={{ fontSize: 13 }}>{r.mode} · {r.published_version ? `published v${r.published_version}` : "draft"} · updated {timeAgo(r.updated_at)}</div></div>)}
          </div>
          {home && !home.reports.length && <Empty title="No reports yet" detail="A report gathers charts and tables into a deliverable you can publish, share as a link, and export to PowerPoint or Excel." />}

          <div className="ax-sect" style={{ marginTop: 6 }}><h3>Active shares</h3></div>
          <div className="ax-home-list">
            {(home?.shares ?? []).map((s) => <div key={s.id} className="card" onClick={() => onTab("sharing")} style={{ cursor: "pointer" }}><div className="card-title">{home?.reports.find((r) => r.id === s.report_id)?.name ?? "Report"}</div><div className="muted" style={{ fontSize: 13 }}>{s.access === "link" ? "Anyone with link" : s.access === "users" ? "Specific users" : "Private"} · {s.permission} · {s.view_count} views{s.expires_at ? ` · expires ${new Date(s.expires_at).toLocaleDateString()}` : ""}</div></div>)}
          </div>
          {home && !home.shares.length && <Empty title="Nothing shared yet" detail="A published report can be given a link that carries its own expiry, password and permission — the reader needs no account." />}
        </div>
      </div>
    </div>
  );
}

function ChartsLibrary({ api, charts, analyses, themes, refresh, onOpen }: { api: AxApi; charts: Row[]; analyses: Row[]; themes: { id: string; name: string; theme: ReportTheme }[]; refresh: () => Promise<void>; onOpen: (a: Row) => void }) {
  const [results, setResults] = React.useState<Record<string, RunResult>>({});
  const [editing, setEditing] = React.useState<Row | null>(null);
  const [spec, setSpec] = React.useState<ChartSpec | null>(null);
  /*
   * Every saved chart's analysis is computed, a few at a time, and each one ends in
   * either a result or a visible failure with a retry. Before, a failed run left
   * the card on "Computing…" for ever, only the first 12 charts were ever
   * requested, and `load` depended on `results` — so each arriving result re-fired
   * the effect and re-requested every chart that had not arrived yet.
   */
  const [status, setStatus] = React.useState<Record<string, "loading" | "error">>({});
  const inFlight = React.useRef(new Set<string>());
  const done = React.useRef(new Set<string>());
  const analysesRef = React.useRef(analyses); analysesRef.current = analyses;
  const load = React.useCallback(async (analysisId: string, force = false) => {
    if (!force && (done.current.has(analysisId) || inFlight.current.has(analysisId))) return;
    const a = analysesRef.current.find((x) => x.id === analysisId); if (!a) return;
    inFlight.current.add(analysisId); setStatus((s) => ({ ...s, [analysisId]: "loading" }));
    try {
      const { result } = await api.run({ ...(a.definition as AnalysisDefinition), name: a.name });
      done.current.add(analysisId); setResults((r) => ({ ...r, [analysisId]: result }));
      setStatus((s) => { const { [analysisId]: _x, ...rest } = s; void _x; return rest; });
    } catch { setStatus((s) => ({ ...s, [analysisId]: "error" })); } finally { inFlight.current.delete(analysisId); }
  }, [api]);
  React.useEffect(() => {
    const ids = [...new Set(charts.map((c) => String(c.analysis_id)))];
    let cancelled = false; let next = 0;
    const worker = async () => { while (!cancelled && next < ids.length) { const id = ids[next++]; await load(id); } };
    void Promise.all([worker(), worker(), worker()]);
    return () => { cancelled = true; };
  }, [charts, load]);
  return (
    <div className="ax-panel" data-testid="ax-charts">
      <div className="row" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}>Saved charts</h2><span className="muted" style={{ fontSize: 13 }}>Each chart is linked to its analysis definition — the data is recomputed, the styling is yours.</span></div>
      {editing && spec && results[editing.analysis_id] && (
        <div className="card">
          <ResultView result={results[editing.analysis_id]} recommendations={results[editing.analysis_id].recommendations} advice={results[editing.analysis_id].advice} spec={spec} onSpec={setSpec} theme={themes.find((t) => t.id === spec.themeId)?.theme ?? null} themes={themes}
            actions={<><button className="btn primary small" onClick={async () => { await api.update("charts", editing.id, { spec, themeId: spec.themeId ?? null, name: spec.options.title ?? editing.name }); setEditing(null); await refresh(); }}>Save styling (v{editing.style_version + 1})</button><button className="btn small" onClick={() => setEditing(null)}>Cancel</button></>} />
        </div>
      )}
      <div className="ax-chart-grid">
        {charts.map((c) => { const r = results[c.analysis_id]; const a = analyses.find((x) => x.id === c.analysis_id); return (
          <div key={c.id} className="card ax-chart-card" data-testid="ax-chart-card">
            <div className="card-title">{c.name}<span className="grow" /><span className="muted" style={{ fontSize: 12.5 }}>style v{c.style_version}</span></div>
            <div className="muted" style={{ fontSize: 13 }}>{a?.name ?? "analysis removed"} · {(c.spec as ChartSpec).type}</div>
            {r ? <Chart result={r} spec={c.spec as ChartSpec} theme={themes.find((t) => t.id === c.theme_id)?.theme ?? null} compact /> : !a ? <div className="muted" style={{ padding: 20 }}>The linked analysis no longer exists.</div> : status[c.analysis_id] === "error" ? <div className="ax-warn" style={{ padding: 12 }} data-testid="ax-chart-failed">This chart could not be computed. <button className="btn small" onClick={() => void load(c.analysis_id, true)}>Try again</button></div> : <div className="muted" style={{ padding: 20 }}>Computing…</div>}
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
  const [tableError, setTableError] = React.useState<string | null>(null);
  const selDef = React.useMemo(() => JSON.stringify(analyses.find((x) => x.id === sel)?.definition ?? null) + (analyses.find((x) => x.id === sel)?.name ?? ""), [analyses, sel]);
  /* keyed on the selected analysis' own definition, not on the `analyses` array (a new array on every refresh re-ran every table); a late answer for a previous selection is dropped; a failure is shown, and the previous table is not left under the new title */
  React.useEffect(() => {
    if (!sel) return; const a = analyses.find((x) => x.id === sel); if (!a) return;
    let cancelled = false; setBusy(true); setTableError(null); setRes(null);
    api.run({ ...(a.definition as AnalysisDefinition), name: a.name })
      .then(({ result }) => { if (cancelled) return; setRes(result); setTableId(result.tables[0]?.id ?? ""); })
      .catch((e: Error) => { if (!cancelled) setTableError(e.message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [sel, selDef, api]); // eslint-disable-line react-hooks/exhaustive-deps
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
      {tableError && !busy && <div className="ax-warn" data-testid="ax-table-failed">{tableError}</div>}
      {view && (
        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}><div className="card-title">{view.title}</div><span className="grow" /><span className="muted" style={{ fontSize: 13 }}>click a column header to sort</span></div>
          <div className="ax-table-wrap"><table className="ax-table" data-testid="ax-builder-table"><thead><tr>{view.columns.map((c) => <th key={c.key} className={c.type && c.type !== "text" ? "num sortable" : "sortable"} onClick={() => setSort(sort?.key === c.key ? { key: c.key, dir: sort.dir === 1 ? -1 : 1 } : { key: c.key, dir: -1 })}>{c.label}{sort?.key === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}</th>)}</tr></thead>
            <tbody>{view.rows.map((r, i) => <tr key={i}>{view.columns.map((c) => { const v = r[c.key]; const sig = r[`${c.key}__sig`]; const ct = (r.__format as string | undefined) ?? c.type; return <td key={c.key} className={typeof v === "number" ? "num" : ""}>{v == null ? "" : typeof v === "number" ? (ct === "pct" ? `${v.toFixed(c.decimals ?? 1)}%` : ct === "count" ? Math.round(v).toLocaleString() : v.toLocaleString("en-US", { maximumFractionDigits: c.decimals ?? 2 })) : String(v)}{sig ? <sup className="ax-sig">{String(sig)}</sup> : null}</td>; })}</tr>)}</tbody></table></div>
          <div className="ax-table-notes">{view.base ? `Base: n = ${view.base.n}${view.base.weightedN != null && view.base.weightedN !== view.base.n ? ` · weighted n = ${view.base.weightedN}` : ""}` : ""}{view.notes?.map((n, i) => <div key={i}>{n}</div>)}<Warnings items={res?.warnings ?? []} testId="ax-table-warnings" /></div>
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
