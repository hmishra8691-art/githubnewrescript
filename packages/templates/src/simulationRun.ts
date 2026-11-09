import type { QuotaCounts } from "@rescript/engine";
import { evaluateCondition, mulberry32, hashString, validateQuestion } from "@rescript/engine";
import type { Condition, Question, SurveyDefinition } from "@rescript/schema";
import { generatePopulation, type GenerationIssue, type Coverage } from "./generate.js";

/**
 * A SIMULATION RUN — TEST RESPONDENTS THAT GO THROUGH THE REAL SURVEY (2026-11-09).
 *
 * The population generator (generate.ts) already walks the questionnaire through the engine exactly as the runtime
 * does: display and skip logic, branching, loops, list fills, scripts, quotas (counters evolving across the run),
 * piping, validation, randomization — and it aims later respondents at questions nobody reached. This module turns
 * one population into what a researcher tests a questionnaire with:
 *
 *   configuration   count, seed, the mix of normal / edge-case respondents, the share steered to complete, PROFILES
 *                   (named groups with their own pinned answers, e.g. "Cardiologists 30 %"), DISTRIBUTIONS (the share of
 *                   each option of a question — demographics, quota variables), sections or questions to focus on,
 *                   simulated quota fullness, and the researcher's EXPECTATIONS (“Q7 is shown only when Q3 = 1”)
 *   journeys        per respondent: the profile, every page in order with the questions shown on it, the questions
 *                   hidden by logic on pages they saw, the pages never reached, the answers, the ending, the order of
 *                   randomized items, script errors
 *   checks          coverage (questions, pages, endings, conditions that never fired), unreachable questions, blocked
 *                   walks, script errors, randomization balance (first position per item), INVALID-ANSWER PROBES (the
 *                   survey's own validation must reject an out-of-range number, a too-short text, a missing required
 *                   answer), and expected vs actual for every expectation, with the respondents that broke it
 *   rows            the response rows to store as TEST data (respondent codes SIM-<run>-0001, embedded
 *                   SIMULATED_RUN): never LIVE, never in reports, quotas or deliverables — cleared by run
 *
 * Pure and deterministic from the seed: the Studio runs it in the browser to preview and on the server to store,
 * and both get the same respondents for the same definition and configuration.
 */
export interface SimProfile { name: string; share: number; answers: Record<string, unknown> }
export interface SimExpectation { id: string; label?: string; question: string; expect: "shown" | "hidden"; when?: Condition }
export interface SimulationConfig {
  count: number;
  seed?: number;
  /** share of edge-case respondents (minimum / maximum / exclusive / “Other”) — 0 … 1 */
  edgeRate?: number;
  /** share of respondents steered to complete; the rest take the outcome their answers earn (screen-outs, quota-full) */
  completeShare?: number;
  profiles?: SimProfile[];
  /** question id → option code → weight */
  distributions?: Record<string, Record<string, number>>;
  /** question ids (or a page / block id) to aim respondents at once the population has warmed up */
  focus?: string[];
  quotaCounts?: QuotaCounts;
  expectations?: SimExpectation[];
  /** run the invalid-answer probes (default true) */
  probeInvalid?: boolean;
  embedded?: Record<string, string>;
}
export interface Journey {
  code: string;
  index: number;
  profile: string | null;
  endStatus: string;
  pages: { pageId: string; shown: string[]; hiddenByLogic: string[] }[];
  /** questions on pages never reached (by question id) */
  notReached: string[];
  answers: Record<string, unknown>;
  calculated: Record<string, unknown>;
  vars: Record<string, unknown>;
  orders: Record<string, string>;
  scriptErrors: string[];
  /** expectation id → met / broken */
  checks: Record<string, boolean>;
  minutes: number;
}
export interface ExpectationResult { id: string; label: string; question: string; expect: "shown" | "hidden"; applicable: number; met: number; broken: number; examples: string[] }
export interface ProbeResult { question: string; code: string; probe: string; rejected: boolean; message: string }
export interface SimulationRunReport {
  runId: string;
  simulated: true;
  requested: number;
  produced: number;
  journeys: Journey[];
  coverage: Coverage;
  issues: GenerationIssue[];
  endings: Record<string, number>;
  expectations: ExpectationResult[];
  probes: ProbeResult[];
  /** item → share of respondents who saw it first, per randomized list (an ORDER_* / *_ORDER variable) */
  randomization: { variable: string; items: { item: string; firstShare: number }[]; balanced: boolean }[];
  verdict: { ok: boolean; problems: string[] };
}

