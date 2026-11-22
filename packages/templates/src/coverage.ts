import type { FlowNode, SurveyDefinition } from "@rescript/schema";
import { evaluateCondition, type QuotaCounts } from "@rescript/engine";
import { runSimulation, type Journey } from "./simulationRun.js";

/**
 * PATH COVERAGE (Level 5 roadmap P2 — 2026-11-28).
 *
 * "Did the test respondents go everywhere?" made exact. The survey is turned into a list of COVERAGE GOALS — every
 * page reached, every conditional question both shown and hidden, every branch path taken, every skip rule fired,
 * every ending reached, every quota cell entered — and simulated respondents are run until each goal is met or
 * shown to be out of reach. Then the FEWEST of them that together meet every goal that was met are picked (greedy
 * set cover): the test script a person can walk by hand, each respondent with the goals it is there for.
 *
 * Quota feasibility: a cell no simulated complete ever entered, targets that add up to more or less than the
 * completes, hard limits that leave the quota unable to fill.
 *
 * Everything runs through the real engine (runSimulation → the Runner's functions). Respondents are simulated.
 * A goal that was not met is not proved impossible: it may need an answer combination the generator never drew.
 * Each one says which, and what it depends on.
 */
export type GoalKind = "page" | "shown" | "hidden" | "path" | "skip" | "ending" | "quota_cell";
export interface CoverageGoal { id: string; kind: GoalKind; label: string; refs: string[] }
export interface CoverRespondent { code: string; endStatus: string; answers: Record<string, unknown>; covers: string[] }
export interface QuotaFeasibility { quota: string; cell: string; label: string; entered: number; target?: number; limit: number; problem?: string }
export interface CoverageReport {
  goals: CoverageGoal[];
  met: string[];
  unmet: { goal: CoverageGoal; why: string }[];
  /** the smallest set found that meets every met goal */
  script: CoverRespondent[];
  simulated: number;
  rounds: number;
  share: number;
  quotas: QuotaFeasibility[];
  quotaProblems: string[];
  simulatedRespondents: true;
}

type K = { children?: FlowNode[]; branches?: { id: string; label?: string; children: FlowNode[] }[]; otherwise?: FlowNode[] };
const pagesUnder = (nodes: FlowNode[] | undefined): string[] => {
  const acc: string[] = [];
  const walk = (ns: FlowNode[] | undefined) => { for (const n of ns ?? []) { if (n.type === "page") acc.push(n.id); const k = n as K; walk(k.children); for (const b of k.branches ?? []) walk(b.children); walk(k.otherwise); } };
  walk(nodes); return acc;
};

