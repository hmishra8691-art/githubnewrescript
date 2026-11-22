/**
 * THE EVALUATION PLATFORM — CORE (Level 5 roadmap, S1 — 2026-11-22).
 *
 * The roadmap's one rule is that an area is Level 5 only when it passes a stated benchmark. This is where a
 * benchmark is stated, run, scored, kept and compared:
 *
 *   Suite        one benchmark of one product area: its metrics, each with the Level 5 target it is judged against
 *   Metric       one number with a direction (higher or lower is better), a unit and a target
 *   Scorecard    every suite's result at one commit
 *   compare      this run against the committed baseline: a metric that got worse by more than its tolerance is a
 *                REGRESSION and fails the run; a metric below its Level 5 target is a GAP and does not — the
 *                targets are where the roadmap is going, not where the product is
 *
 * A suite that cannot be measured (no model key, no audio set) says so with its reason. It is never scored, never
 * counted as passing, and never silently skipped.
 */
export type Area = "ai_agents" | "programming" | "analytics" | "import" | "reporting" | "qualitative" | "fraud";
export const AREA_NAMES: Record<Area, string> = {
  ai_agents: "AI design agents", programming: "Programming", analytics: "Analytics and metrics", import: "Import and migration",
  reporting: "Reporting and dashboards", qualitative: "Qualitative and video", fraud: "Fraud defence",
};

export interface Metric {
  id: string;
  label: string;
  value: number;
  unit: "%" | "ms" | "s" | "count" | "per_s";
  better: "higher" | "lower";
  /** the Level 5 threshold from the roadmap's validation table */
  target: number;
  /** how much worse than the baseline this may be before it is a regression (same unit; default: 1 point for %, 25% for times) */
  tolerance?: number;
  /** a timing depends on the machine: it is reported and compared, but a regression in it warns instead of failing */
  machineDependent?: boolean;
  /** a number worth watching that the roadmap sets no threshold for: shown and compared, never counted as meeting or missing a target */
  informational?: boolean;
  note?: string;
}
export interface CaseResult { id: string; group?: string; pass: boolean; detail?: string }
export interface SuiteResult {
  id: string;
  area: Area;
  title: string;
  /** "measured" — the numbers below are real; "blocked" — it could not run, and `reason` says what it needs */
  status: "measured" | "blocked";
  reason?: string;
  /** what the numbers do and do not show, in a sentence the scorecard prints under the suite */
  caveat?: string;
  metrics: Metric[];
  cases: CaseResult[];
  ms: number;
}
export interface Suite { id: string; area: Area; title: string; run(): Promise<Omit<SuiteResult, "id" | "area" | "title" | "ms">> | Omit<SuiteResult, "id" | "area" | "title" | "ms"> }
export interface Scorecard { version: 1; at: string; commit: string | null; suites: SuiteResult[] }

export const meets = (m: Metric): boolean => (m.better === "higher" ? m.value >= m.target : m.value <= m.target);
export const pct = (hits: number, n: number): number => (n ? Math.round((hits / n) * 1000) / 10 : 0);
const tolerance = (m: Metric): number => m.tolerance ?? (m.unit === "%" ? 1 : Math.abs(m.value) * 0.25);

export async function runSuites(suites: Suite[], opts: { now?: () => number; at?: string; commit?: string | null } = {}): Promise<Scorecard> {
  const now = opts.now ?? Date.now;
  const out: SuiteResult[] = [];
  for (const s of suites) {
    const t = now();
    try {
      const r = await s.run();
      out.push({ id: s.id, area: s.area, title: s.title, ...r, ms: now() - t });
    } catch (e) {
      /* a suite that throws has measured nothing: it is blocked, with the error as the reason, and the run fails on it */
      out.push({ id: s.id, area: s.area, title: s.title, status: "blocked", reason: `the suite failed to run: ${(e as Error).message}`, metrics: [], cases: [], ms: now() - t });
    }
  }
  return { version: 1, at: opts.at ?? new Date().toISOString(), commit: opts.commit ?? null, suites: out };
}

export interface Comparison {
  regressions: { suite: string; metric: string; was: number; now: number; unit: string }[];
  warnings: string[];
  improvements: { suite: string; metric: string; was: number; now: number; unit: string }[];
  gaps: { suite: string; metric: string; value: number; target: number; unit: string }[];
  blocked: { suite: string; reason: string }[];
  /** suites or metrics the baseline has and this run does not: a benchmark must not disappear quietly */
  missing: string[];
  ok: boolean;
}