const answerable = (q: Question) => !["html", "calculated", "embedded_data", "hidden"].includes(q.type) && !(q.settings as { hidden?: boolean } | undefined)?.hidden;

/** the run's id: short, readable, derived from the seed and the time so two runs never collide */
export function newRunId(seed: number, now = Date.now()): string { return `${(now % 1e8).toString(36)}${(seed % 1296).toString(36)}`.toUpperCase().slice(0, 8); }

/** a weighted pick, deterministic from the rng */
function pick<T extends string>(weights: Record<T, number>, rng: () => number): T | null {
  const entries = Object.entries(weights).filter(([, w]) => Number(w) > 0) as [T, number][];
  const total = entries.reduce((a, [, w]) => a + Number(w), 0);
  if (!total) return null;
  let r = rng() * total;
  for (const [k, w] of entries) { r -= Number(w); if (r <= 0) return k; }
  return entries[entries.length - 1][0];
}

/** questions on each page of the flow, by page id (blocks, branches, randomizers, loops walked) */
function pageMap(def: SurveyDefinition): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const walk = (nodes: SurveyDefinition["flow"]) => {
    for (const n of nodes) {
      if (n.type === "page") m.set(n.id, [...((n as { questionIds?: string[] }).questionIds ?? [])]);
      const k = n as { children?: SurveyDefinition["flow"]; branches?: { children: SurveyDefinition["flow"] }[]; otherwise?: SurveyDefinition["flow"] };
      for (const c of [k.children, ...(k.branches ?? []).map((b) => b.children), k.otherwise]) if (c) walk(c);
    }
  };
  walk(def.flow);
  return m;
}

/** the focus list → question ids (a page or block id names its questions) */
function focusQuestions(def: SurveyDefinition, focus: string[]): Set<string> {
  const out = new Set<string>();
  const pages = pageMap(def);
  const byBlock = new Map<string, string[]>();
  const walk = (nodes: SurveyDefinition["flow"], block: string | null) => {
    for (const n of nodes) {
      const b = n.type === "block" ? n.id : block;
      if (n.type === "page" && b) byBlock.set(b, [...(byBlock.get(b) ?? []), ...((n as { questionIds?: string[] }).questionIds ?? [])]);
      const k = n as { children?: SurveyDefinition["flow"]; branches?: { children: SurveyDefinition["flow"] }[]; otherwise?: SurveyDefinition["flow"] };
      for (const c of [k.children, ...(k.branches ?? []).map((x) => x.children), k.otherwise]) if (c) walk(c, b);
    }
  };
  walk(def.flow, null);
  for (const f of focus) {
    const q = def.questions.find((x) => x.id === f || x.code === f || x.variableName === f);
    if (q) out.add(q.id);
    for (const id of pages.get(f) ?? byBlock.get(f) ?? []) out.add(id);
  }
  return out;
}

/* ------------------------------------------------------------ invalid-answer probes */

