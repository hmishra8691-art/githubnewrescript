import { pv, trackWaves, type ChangeVerdict, type TrackerReport } from "@rescript/analytics";
import { orderedWithMappings, type TrackerSession } from "../tracker/session.ts";

/**
 * "IS THE DROP IN AWARENESS SINCE WAVE 2 REAL?" (2026-11-09) — Intelligent Mode's reading of a tracking question, and the
 * answer, computed by the same deterministic tracker the Results → Wave tracker panel uses (mapping, significance,
 * composition adjustment). Nothing is invented: with fewer than two waves or no KPI the answer says what is missing.
 */
const ASKS = /\b(?:waves?|tracker|tracking|longitudinal|wave[- ]on[- ]wave)\b/i;
const ABOUT = /\b(?:compare|comparison|change[sd]?|trend|track|significan\w*|genuine|real|moved?|drop(?:ped)?|rise|rose|increase[ds]?|decrease[ds]?|vs\.?|versus|since|between|across|over time|composition|sample|kpis?|results?|summar\w*|show|what happened)\b/i;
const QUESTION_EDIT = /\b(?:add|create|insert|delete|remove|rename)\b.{0,30}\b(?:question|option|page|block)\b/i;

export function trackerQuestion(text: string): boolean {
  return ASKS.test(text) && ABOUT.test(text) && !QUESTION_EDIT.test(text);
}

const VERDICT: Record<ChangeVerdict, string> = {
  genuine_change: "a genuine change",
  composition: "explained by sample composition",
  not_comparable: "not comparable — the question changed",
  no_change: "no significant change",
  insufficient: "not enough data",
};
const fmt = (v: number | null, nps: boolean) => (v === null ? "—" : nps ? String(v) : `${v}${nps ? "" : ""}`);

export function trackerAnswer(text: string, s: TrackerSession): { answer: string; sections: { title: string; items: { label: string; detail?: string }[] }[]; report: TrackerReport | null } {
  if (s.waves.length < 2) return { answer: `The tracker has ${s.waves.length === 1 ? "one wave" : "no waves"} yet. Add at least two in Results → Wave tracker — upload each wave's data file (CSV or Excel) or add this survey's live data as a wave — and I can compare them.`, sections: [], report: null };
  if (!s.state.kpis.length) return { answer: `${s.waves.length} waves are loaded but no KPI is chosen. Open Results → Wave tracker and pick the KPIs (Suggest KPIs reads them from the baseline), and ask again.`, sections: [], report: null };
  const { waves, mappings } = orderedWithMappings(s);
  const t = text.toLowerCase();
  const named = s.state.kpis.filter((k) => t.includes(k.label.toLowerCase()) || t.includes(k.variable.toLowerCase()) || k.label.toLowerCase().split(/\W+/).some((w) => w.length > 4 && t.includes(w)));
  const report = trackWaves(waves, mappings, { kpis: named.length ? named : s.state.kpis, composition: s.state.composition, segment: s.state.segment, alpha: s.state.alpha });
  const vsBase = /\bbaseline|first wave|since wave 1|vs\.? wave 1\b/.test(t);
  const latest = report.waves[report.waves.length - 1].label, prev = report.waves[report.waves.length - 2].label;
  const lines = report.kpis.map((k) => {
    const c = vsBase ? k.vsBaseline[k.vsBaseline.length - 1] : k.waveOnWave[k.waveOnWave.length - 1];
    const nps = k.kpi.measure === "nps" || k.kpi.measure === "mean";
    return { label: `${k.kpi.label}: ${fmt(k.points[k.points.length - 1].value, nps)}${nps ? "" : "%"} in ${latest}, ${c.diff === null ? "—" : `${c.diff > 0 ? "+" : ""}${c.diff}${nps ? "" : " pts"}`} vs ${c.from}${c.adjustedDiff !== null && c.adjustedDiff !== c.diff ? ` (${c.adjustedDiff > 0 ? "+" : ""}${c.adjustedDiff}${nps ? "" : " pts"} with the samples matched)` : ""} — ${VERDICT[c.verdict]}`, detail: `${c.why}${k.trend ? `; trend across all waves: ${k.trend.p !== null && k.trend.p < s.state.alpha ? `${k.trend.direction} (${pv(k.trend.p)})` : "no significant trend"}` : ""}` };
  });
  const genuine = report.kpis.filter((k) => { const c = vsBase ? k.vsBaseline.at(-1)! : k.waveOnWave.at(-1)!; return c.verdict === "genuine_change"; }).length;
  const comp = report.kpis.filter((k) => (vsBase ? k.vsBaseline.at(-1)! : k.waveOnWave.at(-1)!).verdict === "composition").length;
  const shifted = report.composition.filter((c) => c.shifted);
  const changes = report.kpis.flatMap((k) => k.changes.map((c) => ({ label: k.kpi.label, detail: c })));
  return {
    answer: `${report.waves.length} waves (${report.waves.map((w) => `${w.label} n=${w.n}`).join(", ")}). ${latest} against ${vsBase ? report.waves[0].label : prev}: ${genuine} of ${report.kpis.length} KPI${report.kpis.length === 1 ? "" : "s"} changed significantly${comp ? `, ${comp} moved only because the sample differs` : ""}${s.state.composition.length ? "" : " (no composition checks chosen — add age, gender or region in the Wave tracker to separate sample effects from real change)"}. Charts, the mapping and the CSV export are in Results → Wave tracker.`,
    sections: [
      { title: "KPIs", items: lines },
      ...(shifted.length ? [{ title: "Sample composition shifted", items: shifted.map((c) => ({ label: `${c.variable} in ${c.wave}`, detail: c.largest ? `code ${c.largest.code}: ${c.largest.base}% → ${c.largest.wave}% (${pv(c.p)})` : undefined })) }] : []),
      ...(changes.length ? [{ title: "Question changes between waves", items: changes.slice(0, 10) }] : []),
      { title: "Recommended", items: report.recommendations.map((r) => ({ label: r })) },
    ],
    report,
  };
}