export function compare(current: Scorecard, baseline: Scorecard | null): Comparison {
  const c: Comparison = { regressions: [], warnings: [], improvements: [], gaps: [], blocked: [], missing: [], ok: true };
  const base = new Map((baseline?.suites ?? []).map((s) => [s.id, s]));
  for (const s of current.suites) {
    if (s.status === "blocked") { c.blocked.push({ suite: s.id, reason: s.reason ?? "no reason given" }); if (base.get(s.id)?.status === "measured") c.missing.push(`${s.id} was measured in the baseline and is blocked now`); continue; }
    const was = new Map((base.get(s.id)?.metrics ?? []).map((m) => [m.id, m]));
    for (const m of s.metrics) {
      if (!m.informational && !meets(m)) c.gaps.push({ suite: s.id, metric: m.id, value: m.value, target: m.target, unit: m.unit });
      const b = was.get(m.id);
      if (!b) continue;
      const worse = m.better === "higher" ? b.value - m.value : m.value - b.value;
      const row = { suite: s.id, metric: m.id, was: b.value, now: m.value, unit: m.unit };
      if (worse > tolerance(b)) { if (m.machineDependent) c.warnings.push(`${s.id} ${m.id}: ${b.value} → ${m.value} ${m.unit} (timing, depends on the machine)`); else c.regressions.push(row); }
      else if (worse < -tolerance(b)) c.improvements.push(row);
    }
    for (const id of was.keys()) if (!s.metrics.some((m) => m.id === id)) c.missing.push(`${s.id} no longer reports ${id}`);
  }
  for (const id of base.keys()) if (!current.suites.some((s) => s.id === id)) c.missing.push(`suite ${id} is in the baseline and did not run`);
  c.ok = c.regressions.length === 0 && c.missing.length === 0;
  return c;
}

const fmt = (v: number, unit: Metric["unit"]): string => (unit === "%" ? `${v}%` : unit === "count" ? String(v) : unit === "per_s" ? `${v}/s` : `${v} ${unit}`);

/** the scorecard as a document: one table per area, the Level 5 target beside every number */
export function renderScorecard(card: Scorecard, cmp?: Comparison): string {
  const lines: string[] = [`# Level 5 scorecard`, ``, `Run at ${card.at}${card.commit ? `, commit ${card.commit}` : ""}.`, ``];
  const measured = card.suites.filter((s) => s.status === "measured");
  const all = measured.flatMap((s) => s.metrics).filter((m) => !m.informational);
  lines.push(`${measured.length} of ${card.suites.length} benchmarks measured. ${all.filter(meets).length} of ${all.length} metrics meet their Level 5 target.`, ``);
  for (const area of Object.keys(AREA_NAMES) as Area[]) {
    const suites = card.suites.filter((s) => s.area === area);
    if (!suites.length) { lines.push(`## ${AREA_NAMES[area]}`, ``, `No benchmark yet.`, ``); continue; }
    lines.push(`## ${AREA_NAMES[area]}`, ``);
    for (const s of suites) {
      lines.push(`### ${s.title}`, ``);
      if (s.status === "blocked") { lines.push(`**Not measured.** ${s.reason}`, ``); continue; }
      lines.push(`| Metric | Measured | Level 5 target | Meets it |`, `| --- | --- | --- | --- |`);
      for (const m of s.metrics) lines.push(`| ${m.label}${m.note ? ` (${m.note})` : ""} | ${fmt(m.value, m.unit)} | ${m.informational ? "none set" : `${m.better === "higher" ? "at least" : "at most"} ${fmt(m.target, m.unit)}`} | ${m.informational ? "–" : meets(m) ? "yes" : "no"} |`);
      const failed = s.cases.filter((x) => !x.pass);
      lines.push(``, `${s.cases.length} cases, ${failed.length} not passing.${failed.length ? ` First: ${failed.slice(0, 5).map((x) => `${x.id}${x.detail ? ` (${x.detail})` : ""}`).join("; ")}.` : ""}`);
      if (s.caveat) lines.push(``, `What this does not show: ${s.caveat}`);
      lines.push(``);
    }
  }
  if (cmp) {
    lines.push(`## Against the baseline`, ``);
    lines.push(cmp.regressions.length ? `**Regressions:** ${cmp.regressions.map((r) => `${r.suite} ${r.metric} ${r.was} → ${r.now} ${r.unit}`).join("; ")}.` : `No regressions.`);
    if (cmp.improvements.length) lines.push(``, `Improved: ${cmp.improvements.map((r) => `${r.suite} ${r.metric} ${r.was} → ${r.now} ${r.unit}`).join("; ")}.`);
    if (cmp.missing.length) lines.push(``, `**Missing:** ${cmp.missing.join("; ")}.`);
    if (cmp.warnings.length) lines.push(``, `Timing changes (not failing): ${cmp.warnings.join("; ")}.`);
    lines.push(``);
  }
  return lines.join("\n");
}
