"use client";
import React from "react";
import type { AnalysisResult, ChartRecommendation, ChartSpec, ChartType, ReportTheme } from "@rescript/analytics";
import { CHART_CATALOG, CHART_FAMILIES, chartsAvailable } from "@rescript/analytics";
import { Chart, ResultTableView } from "./charts/Chart";

/**
 * RESULT + CHART WORKBENCH (§9, §10, §29, §30, §31). Shows the tables an
 * analysis produced, the recommended charts, the full gallery by family, and
 * the customisation panel. Styling changes live in the ChartSpec only — the
 * result underneath is never touched (§17).
 */

export function ChartCustomizer({ spec, onChange, themes, result }: { spec: ChartSpec; onChange: (s: ChartSpec) => void; themes: { id: string; name: string }[]; result: AnalysisResult }) {
  const o = spec.options;
  const set = (patch: Partial<ChartSpec["options"]>) => onChange({ ...spec, options: { ...o, ...patch } });
  const cats = result.chart.categories ?? [];
  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="ax-field"><span>{label}</span>{children}</label>;
  return (
    <div className="ax-customize" data-testid="ax-customize">
      <div className="ax-cust-grid">
        <Field label="Title"><input className="input small" value={o.title ?? ""} onChange={(e) => set({ title: e.target.value || undefined })} placeholder={result.name} /></Field>
        <Field label="Subtitle"><input className="input small" value={o.subtitle ?? ""} onChange={(e) => set({ subtitle: e.target.value || undefined })} /></Field>
        <Field label="X axis label"><input className="input small" value={o.xLabel ?? ""} onChange={(e) => set({ xLabel: e.target.value || undefined })} /></Field>
        <Field label="Y axis label"><input className="input small" value={o.yLabel ?? ""} onChange={(e) => set({ yLabel: e.target.value || undefined })} /></Field>
        <Field label="Legend"><select className="select small" value={o.legend ?? "auto"} onChange={(e) => set({ legend: e.target.value === "auto" ? undefined : (e.target.value as ChartSpec["options"]["legend"]) })}><option value="auto">Auto</option><option value="top">Top</option><option value="right">Right</option><option value="bottom">Bottom</option><option value="none">Hidden</option></select></Field>
        <Field label="Decimals"><input className="input small" type="number" min={0} max={4} value={o.decimals ?? ""} onChange={(e) => set({ decimals: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="theme" /></Field>
        <Field label="Font size"><input className="input small" type="number" min={8} max={24} value={o.fontSize ?? ""} onChange={(e) => set({ fontSize: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="12" /></Field>
        <Field label="Font family"><input className="input small" value={o.fontFamily ?? ""} onChange={(e) => set({ fontFamily: e.target.value || undefined })} placeholder="theme font" /></Field>
        <Field label="Line width"><input className="input small" type="number" min={1} max={8} value={o.lineWidth ?? ""} onChange={(e) => set({ lineWidth: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="2" /></Field>
        <Field label="Marker size"><input className="input small" type="number" min={1} max={16} value={o.markerSize ?? ""} onChange={(e) => set({ markerSize: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="4" /></Field>
        <Field label="Width"><input className="input small" type="number" min={240} max={1600} value={o.width ?? ""} onChange={(e) => set({ width: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="720" /></Field>
        <Field label="Height"><input className="input small" type="number" min={160} max={1200} value={o.height ?? ""} onChange={(e) => set({ height: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="380" /></Field>
        <Field label="Orientation"><select className="select small" value={o.orientation ?? "auto"} onChange={(e) => set({ orientation: e.target.value === "auto" ? undefined : (e.target.value as "horizontal" | "vertical") })}><option value="auto">Chart default</option><option value="vertical">Vertical</option><option value="horizontal">Horizontal</option></select></Field>
        <Field label="Sort"><select className="select small" value={o.sort ?? "none"} onChange={(e) => set({ sort: e.target.value as ChartSpec["options"]["sort"] })}><option value="none">Data order</option><option value="desc">Value ↓</option><option value="asc">Value ↑</option><option value="label">Label A–Z</option></select></Field>
        <Field label="Top N"><input className="input small" type="number" min={1} value={o.topN ?? ""} onChange={(e) => set({ topN: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="all" /></Field>
        <Field label="Background"><input className="input small" value={o.background ?? ""} onChange={(e) => set({ background: e.target.value || undefined })} placeholder="#ffffff" /></Field>
        <Field label="Benchmark line"><input className="input small" type="number" value={o.benchmark?.value ?? ""} onChange={(e) => set({ benchmark: e.target.value === "" ? null : { value: Number(e.target.value), label: o.benchmark?.label } })} placeholder="none" /></Field>
        <Field label="Target line"><input className="input small" type="number" value={o.target?.value ?? ""} onChange={(e) => set({ target: e.target.value === "" ? null : { value: Number(e.target.value), label: o.target?.label } })} placeholder="none" /></Field>
        <Field label="Report theme"><select className="select small" value={spec.themeId ?? ""} onChange={(e) => onChange({ ...spec, themeId: e.target.value || null })}><option value="">Default</option>{themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
      </div>
      <div className="ax-toggles">
        {([["dataLabels", "Data labels"], ["gridLines", "Grid lines"], ["percent", "Show as %"], ["showSignificance", "Significance letters"], ["showCI", "Confidence intervals"], ["showBase", "Base size"]] as [keyof ChartSpec["options"], string][]).map(([k, label]) => (
          <label key={k} className="ax-toggle"><input type="checkbox" checked={(o[k] as boolean | undefined) ?? (k === "showBase" || k === "dataLabels" || k === "gridLines" || k === "showSignificance")} onChange={(e) => set({ [k]: e.target.checked } as Partial<ChartSpec["options"]>)} /> {label}</label>
        ))}
      </div>
      {cats.length > 0 && cats.length <= 40 && (
        <details className="ax-details"><summary>Show / hide categories</summary>
          <div className="ax-chips">{cats.map((c) => { const hidden = o.hiddenCategories?.includes(c); return <button key={c} type="button" className={`ax-chip ${hidden ? "" : "on"}`} onClick={() => set({ hiddenCategories: hidden ? (o.hiddenCategories ?? []).filter((x) => x !== c) : [...(o.hiddenCategories ?? []), c] })}>{c}</button>; })}</div>
        </details>
      )}
      <div className="ax-cust-grid">
        <Field label="Footnote"><input className="input small" value={o.footnote ?? ""} onChange={(e) => set({ footnote: e.target.value || undefined })} /></Field>
        <Field label="Source"><input className="input small" value={o.source ?? ""} onChange={(e) => set({ source: e.target.value || undefined })} /></Field>
        <Field label="Notes"><input className="input small" value={o.notes ?? ""} onChange={(e) => set({ notes: e.target.value || undefined })} /></Field>
        <Field label="Palette (comma-separated hex)"><input className="input small" value={o.colors?.join(", ") ?? ""} onChange={(e) => set({ colors: e.target.value.trim() ? e.target.value.split(",").map((x) => x.trim()).filter(Boolean) : undefined })} placeholder="theme palette" /></Field>
      </div>
    </div>
  );
}

export function ChartGallery({ result, current, onPick, recommendations }: { result: AnalysisResult; current: ChartType; onPick: (t: ChartType) => void; recommendations: ChartRecommendation[] }) {
  const available = new Set(chartsAvailable(result));
  const [family, setFamily] = React.useState<string>("recommended");
  const items = family === "recommended" ? recommendations.map((r) => CHART_CATALOG.find((c) => c.type === r.type)!).filter(Boolean) : CHART_CATALOG.filter((c) => c.family === family);
  return (
    <div className="ax-gallery" data-testid="ax-gallery">
      <div className="ax-gallery-fams">
        <button className={`ax-fam ${family === "recommended" ? "on" : ""}`} onClick={() => setFamily("recommended")}>★ Recommended</button>
        {CHART_FAMILIES.map((f) => <button key={f.family} className={`ax-fam ${family === f.family ? "on" : ""}`} onClick={() => setFamily(f.family)}>{f.label}</button>)}
      </div>
      <div className="ax-gallery-items">
        {items.map((c) => { const rec = recommendations.find((r) => r.type === c.type); const ok = available.has(c.type); return (
          <button key={c.type} className={`ax-gitem ${current === c.type ? "on" : ""} ${ok ? "" : "off"}`} disabled={!ok} onClick={() => onPick(c.type)} title={ok ? rec?.reason ?? c.description : `Needs data this analysis does not produce (${c.needs.join(", ")})`} data-testid={`ax-chart-${c.type}`}>
            <span className="ax-gitem-name">{rec ? "★ " : ""}{c.label}</span><span className="ax-gitem-desc">{rec?.reason ?? c.description}</span>
          </button>); })}
        {!items.length && <div className="muted">No charts in this family fit the result.</div>}
      </div>
    </div>
  );
}

export interface ResultViewProps {
  result: AnalysisResult;
  recommendations: ChartRecommendation[];
  spec: ChartSpec;
  onSpec: (s: ChartSpec) => void;
  theme: ReportTheme | null;
  themes: { id: string; name: string }[];
  onSelectCategory?: (c: string | null) => void;
  selected?: string | null;
  actions?: React.ReactNode;
}

export function ResultView(p: ResultViewProps) {
  const [tab, setTab] = React.useState<"chart" | "tables" | "tests" | "insights">("chart");
  const [customize, setCustomize] = React.useState(false);
  const [segIdx, setSegIdx] = React.useState<number | null>(null);
  const r = p.result;
  const spec = segIdx == null ? p.spec : { ...p.spec, options: { ...p.spec.options, segmentIndex: segIdx } };
  return (
    <div className="ax-result" data-testid="ax-result">
      <div className="ax-result-head">
        <div>
          <div className="ax-result-title">{r.name}</div>
          <div className="muted" style={{ fontSize: 12 }} data-testid="ax-base">n = {r.base.n}{r.base.weightedN !== r.base.n ? ` · weighted n = ${r.base.weightedN}` : ""} · {r.base.filtered} of {r.base.total} responses in scope · computed {new Date(r.computedAt).toLocaleTimeString()}</div>
        </div>
        <span className="grow" />
        {p.actions}
      </div>
      {r.warnings.length > 0 && <div className="ax-warnings" data-testid="ax-warnings">{r.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>}
      <div className="ax-tabs">
        {(["chart", "tables", "tests", "insights"] as const).map((t) => <button key={t} className={`ax-tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{t === "chart" ? "Chart" : t === "tables" ? `Tables (${r.tables.length})` : t === "tests" ? `Tests (${r.tests.length})` : `Insights (${r.insights.length})`}</button>)}
        <span className="grow" />
        {tab === "chart" && r.segments?.length ? <select className="select small" value={segIdx ?? ""} onChange={(e) => setSegIdx(e.target.value === "" ? null : Number(e.target.value))} data-testid="ax-segment-switch"><option value="">All respondents</option>{r.segments.map((s, i) => <option key={i} value={i}>{s.name} (n = {s.n})</option>)}</select> : null}
        {tab === "chart" && <button className={`btn small ${customize ? "primary" : ""}`} onClick={() => setCustomize(!customize)} data-testid="ax-customize-toggle">Customize</button>}
      </div>
      {tab === "chart" && (
        <div className="ax-chart-area">
          <div className="ax-chart-main">
            <Chart result={r} spec={spec} theme={p.theme} onSelect={p.onSelectCategory} selected={p.selected} />
            <ChartGallery result={r} current={p.spec.type} onPick={(t) => p.onSpec({ ...p.spec, type: t })} recommendations={p.recommendations} />
          </div>
          {customize && <ChartCustomizer spec={p.spec} onChange={p.onSpec} themes={p.themes} result={r} />}
        </div>
      )}
      {tab === "tables" && <div className="ax-tables">{r.tables.map((t) => <div key={t.id} className="card"><div className="card-title">{t.title}</div><ResultTableView table={t} /></div>)}{!r.tables.length && <div className="muted">This analysis produced no tables.</div>}</div>}
      {tab === "tests" && <div className="card">{r.tests.length ? <table className="ax-table"><thead><tr><th>Test</th><th className="num">Statistic</th><th>df</th><th>p-value</th><th>Effect size</th><th>Note</th></tr></thead><tbody>{r.tests.map((t, i) => <tr key={i}><td>{t.test.replace(/_/g, " ")}</td><td className="num">{t.statistic == null ? "—" : t.statistic.toFixed(3)}</td><td>{Array.isArray(t.df) ? t.df.map((d) => Math.round(d * 10) / 10).join(", ") : t.df == null ? "" : Math.round(t.df * 10) / 10}</td><td className={t.p != null && t.p < 0.05 ? "ax-sig-p" : ""}>{t.p == null ? "—" : t.p < 0.001 ? "< .001" : t.p.toFixed(3)}</td><td>{t.effectSize ? `${t.effectSize.name} = ${t.effectSize.value?.toFixed(3) ?? "—"}` : ""}</td><td className="muted">{t.note ?? ""}</td></tr>)}</tbody></table> : <div className="muted">No statistical tests for this analysis.</div>}</div>}
      {tab === "insights" && <div className="card"><ul className="ax-insights">{r.insights.map((s, i) => <li key={i}>{s}</li>)}</ul>{!r.insights.length && <div className="muted">No insights were generated.</div>}<div className="muted" style={{ fontSize: 11, marginTop: 8 }}>Every statement above is computed from the tables of this analysis (n = {r.base.n}).</div></div>}
    </div>
  );
}
