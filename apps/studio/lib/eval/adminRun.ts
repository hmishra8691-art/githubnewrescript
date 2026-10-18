import type { EvalCase, EvalCategory } from "./cases.ts";
import type { CaseResult } from "./report.ts";

/**
 * THE /platform EVALUATION RUN (platform administrators): a small subset of the
 * harness (≤10 cases) against the installation's own provider, one case per
 * request (each request stays well inside the platform's time limit), with a
 * cost estimate shown first and a HARD CAP checked before every case. Metered
 * to the platform: the cases run in the sandbox project — no customer project
 * is read or written and no customer wallet is charged — and what each model
 * call cost at the provider is kept with the run (`ai_eval_runs`, migration
 * 0068; in the server's memory until it is applied).
 *
 * This file is the arithmetic and the bookkeeping, apart from Next.
 */

export const ADMIN_MAX_CASES = 10;
/** the most one admin run may spend, whatever is asked (PLATFORM_EVAL_MAX_USD lowers or raises it up to $20) */
export function adminCapCeiling(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.PLATFORM_EVAL_MAX_USD);
  return Number.isFinite(v) && v > 0 ? Math.min(20, v) : 2;
}

/** what one model turn of a category typically sends and receives (tokens) — production calls of 2026-10-15…17 for the copilot paths, rounded up */
export const TYPICAL_TURN: Record<EvalCategory, { input: number; output: number }> = {
  single_edit: { input: 9_000, output: 1_500 }, ux_script: { input: 13_000, output: 3_500 }, translation: { input: 10_000, output: 2_500 },
  long_brief: { input: 12_000, output: 3_000 }, staged_generation: { input: 40_000, output: 12_000 }, analysis_plan: { input: 11_000, output: 2_000 },
  methods: { input: 11_000, output: 2_500 }, qualitative: { input: 9_000, output: 4_000 }, scope: { input: 9_000, output: 1_200 },
  multi_turn: { input: 9_500, output: 1_500 }, undo: { input: 9_500, output: 1_500 }, repair: { input: 9_000, output: 1_500 },
  injection: { input: 9_000, output: 1_500 }, production_prompt: { input: 12_000, output: 3_000 },
};
/** a repair pass or a continuation on top of the typical turn */
export const ESTIMATE_HEADROOM = 1.5;

/** the provider cost of a case before it runs: each turn that may call a model at its typical size, uncached, with headroom */
export function estimateCase(c: EvalCase, price: (inputTokens: number, outputTokens: number) => number): number {
  const t = TYPICAL_TURN[c.category];
  const turns = c.turns.filter((x) => x.expect?.modelCalled !== false).length;
  return Math.round(turns * price(t.input, t.output) * ESTIMATE_HEADROOM * 1e6) / 1e6;
}

export interface AdminRun {
  id: string;
  createdBy: string | null;
  status: "running" | "finished" | "capped" | "failed";
  provider: string;
  model: string;
  caseIds: string[];
  capUsd: number;
  estimateUsd: number;
  spentUsd: number;
  results: CaseResult[];
  report: unknown | null;
  createdAt: string;
}

/** may this case run now? — in the run, not run yet, and its estimate fits under the cap with what is spent */
export function mayRunCase(run: AdminRun, caseId: string, estimateUsd: number): { ok: true } | { ok: false; reason: string; capped?: boolean } {
  if (run.status !== "running") return { ok: false, reason: `This run is ${run.status}.` };
  if (!run.caseIds.includes(caseId)) return { ok: false, reason: "That case is not part of this run." };
  if (run.results.some((r) => r.id === caseId)) return { ok: false, reason: "That case has already run." };
  if (run.spentUsd + estimateUsd > run.capUsd) return { ok: false, capped: true, reason: `Stopped at the cap: $${run.spentUsd.toFixed(4)} spent of $${run.capUsd.toFixed(2)}, and the next case may cost up to $${estimateUsd.toFixed(4)}.` };
  return { ok: true };
}

/** a case result as it is kept with the run: the replies shortened */
export function keptResult(r: CaseResult): CaseResult {
  return { ...r, turns: r.turns.map((t) => ({ ...t, reply: t.reply.slice(0, 600), message: t.message.slice(0, 200) })) };
}

