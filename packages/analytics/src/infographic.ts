import type { DashboardDefinition, DashboardWidget, IconKey } from "./types.js";
import type { Finding } from "./findings.js";

/**
 * AN INFOGRAPHIC FROM THE FINDINGS (Intelligent Mode IM9, 2026-11-06).
 *
 * The findings that HOLD — significant at their alpha, or strong — laid out as a one-screen infographic dashboard:
 * a headline text, a KPI tile per finding (the number from its own analysis, recomputed with the data) and a
 * pictogram panel where the finding is a share ("7 in 10"). Nothing is written about a finding that does not hold,
 * and every tile is tied to its analysis, so the picture moves with the data and the evidence is one click away.
 * `pictogramSvg` draws the same "n in 10" as a standalone SVG for an export or a slide.
 */
const ICON_WORDS: [RegExp, IconKey][] = [[/\b(?:doctors?|patients?|people|respondents?|customers?|employees?|users?|men|women|parents?|students?|nurses?)\b/i, "person"], [/\b(?:satisf|rating|score|nps|recommend)\w*/i, "star"], [/\b(?:car|vehicle|drive)\w*/i, "car"], [/\b(?:hotel|stay|room)\w*/i, "hotel"], [/\b(?:company|brand|bank|employer|store)\w*/i, "building"], [/\b(?:increase|higher|more|rise|grow)\w*/i, "trend_up"], [/\b(?:decrease|lower|less|fall|drop)\w*/i, "trend_down"]];
export const iconFor = (text: string): IconKey => ICON_WORDS.find(([re]) => re.test(text))?.[1] ?? "generic";

/** "7 in 10" from a share in percent (rounded; 0 and 10 kept honest: "fewer than 1 in 10", "nearly all") */
export function inTen(share: number): string {
  const n = Math.round(share / 10);
  return share < 5 ? "fewer than 1 in 10" : share > 95 ? "nearly all" : `${n} in 10`;
}

const holds = (f: Finding) => f.significant || f.strength === "strong";
const shareOf = (f: Finding): number | null => {
  const m = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(`${f.headline} ${f.detail ?? ""}`);
  return m ? Number(m[1]) : null;
};

export function infographicDashboard(findings: readonly Finding[], opts: { title: string; max?: number }): { dashboard: DashboardDefinition; used: number; skipped: number } {
  const kept = findings.filter(holds).filter((f) => !!f.analysis.id).slice(0, opts.max ?? 6);
  const widgets: DashboardWidget[] = [];
  widgets.push({ id: "ig-head", type: "text", title: "What the numbers say", text: kept.length ? kept.map((f) => `• ${f.headline}`).join("\n") : "No finding holds yet — run the plan when there are enough completes.", w: 12, h: 2, x: 0, y: 0 });
  let y = 2;
  kept.forEach((f, i) => {
    const share = shareOf(f);
    const x = (i % 2) * 6;
    if (i % 2 === 0 && i > 0) y += 3;
    if (share !== null) widgets.push({ id: `ig-${i}`, type: "icon_panel", title: `${inTen(share)} — ${f.headline}`.slice(0, 140), analysisId: f.analysis.id!, icon: iconFor(`${f.headline} ${f.variables.join(" ")}`), w: 6, h: 3, x, y });
    else widgets.push({ id: `ig-${i}`, type: "kpi", title: f.headline.slice(0, 140), analysisId: f.analysis.id!, w: 6, h: 3, x, y });
  });
  return { dashboard: { title: opts.title, widgets }, used: kept.length, skipped: findings.length - kept.length };
}

/** a "n in 10" pictogram as standalone SVG — ten figures, the first n filled */
export function pictogramSvg(share: number, opts: { label?: string; color?: string; muted?: string } = {}): string {
  const n = Math.max(0, Math.min(10, Math.round(share / 10)));
  const fill = opts.color ?? "#2563eb", rest = opts.muted ?? "#cbd5e1";
  const figure = (x: number, c: string) => `<g transform="translate(${x},0)" fill="${c}"><circle cx="12" cy="8" r="6"/><path d="M3 34c0-7 4-12 9-12s9 5 9 12z"/></g>`;
  const people = Array.from({ length: 10 }, (_, i) => figure(i * 26, i < n ? fill : rest)).join("");
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const label = opts.label ? `<text x="0" y="56" font-family="system-ui, sans-serif" font-size="14" fill="#0f172a">${esc(`${inTen(share)} ${opts.label}`)}</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="${opts.label ? 64 : 36}" viewBox="0 0 260 ${opts.label ? 64 : 36}" role="img" aria-label="${esc(`${inTen(share)}${opts.label ? ` ${opts.label}` : ""}`)}">${people}${label}</svg>`;
}