/** an answer the question's own rules must refuse: below the minimum, above the maximum, too short, missing */
export function invalidProbes(def: SurveyDefinition): ProbeResult[] {
  const out: ProbeResult[] = [];
  const state = { surveyId: def.meta.id, surveyVersion: "sim", sessionId: "probe", seed: 1, startedAt: new Date(0).toISOString(), status: "in_progress", answers: {}, embedded: {}, calculated: {}, flags: [], stepIndex: 0 } as never;
  for (const q of def.questions) {
    if (!answerable(q)) continue;
    const rules = q.validation ?? [];
    const s = (q.settings ?? {}) as { minValue?: number; maxValue?: number };
    const num = (k: string) => rules.filter((r) => r.kind === k).map((r) => Number(r.value)).find((x) => Number.isFinite(x));
    const lo = num("min_value") ?? s.minValue, hi = num("max_value") ?? s.maxValue;
    const minLen = num("min_length");
    const tries: { probe: string; value: unknown }[] = [];
    if (q.required) tries.push({ probe: "no answer to a required question", value: undefined });
    if (q.type === "numeric" || q.type === "number" as never) {
      if (Number.isFinite(lo)) tries.push({ probe: `${Number(lo) - 1} (below the minimum ${lo})`, value: Number(lo) - 1 });
      if (Number.isFinite(hi)) tries.push({ probe: `${Number(hi) + 1} (above the maximum ${hi})`, value: Number(hi) + 1 });
    }
    if (minLen && minLen > 1 && /text|essay|open/.test(q.type)) tries.push({ probe: `a ${minLen - 1}-character text (minimum ${minLen})`, value: "x".repeat(minLen - 1) });
    if (rules.some((r) => r.kind === "email")) tries.push({ probe: "“not-an-email”", value: "not-an-email" });
    for (const t of tries.slice(0, 3)) {
      let errs: { message: string }[] = [];
      try { errs = validateQuestion(def, q, t.value as never, { def, state, loop: null }); } catch (e) { errs = [{ message: `validation threw: ${(e as Error).message}` }]; }
      out.push({ question: q.id, code: q.code ?? q.id, probe: t.probe, rejected: errs.length > 0, message: errs[0]?.message ?? "accepted — the survey would store this value" });
    }
  }
  return out;
}

/* ------------------------------------------------------------ the run */

