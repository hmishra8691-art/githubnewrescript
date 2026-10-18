import type { EvalBudgets, EvalCategory } from "./cases.ts";
import type { CallMetric, Check, TurnFacts } from "./score.ts";

/**
 * THE EVALUATION REPORT (AI evaluation harness): per-case results rolled up
 * into pass rates per category, tokens (cache read / write included), cost,
 * latency p50 / p95, the repair and clarify rates — as JSON and as Markdown —
 * and the comparison with a stored baseline that decides the exit code.
 */

export interface TurnResult {
  index: number;
  message: string;
  status: number;
  latencyMs: number;
  checks: Check[];
  failed: string[];
  /** what the route answered, short — the model's reply when a check failed */
  reply: string;
  facts: Pick<TurnFacts, "kind" | "ops" | "applied" | "refused" | "mode" | "scope" | "stage" | "planItems" | "repairRan" | "repaired" | "oneShotParse" | "clarify" | "modelCalled">;
  calls: CallMetric[];
  streamed?: boolean;
  error?: string;
}

export interface CaseResult {
  id: string;
  category: EvalCategory;
  title: string;
  source: string;
  passed: boolean;
  turns: TurnResult[];
  budget: Required<EvalBudgets>;
  budgetChecks: Check[];
  costUsd: number;
  chargeUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  error?: string;
}

export interface EvalMeta {
  startedAt: string;
  finishedAt: string;
  /** fake | live | replay */
  mode: "fake" | "live" | "replay";
  provider: string;
  model: string;
  /** the baseline key: "<mode>:<model>" ("fake:fake" here) */
  key: string;
  cases: number;
  filter?: string;
  stream?: boolean;
  notes?: string[];
}

export interface CategorySummary { cases: number; passed: number; passRate: number }
export interface EvalSummary {
  cases: number;
  passed: number;
  passRate: number;
  byCategory: Record<string, CategorySummary>;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  chargeUsd: number;
  latencyMs: { p50: number; p95: number; max: number };
  /** of the turns that called a model */
  modelTurns: number;
  repairRate: number;
  clarifyRate: number;
  cleanParseRate: number;
  cacheHitRate: number;
  /** turns the route answered as a stream (--stream) */
  streamedTurns: number;
}

export interface EvalReport { meta: EvalMeta; summary: EvalSummary; cases: CaseResult[] }

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function summarize(cases: CaseResult[]): EvalSummary {
  const byCategory: Record<string, CategorySummary> = {};
  for (const c of cases) {
    const s = byCategory[c.category] ?? { cases: 0, passed: 0, passRate: 0 };
    s.cases++; if (c.passed) s.passed++;
    s.passRate = r3(s.passed / s.cases);
    byCategory[c.category] = s;
  }
  const turns = cases.flatMap((c) => c.turns);
  const modelTurns = turns.filter((t) => t.facts.modelCalled);
  const calls = turns.flatMap((t) => t.calls);
  const input = calls.reduce((n, x) => n + x.inputTokens, 0);
  const read = calls.reduce((n, x) => n + x.cacheReadTokens, 0);
  const lat = modelTurns.map((t) => t.latencyMs);
  const passed = cases.filter((c) => c.passed).length;
  return {
    cases: cases.length, passed, passRate: cases.length ? r3(passed / cases.length) : 0, byCategory,
    tokens: { input, output: calls.reduce((n, x) => n + x.outputTokens, 0), cacheRead: read, cacheWrite: calls.reduce((n, x) => n + x.cacheWriteTokens, 0) },
    costUsd: r6(cases.reduce((n, c) => n + c.costUsd, 0)), chargeUsd: r6(cases.reduce((n, c) => n + c.chargeUsd, 0)),
    latencyMs: { p50: percentile(lat, 50), p95: percentile(lat, 95), max: lat.length ? Math.max(...lat) : 0 },
    modelTurns: modelTurns.length,
    repairRate: modelTurns.length ? r3(modelTurns.filter((t) => t.facts.repairRan).length / modelTurns.length) : 0,
    clarifyRate: modelTurns.length ? r3(modelTurns.filter((t) => t.facts.clarify).length / modelTurns.length) : 0,
    cleanParseRate: modelTurns.length ? r3(modelTurns.filter((t) => t.facts.oneShotParse && !t.facts.repairRan).length / modelTurns.length) : 0,
    cacheHitRate: input ? r3(read / input) : 0,
    streamedTurns: turns.filter((t) => t.streamed).length,
  };
}

