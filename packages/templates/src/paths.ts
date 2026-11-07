import type { FlowNode, SurveyDefinition } from "@rescript/schema";
import type { QuotaCounts } from "@rescript/engine";
import { effectiveQuestion } from "@rescript/engine";
import { generatePopulation, type GenerationReport } from "./generate.js";
import { simulateRespondent } from "./simulate.js";

/**
 * THE RESPONDENT-PATH EXPLORER AND PATH COMPARISON (2026-11-07, audit plan #4).
 *
 *   explorePaths   N varied simulated respondents (the test-data generator: varied answers, edge cases, the real
 *                  engine) → per flow element how many reached it, per page, how interviews ended, which pages and
 *                  branch paths nobody reached, the commonest routes. Professional QA starts with "who goes where".
 *   comparePaths   two answer sets walked side by side → the pages each saw (aligned), the piped text and the
 *                  options that differ on a shared page, and where the routes part.
 *
 * Both walk through `simulateRespondent`, i.e. the Runner's own functions — so a route here is a route live.
 */

export interface ElementReach { id: string; kind: string; label: string; depth: number; reached: number; share: number }
export interface PathExploration {
  respondents: number;
  endings: Record<string, number>;
  elements: ElementReach[];
  pages: { pageId: string; label: string; reached: number; share: number }[];
  neverReached: { id: string; kind: string; label: string }[];
  routes: { pages: string[]; count: number; share: number; ending: string }[];
  blocked: { pageId: string; count: number; message: string }[];
}

function titleOf(n: FlowNode): string {
  const t = (n as { title?: string }).title;
  if (t) return t;
  switch (n.type) {
    case "page": return `page ${n.id}`;
    case "branch": return "Branch";
    case "randomizer": return "Randomizer";
    case "loop": return `Loop ${(n as { loopVar?: string }).loopVar ?? ""}`.trim();
    case "end": return `End (${(n as { status?: string }).status ?? "complete"})`;
    default: return n.type.replace(/_/g, " ");
  }
}

/** every element of the flow, in order, with the pages under it (branch paths as their own rows) */
function outline(flow: FlowNode[]): { id: string; kind: string; label: string; depth: number; pages: string[] }[] {
  const out: { id: string; kind: string; label: string; depth: number; pages: string[] }[] = [];
  const pagesUnder = (nodes: FlowNode[] | undefined): string[] => {
    const acc: string[] = [];
    const walk = (ns: FlowNode[] | undefined) => { for (const n of ns ?? []) { if (n.type === "page") acc.push(n.id); const k = n as { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] }; walk(k.children); for (const b of k.branches ?? []) walk(b.children); walk(k.otherwise); } };
    walk(nodes); return acc;
  };
  const walk = (nodes: FlowNode[], depth: number) => {
    for (const n of nodes) {
      out.push({ id: n.id, kind: n.type, label: titleOf(n), depth, pages: n.type === "page" ? [n.id] : pagesUnder([n]) });
      if (n.type === "branch") {
        for (const b of n.branches) { out.push({ id: `${n.id}/${b.id}`, kind: "path", label: `IF ${b.label ?? b.id}`, depth: depth + 1, pages: pagesUnder(b.children) }); walk(b.children, depth + 2); }
        out.push({ id: `${n.id}/otherwise`, kind: "path", label: "OTHERWISE", depth: depth + 1, pages: pagesUnder(n.otherwise) });
        walk(n.otherwise ?? [], depth + 2);
      } else if ((n as { children?: FlowNode[] }).children) walk((n as { children: FlowNode[] }).children, depth + 1);
    }
  };
  walk(flow, 0);
  return out;
}

export function explorePaths(def: SurveyDefinition, opts: { count?: number; seed?: number; quotaCounts?: QuotaCounts } = {}): PathExploration {
  const count = Math.max(10, Math.min(2000, opts.count ?? 300));
  return summarizePaths(def, generatePopulation(def, { count, seed: opts.seed ?? 20261107, quotaCounts: opts.quotaCounts ?? {}, edgeRate: 0.15 }));
}

