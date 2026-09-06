"use client";
import React from "react";
import type { AnalysisResult, ChartSpec, ChartType, ReportTheme, ChartData, TreeNode } from "@rescript/analytics";
import { DEFAULT_THEME, seriesForChart } from "@rescript/analytics";

/**
 * THE CHART LIBRARY — one SVG renderer for every chart family (§8, §10, §15).
 *
 * Every chart takes the analysis result's chart-ready data (`categories ×
 * series`, `matrix`, `points`, `kpis`, `words`, `tree`, `dendrogram`, `nodes`)
 * plus a `ChartSpec` (type + options) and a `ReportTheme`, and draws in plain
 * SVG — no chart dependency to keep in step with the PowerPoint export, and the
 * same `seriesForChart` sort / top-N / hidden-category rules the export uses,
 * so the slide matches the screen.
 *
 * Interaction: hover tooltips, legend toggling (local, cosmetic) and an
 * `onSelect(category)` callback the workspace uses for click-to-filter and
 * cross-filtering (§15). Shared viewers get the same component with the
 * builder hidden — interaction never changes a saved definition.
 */

export interface ChartProps {
  result: AnalysisResult;
  spec: ChartSpec;
  theme?: ReportTheme | null;
  width?: number;
  height?: number;
  onSelect?: (category: string | null) => void;
  selected?: string | null;
  compact?: boolean;
}

const fmt = (v: number | null | undefined, d = 0, pct = false) => (v == null || !Number.isFinite(v) ? "—" : `${v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 })}${pct ? "%" : ""}`);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

interface Ctx { W: number; H: number; theme: ReportTheme; colors: string[]; font: string; fs: number; decimals: number; pct: boolean; opts: ChartSpec["options"]; sel?: string | null; onSelect?: (c: string | null) => void; hover: [string | null, (s: string | null) => void]; textColor: string; grid: string; subtle: string }

function niceMax(v: number): number { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; const n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10; return n * p; }
function ticks(min: number, max: number, n = 5): number[] { const step = (max - min) / n; return Array.from({ length: n + 1 }, (_, i) => min + i * step); }