/* ------------------------------------------------------------ the baseline */

/** what is kept of a run to compare the next one with */
export interface BaselineEntry { key: string; recordedAt: string; summary: Pick<EvalSummary, "passRate" | "byCategory" | "costUsd" | "latencyMs" | "repairRate" | "clarifyRate">; passed: Record<string, boolean> }
export type Baseline = Record<string, BaselineEntry>;

export interface BaselinePolicy {
  /** overall pass rate may fall by at most this much (absolute) */
  passRateDrop: number;
  /** a case that passed in the baseline and fails now is a regression */
  casesMustKeepPassing: boolean;
  /** cost may grow by at most this fraction (only when both runs cost something) */
  costGrowth: number;
  /** p95 latency may grow by at most this fraction (only for real-provider runs) */
  latencyGrowth: number;
}
export const DEFAULT_POLICY: BaselinePolicy = { passRateDrop: 0.02, casesMustKeepPassing: true, costGrowth: 0.25, latencyGrowth: 0.5 };

export function baselineEntry(report: EvalReport): BaselineEntry {
  const s = report.summary;
  return { key: report.meta.key, recordedAt: report.meta.finishedAt, summary: { passRate: s.passRate, byCategory: s.byCategory, costUsd: s.costUsd, latencyMs: s.latencyMs, repairRate: s.repairRate, clarifyRate: s.clarifyRate }, passed: Object.fromEntries(report.cases.map((c) => [c.id, c.passed])) };
}

export interface Comparison { baseline: BaselineEntry | null; regressions: string[]; improvements: string[]; notes: string[] }

export function compareToBaseline(report: EvalReport, baseline: Baseline | null | undefined, policy: BaselinePolicy = DEFAULT_POLICY): Comparison {
  const b = baseline?.[report.meta.key] ?? null;
  const out: Comparison = { baseline: b, regressions: [], improvements: [], notes: [] };
  if (!b) { out.notes.push(`no baseline for ${report.meta.key} — this run can become it (--update-baseline)`); return out; }
  const s = report.summary;
  if (s.passRate < b.summary.passRate - policy.passRateDrop) out.regressions.push(`pass rate ${(s.passRate * 100).toFixed(1)} % < baseline ${(b.summary.passRate * 100).toFixed(1)} % (tolerance ${(policy.passRateDrop * 100).toFixed(0)} points)`);
  else if (s.passRate > b.summary.passRate) out.improvements.push(`pass rate ${(b.summary.passRate * 100).toFixed(1)} % → ${(s.passRate * 100).toFixed(1)} %`);
  for (const c of report.cases) {
    const was = b.passed[c.id];
    if (was === undefined) { out.notes.push(`new case ${c.id}: ${c.passed ? "passes" : "fails"}`); continue; }
    if (policy.casesMustKeepPassing && was && !c.passed) out.regressions.push(`${c.id} passed in the baseline and fails now`);
    if (!was && c.passed) out.improvements.push(`${c.id} now passes`);
  }
  for (const id of Object.keys(b.passed)) if (!report.cases.some((c) => c.id === id)) out.notes.push(`baseline case ${id} was not run`);
  if (b.summary.costUsd > 0 && s.costUsd > b.summary.costUsd * (1 + policy.costGrowth)) out.regressions.push(`cost $${s.costUsd.toFixed(4)} > baseline $${b.summary.costUsd.toFixed(4)} + ${(policy.costGrowth * 100).toFixed(0)} %`);
  if (report.meta.mode !== "fake" && b.summary.latencyMs.p95 > 0 && s.latencyMs.p95 > b.summary.latencyMs.p95 * (1 + policy.latencyGrowth)) out.regressions.push(`p95 latency ${s.latencyMs.p95} ms > baseline ${b.summary.latencyMs.p95} ms + ${(policy.latencyGrowth * 100).toFixed(0)} %`);
  return out;
}

/* ------------------------------------------------------------ Markdown */

