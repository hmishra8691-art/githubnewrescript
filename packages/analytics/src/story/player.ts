/**
 * THE STORY, AS ONE PAGE A STAKEHOLDER CAN OPEN (Data Analytics audit, Oct 2026, Phase 4).
 *
 * The story document is the `StoryReport` the storyboard already edits,
 * versions and checks: scenes in order, every figure frozen from the result it
 * came from, every scene pointing back at its source. This renders that
 * document as a single self-contained HTML file — the player:
 *
 *   · one scene at a time with the finding as its headline, the evidence under
 *     it (a chart drawn from the frozen numbers, or the table), the context in
 *     one line, what the evidence supports (in words, never colour alone) and
 *     the caveats;
 *   · "How was this calculated" on every scene: the analysis, base, test,
 *     definition hash, run and the data's date — read from the document, not
 *     from memory;
 *   · an outline to jump around, key points or everything, chart or table,
 *     keyboard control, full screen for a meeting, print / PDF with every
 *     scene and no motion;
 *   · motion limited to a reveal, and off when the reader's system asks for
 *     reduced motion (or the design says none);
 *   · its own fonts (a Latin subset, base64) because /report-fonts/* is not
 *     reachable from a shared link, and no network of any kind: a content
 *     security policy forbids it.
 *
 * It never draws a number the document does not hold, and it never updates
 * itself: data newer than the story shows a banner, not silently new figures.
 * Everything that came from a person or a model is escaped.
 */
import { formatValue, displayDecimals, chartWords } from "./charts.js";
import { PLAYER_FONTS, PLAYER_FONT_FORMAT } from "./playerFonts.js";
import { tableCellText } from "./layout.js";
import { contrast } from "./design.js";
import type { EvidenceLevel, FrozenChartData, FrozenTable, Scene, SourceRef, StoryChartType, StoryReport } from "./types.js";

const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const color = (c: string | undefined, fallback: string) => (c && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : fallback);
const safeImg = (u: string | undefined) => (u && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(u) ? u : "");

export type PlayerAudience = "all" | "key";

export interface PlayerOptions {
  /** responses have arrived since the story's data was frozen — shown as a banner, never applied */
  newerData?: { since: string; responses?: number } | null;
  /** the page opens on key points or on everything */
  audience?: PlayerAudience;
  /** the page's own language tag */
  lang?: string;
}

/* ------------------------------------------------------------ what a scene is for */

/** the scenes a busy reader needs: the answer, the evidence that matters, what to do — everything else is for a researcher */
export function sceneTier(s: Scene): "key" | "detail" {
  if (s.section === "appendix") return "detail";
  if (["title", "summary", "conclusions", "recommendations", "closing", "kpis", "statistic"].includes(s.kind)) return "key";
  if (s.kind === "finding" || s.kind === "comparison") return s.emphasis === "focus" || s.evidence === "significant" ? "key" : "detail";
  if (s.kind === "hypotheses") return "key";
  return "detail";
}

export const EVIDENCE_WORDS: Record<EvidenceLevel, { label: string; means: string }> = {
  significant: { label: "Supported by a test", means: "A statistical test found this difference unlikely to be chance." },
  not_significant: { label: "No clear difference", means: "A test did not find a difference larger than chance would produce." },
  descriptive: { label: "Descriptive", means: "These are the figures as observed; no test was run on them." },
  mixed: { label: "Mixed evidence", means: "Significant on its own, but not after allowing for the number of comparisons made." },
  exploratory: { label: "Exploratory", means: "A pattern worth a closer look, not a conclusion." },
};

/* ------------------------------------------------------------ the sentence a screen reader gets for a chart */

/** text that states what the chart shows — the finding, not "chart" */
export function chartAlt(data: FrozenChartData, type: StoryChartType, title: string): string {
  const d = displayDecimals(data, 0);
  const f = (v: number | null | undefined) => formatValue(v, data, d);
  const s0 = data.series[0];
  const base = data.base != null ? ` Base: ${data.base} respondents.` : "";
  if (!s0) return `${title}.${base}`;
  const idx = s0.values.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => x.v != null);
  const top = [...idx].sort((a, b) => b.v - a.v)[0];
  const low = [...idx].sort((a, b) => a.v - b.v)[0];
  if (data.series.length === 1) {
    const rest = top && low && top.i !== low.i ? ` ${data.categories[top.i]} is highest at ${f(top.v)}; ${data.categories[low.i]} is lowest at ${f(low.v)}.` : top ? ` ${data.categories[top.i]}: ${f(top.v)}.` : "";
    return `${chartWords(type)}: ${title}.${rest}${base}`;
  }
  const all = data.series.map((s) => `${s.name}: ${data.categories.map((c, i) => `${c} ${f(s.values[i])}`).join(", ")}`).join("; ");
  return `${chartWords(type)}: ${title}. ${all}.${base}`;
}