/** every goal the survey has */
export function coverageGoals(def: SurveyDefinition): CoverageGoal[] {
  const goals: CoverageGoal[] = [];
  const qById = new Map(def.questions.map((q) => [q.id, q]));
  const code = (id: string) => qById.get(id)?.code ?? id;
  const ruled = new Set(((def as { displayRules?: { target?: { kind?: string; ref?: string } }[] }).displayRules ?? []).filter((r) => r.target?.kind === "question").map((r) => r.target!.ref!));
  const endings = new Set<string>();
  const walk = (nodes: FlowNode[]) => {
    for (const n of nodes) {
      if (n.type === "page") {
        goals.push({ id: `page:${n.id}`, kind: "page", label: `Page ${(n as { title?: string }).title ?? n.id} is reached`, refs: [n.id] });
        for (const qid of n.questionIds) {
          const q = qById.get(qid);
          if (!q) continue;
          if ((q as { displayLogic?: unknown }).displayLogic != null || ruled.has(qid)) {
            goals.push({ id: `shown:${qid}`, kind: "shown", label: `${code(qid)} is shown`, refs: [qid] });
            goals.push({ id: `hidden:${qid}`, kind: "hidden", label: `${code(qid)} is hidden by its display logic`, refs: [qid] });
          }
          for (const r of (q as { skipLogic?: { id: string; label?: string }[] }).skipLogic ?? []) goals.push({ id: `skip:${qid}/${r.id}`, kind: "skip", label: `${code(qid)}: skip ${r.label ?? r.id} fires`, refs: [qid] });
        }
      }
      if (n.type === "branch") {
        const k = n as unknown as K & { id: string };
        for (const b of k.branches ?? []) goals.push({ id: `path:${n.id}/${b.id}`, kind: "path", label: `Branch path “${b.label ?? b.id}” is taken`, refs: pagesUnder(b.children) });
        goals.push({ id: `path:${n.id}/otherwise`, kind: "path", label: "Branch OTHERWISE is taken", refs: pagesUnder(k.otherwise) });
      }
      if (n.type === "end") endings.add(String((n as { status?: string }).status ?? "complete"));
      const k = n as K;
      if (k.children) walk(k.children);
      for (const b of k.branches ?? []) walk(b.children);
      if (k.otherwise) walk(k.otherwise);
    }
  };
  walk(def.flow as FlowNode[]);
  /* a skip or quota can end the interview without an end node of that status */
  if ((def.questions as { skipLogic?: { target?: { kind?: string } }[] }[]).some((q) => (q.skipLogic ?? []).some((r) => /screen|terminat/.test(JSON.stringify(r.target ?? ""))))) endings.add("screened");
  for (const e of endings) goals.push({ id: `ending:${e}`, kind: "ending", label: `An interview ends “${e}”`, refs: [] });
  for (const q of def.quotas ?? []) for (const c of q.cells) goals.push({ id: `quota:${q.id}/${c.id}`, kind: "quota_cell", label: `Quota ${q.name}: a complete enters “${c.label}”`, refs: [q.id, c.id] });
  return goals;
}

/** page id → its position in the flow; question id → its page's position */
const ORDER = new WeakMap<object, { pageOrder: Map<string, number>; pageIndex: Map<string, number> }>();
function order(def: SurveyDefinition) {
  const hit = ORDER.get(def);
  if (hit) return hit;
  const pageOrder = new Map<string, number>(), pageIndex = new Map<string, number>();
  let k = 0;
  const walk = (ns: FlowNode[] | undefined) => { for (const n of ns ?? []) { if (n.type === "page") { pageOrder.set(n.id, k); for (const q of n.questionIds) if (!pageIndex.has(q)) pageIndex.set(q, k); k++; } const x = n as K; walk(x.children); for (const b of x.branches ?? []) walk(b.children); walk(x.otherwise); } };
  walk(def.flow as FlowNode[]);
  const v = { pageOrder, pageIndex };
  ORDER.set(def, v);
  return v;
}

function hits(def: SurveyDefinition, goals: CoverageGoal[], j: Journey): Set<string> {
  const out = new Set<string>();
  const { pageOrder, pageIndex } = order(def);
  const pages = new Set(j.pages.map((p) => p.pageId));
  const shown = new Set(j.pages.flatMap((p) => p.shown));
  const hidden = new Set(j.pages.flatMap((p) => p.hiddenByLogic));
  const state = { answers: j.answers, calculated: j.calculated, embedded: {}, vars: j.vars } as never;
  const holds = (c: unknown) => { try { return evaluateCondition(c as never, { def, state, loop: null }); } catch { return false; } };
  for (const g of goals) {
    switch (g.kind) {
      case "page": if (pages.has(g.refs[0]!)) out.add(g.id); break;
      case "shown": if (shown.has(g.refs[0]!)) out.add(g.id); break;
      case "hidden": {
        const qid = g.refs[0]!;
        if (hidden.has(qid)) { out.add(g.id); break; }
        /* a page whose every question is hidden is not shown at all: the respondent went PAST it with the condition false */
        const at = pageIndex.get(qid);
        const dl = (def.questions.find((q) => q.id === qid) as { displayLogic?: unknown } | undefined)?.displayLogic;
        if (!shown.has(qid) && at !== undefined && dl != null && j.pages.some((p) => (pageOrder.get(p.pageId) ?? -1) > at) && holds(dl) === false) out.add(g.id);
        break;
      }
      case "path": if (g.refs.some((p) => pages.has(p))) out.add(g.id); break;
      case "ending": if (j.endStatus === g.id.slice(7)) out.add(g.id); break;
      case "skip": {
        const [qid, rid] = g.id.slice(5).split("/");
        const rule = ((def.questions.find((q) => q.id === qid) as { skipLogic?: { id: string; when: unknown }[] } | undefined)?.skipLogic ?? []).find((r) => r.id === rid);
        if (rule && shown.has(qid!) && j.answers[qid!] !== undefined && holds(rule.when)) out.add(g.id);
        break;
      }
      case "quota_cell": {
        if (j.endStatus !== "complete") break;
        const cell = (def.quotas ?? []).find((q) => q.id === g.refs[0])?.cells.find((c) => c.id === g.refs[1]);
        if (cell && holds(cell.when)) out.add(g.id);
        break;
      }
    }
  }
  return out;
}

