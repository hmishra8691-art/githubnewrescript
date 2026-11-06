"use client";
import React from "react";
import type { AnalysisResult, ChartData, ChartSpec, DatasetSpec } from "@rescript/analytics";
import type { AxApi, OverviewPayload, Row } from "./api";
import { Chart } from "./charts/Chart";
import { useResults } from "./architect/useResults";
import { DEFAULT_NUMBER_LOCALE } from "@/lib/number";

/**
 * THE EXECUTIVE OVERVIEW (Analytics upgrade M2) — the default landing of Analytics: the study at a glance for a
 * reader who is not a statistician, from the latest run and nothing else.
 *
 *   the band          completes, hypotheses supported, findings that hold, KPIs, data quality, when the run was
 *   the summary       the engine's executive summary; "Polish with AI" asks the model through the gate — what
 *                     comes back is marked as the model's, with how many sentences survived the gate
 *   key findings      title · plain reading · evidence · chart · why it matters — each opens in Architect
 *   hypotheses        every verdict, in words
 *   who answered      the demographic cuts as distributions
 *   correlations · beyond the plan · themes · data quality
 *
 * Nothing is fabricated: a section with no data says what is missing and where to get it. Charts of key findings
 * are the saved analyses' own results (useResults), computed server-side.
 */
export function OverviewDashboard(p: { api: AxApi; dataset: DatasetSpec; analyses: Row[]; refreshKey: number; onOpenAnalysis: (analysisId: string, planned: string | null) => void; onPlan: () => void; onArchitect: () => void; onFindings: () => void }) {
  const [data, setData] = React.useState<OverviewPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [polishing, setPolishing] = React.useState(false);
  const load = React.useCallback(async (narrative = false) => {
    try { const d = await p.api.overview({ environment: p.dataset.environment, dataset: p.dataset.dataset }, narrative); setData(d); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [p.api, p.dataset.environment, p.dataset.dataset]);
  React.useEffect(() => { void load(); }, [load, p.refreshKey]);
  const polish = async () => { setPolishing(true); try { await load(true); } finally { setPolishing(false); } };

  const o = data?.overview;
  const wanted = React.useMemo(() => [...new Set((o?.keyFindings ?? []).map((k) => k.analysisId).filter((x): x is string => !!x))], [o]);
  const results = useResults(p.api, p.analyses, wanted);
  const n = (v: number) => v.toLocaleString(DEFAULT_NUMBER_LOCALE);
  const completes = data ? (p.dataset.environment === "ALL" ? Object.values(data.counts).reduce((a, b) => a + b, 0) : data.counts[p.dataset.environment] ?? 0) : null;

  if (error) return <div className="ax-error" data-testid="ax-overview-error">{error}</div>;
  if (!data || !o) return <div className="ax-ov-loading muted" data-testid="ax-overview-loading">Reading the study…</div>;

  const supported = o.hypothesisCounts.supported;
  const quality = data.quality ?? [];
  const speeders = quality.find((q) => /speeder/i.test(q.metric));
  const kpi0 = o.kpis[0];
  const open = (k: { analysisId: string | null; planned: string | null }) => { if (k.analysisId || k.planned) p.onOpenAnalysis(k.analysisId ?? "", k.planned); else p.onArchitect(); };

  return (
    <div className="ax-ov" data-testid="ax-overview">
      {/* the band */}
      <div className="ax-ov-band">
        <Tile label="Completes" value={completes == null ? "—" : n(completes)} sub={`${p.dataset.environment === "LIVE" ? "production" : p.dataset.environment === "TEST" ? "test" : "all"}${data.surveyVersion ? ` · survey v${data.surveyVersion}` : ""}`} testid="ax-ov-completes" />
        <Tile label="Hypotheses" value={o.hypotheses.length ? `${supported} / ${o.hypotheses.length}` : "—"} sub={o.hypotheses.length ? "supported" : "none in the design"} tone={o.hypotheses.length ? (supported ? "good" : "warn") : undefined} testid="ax-ov-hyp" />
        <Tile label="Findings that hold" value={o.run ? n(o.counts.holding) : "—"} sub={o.run ? `of ${n(o.counts.findings)} tested` : "no run yet"} testid="ax-ov-findings" />
        <Tile label={kpi0 ? kpi0.name : "KPIs"} value={kpi0 ? (kpi0.value == null ? "—" : fmtKpi(kpi0.value, kpi0.measure)) : "—"} sub={kpi0 ? `${kpi0.measure}${kpi0.target ? ` · target ${kpi0.target}` : ""}` : "none declared"} testid="ax-ov-kpi" />
        <Tile label="Data quality" value={speeders ? speeders.value.replace(/^\d+\s*\(/, "").replace(/\)$/, "") : quality.length ? "ok" : "—"} sub={speeders ? "speeders" : quality.length ? "no speeders found" : "no data yet"} testid="ax-ov-quality" />
        <Tile label="Last run" value={o.run ? new Date(o.run.computedAt).toLocaleDateString() : "—"} sub={o.run ? `${o.run.trigger} · ${n(o.run.n)} completes` : data.hasPlan ? "apply the plan" : "no plan yet"} testid="ax-ov-run" />
      </div>

      {/* the summary */}
      <section className="ax-ov-card ax-ov-summary" data-testid="ax-ov-summary">
        <div className="ax-ov-card-head">
          <h3>Executive summary</h3>
          {o.objective && <span className="ax-ov-objective" title={o.objective}>Objective: {o.objective}</span>}
          <span className="grow" />
          {o.run && <button className="btn small" disabled={polishing} onClick={() => void polish()} data-testid="ax-ov-polish" title="Ask the model to write it from the run's claims — every sentence is checked against the numbers">{polishing ? "Asking…" : data.summary.source === "model" ? "Ask again" : "Polish with AI"}</button>}
        </div>
        {!o.run && (
          <div className="ax-ov-empty">
            <b>No analysis run yet.</b>
            <p className="muted">{data.hasPlan ? "The plan is saved. Apply it to run every planned crosstab and test on the responses — the summary, the findings and the hypotheses fill from that run." : "Record the objective and hypotheses, let the engine propose the analysis plan, and apply it; or build an analysis by hand in Explore."}</p>
            <button className="btn primary small" onClick={p.onPlan} data-testid="ax-ov-open-plan">{data.hasPlan ? "Open the plan" : "Plan the analysis"}</button>
          </div>
        )}
        {o.run && data.summary.source === "model" && data.summary.model && (
          <div className="ax-ov-model" data-testid="ax-ov-model">
            {data.summary.model.headline && <p className="ax-ov-headline">{data.summary.model.headline}</p>}
            {(data.summary.model.summary ?? []).map((s, i) => <p key={i}>{s}</p>)}
            {(data.summary.model.implications ?? []).length > 0 && <><div className="eyebrow">What it means</div>{(data.summary.model.implications ?? []).map((s, i) => <p key={i}>{s}</p>)}</>}
            {(data.summary.model.recommendations ?? []).length > 0 && <><div className="eyebrow">Suggested next steps</div>{(data.summary.model.recommendations ?? []).map((s, i) => <p key={i}>{s}</p>)}</>}
            <p className="ax-ov-gate muted">Written by the model from the run's claims and checked against them: {data.summary.gate}. The engine's own words: {data.summary.engine}</p>
          </div>
        )}
        {o.run && data.summary.source !== "model" && (
          <div data-testid="ax-ov-engine">
            <p className="ax-ov-lead">{data.summary.engine}</p>
            {data.summary.gate !== "the engine's words" && <p className="ax-ov-gate muted">{data.summary.gate}</p>}
          </div>
        )}
        {o.caveats.length > 0 && <p className="ax-ov-caveats" data-testid="ax-ov-caveats">{o.caveats.slice(0, 3).join(" ")}</p>}
      </section>

      {/* key findings */}
      {o.run && (
        <section data-testid="ax-ov-key">
          <div className="ax-ov-sect"><h3>Key findings</h3><span className="muted">{o.keyFindings.length ? "the strongest results that hold after correction — each opens in Architect" : "no planned test reached significance on this base"}</span><span className="grow" /><button className="btn small ghost" onClick={p.onFindings}>All findings</button></div>
          <div className="ax-ov-grid">
            {o.keyFindings.map((k, i) => {
              const r = k.analysisId ? results.results[k.analysisId] : undefined;
              return (
                <article key={k.id} className="ax-ov-finding" data-testid="ax-ov-finding" onClick={() => open(k)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") open(k); }}>
                  <div className="ax-ov-finding-head"><span className="ax-ov-num">{i + 1}</span><h4>{k.title}</h4><span className={`ax-ov-strength ${k.strength}`}>{k.strength}</span></div>
                  <p className="ax-ov-plain">{k.plain}</p>
                  {r ? <div className="ax-ov-chart"><Chart result={r} spec={{ type: k.chart, options: {} } as ChartSpec} compact height={180} /></div>
                    : k.analysisId && results.status[k.analysisId] === "error" ? <div className="muted" style={{ fontSize: 12 }}>Chart unavailable — open the analysis.</div>
                    : k.analysisId ? <div className="ax-ov-chart muted" style={{ fontSize: 12 }}>Drawing…</div> : null}
                  <div className="ax-ov-evidence mono">{k.evidence}</div>
                  <div className="ax-ov-why">{k.why}</div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <div className="ax-ov-cols">
        {/* hypotheses */}
        <section className="ax-ov-card" data-testid="ax-ov-hypotheses">
          <div className="ax-ov-card-head"><h3>Hypotheses</h3><span className="muted">{o.hypotheses.length ? `${supported} supported · ${o.hypothesisCounts.not_supported} not · ${o.hypothesisCounts.mixed + o.hypothesisCounts.inconclusive} unclear · ${o.hypothesisCounts.untested} untested` : "none recorded"}</span><span className="grow" /><button className="btn small ghost" onClick={p.onArchitect}>Open in Architect</button></div>
          {!o.hypotheses.length && <p className="muted">The research design has no hypotheses{o.run ? "" : " — or the plan has not been run"}. Record them in the research design and the plan tests them.</p>}
          {o.hypotheses.map((h) => (
            <div key={h.label} className="ax-ov-hyp" data-verdict={h.verdict}>
              <span className={`axa-verdict ${h.verdict}`}>{h.word}</span>
              <div><b>{h.label}</b> {h.text}<div className="muted" style={{ fontSize: 12.5 }}>{h.reason}</div></div>
            </div>
          ))}
        </section>

        {/* who answered */}
        <section className="ax-ov-card" data-testid="ax-ov-sample">
          <div className="ax-ov-card-head"><h3>Who answered</h3><span className="muted">{data.sample.length ? "the questionnaire's own demographic cuts" : "no demographic questions, or no responses yet"}</span></div>
          <div className="ax-ov-sample">
            {data.sample.map((s) => (
              <div key={s.variable} className="ax-ov-sample-cut">
                <div className="ax-ov-sample-label">{s.label} <span className="muted">n = {n(s.n)}</span></div>
                <Chart result={syntheticResult(s.label, s.chart, s.n)} spec={{ type: "bar_horizontal", options: { dataLabels: true } } as ChartSpec} compact height={Math.max(110, 22 * (s.chart.categories?.length ?? 4) + 30)} />
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="ax-ov-cols three">
        <section className="ax-ov-card" data-testid="ax-ov-correlations">
          <div className="ax-ov-card-head"><h3>Correlations</h3></div>
          {!o.correlations.length && <p className="muted">No correlation in the plan reached significance{o.run ? "" : " — no run yet"}.</p>}
          {o.correlations.map((k) => <button key={k.id} className="ax-ov-row" onClick={() => open(k)}><b>{k.title}</b><span>{k.plain}</span><span className="mono muted">{k.evidence}</span></button>)}
        </section>
        <section className="ax-ov-card" data-testid="ax-ov-beyond">
          <div className="ax-ov-card-head"><h3>Beyond the plan</h3></div>
          {!o.beyondThePlan && <p className="muted">The run looks for segment differences, trends and anomalies the plan did not ask for; none yet.</p>}
          {o.beyondThePlan && <><p className="muted" style={{ fontSize: 12.5 }}>{o.beyondThePlan.summary}</p>{o.beyondThePlan.items.map((d, i) => <div key={i} className="ax-ov-row static"><span className="axa-chip">{d.kind}</span> {d.headline}</div>)}</>}
        </section>
        <section className="ax-ov-card" data-testid="ax-ov-themes">
          <div className="ax-ov-card-head"><h3>Themes &amp; data quality</h3></div>
          {data.themes.length > 0 && <div className="ax-ov-themes">{data.themes.map((t) => <span key={t.id} className={`axa-chip ${t.status === "ai_suggested" ? "faint" : ""}`} title={t.status === "ai_suggested" ? "suggested, not yet reviewed" : "reviewed"}>{t.name}</span>)}</div>}
          {!data.themes.length && <p className="muted" style={{ fontSize: 12.5 }}>No qualitative themes — code open ends or transcripts in the qualitative workspace and they appear here.</p>}
          {quality.length > 0 && <dl className="axa-dl" style={{ marginTop: 8 }}>{quality.slice(0, 6).map((q) => <React.Fragment key={q.metric}><dt>{q.metric}</dt><dd>{q.value}</dd></React.Fragment>)}</dl>}
        </section>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, tone, testid }: { label: string; value: string; sub?: string; tone?: "good" | "warn"; testid: string }) {
  return <div className={`metric ax-ov-tile ${tone ?? ""}`} data-testid={testid}><span className="metric-v">{value}</span><span className="metric-l">{label}</span>{sub && <span className="ax-kpi-sub">{sub}</span>}</div>;
}

const fmtKpi = (v: number, measure: string) => (/share|box|%/i.test(measure) && v <= 1 ? `${(v * 100).toFixed(0)}%` : /share|box|%/i.test(measure) ? `${v.toFixed(0)}%` : Number.isInteger(v) ? String(v) : v.toFixed(1));

/** a chart-only result, for a distribution the server already computed — the Chart component reads `chart` and `base` */
function syntheticResult(name: string, chart: ChartData, n: number): AnalysisResult {
  return { kind: "descriptive", name, base: { total: n, filtered: n, n, weightedN: n, label: "" }, tables: [], chart, tests: [], insights: [], warnings: [], recommendedCharts: ["bar_horizontal"], computedAt: "", definitionHash: "", variablesUsed: [] };
}

