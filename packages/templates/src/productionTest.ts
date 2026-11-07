import type { QuotaCounts } from "@rescript/engine";
import { effectiveLimit, fieldworkWindow, quotaIncrements, QUESTIONS_PER_MINUTE } from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";
import { generatePopulation } from "./generate.js";
import { summarizePaths, type PathExploration } from "./paths.js";

/**
 * A PRODUCTION-LIKE TEST (Intelligent Mode IM3, 2026-11-06).
 *
 * The test link runs the draft with TEST quota counters that start at zero — so a quota that is nearly full in
 * the field never fills in a test, and the path most likely to be misprogrammed is the one a tester never sees.
 * This runs the definition a launch would publish the way the LIVE link would meet it:
 *
 *   · the quota counters start from the LIVE counts (or from a simulated fullness: "Cardiology at 95 %",
 *     "the 18–24 cell full") and evolve as simulated respondents complete — `generatePopulation` walks the real
 *     engine (display, skips, quotas, list fills, scripts, validation), nothing here re-implements a rule;
 *   · the live gates are checked as they would be at launch: the fieldwork window, the password, the access mode;
 *   · it is a SIMULATION: nothing is written. No response row, no quota counter — live or test — moves. The
 *     report is marked `simulated` on every line a person reads.
 *
 * What it is not: an incidence forecast. The generator steers respondents past screeners (most of a random
 * population would screen out and test nothing), so the screen-out share here is a lower bound and is said to be.
 */
export interface QuotaFill { quota: string; cell?: string; share: number }
export interface ProductionTestOptions {
  count?: number;
  seed?: number;
  /** the live counters (quota id → cell id → completes) */
  liveCounts?: QuotaCounts;
  /** simulated fullness on top of the live counts: a share of each named cell's limit (1 = full) */
  fill?: QuotaFill[];
  now?: number;
  /** how many unique links / invitations exist, when the survey needs them (the route counts them) */
  links?: number | null;
  /** the publish gate's blockers (the route runs the gate the Publish button runs) */
  publishBlockers?: string[];
}
export interface ProductionQuotaCell {
  quota: string; quotaId: string; cell: string; cellId: string; mode: "hard" | "soft";
  limit: number; target: number | null; start: number; end: number; full: boolean; filledAt: number | null; reached: number;
}
export interface ProductionTestReport {
  simulated: true;
  respondents: number;
  outcomes: Record<string, number>;
  completeShare: number;
  loiMinutes: { median: number; p90: number };
  quotas: ProductionQuotaCell[];
  gates: { id: string; ok: boolean; message: string }[];
  issues: { kind: string; message: string; count: number }[];
  coverage: { questions: string; never: string[] };
  /** who goes where: reach per flow element, the commonest routes, pages and branch paths nobody reached */
  paths: PathExploration;
  verdict: "ready" | "needs_attention" | "blocked";
  lines: string[];
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
const quantile = (xs: number[], q: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]; };

/** the starting counters: live, then the simulated fills applied on top (a fill never lowers a live count) */
export function startingCounts(def: SurveyDefinition, live: QuotaCounts = {}, fill: QuotaFill[] = []): { counts: QuotaCounts; unknown: string[] } {
  const counts: QuotaCounts = JSON.parse(JSON.stringify(live));
  const unknown: string[] = [];
  const norm = (s: string) => s.trim().toLowerCase();
  for (const f of fill) {
    const quotas = def.quotas.filter((q) => norm(q.name) === norm(f.quota) || q.id === f.quota || q.cells.some((c) => norm(c.label) === norm(f.cell ?? f.quota)));
    if (!quotas.length) { unknown.push(f.cell ? `${f.quota} / ${f.cell}` : f.quota); continue; }
    for (const q of quotas) {
      const cells = q.cells.filter((c) => !f.cell ? (norm(q.name) === norm(f.quota) || q.id === f.quota) || norm(c.label) === norm(f.quota) : norm(c.label) === norm(f.cell) || c.id === f.cell);
      if (!cells.length) { unknown.push(`${q.name} / ${f.cell}`); continue; }
      for (const c of cells) {
        const limit = effectiveLimit(q, c.limit, c.limitType);
        const want = Math.min(limit, Math.ceil(limit * Math.max(0, Math.min(1, f.share))));
        const by = (counts[q.id] ??= {});
        by[c.id] = Math.max(by[c.id] ?? 0, want);
      }
    }
  }
  return { counts, unknown };
}