export interface CoverageOptions { seed?: number; perRound?: number; maxRounds?: number; quotaCounts?: QuotaCounts }

export function coverSurvey(def: SurveyDefinition, opts: CoverageOptions = {}): CoverageReport {
  const goals = coverageGoals(def);
  const perRound = opts.perRound ?? 60, maxRounds = opts.maxRounds ?? 4;
  const journeys: { j: Journey; hit: Set<string> }[] = [];
  const met = new Set<string>();
  let rounds = 0;
  for (let r = 0; r < maxRounds; r++) {
    rounds++;
    const unmetNow = goals.filter((g) => !met.has(g.id));
    if (!unmetNow.length) break;
    /* after the first round, aim at what is still missing: the questions of unmet goals, the pages of unmet paths */
    const focus = r === 0 ? undefined : [...new Set(unmetNow.flatMap((g) => (g.kind === "shown" || g.kind === "hidden" || g.kind === "skip" ? [g.refs[0]!] : g.kind === "page" || g.kind === "path" ? g.refs : [])))].slice(0, 40);
    const run = runSimulation(def, { count: perRound, seed: (opts.seed ?? 31) + r * 997, edgeRate: r === 0 ? 0.2 : 0.35, completeShare: r % 2 === 0 ? 0.7 : 0.3, probeInvalid: false, ...(focus?.length ? { focus } : {}), ...(opts.quotaCounts ? { quotaCounts: opts.quotaCounts } : {}) });
    const before = met.size;
    for (const j of run.journeys) { const h = hits(def, goals, j); journeys.push({ j, hit: h }); for (const g of h) met.add(g); }
    if (r > 0 && met.size === before) break; /* aiming did not help: stop rather than spin */
  }
  /* greedy set cover over the respondents simulated */
  const left = new Set(met);
  const script: CoverRespondent[] = [];
  while (left.size) {
    let best: { j: Journey; hit: Set<string> } | null = null, gain = 0;
    for (const x of journeys) { let g = 0; for (const id of x.hit) if (left.has(id)) g++; if (g > gain) { gain = g; best = x; } }
    if (!best) break;
    const covers = [...best.hit].filter((id) => left.has(id));
    for (const id of covers) left.delete(id);
    script.push({ code: best.j.code, endStatus: best.j.endStatus, answers: best.j.answers, covers });
  }
  const qById = new Map(def.questions.map((q) => [q.id, q]));
  const unmet = goals.filter((g) => !met.has(g.id)).map((goal) => ({ goal, why: whyUnmet(def, goal, qById) + routeNote(def, goal, journeys.map((x) => x.j)) }));
  /* quota feasibility */
  const quotas: QuotaFeasibility[] = [];
  const quotaProblems: string[] = [];
  const completes = journeys.filter((x) => x.j.endStatus === "complete");
  for (const q of def.quotas ?? []) {
    let targets = 0, limits = 0, anyTarget = false;
    for (const c of q.cells) {
      const entered = completes.filter((x) => x.hit.has(`quota:${q.id}/${c.id}`)).length;
      const row: QuotaFeasibility = { quota: q.name, cell: c.id, label: c.label, entered, limit: c.limit, ...(c.target != null ? { target: c.target } : {}) };
      if (!entered) row.problem = `No simulated complete entered “${c.label}” in ${completes.length} completes. Check that its condition can be met by someone who completes.`;
      if (c.target != null) { targets += c.target; anyTarget = true; if (c.limitType === "count" && c.target > c.limit) row.problem = `Its target (${c.target}) is above its maximum (${c.limit}): it can never reach the target.`; }
      if (c.limitType === "count") limits += c.limit;
      quotas.push(row);
    }
    if (q.targetTotal && anyTarget && targets !== q.targetTotal) quotaProblems.push(`${q.name}: the cell targets add up to ${targets}, not the quota's total of ${q.targetTotal}.`);
    if (q.targetTotal && q.mode === "hard" && q.cells.every((c) => c.limitType === "count") && limits < q.targetTotal) quotaProblems.push(`${q.name}: the hard maximums add up to ${limits}, fewer than the ${q.targetTotal} completes wanted. Fieldwork cannot finish.`);
  }
  return { goals, met: [...met], unmet, script, simulated: journeys.length, rounds, share: goals.length ? Math.round((met.size / goals.length) * 1000) / 10 : 100, quotas, quotaProblems, simulatedRespondents: true };
}