export function runSimulation(def: SurveyDefinition, cfg: SimulationConfig, opts: { runId?: string; now?: number } = {}): SimulationRunReport {
  const count = Math.max(1, Math.min(5000, Math.round(cfg.count || 1)));
  const seed = cfg.seed ?? 20261109;
  const runId = opts.runId ?? newRunId(seed, opts.now);
  const rngFor = (i: number) => mulberry32(hashString(`${seed}:${runId}:profile:${i}`));
  /* each respondent's profile and sampled distribution answers, fixed before the walk */
  const assigned: { profile: string | null; pinned: Record<string, unknown> }[] = [];
  const profiles = (cfg.profiles ?? []).filter((p) => p.share > 0);
  for (let i = 0; i < count; i++) {
    const rng = rngFor(i);
    const pr = profiles.length ? profiles.find((p) => p.name === pick(Object.fromEntries(profiles.map((x) => [x.name, x.share])) as Record<string, number>, rng)) ?? null : null;
    const pinned: Record<string, unknown> = { ...(pr?.answers ?? {}) };
    for (const [qid, weights] of Object.entries(cfg.distributions ?? {})) {
      if (pinned[qid] !== undefined) continue;
      const q = def.questions.find((x) => x.id === qid);
      if (!q) continue;
      const code = pick(weights, rng);
      if (code === null) continue;
      const opt = q.options.find((o) => String(o.code) === code);
      if (opt) pinned[qid] = q.type === "multi_select" ? [opt.code] : opt.code;
    }
    assigned.push({ profile: pr?.name ?? null, pinned });
  }
  const focus = cfg.focus?.length ? focusQuestions(def, cfg.focus) : null;
  const pop = generatePopulation(def, {
    count, seed, edgeRate: cfg.edgeRate ?? 0.2, completeShare: cfg.completeShare, embedded: cfg.embedded, quotaCounts: cfg.quotaCounts,
    pinnedFor: (i) => assigned[i]?.pinned,
    ...(focus?.size ? { exploreAfter: Math.min(5, Math.ceil(count / 4)) } : {}),
  });

  const pages = pageMap(def);
  const qById = new Map(def.questions.map((q) => [q.id, q]));
  const expectations = (cfg.expectations ?? []).filter((e) => qById.has(e.question));
  const expTally = new Map(expectations.map((e) => [e.id, { applicable: 0, met: 0, broken: 0, examples: [] as string[] }]));
  const firstSeen = new Map<string, Map<string, number>>();
  const firstTotals = new Map<string, number>();

  const journeys: Journey[] = pop.respondents.map((r, k) => {
    const code = `SIM-${runId}-${String(k + 1).padStart(4, "0")}`;
    const shownAll = new Set<string>();
    const seenPages = new Set<string>();
    const jp = r.sim.pages.map((p) => {
      const base = p.pageId.split("@")[0];
      seenPages.add(base);
      p.questionIds.forEach((q) => shownAll.add(q));
      const onPage = pages.get(base) ?? [];
      return { pageId: p.pageId, shown: p.questionIds, hiddenByLogic: onPage.filter((q) => !p.questionIds.includes(q) && answerable(qById.get(q) ?? ({ type: "html" } as Question))) };
    });
    const notReached = [...pages.entries()].filter(([pid]) => !seenPages.has(pid)).flatMap(([, qs]) => qs).filter((q) => answerable(qById.get(q) ?? ({ type: "html" } as Question)));
    /* the orders the respondent saw: ORDER_<node> and <VAR>_ORDER calculated variables */
    const orders: Record<string, string> = {};
    for (const [key, v] of Object.entries(r.sim.state.calculated ?? {})) if (/^ORDER_|_ORDER$/.test(key) && typeof v === "string" && v) orders[key] = v;
    for (const [key, v] of Object.entries(orders)) {
      const first = v.split(",")[0];
      if (!first) continue;
      if (!firstSeen.has(key)) firstSeen.set(key, new Map());
      firstSeen.get(key)!.set(first, (firstSeen.get(key)!.get(first) ?? 0) + 1);
      firstTotals.set(key, (firstTotals.get(key) ?? 0) + 1);
    }
    const checks: Record<string, boolean> = {};
    for (const e of expectations) {
      let applies = true;
      if (e.when) { try { applies = evaluateCondition(e.when, { def, state: r.sim.state, loop: null }); } catch { applies = false; } }
      if (!applies) continue;
      const shown = shownAll.has(e.question);
      const met = e.expect === "shown" ? shown : !shown;
      checks[e.id] = met;
      const t = expTally.get(e.id)!;
      t.applicable++;
      if (met) t.met++; else { t.broken++; if (t.examples.length < 5) t.examples.push(code); }
    }
    const answered = [...shownAll].filter((q) => answerable(qById.get(q) ?? ({ type: "html" } as Question))).length;
    return {
      code, index: k, profile: assigned[r.index]?.profile ?? null, endStatus: r.endStatus, pages: jp, notReached,
      answers: r.sim.state.answers as Record<string, unknown>, calculated: (r.sim.state.calculated ?? {}) as Record<string, unknown>, vars: r.vars, orders,
      scriptErrors: r.sim.scriptErrors.flatMap((s) => s.errors.map((e) => `${s.pageId}: ${e.message}`)),
      checks, minutes: Math.round((answered / 4) * 10) / 10,
    };
  });

  const expectationResults: ExpectationResult[] = expectations.map((e) => { const t = expTally.get(e.id)!; return { id: e.id, label: e.label || `${qById.get(e.question)?.code ?? e.question} is ${e.expect}${e.when ? " when its condition holds" : ""}`, question: e.question, expect: e.expect, ...t }; });
  const randomization = [...firstSeen.entries()].map(([variable, m]) => {
    const total = firstTotals.get(variable) ?? 1;
    const items = [...m.entries()].map(([item, c]) => ({ item, firstShare: Math.round((c / total) * 1000) / 1000 })).sort((a, b) => b.firstShare - a.firstShare);
    /* balanced: no item leads more than twice its fair share, once there are enough respondents to tell */
    const n = Math.max(items.length, 1);
    const balanced = total < 20 || items.every((x) => x.firstShare <= 2 / n + 0.05);
    return { variable, items, balanced };
  });
  const probes = cfg.probeInvalid === false ? [] : invalidProbes(def);
  const problems = [
    ...pop.issues.filter((i) => i.kind !== "unsupported_type").map((i) => `${i.kind.replace(/_/g, " ")}: ${i.message}${i.count > 1 ? ` (${i.count}×)` : ""}`),
    ...expectationResults.filter((e) => e.broken).map((e) => `expectation broken — ${e.label}: ${e.broken} of ${e.applicable} respondents (${e.examples.join(", ")})`),
    ...probes.filter((p) => !p.rejected).map((p) => `${p.code} accepted an invalid answer: ${p.probe}`),
    ...randomization.filter((r) => !r.balanced).map((r) => `${r.variable} looks unbalanced: “${r.items[0]?.item}” came first for ${Math.round((r.items[0]?.firstShare ?? 0) * 100)}%`),
  ];
  return {
    runId, simulated: true, requested: count, produced: journeys.length, journeys, coverage: pop.coverage, issues: pop.issues,
    endings: pop.coverage.endStatuses, expectations: expectationResults, probes, randomization, verdict: { ok: problems.length === 0, problems },
  };
}

