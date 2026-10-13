import type { AnalysisResult, ChartType, StoryDefinition, StoryScene } from "./types.js";
import { divergingLayout, stackShares } from "./chartLayout.js";

/**
 * THE ANIMATED STORY, AS ONE SELF-CONTAINED HTML FILE.
 *
 * The platform has no video renderer — and a promise of an MP4 that nothing can
 * produce would be a lie — so the story is delivered in the one animated format
 * it can truly generate: a single HTML page (inline CSS, inline SVG charts, a
 * few lines of script, no network, no libraries) that plays scene by scene with
 * transitions, bars that grow, captions, play / pause / back / next, keyboard
 * control and optional narration audio. It opens from a file, an e-mail
 * attachment or an iframe, and prints as a document when scripts are off.
 *
 * Every number on screen is drawn from the `results` it is given — the
 * snapshot a share is built from, or the latest computed results — never from
 * the scene's own text alone. Everything that came from a person or a model is
 * escaped; the page contains no way to run it.
 */
export interface StoryRenderOptions {
  results: Record<string, AnalysisResult | undefined>;
  /** narration audio per scene id, as data: URLs — present only when it was really generated */
  audio?: Record<string, string>;
  /** start playing at once (a preview) or wait for the first click (a file opened cold) */
  autoplay?: boolean;
}

export const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const safeColor = (c: string | undefined, fallback: string) => (c && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : fallback);
const safeImg = (u: string | undefined) => (u && /^(https:\/\/|data:image\/(png|jpeg|gif|webp|svg\+xml);base64,)/i.test(u) ? u : "");
const safeAudio = (u: string | undefined) => (u && /^data:audio\/(mpeg|mp3|wav|x-wav|ogg|webm);base64,[A-Za-z0-9+/=]+$/.test(u) ? u : "");

const PALETTE = ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];
const num = (x: number | null | undefined, pct: boolean) => (x == null || !Number.isFinite(x) ? "–" : `${Math.round(x * 10) / 10}${pct ? "%" : ""}`);
const W = 640, H = 340;

/* ------------------------------------------------------------ charts: small, honest SVG */

type Kind = "hbar" | "vbar" | "stack" | "diverge" | "donut" | "line" | "table";
const KIND: Partial<Record<ChartType, Kind>> = {
  bar_horizontal: "hbar", ranking_bar: "hbar", lollipop: "hbar", dot_plot: "hbar", pareto: "hbar",
  bar_vertical: "vbar", bar_grouped: "vbar", column_clustered: "vbar", histogram: "vbar",
  bar_stacked: "stack", bar_stacked_100: "stack", diverging_likert: "diverge",
  pie: "donut", donut: "donut", donut_semi: "donut",
  line: "line", line_multi: "line", area: "line", spline: "line", wave_trend: "line",
};

/** the chart a result is drawn as in the story — the scene's choice when the data can draw it, otherwise a table, and a note saying so */
export function storyChart(result: AnalysisResult, type: ChartType | undefined): { svg: string; note?: string } {
  const want = type ?? "bar_vertical";
  const kind = KIND[want];
  const c = result.chart;
  const hasSeries = !!c.series?.length && !!c.categories?.length;
  if (!kind || !hasSeries) {
    const label = want.replace(/_/g, " ");
    const note = want === "table" ? undefined : !kind ? `A ${label} chart is not drawn in the animated story, so the result is shown as a table.` : `This result has no series to draw as a ${label} chart, so it is shown as a table.`;
    return { svg: tableSvg(result), ...(note ? { note } : {}) };
  }
  const pct = c.valueFormat === "pct";
  switch (kind) {
    case "hbar": return { svg: bars(result, true, pct) };
    case "vbar": return { svg: bars(result, false, pct) };
    case "stack": return { svg: stacked(result, pct, false) };
    case "diverge": return { svg: stacked(result, pct, true) };
    case "donut": return { svg: donut(result, pct) };
    case "line": return { svg: lines(result, pct) };
  }
  return { svg: tableSvg(result) };
}