const pct = (n: number) => `${(n * 100).toFixed(1)} %`;
const k = (n: number) => n.toLocaleString("en");
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export function reportMarkdown(report: EvalReport, cmp?: Comparison): string {
  const { meta, summary: s } = report;
  const L: string[] = [];
  L.push(`# Intelligent Mode evaluation — ${meta.mode} (${meta.model})`, "");
  if (meta.mode === "fake") L.push("> **Fake provider.** Every model reply was scripted per case: this proves the harness and the deterministic pipeline (scope, routing, the engine's gate, plan → build, repair), **not** the model. Real-model numbers come from the first real run (`EVAL_AI_API_URL` …, or `--replay` of recorded cassettes).", "");
  for (const n of meta.notes ?? []) L.push(`> ${n}`);
  if (meta.notes?.length) L.push("");
  L.push(`Run ${meta.startedAt} → ${meta.finishedAt} · provider ${meta.provider} · ${meta.cases} cases${meta.filter ? ` (filter ${meta.filter})` : ""}${meta.stream ? ` · streamed (${s.streamedTurns} turns as NDJSON)` : ""}`, "");
  L.push(`**Pass rate ${pct(s.passRate)}** (${s.passed}/${s.cases}) · cost $${s.costUsd.toFixed(4)} (charge $${s.chargeUsd.toFixed(4)}) · latency p50 ${k(s.latencyMs.p50)} ms, p95 ${k(s.latencyMs.p95)} ms · repair ${pct(s.repairRate)} · clarify ${pct(s.clarifyRate)} · clean parse ${pct(s.cleanParseRate)} of ${s.modelTurns} model turns`);
  L.push(`Tokens: input ${k(s.tokens.input)} (cache read ${k(s.tokens.cacheRead)}, cache write ${k(s.tokens.cacheWrite)}; hit ${pct(s.cacheHitRate)}) · output ${k(s.tokens.output)}`, "");
  L.push("| category | cases | passed | pass rate |", "|---|---:|---:|---:|");
  for (const [cat, c] of Object.entries(s.byCategory).sort()) L.push(`| ${cat} | ${c.cases} | ${c.passed} | ${pct(c.passRate)} |`);
  if (cmp) {
    L.push("", "## Against the baseline", "");
    if (!cmp.baseline) L.push(...cmp.notes.map((n) => `- ${n}`));
    else {
      L.push(`Baseline ${cmp.baseline.key} recorded ${cmp.baseline.recordedAt} (pass rate ${pct(cmp.baseline.summary.passRate)}).`, "");
      L.push(cmp.regressions.length ? `**${cmp.regressions.length} regression(s):**` : "No regression.");
      for (const r of cmp.regressions) L.push(`- ${r}`);
      for (const i of cmp.improvements) L.push(`- improved: ${i}`);
      for (const n of cmp.notes) L.push(`- ${n}`);
    }
  }
  L.push("", "## Cases", "", "| case | category | result | turns | tokens in / out | cache read / write | cost | latency |", "|---|---|---|---:|---:|---:|---:|---:|");
  for (const c of report.cases) L.push(`| ${c.id} | ${c.category} | ${c.passed ? "pass" : "**FAIL**"} | ${c.turns.length} | ${k(c.inputTokens)} / ${k(c.outputTokens)} | ${k(c.cacheReadTokens)} / ${k(c.cacheWriteTokens)} | $${c.costUsd.toFixed(4)} | ${k(c.latencyMs)} ms |`);
  const failed = report.cases.filter((c) => !c.passed);
  if (failed.length) {
    L.push("", "## Failures", "");
    for (const c of failed) {
      L.push(`### ${c.id} — ${esc(c.title)}`, "");
      if (c.error) L.push(`Error: ${esc(c.error)}`, "");
      for (const t of c.turns) for (const ch of t.checks.filter((x) => !x.ok)) L.push(`- turn ${t.index + 1} **${ch.name}**: ${esc(ch.detail ?? "")}`);
      for (const b of c.budgetChecks.filter((x) => !x.ok)) L.push(`- budget **${b.name}**: ${esc(b.detail ?? "")}`);
      const last = c.turns[c.turns.length - 1];
      if (last) L.push("", `Model reply (turn ${last.index + 1}, ops ${last.facts.ops.join(", ") || "none"}): “${esc(last.reply).slice(0, 600)}”`, "");
    }
  }
  return L.join("\n");
}
