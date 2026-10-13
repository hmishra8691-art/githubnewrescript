"use client";
import React from "react";
import type { AnalysisDefinition, ChartSpec, ChartType, DatasetSpec, VariableMeta } from "@rescript/analytics";
import { ANALYSIS_METHODS, type AnalysisMethod, type PlannedCrosstab, type PlannedTest } from "@rescript/schema";
import { AxApi, type ApplyResponse, type PlanPayload, type Row, type RunResult, timeAgo } from "./api";
import { Chart, ResultTableView } from "./charts/Chart";
import { Icon } from "../ui/Icon";

/**
 * THE ANALYSIS PLAN WORKSPACE — Results → Data Analytics → Analysis plan.
 *
 * The plan is written in Intelligent mode and kept in the survey definition;
 * this is where it is reviewed, edited and APPLIED to the Results outputs.
 * Everything shown is the server's `GET plan`: the plan against the
 * dictionary, the saved analyses, the charts, the latest run and apply, the
 * plan's own report and dashboard. Every edit is an analysis action sent to
 * `PUT plan` (the engine's own vocabulary, saved to the draft definition the
 * way the Studio saves it); "Apply analysis plan" is `POST plan/apply`.
 * Nothing here computes a result: previews and charts come from `POST run`,
 * on the server, like every other chart in the workspace.
 */

type Section = "overview" | "hypotheses" | "crosstabs" | "tests" | "variables" | "charts" | "insights" | "reports" | "dashboards";
const SECTIONS: { key: Section; label: string }[] = [
  { key: "overview", label: "Overview" }, { key: "hypotheses", label: "Hypotheses" }, { key: "crosstabs", label: "Cross-tabs" }, { key: "tests", label: "Tests & models" },
  { key: "variables", label: "Variables" }, { key: "charts", label: "Charts" }, { key: "insights", label: "Themes & insights" }, { key: "reports", label: "Reports" }, { key: "dashboards", label: "Dashboards" },
];

type Item = PlanPayload["items"][number];
type Variable = PlanPayload["variables"][number];
const words = (m: string) => m.replace(/_/g, " ");
const STATE_WORD: Record<Item["state"], string> = { planned: "Planned", invalid: "Needs attention", configured: "Configured", stale: "Changed — apply to update", refined: "Refined in Analytics" };
const STATE_TONE: Record<Item["state"], string> = { planned: "neutral", invalid: "error", configured: "success", stale: "warning", refined: "" };
const VERDICT_WORD: Record<string, string> = { supported: "Supported", not_supported: "Not supported", mixed: "Mixed", inconclusive: "Inconclusive", untested: "Untested" };
const VERDICT_TONE: Record<string, string> = { supported: "success", not_supported: "error", mixed: "warning", inconclusive: "warning", untested: "neutral" };
const COVERAGE_WORD: Record<string, string> = { testable: "Testable", partly: "Measured, nothing planned", unmeasured: "Not measured", unlinked: "Nothing measures it" };
const COVERAGE_TONE: Record<string, string> = { testable: "success", partly: "warning", unmeasured: "error", unlinked: "error" };
const MEASURES: { v: PlannedCrosstab["measure"] & string; l: string }[] = [{ v: "pct_col", l: "Column %" }, { v: "pct_row", l: "Row %" }, { v: "count", l: "Counts" }, { v: "mean", l: "Means" }];

export interface PlanWorkspaceProps {
  api: AxApi;
  surveyId: string;
  surveyTitle: string;
  dataset: DatasetSpec;
  variables: VariableMeta[];
  counts: Record<string, number>;
  /** saved analyses of the survey — for the chart definitions and "open analysis" */
  analyses: Row[];
  /** may write the analytics tables (analytics.edit) */
  canEdit: boolean;
  /** may change the survey definition (survey.edit) — the plan lives there */
  canEditPlan: boolean;
  canExport: boolean;
  onOpenAnalysis: (a: Row) => void;
  onTab: (tab: "reports" | "charts" | "analysis") => void;
  /** the workspace reloads its lists after an apply */
  onApplied: () => void;
  initialSection?: Section;
}