/* ------------------------------------------------------------ charts: frozen numbers drawn as plain SVG */

const W = 720, H = 380;
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

function niceMax(max: number, pct: boolean): number {
  if (pct && max <= 100 && max > 60) return 100;
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max)); const m = max / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

function chartSvg(type: StoryChartType, data: FrozenChartData, palette: string[], decimals: number, labels: boolean): string {
  const f = (v: number | null | undefined) => formatValue(v, data, decimals);
  const series = data.series;
  const cats = data.categories;
  const pct = data.valueFormat === "pct";
  const col = (i: number) => color(palette[i % palette.length], "#2563eb");
  const legend = series.length > 1 && type !== "donut"
    ? `<g class="legend">${series.map((s, i) => `<g transform="translate(${8 + i * 150},${H - 14})"><rect width="12" height="12" fill="${col(i)}" rx="2"/><text x="18" y="10">${esc(trunc(s.name, 20))}</text></g>`).join("")}</g>`
    : "";
  const bottom = series.length > 1 && type !== "donut" ? 34 : 14;
  if (type === "donut") {
    const vals = (series[0]?.values ?? []).map((v) => (v != null && v > 0 ? v : 0));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = 190, cy = 190, R = 150, r = 88;
    let a0 = -Math.PI / 2;
    const arcs = vals.map((v, i) => {
      if (!v) return "";
      const a1 = a0 + (v / total) * Math.PI * 2 - (vals.filter(Boolean).length > 1 ? 0.012 : 0);
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rad: number, a: number) => `${(cx + rad * Math.cos(a)).toFixed(1)} ${(cy + rad * Math.sin(a)).toFixed(1)}`;
      const d = vals.filter(Boolean).length === 1
        ? `M ${cx - R} ${cy} a ${R} ${R} 0 1 0 ${R * 2} 0 a ${R} ${R} 0 1 0 ${-R * 2} 0 M ${cx - r} ${cy} a ${r} ${r} 0 1 1 ${r * 2} 0 a ${r} ${r} 0 1 1 ${-r * 2} 0`
        : `M ${p(R, a0)} A ${R} ${R} 0 ${large} 1 ${p(R, a1)} L ${p(r, a1)} A ${r} ${r} 0 ${large} 0 ${p(r, a0)} Z`;
      a0 = a1 + 0.012;
      return `<path d="${d}" fill="${col(i)}" fill-rule="evenodd"><title>${esc(cats[i])}: ${esc(f(series[0].values[i]))}</title></path>`;
    }).join("");
    const key = cats.map((c, i) => `<g transform="translate(380,${40 + i * 26})"><rect width="14" height="14" fill="${col(i)}" rx="2"/><text x="22" y="12">${esc(trunc(c, 30))} — ${esc(f(series[0].values[i]))}</text></g>`).join("");
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><g class="grow">${arcs}</g>${key}</svg>`;
  }
  if (type === "line") {
    const L = 52, T = 16, pw = W - L - 20, ph = H - T - bottom - 28;
    const all = series.flatMap((s) => s.values).filter((v): v is number => v != null);
    const hi = niceMax(Math.max(0, ...all), pct), lo = Math.min(0, ...all);
    const x = (i: number) => L + (cats.length <= 1 ? pw / 2 : (i / (cats.length - 1)) * pw);
    const y = (v: number) => T + ph - ((v - lo) / (hi - lo || 1)) * ph;
    const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => { const v = lo + (hi - lo) * t; return `<line x1="${L}" x2="${W - 20}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="axis">${esc(f(v))}</text>`; }).join("");
    const xl = cats.map((c, i) => (cats.length <= 8 || i % Math.ceil(cats.length / 8) === 0 ? `<text x="${x(i).toFixed(1)}" y="${T + ph + 18}" text-anchor="middle" class="axis">${esc(trunc(c, 12))}</text>` : "")).join("");
    const lines = series.map((s, si) => {
      const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)] as [number, number]));
      const path = pts.reduce((d, p, i) => (p ? `${d}${d && pts[i - 1] ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}` : d), "");
      const dots = pts.map((p, i) => (p ? `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="${col(si)}"><title>${esc(s.name)}, ${esc(cats[i])}: ${esc(f(s.values[i]))}</title></circle>${labels && (series.length === 1 || i === pts.length - 1) ? `<text x="${p[0].toFixed(1)}" y="${(p[1] - 9).toFixed(1)}" text-anchor="middle" class="val">${esc(f(s.values[i]))}</text>` : ""}` : "")).join("");
      return `<path d="${path}" fill="none" stroke="${col(si)}" stroke-width="3" class="draw"/>${dots}`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${grid}${xl}${lines}${legend}</svg>`;
  }
  if (type === "hbar" || type === "stacked_100") {
    const L = Math.min(210, 20 + Math.max(...cats.map((c) => Math.min(c.length, 28))) * 7), R = 60, T = 8, pw = W - L - R, ph = H - T - bottom;
    const band = ph / Math.max(1, cats.length), bh = type === "stacked_100" ? Math.min(34, band * 0.62) : Math.min(30, (band * 0.72) / series.length);
    if (type === "stacked_100") {
      const rows = cats.map((c, i) => {
        const vs = series.map((s) => s.values[i] ?? 0); const sum = vs.reduce((a, b) => a + b, 0) || 1; let acc = 0;
        const segs = vs.map((v, si) => { const w = (v / sum) * pw; const seg = `<rect x="${(L + acc).toFixed(1)}" y="${(T + i * band + (band - bh) / 2).toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${bh.toFixed(1)}" fill="${col(si)}"><title>${esc(series[si].name)}, ${esc(c)}: ${esc(f(series[si].values[i]))}</title></rect>${labels && w > 38 ? `<text x="${(L + acc + w / 2).toFixed(1)}" y="${(T + i * band + band / 2 + 4).toFixed(1)}" text-anchor="middle" class="inval">${esc(f(series[si].values[i]))}</text>` : ""}`; acc += w; return seg; }).join("");
        return `<text x="${L - 8}" y="${(T + i * band + band / 2 + 4).toFixed(1)}" text-anchor="end" class="cat">${esc(trunc(c, 28))}</text>${segs}`;
      }).join("");
      return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><g class="grow-x">${rows}</g>${legend}</svg>`;
    }
    const hi = niceMax(Math.max(0, ...series.flatMap((s) => s.values).filter((v): v is number => v != null)), pct);
    const rows = cats.map((c, i) => {
      const bars = series.map((s, si) => { const v = s.values[i]; const w = v == null ? 0 : (Math.max(0, v) / hi) * pw; const y = T + i * band + (band - bh * series.length) / 2 + si * bh; return `<rect x="${L}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${(bh - 2).toFixed(1)}" fill="${col(si)}" rx="2"><title>${esc(s.name)}, ${esc(c)}: ${esc(f(v))}</title></rect>${labels ? `<text x="${(L + w + 6).toFixed(1)}" y="${(y + bh / 2 + 3).toFixed(1)}" class="val">${esc(f(v))}${s.sig?.[i] ? ` ${esc(s.sig[i])}` : ""}</text>` : ""}`; }).join("");
      return `<text x="${L - 8}" y="${(T + i * band + band / 2 + 4).toFixed(1)}" text-anchor="end" class="cat">${esc(trunc(c, 28))}</text>${bars}`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><line x1="${L}" x2="${L}" y1="${T}" y2="${T + ph}" class="grid"/><g class="grow-x">${rows}</g>${legend}</svg>`;
  }
  /* bar (vertical) and grouped_bar */
  const L = 52, T = 22, pw = W - L - 20, ph = H - T - bottom - 34;
  const all = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  const hi = niceMax(Math.max(0, ...all), pct);
  const band = pw / Math.max(1, cats.length), bw = Math.min(64, (band * 0.72) / series.length);
  const y = (v: number) => T + ph - (Math.max(0, v) / hi) * ph;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => `<line x1="${L}" x2="${W - 20}" y1="${y(hi * t).toFixed(1)}" y2="${y(hi * t).toFixed(1)}" class="grid"/><text x="${L - 6}" y="${(y(hi * t) + 4).toFixed(1)}" text-anchor="end" class="axis">${esc(f(hi * t))}</text>`).join("");
  const bars = cats.map((c, i) => {
    const bs = series.map((s, si) => { const v = s.values[i]; if (v == null) return ""; const x = L + i * band + (band - bw * series.length) / 2 + si * bw; return `<rect x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${(T + ph - y(v)).toFixed(1)}" fill="${col(si)}" rx="2"><title>${esc(s.name)}, ${esc(c)}: ${esc(f(v))}</title></rect>${labels ? `<text x="${(x + (bw - 2) / 2).toFixed(1)}" y="${(y(v) - 6).toFixed(1)}" text-anchor="middle" class="val">${esc(f(v))}${s.sig?.[i] ? ` ${esc(s.sig[i])}` : ""}</text>` : ""}`; }).join("");
    return `${bs}<text x="${(L + i * band + band / 2).toFixed(1)}" y="${T + ph + 18}" text-anchor="middle" class="axis">${esc(trunc(c, Math.max(6, Math.floor(band / 7))))}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${grid}<g class="grow">${bars}</g>${legend}</svg>`;
}

/* ------------------------------------------------------------ tables */

function dataTable(data: FrozenChartData, decimals: number, caption: string): string {
  const f = (v: number | null | undefined) => formatValue(v, data, decimals);
  return `<table class="data"><caption>${esc(caption)}</caption><thead><tr><th scope="col"></th>${data.series.map((s) => `<th scope="col">${esc(s.name)}</th>`).join("")}</tr></thead><tbody>${data.categories.map((c, i) => `<tr><th scope="row">${esc(c)}</th>${data.series.map((s) => `<td>${esc(f(s.values[i]))}${s.sig?.[i] ? ` <span class="sig">${esc(s.sig[i])}</span>` : ""}</td>`).join("")}</tr>`).join("")}</tbody>${data.seriesBases?.some((b) => b != null) ? `<tfoot><tr><th scope="row">Base (n)</th>${data.seriesBases.map((b) => `<td>${b ?? "—"}</td>`).join("")}</tr></tfoot>` : ""}</table>`;
}

function frozenTable(t: FrozenTable): string {
  return `<table class="data"><caption>${esc(t.title)}</caption><thead><tr>${t.columns.map((c) => `<th scope="col">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${t.rows.map((r) => `<tr>${t.columns.map((c, i) => (i === 0 ? `<th scope="row">${esc(tableCellText(r, c))}</th>` : `<td class="${c.numeric ? "n" : ""}">${esc(tableCellText(r, c))}</td>`)).join("")}</tr>`).join("")}</tbody></table>`;
}

/* ------------------------------------------------------------ how was this calculated */

const short = (h: string | undefined) => (h ? h.slice(0, 10) : "");

function sourceLines(src: SourceRef[]): string {
  return src.map((s) => `<li><b>${esc(s.name)}</b>${s.definitionHash ? ` · definition <code>${esc(short(s.definitionHash))}</code>` : ""}${s.runId ? ` · run <code>${esc(short(s.runId))}</code>` : ""}${s.plannedId ? ` · plan item <code>${esc(s.plannedId)}</code>` : ""}</li>`).join("");
}

function howCalculated(story: StoryReport, s: Scene): string {
  const v = s.visual;
  const rows: string[] = [];
  const src = s.notes.sources.length ? s.notes.sources : (v.type === "chart" || v.type === "table") ? [v.source] : [];
  if (src.length) rows.push(`<div><dt>From</dt><dd><ul>${sourceLines(src)}</ul></dd></div>`);
  if (v.type === "chart") {
    rows.push(`<div><dt>Measure</dt><dd>${esc(v.data.measure)}</dd></div>`);
    rows.push(`<div><dt>Base</dt><dd>${v.data.base != null ? `${v.data.base} respondents` : "not recorded"}${v.data.seriesBases?.some((b) => b != null) ? `; per column ${v.data.series.map((x, i) => `${esc(x.name)} ${v.data.seriesBases![i] ?? "—"}`).join(", ")}` : ""}</dd></div>`);
    rows.push(`<div><dt>Testing</dt><dd>${v.data.significanceTested ? "Letters or a test mark a difference only where a significance test found one." : "No significance test is shown for this figure."}</dd></div>`);
  }
  if (v.type === "table") rows.push(`<div><dt>Base</dt><dd>${v.table.base != null ? `${v.table.base} respondents` : "not recorded"}</dd></div>`);
  if (s.evidence) rows.push(`<div><dt>Evidence</dt><dd>${esc(EVIDENCE_WORDS[s.evidence].label)} — ${esc(EVIDENCE_WORDS[s.evidence].means)}</dd></div>`);
  if (s.notes.footnotes.length) rows.push(`<div><dt>Notes</dt><dd>${s.notes.footnotes.map((n) => esc(n)).join(" ")}</dd></div>`);
  rows.push(`<div><dt>Data</dt><dd>${esc(story.createdFrom.environment)} data, ${esc(story.createdFrom.dataset)} responses, ${story.createdFrom.n} respondents, computed ${esc(story.createdFrom.computedAt.slice(0, 10))}. Figures are frozen: they do not change if the survey receives more responses.</dd></div>`);
  return `<details class="how"><summary>How was this calculated?</summary><dl>${rows.join("")}</dl></details>`;
}

/* ------------------------------------------------------------ a scene */

function evidenceBlock(story: StoryReport, s: Scene, palette: string[]): string {
  const v = s.visual;
  switch (v.type) {
    case "chart": {
      const decimals = displayDecimals(v.data, story.design.dataLabels.decimals);
      const alt = chartAlt(v.data, v.chart, s.title);
      return `<figure class="evidence" data-view="chart"><div class="view-chart" role="img" aria-label="${esc(alt)}">${chartSvg(v.chart, v.data, palette, decimals, story.design.dataLabels.show)}</div><div class="view-table" hidden>${dataTable(v.data, decimals, `${s.title} — the figures`)}</div>${v.data.significanceTested ? `<p class="small">Letters mark a difference a significance test found.</p>` : ""}<button type="button" class="toggle" aria-pressed="false" data-toggle-view>Show as table</button></figure>`;
    }
    case "table": return `<figure class="evidence">${frozenTable(v.table)}${v.table.notes.length ? `<figcaption class="small">${v.table.notes.map(esc).join(" ")}</figcaption>` : ""}</figure>`;
    case "bullets": return `<ul class="bullets">${v.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
    case "kpis": return `<ul class="kpis">${v.items.map((k) => `<li><span class="kv">${esc(k.value)}</span><span class="kl">${esc(k.label)}</span>${k.detail ? `<span class="kd">${esc(k.detail)}</span>` : ""}</li>`).join("")}</ul>`;
    case "stat": return `<p class="stat"><span class="kv">${esc(v.value)}</span><span class="kl">${esc(v.label)}</span><span class="kd">${esc(v.detail)}</span></p>`;
    case "verdicts": return `<ul class="verdicts">${v.items.map((i) => `<li><span class="vb v-${i.verdict}">${esc(({ supported: "Supported", not_supported: "Not supported", mixed: "Mixed", inconclusive: "Inconclusive", untested: "Not tested" } as const)[i.verdict])}</span> <b>${esc(i.label)}</b> ${esc(i.text)}<span class="small"> ${esc(i.reason)}</span></li>`).join("")}</ul>`;
    case "facts": return `<dl class="facts">${v.items.map((i) => `<div><dt>${esc(i.label)}</dt><dd>${esc(i.value)}</dd></div>`).join("")}</dl>`;
    default: return "";
  }
}

function sceneHtml(story: StoryReport, s: Scene, i: number, palette: string[]): string {
  const id = `s-${i}`;
  const ev = s.evidence ? EVIDENCE_WORDS[s.evidence] : null;
  const ctx = s.visual.type === "chart"
    ? `${esc(s.visual.data.measure)}${s.visual.data.base != null ? ` · base ${s.visual.data.base}` : ""}`
    : s.visual.type === "table" && s.visual.table.base != null ? `Base ${s.visual.table.base}` : "";
  return `<section class="scene" id="${id}" data-tier="${sceneTier(s)}" data-kind="${esc(s.kind)}" aria-labelledby="${id}-h" tabindex="-1">
<header>${s.kicker ? `<p class="kicker">${esc(s.kicker)}</p>` : ""}<h2 id="${id}-h">${esc(s.title)}</h2>${s.subtitle ? `<p class="sub">${esc(s.subtitle)}</p>` : ""}</header>
${s.body ? `<p class="body">${esc(s.body)}</p>` : ""}
${evidenceBlock(story, s, palette)}
${ctx ? `<p class="ctx">${ctx}</p>` : ""}
${ev ? `<p class="evidence-label"><span class="badge" data-level="${s.evidence}"><span aria-hidden="true">${s.evidence === "significant" ? "✓" : s.evidence === "not_significant" ? "–" : s.evidence === "mixed" ? "~" : "·"}</span> ${esc(ev.label)}</span> <span class="small">${esc(ev.means)}</span></p>` : ""}
${s.notes.caveats.length ? `<div class="caveats" role="note"><b>Read with care</b><ul>${s.notes.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>` : ""}
${s.visual.type === "chart" || s.visual.type === "table" || s.notes.sources.length ? howCalculated(story, s) : ""}
</section>`;
}

/* ------------------------------------------------------------ the page */

export function storyPlayerHtml(story: StoryReport, opts: PlayerOptions = {}): string {
  const d = story.design;
  const c = d.colors;
  const bg = color(c.background, "#ffffff"), text = color(c.text, "#141b26"), muted = color(c.textMuted, "#4a5568"), primary = color(c.primary, "#1f3a5f"), accent = color(c.accent, "#b8892b"), surface = color(c.surface, "#f3f5f8"), grid = color(c.grid, "#d7dde5");
  const palette = (c.chart?.length ? c.chart : [primary, accent]).map((x) => color(x, "#2563eb"));
  const families = [...new Set([d.typography.heading, d.typography.body, d.typography.numeric])].filter((f) => PLAYER_FONTS[f]);
  const faces = families.flatMap((f) => ([400, 700] as const).map((w) => `@font-face{font-family:"${f}";font-weight:${w};font-style:normal;font-display:swap;src:url(data:font/${PLAYER_FONT_FORMAT};base64,${PLAYER_FONTS[f][w]}) format("${PLAYER_FONT_FORMAT}")}`)).join("");
  const stack = (f: string) => `"${PLAYER_FONTS[f] ? f : "Inter"}", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const motionOn = d.motion.style !== "none";
  const scenes = story.scenes;
  const main = scenes.filter((s) => s.section === "main");
  const appendix = scenes.filter((s) => s.section === "appendix");
  const ordered = [...main, ...appendix];
  const logo = safeImg(d.logo?.dataUri);
  const startKey = opts.audience === "key";
  const asOf = story.createdFrom.computedAt.slice(0, 10);
  const css = `${faces}
:root{--bg:${bg};--text:${text};--muted:${muted};--primary:${primary};--accent:${accent};--surface:${surface};--grid:${grid};--on-primary:${contrast(primary, "#ffffff") >= contrast(primary, "#000000") ? "#ffffff" : "#000000"}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--text);font:17px/1.55 ${stack(d.typography.body)};-webkit-text-size-adjust:100%}
h1,h2{font-family:${stack(d.typography.heading)};font-weight:700;line-height:1.2;margin:0}
.kv,.val,table.data td{font-family:${stack(d.typography.numeric)};font-variant-numeric:tabular-nums}
a{color:var(--primary)}:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;background:var(--bg);padding:8px;z-index:10}
.top{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center;padding:14px 24px;border-bottom:1px solid var(--grid);background:var(--surface)}
.top h1{font-size:1.15rem}.top .meta{color:var(--muted);font-size:.85rem}.top img{height:28px}
.tools{margin-left:auto;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
button{font:inherit;font-size:.9rem;padding:6px 12px;border:1px solid var(--grid);background:var(--bg);color:var(--text);border-radius:6px;cursor:pointer}
button[aria-pressed=true],button.on{background:var(--primary);color:var(--on-primary);border-color:var(--primary)}
.banner{margin:0;padding:10px 24px;background:#fff4d6;color:#5a4300;border-bottom:1px solid #e6cf8a;font-size:.92rem}
.layout{display:grid;grid-template-columns:minmax(180px,260px) 1fr;min-height:calc(100vh - 120px)}
nav.outline{border-right:1px solid var(--grid);padding:16px 12px;font-size:.9rem;background:var(--surface)}
nav.outline ol{list-style:none;margin:0;padding:0}nav.outline li{margin:2px 0}
nav.outline button{width:100%;text-align:left;border:0;background:transparent;padding:6px 8px;border-radius:6px}
nav.outline button[aria-current=step]{background:var(--primary);color:var(--on-primary)}
nav.outline .appx{margin:12px 8px 4px;color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.06em}
main{padding:28px clamp(16px,4vw,56px) 80px;max-width:980px;width:100%}
.scene header{margin-bottom:12px}.kicker{margin:0 0 4px;color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.08em}
.scene h2{font-size:clamp(1.5rem,3.2vw,2.1rem)}.sub{margin:6px 0 0;color:var(--muted)}.body{font-size:1.05rem;max-width:62ch}
.evidence{margin:18px 0 8px;padding:14px;border:1px solid var(--grid);border-radius:10px;background:var(--bg)}
.evidence svg{width:100%;height:auto;display:block}.evidence text{fill:var(--text);font-size:13px;font-family:inherit}
.evidence .axis{fill:var(--muted);font-size:12px}.evidence .grid{stroke:var(--grid);stroke-width:1}.evidence .inval{fill:#fff;font-weight:700;paint-order:stroke;stroke:rgba(0,0,0,.35);stroke-width:2px}
.evidence .val{font-weight:700}.legend text{font-size:12px}
.toggle{margin-top:8px}.small{color:var(--muted);font-size:.85rem}.ctx{margin:6px 0;color:var(--muted);font-size:.9rem}
table.data{border-collapse:collapse;width:100%;font-size:.92rem}table.data caption{text-align:left;font-weight:700;padding-bottom:6px}
table.data th,table.data td{padding:6px 10px;border-bottom:1px solid var(--grid);text-align:right}table.data th[scope=col]:first-child,table.data th[scope=row]{text-align:left;font-weight:600}
table.data thead th{background:var(--surface)}.sig{color:var(--primary);font-weight:700}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;border:1.5px solid var(--primary);font-weight:700;font-size:.85rem}
.caveats{margin:12px 0;padding:10px 14px;border-left:4px solid var(--accent);background:var(--surface);font-size:.92rem}.caveats ul{margin:4px 0 0 18px;padding:0}
details.how{margin:12px 0;border:1px solid var(--grid);border-radius:8px;padding:6px 12px}details.how summary{cursor:pointer;font-weight:600}
details.how dl{margin:8px 0 4px}details.how dl>div{display:grid;grid-template-columns:110px 1fr;gap:8px;padding:5px 0;border-top:1px solid var(--grid);font-size:.9rem}details.how dt{color:var(--muted)}details.how dd{margin:0}details.how ul{margin:0;padding-left:16px}
.kpis{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.kpis li,.stat{padding:14px;border:1px solid var(--grid);border-radius:10px;background:var(--surface);display:flex;flex-direction:column;gap:2px}
.kv{font-size:2.2rem;font-weight:700;color:var(--primary)}.kl{font-weight:600}.kd{color:var(--muted);font-size:.88rem}
.verdicts{list-style:none;padding:0}.verdicts li{padding:8px 0;border-bottom:1px solid var(--grid)}.vb{display:inline-block;padding:1px 8px;border:1.5px solid var(--primary);border-radius:6px;font-weight:700;font-size:.8rem}
.facts{display:grid;gap:6px}.facts>div{display:grid;grid-template-columns:160px 1fr;gap:8px;border-bottom:1px solid var(--grid);padding:4px 0}.facts dt{color:var(--muted)}.facts dd{margin:0}
footer.foot{padding:16px 24px;border-top:1px solid var(--grid);color:var(--muted);font-size:.82rem}
.pager{position:sticky;bottom:0;display:flex;gap:8px;align-items:center;padding:10px 24px;background:var(--surface);border-top:1px solid var(--grid)}.pager .count{margin:0 auto;color:var(--muted);font-size:.9rem}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.js .scene{display:none}.js .scene.active{display:block}.js .scene.filtered{display:none!important}
${motionOn ? `@media (prefers-reduced-motion:no-preference){.js .scene.active{animation:rise .35s ease both}.grow rect,.grow path{transform-box:fill-box;transform-origin:bottom;animation:grow .6s ease both}.grow-x rect{transform-box:fill-box;transform-origin:left;animation:growx .6s ease both}.draw{stroke-dasharray:1200;stroke-dashoffset:1200;animation:draw .9s ease forwards}}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}@keyframes growx{from{transform:scaleX(0)}to{transform:scaleX(1)}}@keyframes draw{to{stroke-dashoffset:0}}` : ""}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media (max-width:760px){.layout{grid-template-columns:1fr}nav.outline{border-right:0;border-bottom:1px solid var(--grid)}.top{padding:12px 16px}}
.present .top,.present nav.outline,.present footer.foot,.present .banner{display:none}.present .layout{grid-template-columns:1fr}.present main{max-width:1180px;margin:0 auto;font-size:1.15em}
@media print{.top .tools,nav.outline,.pager,button,.banner.screen{display:none!important}.layout{display:block}.js .scene,.js .scene.filtered{display:block!important;break-inside:avoid;page-break-after:always;animation:none!important}.view-table{display:none}.evidence{border:0}.grow rect,.draw{animation:none!important}details.how{display:block}details.how:not([open])>dl{display:block}}`;
  const outline = ordered.map((s, i) => ({ s, i }));
  const mainIdx = outline.filter((o) => o.s.section === "main"), appxIdx = outline.filter((o) => o.s.section === "appendix");
  const outlineBtn = (o: { s: Scene; i: number }) => `<li data-tier="${sceneTier(o.s)}"><button type="button" data-go="${o.i}">${esc(o.s.title)}</button></li>`;
  const body = `<a class="skip" href="#main">Skip to the story</a>
<div class="top"><div>${logo ? `<img src="${logo}" alt="" />` : ""}<h1>${esc(story.title)}</h1>${story.subtitle ? `<div class="meta">${esc(story.subtitle)}</div>` : ""}</div>
<div class="meta" id="asof">Data as of ${esc(asOf)} · ${story.createdFrom.n} respondents</div>
<div class="tools" role="toolbar" aria-label="Story controls"><span id="tierlabel" class="small">Show:</span><button type="button" data-tier-btn="key" aria-pressed="${startKey}">Key points</button><button type="button" data-tier-btn="all" aria-pressed="${!startKey}">Everything</button><button type="button" id="present">Present</button><button type="button" id="print">Print / PDF</button></div></div>
${opts.newerData ? `<p class="banner" role="status" data-testid="newer-data">This story shows the data frozen on ${esc(asOf)}. ${opts.newerData.responses ? `${opts.newerData.responses} more ${opts.newerData.responses === 1 ? "response has" : "responses have"} arrived since ` : "More responses have arrived since "}${esc(opts.newerData.since.slice(0, 10))}. The figures below have not changed; ask the author for a new version to include them.</p>` : ""}
<div class="layout"><nav class="outline" aria-label="Story outline"><ol>${mainIdx.map(outlineBtn).join("")}</ol>${appxIdx.length ? `<div class="appx">Appendix</div><ol>${appxIdx.map(outlineBtn).join("")}</ol>` : ""}</nav>
<main id="main" aria-live="polite">${ordered.map((s, i) => sceneHtml(story, s, i, palette)).join("\n")}</main></div>
<div class="pager"><button type="button" id="prev" aria-label="Previous scene">← Back</button><span class="count" id="count" aria-live="polite"></span><button type="button" id="next" aria-label="Next scene">Next →</button></div>
<footer class="foot">Every figure is frozen from the analysis it came from; “How was this calculated?” on a scene names it. Keys: ← → move, Home / End jump, T chart or table, H how it was calculated, P present, Esc leave.</footer>`;
  const script = `(function(){
var d=document,root=d.documentElement;root.classList.add("js");
var scenes=[].slice.call(d.querySelectorAll(".scene")),btns=[].slice.call(d.querySelectorAll("[data-go]"));
var tier=${JSON.stringify(startKey ? "key" : "all")},cur=0;
function visible(i){return tier==="all"||scenes[i].getAttribute("data-tier")==="key"}
function show(i,focus){if(!visible(i)){var n=next(i,1)>=0?next(i,1):next(i,-1);if(n<0)return;i=n}
cur=i;scenes.forEach(function(s,k){s.classList.toggle("active",k===i);s.classList.toggle("filtered",!visible(k))});
btns.forEach(function(b){var k=+b.getAttribute("data-go");b.parentNode.style.display=visible(k)?"":"none";if(k===i)b.setAttribute("aria-current","step");else b.removeAttribute("aria-current")});
var vis=scenes.map(function(_,k){return k}).filter(visible);d.getElementById("count").textContent="Scene "+(vis.indexOf(i)+1)+" of "+vis.length;
d.getElementById("prev").disabled=next(i,-1)<0;d.getElementById("next").disabled=next(i,1)<0;
try{history.replaceState(null,"","#"+scenes[i].id)}catch(e){}
if(focus!==false){scenes[i].focus({preventScroll:true});window.scrollTo(0,0)}}
function next(i,dir){for(var k=i+dir;k>=0&&k<scenes.length;k+=dir)if(visible(k))return k;return -1}
function go(dir){var n=next(cur,dir);if(n>=0)show(n)}
btns.forEach(function(b){b.addEventListener("click",function(){show(+b.getAttribute("data-go"))})});
d.getElementById("prev").addEventListener("click",function(){go(-1)});d.getElementById("next").addEventListener("click",function(){go(1)});
[].slice.call(d.querySelectorAll("[data-tier-btn]")).forEach(function(b){b.addEventListener("click",function(){tier=b.getAttribute("data-tier-btn");[].slice.call(d.querySelectorAll("[data-tier-btn]")).forEach(function(x){x.setAttribute("aria-pressed",String(x===b))});show(cur,false)})});
[].slice.call(d.querySelectorAll("[data-toggle-view]")).forEach(function(b){b.addEventListener("click",function(){var f=b.closest("figure"),t=f.getAttribute("data-view")==="chart";f.setAttribute("data-view",t?"table":"chart");f.querySelector(".view-chart").hidden=t;f.querySelector(".view-table").hidden=!t;b.setAttribute("aria-pressed",String(t));b.textContent=t?"Show as chart":"Show as table"})});
function present(on){root.classList.toggle("present",on);d.getElementById("present").setAttribute("aria-pressed",String(on));if(on&&root.requestFullscreen)root.requestFullscreen().catch(function(){});if(!on&&d.fullscreenElement&&d.exitFullscreen)d.exitFullscreen()}
d.getElementById("present").addEventListener("click",function(){present(!root.classList.contains("present"))});
d.getElementById("print").addEventListener("click",function(){window.print()});
d.addEventListener("keydown",function(e){if(e.altKey||e.ctrlKey||e.metaKey)return;var t=e.target&&e.target.tagName;if(t==="INPUT"||t==="TEXTAREA"||t==="SELECT")return;var k=e.key;
if(k==="ArrowRight"||k==="PageDown"||(k===" "&&t!=="BUTTON"&&t!=="SUMMARY")){e.preventDefault();go(1)}
else if(k==="ArrowLeft"||k==="PageUp"){e.preventDefault();go(-1)}
else if(k==="Home"){e.preventDefault();var f=next(-1,1);if(f>=0)show(f)}
else if(k==="End"){e.preventDefault();var l=next(scenes.length,-1);if(l>=0)show(l)}
else if(k==="t"||k==="T"){var b=scenes[cur].querySelector("[data-toggle-view]");if(b)b.click()}
else if(k==="h"||k==="H"){var h=scenes[cur].querySelector("details.how");if(h)h.open=!h.open}
else if(k==="p"||k==="P"){present(!root.classList.contains("present"))}
else if(k==="Escape"&&root.classList.contains("present"))present(false)});
d.addEventListener("fullscreenchange",function(){if(!d.fullscreenElement&&root.classList.contains("present"))present(false)});
var start=0,h=(location.hash||"").slice(1);scenes.forEach(function(s,k){if(s.id===h)start=k});show(start,false)})();`;
  return `<!doctype html>
<html lang="${esc(opts.lang ?? "en")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${esc(story.title)}</title><style>${css}</style></head>
<body>${body}<script>${script}</script></body></html>`;
}
