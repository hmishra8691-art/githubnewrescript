"use client";
import React from "react";
import type { AnalysisResult, ChartRecommendation, ChartSpec, ChartType, ReportTheme } from "@rescript/analytics";
import { CHART_CATALOG, CHART_FAMILIES, chartsAvailable } from "@rescript/analytics";
import { Chart } from "./charts/Chart";
import { ProTable, tableToTsv, type TableFormatting } from "./ProTable";
import { downloadBlob } from "./api";

/**
 * RESULT + CHART WORKBENCH (§9, §10, §29, §30, §31). Shows the tables an
 * analysis produced, the recommended charts, the full gallery by family, and
 * the customisation panel. Styling changes live in the ChartSpec only — the
 * result underneath is never touched (§17).
 *
 * Two views of the same result: `results` (tables, tests, insights, with the
 * chart as a first tab) and `chart` (the visualization workbench: a large
 * chart, the gallery, the customizer, full screen, PNG / SVG).
 */

export function ChartCustomizer({ spec, onChange, themes, result }: { spec: ChartSpec; onChange: (s: ChartSpec) => void; themes: { id: string; name: string }[]; result: AnalysisResult }) {
  const o = spec.options;
  const set = (patch: Partial<ChartSpec["options"]>) => onChange({ ...spec, options: { ...o, ...patch } });
  const cats = result.chart.categories ?? [];
  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="ax-field"><span>{label}</span>{children}</label>;
  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => <div className="ax-cust-sect"><div className="ax-cust-title">{title}</div>{children}</div>;
  return (
    <div className="ax-customize" data-testid="ax-customize">
      <Section title="Titles & axes">
        <div className="ax-cust-grid">
          <Field label="Title"><input className="input small" value={o.title ?? ""} onChange={(e) => set({ title: e.target.value || undefined })} placeholder={result.name} /></Field>
          <Field label="Subtitle"><input className="input small" value={o.subtitle ?? ""} onChange={(e) => set({ subtitle: e.target.value || undefined })} /></Field>
          <Field label="X axis label"><input className="input small" value={o.xLabel ?? ""} onChange={(e) => set({ xLabel: e.target.value || undefined })} /></Field>
          <Field label="Y axis label"><input className="input small" value={o.yLabel ?? ""} onChange={(e) => set({ yLabel: e.target.value || undefined })} /></Field>
          <Field label="Legend"><select className="select small" value={o.legend ?? "auto"} onChange={(e) => set({ legend: e.target.value === "auto" ? undefined : (e.target.value as ChartSpec["options"]["legend"]) })}><option value="auto">Auto</option><option value="top">Top</option><option value="right">Right</option><option value="bottom">Bottom</option><option value="none">Hidden</option></select></Field>
          <Field label="Orientation"><select className="select small" value={o.orientation ?? "auto"} onChange={(e) => set({ orientation: e.target.value === "auto" ? undefined : (e.target.value as "horizontal" | "vertical") })}><option value="auto">Chart default</option><option value="vertical">Vertical</option><option value="horizontal">Horizontal</option></select></Field>
        </div>
      </Section>
      <Section title="Data">
        <div className="ax-cust-grid">
          <Field label="Sort"><select className="select small" value={o.sort ?? "none"} onChange={(e) => set({ sort: e.target.value as ChartSpec["options"]["sort"] })}><option value="none">Data order</option><option value="desc">Value ↓</option><option value="asc">Value ↑</option><option value="label">Label A–Z</option></select></Field>
          <Field label="Top N"><input className="input small" type="number" min={1} value={o.topN ?? ""} onChange={(e) => set({ topN: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="all" /></Field>
          <Field label="Decimals"><input className="input small" type="number" min={0} max={4} value={o.decimals ?? ""} onChange={(e) => set({ decimals: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="theme" /></Field>
          <Field label="Benchmark line"><input className="input small" type="number" value={o.benchmark?.value ?? ""} onChange={(e) => set({ benchmark: e.target.value === "" ? null : { value: Number(e.target.value), label: o.benchmark?.label } })} placeholder="none" /></Field>
          <Field label="Target line"><input className="input small" type="number" value={o.target?.value ?? ""} onChange={(e) => set({ target: e.target.value === "" ? null : { value: Number(e.target.value), label: o.target?.label } })} placeholder="none" /></Field>
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
      </Section>
      <Section title="Style">
        <div className="ax-cust-grid">
          <Field label="Report theme"><select className="select small" value={spec.themeId ?? ""} onChange={(e) => onChange({ ...spec, themeId: e.target.value || null })}><option value="">Default</option>{themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          <Field label="Font size"><input className="input small" type="number" min={8} max={24} value={o.fontSize ?? ""} onChange={(e) => set({ fontSize: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="12" /></Field>
          <Field label="Font family"><input className="input small" value={o.fontFamily ?? ""} onChange={(e) => set({ fontFamily: e.target.value || undefined })} placeholder="theme font" /></Field>
          <Field label="Line width"><input className="input small" type="number" min={1} max={8} value={o.lineWidth ?? ""} onChange={(e) => set({ lineWidth: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="2" /></Field>
          <Field label="Marker size"><input className="input small" type="number" min={1} max={16} value={o.markerSize ?? ""} onChange={(e) => set({ markerSize: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="4" /></Field>
          <Field label="Width"><input className="input small" type="number" min={240} max={1600} value={o.width ?? ""} onChange={(e) => set({ width: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="720" /></Field>
          <Field label="Height"><input className="input small" type="number" min={160} max={1200} value={o.height ?? ""} onChange={(e) => set({ height: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="380" /></Field>
          <Field label="Background"><input className="input small" value={o.background ?? ""} onChange={(e) => set({ background: e.target.value || undefined })} placeholder="#ffffff" /></Field>
          <Field label="Palette (comma-separated hex)"><input className="input small" value={o.colors?.join(", ") ?? ""} onChange={(e) => set({ colors: e.target.value.trim() ? e.target.value.split(",").map((x) => x.trim()).filter(Boolean) : undefined })} placeholder="theme palette" /></Field>
        </div>
      </Section>
      <Section title="Annotations">
        <div className="ax-cust-grid">
          <Field label="Footnote"><input className="input small" value={o.footnote ?? ""} onChange={(e) => set({ footnote: e.target.value || undefined })} /></Field>
          <Field label="Source"><input className="input small" value={o.source ?? ""} onChange={(e) => set({ source: e.target.value || undefined })} /></Field>
          <Field label="Notes"><input className="input small" value={o.notes ?? ""} onChange={(e) => set({ notes: e.target.value || undefined })} /></Field>
        </div>
      </Section>
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

/* ------------------------------------------------------------ chart export (client side, from the SVG on screen) */

function svgOf(host: HTMLElement | null): SVGSVGElement | null { return host?.querySelector("svg") ?? null; }
function serialize(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const vb = svg.viewBox.baseVal; clone.setAttribute("width", String(vb.width || svg.clientWidth)); clone.setAttribute("height", String(vb.height || svg.clientHeight));
  const bg = getComputedStyle(svg.parentElement as Element).backgroundColor;
  if (bg && bg !== "rgba(0, 0, 0, 0)") { const r = document.createElementNS("http://www.w3.org/2000/svg", "rect"); r.setAttribute("width", "100%"); r.setAttribute("height", "100%"); r.setAttribute("fill", bg); clone.insertBefore(r, clone.firstChild); }
  return new XMLSerializer().serializeToString(clone);
}
export function downloadSvg(host: HTMLElement | null, name: string) {
  const svg = svgOf(host); if (!svg) return;
  downloadBlob(new Blob([serialize(svg)], { type: "image/svg+xml" }), `${name}.svg`);
}
/** a 3× raster of the chart — presentation quality, not a screenshot */
export function downloadPng(host: HTMLElement | null, name: string, scale = 3) {
  const svg = svgOf(host); if (!svg) return;
  const xml = serialize(svg);
  const vb = svg.viewBox.baseVal; const w = (vb.width || svg.clientWidth) * scale, h = (vb.height || svg.clientHeight) * scale;
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d"); if (!g) return;
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
    c.toBlob((b) => { if (b) downloadBlob(b, `${name}.png`); }, "image/png");
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
}

/**
 * §43 — the same raster as `downloadPng`, handed back instead of downloaded.
 *
 * The PowerPoint export uses it for maps: pptxgenjs has no map chart, and the
 * only thing in the system that can draw one is the renderer that already
 * did. Resolves null rather than rejecting — and gives up after a moment —
 * because an export must not hang or fail on a picture it can do without.
 */
export function svgToPngDataUrl(host: HTMLElement | null, scale = 2, timeoutMs = 4000): Promise<string | null> {
  const svg = svgOf(host);
  if (!svg) return Promise.resolve(null);
  let xml: string;
  try { xml = serialize(svg); } catch { return Promise.resolve(null); }
  const vb = svg.viewBox.baseVal;
  const w = Math.max(1, Math.round((vb.width || svg.clientWidth) * scale));
  const h = Math.max(1, Math.round((vb.height || svg.clientHeight) * scale));
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(null), timeoutMs);
    const img = new Image();
    img.onload = () => {
      clearTimeout(timer);
      try {
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        const g = c.getContext("2d");
        if (!g) return done(null);
        g.fillStyle = "#ffffff"; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
        done(c.toDataURL("image/png"));
      } catch { done(null); }
    };
    img.onerror = () => { clearTimeout(timer); done(null); };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  });
}

/** Every geographic chart on screen, rastered and keyed by the block it belongs to. */
export async function mapImagesOnScreen(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (typeof document === "undefined") return out;
  const hosts = Array.from(document.querySelectorAll<HTMLElement>("[data-block-id]"));
  for (const host of hosts) {
    const id = host.dataset.blockId;
    const chart = host.querySelector<HTMLElement>('[data-testid="ax-chart"]');
    const type = chart?.getAttribute("data-chart-type") ?? "";
    if (!id || !/^(map_|choropleth$)/.test(type)) continue;
    const png = await svgToPngDataUrl(chart, 2);
    if (png) out[id] = png;
  }
  return out;
}

/** the chart with its workbench chrome: full screen, PNG, SVG */
export function ChartFrame({ result, spec, theme, onSelect, selected, name, large }: { result: AnalysisResult; spec: ChartSpec; theme: ReportTheme | null; onSelect?: (c: string | null) => void; selected?: string | null; name: string; large?: boolean }) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const [full, setFull] = React.useState(false);
  React.useEffect(() => { if (!full) return; const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [full]);
  const file = (name || result.name || "chart").replace(/[^\w.-]+/g, "_").slice(0, 80);
  return (
    <div className="ax-chart-frame" data-testid="ax-chart-frame">
      <div className="ax-chart-tools">
        <button type="button" className="btn small ghost" onClick={() => setFull(true)} title="Show the chart full screen (Esc to leave)" data-testid="ax-chart-full">⤢ Full screen</button>
        <button type="button" className="btn small ghost" onClick={() => downloadPng(host.current, file)} title="Download a high-resolution PNG" data-testid="ax-chart-png">PNG</button>
        <button type="button" className="btn small ghost" onClick={() => downloadSvg(host.current, file)} title="Download the vector SVG" data-testid="ax-chart-svg">SVG</button>
      </div>
      <div ref={host}><Chart result={result} spec={spec} theme={theme} onSelect={onSelect} selected={selected} height={large ? Math.max(spec.options.height ?? 0, 460) : undefined} width={large ? Math.max(spec.options.width ?? 0, 960) : undefined} /></div>
      {full && (
        <div className="ax-fullscreen" role="dialog" aria-label="Chart full screen" data-testid="ax-fullscreen" onClick={() => setFull(false)}>
          <div className="ax-fullscreen-body" onClick={(e) => e.stopPropagation()}>
            <div className="ax-chart-tools"><span className="ax-fullscreen-title">{spec.options.title ?? result.name}</span><span className="grow" /><button type="button" className="btn small ghost" onClick={() => downloadPng(host.current, file)}>PNG</button><button type="button" className="btn small ghost" onClick={() => downloadSvg(host.current, file)}>SVG</button><button type="button" className="btn small" onClick={() => setFull(false)}>Close</button></div>
            <Chart result={result} spec={spec} theme={theme} width={1400} height={760} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ the result view */

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
  /** `results` — chart / tables / tests / insights tabs; `chart` — the visualization workbench */
  view?: "results" | "chart";
  /** table formatting saved with the analysis (heat, counts, decimals…) */
  formatting?: TableFormatting;
  onFormatting?: (f: TableFormatting) => void;
}

export function ResultView(p: ResultViewProps) {
  const [tab, setTab] = React.useState<"chart" | "tables" | "tests" | "insights">("chart");
  const [customize, setCustomize] = React.useState(false);
  const [segIdx, setSegIdx] = React.useState<number | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const r = p.result;
  const view = p.view ?? "results";
  const spec = segIdx == null ? p.spec : { ...p.spec, options: { ...p.spec.options, segmentIndex: segIdx } };
  const f = p.formatting ?? {};
  const setF = (patch: TableFormatting) => p.onFormatting?.({ ...f, ...patch });
  const showChart = view === "chart" || tab === "chart";
  const copy = async (t: AnalysisResult["tables"][number]) => { try { await navigator.clipboard.writeText(tableToTsv(t, f.decimals)); setCopied(t.id); setTimeout(() => setCopied(null), 1500); } catch { /* clipboard unavailable */ } };
  const segmentSwitch = r.segments?.length ? <select className="select small" value={segIdx ?? ""} onChange={(e) => setSegIdx(e.target.value === "" ? null : Number(e.target.value))} data-testid="ax-segment-switch"><option value="">All respondents</option>{r.segments.map((s, i) => <option key={i} value={i}>{s.name} (n = {s.n})</option>)}</select> : null;
  return (
    <div className="ax-result" data-testid="ax-result" data-view={view}>
      <div className="ax-result-head">
        <div>
          <div className="ax-result-title">{r.name}</div>
          <div className="muted" style={{ fontSize: 13 }} data-testid="ax-base">n = {r.base.n}{r.base.weightedN !== r.base.n ? ` · weighted n = ${r.base.weightedN}` : ""} · {r.base.filtered} of {r.base.total} responses in scope · computed {new Date(r.computedAt).toLocaleTimeString()}</div>
        </div>
        <span className="grow" />
        {p.actions}
      </div>
      {r.warnings.length > 0 && <div className="ax-warnings" data-testid="ax-warnings">{r.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>}
      {view === "results" && (
        <div className="ax-tabs">
          {(["chart", "tables", "tests", "insights"] as const).map((t) => <button key={t} className={`ax-tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{t === "chart" ? "Chart" : t === "tables" ? `Tables (${r.tables.length})` : t === "tests" ? `Tests (${r.tests.length})` : `Insights (${r.insights.length})`}</button>)}
          <span className="grow" />
          {tab === "chart" && segmentSwitch}
          {tab === "chart" && <button className={`btn small ${customize ? "primary" : ""}`} onClick={() => setCustomize(!customize)} data-testid="ax-customize-toggle">Customize</button>}
          {tab === "tables" && (
            <div className="ax-fmt" data-testid="ax-table-format">
              <label className="ax-toggle" title="Shade cells by value"><input type="checkbox" checked={!!f.heat} onChange={(e) => setF({ heat: e.target.checked })} /> Heat</label>
              <label className="ax-toggle" title="Print the count under each percentage"><input type="checkbox" checked={!!f.showCounts} onChange={(e) => setF({ showCounts: e.target.checked })} /> Counts</label>
              <label className="ax-toggle" title="Tint significant cells"><input type="checkbox" checked={f.highlightSig !== false} onChange={(e) => setF({ highlightSig: e.target.checked })} /> Highlight sig.</label>
              <label className="ax-toggle" title="Compact rows"><input type="checkbox" checked={!!f.dense} onChange={(e) => setF({ dense: e.target.checked })} /> Dense</label>
              <label className="ax-toggle" title="Decimals">Dec. <input className="input small" type="number" min={0} max={4} style={{ width: 52 }} value={f.decimals ?? ""} placeholder="1" onChange={(e) => setF({ decimals: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
            </div>
          )}
        </div>
      )}
      {view === "chart" && (
        <div className="ax-tabs">
          <span className="ax-tabs-title">Visualization</span>
          <span className="grow" />
          {segmentSwitch}
          <button className={`btn small ${customize ? "primary" : ""}`} onClick={() => setCustomize(!customize)} data-testid="ax-customize-toggle">Customize</button>
        </div>
      )}
      {showChart && (
        <div className="ax-chart-area">
          <div className="ax-chart-main">
            <ChartFrame result={r} spec={spec} theme={p.theme} onSelect={p.onSelectCategory} selected={p.selected} name={spec.options.title ?? r.name} large={view === "chart"} />
            <ChartGallery result={r} current={p.spec.type} onPick={(t) => p.onSpec({ ...p.spec, type: t })} recommendations={p.recommendations} />
          </div>
          {customize && <ChartCustomizer spec={p.spec} onChange={p.onSpec} themes={p.themes} result={r} />}
        </div>
      )}
      {view === "results" && tab === "tables" && (
        <div className="ax-tables">
          {r.tables.map((t) => (
            <div key={t.id} className="card ax-table-card">
              <div className="ax-table-card-head"><div className="card-title">{t.title}</div><span className="grow" /><button type="button" className="btn small ghost" onClick={() => copy(t)} title="Copy as tab-separated text for a spreadsheet">{copied === t.id ? "Copied" : "Copy"}</button></div>
              <ProTable table={t} formatting={f} />
            </div>
          ))}
          {!r.tables.length && <div className="ax-empty"><div className="ax-empty-t">No tables</div><div className="ax-empty-d">This analysis produced charts and statistics but no table.</div></div>}
        </div>
      )}
      {view === "results" && tab === "tests" && <div className="card">{r.tests.length ? <table className="ax-table"><thead><tr><th>Test</th><th className="num">Statistic</th><th>df</th><th>p-value</th><th>Effect size</th><th>Note</th></tr></thead><tbody>{r.tests.map((t, i) => <tr key={i}><td>{t.test.replace(/_/g, " ")}</td><td className="num">{t.statistic == null ? "—" : t.statistic.toFixed(3)}</td><td>{Array.isArray(t.df) ? t.df.map((d) => Math.round(d * 10) / 10).join(", ") : t.df == null ? "" : Math.round(t.df * 10) / 10}</td><td className={t.p != null && t.p < 0.05 ? "ax-sig-p" : ""}>{t.p == null ? "—" : t.p < 0.001 ? "< .001" : t.p.toFixed(3)}</td><td>{t.effectSize ? `${t.effectSize.name} = ${t.effectSize.value?.toFixed(3) ?? "—"}` : ""}</td><td className="muted">{t.note ?? ""}</td></tr>)}</tbody></table> : <div className="muted">No statistical tests for this analysis.</div>}</div>}
      {view === "results" && tab === "insights" && <div className="card"><ul className="ax-insights">{r.insights.map((s, i) => <li key={i}>{s}</li>)}</ul>{!r.insights.length && <div className="muted">No insights were generated.</div>}<div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>Every statement above is computed from the tables of this analysis (n = {r.base.n}).</div></div>}
    </div>
  );
}