/** the rows the Studio stores as TEST responses (rescript_import_responses, environment TEST) */
export function simulationRows(report: SimulationRunReport, opts: { startedAt?: number } = {}): { respondentCode: string; answers: Record<string, unknown>; embedded: Record<string, string>; status: string; startedAt: string; completedAt: string | null }[] {
  const t0 = opts.startedAt ?? Date.now();
  return report.journeys.map((j, i) => {
    const start = new Date(t0 + i * 1000);
    const end = new Date(start.getTime() + Math.max(30, j.minutes * 60) * 1000);
    return {
      respondentCode: j.code,
      answers: j.answers,
      embedded: { SIMULATED_RUN: report.runId, ...(j.profile ? { SIMULATED_PROFILE: j.profile } : {}) },
      status: ["complete", "screened", "quota_full", "terminated"].includes(j.endStatus) ? j.endStatus : "complete",
      startedAt: start.toISOString(),
      completedAt: end.toISOString(),
    };
  });
}

/** one respondent's journey in words — what the review panel shows when a journey is opened */
export function journeyLines(def: SurveyDefinition, j: Journey): string[] {
  const label = (id: string) => def.questions.find((q) => q.id === id)?.code ?? id;
  return [
    `${j.code}${j.profile ? ` · ${j.profile}` : ""} · ended ${j.endStatus}`,
    ...j.pages.map((p, i) => `${i + 1}. ${p.pageId}: shown ${p.shown.map(label).join(", ") || "—"}${p.hiddenByLogic.length ? `; hidden by logic ${p.hiddenByLogic.map(label).join(", ")}` : ""}`),
    ...(j.notReached.length ? [`not reached: ${j.notReached.map(label).join(", ")}`] : []),
    ...j.scriptErrors.map((e) => `script error — ${e}`),
  ];
}



/** the journeys as response states, for the exporters (CSV, Excel) — TEST rows, marked with the run */
export function simulationStates(report: SimulationRunReport, opts: { startedAt?: number } = {}) {
  const rows = simulationRows(report, opts);
  return report.journeys.map((j, i) => ({
    sessionId: j.code, respondentId: j.code, seed: 0, startedAt: rows[i].startedAt, completedAt: rows[i].completedAt, isTest: true,
    status: rows[i].status as "complete", answers: j.answers as never, embedded: rows[i].embedded, calculated: j.calculated as never, flags: [], stepIndex: 0,
    surveyId: "", surveyVersion: "",
  }));
}