const legend = (names: string[], y: number) => names.length > 1 ? names.slice(0, 8).map((n, i) => `<g transform="translate(${10 + i * 110},${y})"><rect width="10" height="10" rx="2" fill="${PALETTE[i % PALETTE.length]}"/><text x="15" y="9" class="sm">${esc(n.slice(0, 16))}</text></g>`).join("") : "";
const frame = (inner: string) => `<svg viewBox="0 0 ${W} ${H}" role="img" class="chart" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

function bars(r: AnalysisResult, horizontal: boolean, pct: boolean): string {
  const cats = r.chart.categories!.slice(0, 12), S = r.chart.series!.slice(0, 6);
  const max = Math.max(1e-9, ...S.flatMap((s) => s.values.slice(0, 12).map((v) => v ?? 0)));
  const top = S.length > 1 ? 24 : 8;
  let out = legend(S.map((s) => s.name), 4);
  if (horizontal) {
    const label = 150, rowH = (H - top - 8) / cats.length, bh = Math.min(26, (rowH - 6) / S.length);
    cats.forEach((cat, i) => {
      out += `<text x="${label - 8}" y="${top + i * rowH + rowH / 2 + 4}" text-anchor="end" class="lbl">${esc(cat.slice(0, 26))}</text>`;
      S.forEach((s, j) => { const v = s.values[i] ?? 0, w = (v / max) * (W - label - 60), y = top + i * rowH + (rowH - bh * S.length) / 2 + j * bh;
        out += `<rect class="bar h" style="animation-delay:${(i * 60 + j * 30)}ms" x="${label}" y="${y}" width="${Math.max(0, w)}" height="${bh - 2}" rx="3" fill="${PALETTE[j % PALETTE.length]}"/><text x="${label + w + 6}" y="${y + bh / 2 + 3}" class="val">${num(v, pct)}</text>`; });
    });
  } else {
    const base = H - 44, area = base - top - 14, colW = (W - 20) / cats.length, bw = Math.min(54, (colW - 8) / S.length);
    cats.forEach((cat, i) => {
      S.forEach((s, j) => { const v = s.values[i] ?? 0, h = (v / max) * area, x = 10 + i * colW + (colW - bw * S.length) / 2 + j * bw;
        out += `<rect class="bar v" style="animation-delay:${(i * 60 + j * 30)}ms" x="${x}" y="${base - h}" width="${bw - 2}" height="${h}" rx="3" fill="${PALETTE[j % PALETTE.length]}"/><text x="${x + (bw - 2) / 2}" y="${base - h - 4}" text-anchor="middle" class="val">${num(v, pct)}</text>`; });
      out += `<text x="${10 + i * colW + colW / 2}" y="${base + 16}" text-anchor="middle" class="lbl">${esc(cat.slice(0, colW < 70 ? 8 : 16))}</text>`;
    });
  }
  return frame(out);
}

/** stacked bars to 100% — or the same split around the middle of an ordered scale (a diverging bar, laid out by chartLayout.ts) */
function stacked(r: AnalysisResult, pct: boolean, diverging: boolean): string {
  const cats = r.chart.categories!.slice(0, 10), S = r.chart.series!;
  const label = 150, rowH = (H - 40) / cats.length, bh = Math.min(30, rowH - 8), span = W - label - 20;
  let out = legend(S.map((s) => s.name), 4);
  const rows = cats.map((_, i) => { const vals = S.map((s) => Math.max(0, s.values[i] ?? 0)); return { vals, shares: stackShares(vals) }; });
  const layouts = diverging && S.length >= 2 ? rows.map((x) => divergingLayout(x.shares)!) : null;
  const reach = layouts ? Math.max(1, ...layouts.map((l) => Math.max(l.left, l.right))) : 100;
  const centre = label + span / 2;
  cats.forEach((cat, i) => {
    const { vals, shares } = rows[i];
    const y = 28 + i * rowH + (rowH - bh) / 2;
    out += `<text x="${label - 8}" y="${y + bh / 2 + 4}" text-anchor="end" class="lbl">${esc(cat.slice(0, 26))}</text>`;
    let x = label;
    shares.forEach((sh, j) => {
      let x0: number, w: number;
      if (layouts) { const sg = layouts[i].segments[j]; x0 = centre + (sg.from / reach) * (span / 2); w = ((sg.to - sg.from) / reach) * (span / 2); }
      else { x0 = x; w = (sh / 100) * span; x += w; }
      out += `<rect class="bar h" style="animation-delay:${i * 60 + j * 25}ms" x="${x0}" y="${y}" width="${w}" height="${bh}" fill="${PALETTE[j % PALETTE.length]}"><title>${esc(S[j].name)}: ${num(vals[j], pct)}</title></rect>${w > 30 ? `<text x="${x0 + w / 2}" y="${y + bh / 2 + 4}" text-anchor="middle" class="inbar">${num(vals[j], false)}</text>` : ""}`;
    });
  });
  if (layouts) out += `<line x1="${centre}" x2="${centre}" y1="22" y2="${H - 8}" stroke="#94a3b8" stroke-dasharray="3 3"/>`;
  return frame(out);
}

function donut(r: AnalysisResult, pct: boolean): string {
  const cats = r.chart.categories!.slice(0, 8), vals = cats.map((_, i) => Math.max(0, r.chart.series![0].values[i] ?? 0));
  const tot = vals.reduce((a, b) => a + b, 0) || 1, cx = 170, cy = H / 2, R = 120, ri = 68;
  let a0 = -Math.PI / 2, out = "";
  vals.forEach((v, i) => { const a1 = a0 + (v / tot) * Math.PI * 2, large = a1 - a0 > Math.PI ? 1 : 0, p = (r2: number, a: number) => `${cx + r2 * Math.cos(a)},${cy + r2 * Math.sin(a)}`;
    if (v > 0) out += `<path class="arc" style="animation-delay:${i * 90}ms" d="M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, Math.min(a1, a0 + Math.PI * 2 - 1e-4))} L${p(ri, Math.min(a1, a0 + Math.PI * 2 - 1e-4))} A${ri},${ri} 0 ${large} 0 ${p(ri, a0)} Z" fill="${PALETTE[i % PALETTE.length]}"/>`;
    out += `<g transform="translate(340,${50 + i * 30})"><rect width="12" height="12" rx="2" fill="${PALETTE[i % PALETTE.length]}"/><text x="18" y="11" class="lbl">${esc(cats[i].slice(0, 28))} — ${num(v, pct)}</text></g>`; a0 = a1; });
  return frame(out);
}

function lines(r: AnalysisResult, pct: boolean): string {
  const cats = r.chart.categories!.slice(0, 40), S = r.chart.series!.slice(0, 6);
  const all = S.flatMap((s) => s.values.slice(0, 40)).filter((v): v is number => v != null);
  const lo = Math.min(0, ...all), hi = Math.max(1e-9, ...all), left = 40, base = H - 36, top = 28, step = cats.length > 1 ? (W - left - 20) / (cats.length - 1) : 0;
  const y = (v: number) => base - ((v - lo) / (hi - lo || 1)) * (base - top);
  let out = legend(S.map((s) => s.name), 4);
  S.forEach((s, j) => { const pts = s.values.slice(0, 40).map((v, i) => (v == null ? null : [left + i * step, y(v)] as const));
    const d = pts.filter(Boolean).map((p, i) => `${i ? "L" : "M"}${p![0]},${p![1]}`).join(" ");
    out += `<path class="line" d="${d}" fill="none" stroke="${PALETTE[j % PALETTE.length]}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" pathLength="1"/>`;
    pts.forEach((p) => { if (p) out += `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="${PALETTE[j % PALETTE.length]}"/>`; }); });
  cats.forEach((c, i) => { if (cats.length <= 12 || i % Math.ceil(cats.length / 12) === 0) out += `<text x="${left + i * step}" y="${H - 14}" text-anchor="middle" class="lbl">${esc(c.slice(0, 10))}</text>`; });
  out += `<text x="4" y="${y(hi) + 4}" class="sm">${num(hi, pct)}</text><text x="4" y="${y(lo) + 4}" class="sm">${num(lo, pct)}</text>`;
  return frame(out);
}

/** the first table of the result, as SVG text — what every chart type falls back to */
function tableSvg(r: AnalysisResult): string {
  const t = r.tables[0];
  if (!t) return frame(`<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="lbl">No chart or table for this result.</text>`);
  const cols = t.columns.filter((c) => !/^__/.test(c.key)).slice(0, 5), rows = t.rows.filter((row) => row.__kind !== "base").slice(0, 9);
  const cw = (W - 20) / cols.length; let out = "";
  cols.forEach((c, i) => { out += `<text x="${10 + i * cw}" y="20" class="th">${esc(String(c.label).slice(0, Math.floor(cw / 7)))}</text>`; });
  rows.forEach((row, ri) => { cols.forEach((c, i) => { const v = row[c.key]; const txt = typeof v === "number" ? num(v, c.type === "pct") : String(v ?? "").slice(0, Math.floor(cw / 7)); out += `<text x="${10 + i * cw}" y="${46 + ri * 28}" class="lbl">${esc(txt)}</text>`; }); out += `<line x1="10" x2="${W - 10}" y1="${30 + ri * 28}" y2="${30 + ri * 28}" stroke="#e2e8f0"/>`; });
  return frame(out);
}

/* ------------------------------------------------------------ the page */

export function storyHtml(story: StoryDefinition, opts: StoryRenderOptions): string {
  const accent = safeColor(story.accent, "#2563eb");
  const logo = safeImg(story.logoUrl);
  const scenes = story.scenes.filter((s) => !s.hidden);
  const body = scenes.map((s, i) => sceneHtml(s, i, opts, story.transition)).join("\n");
  const dur = JSON.stringify(scenes.map((s) => Math.max(2000, Math.min(60000, Math.round(s.durationMs || 6000)))));
  const hasAudio = scenes.some((s) => safeAudio(opts.audio?.[s.id]));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(story.title)}</title>
<style>
:root{--accent:${accent};--bg:#0f172a;--fg:#f8fafc;--muted:#94a3b8;--card:#ffffff;--ink:#0f172a}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.stage{position:relative;height:100vh;overflow:hidden}
.scene{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:6vh 7vw 14vh;opacity:0;pointer-events:none;transition:opacity .6s ease,transform .6s ease}
.scene.tr-slide{transform:translateX(6vw)}.scene.tr-zoom{transform:scale(.94)}
.scene.on{opacity:1;pointer-events:auto;transform:none}
.eyebrow{color:var(--accent);font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:.8rem}
.scene h1,.scene h2{margin:.2em 0 .4em;line-height:1.15}.scene h1{font-size:clamp(2rem,5vw,3.6rem)}.scene h2{font-size:clamp(1.4rem,3vw,2.2rem)}
.text{font-size:clamp(1.05rem,2vw,1.5rem);max-width:60ch}.base{color:var(--muted);font-size:.9rem;margin-top:.8em;max-width:70ch}
.interp .eyebrow{color:#fbbf24}.tag{display:inline-block;border:1px solid #fbbf24;color:#fbbf24;border-radius:99px;padding:1px 10px;font-size:.75rem;margin-left:8px}
.panel{background:var(--card);color:var(--ink);border-radius:14px;padding:14px;margin-top:18px;max-width:760px;width:100%}
.chart{width:100%;height:auto;display:block}.chart text{fill:#0f172a;font:12px system-ui,sans-serif}.chart .lbl{font-size:12px}.chart .sm{font-size:10px;fill:#475569}.chart .val{font-size:11px;font-weight:600}.chart .inbar{fill:#fff;font-size:11px;font-weight:600}.chart .th{font-weight:700;fill:#475569}
.note{color:#b45309;font-size:.8rem;margin-top:6px}
.on .bar.h{transform-origin:left center;animation:growx .9s cubic-bezier(.2,.7,.2,1) both}.on .bar.v{transform-origin:center bottom;transform-box:fill-box;animation:growy .9s cubic-bezier(.2,.7,.2,1) both}
.on .arc{animation:fade .8s ease both}.on .line{stroke-dasharray:1;animation:draw 1.4s ease both}
.on .text,.on h1,.on h2,.on .base{animation:rise .7s ease both}
@keyframes growx{from{transform:scaleX(0)}to{transform:scaleX(1)}}@keyframes growy{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes fade{from{opacity:0}to{opacity:1}}@keyframes draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.bar{transform-box:fill-box}
.logo{position:absolute;top:3vh;right:4vw;max-height:6vh;max-width:18vw;z-index:3}
.bar-ui{position:absolute;left:0;right:0;bottom:0;padding:10px 4vw 14px;background:linear-gradient(transparent,rgba(15,23,42,.92) 40%);z-index:2}
.progress{height:4px;background:#334155;border-radius:2px;overflow:hidden;margin-bottom:10px}.progress i{display:block;height:100%;width:0;background:var(--accent)}
.ctl{display:flex;gap:8px;align-items:center}.ctl button{background:#1e293b;color:var(--fg);border:1px solid #334155;border-radius:8px;padding:6px 14px;font:inherit;cursor:pointer}.ctl button:hover{border-color:var(--accent)}
.ctl .count{color:var(--muted);margin-left:auto;font-size:.85rem}
.cap{position:absolute;left:7vw;right:7vw;bottom:9vh;text-align:center;color:#e2e8f0;font-size:1rem;z-index:2;display:none}.caps .cap{display:block}
@media print,(prefers-reduced-motion:reduce){.scene,.on .bar,.on .arc,.on .line,.on .text,.on h1,.on h2,.on .base{transition:none!important;animation:none!important}}
html:not(.js) .stage{height:auto;overflow:visible}html:not(.js) .scene{position:static;opacity:1;pointer-events:auto;transform:none;padding:5vh 7vw;border-bottom:1px solid #1e293b;min-height:70vh}html:not(.js) .bar-ui,html:not(.js) .cap{display:none}
@media print{html,body{background:#fff;color:#000}.scene{position:static!important;opacity:1!important;page-break-after:always;color:#000}.bar-ui,.logo{display:none}}
</style></head>
<body><div class="stage" id="stage">${logo ? `<img class="logo" src="${esc(logo)}" alt="">` : ""}
${body}
<div class="bar-ui"><div class="progress"><i id="prog"></i></div><div class="ctl"><button id="prev" aria-label="Previous scene">◀</button><button id="play" aria-label="Play or pause">▶ Play</button><button id="next" aria-label="Next scene">▶▶</button><button id="cc" aria-pressed="false" aria-label="Captions">CC</button><span class="count" id="count"></span></div></div>
</div>
<script>
(function(){document.documentElement.className+=" js";
var S=[].slice.call(document.querySelectorAll(".scene")),D=${dur},i=0,playing=false,t=null,A=${hasAudio ? "true" : "false"};
var prog=document.getElementById("prog"),pb=document.getElementById("play"),cnt=document.getElementById("count"),st=document.getElementById("stage");
function audio(k){return S[k]&&S[k].querySelector("audio")}
function stopAudio(){S.forEach(function(s){var a=s.querySelector("audio");if(a){a.pause();a.currentTime=0}})}
function show(k){if(k<0||k>=S.length)return;stopAudio();clearTimeout(t);i=k;S.forEach(function(s,j){s.classList.toggle("on",j===k)});
prog.style.transition="none";prog.style.width=(k/Math.max(1,S.length-1)*100)+"%";cnt.textContent=(k+1)+" / "+S.length;
if(playing)arm()}
function arm(){var a=audio(i);if(A&&a){a.onended=function(){next()};var p=a.play();if(p&&p.catch)p.catch(function(){t=setTimeout(next,D[i])});return}t=setTimeout(next,D[i])}
function next(){if(i<S.length-1)show(i+1);else{playing=false;pb.textContent="↻ Replay";stopAudio()}}
function toggle(){if(!playing){playing=true;pb.textContent="❚❚ Pause";if(i>=S.length-1)i=0;show(i)}else{playing=false;pb.textContent="▶ Play";clearTimeout(t);stopAudio()}}
document.getElementById("play").onclick=toggle;document.getElementById("next").onclick=function(){show(i+1)};document.getElementById("prev").onclick=function(){show(i-1)};
document.getElementById("cc").onclick=function(e){var on=st.classList.toggle("caps");e.target.setAttribute("aria-pressed",on)};
document.addEventListener("keydown",function(e){if(e.key==="ArrowRight")show(i+1);else if(e.key==="ArrowLeft")show(i-1);else if(e.key===" "){e.preventDefault();toggle()}});
show(0);${opts.autoplay ? "toggle();" : ""}})();
</script></body></html>`;
}