/**
 * For a conditional question that was never shown, or never hidden: the respondents whose answers WOULD have made it
 * so — where did they go? "Everyone who would hide it was screened out first" means the display logic is never used.
 */
function routeNote(def: SurveyDefinition, g: CoverageGoal, js: Journey[]): string {
  if (g.kind !== "shown" && g.kind !== "hidden") return "";
  const q = def.questions.find((x) => x.id === g.refs[0]) as { displayLogic?: unknown; code?: string } | undefined;
  if (!q?.displayLogic) return "";
  const wantTrue = g.kind === "shown";
  const holds = (j: Journey) => { try { return evaluateCondition(q.displayLogic as never, { def, state: { answers: j.answers, calculated: j.calculated, embedded: {}, vars: j.vars } as never, loop: null }); } catch { return null; } };
  const would = js.filter((j) => holds(j) === wantTrue);
  if (!would.length) return ` No simulated respondent answered so that it would be ${g.kind}.`;
  const ends = new Map<string, number>();
  for (const j of would) { const k = `${j.endStatus} after page ${j.pages[j.pages.length - 1]?.pageId ?? "?"}`; ends.set(k, (ends.get(k) ?? 0) + 1); }
  return ` ${would.length} answered so that it would be ${g.kind}, and none reached it: ${[...ends.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ended ${k}`).join(", ")}.${g.kind === "hidden" ? " The display logic is never used: those respondents leave first." : ""}`;
}

function whyUnmet(def: SurveyDefinition, g: CoverageGoal, qById: Map<string, SurveyDefinition["questions"][number]>): string {
  const code = (id: string) => qById.get(id)?.code ?? id;
  switch (g.kind) {
    case "shown": return `No simulated respondent was shown ${code(g.refs[0]!)}. Its display logic was never true for someone who reached its page — or nobody reached the page.`;
    case "hidden": return `${code(g.refs[0]!)} was shown to everyone who reached it: its display logic was always true. Either the condition is always met, or the answers that would hide it were never drawn.`;
    case "page": return `Nobody reached ${g.refs[0]}. A skip, a screen-out or a branch before it routes everyone past it.`;
    case "path": return g.refs.length ? `No respondent went down this path (pages ${g.refs.join(", ")}).` : "This path has no pages, so whether it was taken cannot be observed.";
    case "skip": return `The skip on ${code(g.refs[0]!)} never fired for someone who answered it.`;
    case "ending": return `No interview ended “${g.id.slice(7)}”.`;
    case "quota_cell": return "No simulated complete met this cell's condition.";
  }
}