export function Chart(props: ChartProps) {
  const theme = props.theme ?? DEFAULT_THEME;
  const spec = props.spec;
  const o = spec.options ?? {};
  const W = props.width ?? o.width ?? 720, H = props.height ?? o.height ?? (props.compact ? 240 : 380);
  const [hover, setHover] = React.useState<string | null>(null);
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());
  const series = React.useMemo(() => seriesForChart(props.result, spec), [props.result, spec]);
  const shown = series.filter((s) => !hidden.has(s.name));
  const ctx: Ctx = {
    W, H, theme, colors: o.colors?.length ? o.colors : theme.colors.palette, font: o.fontFamily ?? theme.fontFamily, fs: o.fontSize ?? theme.typography?.baseSize ?? 12,
    decimals: o.decimals ?? theme.chart?.decimals ?? (series[0]?.meta?.pct ? 0 : 1), pct: !!series[0]?.meta?.pct || props.result.chart.valueFormat === "pct", opts: o, sel: props.selected, onSelect: props.onSelect,
    hover: [hover, setHover], textColor: theme.colors.text, grid: "#e5e9f0", subtle: theme.colors.subtle,
  };
  const d = props.result.chart;
  const title = o.title ?? spec.name;
  const legendPos = o.legend ?? (shown.length > 1 ? "bottom" : "none");
  const top = (title ? 26 : 0) + (o.subtitle ? 18 : 0);
  const legendH = legendPos === "bottom" || legendPos === "top" ? 22 : 0;
  const notesH = o.footnote || o.source || o.showBase !== false ? 16 : 0;
  const inner = { x: 0, y: top + (legendPos === "top" ? legendH : 0), w: legendPos === "right" ? W - 150 : W, h: H - top - legendH - notesH - 6 };

  let body: React.ReactNode;
  const t = spec.type;
  if (t === "table") body = <foreignObject x={0} y={inner.y} width={W} height={inner.h}><div style={{ overflow: "auto", maxHeight: inner.h }}><ResultTableView table={props.result.tables[0]} /></div></foreignObject>;
  else if (["pie", "donut", "donut_semi", "donut_nested", "donut_radial", "segment_size"].includes(t)) body = <PieChart ctx={ctx} inner={inner} series={shown} type={t} />;
  else if (["line", "line_multi", "spline", "step_line", "rolling_average", "wave_trend", "yoy_trend", "mom_trend", "area", "area_stacked", "sentiment_trend", "demand_curve", "purchase_probability", "revenue_curve", "price_elasticity", "price_sensitivity", "bump"].includes(t)) body = <LineChart ctx={ctx} inner={inner} series={shown} type={t} />;
  else if (["scatter", "bubble", "scatter_trendline", "scatter_ci", "heatmap_ipa", "segment_bubble", "map_bubble", "map_heat"].includes(t)) body = <ScatterChart ctx={ctx} inner={inner} data={d} type={t} />;
  else if (["heatmap", "heatmap_crosstab", "heatmap_correlation", "heatmap_satisfaction", "heatmap_quota", "correlation_matrix", "correlogram", "rank_heatmap", "segment_heatmap", "maxdiff_heatmap", "maxdiff_segment", "theme_segment_heatmap", "marimekko"].includes(t)) body = <HeatmapChart ctx={ctx} inner={inner} data={d} series={shown} type={t} />;
  else if (["radar", "spider", "radar_multi", "radar_brand", "radar_segment"].includes(t)) body = <RadarChart ctx={ctx} inner={inner} series={shown} type={t} />;
  else if (["funnel", "funnel_brand", "funnel_purchase", "funnel_awareness", "funnel_dropout"].includes(t)) body = <FunnelChart ctx={ctx} inner={inner} series={shown} />;
  else if (["kpi_card", "gauge", "progress_circle", "bullet", "scorecard"].includes(t)) body = <KpiChart ctx={ctx} inner={inner} data={d} type={t} result={props.result} />;
  else if (["box_plot", "violin", "strip", "beeswarm", "raincloud"].includes(t)) body = <BoxChart ctx={ctx} inner={inner} data={d} type={t} />;
  else if (["treemap", "sunburst", "theme_distribution", "topic_distribution", "part_worth", "utility_by_level", "wtp"].includes(t)) body = <TreeChart ctx={ctx} inner={inner} data={d} type={t} series={shown} />;
  else if (t === "dendrogram") body = <Dendrogram ctx={ctx} inner={inner} data={d} />;
  else if (["word_cloud"].includes(t)) body = <WordCloud ctx={ctx} inner={inner} data={d} />;
  else if (["sankey", "alluvial", "chord", "network"].includes(t)) body = <NetworkChart ctx={ctx} inner={inner} data={d} type={t} />;
  else if (["waterfall"].includes(t)) body = <WaterfallChart ctx={ctx} inner={inner} series={shown} />;
  else if (t === "parallel_coordinates") body = <ParallelChart ctx={ctx} inner={inner} series={shown} />;
  else if (["histogram", "density"].includes(t)) body = <BarChart ctx={ctx} inner={inner} series={shown} type={t === "density" ? "area" : "bar_vertical"} tight />;
  else if (["map_country", "map_state", "choropleth"].includes(t)) body = <BarChart ctx={ctx} inner={inner} series={shown} type="bar_horizontal" note="Geographic rendering shows values by region as ranked bars" />;
  else body = <BarChart ctx={ctx} inner={inner} series={shown} type={t} />;

  const base = props.result.base;
  return (
    <div className="ax-chart" style={{ position: "relative", fontFamily: ctx.font, background: o.background ?? theme.colors.background, borderRadius: 8 }} data-testid="ax-chart" data-chart-type={t}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", maxWidth: "100%" }} role="img" aria-label={title ?? props.result.name}>
        {title && <text x={0} y={16} fontSize={ctx.fs + 3} fontWeight={700} fill={ctx.textColor} fontFamily={ctx.font}>{title}</text>}
        {o.subtitle && <text x={0} y={title ? 34 : 16} fontSize={ctx.fs - 1} fill={ctx.subtle} fontFamily={ctx.font}>{o.subtitle}</text>}
        {body}
        {legendPos !== "none" && series.length > 0 && (
          <Legend ctx={ctx} series={series} hidden={hidden} toggle={(n) => setHidden((h) => { const s = new Set(h); if (s.has(n)) s.delete(n); else s.add(n); return s; })} x={legendPos === "right" ? W - 145 : 0} y={legendPos === "top" ? top + 4 : legendPos === "right" ? top + 10 : H - notesH - legendH + 4} vertical={legendPos === "right"} />
        )}
        {notesH > 0 && (
          <text x={0} y={H - 3} fontSize={ctx.fs - 3} fill={ctx.subtle} fontFamily={ctx.font}>
            {[o.showBase === false ? null : `n = ${base.n}${base.weightedN !== base.n ? ` (weighted ${base.weightedN})` : ""}`, o.footnote, o.source ? `Source: ${o.source}` : null].filter(Boolean).join("  ·  ")}
          </text>
        )}
      </svg>
      {hover && <div className="ax-tip" style={{ position: "absolute", left: 8, top: 8, pointerEvents: "none" }}>{hover}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ legend */
function Legend({ ctx, series, hidden, toggle, x, y, vertical }: { ctx: Ctx; series: { name: string }[]; hidden: Set<string>; toggle: (n: string) => void; x: number; y: number; vertical: boolean }) {
  let cx = x;
  return (
    <g fontFamily={ctx.font} fontSize={ctx.fs - 2}>
      {series.map((s, i) => {
        const w = Math.min(s.name.length * (ctx.fs - 2) * 0.55 + 22, vertical ? 140 : 180);
        const el = (
          <g key={s.name} transform={`translate(${vertical ? x : cx},${vertical ? y + i * 18 : y})`} style={{ cursor: "pointer" }} onClick={() => toggle(s.name)} opacity={hidden.has(s.name) ? 0.35 : 1}>
            <rect width={10} height={10} y={2} rx={2} fill={ctx.colors[i % ctx.colors.length]} />
            <text x={14} y={11} fill={ctx.textColor}>{trunc(s.name, vertical ? 20 : 28)}</text>
          </g>
        );
        cx += w;
        return el;
      })}
    </g>
  );
}

/* ------------------------------------------------------------ bars */
function BarChart({ ctx, inner, series, type, tight, note }: { ctx: Ctx; inner: { x: number; y: number; w: number; h: number }; series: ReturnType<typeof seriesForChart>; type: ChartType | string; tight?: boolean; note?: string }) {
  if (!series.length || !series[0].labels.length) return <Empty ctx={ctx} inner={inner} />;
  const horizontal = ["bar_horizontal", "ranking_bar", "lollipop", "dot_plot", "diverging_likert", "bar_stacked_100", "maxdiff_utility", "maxdiff_preference", "attribute_importance", "coefficient_plot", "forest", "keyword_bar", "maxdiff_best_worst"].includes(type as string) || ctx.opts.orientation === "horizontal";
  const stacked = ["bar_stacked", "bar_stacked_100", "diverging_likert", "funnel"].includes(type as string);
  const pct100 = type === "bar_stacked_100" || type === "diverging_likert";
  const lollipop = type === "lollipop" || type === "dot_plot";
  const labels = series[0].labels;
  const n = labels.length, k = series.length;
  const ci = series.length === 1 ? (ctx.opts.showCI ?? ["mean_ci", "ci_plot", "error_bar", "forest", "coefficient_plot", "diff_means", "diff_proportions"].includes(type as string)) : false;
  const rawCI = ci ? series[0].ci ?? null : null;
  const totals = labels.map((_, i) => series.reduce((t, s) => t + Math.max(0, s.values[i] ?? 0), 0));
  let maxV = stacked ? Math.max(...totals) : Math.max(...series.flatMap((s) => s.values.map((v) => v ?? 0)), ...(rawCI ? rawCI.map((c) => c?.[1] ?? 0) : []));
  let minV = Math.min(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)), ...(rawCI ? rawCI.map((c) => c?.[0] ?? 0) : []));
  if (pct100) { maxV = 100; minV = 0; }
  maxV = niceMax(maxV || 1); if (minV < 0) minV = -niceMax(-minV);
  const labelW = horizontal ? clamp(Math.max(...labels.map((l) => l.length)) * (ctx.fs - 1) * 0.55, 60, inner.w * 0.35) : 0;
  const pad = { l: horizontal ? labelW + 8 : 44, r: 12, t: 8, b: horizontal ? 22 : 40 };
  const px = inner.x + pad.l, py = inner.y + pad.t, pw = inner.w - pad.l - pad.r, ph = inner.h - pad.t - pad.b;
  const scale = (v: number) => (horizontal ? px + ((v - minV) / (maxV - minV)) * pw : py + ph - ((v - minV) / (maxV - minV)) * ph);
  const zero = scale(0);
  const band = (horizontal ? ph : pw) / n, gap = tight ? 1 : band * 0.25, inner_ = band - gap, bw = stacked || lollipop ? inner_ : inner_ / k;
  const [, setHover] = ctx.hover;
  const tk = ticks(minV, maxV, 5);
  const gridOn = ctx.opts.gridLines ?? ctx.theme.chart?.gridLines ?? true;
  const dataLabels = ctx.opts.dataLabels ?? ctx.theme.chart?.dataLabels ?? true;
  // letters per category: in a grouped chart each series carries its own letters, so show the hovered/first series' letters only when a single series is drawn
  const sig = series.length === 1 ? series[0].sig ?? null : null;
  const showSig = ctx.opts.showSignificance ?? true;
  return (
    <g fontFamily={ctx.font} fontSize={ctx.fs - 2}>
      {gridOn && tk.map((v, i) => horizontal
        ? <line key={i} x1={scale(v)} x2={scale(v)} y1={py} y2={py + ph} stroke={ctx.grid} />
        : <line key={i} x1={px} x2={px + pw} y1={scale(v)} y2={scale(v)} stroke={ctx.grid} />)}
      {tk.map((v, i) => horizontal
        ? <text key={i} x={scale(v)} y={py + ph + 14} textAnchor="middle" fill={ctx.subtle}>{fmt(v, 0, pct100 || ctx.pct)}</text>
        : <text key={i} x={px - 6} y={scale(v) + 4} textAnchor="end" fill={ctx.subtle}>{fmt(v, 0, ctx.pct)}</text>)}
      {labels.map((lab, i) => {
        const b0 = (horizontal ? py : px) + i * band + gap / 2;
        let acc = 0, accNeg = 0;
        const selected = ctx.sel === lab;
        return (
          <g key={lab} opacity={ctx.sel && !selected ? 0.45 : 1} style={{ cursor: ctx.onSelect ? "pointer" : "default" }} onClick={() => ctx.onSelect?.(selected ? null : lab)}>
            {horizontal
              ? <text x={px - 8} y={b0 + inner_ / 2 + 4} textAnchor="end" fill={ctx.textColor} fontWeight={selected ? 700 : 400}>{trunc(lab, Math.floor(labelW / ((ctx.fs - 1) * 0.55)))}</text>
              : <text x={b0 + inner_ / 2} y={py + ph + 14} textAnchor="middle" fill={ctx.textColor} fontWeight={selected ? 700 : 400} transform={n > 8 ? `rotate(-30 ${b0 + inner_ / 2} ${py + ph + 14})` : undefined}>{trunc(lab, n > 8 ? 14 : Math.max(6, Math.floor(inner_ / 6)))}</text>}
            {series.map((s, j) => {
              const v = s.values[i] ?? 0;
              const color = ctx.colors[j % ctx.colors.length];
              let a: number, b: number;
              if (stacked) {
                if (type === "diverging_likert") { const half = Math.floor(k / 2); const neg = j < half || (k % 2 === 1 && j === half && false); if (neg) { a = 50 - accNeg - v; b = 50 - accNeg; accNeg += v; } else { a = 50 + acc; b = 50 + acc + v; acc += v; } if (j === Math.floor(k / 2) && k % 2 === 1) { a = 50 - v / 2 + acc - v / 2; } }
                else { a = acc; b = acc + v; acc += v; }
              } else { a = Math.min(0, v); b = Math.max(0, v); }
              const s0 = scale(a), s1 = scale(b);
              const off = stacked || lollipop ? 0 : j * bw;
              const rect = horizontal ? { x: Math.min(s0, s1), y: b0 + off, w: Math.abs(s1 - s0), h: bw } : { x: b0 + off, y: Math.min(s0, s1), w: bw, h: Math.abs(s1 - s0) };
              const label = `${s.name}: ${fmt(v, ctx.decimals, ctx.pct)}`;
              const midX = horizontal ? scale(v) : rect.x + rect.w / 2, midY = horizontal ? rect.y + rect.h / 2 : scale(v);
              return (
                <g key={s.name} onMouseEnter={() => setHover(`${lab} — ${label}`)} onMouseLeave={() => setHover(null)}>
                  {lollipop
                    ? <>{type === "lollipop" && <line x1={horizontal ? zero : midX} y1={horizontal ? midY : zero} x2={horizontal ? scale(v) : midX} y2={horizontal ? midY : scale(v)} stroke={color} strokeWidth={ctx.opts.lineWidth ?? 2} />}<circle cx={horizontal ? scale(v) : midX} cy={horizontal ? midY : scale(v)} r={ctx.opts.markerSize ?? 5} fill={color} /></>
                    : <rect x={rect.x} y={rect.y} width={Math.max(rect.w, 0)} height={Math.max(rect.h, 0)} fill={color} rx={ctx.theme.chart?.cornerRadius ?? 2} />}
                  {dataLabels && !stacked && (() => { const letter = showSig ? (series.length === 1 ? sig?.[i] : s.sig?.[i]) : ""; return horizontal
                    ? <text x={scale(v) + 4} y={midY + 4} fill={ctx.textColor} fontSize={ctx.fs - 3}>{fmt(v, ctx.decimals, ctx.pct)}{letter ? <tspan fill={ctx.theme.colors.accent} fontWeight={700}> {letter}</tspan> : null}</text>
                    : <text x={midX} y={scale(v) - 4} textAnchor="middle" fill={ctx.textColor} fontSize={ctx.fs - 3}>{fmt(v, ctx.decimals, ctx.pct)}{letter ? <tspan fill={ctx.theme.colors.accent} fontWeight={700}> {letter}</tspan> : null}</text>; })()}
                  {dataLabels && stacked && Math.abs(s1 - s0) > 22 && <text x={rect.x + rect.w / 2} y={rect.y + rect.h / 2 + 4} textAnchor="middle" fill="#fff" fontSize={ctx.fs - 3}>{fmt(v, ctx.decimals, ctx.pct)}</text>}
                </g>
              );
            })}
            {rawCI?.[i] && (horizontal
              ? <g stroke={ctx.textColor} strokeWidth={1.2}><line x1={scale(rawCI[i]![0])} x2={scale(rawCI[i]![1])} y1={b0 + inner_ / 2} y2={b0 + inner_ / 2} /><line x1={scale(rawCI[i]![0])} x2={scale(rawCI[i]![0])} y1={b0 + inner_ / 2 - 4} y2={b0 + inner_ / 2 + 4} /><line x1={scale(rawCI[i]![1])} x2={scale(rawCI[i]![1])} y1={b0 + inner_ / 2 - 4} y2={b0 + inner_ / 2 + 4} /></g>
              : <g stroke={ctx.textColor} strokeWidth={1.2}><line y1={scale(rawCI[i]![0])} y2={scale(rawCI[i]![1])} x1={b0 + inner_ / 2} x2={b0 + inner_ / 2} /><line y1={scale(rawCI[i]![0])} y2={scale(rawCI[i]![0])} x1={b0 + inner_ / 2 - 4} x2={b0 + inner_ / 2 + 4} /><line y1={scale(rawCI[i]![1])} y2={scale(rawCI[i]![1])} x1={b0 + inner_ / 2 - 4} x2={b0 + inner_ / 2 + 4} /></g>)}
          </g>
        );
      })}
      <line x1={horizontal ? zero : px} x2={horizontal ? zero : px + pw} y1={horizontal ? py : zero} y2={horizontal ? py + ph : zero} stroke={ctx.subtle} />
      {type === "pareto" && <ParetoLine ctx={ctx} series={series[0]} px={px} py={py} pw={pw} ph={ph} band={band} />}
      {ctx.opts.benchmark && <RefLine ctx={ctx} v={scale(ctx.opts.benchmark.value)} horizontal={horizontal} px={px} py={py} pw={pw} ph={ph} label={ctx.opts.benchmark.label ?? `Benchmark ${ctx.opts.benchmark.value}`} dashed />}
      {ctx.opts.target && <RefLine ctx={ctx} v={scale(ctx.opts.target.value)} horizontal={horizontal} px={px} py={py} pw={pw} ph={ph} label={ctx.opts.target.label ?? `Target ${ctx.opts.target.value}`} color={ctx.theme.colors.accent} />}
      {ctx.opts.xLabel && <text x={px + pw / 2} y={inner.y + inner.h - 2} textAnchor="middle" fill={ctx.subtle}>{ctx.opts.xLabel}</text>}
      {ctx.opts.yLabel && <text x={12} y={py + ph / 2} textAnchor="middle" fill={ctx.subtle} transform={`rotate(-90 12 ${py + ph / 2})`}>{ctx.opts.yLabel}</text>}
      {note && <text x={px} y={py - 1} fill={ctx.subtle} fontSize={ctx.fs - 4}>{note}</text>}
    </g>
  );
}