/* ------------------------------------------------------------ the store: the database (0068), else memory */

type Db = { from(t: string): any };  // eslint-disable-line @typescript-eslint/no-explicit-any
declare global {
  // eslint-disable-next-line no-var
  var __rescriptEvalRuns: Map<string, AdminRun> | undefined;
}
const memory = () => (globalThis.__rescriptEvalRuns ??= new Map());
const MISSING = /ai_eval_runs|relation .* does not exist|schema cache|PGRST205/i;

const fromRow = (r: Record<string, unknown>): AdminRun => ({
  id: String(r.id), createdBy: (r.created_by as string) ?? null, status: r.status as AdminRun["status"], provider: String(r.provider ?? ""), model: String(r.model ?? ""),
  caseIds: (r.case_ids as string[]) ?? [], capUsd: Number(r.cap_usd ?? 0), estimateUsd: Number(r.estimate_usd ?? 0), spentUsd: Number(r.spent_usd ?? 0),
  results: (r.results as CaseResult[]) ?? [], report: r.report ?? null, createdAt: String(r.created_at ?? ""),
});

export interface AdminRunStore { durable: boolean; create(r: Omit<AdminRun, "id" | "createdAt" | "results" | "report" | "spentUsd" | "status">): Promise<AdminRun>; get(id: string): Promise<AdminRun | null>; save(r: AdminRun): Promise<AdminRun>; recent(n: number): Promise<AdminRun[]> }

export function adminRunStore(db: Db | null): AdminRunStore {
  let durable = !!db;
  const mem: AdminRunStore = {
    durable: false,
    async create(r) { const run: AdminRun = { ...r, id: globalThis.crypto.randomUUID(), createdAt: new Date().toISOString(), results: [], report: null, spentUsd: 0, status: "running" }; memory().set(run.id, run); return run; },
    async get(id) { return memory().get(id) ?? null; },
    async save(r) { memory().set(r.id, r); return r; },
    async recent(n) { return [...memory().values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, n); },
  };
  if (!db) return mem;
  const fallback = <T,>(e: { message?: string } | null, run: () => Promise<T>): Promise<T> | null => { if (e && MISSING.test(e.message ?? "")) { durable = false; return run(); } return null; };
  return {
    get durable() { return durable; },
    async create(r) {
      if (!durable) return mem.create(r);
      const { data, error } = await db.from("ai_eval_runs").insert({ created_by: r.createdBy, provider: r.provider.slice(0, 200), model: r.model.slice(0, 200), case_ids: r.caseIds, cap_usd: r.capUsd, estimate_usd: r.estimateUsd }).select("*").single();
      const fb = fallback(error, () => mem.create(r)); if (fb) return fb;
      if (error) throw new Error(error.message);
      return fromRow(data);
    },
    async get(id) {
      if (!durable || !/^[0-9a-f-]{36}$/i.test(id)) return mem.get(id);
      const { data, error } = await db.from("ai_eval_runs").select("*").eq("id", id).maybeSingle();
      const fb = fallback(error, () => mem.get(id)); if (fb) return fb;
      if (error) throw new Error(error.message);
      return data ? fromRow(data) : mem.get(id);
    },
    async save(r) {
      if (!durable || memory().has(r.id)) return mem.save(r);
      const { error } = await db.from("ai_eval_runs").update({ status: r.status, spent_usd: r.spentUsd, results: r.results, report: r.report, updated_at: new Date().toISOString() }).eq("id", r.id);
      const fb = fallback(error, () => mem.save(r)); if (fb) return fb;
      if (error) throw new Error(error.message);
      return r;
    },
    async recent(n) {
      if (!durable) return mem.recent(n);
      const { data, error } = await db.from("ai_eval_runs").select("id, created_by, status, provider, model, case_ids, cap_usd, estimate_usd, spent_usd, report, created_at").order("created_at", { ascending: false }).limit(n);
      const fb = fallback(error, () => mem.recent(n)); if (fb) return fb;
      if (error) throw new Error(error.message);
      return (data ?? []).map((x: Record<string, unknown>) => fromRow({ ...x, results: [] }));
    },
  };
}