export function productionTest(def: SurveyDefinition, opts: ProductionTestOptions = {}): ProductionTestReport {
  const count = Math.max(10, Math.min(2000, opts.count ?? 200));
  const { counts: start, unknown } = startingCounts(def, opts.liveCounts, opts.fill);
  const pop = generatePopulation(def, { count, seed: opts.seed ?? 20261106, quotaCounts: start, edgeRate: 0.1 });

  /* the counters as they evolve: replay the completes in arrival order, noting when each cell fills */
  const running: QuotaCounts = JSON.parse(JSON.stringify(start));
  const filledAt = new Map<string, number>();
  const reached = new Map<string, number>();
  const minutes: number[] = [];
  pop.respondents.forEach((r, i) => {
    if (r.endStatus === "complete") {
      minutes.push(Math.max(1, r.asked.length / QUESTIONS_PER_MINUTE));
      for (const { quotaId, cellId } of quotaIncrements(def, r.sim.state)) {
        const by = (running[quotaId] ??= {});
        by[cellId] = (by[cellId] ?? 0) + 1;
        const k = `${quotaId}:${cellId}`;
        reached.set(k, (reached.get(k) ?? 0) + 1);
        const q = def.quotas.find((x) => x.id === quotaId)!;
        const c = q.cells.find((x) => x.id === cellId)!;
        const lim = effectiveLimit(q, c.limit, c.limitType);
        if (lim > 0 && by[cellId] >= lim && !filledAt.has(k)) filledAt.set(k, i + 1);
      }
    }
  });
  const quotas: ProductionQuotaCell[] = def.quotas.flatMap((q) => q.cells.map((c) => {
    const k = `${q.id}:${c.id}`;
    const lim = effectiveLimit(q, c.limit, c.limitType);
    const s = start[q.id]?.[c.id] ?? 0, e = running[q.id]?.[c.id] ?? 0;
    return { quota: q.name, quotaId: q.id, cell: c.label, cellId: c.id, mode: q.mode, limit: lim, target: c.target ?? null, start: s, end: e, full: lim > 0 && e >= lim, filledAt: lim > 0 && s >= lim ? 0 : filledAt.get(k) ?? null, reached: reached.get(k) ?? 0 };
  }));

  /* the live gates, as launch would meet them */
  const gates: ProductionTestReport["gates"] = [];
  const win = fieldworkWindow(def.deployment, opts.now ?? Date.now());
  gates.push(win.open ? { id: "window", ok: true, message: def.deployment.activeUntil ? `The live link is open now and closes ${def.deployment.activeUntil.slice(0, 10)}.` : "The live link has no closing date." } : { id: "window", ok: false, message: `${win.title}: ${win.body}` });
  const access = def.deployment.access;
  if (access.mode === "password") gates.push(access.password ? { id: "password", ok: true, message: "Respondents type the password before the first page." } : { id: "password", ok: false, message: "Access is by password but no password is set — nobody could start." });
  if (access.mode === "unique_links" || access.mode === "invitation") gates.push(opts.links ? { id: "links", ok: true, message: `${opts.links.toLocaleString("en")} ${access.mode === "invitation" ? "invitations" : "unique links"} exist.` } : { id: "links", ok: false, message: `Access is by ${access.mode === "invitation" ? "invitation" : "unique link"} and no ${access.mode === "invitation" ? "invitations have" : "links have"} been created — nobody could start.` });
  for (const b of opts.publishBlockers ?? []) gates.push({ id: "publish", ok: false, message: b });
  if (unknown.length) gates.push({ id: "fill", ok: false, message: `No quota or cell named ${unknown.join(", ")} — that fill was not simulated.` });

  const outcomes = pop.coverage.endStatuses;
  const completes = outcomes.complete ?? 0;
  const issues = pop.issues.map((x) => ({ kind: x.kind, message: x.message, count: x.count }));
  const never = pop.coverage.questions.missing.map((m) => m.code);
  const hardFullAtStart = quotas.filter((c) => c.mode === "hard" && c.filledAt === 0);
  const neverReached = quotas.filter((c) => c.limit > 0 && c.reached === 0 && c.start < c.limit);
  const blocked = gates.some((g) => !g.ok && g.id !== "fill") || completes === 0;
  const attention = issues.length > 0 || neverReached.length > 0 || hardFullAtStart.length > 0 || gates.some((g) => !g.ok);
  const verdict: ProductionTestReport["verdict"] = blocked ? "blocked" : attention ? "needs_attention" : "ready";
  const loi = { median: Math.round(quantile(minutes, 0.5)), p90: Math.round(quantile(minutes, 0.9)) };

  const lines: string[] = [];
  lines.push(`Simulated — nothing was written: ${count} respondents walked the survey as the live link would meet them${opts.liveCounts && Object.keys(opts.liveCounts).length ? ", starting from the live quota counts" : ""}${opts.fill?.length ? `, with ${opts.fill.map((f) => `${f.cell ?? f.quota} at ${Math.round(f.share * 100)} %`).join(", ")}` : ""}. No live or test counter moved.`);
  lines.push(`Outcomes: ${Object.entries(outcomes).map(([k, v]) => `${k.replace("_", " ")} ${v} (${pct(v, pop.respondents.length)} %)`).join(", ")}. The generator steers respondents past screeners, so the screen-out share is a lower bound, not an incidence forecast.`);
  if (completes) lines.push(`Length: about ${loi.median} minutes for a complete (90 % within ${loi.p90}), from the questions each one was asked.`);
  for (const g of gates) lines.push(`${g.ok ? "✓" : "✗"} ${g.message}`);
  for (const c of hardFullAtStart) lines.push(`${c.quota} / ${c.cell} is full before the test starts (${c.start} of ${c.limit}) — every respondent in it ends quota-full${c.mode === "hard" ? "" : " (soft: flagged only)"}.`);
  for (const c of quotas.filter((x) => x.filledAt && x.filledAt > 0)) lines.push(`${c.quota} / ${c.cell} fills after ${c.filledAt} simulated respondents (${c.start} → ${c.limit}); later respondents in it end quota-full.`);
  for (const c of neverReached) lines.push(`${c.quota} / ${c.cell}: no simulated complete fell in it — check its condition can be met by an answer the survey asks.`);
  if (outcomes.quota_full) lines.push(`${outcomes.quota_full} respondents ended on the quota-full path; its end page and redirect are what they would see live.`);
  for (const x of issues.slice(0, 8)) lines.push(`Issue (${x.kind.replace(/_/g, " ")}, ${x.count}×): ${x.message}`);
  const paths = summarizePaths(def, pop);
  if (paths.routes[0]) lines.push(`Most common route (${paths.routes[0].share} %): ${paths.routes[0].pages.length} pages, ending ${paths.routes[0].ending}; ${paths.routes.length} distinct routes in the top list.`);
  if (paths.neverReached.length) lines.push(`No simulated respondent reached: ${paths.neverReached.slice(0, 8).map((x) => x.kind === "path" ? x.label : x.id).join(", ")} — check the conditions in front of them.`);
  if (never.length) lines.push(`Never shown to any simulated respondent: ${never.slice(0, 12).join(", ")}${never.length > 12 ? ` and ${never.length - 12} more` : ""}.`);
  lines.push(verdict === "ready" ? "Verdict: ready — nothing in the simulation would stop or mislead a live respondent." : verdict === "blocked" ? "Verdict: blocked — fix the ✗ lines before launch." : "Verdict: needs attention — read the lines above before launch.");

  return {
    simulated: true, respondents: pop.respondents.length, outcomes, completeShare: pct(completes, pop.respondents.length) / 100, loiMinutes: loi, quotas, gates, issues,
    coverage: { questions: `${pop.coverage.questions.exercised} of ${pop.coverage.questions.total}`, never }, paths, verdict, lines,
  };
}