function sceneHtml(s: StoryScene, _i: number, opts: StoryRenderOptions, transition: StoryDefinition["transition"]): string {
  const r = s.analysisId ? opts.results[s.analysisId] : undefined;
  const interp = s.nature === "interpretation";
  let chart = "";
  if (s.analysisId) {
    if (!r || r.error) chart = `<div class="panel"><p class="note">This analysis has no results to draw (${esc(r?.error?.message ?? "it was not computed")}).</p></div>`;
    else { const c = storyChart(r, s.chart?.type); chart = `<div class="panel">${c.svg}${c.note ? `<div class="note">${esc(c.note)}</div>` : ""}</div>`; }
  }
  const audio = safeAudio(opts.audio?.[s.id]);
  const label = s.type === "title" ? "" : interp ? `Interpretation<span class="tag">not a finding</span>` : s.type === "summary" ? "Summary" : s.type === "sample" ? "Sample" : s.type === "objective" ? "Objective" : s.type === "comparison" ? "Comparison" : s.type === "difference" ? "Difference" : "Finding";
  const tr = `tr-${transition === "slide" ? "slide" : transition === "zoom" ? "zoom" : "fade"}`;
  return `<section class="scene ${interp ? "interp " : ""}${tr}" data-scene="${esc(s.id)}" aria-label="${esc(s.title)}">
${label ? `<div class="eyebrow">${label}</div>` : ""}${s.type === "title" ? `<h1>${esc(s.title)}</h1>` : `<h2>${esc(s.title)}</h2>`}
<div class="text">${esc(s.text)}</div>${chart}${s.base && s.analysisId ? `<div class="base">${esc(s.base)}</div>` : ""}
<div class="cap">${esc(s.narration)}</div>${audio ? `<audio preload="auto" src="${esc(audio)}"></audio>` : ""}
</section>`;
}