export function PlanWorkspace(p: PlanWorkspaceProps) {
  const [data, setData] = React.useState<PlanPayload | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ tone: "ok" | "warn" | "error"; text: string; detail?: string[] } | null>(null);
  const [section, setSection] = React.useState<Section>(p.initialSection ?? "overview");
  const [query, setQuery] = React.useState("");
  const [applying, setApplying] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [editor, setEditor] = React.useState<{ kind: "crosstab" | "test"; item?: Item } | null>(null);
  const [applyResult, setApplyResult] = React.useState<ApplyResponse | null>(null);

  const load = React.useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try { setData(await p.api.plan({ environment: p.dataset.environment, dataset: p.dataset.dataset })); setError(null); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [p.api, p.dataset.environment, p.dataset.dataset]);
  React.useEffect(() => { void load(); }, [load]);

  /* every edit: one request, then the server's plan again — the list is never the browser's own */
  const edit = React.useCallback(async (actions: unknown[], what: string): Promise<boolean> => {
    if (!data) return false;
    setSaving(true);
    try {
      const r = await p.api.editPlan({ actions, baseRevision: data.definition.revision });
      const failed = r.results.filter((x) => !x.ok);
      setNotice(failed.length ? { tone: "warn", text: `${what}: ${failed.map((x) => x.error).join(" ")}` } : { tone: "ok", text: `${what} — saved to the survey (revision ${r.revision ?? "?"}).${r.warnings.length ? ` ${r.warnings.join(" ")}` : ""}` });
      await load(true);
      return !failed.length;
    } catch (e) {
      const msg = (e as Error).message;
      setNotice({ tone: "error", text: msg });
      if (/changed somewhere else/.test(msg)) await load(true);
      return false;
    } finally { setSaving(false); }
  }, [data, p.api, load]);

  const apply = async (replaceReport = false) => {
    setApplying(true); setApplyResult(null);
    try {
      const r = await p.api.applyPlan({ environment: p.dataset.environment, dataset: p.dataset.dataset, replaceReport });
      setApplyResult(r);
      /* the outcome panel carries the result; the notice only carries what else the apply had to say */
      const detail = [...(r.warnings ?? []), ...(r.report?.action === "kept_edited" ? ["The findings report was edited by hand since the last apply, so it was kept as it is — use “Regenerate from the latest run” in Reports to replace it."] : [])];
      setNotice(detail.length ? { tone: "warn", text: detail[0], detail: detail.slice(1) } : null);
      await load(true);
      p.onApplied();
    } catch (e) { setNotice({ tone: "error", text: (e as Error).message }); }
    finally { setApplying(false); }
  };

  const plan = data?.plan ?? null;
  const items = React.useMemo(() => data?.items ?? [], [data]);
  const q = query.trim().toLowerCase();
  const matches = (it: Item) => !q || it.title.toLowerCase().includes(q) || it.variables.some((v) => v.toLowerCase().includes(q)) || it.hypotheses.some((h) => h.toLowerCase() === q) || it.method.includes(q);
  const hypothesisLabels = (data?.survey.hypotheses ?? []).map((_, i) => `H${i + 1}`);
  const dataN = data ? data.counts[p.dataset.environment] ?? 0 : 0;
  const analysisRow = (it: Item): Row | undefined => (it.analysis ? p.analyses.find((a) => a.id === it.analysis!.id) : undefined);
  const openEditorFor = (id: string) => { const it = items.find((x) => x.id === id); if (it) { setEditor({ kind: it.kind, item: it }); setSection(it.kind === "crosstab" ? "crosstabs" : "tests"); } };

  if (loading && !data) return <div className="ax-panel" data-testid="ap-loading"><div className="muted">Loading the analysis plan…</div></div>;
  if (error && !data) return <div className="ax-panel"><p className="iq-error" data-testid="ap-error"><Icon name="warning" size={12} /> {error} <button className="btn small" onClick={() => void load()}>Retry</button></p></div>;
  if (!data) return null;

  /* ---------------------------------------------------------- no plan yet */
  if (!plan || (!plan.crosstabs.length && !plan.tests.length && !plan.derived.length)) {
    return (
      <div className="ax-panel ap" data-testid="ap-none">
        <div className="ax-empty" style={{ textAlign: "left" }}>
          <div className="ax-empty-t">No analysis plan yet</div>
          <div className="ax-empty-d">
            {plan ? "The plan is saved but empty." : "This survey has no analysis plan."} Plan it in Intelligent mode — the engine proposes the crosstabs and tests the research design implies, and the copilot refines it in words — or add the first crosstab or test here.
            {data.survey.hypotheses.length ? ` The research design has ${data.survey.hypotheses.length} hypothes${data.survey.hypotheses.length === 1 ? "is" : "es"} to plan for.` : " Record the objective and hypotheses first, so the plan can serve them."}
          </div>
          <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: "wrap" }}>
            <a className="btn primary" href={`/studio/${p.surveyId}?mode=intelligent`} data-testid="ap-open-intelligent"><Icon name="sparkle" size={14} /> Plan it in Intelligent mode</a>
            {p.canEditPlan && <button className="btn" onClick={() => { setEditor({ kind: "crosstab" }); }} data-testid="ap-add-first-crosstab">Add a crosstab</button>}
            {p.canEditPlan && <button className="btn" onClick={() => { setEditor({ kind: "test" }); }} data-testid="ap-add-first-test">Add a test</button>}
            <button className="btn" onClick={() => p.onTab("analysis")} data-testid="ap-create-analysis">Create an analysis by hand</button>
          </div>
        </div>
        {notice && <Notice n={notice} onClose={() => setNotice(null)} />}
        {editor && <ItemEditor kind={editor.kind} item={editor.item} variables={p.variables} plan={plan ?? { crosstabs: [], tests: [], derived: [], segments: [] }} hypothesisLabels={hypothesisLabels} saving={saving} onCancel={() => setEditor(null)}
          onSave={async (action, what) => { const ok = await edit([action], what); if (ok) setEditor(null); }} />}
      </div>
    );
  }

  /* ---------------------------------------------------------- the plan */
  const ov = data.overview!;
  const applied = data.apply;
  const status = planStatus(data);
  const planName = `${data.survey.objective ? data.survey.objective.slice(0, 80) : p.surveyTitle} — analysis plan`;
  const counts = { crosstabs: items.filter((i) => i.kind === "crosstab").length, tests: items.filter((i) => i.kind === "test").length };
  const attention = items.filter((i) => i.state === "invalid" || i.state === "stale");

  return (
    <div className="ap" data-testid="ap-workspace" data-status={status.key}>
      <div className="ap-head card">
        <div className="ap-head-main">
          <div className="ap-title-row">
            <h2 className="ap-title" data-testid="ap-name">{planName}</h2>
            <span className={`badge ${status.tone}`} data-testid="ap-status">{status.label}</span>
          </div>
          <div className="muted ap-meta" data-testid="ap-meta">
            {p.surveyTitle} · {counts.crosstabs} crosstab{counts.crosstabs === 1 ? "" : "s"}, {counts.tests} test{counts.tests === 1 ? "" : "s"}{ov.derived ? `, ${ov.derived} derived variable${ov.derived === 1 ? "" : "s"}` : ""}{ov.segments ? `, ${ov.segments} segment${ov.segments === 1 ? "" : "s"}` : ""}
            {" · "}planned by {data.planSource ?? "the researcher"}{data.planUpdatedAt ? ` · edited ${timeAgo(data.planUpdatedAt)}` : ""}
            {" · "}from the {data.definition.source === "draft" ? "draft" : `saved version${data.definition.version ? ` v${data.definition.version}` : ""}`}{data.definition.revision != null ? ` · rev ${data.definition.revision}` : ""}
          </div>
          <div className="muted ap-meta">{status.detail}</div>
        </div>
        <div className="ap-head-actions">
          {p.canEdit && <button className={`btn primary${applying ? " loading" : ""}`} disabled={applying || saving} onClick={() => void apply()} data-testid="ap-apply" title="Validate the plan, create or update its saved analyses, run them on the responses, and refresh the charts, the dashboard and the findings report">Apply analysis plan</button>}
          <button className="btn" onClick={() => void load()} disabled={loading} data-testid="ap-refresh">Refresh</button>
          <a className="btn" href={`/studio/${p.surveyId}?mode=intelligent`} data-testid="ap-intelligent"><Icon name="sparkle" size={14} /> Intelligent mode</a>
        </div>
      </div>

      {notice && <Notice n={notice} onClose={() => setNotice(null)} />}
      {applyResult?.summary && <ApplyOutcome r={applyResult} onFix={openEditorFor} onClose={() => setApplyResult(null)} />}
      {!p.canEditPlan && <p className="muted ap-meta" data-testid="ap-readonly">Your role lets you apply the plan but not change it — editing the plan is a change to the survey.</p>}

      <div className="ap-sections" role="tablist" data-testid="ap-sections">
        {SECTIONS.map((s) => <button key={s.key} role="tab" aria-selected={section === s.key} className={`ax-wstab ${section === s.key ? "on" : ""}`} onClick={() => setSection(s.key)} data-testid={`ap-section-${s.key}`}>{s.label}{s.key === "crosstabs" ? ` ${counts.crosstabs}` : s.key === "tests" ? ` ${counts.tests}` : s.key === "hypotheses" ? ` ${ov.hypotheses}` : s.key === "variables" ? ` ${ov.variables}` : ""}</button>)}
        <span className="grow" />
        {(section === "crosstabs" || section === "tests" || section === "variables" || section === "charts") && <input className="input small" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="ap-search" style={{ maxWidth: 220 }} />}
      </div>

      {section === "overview" && (
        <div className="ap-overview" data-testid="ap-overview">
          <div className="ax-kpis">
            {[
              { l: "Planned analyses", v: items.length, s: `${ov.tiers.essential} essential · ${ov.tiers.recommended} recommended · ${ov.tiers.exploratory} exploratory`, t: "ap-kpi-items" },
              { l: "Hypotheses", v: ov.hypotheses, s: `${data.hypotheses.filter((h) => h.status === "testable").length} testable`, t: "ap-kpi-hypotheses" },
              { l: "Cross-tabs", v: ov.crosstabs, s: `${items.filter((i) => i.kind === "crosstab" && i.hypotheses.length).length} serve a hypothesis`, t: "ap-kpi-crosstabs" },
              { l: "Variables", v: ov.variables, s: ov.missingVariables ? `${ov.missingVariables} missing` : "all in the survey", t: "ap-kpi-variables" },
              { l: "Configured", v: ov.configured, s: `${items.length - ov.configured - ov.invalid} not applied yet`, t: "ap-kpi-configured" },
              { l: "Charts", v: ov.charts, s: `${ov.run} with results`, t: "ap-kpi-charts" },
              { l: "Need attention", v: ov.invalid + ov.stale, s: ov.invalid ? `${ov.invalid} cannot run` : ov.stale ? `${ov.stale} to update` : "nothing", t: "ap-kpi-attention" },
            ].map((k) => <div key={k.l} className="metric" data-testid={k.t}><span className="metric-v">{k.v.toLocaleString()}</span><span className="metric-l">{k.l}</span><span className="ax-kpi-sub">{k.s}</span></div>)}
          </div>
          <div className="ap-two">
            <div className="card">
              <div className="card-title">Where the plan stands</div>
              <ul className="ap-facts" data-testid="ap-facts">
                <li><b>Saved</b> — {plan.updatedAt ? `last edited ${new Date(plan.updatedAt).toLocaleString()}` : "in the survey definition"}{data.definition.source === "draft" ? " (draft)" : " (version)"}.</li>
                <li><b>Applied</b> — {applied ? `${new Date(applied.startedAt).toLocaleString()} on ${applied.environment.toLowerCase()} data · ${applied.status}${applied.current ? "" : " · the plan has changed since"}` : data.applyAvailable ? "never" : "not recorded on this database (migration 0050)"}.</li>
                <li><b>Computed</b> — {data.run ? `${data.run.items} analyses run ${timeAgo(data.run.computedAt)} on ${data.run.n} ${data.run.environment.toLowerCase()} completes (${data.run.trigger})` : "no run yet"}{data.dataChangedSinceApply ? ` · ${dataN - (data.run?.n ?? 0)} new completes since — apply again to refresh` : ""}.</li>
                <li><b>Data</b> — {dataN.toLocaleString()} complete {p.dataset.environment === "ALL" ? "" : p.dataset.environment.toLowerCase() + " "}responses{p.dataset.dataset === "clean" ? " (clean only)" : ""}{dataN ? "" : " — outputs are configured now and fill when data arrives"}.</li>
                <li><b>Outputs</b> — {data.report ? "findings report" : "no report yet"}{data.dashboard ? ", dashboard" : ", no dashboard yet"}, {ov.charts} chart{ov.charts === 1 ? "" : "s"}.</li>
              </ul>
            </div>
            <div className="card">
              <div className="card-title">Needs attention <span className="ax-rail-count">{attention.length}</span></div>
              {!attention.length && <div className="muted" style={{ fontSize: 13 }}>Every planned analysis reads variables the survey has{ov.configured ? " and matches its saved analysis" : ""}.</div>}
              <ul className="ap-attention" data-testid="ap-attention">
                {attention.map((it) => <li key={it.id}><span className={`badge ${STATE_TONE[it.state]}`}>{STATE_WORD[it.state]}</span> <button className="ax-linkbtn" onClick={() => openEditorFor(it.id)}>{it.title}</button><div className="muted" style={{ fontSize: 12.5 }}>{it.issues[0]?.message ?? it.staleBecause ?? "the plan changed after its analysis was written"}</div></li>)}
              </ul>
              {data.hypotheses.some((h) => h.status !== "testable") && <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>{data.hypotheses.filter((h) => h.status !== "testable").map((h) => `${h.label}: ${COVERAGE_WORD[h.status].toLowerCase()}`).join(" · ")} — see Hypotheses.</div>}
            </div>
          </div>
          {ov.notShown.length > 0 && (
            <div className="card" data-testid="ap-not-shown">
              <div className="card-title">Not applied by default <span className="ax-rail-count">{ov.notShown.length}</span></div>
              <div className="muted" style={{ fontSize: 13 }}>The plan applies every essential item and then the most useful of the rest, up to a cap, so a report stays readable. These stay in the plan — open one to edit or remove it, or raise its tier to include it.</div>
              <ul className="ap-attention">
                {ov.notShown.slice(0, 12).map((n) => <li key={n.id}><span className="badge neutral">{n.tier}</span> <button className="ax-linkbtn" onClick={() => openEditorFor(n.id)}>{n.title}</button></li>)}
              </ul>
              {ov.notShown.length > 12 && <div className="muted" style={{ fontSize: 12.5 }}>…and {ov.notShown.length - 12} more (see Cross-tabs and Tests &amp; models).</div>}
            </div>
          )}
          <div className="card ap-flow" data-testid="ap-flow">
            <div className="card-title">What applying does</div>
            <ol className="ap-steps">
              <li><b>Validate</b> — every planned crosstab and test against the survey's variables and the plan review; items that cannot run are skipped and named.</li>
              <li><b>Configure</b> — one saved analysis per planned item (created once; updated in place when the plan changed; a refinement you made in Analytics is kept).</li>
              <li><b>Run</b> — on the {p.dataset.environment.toLowerCase()} completes when there are any, with the findings and hypothesis verdicts kept as a run.</li>
              <li><b>Outputs</b> — a chart per analysis, the plan's dashboard, and the findings report from the run; applying again refreshes them instead of creating a second set.</li>
            </ol>
          </div>
        </div>
      )}

      {section === "hypotheses" && (
        <div className="ap-list" data-testid="ap-hypotheses">
          {data.trace && data.trace.objective && (
            <div className="muted" style={{ fontSize: 13 }} data-testid="ap-trace-objective">
              <b>Objective</b> — {data.trace.objective}. Each hypothesis below traces to the planned items that read both of its sides, their results, and the claim the run made.
              {data.trace.gaps.length > 0 && <ul style={{ margin: "4px 0 0 18px" }} data-testid="ap-trace-gaps">{data.trace.gaps.map((g) => <li key={g}>{g}</li>)}</ul>}
            </div>
          )}
          {!data.hypotheses.length && <div className="ax-empty"><div className="ax-empty-t">No hypotheses recorded</div><div className="ax-empty-d">Record the objective and hypotheses in the research design (Intelligent → Analysis, or Survey Settings); the plan's items then say which hypothesis they serve.</div></div>}
          {data.hypotheses.map((h) => (
            <div key={h.label} className="card ap-hyp" data-testid="ap-hyp" data-status={h.status}>
              <div className="card-title"><span className="ap-hlabel mono">{h.label}</span> {h.text}<span className="grow" /><span className={`badge ${COVERAGE_TONE[h.status]}`}>{COVERAGE_WORD[h.status]}</span>{h.verdict && <span className={`badge ${VERDICT_TONE[h.verdict.verdict]}`} data-testid="ap-hyp-verdict">{VERDICT_WORD[h.verdict.verdict]}</span>}</div>
              {h.constructs.length > 0 && <div className="muted" style={{ fontSize: 13 }}>{h.constructs.map((c) => <span key={c.name} style={{ marginRight: 10 }}>{c.name} <i>({c.role})</i>: {c.measured ? c.questions.join(", ") : <b>not measured</b>}</span>)}</div>}
              <div className="ap-hyp-items">
                {h.items.length ? items.filter((i) => h.items.includes(i.id)).map((it) => <button key={it.id} className="ax-chip" onClick={() => openEditorFor(it.id)} title={it.title}>{it.kind === "crosstab" ? "⊞" : "ƒ"} {it.title}{it.run ? ` · ${it.run.significant} sig.` : ""}</button>)
                  : <span className="muted" style={{ fontSize: 13 }}>Nothing planned for it yet{p.canEditPlan ? " — add a crosstab or test and tick this hypothesis." : "."}</span>}
              </div>
              {(data.trace?.hypotheses.find((t) => t.label === h.label)?.items ?? []).filter((t) => t.findings.length).map((t) => (
                <ul key={t.id} className="ax-insights" data-testid="ap-hyp-results" style={{ margin: "4px 0" }}>{t.findings.slice(0, 2).map((f) => <li key={f.id}>{f.headline}{t.outOfDate ? <span className="muted"> · from an out-of-date analysis</span> : null}</li>)}</ul>
              ))}
              {h.verdict ? <div className="ap-verdict" data-testid="ap-hyp-reason"><b>{VERDICT_WORD[h.verdict.verdict]}</b> — {h.verdict.reason}{h.verdict.corrected ? <span className="muted"> · {h.verdict.corrected.note}</span> : null}</div>
                : <div className="muted" style={{ fontSize: 12.5 }}>Not tested yet — a verdict appears once the plan has been applied on responses.</div>}
            </div>
          ))}
        </div>
      )}

      {(section === "crosstabs" || section === "tests") && (
        <ItemsSection kind={section === "crosstabs" ? "crosstab" : "test"} items={items.filter((i) => i.kind === (section === "crosstabs" ? "crosstab" : "test")).filter(matches)} all={items} data={data} api={p.api} dataset={p.dataset} dataN={dataN}
          canEditPlan={p.canEditPlan} saving={saving} editor={editor} variables={p.variables} hypothesisLabels={hypothesisLabels} analysisRow={analysisRow} onOpenAnalysis={p.onOpenAnalysis}
          onAdd={() => setEditor({ kind: section === "crosstabs" ? "crosstab" : "test" })} onEdit={(it) => setEditor({ kind: it.kind, item: it })} onCloseEditor={() => setEditor(null)}
          onSave={async (action, what) => { const ok = await edit([action], what); if (ok) setEditor(null); }}
          onRemove={async (it) => { if (!window.confirm(`Remove “${it.title}” from the plan?${it.analysis ? " Its saved analysis stays in the Analyses rail; its chart and dashboard widget are removed at the next apply." : ""}`)) return; await edit([{ op: it.kind === "crosstab" ? "remove_crosstab" : "remove_analysis_test", id: it.id }], `Removed ${it.title}`); if (editor?.item?.id === it.id) setEditor(null); }}
          onMove={async (it, dir) => { const list = items.filter((i) => i.kind === it.kind).map((i) => i.id); const i = list.indexOf(it.id); const j = i + dir; if (i < 0 || j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; await edit([{ op: "reorder_analysis_plan", ...(it.kind === "crosstab" ? { crosstabs: list } : { tests: list }) }], "Reordered"); }} />
      )}

      {section === "variables" && <VariablesSection variables={data.variables.filter((v) => !q || v.name.toLowerCase().includes(q) || v.label.toLowerCase().includes(q) || (v.questionCode ?? "").toLowerCase().includes(q))} items={items} onItem={openEditorFor} />}

      {section === "charts" && <ChartsSection items={items.filter((i) => i.state !== "invalid").filter(matches)} api={p.api} dataN={dataN} dataset={p.dataset} analysisRow={analysisRow} onOpenAnalysis={p.onOpenAnalysis} onTab={p.onTab} canEdit={p.canEdit} onApply={() => void apply()} applying={applying} />}

      {section === "insights" && <InsightsSection data={data} items={items} onItem={openEditorFor} surveyId={p.surveyId} />}

      {section === "reports" && <OutputSection kind="report" out={data.report} items={items} data={data} canEdit={p.canEdit} canExport={p.canExport} api={p.api} applying={applying} onApply={(replace) => void apply(replace)} onTab={p.onTab} />}
      {section === "dashboards" && <OutputSection kind="dashboard" out={data.dashboard} items={items} data={data} canEdit={p.canEdit} canExport={p.canExport} api={p.api} applying={applying} onApply={(replace) => void apply(replace)} onTab={p.onTab} />}
    </div>
  );
}

/* ------------------------------------------------------------ status */

function planStatus(d: PlanPayload): { key: string; label: string; tone: string; detail: string } {
  const a = d.apply;
  const run = d.run;
  if (!a) return { key: "not_applied", label: "Saved · not applied", tone: "warning", detail: d.applyAvailable ? "The plan is saved in the survey. Apply it to create its analyses, charts and dashboard in Results." : "Applies are not recorded on this database yet (migration 0050); applying still produces the outputs." };
  if (a.status === "running") return { key: "running", label: "Applying…", tone: "neutral", detail: `Started ${timeAgo(a.startedAt)}.` };
  if (a.status === "failed") return { key: "failed", label: "Apply failed", tone: "error", detail: a.error ?? "The last apply did not finish." };
  if (!a.current) return { key: "changed", label: "Changed since applied", tone: "warning", detail: `Applied ${timeAgo(a.startedAt)}, but the plan was edited after that — apply it again to update the outputs.` };
  if (a.status === "no_data") return { key: "no_data", label: "Applied · waiting for data", tone: "neutral", detail: "The outputs are configured; nothing could be computed because there are no complete responses in this dataset yet." };
  if (d.dataChangedSinceApply) return { key: "data_changed", label: "Applied · new data since", tone: "warning", detail: `More completes have arrived since the run of ${run ? timeAgo(run.computedAt) : "the apply"} — apply again to refresh the results.` };
  if (a.status === "partial") return { key: "partial", label: "Applied · some analyses failed", tone: "warning", detail: "Some planned analyses were skipped or could not be computed — see Needs attention and the items marked below." };
  const bad = (d.overview?.invalid ?? 0) + (d.overview?.stale ?? 0);
  /* "Applied" with an item that cannot run, or whose analysis is out of date, is not the whole truth (audit P-10) */
  if (bad) return { key: "applied_attention", label: `Applied · ${bad} item${bad === 1 ? "" : "s"} need${bad === 1 ? "s" : ""} attention`, tone: "warning", detail: `Applied ${timeAgo(a.startedAt)}, but ${d.overview!.invalid ? `${d.overview!.invalid} planned item${d.overview!.invalid === 1 ? "" : "s"} cannot run` : ""}${d.overview!.invalid && d.overview!.stale ? " and " : ""}${d.overview!.stale ? `${d.overview!.stale} ${d.overview!.stale === 1 ? "has" : "have"} an out-of-date analysis` : ""} — see Needs attention.` };
  return { key: "applied", label: "Applied", tone: "success", detail: `Applied ${timeAgo(a.startedAt)}${run ? ` · ${run.items} analyses computed on ${run.n} completes` : ""}.` };
}

function Notice({ n, onClose }: { n: { tone: "ok" | "warn" | "error"; text: string; detail?: string[] }; onClose: () => void }) {
  const cls = n.tone === "ok" ? "ax-notice" : n.tone === "warn" ? "ax-warnings" : "ax-error";
  return <div className={`ap-notice ${cls}`} data-testid="ap-notice" data-tone={n.tone} onClick={onClose} role="status">{n.text}{n.detail?.filter(Boolean).map((d, i) => <div key={i} style={{ marginTop: 2 }}>{d}</div>)}</div>;
}

function ApplyOutcome({ r, onFix, onClose }: { r: ApplyResponse; onFix: (id: string) => void; onClose: () => void }) {
  const s = r.summary!;
  const bad = s.items.filter((i) => i.status === "failed" || i.status === "skipped");
  return (
    <div className="ap-outcome" data-testid="ap-outcome" data-status={s.status}>
      <div className="row"><span className="grow"><b>Last apply:</b> {s.message}</span><button className="ax-rail-btn" onClick={onClose} aria-label="Dismiss" data-testid="ap-outcome-close">×</button></div>
      <div className="muted" style={{ fontSize: 12.5 }}>{s.counts.created} created · {s.counts.updated} updated{s.counts.repointed ? ` · ${s.counts.repointed} moved to this dataset` : ""} · {s.counts.unchanged} unchanged · {s.counts.keptRefined} kept refined · {s.counts.run} run · {s.counts.charts} charts · report {r.report?.action ?? "none"} · dashboard {r.dashboard?.action ?? "none"}</div>
      {bad.length > 0 && <ul className="ap-attention" style={{ marginTop: 6 }}>{bad.map((i) => <li key={i.id}><span className={`badge ${i.status === "failed" ? "error" : "warning"}`}>{i.status === "failed" ? "Failed" : "Skipped"}</span> <button className="ax-linkbtn" onClick={() => onFix(i.id)}>{i.title}</button><div className="muted" style={{ fontSize: 12.5 }}>{i.reason}</div></li>)}</ul>}
    </div>
  );
}

/* ------------------------------------------------------------ the items */

function ItemsSection(p: {
  kind: "crosstab" | "test"; items: Item[]; all: Item[]; data: PlanPayload; api: AxApi; dataset: DatasetSpec; dataN: number;
  canEditPlan: boolean; saving: boolean; editor: { kind: "crosstab" | "test"; item?: Item } | null; variables: VariableMeta[]; hypothesisLabels: string[];
  analysisRow: (it: Item) => Row | undefined; onOpenAnalysis: (a: Row) => void;
  onAdd: () => void; onEdit: (it: Item) => void; onCloseEditor: () => void; onSave: (action: unknown, what: string) => Promise<void>; onRemove: (it: Item) => Promise<void>; onMove: (it: Item, dir: -1 | 1) => Promise<void>;
}) {
  const [open, setOpen] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<Record<string, { busy: boolean; result?: RunResult; error?: string }>>({});
  /* a preview belongs to the item as it is NOW: the plan item, what it reads, and the dataset — change any and it is gone (audit P-10) */
  const previewKey = (it: Item) => `${it.id}|${it.hash}|${it.readsHash}|${p.dataset.environment}|${p.dataset.dataset ?? ""}`;
  const previewOf = async (it: Item, force = false) => {
    const key = previewKey(it);
    const cur = preview[key];
    if (cur?.busy || (cur?.result && !force)) return;
    setPreview((s) => ({ ...s, [key]: { busy: true } }));
    try {
      const saved = p.analysisRow(it);
      const def: AnalysisDefinition = saved ? { ...(saved.definition as AnalysisDefinition), name: saved.name as string, dataset: p.dataset } : { ...(it.derived as AnalysisDefinition), dataset: p.dataset };
      const { result } = await p.api.run(def, force ? { fresh: true } : undefined);
      setPreview((s) => ({ ...s, [key]: { busy: false, result } }));
    } catch (e) { setPreview((s) => ({ ...s, [key]: { busy: false, error: (e as Error).message } })); }
  };
  const editorOpen = p.editor && p.editor.kind === p.kind;
  return (
    <div className="ap-items" data-testid={`ap-${p.kind}s`}>
      <div className="row" style={{ marginBottom: 8, flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 13 }}>{p.kind === "crosstab" ? "Each crosstab is a table of its row variables by its column variables (a banner when there are several), with significance letters where the base allows." : "Each test or model runs on the dataset as the plan states it — the outcome, the predictors, the grouping — and its findings feed the hypothesis verdicts."} P1 serves a hypothesis directly, P2 profiles, P3 explores.</span>
        <span className="grow" />
        {p.canEditPlan && <button className="btn small primary" onClick={p.onAdd} data-testid={`ap-add-${p.kind}`}>+ Add {p.kind === "crosstab" ? "crosstab" : "test"}</button>}
      </div>
      {editorOpen && !p.editor?.item && <ItemEditor kind={p.kind} variables={p.variables} plan={p.data.plan!} hypothesisLabels={p.hypothesisLabels} saving={p.saving} onCancel={p.onCloseEditor} onSave={p.onSave} />}
      {!p.items.length && <div className="ax-empty"><div className="ax-empty-t">{p.all.some((i) => i.kind === p.kind) ? "Nothing matches" : `No ${p.kind === "crosstab" ? "crosstabs" : "tests"} planned`}</div><div className="ax-empty-d">{p.all.some((i) => i.kind === p.kind) ? "Clear the search to see every item." : p.canEditPlan ? "Add one here, or ask Intelligent mode to plan the analysis." : "Ask the project owner to plan them."}</div></div>}
      <div className="ap-item-list">
        {p.items.map((it, idx) => {
          const expanded = open === it.id;
          const editing = p.editor?.item?.id === it.id;
          const pv = preview[previewKey(it)];
          const saved = p.analysisRow(it);
          return (
            <div key={it.id} className={`card ap-item ${expanded ? "open" : ""}`} data-testid={`ap-${p.kind}`} data-id={it.id} data-state={it.state}>
              <div className="ap-item-row" onClick={() => setOpen(expanded ? null : it.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setOpen(expanded ? null : it.id); }}>
                <span className={`cp-sev v-${it.priority === 1 ? "critical" : it.priority === 2 ? "warning" : "suggestion"}`} title={`Priority ${it.priority}`}>P{it.priority}</span>
                <div className="ap-item-main">
                  <div className="ap-item-title">{it.title}</div>
                  <div className="muted ap-item-sub">
                    {it.kind === "crosstab" ? <>{(it.item as PlannedCrosstab).rows.join(", ")} <i>by</i> {(it.item as PlannedCrosstab).columns.join(", ")}{(it.item as PlannedCrosstab).measure ? ` · ${MEASURES.find((m) => m.v === (it.item as PlannedCrosstab).measure)?.l ?? (it.item as PlannedCrosstab).measure}` : " · column %"}</>
                      : <>{words((it.item as PlannedTest).method)}{(it.item as PlannedTest).outcome ? <> · outcome {(it.item as PlannedTest).outcome}</> : null}{(it.item as PlannedTest).variables.length ? <> · {(it.item as PlannedTest).variables.join(" + ")}</> : null}{(it.item as PlannedTest).groupBy ? <> · across {(it.item as PlannedTest).groupBy}</> : null}{(it.item as PlannedTest).moderator ? <> · × {(it.item as PlannedTest).moderator}</> : null}{(it.item as PlannedTest).mediator ? <> · via {(it.item as PlannedTest).mediator}</> : null}</>}
                    {it.hypotheses.length ? ` · ${it.hypotheses.join(", ")}` : ""}
                  </div>
                </div>
                <div className="ap-item-badges">
                  <span className="badge neutral" title={it.inScope ? `${it.tier} tier` : `${it.tier} tier — beyond the items the plan applies by default`} data-testid="ap-item-tier" data-tier={it.tier} data-inscope={it.inScope ? "1" : "0"}>{it.inScope ? it.tier : `${it.tier} · not applied`}</span>
                  <span className={`badge ${STATE_TONE[it.state]}`} data-testid="ap-item-state" title={it.staleBecause}>{STATE_WORD[it.state]}</span>
                  {it.run && <span className="badge neutral" title="Findings from the latest run">{it.run.significant} sig. of {it.run.findings.length}</span>}
                  {it.chart && <span className="badge neutral" title={`Chart: ${it.chart.type}`}><Icon name="chart" size={11} /> {words(it.chart.type)}</span>}
                </div>
                {p.canEditPlan && (
                  <div className="ap-item-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="ax-rail-btn" title="Move up" disabled={idx === 0 || p.saving} onClick={() => void p.onMove(it, -1)} data-testid="ap-item-up">↑</button>
                    <button className="ax-rail-btn" title="Move down" disabled={idx === p.items.length - 1 || p.saving} onClick={() => void p.onMove(it, 1)} data-testid="ap-item-down">↓</button>
                    <button className="btn small" onClick={() => p.onEdit(it)} data-testid="ap-item-edit">Edit</button>
                    <button className="btn small danger" onClick={() => void p.onRemove(it)} data-testid="ap-item-remove">Remove</button>
                  </div>
                )}
              </div>
              {it.issues.length > 0 && <ul className="ap-issues" data-testid="ap-item-issues">{it.issues.map((i, k) => <li key={k} className={`iq-${i.level === "critical" ? "error" : "warning"}`}><Icon name="warning" size={12} /> <span>{i.message}{i.suggestion ? <span className="muted"> {i.suggestion}</span> : null}</span></li>)}</ul>}
              {editing && <ItemEditor kind={it.kind} item={it} variables={p.variables} plan={p.data.plan!} hypothesisLabels={p.hypothesisLabels} saving={p.saving} onCancel={p.onCloseEditor} onSave={p.onSave} />}
              {expanded && !editing && (
                <div className="ap-item-detail" data-testid="ap-item-detail">
                  <dl className="ap-dl">
                    <dt>Variables</dt><dd>{it.variables.map((v) => <span key={v} className={`chip ${it.missing.includes(v) ? "warn" : ""}`}>{v}</span>)}</dd>
                    {it.reason && <><dt>Why</dt><dd>{it.reason}</dd></>}
                    <dt>Hypotheses</dt><dd>{it.hypotheses.length ? it.hypotheses.map((h) => `${h} — ${p.data.survey.hypotheses[Number(h.slice(1)) - 1] ?? ""}`).join("; ") : <span className="muted">none</span>}</dd>
                    <dt>Saved analysis</dt><dd>{it.analysis ? <>{it.analysis.name} · v{it.analysis.version}{it.analysis.updatedAt ? ` · ${timeAgo(it.analysis.updatedAt)}` : ""} {saved && <button className="btn small" onClick={() => p.onOpenAnalysis(saved)} data-testid="ap-item-open">Open in the builder</button>}</> : <span className="muted">none yet — created when the plan is applied</span>}</dd>
                    {it.run && <><dt>Findings</dt><dd>{it.run.findings.length ? <ul className="ax-insights">{it.run.findings.slice(0, 4).map((f) => <li key={f.id}>{f.headline}</li>)}</ul> : <span className="muted">no finding on this base</span>}</dd></>}
                  </dl>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {p.dataN > 0 && it.state !== "invalid" && <button className="btn small" disabled={pv?.busy} onClick={() => void previewOf(it, !!pv?.result)} data-testid="ap-item-preview">{pv?.busy ? "Computing…" : pv?.result ? "Recompute preview" : "Preview the table"}</button>}
                    {p.dataN === 0 && <span className="muted" style={{ fontSize: 12.5 }} data-testid="ap-item-pending">Waiting for data — no complete responses in this dataset yet, so there is nothing to tabulate.</span>}
                    {it.state === "invalid" && <span className="muted" style={{ fontSize: 12.5 }}>Fix the variables above before it can run.</span>}
                  </div>
                  {pv?.error && <p className="iq-error"><Icon name="warning" size={12} /> {pv.error}</p>}
                  {pv?.result && (
                    <div className="ap-preview" data-testid="ap-item-table">
                      {pv.result.tables.length ? <ResultTableView table={pv.result.tables[0]} dense maxRows={40} /> : <div className="muted">The result has no table{pv.result.tests.length ? "; its tests are listed below" : ""}.</div>}
                      {pv.result.tests.map((t, i) => <div key={i} className="muted" style={{ fontSize: 12.5 }}>{t.test}: {t.p == null ? "—" : `p ${t.p < 0.001 ? "< .001" : `= ${t.p.toFixed(3).replace(/^0/, "")}`}`}{t.effectSize && t.effectSize.value != null ? ` · ${t.effectSize.name} = ${Math.round(t.effectSize.value * 100) / 100}` : ""}{t.note ? ` · ${t.note}` : ""}</div>)}
                      {pv.result.warnings.map((w, i) => <div key={i} className="muted" style={{ fontSize: 12.5 }}>⚠ {w}</div>)}
                      <div className="ax-table-notes">{pv.result.base ? `Base: n = ${pv.result.base.n}` : ""}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ the editor */

type Draft = { rows: string[]; columns: string[]; measure: string; method: AnalysisMethod; outcome: string; variables: string[]; groupBy: string; moderator: string; mediator: string; priority: number; hypotheses: string[]; reason: string };

function ItemEditor(p: { kind: "crosstab" | "test"; item?: Item; variables: VariableMeta[]; plan: NonNullable<PlanPayload["plan"]>; hypothesisLabels: string[]; saving: boolean; onCancel: () => void; onSave: (action: unknown, what: string) => Promise<void> }) {
  const x = p.item?.item as PlannedCrosstab | undefined; const t = p.item?.item as PlannedTest | undefined;
  const [d, setD] = React.useState<Draft>(() => p.kind === "crosstab"
    ? { rows: x?.rows ?? [], columns: x?.columns ?? [], measure: x?.measure ?? "", method: "crosstab", outcome: "", variables: [], groupBy: "", moderator: "", mediator: "", priority: x?.priority ?? 2, hypotheses: x?.hypotheses ?? [], reason: x?.reason ?? "" }
    : { rows: [], columns: [], measure: "", method: t?.method ?? "chi_square", outcome: t?.outcome ?? "", variables: t?.variables ?? [], groupBy: t?.groupBy ?? "", moderator: t?.moderator ?? "", mediator: t?.mediator ?? "", priority: t?.priority ?? 2, hypotheses: t?.hypotheses ?? [], reason: t?.reason ?? "" });
  const [err, setErr] = React.useState<string | null>(null);
  /* a variable is a dictionary variable, or one the plan computes (a derived variable, a segment) */
  const options = React.useMemo(() => {
    const seen = new Set<string>();
    const out: { name: string; label: string; group: string }[] = [];
    for (const v of p.variables) { if (seen.has(v.name)) continue; seen.add(v.name); out.push({ name: v.name, label: v.questionCode ? `${v.questionCode} · ${v.label}` : v.label, group: v.derived ? "Derived" : "Questions" }); }
    for (const dv of p.plan.derived) if (!seen.has(dv.name)) { seen.add(dv.name); out.push({ name: dv.name, label: `${dv.name} · ${words(dv.kind)} of ${dv.from.join(", ")}`, group: "Planned derived variables" }); }
    for (const s of p.plan.segments) if (!seen.has(s.name)) { seen.add(s.name); out.push({ name: s.name, label: `${s.name} · segment by ${s.by.join(" × ")}`, group: "Planned segments" }); }
    return out;
  }, [p.variables, p.plan]);
  const set = (patch: Partial<Draft>) => setD((s) => ({ ...s, ...patch }));
  const validate = (): string | null => {
    if (p.kind === "crosstab") {
      if (!d.rows.length) return "Choose at least one row variable.";
      if (!d.columns.length) return "Choose at least one column variable.";
      const same = d.rows.filter((r) => d.columns.includes(r)); if (same.length) return `${same.join(", ")} cannot be both a row and a column.`;
    } else {
      if (!d.outcome && !d.variables.length && !d.groupBy) return "A test needs an outcome, variables or a grouping variable.";
      if (["t_test", "anova", "mann_whitney", "kruskal_wallis"].includes(d.method) && !d.groupBy) return `A ${words(d.method)} compares groups — choose the grouping variable.`;
      if (["regression", "logistic_regression", "driver_analysis", "correlation"].includes(d.method) && !d.outcome && d.method !== "correlation") return `A ${words(d.method)} needs an outcome.`;
      if (d.method === "reliability" && d.variables.length < 2) return "Reliability needs at least two items.";
    }
    return null;
  };
  const save = async () => {
    const v = validate(); setErr(v); if (v) return;
    const common = { priority: d.priority, hypotheses: d.hypotheses, reason: d.reason.trim() || (p.item ? null : undefined) };
    const action = p.kind === "crosstab"
      ? (p.item ? { op: "update_crosstab", id: p.item.id, rows: d.rows, columns: d.columns, measure: d.measure || null, ...common } : { op: "add_crosstab", rows: d.rows, columns: d.columns, ...(d.measure ? { measure: d.measure } : {}), priority: d.priority, hypotheses: d.hypotheses, ...(d.reason.trim() ? { reason: d.reason.trim() } : {}) })
      : (p.item ? { op: "update_analysis_test", id: p.item.id, method: d.method, outcome: d.outcome || null, variables: d.variables, groupBy: d.groupBy || null, moderator: d.moderator || null, mediator: d.mediator || null, ...common }
        : { op: "add_analysis_test", method: d.method, ...(d.outcome ? { outcome: d.outcome } : {}), variables: d.variables, ...(d.groupBy ? { groupBy: d.groupBy } : {}), ...(d.moderator ? { moderator: d.moderator } : {}), ...(d.mediator ? { mediator: d.mediator } : {}), priority: d.priority, hypotheses: d.hypotheses, ...(d.reason.trim() ? { reason: d.reason.trim() } : {}) });
    await p.onSave(action, p.item ? `Changed ${p.item.title}` : p.kind === "crosstab" ? `Planned crosstab ${d.rows.join(", ")} by ${d.columns.join(", ")}` : `Planned ${words(d.method)}`);
  };
  const Pick = ({ label, value, onChange, multi, testid }: { label: string; value: string[] | string; onChange: (v: string[] | string) => void; multi?: boolean; testid: string }) => (
    <label className="ax-field ap-field"><span>{label}</span>
      {multi ? (
        <div className="ap-chips" data-testid={testid}>
          {(value as string[]).map((v) => <span key={v} className="ax-pill">{v}<button type="button" onClick={() => onChange((value as string[]).filter((x) => x !== v))} aria-label={`Remove ${v}`}>×</button></span>)}
          <select className="select small" value="" onChange={(e) => { if (e.target.value && !(value as string[]).includes(e.target.value)) onChange([...(value as string[]), e.target.value]); }} data-testid={`${testid}-add`}>
            <option value="">+ add variable…</option>
            {["Questions", "Derived", "Planned derived variables", "Planned segments"].map((g) => options.some((o) => o.group === g) ? <optgroup key={g} label={g}>{options.filter((o) => o.group === g).map((o) => <option key={o.name} value={o.name}>{o.label}</option>)}</optgroup> : null)}
          </select>
        </div>
      ) : (
        <select className="select" value={value as string} onChange={(e) => onChange(e.target.value)} data-testid={testid}>
          <option value="">—</option>
          {["Questions", "Derived", "Planned derived variables", "Planned segments"].map((g) => options.some((o) => o.group === g) ? <optgroup key={g} label={g}>{options.filter((o) => o.group === g).map((o) => <option key={o.name} value={o.name}>{o.label}</option>)}</optgroup> : null)}
        </select>
      )}
    </label>
  );
  return (
    <div className="ap-editor card" data-testid="ap-editor" data-kind={p.kind}>
      <div className="card-title">{p.item ? `Edit ${p.kind === "crosstab" ? "crosstab" : "test"}` : `New ${p.kind === "crosstab" ? "crosstab" : "test"}`}<span className="grow" /><span className="muted" style={{ fontSize: 12.5 }}>{p.item ? `Keeps id ${p.item.id} — its analysis, chart and dashboard widget stay linked` : "Saved to the survey's plan"}</span></div>
      <div className="ap-editor-grid">
        {p.kind === "crosstab" ? (
          <>
            <Pick label="Rows" value={d.rows} onChange={(v) => set({ rows: v as string[] })} multi testid="ap-ed-rows" />
            <Pick label="Columns (banner when several)" value={d.columns} onChange={(v) => set({ columns: v as string[] })} multi testid="ap-ed-columns" />
            <label className="ax-field ap-field"><span>Measure</span><select className="select" value={d.measure} onChange={(e) => set({ measure: e.target.value })} data-testid="ap-ed-measure"><option value="">Column % (default)</option>{MEASURES.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}</select></label>
          </>
        ) : (
          <>
            <label className="ax-field ap-field"><span>Method</span><select className="select" value={d.method} onChange={(e) => set({ method: e.target.value as AnalysisMethod })} data-testid="ap-ed-method">{ANALYSIS_METHODS.filter((m) => m !== "crosstab").map((m) => <option key={m} value={m}>{words(m)}</option>)}</select></label>
            <Pick label="Outcome (dependent)" value={d.outcome} onChange={(v) => set({ outcome: v as string })} testid="ap-ed-outcome" />
            <Pick label="Variables (predictors, items)" value={d.variables} onChange={(v) => set({ variables: v as string[] })} multi testid="ap-ed-variables" />
            <Pick label="Group by" value={d.groupBy} onChange={(v) => set({ groupBy: v as string })} testid="ap-ed-groupby" />
            <Pick label="Moderator" value={d.moderator} onChange={(v) => set({ moderator: v as string })} testid="ap-ed-moderator" />
            <Pick label="Mediator" value={d.mediator} onChange={(v) => set({ mediator: v as string })} testid="ap-ed-mediator" />
          </>
        )}
        <label className="ax-field ap-field"><span>Priority</span><select className="select" value={d.priority} onChange={(e) => set({ priority: Number(e.target.value) })} data-testid="ap-ed-priority"><option value={1}>P1 — answers a hypothesis or the objective</option><option value={2}>P2 — profiling</option><option value={3}>P3 — exploratory</option></select></label>
        <div className="ax-field ap-field"><span>Hypotheses</span>
          <div className="ap-chips" data-testid="ap-ed-hypotheses">{p.hypothesisLabels.length ? p.hypothesisLabels.map((h) => <label key={h} className={`ax-chip ${d.hypotheses.includes(h) ? "on" : ""}`}><input type="checkbox" style={{ display: "none" }} checked={d.hypotheses.includes(h)} onChange={(e) => set({ hypotheses: e.target.checked ? [...d.hypotheses, h].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))) : d.hypotheses.filter((x) => x !== h) })} />{h}</label>) : <span className="muted" style={{ fontSize: 12.5 }}>No hypotheses in the research design.</span>}</div>
        </div>
        <label className="ax-field ap-field ap-field-wide"><span>Why (shown as the analysis name)</span><input className="input" value={d.reason} onChange={(e) => set({ reason: e.target.value })} placeholder={p.kind === "crosstab" ? "e.g. purchase intent by country" : "e.g. does trust differ by region"} data-testid="ap-ed-reason" /></label>
      </div>
      {err && <p className="iq-error" data-testid="ap-ed-error"><Icon name="warning" size={12} /> {err}</p>}
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button className={`btn primary small${p.saving ? " loading" : ""}`} disabled={p.saving} onClick={() => void save()} data-testid="ap-ed-save">{p.item ? "Save changes" : "Add to the plan"}</button>
        <button className="btn small" disabled={p.saving} onClick={p.onCancel} data-testid="ap-ed-cancel">Cancel</button>
        <span className="muted" style={{ fontSize: 12.5 }}>Saving writes the survey's draft; apply the plan afterwards to update the outputs.</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ variables */

function VariablesSection({ variables, items, onItem }: { variables: Variable[]; items: Item[]; onItem: (id: string) => void }) {
  const [open, setOpen] = React.useState<string | null>(null);
  const title = (id: string) => items.find((i) => i.id === id)?.title ?? id;
  const KIND_WORD: Record<Variable["kind"], string> = { question: "Question", derived: "Planned derived", segment: "Planned segment", calculation: "Calculation", embedded: "Embedded / system", missing: "Missing" };
  return (
    <div className="ax-panel" data-testid="ap-variables">
      {!variables.length && <div className="ax-empty"><div className="ax-empty-t">No variables</div><div className="ax-empty-d">The plan reads no variable, or nothing matches the search.</div></div>}
      {variables.length > 0 && (
        <div className="ax-table-wrap">
          <table className="ax-table" data-testid="ap-variables-table">
            <thead><tr><th>Variable</th><th>Label / source question</th><th>Type</th><th>Role · level</th><th>Categories</th><th>Hypotheses</th><th>Used by</th></tr></thead>
            <tbody>
              {variables.map((v) => (
                <React.Fragment key={v.name}>
                  <tr data-testid="ap-variable" data-kind={v.kind} className={v.kind === "missing" ? "ap-var-missing" : ""}>
                    <td><span className="mono">{v.name}</span>{v.kind === "missing" && <span className="badge error" style={{ marginLeft: 6 }}>missing</span>}</td>
                    <td style={{ whiteSpace: "normal", maxWidth: 360 }}>{v.questionCode ? <b>{v.questionCode}</b> : null} {v.label}{v.construct ? <div className="muted" style={{ fontSize: 12 }}>measures “{v.construct}”</div> : null}</td>
                    <td>{KIND_WORD[v.kind]}{v.questionType ? <div className="muted" style={{ fontSize: 12 }}>{words(v.questionType)}</div> : null}</td>
                    <td>{v.role ?? "—"}{v.measurement ? ` · ${v.measurement}` : ""}</td>
                    <td>{v.categories?.length ? <button className="ax-linkbtn" onClick={() => setOpen(open === v.name ? null : v.name)} data-testid="ap-var-cats">{v.categories.length} {open === v.name ? "▾" : "▸"}</button> : <span className="muted">—</span>}</td>
                    <td>{v.hypotheses.join(", ") || <span className="muted">—</span>}</td>
                    <td style={{ whiteSpace: "normal" }}>{[...v.crosstabs, ...v.tests].map((id) => <button key={id} className="ax-chip" style={{ margin: 1 }} onClick={() => onItem(id)} title={title(id)}>{title(id).slice(0, 36)}{title(id).length > 36 ? "…" : ""}</button>)}</td>
                  </tr>
                  {(v.warnings.length > 0 || open === v.name) && (
                    <tr className="ap-var-extra"><td colSpan={7} style={{ whiteSpace: "normal" }}>
                      {v.warnings.map((w, i) => <p key={i} className="iq-warning" data-testid="ap-var-warning"><Icon name="warning" size={12} /> {w}{v.kind === "missing" && (v.crosstabs[0] || v.tests[0]) ? <> <button className="btn small" onClick={() => onItem(v.crosstabs[0] ?? v.tests[0])} data-testid="ap-var-resolve">Resolve — edit the first item that reads it</button></> : null}</p>)}
                      {open === v.name && v.categories && <div className="ap-cats">{v.categories.map((c) => <span key={c.code} className="chip"><span className="mono">{c.code}</span> {c.label}</span>)}</div>}
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ charts */

function ChartsSection(p: { items: Item[]; api: AxApi; dataN: number; dataset: DatasetSpec; analysisRow: (it: Item) => Row | undefined; onOpenAnalysis: (a: Row) => void; onTab: (t: "charts" | "reports" | "analysis") => void; canEdit: boolean; onApply: () => void; applying: boolean }) {
  const [results, setResults] = React.useState<Record<string, { busy: boolean; result?: RunResult; error?: string }>>({});
  const [limit, setLimit] = React.useState(8);
  const shown = p.items.slice(0, limit);
  /* a drawn result is for the item as it is now (what it computes, what it reads) on this dataset; when any of that changes the old one is not shown (audit P-10) */
  const keyOf = (it: Item) => `${it.id}|${it.hash}|${it.readsHash}|${p.dataset.environment}|${p.dataset.dataset ?? ""}|${p.analysisRow(it)?.version ?? 0}`;
  const load = React.useCallback(async (it: Item, key: string) => {
    setResults((s) => (s[key] ? s : { ...s, [key]: { busy: true } }));
    const saved = p.analysisRow(it);
    const def: AnalysisDefinition = saved ? { ...(saved.definition as AnalysisDefinition), name: saved.name as string, dataset: p.dataset } : { ...(it.derived as AnalysisDefinition), dataset: p.dataset };
    try { const { result } = await p.api.run(def); setResults((s) => ({ ...s, [key]: { busy: false, result } })); }
    catch (e) { setResults((s) => ({ ...s, [key]: { busy: false, error: (e as Error).message } })); }
  }, [p.api, p.analysisRow, p.dataset]);
  React.useEffect(() => { if (p.dataN > 0) for (const it of shown) { const key = keyOf(it); if (!results[key]) void load(it, key); } }, [shown, p.dataN, load, results]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p.items.length) return <div className="ax-empty"><div className="ax-empty-t">Nothing to chart</div><div className="ax-empty-d">Every planned analysis that can run appears here as a chart.</div></div>;
  if (p.dataN === 0) return (
    <div className="ax-empty" data-testid="ap-charts-pending">
      <div className="ax-empty-t">Waiting for data</div>
      <div className="ax-empty-d">{p.items.length} chart{p.items.length === 1 ? "" : "s"} configured from the plan — no complete responses in this dataset yet, so nothing is drawn. Switch the dataset above, or come back when fieldwork has started.</div>
    </div>
  );
  return (
    <div data-testid="ap-charts">
      <div className="row" style={{ marginBottom: 8, flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 13 }}>Each chart is the planned analysis computed on the current {p.dataset.environment.toLowerCase()} data, drawn as the run recommends{p.items.some((i) => i.chart) ? "; saved charts keep the styling you gave them" : "; apply the plan to save them as charts"}.</span>
        <span className="grow" />
        <button className="btn small" onClick={() => p.onTab("charts")}>Saved charts</button>
      </div>
      <div className="ax-chart-grid">
        {shown.map((it) => {
          const r = results[keyOf(it)];
          const saved = p.analysisRow(it);
          const type: ChartType = it.chart?.type ?? it.run?.chart ?? r?.result?.recommendations?.[0]?.type ?? r?.result?.recommendedCharts?.[0] ?? "bar_vertical";
          /* a saved chart is drawn as saved — its title, labels, colours, decimals — not as a fresh default (audit P-10) */
          const spec: ChartSpec = it.chart?.spec ?? { type, options: { title: it.title, dataLabels: true } };
          return (
            <div key={it.id} className="card ax-chart-card" data-testid="ap-chart-card" data-id={it.id}>
              <div className="card-title">{it.title}<span className="grow" /><span className="muted" style={{ fontSize: 12.5 }}>{words(type)}{it.chart ? "" : " · not saved yet"}</span></div>
              <div className="muted" style={{ fontSize: 12.5 }}>{it.kind === "crosstab" ? "crosstab" : words((it.item as PlannedTest).method)}{it.hypotheses.length ? ` · ${it.hypotheses.join(", ")}` : ""}</div>
              {r?.result ? <Chart result={r.result} spec={spec} compact /> : r?.error ? <p className="iq-error"><Icon name="warning" size={12} /> {r.error}</p> : <div className="muted" style={{ padding: 20 }}>Computing…</div>}
              {r?.result?.warnings.length ? <div className="muted" style={{ fontSize: 12 }}>{r.result.warnings[0]}</div> : null}
              <div className="card-actions" style={{ marginTop: 6 }}>{saved && <button className="btn small" onClick={() => p.onOpenAnalysis(saved)}>Open analysis</button>}{!saved && p.canEdit && <button className="btn small" disabled={p.applying} onClick={p.onApply}>Apply the plan to save it</button>}</div>
            </div>
          );
        })}
      </div>
      {p.items.length > limit && <div className="row" style={{ marginTop: 10 }}><button className="btn small" onClick={() => setLimit((l) => l + 8)} data-testid="ap-charts-more">Show {Math.min(8, p.items.length - limit)} more ({p.items.length - limit} left)</button></div>}
    </div>
  );
}

/* ------------------------------------------------------------ insights */

function InsightsSection({ data, items, onItem, surveyId }: { data: PlanPayload; items: Item[]; onItem: (id: string) => void; surveyId: string }) {
  const run = data.run;
  const [onlySig, setOnlySig] = React.useState(true);
  if (!run) return <div className="ax-empty" data-testid="ap-insights-none"><div className="ax-empty-t">No findings yet</div><div className="ax-empty-d">Apply the plan once complete responses exist. The findings here are what the engine observes in the data — each one traces to a planned analysis, its test, p-value, effect size and base.</div></div>;
  const findings = run.findings.filter((f) => !onlySig || f.significant || ["nps", "topbox", "reliability"].includes(f.kind));
  const itemFor = (f: { analysis: { planned?: string } }) => (f.analysis.planned ? items.find((i) => i.id === f.analysis.planned) : undefined);
  const disc = run.discoveries;
  return (
    <div className="ap-insights" data-testid="ap-insights">
      <p className="muted" style={{ fontSize: 13 }} data-testid="ap-insights-note"><Icon name="info" size={12} /> Observed patterns, computed by the engine from the run of {new Date(run.computedAt).toLocaleString()} on {run.n} {run.environment.toLowerCase()} completes. Nothing here is written by a language model; the copilot's narrative (headline, implications, recommendations) is in <a href={`/studio/${surveyId}?mode=intelligent`}>Intelligent mode → Findings</a> and is gated against these numbers.</p>
      {run.n < 30 && <p className="iq-warning"><Icon name="warning" size={12} /> Only {run.n} completes — read every finding with caution; nothing here is conclusive yet.</p>}
      <div className="ap-two">
        <div className="card">
          <div className="card-title">Hypothesis verdicts</div>
          {!run.verdicts.length && <div className="muted" style={{ fontSize: 13 }}>No hypotheses in the research design.</div>}
          <ul className="ap-verdicts">{run.verdicts.map((v) => <li key={v.label} data-testid="ap-verdict"><span className={`badge ${VERDICT_TONE[v.verdict]}`}>{VERDICT_WORD[v.verdict]}</span> <b>{v.label}</b> {v.text}<div className="muted" style={{ fontSize: 12.5 }}>{v.reason}</div></li>)}</ul>
        </div>
        <div className="card">
          <div className="card-title">KPIs{run.since ? " · since the last wave" : ""}</div>
          {!run.kpis?.length && <div className="muted" style={{ fontSize: 13 }}>No KPIs in the research design.</div>}
          {run.kpis && run.kpis.length > 0 && <table className="ax-table dense"><thead><tr><th>KPI</th><th>Measure</th><th className="num">Value</th>{run.since && <th className="num">Change</th>}<th className="num">n</th></tr></thead><tbody>{run.kpis.map((k) => { const d = run.since?.kpis.find((x) => x.name === k.name && x.measure === k.measure); return <tr key={`${k.name}:${k.measure}`}><td>{k.name}</td><td>{words(k.measure)}</td><td className="num">{k.value == null ? "—" : Math.round(k.value * 10) / 10}</td>{run.since && <td className="num">{d?.delta == null ? "—" : `${d.delta > 0 ? "+" : ""}${Math.round(d.delta * 10) / 10}`}</td>}<td className="num">{k.n}</td></tr>; })}</tbody></table>}
        </div>
      </div>
      <div className="card">
        <div className="card-title">Findings <span className="ax-rail-count">{findings.length}</span><span className="grow" /><label className="ax-toggle muted" style={{ fontSize: 12.5 }}><input type="checkbox" checked={onlySig} onChange={(e) => setOnlySig(e.target.checked)} /> significant only</label></div>
        {!findings.length && <div className="muted" style={{ fontSize: 13 }}>No {onlySig ? "significant " : ""}finding on this base.</div>}
        <ul className="ap-findings">
          {findings.slice(0, 60).map((f) => { const it = itemFor(f); return (
            <li key={f.id} data-testid="ap-finding" data-kind={f.kind}>
              <span className={`cp-sev v-${f.strength === "strong" ? "critical" : f.strength === "moderate" ? "warning" : "suggestion"}`}>{f.strength}</span> {f.headline}
              <div className="muted" style={{ fontSize: 12.5 }}>
                {f.evidence.test ? `${f.evidence.test} · ` : ""}{f.evidence.p != null ? `p ${f.evidence.p < 0.001 ? "< .001" : `= ${f.evidence.p.toFixed(3).replace(/^0/, "")}`} · ` : ""}{f.evidence.effect ? `${f.evidence.effect.name} = ${Math.round(f.evidence.effect.value * 100) / 100} · ` : ""}n = {f.evidence.n}
                {f.hypotheses.length ? ` · ${f.hypotheses.join(", ")}` : ""} · variables {f.variables.join(", ")}
                {it ? <> · from <button className="ax-linkbtn" onClick={() => onItem(it.id)}>{it.title}</button></> : <> · {f.analysis.name}</>}
              </div>
            </li>); })}
        </ul>
      </div>
      {disc && (disc.segments.length > 0 || disc.anomalies.length > 0 || disc.trends.length > 0) && (
        <div className="card" data-testid="ap-discoveries">
          <div className="card-title">Beyond the plan</div>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>Segment differences the plan did not test, data anomalies and wave movements the engine noticed — exploratory, corrected for multiple comparisons, not part of any hypothesis.</div>
          <ul className="ap-findings">{[...disc.segments, ...disc.anomalies, ...disc.trends].slice(0, 30).map((f) => <li key={f.id} data-kind={f.kind}><span className="badge neutral">{f.kind}</span> {f.headline}<div className="muted" style={{ fontSize: 12.5 }}>{f.evidence.p != null ? `p ${f.evidence.p < 0.001 ? "< .001" : `= ${f.evidence.p.toFixed(3).replace(/^0/, "")}`} · ` : ""}n = {f.evidence.n} · {f.variables.join(", ")}</div></li>)}</ul>
        </div>
      )}
      {run.warnings.length > 0 && <div className="card"><div className="card-title">Caveats</div><ul className="ax-insights">{run.warnings.map((w, i) => <li key={i} className="muted" style={{ fontSize: 13 }}>{w}</li>)}</ul></div>}
    </div>
  );
}

/* ------------------------------------------------------------ reports & dashboards */

function OutputSection(p: { kind: "report" | "dashboard"; out: PlanPayload["report"]; items: Item[]; data: PlanPayload; canEdit: boolean; canExport: boolean; api: AxApi; applying: boolean; onApply: (replaceReport: boolean) => void; onTab: (t: "reports" | "charts" | "analysis") => void }) {
  const out = p.out;
  const title = (id: string | null) => (id ? p.items.find((i) => i.id === id)?.title ?? null : null);
  if (!out) return (
    <div className="ax-empty" data-testid={`ap-${p.kind}-none`}>
      <div className="ax-empty-t">No {p.kind} from the plan yet</div>
      <div className="ax-empty-d">{p.kind === "report" ? "The findings report is drafted from a run — apply the plan once complete responses exist and it appears here, with a section per hypothesis, every planned chart captioned with its findings, the methodology and the caveats." : "The dashboard is configured when the plan is applied: one chart widget per planned analysis (hypothesis-linked first) and a findings summary; the widgets fill as data arrives."}</div>
      {p.canEdit && <div style={{ marginTop: 10 }}><button className="btn primary" disabled={p.applying} onClick={() => p.onApply(false)} data-testid={`ap-${p.kind}-apply`}>Apply analysis plan</button></div>}
    </div>
  );
  const linked = out.components.filter((c) => c.planned || c.analysisId);
  return (
    <div className="ap-output" data-testid={`ap-${p.kind}`}>
      <div className="card">
        <div className="card-title">{p.kind === "dashboard" ? "▦" : "▤"} {out.name}<span className="grow" />{out.publishedVersion ? <span className="badge success">published v{out.publishedVersion}</span> : <span className="badge neutral">draft</span>}{out.editedSinceApply && <span className="badge warning" data-testid={`ap-${p.kind}-edited`}>edited by hand since the apply</span>}</div>
        <div className="muted" style={{ fontSize: 13 }}>Updated {timeAgo(out.updatedAt)}{out.appliedAt ? ` · last written by the apply ${timeAgo(out.appliedAt)}` : ""} · {out.components.length} {p.kind === "dashboard" ? "widgets" : "blocks"}, {linked.length} from analyses</div>
        <div className="card-actions" style={{ marginTop: 8, flexWrap: "wrap" }}>
          <button className="btn primary small" onClick={() => p.onTab("reports")} data-testid={`ap-${p.kind}-open`}>Open in Reports</button>
          {p.canEdit && p.kind === "report" && <button className="btn small" disabled={p.applying} onClick={() => { if (!out.editedSinceApply || window.confirm("Regenerate the findings report from the latest run? Your hand edits to it will be replaced.")) p.onApply(true); }} data-testid="ap-report-regenerate">Regenerate from the latest run</button>}
          {p.canEdit && p.kind === "dashboard" && <button className="btn small" disabled={p.applying} onClick={() => p.onApply(false)} data-testid="ap-dashboard-refresh">Refresh from the plan</button>}
          {p.canExport && p.kind === "report" && <button className="btn small" onClick={() => void p.api.export({ format: "pptx", reportId: out.id })}>PowerPoint</button>}
          {p.canExport && p.kind === "report" && <button className="btn small" onClick={() => void p.api.export({ format: "xlsx", reportId: out.id })}>Excel</button>}
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>{p.kind === "report" ? "The report stays linked to its analyses: open it in Reports and every chart is recomputed from the current data. Applying the plan again regenerates it from the new run unless you edited it by hand — then it is kept, and “Regenerate” replaces it." : "Widgets made from the plan carry their planned item; applying again adds widgets for new items, removes those of items that left the plan, and keeps every widget where you put it, plus anything you added yourself."}</p>
      </div>
      <div className="card">
        <div className="card-title">What each component comes from</div>
        <div className="ax-table-wrap"><table className="ax-table dense" data-testid={`ap-${p.kind}-components`}>
          <thead><tr><th>Component</th><th>Type</th><th>Planned analysis</th><th>Analysis</th></tr></thead>
          <tbody>{out.components.map((c) => <tr key={c.id} data-planned={c.planned ?? ""}><td style={{ whiteSpace: "normal" }}>{c.title || <span className="muted">{c.id}</span>}</td><td>{words(c.type)}</td><td style={{ whiteSpace: "normal" }}>{title(c.planned) ?? (c.id === "plan:summary" ? <span className="muted">the run's summary</span> : <span className="muted">—</span>)}</td><td>{c.analysisId ? <span className="mono muted" style={{ fontSize: 12 }}>{c.analysisId.slice(0, 8)}</span> : <span className="muted">—</span>}</td></tr>)}</tbody>
        </table></div>
      </div>
    </div>
  );
}