/** the path view of any generated population (the production-like test reuses its own) */
export function summarizePaths(def: SurveyDefinition, pop: GenerationReport): PathExploration {
  const n = pop.respondents.length || 1;
  const visited = pop.respondents.map((r) => new Set(r.sim.pages.map((p) => p.pageId.split("@")[0])));
  const endings: Record<string, number> = {};
  const routes = new Map<string, { pages: string[]; count: number; ending: string }>();
  const blocked = new Map<string, { count: number; message: string }>();
  for (const r of pop.respondents) {
    endings[r.endStatus] = (endings[r.endStatus] ?? 0) + 1;
    const seq = r.sim.pages.map((p) => p.pageId.split("@")[0]).filter((p, i, a) => i === 0 || a[i - 1] !== p);
    const key = `${seq.join(">")}|${r.endStatus}`;
    const e = routes.get(key) ?? { pages: seq, count: 0, ending: r.endStatus };
    e.count++; routes.set(key, e);
    if (r.sim.blocked) { const b = blocked.get(r.sim.blocked.pageId) ?? { count: 0, message: r.sim.blocked.errors[0]?.message ?? "" }; b.count++; blocked.set(r.sim.blocked.pageId, b); }
  }
  const share = (k: number) => Math.round((k / n) * 1000) / 10;
  const elements = outline(def.flow as FlowNode[]).map((e) => {
    const reached = e.pages.length ? visited.filter((v) => e.pages.some((p) => v.has(p))).length : NaN;
    return { id: e.id, kind: e.kind, label: e.label, depth: e.depth, reached: Number.isNaN(reached) ? -1 : reached, share: Number.isNaN(reached) ? -1 : share(reached) };
  });
  const pageIds = elements.filter((e) => e.kind === "page").map((e) => e.id);
  const pages = pageIds.map((id) => { const reached = visited.filter((v) => v.has(id)).length; return { pageId: id, label: elements.find((e) => e.id === id)!.label, reached, share: share(reached) }; });
  const neverReached = elements.filter((e) => e.reached === 0 && (e.kind === "page" || e.kind === "path" || e.kind === "block")).map(({ id, kind, label }) => ({ id, kind, label }));
  return {
    respondents: pop.respondents.length, endings, elements, pages, neverReached,
    routes: [...routes.values()].sort((a, b) => b.count - a.count).slice(0, 8).map((r) => ({ ...r, share: share(r.count) })),
    blocked: [...blocked.entries()].map(([pageId, b]) => ({ pageId, ...b })),
  };
}

export interface PathComparison {
  a: { pages: string[]; ending: string };
  b: { pages: string[]; ending: string };
  /** the first page where the routes differ, or null when they never part */
  partsAt: string | null;
  onlyA: string[];
  onlyB: string[];
  /** shared pages where what was SHOWN differs */
  differences: { pageId: string; questionId: string; code: string; what: "text" | "options"; a: string; b: string }[];
}

/** walk two answer sets side by side (answers keyed by question id; missing answers get the simulator's defaults) */
export function comparePaths(def: SurveyDefinition, answersA: Record<string, unknown>, answersB: Record<string, unknown>, opts: { seed?: number; embedded?: Record<string, string> } = {}): PathComparison {
  const run = (answers: Record<string, unknown>) => simulateRespondent(def, { answers, seed: opts.seed ?? 1, embedded: opts.embedded ?? {} });
  const A = run(answersA), B = run(answersB);
  const seq = (s: typeof A) => s.pages.map((p) => p.pageId);
  const pa = seq(A), pb = seq(B);
  let partsAt: string | null = null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if (pa[i] !== pb[i]) { partsAt = pa[i] ?? pb[i] ?? null; break; }
  const differences: PathComparison["differences"] = [];
  for (const page of A.pages) {
    const other = B.pages.find((p) => p.pageId === page.pageId);
    if (!other) continue;
    for (const qid of page.questionIds) {
      const q = def.questions.find((x) => x.id === qid);
      if (!q || !other.questionIds.includes(qid)) continue;
      const ta = (page.texts[qid] ?? "").replace(/<[^>]*>/g, ""), tb = (other.texts[qid] ?? "").replace(/<[^>]*>/g, "");
      if (ta !== tb) differences.push({ pageId: page.pageId, questionId: qid, code: String(q.code), what: "text", a: ta, b: tb });
      if (q.options?.length || q.dynamicOptions) {
        const shown = (sim: typeof A) => { return effectiveQuestion(q, { def, state: sim.state, loop: page.loop ?? null }).options.map((o) => o.label.replace(/<[^>]*>/g, "")).join(" · "); };
        const oa = shown(A), ob = shown(B);
        if (oa !== ob) differences.push({ pageId: page.pageId, questionId: qid, code: String(q.code), what: "options", a: oa, b: ob });
      }
    }
  }
  return {
    a: { pages: pa, ending: A.endStatus ?? A.state.status }, b: { pages: pb, ending: B.endStatus ?? B.state.status },
    partsAt, onlyA: pa.filter((p) => !pb.includes(p)), onlyB: pb.filter((p) => !pa.includes(p)), differences,
  };
}