function RefLine({ ctx, v, horizontal, px, py, pw, ph, label, dashed, color }: { ctx: Ctx; v: number; horizontal: boolean; px: number; py: number; pw: number; ph: number; label: string; dashed?: boolean; color?: string }) {
  const c = color ?? ctx.subtle;
  return horizontal
    ? <g><line x1={v} x2={v} y1={py} y2={py + ph} stroke={c} strokeDasharray={dashed ? "4 3" : undefined} strokeWidth={1.5} /><text x={v + 3} y={py + 10} fill={c} fontSize={ctx.fs - 3}>{label}</text></g>
    : <g><line x1={px} x2={px + pw} y1={v} y2={v} stroke={c} strokeDasharray={dashed ? "4 3" : undefined} strokeWidth={1.5} /><text x={px + pw - 2} y={v - 3} textAnchor="end" fill={c} fontSize={ctx.fs - 3}>{label}</text></g>;
}

function ParetoLine({ ctx, series, px, py, pw, ph, band }: { ctx: Ctx; series: { values: (number | null)[] }; px: number; py: number; pw: number; ph: number; band: number }) {
  const total = series.values.reduce((t: number, v) => t + (v ?? 0), 0) || 1;
  let acc = 0;
  const pts = series.values.map((v, i) => { acc += v ?? 0; return [px + i * band + band / 2, py + ph - (acc / total) * ph] as [number, number]; });
  void pw;
  return <g><polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={ctx.theme.colors.accent} strokeWidth={2} />{pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={3} fill={ctx.theme.colors.accent} />)}</g>;
}

function Empty({ ctx, inner }: { ctx: Ctx; inner: { x: number; y: number; w: number; h: number } }) {
  return <text x={inner.x + inner.w / 2} y={inner.y + inner.h / 2} textAnchor="middle" fill={ctx.subtle} fontFamily={ctx.font} fontSize={ctx.fs}>No data to chart</text>;
}

/* ------------------------------------------------------------ pie / donut */
function PieChart({ ctx, inner, series, type }: { ctx: Ctx; inner: { x: number; y: number; w: number; h: number }; series: ReturnType<typeof seriesForChart>; type: string }) {
  const s = series[0];
  if (!s || !s.labels.length) return <Empty ctx={ctx} inner={inner} />;
  const semi = type === "donut_semi";
  const vals = s.values.map((v) => Math.max(0, v ?? 0));
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  const r = Math.min(inner.w * 0.6, semi ? inner.h * 0.9 : inner.h) / 2 - 8;
  const cx = inner.x + inner.w * 0.38, cy = semi ? inner.y + inner.h * 0.85 : inner.y + inner.h / 2;
  const ir = type === "pie" ? 0 : type === "donut_radial" ? r * 0.35 : r * 0.58;
  const [, setHover] = ctx.hover;
  const sweep = semi ? Math.PI : Math.PI * 2, start0 = semi ? Math.PI : -Math.PI / 2;
  let a0 = start0;
  const arc = (a: number, b: number, R: number, IR: number) => { const p = (ang: number, rad: number) => [cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad]; const large = b - a > Math.PI ? 1 : 0; const [x0, y0] = p(a, R), [x1, y1] = p(b, R), [x2, y2] = p(b, IR), [x3, y3] = p(a, IR); return `M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${IR},${IR} 0 ${large} 0 ${x3},${y3} Z`; };
  if (type === "donut_radial") {
    const maxV = Math.max(...vals) || 1, ring = (r - ir) / vals.length;
    return <g fontFamily={ctx.font} fontSize={ctx.fs - 2}>{vals.map((v, i) => { const R = r - i * ring, IR = R - ring * 0.7; const b = start0 + (v / maxV) * (Math.PI * 1.75); return <g key={i} onMouseEnter={() => setHover(`${s.labels[i]}: ${fmt(v, ctx.decimals, ctx.pct)}`)} onMouseLeave={() => setHover(null)}><path d={arc(start0, start0 + 0.001, R, IR)} fill="none" /><circle cx={cx} cy={cy} r={(R + IR) / 2} fill="none" stroke={ctx.grid} strokeWidth={ring * 0.7} /><path d={arc(start0, b, R, IR)} fill={ctx.colors[i % ctx.colors.length]} /><text x={cx + r + 14} y={cy - r + i * 16 + 10} fill={ctx.textColor}>{trunc(s.labels[i], 22)} — {fmt(v, ctx.decimals, ctx.pct)}</text></g>; })}</g>;
  }
  return (
    <g fontFamily={ctx.font} fontSize={ctx.fs - 2}>
      {vals.map((v, i) => {
        const a1 = a0 + (v / total) * sweep; const mid = (a0 + a1) / 2; const d = arc(a0, a1 - 0.002, r, ir); a0 = a1;
        const lab = s.labels[i], selected = ctx.sel === lab;
        return <g key={lab} opacity={ctx.sel && !selected ? 0.45 : 1} style={{ cursor: ctx.onSelect ? "pointer" : "default" }} onClick={() => ctx.onSelect?.(selected ? null : lab)} onMouseEnter={() => setHover(`${lab}: ${fmt(v, ctx.decimals, ctx.pct)} (${fmt((v / total) * 100, 0)}% of total)`)} onMouseLeave={() => setHover(null)}>
          <path d={d} fill={ctx.colors[i % ctx.colors.length]} stroke="#fff" strokeWidth={1.5} />
          {(ctx.opts.dataLabels ?? true) && v / total > 0.04 && <text x={cx + Math.cos(mid) * (ir ? (r + ir) / 2 : r * 0.65)} y={cy + Math.sin(mid) * (ir ? (r + ir) / 2 : r * 0.65) + 4} textAnchor="middle" fill="#fff" fontWeight={600} fontSize={ctx.fs - 2}>{fmt(v, ctx.decimals, ctx.pct)}</text>}
        </g>;
      })}
      {ir > 0 && <text x={cx} y={cy + (semi ? -6 : 5)} textAnchor="middle" fill={ctx.textColor} fontSize={ctx.fs + 4} fontWeight={700}>{fmt(total, ctx.pct ? 0 : ctx.decimals, ctx.pct)}</text>}
      <g>{s.labels.map((lab, i) => <g key={lab} transform={`translate(${cx + r + 18},${cy - Math.min(r, (s.labels.length * 17) / 2) + i * 17})`} style={{ cursor: ctx.onSelect ? "pointer" : "default" }} onClick={() => ctx.onSelect?.(ctx.sel === lab ? null : lab)}><rect width={10} height={10} rx={2} fill={ctx.colors[i % ctx.colors.length]} /><text x={14} y={9} fill={ctx.textColor}>{trunc(lab, 26)} <tspan fill={ctx.subtle}>{fmt(vals[i], ctx.decimals, ctx.pct)}</tspan></text></g>)}</g>
    </g>
  );
}

/* ------------------------------------------------------------ lines / areas */
function LineChart({ ctx, inner, series, type }: { ctx: Ctx; inner: { x: number; y: number; w: number; h: number }; series: ReturnType<typeof seriesForChart>; type: string }) {
  if (!series.length || series[0].labels.length < 1) return <Empty ctx={ctx} inner={inner} />;
  const labels = series[0].labels, n = labels.length;
  const stacked = type === "area_stacked";
  const area = type === "area" || stacked;
  const smooth = type === "spline";
  const step = type === "step_line";
  const pad = { l: 46, r: 16, t: 10, b: 36 };
  const px = inner.x + pad.l, py = inner.y + pad.t, pw = inner.w - pad.l - pad.r, ph = inner.h - pad.t - pad.b;
  const stackedVals = stacked ? labels.map((_, i) => series.reduce((t, s) => t + (s.values[i] ?? 0), 0)) : [];
  let maxV = stacked ? Math.max(...stackedVals) : Math.max(...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  let minV = Math.min(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  if (ctx.opts.benchmark) { maxV = Math.max(maxV, ctx.opts.benchmark.value); minV = Math.min(minV, ctx.opts.benchmark.value); }
  maxV = niceMax(maxV || 1); if (minV < 0) minV = -niceMax(-minV);
  const xs = (i: number) => px + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
  const ys = (v: number) => py + ph - ((v - minV) / (maxV - minV)) * ph;
  const [, setHover] = ctx.hover;
  const acc = new Array(n).fill(0);
  const path = (pts: [number, number][]) => {
    if (step) return pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `H${p[0]} V${p[1]}`)).join(" ");
    if (!smooth || pts.length < 3) return pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) { const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)]; const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]; d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`; }
    return d;
  };
  const tk = ticks(minV, maxV, 5);
  const every = Math.ceil(n / Math.max(1, Math.floor(pw / 70)));
  return (
    <g fontFamily={ctx.font} fontSize={ctx.fs - 2}>
      {(ctx.opts.gridLines ?? true) && tk.map((v, i) => <line key={i} x1={px} x2={px + pw} y1={ys(v)} y2={ys(v)} stroke={ctx.grid} />)}
      {tk.map((v, i) => <text key={i} x={px - 6} y={ys(v) + 4} textAnchor="end" fill={ctx.subtle}>{fmt(v, 0, ctx.pct)}</text>)}
      {labels.map((l, i) => i % every === 0 ? <text key={l} x={xs(i)} y={py + ph + 16} textAnchor="middle" fill={ctx.textColor}>{trunc(l, 12)}</text> : null)}
      {series.map((s, j) => {
        const color = ctx.colors[j % ctx.colors.length];
        const pts = s.values.map((v, i) => { const base = stacked ? acc[i] : 0; const val = base + (v ?? 0); return [xs(i), ys(val)] as [number, number]; });
        const basePts = stacked ? acc.map((b, i) => [xs(i), ys(b)] as [number, number]) : labels.map((_, i) => [xs(i), ys(0)] as [number, number]);
        if (stacked) s.values.forEach((v, i) => { acc[i] += v ?? 0; });
        const dashed = s.meta?.dashed || s.name.includes("avg");
        return (
          <g key={s.name}>
            {area && <path d={`${path(pts)} L${basePts[basePts.length - 1][0]},${basePts[basePts.length - 1][1]} ${[...basePts].reverse().slice(1).map((p) => `L${p[0]},${p[1]}`).join(" ")} Z`} fill={color} opacity={0.18} />}
            <path d={path(pts)} fill="none" stroke={color} strokeWidth={ctx.opts.lineWidth ?? 2} strokeDasharray={dashed ? "5 4" : undefined} />
            {pts.map((p, i) => s.values[i] == null ? null : <g key={i} onMouseEnter={() => setHover(`${labels[i]} — ${s.name}: ${fmt(s.values[i], ctx.decimals, ctx.pct)}`)} onMouseLeave={() => setHover(null)} style={{ cursor: ctx.onSelect ? "pointer" : "default" }} onClick={() => ctx.onSelect?.(ctx.sel === labels[i] ? null : labels[i])}>
              <circle cx={p[0]} cy={p[1]} r={ctx.opts.markerSize ?? 3.5} fill={color} stroke="#fff" strokeWidth={1} />
              {(ctx.opts.dataLabels ?? false) && <text x={p[0]} y={p[1] - 7} textAnchor="middle" fill={ctx.textColor} fontSize={ctx.fs - 3}>{fmt(s.values[i], ctx.decimals, ctx.pct)}</text>}
            </g>)}
          </g>
        );
      })}
      <line x1={px} x2={px + pw} y1={ys(0)} y2={ys(0)} stroke={ctx.subtle} />
      {ctx.opts.benchmark && <RefLine ctx={ctx} v={ys(ctx.opts.benchmark.value)} horizontal={false} px={px} py={py} pw={pw} ph={ph} label={ctx.opts.benchmark.label ?? `Baseline ${ctx.opts.benchmark.value}`} dashed />}
      {ctx.opts.target && <RefLine ctx={ctx} v={ys(ctx.opts.target.value)} horizontal={false} px={px} py={py} pw={pw} ph={ph} label={ctx.opts.target.label ?? `Target ${ctx.opts.target.value}`} color={ctx.theme.colors.accent} />}
      {ctx.opts.xLabel && <text x={px + pw / 2} y={inner.y + inner.h - 2} textAnchor="middle" fill={ctx.subtle}>{ctx.opts.xLabel}</text>}
      {ctx.opts.yLabel && <text x={12} y={py + ph / 2} textAnchor="middle" fill={ctx.subtle} transform={`rotate(-90 12 ${py + ph / 2})`}>{ctx.opts.yLabel}</text>}
    </g>
  );
}

/* ------------------------------------------------------------ scatter / bubble / IPA */
function ScatterChart({ ctx, inner, data, type }: { ctx: Ctx; inner: { x: number; y: number; w: number; h: number }; data: ChartData; type: string }) {
  const pts = data.points ?? [];
  if (!pts.length) return <Empty ctx={ctx} inner={inner} />;
  const pad = { l: 46, r: 16, t: 10, b: 36 };
  const px = inner.x + pad.l, py = inner.y + pad.t, pw = inner.w - pad.l - pad.r, ph = inner.h - pad.t - pad.b;
  const xsv = pts.map((p) => p.x), ysv = pts.map((p) => p.y);
  const xmin = Math.min(...xsv), xmax = Math.max(...xsv), ymin = Math.min(...ysv), ymax = Math.max(...ysv);
  const xr = xmax - xmin || 1, yr = ymax - ymin || 1;
  const X = (v: number) => px + ((v - (xmin - xr * 0.05)) / (xr * 1.1)) * pw, Y = (v: number) => py + ph - ((v - (ymin - yr * 0.05)) / (yr * 1.1)) * ph;
  const groups = [...new Set(pts.map((p) => p.group ?? ""))];
  const [, setHover] = ctx.hover;
  const fit = data.series?.find((s) => s.meta?.kind === "line_fit");
  const ipa = type === "heatmap_ipa";
  const mx = xsv.reduce((a, b) => a + b, 0) / xsv.length, my = ysv.reduce((a, b) => a + b, 0) / ysv.length;
  const many = pts.length > 400;
  return (
    <g fontFamily={ctx.font} fontSize={ctx.fs - 2}>
      {ticks(xmin, xmax, 5).map((v, i) => <g key={i}><line x1={X(v)} x2={X(v)} y1={py} y2={py + ph} stroke={ctx.grid} /><text x={X(v)} y={py + ph + 14} textAnchor="middle" fill={ctx.subtle}>{fmt(v, 1)}</text></g>)}
      {ticks(ymin, ymax, 5).map((v, i) => <g key={i}><line x1={px} x2={px + pw} y1={Y(v)} y2={Y(v)} stroke={ctx.grid} /><text x={px - 6} y={Y(v) + 4} textAnchor="end" fill={ctx.subtle}>{fmt(v, 1)}</text></g>)}
      {ipa && <g><line x1={X(mx)} x2={X(mx)} y1={py} y2={py + ph} stroke={ctx.subtle} strokeDasharray="4 3" /><line x1={px} x2={px + pw} y1={Y(my)} y2={Y(my)} stroke={ctx.subtle} strokeDasharray="4 3" />
        <text x={px + 4} y={py + 12} fill={ctx.subtle} fontSize={ctx.fs - 3}>Possible overkill</text><text x={px + pw - 4} y={py + 12} textAnchor="end" fill={ctx.subtle} fontSize={ctx.fs - 3}>Keep up the good work</text>
        <text x={px + 4} y={py + ph - 6} fill={ctx.subtle} fontSize={ctx.fs - 3}>Low priority</text><text x={px + pw - 4} y={py + ph - 6} textAnchor="end" fill={ctx.theme.colors.accent} fontSize={ctx.fs - 3} fontWeight={700}>Concentrate here</text></g>}
      {fit && (() => { const [b0, b1] = fit.values as number[]; const x0 = xmin, x1 = xmax; return <line x1={X(x0)} y1={Y(b0 + b1 * x0)} x2={X(x1)} y2={Y(b0 + b1 * x1)} stroke={ctx.theme.colors.accent} strokeWidth={2} strokeDasharray={type === "scatter_ci" ? undefined : "6 4"} />; })()}
      {pts.map((p, i) => { const gi = groups.indexOf(p.group ?? ""); const r = type === "bubble" || type === "segment_bubble" ? clamp((p.size ?? 1) * 6, 4, 26) : many ? 2.5 : (ctx.opts.markerSize ?? 5); return <g key={i} onMouseEnter={() => setHover(`${p.label ?? p.group ?? ""} (${fmt(p.x, 2)}, ${fmt(p.y, 2)})`)} onMouseLeave={() => setHover(null)}><circle cx={X(p.x)} cy={Y(p.y)} r={r} fill={ctx.colors[gi % ctx.colors.length]} opacity={many ? 0.5 : 0.85} stroke="#fff" strokeWidth={many ? 0 : 1} />{p.label && pts.length <= 40 && <text x={X(p.x) + r + 3} y={Y(p.y) + 4} fill={ctx.textColor} fontSize={ctx.fs - 3}>{trunc(p.label, 22)}</text>}</g>; })}
      {groups.length > 1 && groups.map((g, i) => <g key={g} transform={`translate(${px + 6 + i * 130},${py + ph + 30})`}><circle r={5} cx={5} cy={0} fill={ctx.colors[i % ctx.colors.length]} /><text x={14} y={4} fill={ctx.textColor}>{trunc(g, 18)}</text></g>)}
      {ctx.opts.xLabel && <text x={px + pw / 2} y={inner.y + inner.h - 2} textAnchor="middle" fill={ctx.subtle}>{ctx.opts.xLabel}</text>}
      {ctx.opts.yLabel && <text x={12} y={py + ph / 2} textAnchor="middle" fill={ctx.subtle} transform={`rotate(-90 12 ${py + ph / 2})`}>{ctx.opts.yLabel}</text>}
    </g>
  );
}

/* ------------------------------------------------------------ heatmap */
function heat(v: number, min: number, max: number, diverging: boolean, primary: string): string {
  const t = max === min ? 0.5 : (v - min) / (max - min);
  if (diverging) { const s = clamp((v - 0) / (Math.max(Math.abs(min), Math.abs(max)) || 1), -1, 1); return s >= 0 ? `rgba(37,99,235,${0.1 + s * 0.85})` : `rgba(239,68,68,${0.1 + -s * 0.85})`; }
  const [r, g, b] = hexRgb(primary);
  return `rgba(${r},${g},${b},${0.08 + t * 0.9})`;
}
function hexRgb(h: string): [number, number, number] { const s = h.replace("#", ""); return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]; }

function HeatmapChart({ ctx, inner, data, series, type }: { ctx: Ctx; inner: { x: number; y: number; w: number; h: number }; data: ChartData; series: ReturnType<typeof seriesForChart>; type: string }) {
  const m = data.matrix ?? (series.length ? { rows: series[0].labels, columns: series.map((s) => s.name), values: series[0].labels.map((_, i) => series.map((s) => s.values[i])) } : null);
  if (!m || !m.rows.length) return <Empty ctx={ctx} inner={inner} />;
  const diverging = type === "heatmap_correlation" || type === "correlation_matrix" || type === "correlogram" || m.values.some((r) => r.some((v) => v != null && v < 0));
  const flat = m.values.flat().filter((v): v is number => v != null);
  const min = Math.min(...flat), max = Math.max(...flat);
  const labelW = clamp(Math.max(...m.rows.map((r) => r.length)) * (ctx.fs - 2) * 0.55, 60, inner.w * 0.3);
  const px = inner.x + labelW + 6, py = inner.y + 34, pw = inner.w - labelW - 10, ph = inner.h - 40;
  const cw = pw / m.columns.length, ch = ph / m.rows.length;
  const [, setHover] = ctx.hover;
  if (type === "marimekko") {
    const colTotals = m.columns.map((_, j) => m.values.reduce((t, r) => t + (r[j] ?? 0), 0)); const grand = colTotals.reduce((a, b) => a + b, 0) || 1; let x = px;
    return <g fontFamily={ctx.font} fontSize={ctx.fs - 3}>{m.columns.map((c, j) => { const w = (colTotals[j] / grand) * pw; let y = py; const el = <g key={c}>{m.rows.map((r, i) => { const h = colTotals[j] ? ((m.values[i][j] ?? 0) / colTotals[j]) * ph : 0; const rect = <rect key={r} x={x} y={y} width={Math.max(w - 2, 0)} height={Math.max(h - 1, 0)} fill={ctx.colors[i % ctx.colors.length]} onMouseEnter={() => setHover(`${c} · ${r}: ${fmt(m.values[i][j], ctx.decimals, ctx.pct)}`)} onMouseLeave={() => setHover(null)} />; y += h; return rect; })}<text x={x + w / 2} y={py + ph + 14} textAnchor="middle" fill={ctx.textColor}>{trunc(c, Math.max(4, Math.floor(w / 6)))}</text></g>; x += w; return el; })}</g>;
  }
  return (
    <g fontFamily={ctx.font} fontSize={ctx.fs - 3}>
      {m.columns.map((c, j) => <text key={c} x={px + j * cw + cw / 2} y={py - 8} textAnchor={m.columns.length > 8 ? "start" : "middle"} transform={m.columns.length > 8 ? `rotate(-35 ${px + j * cw + cw / 2} ${py - 8})` : undefined} fill={ctx.textColor}>{trunc(c, m.columns.length > 8 ? 14 : Math.max(4, Math.floor(cw / 6)))}</text>)}
      {m.rows.map((r, i) => <g key={r}>
        <text x={px - 6} y={py + i * ch + ch / 2 + 4} textAnchor="end" fill={ctx.textColor} style={{ cursor: ctx.onSelect ? "pointer" : "default" }} onClick={() => ctx.onSelect?.(ctx.sel === r ? null : r)} fontWeight={ctx.sel === r ? 700 : 400}>{trunc(r, Math.floor(labelW / ((ctx.fs - 2) * 0.55)))}</text>
        {m.columns.map((c, j) => { const v = m.values[i][j]; const isCorr = type === "correlogram"; return <g key={c} onMouseEnter={() => setHover(`${r} × ${c}: ${fmt(v, ctx.decimals + (diverging ? 2 : 0), ctx.pct && !diverging)}`)} onMouseLeave={() => setHover(null)}>
          {isCorr ? <circle cx={px + j * cw + cw / 2} cy={py + i * ch + ch / 2} r={v == null ? 0 : (Math.abs(v) / (Math.max(Math.abs(min), Math.abs(max)) || 1)) * Math.min(cw, ch) * 0.45} fill={heat(v ?? 0, min, max, true, ctx.theme.colors.primary)} />
            : <rect x={px + j * cw + 1} y={py + i * ch + 1} width={Math.max(cw - 2, 0)} height={Math.max(ch - 2, 0)} rx={2} fill={v == null ? "#f1f5f9" : heat(v, min, max, diverging, ctx.theme.colors.primary)} />}
          {(ctx.opts.dataLabels ?? true) && v != null && cw > 28 && ch > 14 && !isCorr && <text x={px + j * cw + cw / 2} y={py + i * ch + ch / 2 + 4} textAnchor="middle" fill={Math.abs(v - (diverging ? 0 : min)) / ((diverging ? Math.max(Math.abs(min), Math.abs(max)) : max - min) || 1) > 0.55 ? "#fff" : ctx.textColor}>{fmt(v, diverging ? 2 : ctx.decimals, ctx.pct && !diverging)}</text>}
        </g>; })}
      </g>)}
    </g>
  );
}

/* ------------------------------------------------------------ radar */
function RadarChart({ ctx, inner, series }: { ctx: Ctx; inner: { x: number; y: number; w: number; h: number }; series: ReturnType<typeof seriesForChart>; type: string }) {
  if (!series.length || series[0].labels.length < 3) return <BarChart ctx={ctx} inner={inner} series={series} type="bar_grouped" note="Radar needs at least three categories" />;
  const labels = series[0].labels, n = labels.length;
  const cx = inner.x + inner.w / 2, cy = inner.y + inner.h / 2 + 4, r = Math.min(inner.w, inner.h) / 2 - 34;
  const maxV = niceMax(Math.max(...series.flatMap((s) => s.values.map((v) => v ?? 0))) || 1);
  const ang = (i: number) => -Math.PI / 2 + (i / n) * Math.PI * 2;
  const P = (i: number, v: number) => [cx + Math.cos(ang(i)) * (v / maxV) * r, cy + Math.sin(ang(i)) * (v / maxV) * r];
  const [, setHover] = ctx.hover;
  return (
    <g fontFamily={ctx.font} fontSize={ctx.fs - 3}>
      {[0.25, 0.5, 0.75, 1].map((f) => <polygon key={f} points={labels.map((_, i) => P(i, maxV * f).join(",")).join(" ")} fill="none" stroke={ctx.grid} />)}
      {labels.map((l, i) => { const [x, y] = P(i, maxV * 1.12); return <g key={l}><line x1={cx} y1={cy} x2={P(i, maxV)[0]} y2={P(i, maxV)[1]} stroke={ctx.grid} /><text x={x} y={y + 4} textAnchor={Math.abs(Math.cos(ang(i))) < 0.2 ? "middle" : Math.cos(ang(i)) > 0 ? "start" : "end"} fill={ctx.textColor}>{trunc(l, 16)}</text></g>; })}
      {series.map((s, j) => <g key={s.name}><polygon points={s.values.map((v, i) => P(i, v ?? 0).join(",")).join(" ")} fill={ctx.colors[j % ctx.colors.length]} opacity={0.15} stroke={ctx.colors[j % ctx.colors.length]} strokeWidth={2} />{s.values.map((v, i) => { const [x, y] = P(i, v ?? 0); return <circle key={i} cx={x} cy={y} r={3.5} fill={ctx.colors[j % ctx.colors.length]} onMouseEnter={() => setHover(`${labels[i]} — ${s.name}: ${fmt(v, ctx.decimals, ctx.pct)}`)} onMouseLeave={() => setHover(null)} />; })}</g>)}
    </g>
  );
}

/* ------------------------------------------------------------ funnel */
function FunnelChart({ ctx, inner, series }: { ctx: Ctx; inner: { x: number; y: number; w: number; h: number }; series: ReturnType<typeof seriesForChart> }) {
  if (!series.length) return <Empty ctx={ctx} inner={inner} />;
  // single series: stages as rows; several series (brands): grouped columns by stage
  if (series.length > 1) return <BarChart ctx={ctx} inner={inner} series={series} type="bar_grouped" />;
  const s = series[0], n = s.labels.length, maxV = Math.max(...s.values.map((v) => v ?? 0)) || 1;
  const rowH = (inner.h - 10) / n, cx = inner.x + inner.w / 2, maxW = inner.w * 0.7;
  const [, setHover] = ctx.hover;
  return <g fontFamily={ctx.font} fontSize={ctx.fs - 2}>{s.labels.map((l, i) => { const v = s.values[i] ?? 0, w = (v / maxV) * maxW, next = s.values[i + 1] ?? null; return <g key={l} onMouseEnter={() => setHover(`${l}: ${fmt(v, ctx.decimals, ctx.pct)}`)} onMouseLeave={() => setHover(null)} style={{ cursor: ctx.onSelect ? "pointer" : "default" }} onClick={() => ctx.onSelect?.(ctx.sel === l ? null : l)}>
    <rect x={cx - w / 2} y={inner.y + 4 + i * rowH} width={Math.max(w, 2)} height={rowH - 6} rx={3} fill={ctx.colors[i % ctx.colors.length]} opacity={ctx.sel && ctx.sel !== l ? 0.45 : 1} />
    <text x={cx} y={inner.y + 4 + i * rowH + rowH / 2 + 4} textAnchor="middle" fill="#fff" fontWeight={600}>{trunc(l, 24)} · {fmt(v, ctx.decimals, ctx.pct)}</text>
    {next != null && v > 0 && <text x={cx + maxW / 2 + 10} y={inner.y + 4 + i * rowH + rowH + 2} fill={ctx.subtle} fontSize={ctx.fs - 3}>→ {fmt((next / v) * 100, 0)}% convert</text>}
  </g>; })}</g>;
}

/* ------------------------------------------------------------ KPI / gauge */
function KpiChart({ ctx, inner, data, type, result }: { ctx: Ctx; inner: { x: number; y: number; w: number; h: number }; data: ChartData; type: string; result: AnalysisResult }) {
  type Kpi = { label: string; value: number | string; delta?: number; unit?: string; target?: number };
  const kpis: Kpi[] = data.kpis?.length ? data.kpis : data.series?.[0] ? data.series[0].values.slice(0, 4).map((v, i) => ({ label: data.categories?.[i] ?? "", value: v ?? 0 })) : [];
  if (!kpis.length) return <Empty ctx={ctx} inner={inner} />;
  if (type === "gauge" || type === "progress_circle" || type === "bullet") {
    const k = kpis[0]; const v = typeof k.value === "number" ? k.value : 0;
    const isNps = result.kind === "nps" && /nps/i.test(k.label);
    const min = isNps ? -100 : 0, max = isNps ? 100 : k.unit === "%" || ctx.pct ? 100 : niceMax(Math.max(v, k.target ?? 0) || 1);
    const cx = inner.x + inner.w / 2, cy = inner.y + inner.h * 0.72, r = Math.min(inner.w / 2, inner.h * 0.7) - 10;
    const f = clamp((v - min) / (max - min), 0, 1);
    const a0 = Math.PI, a1 = Math.PI + f * Math.PI;
    const arc = (s: number, e: number, R: number) => `M${cx + Math.cos(s) * R},${cy + Math.sin(s) * R} A${R},${R} 0 ${e - s > Math.PI ? 1 : 0} 1 ${cx + Math.cos(e) * R},${cy + Math.sin(e) * R}`;
    if (type === "bullet") { const px = inner.x + 20, pw = inner.w - 40, y = inner.y + inner.h / 2; const X = (x: number) => px + ((x - min) / (max - min)) * pw; return <g fontFamily={ctx.font}><rect x={px} y={y - 14} width={pw} height={28} fill={ctx.grid} rx={4} /><rect x={px} y={y - 8} width={Math.max(X(v) - px, 0)} height={16} fill={ctx.theme.colors.primary} rx={2} />{k.target != null && <line x1={X(k.target)} x2={X(k.target)} y1={y - 18} y2={y + 18} stroke={ctx.theme.colors.accent} strokeWidth={3} />}<text x={px} y={y - 24} fill={ctx.subtle} fontSize={ctx.fs}>{k.label}</text><text x={px + pw} y={y - 24} textAnchor="end" fill={ctx.textColor} fontSize={ctx.fs + 4} fontWeight={700}>{fmt(v, ctx.decimals)}{k.unit ?? ""}</text></g>; }
    return <g fontFamily={ctx.font}>
      <path d={type === "progress_circle" ? "" : arc(a0, 2 * Math.PI, r)} fill="none" stroke={ctx.grid} strokeWidth={r * 0.22} strokeLinecap="round" />
      {type === "progress_circle" ? <><circle cx={cx} cy={inner.y + inner.h / 2} r={r * 0.8} fill="none" stroke={ctx.grid} strokeWidth={r * 0.18} /><circle cx={cx} cy={inner.y + inner.h / 2} r={r * 0.8} fill="none" stroke={ctx.theme.colors.primary} strokeWidth={r * 0.18} strokeDasharray={`${f * 2 * Math.PI * r * 0.8} ${2 * Math.PI * r * 0.8}`} transform={`rotate(-90 ${cx} ${inner.y + inner.h / 2})`} strokeLinecap="round" /></>
        : <path d={arc(a0, Math.max(a1, a0 + 0.01), r)} fill="none" stroke={isNps ? (v >= 50 ? ctx.theme.colors.primary : v >= 0 ? ctx.theme.colors.accent : "#ef4444") : ctx.theme.colors.primary} strokeWidth={r * 0.22} strokeLinecap="round" />}
      {k.target != null && type === "gauge" && (() => { const ta = Math.PI + clamp((k.target - min) / (max - min), 0, 1) * Math.PI; return <line x1={cx + Math.cos(ta) * (r - r * 0.16)} y1={cy + Math.sin(ta) * (r - r * 0.16)} x2={cx + Math.cos(ta) * (r + r * 0.16)} y2={cy + Math.sin(ta) * (r + r * 0.16)} stroke={ctx.theme.colors.accent} strokeWidth={3} />; })()}
      <text x={cx} y={type === "progress_circle" ? inner.y + inner.h / 2 + 10 : cy - 6} textAnchor="middle" fill={ctx.textColor} fontSize={ctx.fs + 18} fontWeight={700}>{fmt(v, k.unit === "%" ? 0 : ctx.decimals)}{k.unit ?? ""}</text>
      <text x={cx} y={type === "progress_circle" ? inner.y + inner.h / 2 + 30 : cy + 16} textAnchor="middle" fill={ctx.subtle} fontSize={ctx.fs}>{k.label}</text>
      {type === "gauge" && <><text x={cx - r} y={cy + 16} textAnchor="middle" fill={ctx.subtle} fontSize={ctx.fs - 3}>{min}</text><text x={cx + r} y={cy + 16} textAnchor="middle" fill={ctx.subtle} fontSize={ctx.fs - 3}>{max}</text></>}
    </g>;
  }
  const cols = Math.min(kpis.length, 4), rows = Math.ceil(kpis.length / cols), cw = inner.w / cols, ch = Math.min(inner.h / rows, 120);
  return <g fontFamily={ctx.font}>{kpis.slice(0, cols * rows).map((k, i) => { const x = inner.x + (i % cols) * cw, y = inner.y + Math.floor(i / cols) * ch; return <g key={i}><rect x={x + 4} y={y + 4} width={cw - 8} height={ch - 8} rx={8} fill="#f5f7fa" stroke={ctx.grid} /><text x={x + cw / 2} y={y + ch / 2 + 2} textAnchor="middle" fill={ctx.theme.colors.primary} fontSize={Math.min(ctx.fs + 16, ch / 3)} fontWeight={700}>{typeof k.value === "number" ? fmt(k.value, ctx.decimals) : k.value}{k.unit ?? ""}</text><text x={x + cw / 2} y={y + ch / 2 + 22} textAnchor="middle" fill={ctx.subtle} fontSize={ctx.fs - 1}>{trunc(k.label, 24)}</text>{k.delta != null && <text x={x + cw / 2} y={y + ch / 2 + 38} textAnchor="middle" fill={k.delta >= 0 ? "#157f3d" : "#d02b2b"} fontSize={ctx.fs - 2}>{k.delta >= 0 ? "▲" : "▼"} {fmt(Math.abs(k.delta), 1)}</text>}</g>; })}</g>;
}

/* ------------------------------------------------------------ box / strip */
function BoxChart({ ctx, inner, data, type }: { ctx: Ctx; inner: { x: number; y: number; w: number; h: number }; data: ChartData; type: string }) {
  const pts = data.points ?? [];
  if (!pts.length) return <Empty ctx={ctx} inner={inner} />;
  const groups = [...new Set(pts.map((p) => p.group ?? ""))];
  const pad = { l: 46, r: 16, t: 10, b: 36 };
  const px = inner.x + pad.l, py = inner.y + pad.t, pw = inner.w - pad.l - pad.r, ph = inner.h - pad.t - pad.b;
  const all = pts.map((p) => p.y), min = Math.min(...all), max = Math.max(...all), rng = max - min || 1;
  const Y = (v: number) => py + ph - ((v - min + rng * 0.05) / (rng * 1.1)) * ph;
  const band = pw / groups.length;
  const q = (arr: number[], p: number) => { const s = [...arr].sort((a, b) => a - b); const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
  const [, setHover] = ctx.hover;
  return <g fontFamily={ctx.font} fontSize={ctx.fs - 2}>
    {ticks(min, max, 5).map((v, i) => <g key={i}><line x1={px} x2={px + pw} y1={Y(v)} y2={Y(v)} stroke={ctx.grid} /><text x={px - 6} y={Y(v) + 4} textAnchor="end" fill={ctx.subtle}>{fmt(v, 1)}</text></g>)}
    {groups.map((g, gi) => {
      const ys = pts.filter((p) => (p.group ?? "") === g).map((p) => p.y); if (!ys.length) return null;
      const cx = px + gi * band + band / 2, bw = band * 0.5, color = ctx.colors[gi % ctx.colors.length];
      const q1 = q(ys, 0.25), med = q(ys, 0.5), q3 = q(ys, 0.75), iqr = q3 - q1, lo = Math.max(Math.min(...ys), q1 - 1.5 * iqr), hi = Math.min(Math.max(...ys), q3 + 1.5 * iqr);
      const showBox = type === "box_plot" || type === "raincloud" || type === "violin";
      const showPts = type !== "box_plot";
      // density for violin
      const bins = 16, counts = new Array(bins).fill(0); ys.forEach((y) => { counts[Math.min(bins - 1, Math.floor(((y - min) / rng) * bins))]++; }); const cmax = Math.max(...counts) || 1;
      return <g key={g} onMouseEnter={() => setHover(`${g}: median ${fmt(med, 2)}, IQR ${fmt(q1, 2)}–${fmt(q3, 2)}, n = ${ys.length}`)} onMouseLeave={() => setHover(null)}>
        {type === "violin" && <path d={counts.map((c, i) => { const y0 = Y(min + (i / bins) * rng), y1 = Y(min + ((i + 1) / bins) * rng); const w = (c / cmax) * bw; return `${i === 0 ? "M" : "L"}${cx - w / 2},${y0} L${cx - w / 2},${y1}`; }).join(" ") + counts.map((c, i) => { const y1 = Y(min + ((bins - i) / bins) * rng), y0 = Y(min + ((bins - i - 1) / bins) * rng); const w = (counts[bins - i - 1] / cmax) * bw; return `L${cx + w / 2},${y1} L${cx + w / 2},${y0}`; }).join(" ") + " Z"} fill={color} opacity={0.35} />}
        {type === "raincloud" && <path d={counts.map((c, i) => `${i === 0 ? "M" : "L"}${cx - (c / cmax) * bw * 0.9},${Y(min + ((i + 0.5) / bins) * rng)}`).join(" ") + ` L${cx},${Y(max)} L${cx},${Y(min)} Z`} fill={color} opacity={0.3} />}
        {showBox && <g><line x1={cx} x2={cx} y1={Y(lo)} y2={Y(hi)} stroke={ctx.textColor} /><rect x={cx - bw * 0.3} y={Y(q3)} width={bw * 0.6} height={Math.max(Y(q1) - Y(q3), 1)} fill={type === "violin" ? "#fff" : color} stroke={ctx.textColor} opacity={0.9} /><line x1={cx - bw * 0.3} x2={cx + bw * 0.3} y1={Y(med)} y2={Y(med)} stroke={ctx.textColor} strokeWidth={2} /></g>}
        {showPts && ys.slice(0, 600).map((y, i) => { const jitter = type === "beeswarm" ? ((i % 9) - 4) * (bw / 12) : (Math.sin(i * 12.9898) * 0.5) * bw * 0.6; return <circle key={i} cx={cx + (type === "raincloud" ? bw * 0.4 : 0) + jitter} cy={Y(y)} r={2.2} fill={color} opacity={0.55} />; })}
        {ys.filter((y) => y < lo || y > hi).slice(0, 50).map((y, i) => <circle key={`o${i}`} cx={cx} cy={Y(y)} r={2.5} fill="none" stroke={ctx.textColor} />)}
        <text x={cx} y={py + ph + 16} textAnchor="middle" fill={ctx.textColor}>{trunc(g, 16)}</text>
      </g>;
    })}
  </g>;
}

/* ------------------------------------------------------------ treemap / sunburst / grouped tree (part-worths) */
function TreeChart({ ctx, inner, data, type, series }: { ctx: Ctx; inner: { x: number; y: number; w: number; h: number }; data: ChartData; type: string; series: ReturnType<typeof seriesForChart> }) {
  const tree: TreeNode[] = data.tree ?? (series[0] ? series[0].labels.map((l, i) => ({ name: l, value: series[0].values[i] ?? 0 })) : []);
  if (!tree.length) return <Empty ctx={ctx} inner={inner} />;
  const [, setHover] = ctx.hover;
  if (type === "part_worth" || type === "utility_by_level" || type === "wtp") {
    // grouped horizontal bars: attribute → levels (utilities may be negative)
    const rows = tree.flatMap((a) => (a.children ?? [{ name: a.name, value: a.value }]).map((l) => ({ attr: a.name, level: l.name, v: l.value ?? 0 })));
    const maxAbs = Math.max(...rows.map((r) => Math.abs(r.v))) || 1;
    const labelW = inner.w * 0.38, px = inner.x + labelW, pw = inner.w - labelW - 40, rowH = Math.min(24, (inner.h - 10) / rows.length), zero = px + pw / 2;
    const X = (v: number) => zero + (v / maxAbs) * (pw / 2);
    let lastAttr = "";
    return <g fontFamily={ctx.font} fontSize={ctx.fs - 2}><line x1={zero} x2={zero} y1={inner.y} y2={inner.y + rows.length * rowH} stroke={ctx.subtle} />{rows.map((r, i) => { const y = inner.y + i * rowH; const ai = tree.findIndex((a) => a.name === r.attr); const showAttr = r.attr !== lastAttr; lastAttr = r.attr; return <g key={i} onMouseEnter={() => setHover(`${r.attr} · ${r.level}: ${fmt(r.v, 3)}`)} onMouseLeave={() => setHover(null)}>{showAttr && <text x={inner.x} y={y + rowH / 2 + 4} fill={ctx.theme.colors.primary} fontWeight={700}>{trunc(r.attr, 16)}</text>}<text x={px - 8} y={y + rowH / 2 + 4} textAnchor="end" fill={ctx.textColor}>{trunc(r.level, 18)}</text><rect x={Math.min(zero, X(r.v))} y={y + 3} width={Math.abs(X(r.v) - zero)} height={rowH - 6} fill={ctx.colors[ai % ctx.colors.length]} rx={2} /><text x={r.v >= 0 ? X(r.v) + 4 : X(r.v) - 4} y={y + rowH / 2 + 4} textAnchor={r.v >= 0 ? "start" : "end"} fill={ctx.textColor} fontSize={ctx.fs - 3}>{fmt(r.v, 2)}</text></g>; })}</g>;
  }
  if (type === "sunburst") {
    const cx = inner.x + inner.w / 2, cy = inner.y + inner.h / 2, R = Math.min(inner.w, inner.h) / 2 - 8;
    const total = tree.reduce((t, n) => t + (n.value ?? (n.children ?? []).reduce((s, c) => s + (c.value ?? 0), 0)), 0) || 1;
    let a = -Math.PI / 2;
    const arc = (s: number, e: number, r0: number, r1: number) => { const p = (ang: number, r: number) => [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]; const L = e - s > Math.PI ? 1 : 0; const [x0, y0] = p(s, r1), [x1, y1] = p(e, r1), [x2, y2] = p(e, r0), [x3, y3] = p(s, r0); return `M${x0},${y0} A${r1},${r1} 0 ${L} 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 ${L} 0 ${x3},${y3} Z`; };
    return <g fontFamily={ctx.font} fontSize={ctx.fs - 3}>{tree.map((n, i) => { const v = n.value ?? (n.children ?? []).reduce((s, c) => s + (c.value ?? 0), 0); const b = a + (v / total) * 2 * Math.PI; const outer = <path d={arc(a, b - 0.003, R * 0.35, R * 0.65)} fill={ctx.colors[i % ctx.colors.length]} stroke="#fff" onMouseEnter={() => setHover(`${n.name}: ${fmt(v, ctx.decimals)}`)} onMouseLeave={() => setHover(null)} />; let ca = a; const kids = (n.children ?? []).map((c, j) => { const cv = c.value ?? 0, cb = ca + (cv / (v || 1)) * (b - a); const el = <path key={j} d={arc(ca, cb - 0.003, R * 0.67, R)} fill={ctx.colors[i % ctx.colors.length]} opacity={0.55 + (j % 3) * 0.15} stroke="#fff" onMouseEnter={() => setHover(`${n.name} › ${c.name}: ${fmt(cv, ctx.decimals)}`)} onMouseLeave={() => setHover(null)} />; ca = cb; return el; }); a = b; return <g key={n.name}>{outer}{kids}</g>; })}</g>;
  }
  // squarified-ish treemap (slice & dice alternating)
  const items = tree.map((n) => ({ name: n.name, value: Math.max(0, n.value ?? (n.children ?? []).reduce((s, c) => s + (c.value ?? 0), 0)) })).filter((n) => n.value > 0).sort((a, b) => b.value - a.value);
  const total = items.reduce((t, n) => t + n.value, 0) || 1;
  const rects: { x: number; y: number; w: number; h: number; name: string; value: number }[] = [];
  let x = inner.x, y = inner.y, w = inner.w, h = inner.h, rest = total;
  items.forEach((it) => { const f = it.value / rest; if (w >= h) { const rw = w * f; rects.push({ x, y, w: rw, h, name: it.name, value: it.value }); x += rw; w -= rw; } else { const rh = h * f; rects.push({ x, y, w, h: rh, name: it.name, value: it.value }); y += rh; h -= rh; } rest -= it.value; });
  return <g fontFamily={ctx.font} fontSize={ctx.fs - 2}>{rects.map((r, i) => <g key={r.name} onMouseEnter={() => setHover(`${r.name}: ${fmt(r.value, ctx.decimals)} (${fmt((r.value / total) * 100, 0)}%)`)} onMouseLeave={() => setHover(null)} style={{ cursor: ctx.onSelect ? "pointer" : "default" }} onClick={() => ctx.onSelect?.(ctx.sel === r.name ? null : r.name)}><rect x={r.x + 1} y={r.y + 1} width={Math.max(r.w - 2, 0)} height={Math.max(r.h - 2, 0)} fill={ctx.colors[i % ctx.colors.length]} rx={3} />{r.w > 50 && r.h > 24 && <text x={r.x + 8} y={r.y + 18} fill="#fff" fontWeight={600}>{trunc(r.name, Math.floor(r.w / 7))}</text>}{r.w > 50 && r.h > 40 && <text x={r.x + 8} y={r.y + 34} fill="#fff" fontSize={ctx.fs - 3}>{fmt(r.value, ctx.decimals)} · {fmt((r.value / total) * 100, 0)}%</text>}</g>)}</g>;
}

/* ------------------------------------------------------------ dendrogram */
function Dendrogram({ ctx, inner, data }: { ctx: Ctx; inner: { x: number; y: number; w: number; h: number }; data: ChartData }) {
  const merges = data.dendrogram ?? [];
  if (!merges.length) return <Empty ctx={ctx} inner={inner} />;
  const n = merges.length + 1;
  // leaf order by traversing the final merge
  const pos = new Map<number, number>(); const height = new Map<number, number>();
  const order: number[] = [];
  const walk = (id: number) => { if (id < n) { order.push(id); return; } const m = merges[id - n]; walk(m.left); walk(m.right); };
  walk(n + merges.length - 1);
  order.forEach((leaf, i) => { pos.set(leaf, i); height.set(leaf, 0); });
  const maxH = Math.max(...merges.map((m) => m.height)) || 1;
  const px = inner.x + 10, pw = inner.w - 20, py = inner.y + 10, ph = inner.h - 30;
  const X = (p: number) => px + (p / Math.max(1, n - 1)) * pw, Y = (h: number) => py + ph - (h / maxH) * ph;
  const lines: React.ReactNode[] = [];
  merges.forEach((m, i) => { const id = n + i; const pl = pos.get(m.left)!, pr = pos.get(m.right)!, hl = height.get(m.left)!, hr = height.get(m.right)!; const p = (pl + pr) / 2; pos.set(id, p); height.set(id, m.height); lines.push(<path key={i} d={`M${X(pl)},${Y(hl)} V${Y(m.height)} H${X(pr)} V${Y(hr)}`} fill="none" stroke={ctx.theme.colors.primary} strokeWidth={1.4} />); });
  return <g fontFamily={ctx.font} fontSize={ctx.fs - 4}>{lines}{n <= 60 && order.map((leaf, i) => <text key={leaf} x={X(i)} y={py + ph + 12} textAnchor="middle" fill={ctx.subtle}>{leaf + 1}</text>)}<text x={px} y={py} fill={ctx.subtle} fontSize={ctx.fs - 3}>Merge height</text></g>;
}

/* ------------------------------------------------------------ word cloud */
function WordCloud({ ctx, inner, data }: { ctx: Ctx; inner: { x: number; y: number; w: number; h: number }; data: ChartData }) {
  const words = (data.words ?? []).slice(0, 60);
  if (!words.length) return <Empty ctx={ctx} inner={inner} />;
  const max = Math.max(...words.map((w) => w.value)) || 1, min = Math.min(...words.map((w) => w.value));
  const size = (v: number) => 11 + ((v - min) / (max - min || 1)) * 30;
  // spiral placement with rectangle collision
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const cx = inner.x + inner.w / 2, cy = inner.y + inner.h / 2;
  const [, setHover] = ctx.hover;
  const els = words.map((w, i) => {
    const fs = size(w.value), tw = w.text.length * fs * 0.58, th = fs;
    let x = cx, y = cy, t = 0;
    while (t < 2000) { x = cx + Math.cos(t * 0.35) * t * 1.6; y = cy + Math.sin(t * 0.35) * t * 0.9; const r = { x: x - tw / 2, y: y - th / 2, w: tw, h: th }; if (r.x >= inner.x && r.y >= inner.y && r.x + r.w <= inner.x + inner.w && r.y + r.h <= inner.y + inner.h && !placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y)) { placed.push(r); break; } t++; }
    if (t >= 2000) return null;
    const color = w.sentiment === 1 ? "#157f3d" : w.sentiment === -1 ? "#d02b2b" : ctx.colors[i % ctx.colors.length];
    return <text key={w.text} x={x} y={y + fs / 3} textAnchor="middle" fontSize={fs} fontWeight={fs > 24 ? 700 : 500} fill={color} onMouseEnter={() => setHover(`“${w.text}” — ${w.value} mentions`)} onMouseLeave={() => setHover(null)} style={{ cursor: ctx.onSelect ? "pointer" : "default" }} onClick={() => ctx.onSelect?.(ctx.sel === w.text ? null : w.text)}>{w.text}</text>;
  });
  return <g fontFamily={ctx.font}>{els}</g>;
}

/* ------------------------------------------------------------ network / sankey */
function NetworkChart({ ctx, inner, data, type }: { ctx: Ctx; inner: { x: number; y: number; w: number; h: number }; data: ChartData; type: string }) {
  const nodes = data.nodes ?? [], links = data.links ?? [];
  if (!nodes.length) return <Empty ctx={ctx} inner={inner} />;
  const [, setHover] = ctx.hover;
  if (type === "sankey" || type === "alluvial") {
    // left column: sources, right column: targets
    const src = [...new Set(links.map((l) => l.source))], tgt = [...new Set(links.map((l) => l.target))];
    const total = links.reduce((t, l) => t + Math.abs(l.value), 0) || 1;
    const colH = inner.h - 20, x0 = inner.x + 120, x1 = inner.x + inner.w - 140;
    const layout = (ids: string[]) => { let y = inner.y + 10; return new Map(ids.map((id) => { const v = links.filter((l) => l.source === id || l.target === id).reduce((t, l) => t + Math.abs(l.value), 0); const h = (v / total) * colH * 0.9; const r = { y, h }; y += h + 6; return [id, r]; })); };
    const L = layout(src), R = layout(tgt);
    const offS = new Map<string, number>(), offT = new Map<string, number>();
    return <g fontFamily={ctx.font} fontSize={ctx.fs - 3}>
      {links.map((l, i) => { const s = L.get(l.source)!, t = R.get(l.target)!; if (!s || !t) return null; const h = (Math.abs(l.value) / total) * colH * 0.9; const sy = s.y + (offS.get(l.source) ?? 0), ty = t.y + (offT.get(l.target) ?? 0); offS.set(l.source, (offS.get(l.source) ?? 0) + h); offT.set(l.target, (offT.get(l.target) ?? 0) + h); return <path key={i} d={`M${x0 + 12},${sy} C${(x0 + x1) / 2},${sy} ${(x0 + x1) / 2},${ty} ${x1},${ty} v${h} C${(x0 + x1) / 2},${ty + h} ${(x0 + x1) / 2},${sy + h} ${x0 + 12},${sy + h} Z`} fill={ctx.colors[src.indexOf(l.source) % ctx.colors.length]} opacity={0.45} onMouseEnter={() => setHover(`${l.source} → ${l.target}: ${fmt(l.value, 2)}`)} onMouseLeave={() => setHover(null)} />; })}
      {src.map((id, i) => { const r = L.get(id)!; return <g key={id}><rect x={x0} y={r.y} width={12} height={r.h} fill={ctx.colors[i % ctx.colors.length]} /><text x={x0 - 6} y={r.y + r.h / 2 + 4} textAnchor="end" fill={ctx.textColor}>{trunc(nodes.find((n) => n.id === id)?.label ?? id, 18)}</text></g>; })}
      {tgt.map((id) => { const r = R.get(id)!; return <g key={id}><rect x={x1} y={r.y} width={12} height={r.h} fill={ctx.subtle} /><text x={x1 + 18} y={r.y + r.h / 2 + 4} fill={ctx.textColor}>{trunc(nodes.find((n) => n.id === id)?.label ?? id, 18)}</text></g>; })}
    </g>;
  }
  // circular layout network / chord
  const cx = inner.x + inner.w / 2, cy = inner.y + inner.h / 2, R = Math.min(inner.w, inner.h) / 2 - 40;
  const P = (i: number) => [cx + Math.cos((i / nodes.length) * 2 * Math.PI - Math.PI / 2) * R, cy + Math.sin((i / nodes.length) * 2 * Math.PI - Math.PI / 2) * R];
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const maxV = Math.max(...links.map((l) => Math.abs(l.value))) || 1;
  return <g fontFamily={ctx.font} fontSize={ctx.fs - 3}>
    {links.map((l, i) => { const a = P(idx.get(l.source) ?? 0), b = P(idx.get(l.target) ?? 0); return <path key={i} d={type === "chord" ? `M${a[0]},${a[1]} Q${cx},${cy} ${b[0]},${b[1]}` : `M${a[0]},${a[1]} L${b[0]},${b[1]}`} fill="none" stroke={l.value >= 0 ? ctx.theme.colors.primary : "#d02b2b"} strokeWidth={0.8 + (Math.abs(l.value) / maxV) * 5} opacity={0.6} onMouseEnter={() => setHover(`${l.source} → ${l.target}: ${fmt(l.value, 3)}`)} onMouseLeave={() => setHover(null)} />; })}
    {nodes.map((n, i) => { const [x, y] = P(i); return <g key={n.id}><circle cx={x} cy={y} r={8 + Math.min(10, (n.value ?? 0) / 10)} fill={ctx.colors[(n.group ? [...new Set(nodes.map((m) => m.group))].indexOf(n.group) : i) % ctx.colors.length]} stroke="#fff" strokeWidth={2} /><text x={x + (x > cx ? 14 : -14)} y={y + 4} textAnchor={x > cx ? "start" : "end"} fill={ctx.textColor}>{trunc(n.label, 20)}</text></g>; })}
  </g>;
}

/* ------------------------------------------------------------ waterfall */
function WaterfallChart({ ctx, inner, series }: { ctx: Ctx; inner: { x: number; y: number; w: number; h: number }; series: ReturnType<typeof seriesForChart> }) {
  // series 0 = cumulative or increments; prefer an "Incremental" series when present
  const inc = series.find((s) => /increment/i.test(s.name)) ?? series[0];
  if (!inc || !inc.labels.length) return <Empty ctx={ctx} inner={inner} />;
  const vals = inc.values.map((v) => v ?? 0);
  const cum: number[] = []; let acc = 0; for (const v of vals) { acc += v; cum.push(acc); }
  const maxV = niceMax(Math.max(...cum, 0) || 1);
  const pad = { l: 46, r: 16, t: 10, b: 40 }, px = inner.x + pad.l, py = inner.y + pad.t, pw = inner.w - pad.l - pad.r, ph = inner.h - pad.t - pad.b;
  const band = pw / vals.length, Y = (v: number) => py + ph - (v / maxV) * ph;
  const [, setHover] = ctx.hover;
  return <g fontFamily={ctx.font} fontSize={ctx.fs - 2}>
    {ticks(0, maxV, 5).map((v, i) => <g key={i}><line x1={px} x2={px + pw} y1={Y(v)} y2={Y(v)} stroke={ctx.grid} /><text x={px - 6} y={Y(v) + 4} textAnchor="end" fill={ctx.subtle}>{fmt(v, 0, ctx.pct)}</text></g>)}
    {vals.map((v, i) => { const start = i === 0 ? 0 : cum[i - 1]; const x = px + i * band + band * 0.15; return <g key={i} onMouseEnter={() => setHover(`${inc.labels[i]}: +${fmt(v, ctx.decimals, ctx.pct)} → ${fmt(cum[i], ctx.decimals, ctx.pct)}`)} onMouseLeave={() => setHover(null)}>{i > 0 && <line x1={px + (i - 1) * band + band * 0.85} x2={x} y1={Y(start)} y2={Y(start)} stroke={ctx.subtle} strokeDasharray="3 2" />}<rect x={x} y={Y(cum[i])} width={band * 0.7} height={Math.max(Y(start) - Y(cum[i]), 1)} fill={i === 0 ? ctx.theme.colors.primary : ctx.colors[1 % ctx.colors.length]} rx={2} /><text x={x + band * 0.35} y={Y(cum[i]) - 5} textAnchor="middle" fill={ctx.textColor} fontSize={ctx.fs - 3}>{fmt(cum[i], ctx.decimals, ctx.pct)}</text><text x={x + band * 0.35} y={py + ph + 14} textAnchor="middle" fill={ctx.textColor} transform={vals.length > 6 ? `rotate(-25 ${x + band * 0.35} ${py + ph + 14})` : undefined}>{trunc(inc.labels[i], 14)}</text></g>; })}
  </g>;
}

/* ------------------------------------------------------------ parallel coordinates */
function ParallelChart({ ctx, inner, series }: { ctx: Ctx; inner: { x: number; y: number; w: number; h: number }; series: ReturnType<typeof seriesForChart> }) {
  if (!series.length) return <Empty ctx={ctx} inner={inner} />;
  const axes = series[0].labels, n = axes.length;
  const px = inner.x + 30, pw = inner.w - 60, py = inner.y + 20, ph = inner.h - 50;
  const X = (i: number) => px + (i / Math.max(1, n - 1)) * pw;
  const maxs = axes.map((_, i) => Math.max(...series.map((s) => s.values[i] ?? 0)) || 1), mins = axes.map((_, i) => Math.min(...series.map((s) => s.values[i] ?? 0)));
  const Y = (i: number, v: number) => py + ph - ((v - mins[i]) / ((maxs[i] - mins[i]) || 1)) * ph;
  return <g fontFamily={ctx.font} fontSize={ctx.fs - 3}>{axes.map((a, i) => <g key={a}><line x1={X(i)} x2={X(i)} y1={py} y2={py + ph} stroke={ctx.grid} /><text x={X(i)} y={py + ph + 16} textAnchor="middle" fill={ctx.textColor}>{trunc(a, 14)}</text><text x={X(i)} y={py - 6} textAnchor="middle" fill={ctx.subtle}>{fmt(maxs[i], 1)}</text></g>)}{series.map((s, j) => <polyline key={s.name} points={s.values.map((v, i) => `${X(i)},${Y(i, v ?? 0)}`).join(" ")} fill="none" stroke={ctx.colors[j % ctx.colors.length]} strokeWidth={2} />)}</g>;
}

/* ------------------------------------------------------------ table view (shared by chart fallback and Table Builder) */
export function ResultTableView({ table, dense, maxRows }: { table?: AnalysisResult["tables"][number]; dense?: boolean; maxRows?: number }) {
  if (!table) return <div className="muted">No table.</div>;
  const rows = maxRows ? table.rows.slice(0, maxRows) : table.rows;
  return (
    <div className="ax-table-wrap">
      <table className={`ax-table ${dense ? "dense" : ""}`} data-testid="ax-table">
        <thead><tr>{table.columns.map((c) => <th key={c.key} className={c.type && c.type !== "text" ? "num" : ""}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i}>{table.columns.map((c) => { const v = r[c.key]; const sig = r[`${c.key}__sig`]; const n = r[`${c.key}__n`]; const ct = (r.__format as string | undefined) ?? c.type; return <td key={c.key} className={typeof v === "number" ? "num" : ""} title={typeof n === "number" ? `n = ${n}` : undefined}>{v == null ? "" : typeof v === "number" ? (ct === "pct" ? `${v.toFixed(c.decimals ?? 1)}%` : ct === "count" ? Math.round(v).toLocaleString() : v.toLocaleString("en-US", { maximumFractionDigits: c.decimals ?? 2 })) : String(v)}{sig ? <sup className="ax-sig">{String(sig)}</sup> : null}</td>; })}</tr>)}
        </tbody>
      </table>
      {(table.base || table.notes?.length) && <div className="ax-table-notes">{table.base ? `Base: n = ${table.base.n}${table.base.weightedN != null && table.base.weightedN !== table.base.n ? ` · weighted n = ${table.base.weightedN}` : ""}${table.base.label ? ` · ${table.base.label}` : ""}` : ""}{table.notes?.map((n, i) => <div key={i}>{n}</div>)}</div>}
    </div>
  );
}

export default Chart;
