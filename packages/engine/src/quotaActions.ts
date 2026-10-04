import type { Condition, FlowNode, Question, Quota, QuotaCell, SurveyDefinition } from "@rescript/schema";
import type { IdMinter } from "./questionOps.js";
import { conditionRefs, questionOrder } from "./dependencies.js";
import { evaluateCondition } from "./evaluate.js";
import { createResponseState } from "./state.js";
import { formatCondition } from "./logicExpression.js";
import { quotaReferences } from "./quotaDashboard.js";
import type { QuotaCounts } from "./quotas.js";
import { stripHtmlText } from "./html.js";
import { listBlocks } from "./blocks.js";

/*
 * QUOTA INTELLIGENCE (research-intelligence Phase 4): quotas as copilot
 * actions, in words — "500 completes, 50/50 gender, interlocked with three
 * age bands" — written through the same gate as everything else; the
 * feasibility review (cells that leave people out, cells that double-count,
 * limits that do not add up, a quota nothing checks, a check placed before
 * the question it reads); and fieldwork advice from the live counts (a cell
 * that is full while the rest is open, a cell that will not fill at this
 * pace), each with the adjustment it would take, as a proposal.
 *
 * The quota itself is the existing `Quota` — the dashboard, the runtime and
 * the List Fill read the same object — and the counts stay in `quota_counts`.
 */

/* ------------------------------------------------------------ actions */

import type { CondInput } from "./surveyActions.js";
export interface QuotaOnFull { kind: "terminate" | "redirect" | "flag" | "warn"; url?: string; message?: string }
export interface QuotaCellSpec { label?: string; when: CondInput; limit?: number; percent?: number; target?: number }
/** one band of one dimension: a set of option codes, or a numeric range */
export interface QuotaBand { label?: string; codes?: (string | number)[]; min?: number; max?: number; share?: number }
export interface QuotaDimension { question: string; bands?: QuotaBand[] }

export type QuotaAction =
  | { op: "create_quota"; name: string; cells?: QuotaCellSpec[]; dimensions?: QuotaDimension[]; total?: number; mode?: "hard" | "soft"; onFull?: QuotaOnFull; countStatus?: ("complete" | "in_progress")[]; check?: boolean; checkWhen?: CondInput }
  | { op: "update_quota"; quota: string; name?: string; targetTotal?: number | null; total?: number; mode?: "hard" | "soft"; onFull?: QuotaOnFull; countStatus?: ("complete" | "in_progress")[]; cells?: { cell: string; label?: string; limit?: number; percent?: number; target?: number | null }[] }
  | { op: "add_quota_cells"; quota: string; cells: QuotaCellSpec[] }
  | { op: "remove_quota_cells"; quota: string; cells: string[] }
  | { op: "delete_quota"; quota: string }
  | { op: "set_quota_check"; quotas: string[]; after?: string; onFull?: QuotaOnFull; when?: CondInput | null };

export const QUOTA_ACTION_OPS = ["create_quota", "update_quota", "add_quota_cells", "remove_quota_cells", "delete_quota", "set_quota_check"] as const;
const OPS = new Set<string>(QUOTA_ACTION_OPS);
export const isQuotaOp = (op: string): boolean => OPS.has(op);

const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v.replace(/[%,\s]/g, ""))) ? Number(v.replace(/[%,\s]/g, "")) : undefined);
const cond = (v: unknown): CondInput | undefined => (typeof v === "string" && v.trim() ? v.trim() : v && typeof v === "object" && !Array.isArray(v) ? (v as Condition) : undefined);
const ON_FULL = new Set(["terminate", "redirect", "flag", "warn"]);

function onFullOf(v: unknown): QuotaOnFull | string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") { const k = v.trim().toLowerCase().replace(/^screen[- ]?out$|^end$|^close$/, "terminate").replace(/^continue$/, "flag"); return ON_FULL.has(k) ? { kind: k as QuotaOnFull["kind"] } : `“${v}” is not what a full quota can do (terminate, redirect, flag, warn)`; }
  if (typeof v !== "object") return "onFull must be terminate, redirect, flag or warn";
  const o = v as Record<string, unknown>;
  const k = str(o.kind ?? o.action)?.toLowerCase().replace(/^screen[- ]?out$|^end$|^close$/, "terminate").replace(/^continue$/, "flag");
  if (!k || !ON_FULL.has(k)) return `“${String(o.kind ?? o.action)}” is not what a full quota can do (terminate, redirect, flag, warn)`;
  const url = str(o.url, 2000), message = str(o.message, 2000);
  if (k === "redirect" && !url) return "a redirect needs a url";
  return { kind: k as QuotaOnFull["kind"], ...(url ? { url } : {}), ...(message ? { message } : {}) };
}

function cellSpec(e: unknown): QuotaCellSpec | string | null {
  const x = (e ?? {}) as Record<string, unknown>;
  const when = cond(x.when ?? x.condition);
  if (!when) return null;
  const limit = num(x.limit ?? x.max ?? x.count ?? x.n), percent = num(x.percent ?? x.pct ?? x.share), target = num(x.target);
  if (limit !== undefined && limit < 0) return "a cell's limit cannot be negative";
  if (percent !== undefined && (percent <= 0 || percent > 100)) return "a cell's percent must be between 0 and 100";
  return { ...(str(x.label, 120) ? { label: str(x.label, 120) } : {}), when, ...(limit !== undefined ? { limit } : {}), ...(percent !== undefined ? { percent } : {}), ...(target !== undefined ? { target } : {}) };
}

function bands(v: unknown): QuotaBand[] | string | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: QuotaBand[] = [];
  for (const e of v) {
    const x = (e ?? {}) as Record<string, unknown>;
    const codes = Array.isArray(x.codes ?? x.options ?? x.values) ? ((x.codes ?? x.options ?? x.values) as unknown[]).filter((c): c is string | number => typeof c === "string" || typeof c === "number") : x.code !== undefined || x.option !== undefined ? [x.code ?? x.option].filter((c): c is string | number => typeof c === "string" || typeof c === "number") : undefined;
    const min = num(x.min ?? x.from), max = num(x.max ?? x.to), share = num(x.share ?? x.percent ?? x.pct);
    if (share !== undefined && (share <= 0 || share > 100)) return "a band's share must be between 0 and 100";
    if (!codes?.length && min === undefined && max === undefined && !str(x.label)) return "a band needs codes (option codes or labels), a min/max range, or a label that names an option";
    out.push({ ...(str(x.label, 120) ? { label: str(x.label, 120) } : {}), ...(codes?.length ? { codes } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(share !== undefined ? { share } : {}) });
  }
  return out;
}

const COUNT_STATUS = new Set(["complete", "in_progress"]);
const statuses = (v: unknown): ("complete" | "in_progress")[] | undefined => (Array.isArray(v) ? (v.map((x) => String(x).toLowerCase().replace(/[\s-]/g, "_")).filter((x) => COUNT_STATUS.has(x)) as ("complete" | "in_progress")[]) : undefined);

/** the gate: a well-formed action, a reason it is refused, or null when `op` is not a quota op */
export function coerceQuotaAction(op: string, o: Record<string, unknown>): QuotaAction | string | null {
  if (!isQuotaOp(op)) return null;
  switch (op) {
    case "create_quota": {
      const name = str(o.name ?? o.title, 120);
      if (!name) return "create_quota needs a name";
      const rawCells = Array.isArray(o.cells) ? o.cells : undefined;
      const cells: QuotaCellSpec[] = [];
      for (const e of rawCells ?? []) { const c = cellSpec(e); if (typeof c === "string") return c; if (c) cells.push(c); }
      const dims: QuotaDimension[] = [];
      for (const e of Array.isArray(o.dimensions ?? o.interlock ?? o.by) ? ((o.dimensions ?? o.interlock ?? o.by) as unknown[]) : []) {
        const x = (typeof e === "string" ? { question: e } : (e ?? {})) as Record<string, unknown>;
        const question = str(x.question ?? x.ref ?? x.variable, 80);
        if (!question) return "a dimension needs a question";
        const b = bands(x.bands ?? x.groups ?? x.ranges ?? x.options);
        if (typeof b === "string") return b;
        dims.push({ question, ...(b ? { bands: b } : {}) });
      }
      if (!cells.length && !dims.length) return "create_quota needs cells (label, when, limit) or dimensions (the questions it crosses)";
      const total = num(o.total ?? o.targetTotal ?? o.completes);
      if (dims.length && total === undefined) return "a quota built from dimensions needs the total number of completes it splits (total)";
      if (cells.some((c) => c.percent !== undefined) && total === undefined) return "percent cells need the total they are a percent of (total)";
      if (cells.some((c) => c.limit === undefined && c.percent === undefined)) return "every cell needs a limit (or a percent of the total)";
      const of = onFullOf(o.onFull ?? o.on_full ?? o.whenFull); if (typeof of === "string") return of;
      const mode = str(o.mode)?.toLowerCase();
      if (mode && mode !== "hard" && mode !== "soft") return "mode is hard or soft";
      const checkWhen = cond(o.checkWhen ?? o.check_when);
      return { op, name, ...(cells.length ? { cells } : {}), ...(dims.length ? { dimensions: dims } : {}), ...(total !== undefined ? { total } : {}), ...(mode ? { mode: mode as "hard" | "soft" } : {}), ...(of ? { onFull: of } : {}), ...(statuses(o.countStatus) ? { countStatus: statuses(o.countStatus) } : {}), ...(o.check === false ? { check: false } : {}), ...(checkWhen ? { checkWhen } : {}) };
    }
    case "update_quota": {
      const quota = str(o.quota ?? o.name ?? o.target, 120); if (!quota) return "update_quota needs the quota (by name or id)";
      const a: QuotaAction = { op, quota };
      const name = str(o.newName ?? o.rename ?? o.title, 120); if (name) a.name = name;
      if (o.targetTotal === null) a.targetTotal = null; else if (num(o.targetTotal) !== undefined) a.targetTotal = num(o.targetTotal);
      if (num(o.total ?? o.scaleTo ?? o.completes) !== undefined) a.total = num(o.total ?? o.scaleTo ?? o.completes);
      const mode = str(o.mode)?.toLowerCase(); if (mode) { if (mode !== "hard" && mode !== "soft") return "mode is hard or soft"; a.mode = mode as "hard" | "soft"; }
      const of = onFullOf(o.onFull ?? o.on_full ?? o.whenFull); if (typeof of === "string") return of; if (of) a.onFull = of;
      if (statuses(o.countStatus)) a.countStatus = statuses(o.countStatus);
      if (Array.isArray(o.cells)) {
        a.cells = [];
        for (const e of o.cells) {
          const x = (e ?? {}) as Record<string, unknown>;
          const cell = str(x.cell ?? x.label ?? x.id, 120); if (!cell) return "each cell edit names the cell (by label or id)";
          const limit = num(x.limit ?? x.max ?? x.count), percent = num(x.percent ?? x.pct), target = x.target === null ? null : num(x.target), label = str(x.newLabel ?? x.rename, 120);
          if (limit !== undefined && limit < 0) return "a cell's limit cannot be negative";
          if (percent !== undefined && (percent <= 0 || percent > 100)) return "a cell's percent must be between 0 and 100";
          if (limit === undefined && percent === undefined && target === undefined && !label) return `the edit of cell “${cell}” changes nothing`;
          a.cells.push({ cell, ...(label ? { label } : {}), ...(limit !== undefined ? { limit } : {}), ...(percent !== undefined ? { percent } : {}), ...(target !== undefined ? { target } : {}) });
        }
      }
      if (Object.keys(a).length <= 2) return "update_quota changes nothing";
      return a;
    }
    case "add_quota_cells": {
      const quota = str(o.quota ?? o.name, 120); if (!quota) return "add_quota_cells needs the quota";
      const cells: QuotaCellSpec[] = [];
      for (const e of Array.isArray(o.cells) ? o.cells : []) { const c = cellSpec(e); if (typeof c === "string") return c; if (c) cells.push(c); }
      if (!cells.length) return "add_quota_cells needs cells with when and limit";
      if (cells.some((c) => c.limit === undefined && c.percent === undefined)) return "every cell needs a limit (or a percent of the quota's total)";
      return { op, quota, cells };
    }
    case "remove_quota_cells": {
      const quota = str(o.quota ?? o.name, 120); if (!quota) return "remove_quota_cells needs the quota";
      const cells = Array.isArray(o.cells) ? o.cells.map((x) => str(x, 120)).filter((x): x is string => !!x) : [];
      if (!cells.length) return "remove_quota_cells needs the cells to remove (by label or id)";
      return { op, quota, cells };
    }
    case "delete_quota": {
      const quota = str(o.quota ?? o.name ?? o.target, 120); if (!quota) return "delete_quota needs the quota";
      return { op, quota };
    }
    case "set_quota_check": {
      const list = Array.isArray(o.quotas) ? o.quotas : o.quota !== undefined ? [o.quota] : [];
      const quotas = list.map((x) => str(x, 120)).filter((x): x is string => !!x);
      if (!quotas.length) return "set_quota_check needs the quotas it checks";
      const of = onFullOf(o.onFull ?? o.on_full); if (typeof of === "string") return of;
      const after = str(o.after ?? o.afterQuestion ?? o.afterBlock, 120);
      const when = o.when === null ? null : cond(o.when);
      return { op, quotas, ...(after ? { after } : {}), ...(of ? { onFull: of } : {}), ...(when !== undefined ? { when } : {}) };
    }
  }
  return null;
}

/* ------------------------------------------------------------ applying */

export interface QuotaEnv {
  question(ref: string): Question | undefined;
  condition(input: CondInput): Condition;
  ids: IdMinter;
}
export interface QuotaApplied { description: string; destructive?: string; warnings: string[]; touched: string[] }

class ActionError extends Error {}
const fail = (m: string): never => { throw new ActionError(m); };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function findQuota(def: SurveyDefinition, ref: string): Quota | undefined {
  const r = ref.trim().toLowerCase();
  return def.quotas.find((q) => q.id.toLowerCase() === r) ?? def.quotas.find((q) => q.name.trim().toLowerCase() === r) ?? def.quotas.find((q) => q.name.trim().toLowerCase().includes(r) && r.length >= 3);
}
const quotaOrFail = (def: SurveyDefinition, ref: string): Quota => findQuota(def, ref) ?? fail(`there is no quota “${ref}”${def.quotas.length ? ` — the quotas are ${def.quotas.map((q) => `“${q.name}”`).join(", ")}` : ""}`);
function findCell(q: Quota, ref: string): QuotaCell | undefined {
  const r = ref.trim().toLowerCase();
  return q.cells.find((c) => c.id.toLowerCase() === r) ?? q.cells.find((c) => c.label.trim().toLowerCase() === r);
}

/** is this node (or something inside it) the page that asks `qid`? */
export function containsQuestion(n: FlowNode, qid: string): boolean {
  if (n.type === "page") return n.questionIds.includes(qid);
  const k = n as { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] };
  for (const list of [k.children, ...(k.branches ?? []).map((b) => b.children), k.otherwise]) if (list?.some((c) => containsQuestion(c, qid))) return true;
  return false;
}
/** before the survey's trailing End node(s) */
export function endIndex(flow: FlowNode[]): number {
  let i = flow.length;
  while (i > 0 && flow[i - 1].type === "end") i--;
  return i;
}

/** every question a quota's cells read */
export function quotaReads(def: SurveyDefinition, quota: Quota): Set<string> {
  const read = new Set<string>();
  for (const c of quota.cells) conditionRefs(def, c.when, read);
  return read;
}
/** the top-level flow index after which a check of these quotas may run: after the last question any of them reads; -1 when they read nothing */
export function checkPosition(def: SurveyDefinition, quotas: Quota[]): number {
  const order = questionOrder(def);
  const flow = def.flow as FlowNode[];
  let best = -1;
  for (const q of quotas) for (const id of quotaReads(def, q)) {
    const top = flow.findIndex((n) => containsQuestion(n, id));
    if (top > best) best = top;
  }
  void order;
  return best;
}
function removeChecksFor(def: SurveyDefinition, quotaId: string): void {
  const flow = def.flow as FlowNode[];
  for (let i = flow.length - 1; i >= 0; i--) {
    const n = flow[i] as { type: string; quotaIds?: string[] };
    if (n.type !== "quota_check" || !n.quotaIds?.includes(quotaId)) continue;
    n.quotaIds = n.quotaIds.filter((x) => x !== quotaId);
    if (!n.quotaIds.length) flow.splice(i, 1);
  }
}
function placeCheck(def: SurveyDefinition, quotas: Quota[], onFull: QuotaOnFull, ids: IdMinter, when?: Condition, afterIndex?: number): string {
  const flow = def.flow as FlowNode[];
  const at = afterIndex !== undefined ? afterIndex : checkPosition(def, quotas);
  const node = { type: "quota_check", id: ids("quota_check"), quotaIds: quotas.map((q) => q.id), onFull: { kind: onFull.kind === "warn" ? "flag" : onFull.kind, ...(onFull.url ? { url: onFull.url } : {}) }, ...(when ? { when } : {}) };
  flow.splice(at >= 0 ? at + 1 : endIndex(flow), 0, node as never);
  return node.id;
}

interface BuiltCell { label: string; when: Condition; limit: number; limitType: "count" | "percent"; target?: number }

/** cells from the crossing of dimensions: every band of every question, shares to the total, largest remainder so the limits add up */
function cellsFromDimensions(def: SurveyDefinition, dims: QuotaDimension[], total: number, env: QuotaEnv): BuiltCell[] {
  type Band = { label: string; rule: Condition; share: number };
  const perDim: Band[][] = dims.map((d) => {
    const q = env.question(d.question) ?? fail(`there is no question “${d.question}” to build a quota on`);
    const choice = ["single_select", "dropdown", "multi_select", "multi_dropdown", "image_select"].includes(q.type);
    const options = q.options ?? [];
    const bandsIn: QuotaBand[] = d.bands?.length ? d.bands : choice ? options.map((o) => ({ label: stripHtmlText(o.label), codes: [o.code] })) : fail(`${q.code} is not a choice question — give it bands with min/max (e.g. 18–34)`);
    const bands: Band[] = bandsIn.map((b) => {
      if (b.codes?.length || (b.label && !b.min && !b.max && choice)) {
        const want = (b.codes?.length ? b.codes : [b.label!]).map((c) => {
          const hit = options.find((o) => String(o.code).toLowerCase() === String(c).toLowerCase()) ?? options.find((o) => stripHtmlText(o.label).toLowerCase() === String(c).toLowerCase());
          return hit ?? fail(`${q.code} has no option “${c}” — its options are ${options.map((o) => `${o.code}=${stripHtmlText(o.label)}`).join(", ")}`);
        });
        const codes = want.map((o) => o.code);
        const rule: Condition = codes.length === 1
          ? { type: "rule", source: { kind: "question", ref: q.id }, operator: q.type === "multi_select" || q.type === "multi_dropdown" ? "selected" : "eq", value: codes[0] } as Condition
          : { type: "rule", source: { kind: "question", ref: q.id }, operator: q.type === "multi_select" || q.type === "multi_dropdown" ? "containsAny" : "in", value: codes } as Condition;
        return { label: b.label ?? want.map((o) => stripHtmlText(o.label)).join("/"), rule, share: b.share ?? 0 };
      }
      if (b.min === undefined && b.max === undefined) fail(`band “${b.label ?? "?"}” on ${q.code} needs a min or a max`);
      const rule: Condition = b.min !== undefined && b.max !== undefined
        ? { type: "rule", source: { kind: "question", ref: q.id }, operator: "between", value: b.min, value2: b.max } as Condition
        : b.min !== undefined
          ? { type: "rule", source: { kind: "question", ref: q.id }, operator: "gte", value: b.min } as Condition
          : { type: "rule", source: { kind: "question", ref: q.id }, operator: "lte", value: b.max } as Condition;
      return { label: b.label ?? (b.min !== undefined && b.max !== undefined ? `${b.min}–${b.max}` : b.min !== undefined ? `${b.min}+` : `≤${b.max}`), rule, share: b.share ?? 0 };
    });
    // shares: the ones given are kept; the rest split what is left equally
    const given = bands.filter((b) => b.share > 0).reduce((s, b) => s + b.share, 0);
    if (given > 100.001) fail(`the shares of ${q.code}'s bands add up to ${given}% — more than 100`);
    const open = bands.filter((b) => !(b.share > 0)).length;
    for (const b of bands) if (!(b.share > 0)) b.share = open ? (100 - given) / open : 0;
    return bands;
  });
  // the crossing
  let cells: { labels: string[]; rules: Condition[]; share: number }[] = [{ labels: [], rules: [], share: 1 }];
  for (const bands of perDim) cells = cells.flatMap((c) => bands.map((b) => ({ labels: [...c.labels, b.label], rules: [...c.rules, b.rule], share: c.share * b.share / 100 })));
  if (cells.length > 400) fail(`${cells.length} cells is too many for one quota — cross fewer bands`);
  // largest remainder: limits add up to the total exactly
  const raw = cells.map((c) => total * c.share);
  const floors = raw.map(Math.floor);
  let left = Math.round(total) - floors.reduce((s, x) => s + x, 0);
  const byRemainder = raw.map((x, i) => ({ i, r: x - floors[i] })).sort((a, b) => b.r - a.r);
  for (const { i } of byRemainder) { if (left <= 0) break; floors[i]++; left--; }
  return cells.map((c, i) => ({ label: c.labels.join(" × "), when: c.rules.length === 1 ? c.rules[0] : { type: "group", op: "and", children: c.rules } as Condition, limit: floors[i], limitType: "count" as const }));
}

function buildCell(def: SurveyDefinition, spec: QuotaCellSpec, total: number | undefined, env: QuotaEnv): BuiltCell {
  const when = env.condition(spec.when);
  const label = spec.label ?? formatCondition(def, when).slice(0, 80);
  if (spec.percent !== undefined) return { label, when, limit: spec.percent, limitType: "percent", ...(spec.target !== undefined ? { target: spec.target } : {}) };
  void total;
  return { label, when, limit: spec.limit ?? 0, limitType: "count", ...(spec.target !== undefined ? { target: spec.target } : {}) };
}

export function applyQuotaAction(def: SurveyDefinition, a: QuotaAction, env: QuotaEnv): QuotaApplied {
  const warnings: string[] = [];
  switch (a.op) {
    case "create_quota": {
      if (def.quotas.some((q) => q.name.trim().toLowerCase() === a.name.trim().toLowerCase())) fail(`there is already a quota named “${a.name}” — update_quota changes it`);
      const built: BuiltCell[] = [
        ...(a.dimensions?.length ? cellsFromDimensions(def, a.dimensions, a.total!, env) : []),
        ...(a.cells ?? []).map((c) => buildCell(def, c, a.total, env)),
      ];
      if (!built.length) fail("the quota has no cells");
      const cells: QuotaCell[] = built.map((c) => ({ id: env.ids("cell"), label: c.label, when: c.when, limit: c.limit, limitType: c.limitType, ...(c.target !== undefined ? { target: c.target } : {}) }));
      const onFull: QuotaOnFull = a.onFull ?? { kind: a.mode === "soft" ? "flag" : "terminate" };
      const quota: Quota = { id: env.ids("quota"), name: a.name, mode: a.mode ?? "hard", cells, ...(a.total !== undefined ? { targetTotal: a.total } : {}), onFull: { kind: onFull.kind, ...(onFull.url ? { url: onFull.url } : {}), ...(onFull.message ? { message: onFull.message } : {}) }, countStatus: a.countStatus?.length ? a.countStatus : ["complete"] };
      def.quotas = [...def.quotas, quota];
      if (a.check !== false) placeCheck(def, [quota], onFull, env.ids, a.checkWhen ? env.condition(a.checkWhen) : undefined);
      const sum = cells.filter((c) => c.limitType === "count").reduce((s, c) => s + c.limit, 0);
      if (a.total !== undefined && cells.every((c) => c.limitType === "count") && sum !== a.total) warnings.push(`The cells of “${a.name}” allow ${sum} completes in all, not the ${a.total} asked for.`);
      const shown = cells.slice(0, 12).map((c) => `${c.label} ≤ ${c.limit}${c.limitType === "percent" ? "%" : ""}`).join(", ");
      return { description: `Quota “${a.name}”${a.mode === "soft" ? " (soft)" : ""}${a.total !== undefined ? ` of ${a.total}` : ""}: ${shown}${cells.length > 12 ? ` … (${cells.length} cells)` : ""}${a.check === false ? " — not checked in the flow" : ""}`, warnings, touched: [] };
    }
    case "update_quota": {
      const q = quotaOrFail(def, a.quota);
      const changed: string[] = [];
      if (a.name && a.name !== q.name) { if (def.quotas.some((x) => x !== q && x.name.trim().toLowerCase() === a.name!.trim().toLowerCase())) fail(`there is already a quota named “${a.name}”`); q.name = a.name; changed.push(`renamed “${a.name}”`); }
      if (a.targetTotal === null) { delete q.targetTotal; changed.push("no target total"); }
      else if (a.targetTotal !== undefined) { if (a.targetTotal <= 0) fail("the target total must be above zero"); q.targetTotal = a.targetTotal; changed.push(`target total ${a.targetTotal}`); }
      if (a.total !== undefined) {
        // rescale: every count cell in proportion, the total exactly
        if (a.total <= 0) fail("the total must be above zero");
        const countCells = q.cells.filter((c) => c.limitType === "count");
        const sum = countCells.reduce((s, c) => s + c.limit, 0);
        if (countCells.length && sum > 0) {
          const raw = countCells.map((c) => a.total! * c.limit / sum);
          const floors = raw.map(Math.floor);
          let left = Math.round(a.total) - floors.reduce((s, x) => s + x, 0);
          for (const { i } of raw.map((x, i) => ({ i, r: x - floors[i] })).sort((x, y) => y.r - x.r)) { if (left <= 0) break; floors[i]++; left--; }
          countCells.forEach((c, i) => { c.limit = floors[i]; });
          changed.push(`limits rescaled from ${sum} to ${a.total} completes`);
        }
        q.targetTotal = a.total;
        if (!countCells.length) changed.push(`target total ${a.total}`);
      }
      if (a.mode && a.mode !== q.mode) { q.mode = a.mode; changed.push(a.mode === "soft" ? "soft — full cells flag, nobody is stopped" : "hard"); }
      if (a.onFull) { q.onFull = { kind: a.onFull.kind, ...(a.onFull.url ? { url: a.onFull.url } : {}), ...(a.onFull.message ? { message: a.onFull.message } : {}) }; for (const n of def.flow as FlowNode[]) if (n.type === "quota_check" && n.quotaIds.includes(q.id) && n.quotaIds.length === 1) n.onFull = { kind: a.onFull.kind === "warn" ? "flag" : a.onFull.kind, ...(a.onFull.url ? { url: a.onFull.url } : {}) }; changed.push(`when full: ${a.onFull.kind}${a.onFull.url ? ` → ${a.onFull.url}` : ""}`); }
      if (a.countStatus?.length) { q.countStatus = a.countStatus; changed.push(`counts ${a.countStatus.join(" and ").replace("_", " ")}`); }
      for (const e of a.cells ?? []) {
        const c = findCell(q, e.cell) ?? fail(`“${q.name}” has no cell “${e.cell}” — its cells are ${q.cells.map((x) => `“${x.label}”`).join(", ")}`);
        if (e.label) { changed.push(`“${c.label}” → “${e.label}”`); c.label = e.label; }
        if (e.limit !== undefined) { changed.push(`${c.label} ${c.limit}${c.limitType === "percent" ? "%" : ""} → ${e.limit}`); c.limit = e.limit; c.limitType = "count"; }
        if (e.percent !== undefined) { if (q.targetTotal === undefined) fail("a percent limit needs the quota's target total — set total first"); changed.push(`${c.label} → ${e.percent}%`); c.limit = e.percent; c.limitType = "percent"; }
        if (e.target === null) { delete c.target; } else if (e.target !== undefined) { c.target = e.target; changed.push(`${c.label} target ${e.target}`); }
      }
      if (!changed.length) fail("update_quota changes nothing");
      return { description: `Quota “${q.name}”: ${changed.join("; ")}`, warnings, touched: [] };
    }
    case "add_quota_cells": {
      const q = quotaOrFail(def, a.quota);
      const built = a.cells.map((c) => buildCell(def, c, q.targetTotal, env));
      if (built.some((c) => c.limitType === "percent") && q.targetTotal === undefined) fail("percent cells need the quota's target total — set total first");
      for (const c of built) if (q.cells.some((x) => x.label.trim().toLowerCase() === c.label.trim().toLowerCase())) fail(`“${q.name}” already has a cell “${c.label}”`);
      q.cells = [...q.cells, ...built.map((c) => ({ id: env.ids("cell"), label: c.label, when: c.when, limit: c.limit, limitType: c.limitType, ...(c.target !== undefined ? { target: c.target } : {}) }))];
      // the new cells may read a later question than the check sits after: move the check
      const pos = checkPosition(def, [q]);
      const flow = def.flow as FlowNode[];
      const checks = flow.map((n, i) => ({ n, i })).filter(({ n }) => n.type === "quota_check" && (n as { quotaIds: string[] }).quotaIds.includes(q.id));
      if (checks.length && pos >= 0 && checks.some(({ i }) => i <= pos)) { const kind = q.onFull.kind; removeChecksFor(def, q.id); placeCheck(def, [q], { kind, ...(q.onFull.url ? { url: q.onFull.url } : {}) }, env.ids); warnings.push(`The quota check for “${q.name}” was moved after the question the new cells read.`); }
      return { description: `Quota “${q.name}”: ${plural(built.length, "cell")} added — ${built.map((c) => `${c.label} ≤ ${c.limit}${c.limitType === "percent" ? "%" : ""}`).join(", ")}`, warnings, touched: [] };
    }
    case "remove_quota_cells": {
      const q = quotaOrFail(def, a.quota);
      const gone = a.cells.map((r) => findCell(q, r) ?? fail(`“${q.name}” has no cell “${r}”`));
      if (gone.length >= q.cells.length) fail(`that removes every cell of “${q.name}” — delete_quota removes the quota`);
      q.cells = q.cells.filter((c) => !gone.includes(c));
      return { description: `Quota “${q.name}”: ${plural(gone.length, "cell")} removed (${gone.map((c) => c.label).join(", ")})`, destructive: `Removes ${plural(gone.length, "cell")} from quota “${q.name}”: ${gone.map((c) => c.label).join(", ")} — their counts are no longer enforced`, warnings, touched: [] };
    }
    case "delete_quota": {
      const q = quotaOrFail(def, a.quota);
      const refs = quotaReferences(def, q.id);
      def.quotas = def.quotas.filter((x) => x !== q);
      removeChecksFor(def, q.id);
      for (const lf of def.listFills ?? []) if (lf.tracking?.quotaIds?.includes(q.id)) lf.tracking.quotaIds = lf.tracking.quotaIds.filter((x) => x !== q.id);
      if (refs.conditions.length) warnings.push(`${plural(refs.conditions.length, "condition")} read quota “${q.name}” (${refs.conditions.map((c) => c.where).slice(0, 3).join(", ")}) and will no longer resolve.`);
      return { description: `Quota “${q.name}” removed`, destructive: `Removes quota “${q.name}” (${plural(q.cells.length, "cell")})${refs.quotaChecks.length ? ` and its ${plural(refs.quotaChecks.length, "check")}` : ""}${refs.listFills.length ? `; ${plural(refs.listFills.length, "List Fill")} stop consulting it` : ""}`, warnings, touched: [] };
    }
    case "set_quota_check": {
      const quotas = a.quotas.map((r) => quotaOrFail(def, r));
      for (const q of quotas) removeChecksFor(def, q.id);
      const flow = def.flow as FlowNode[];
      let afterIndex: number | undefined;
      if (a.after) {
        if (/^end$/i.test(a.after)) afterIndex = endIndex(flow) - 1;
        else {
          const q = env.question(a.after);
          const block = listBlocks(flow).find((b) => b.id === a.after || (b.title ?? "").trim().toLowerCase() === a.after!.trim().toLowerCase());
          const target = q ? flow.findIndex((n) => containsQuestion(n, q.id)) : block ? flow.findIndex((n) => n === block.node || n.id === block.id || !!(n as { children?: FlowNode[] }).children?.includes(block.node)) : -1;
          if (target < 0) fail(`“${a.after}” is not a question or a block at the top level of the flow`);
          afterIndex = target;
        }
        const needed = checkPosition(def, quotas);
        if (needed > afterIndex!) warnings.push(`The check sits before a question the quota reads — it cannot decide anything there. Put it after the question, or leave “after” out and it is placed there.`);
      }
      const kind: QuotaOnFull = a.onFull ?? { kind: quotas[0].onFull.kind, ...(quotas[0].onFull.url ? { url: quotas[0].onFull.url } : {}) };
      const when = a.when === null || a.when === undefined ? undefined : env.condition(a.when);
      const id = placeCheck(def, quotas, kind, env.ids, when, afterIndex);
      const at = flow.findIndex((n) => n.id === id);
      const before = flow.slice(0, at).reverse().find((n) => n.type === "block" || n.type === "page") as { title?: string } | undefined;
      return { description: `Quota check for ${quotas.map((q) => `“${q.name}”`).join(", ")}${before?.title ? ` after “${before.title}”` : at === 0 ? " at the start" : ""}: ${kind.kind}${when ? ` when ${formatCondition(def, when)}` : ""}`, warnings, touched: [] };
    }
  }
}

export function describeQuotaAction(a: QuotaAction): string {
  switch (a.op) {
    case "create_quota": return `Create quota ${a.name}`;
    case "update_quota": return `Change quota ${a.quota}`;
    case "add_quota_cells": return `Add ${plural(a.cells.length, "cell")} to quota ${a.quota}`;
    case "remove_quota_cells": return `Remove ${plural(a.cells.length, "cell")} from quota ${a.quota}`;
    case "delete_quota": return `Remove quota ${a.quota}`;
    case "set_quota_check": return `Place the quota check for ${a.quotas.join(", ")}`;
  }
}

/* ------------------------------------------------------------ feasibility */

export interface QuotaFinding {
  severity: "critical" | "warning" | "suggestion";
  kind: "unchecked" | "check_before_question" | "uncovered" | "overlap" | "sum_over" | "sum_under" | "percent_under" | "no_total" | "unreachable_cell" | "cell_zero";
  quotaId: string;
  quotaName: string;
  message: string;
  suggestion?: string;
  cellIds?: string[];
  questionIds?: string[];
  /** a mechanical fix, when there is one */
  action?: QuotaAction;
}

type Probe = { questionId: string; label: string; value: unknown };

/** representative answers to a question for the coverage check: every option of a choice question; for a number, the band edges and the gaps between them */
function probesFor(def: SurveyDefinition, q: Question, quota: Quota): Probe[] {
  const choice = ["single_select", "dropdown", "image_select"].includes(q.type);
  if (choice) return (q.options ?? []).map((o) => ({ questionId: q.id, label: stripHtmlText(o.label), value: o.code }));
  if (["multi_select", "multi_dropdown"].includes(q.type)) return (q.options ?? []).map((o) => ({ questionId: q.id, label: stripHtmlText(o.label), value: [o.code] }));
  if (["numeric", "slider", "nps"].includes(q.type)) {
    const edges = new Set<number>();
    for (const c of quota.cells) {
      const walk = (x: Condition): void => { if (x.type === "group") { x.children.forEach(walk); return; } if (x.type !== "rule" || (x.source.kind !== "question" && x.source.kind !== "variable") || (x.source.ref !== q.id && x.source.ref !== q.variableName && x.source.ref !== String(q.code))) return; for (const v of [x.value, (x as { value2?: unknown }).value2]) if (typeof v === "number") { edges.add(v); edges.add(v - 1); edges.add(v + 1); } else if (Array.isArray(v)) for (const y of v) if (typeof y === "number") edges.add(y); };
      walk(c.when);
    }
    const s = q.settings as { minValue?: number; maxValue?: number };
    if (typeof s.minValue === "number") edges.add(s.minValue); if (typeof s.maxValue === "number") edges.add(s.maxValue);
    const vals = [...edges].filter((v) => (typeof s.minValue !== "number" || v >= s.minValue) && (typeof s.maxValue !== "number" || v <= s.maxValue)).sort((a, b) => a - b);
    return vals.map((v) => ({ questionId: q.id, label: String(v), value: v }));
  }
  return [];
}

/** which cells match each combination of answers to the questions the quota reads; null when the quota reads something that cannot be enumerated */
export function quotaCoverage(def: SurveyDefinition, quota: Quota): { combos: number; uncovered: string[]; overlaps: { combo: string; cells: string[] }[] } | null {
  const reads = [...quotaReads(def, quota)].map((id) => def.questions.find((q) => q.id === id)).filter((q): q is Question => !!q);
  if (!reads.length || reads.length > 4) return null;
  const probes = reads.map((q) => probesFor(def, q, quota));
  if (probes.some((p) => !p.length)) return null;
  const combos = probes.reduce((n, p) => n * p.length, 1);
  if (combos > 2000) return null;
  let rows: Probe[][] = [[]];
  for (const p of probes) rows = rows.flatMap((r) => p.map((x) => [...r, x]));
  const uncovered: string[] = []; const overlaps: { combo: string; cells: string[] }[] = [];
  for (const r of rows) {
    const state = createResponseState(def, { sessionId: "probe", seed: 1 });
    for (const p of r) state.answers[p.questionId] = p.value as never;
    const hit = quota.cells.filter((c) => evaluateCondition(c.when, { def, state }));
    const combo = r.map((p) => p.label).join(" × ");
    if (!hit.length) uncovered.push(combo);
    else if (hit.length > 1) overlaps.push({ combo, cells: hit.map((c) => c.label) });
  }
  return { combos: rows.length, uncovered, overlaps };
}

/** the feasibility review of every quota — complementary to lintStructure's shape checks (no cells, zero limits, percent over 100, duplicate conditions) */
export function reviewQuotas(def: SurveyDefinition): QuotaFinding[] {
  const out: QuotaFinding[] = [];
  const flow = def.flow as FlowNode[];
  for (const q of def.quotas) {
    const base = { quotaId: q.id, quotaName: q.name };
    const refs = quotaReferences(def, q.id);
    const reads = quotaReads(def, q);
    const stops = q.mode === "hard" && (q.onFull.kind === "terminate" || q.onFull.kind === "redirect");
    if (!refs.quotaChecks.length && !refs.listFills.length) out.push({ ...base, severity: stops ? "warning" : "suggestion", kind: "unchecked", message: `Quota “${q.name}” is counted but never checked — no quota check in the flow reads it, so a full cell stops nobody.`, suggestion: "Ask “check the quota after <the question it reads>”, or add a quota check in the flow.", action: { op: "set_quota_check", quotas: [q.id] } });
    const need = checkPosition(def, [q]);
    for (const c of refs.quotaChecks) {
      const at = flow.findIndex((n) => n.id === c.nodeId);
      if (at >= 0 && need >= 0 && at <= need) {
        const late = [...reads].filter((id) => { const top = flow.findIndex((n) => containsQuestion(n, id)); return top >= at; }).map((id) => def.questions.find((x) => x.id === id)?.code ?? id);
        out.push({ ...base, severity: "critical", kind: "check_before_question", message: `The check of quota “${q.name}” runs before ${late.join(", ")} ${late.length === 1 ? "is" : "are"} asked — its cells cannot match anyone there, so the quota never closes.`, suggestion: `Move the check after ${late[late.length - 1]}.`, questionIds: [...reads], action: { op: "set_quota_check", quotas: [q.id] } });
      }
    }
    if (q.cells.some((c) => c.limitType === "percent") && q.targetTotal === undefined) out.push({ ...base, severity: "critical", kind: "no_total", message: `Quota “${q.name}” has percent cells but no target total — a percent of nothing is zero, so those cells are full from the start.`, suggestion: "Set the quota's total (“the quota is 500 completes”)." });
    const counts = q.cells.filter((c) => c.limitType === "count"), pcts = q.cells.filter((c) => c.limitType === "percent");
    if (counts.length && q.targetTotal !== undefined && !pcts.length) {
      const sum = counts.reduce((s, c) => s + c.limit, 0);
      if (sum > q.targetTotal) out.push({ ...base, severity: "suggestion", kind: "sum_over", message: `The cells of “${q.name}” allow ${sum} completes together, ${sum - q.targetTotal} more than its total of ${q.targetTotal} — the total is reached before every cell is full.`, suggestion: `Fine for a flexible quota; for an exact split ask to “rescale the ${q.name} quota to ${q.targetTotal}”.`, action: { op: "update_quota", quota: q.id, total: q.targetTotal } });
      if (sum < q.targetTotal) out.push({ ...base, severity: "warning", kind: "sum_under", message: `The cells of “${q.name}” allow only ${sum} completes together, ${q.targetTotal - sum} short of its total of ${q.targetTotal} — the total cannot be reached once every cell is full.`, suggestion: `Ask to “rescale the ${q.name} quota to ${q.targetTotal}”, or raise the cells that are hardest to fill.`, action: { op: "update_quota", quota: q.id, total: q.targetTotal } });
    }
    if (pcts.length && !counts.length) {
      const sum = pcts.reduce((s, c) => s + c.limit, 0);
      if (sum < 99.5) out.push({ ...base, severity: "warning", kind: "percent_under", message: `The percent cells of “${q.name}” add up to ${sum}% — ${Math.round((100 - sum) * 10) / 10}% of the target is not allowed into any cell.`, suggestion: "Make the shares add up to 100, or add the missing group." });
    }
    for (const c of q.cells) if (c.limitType === "count" && c.limit === 0) out.push({ ...base, severity: "warning", kind: "cell_zero", message: `Cell “${c.label}” of quota “${q.name}” has a limit of 0 — it is unlimited, not closed (the engine treats 0 as no limit).`, suggestion: "Give it a limit, or remove the cell.", cellIds: [c.id] });
    const cov = quotaCoverage(def, q);
    if (cov) {
      if (cov.uncovered.length) out.push({ ...base, severity: q.mode === "hard" ? "warning" : "suggestion", kind: "uncovered", message: `${cov.uncovered.length} of ${cov.combos} answer combination${cov.combos === 1 ? "" : "s"} fall${cov.uncovered.length === 1 ? "s" : ""} outside every cell of “${q.name}” (${cov.uncovered.slice(0, 4).join("; ")}${cov.uncovered.length > 4 ? "; …" : ""}) — those respondents are never counted or stopped by it.`, suggestion: "Add a cell for them, or make the quota's question screen them out first.", questionIds: [...reads] });
      if (cov.overlaps.length) out.push({ ...base, severity: "suggestion", kind: "overlap", message: `${cov.overlaps.length} answer combination${cov.overlaps.length === 1 ? "" : "s"} of “${q.name}” match${cov.overlaps.length === 1 ? "es" : ""} more than one cell (${cov.overlaps.slice(0, 3).map((o) => `${o.combo}: ${o.cells.join(" + ")}`).join("; ")}${cov.overlaps.length > 3 ? "; …" : ""}) — one respondent counts in each of them, and is stopped when any is full.`, suggestion: "Intended for flat dimensions in one quota (gender cells and age cells side by side); for an exact split, interlock them into cross-cells or separate the dimensions into their own quotas.", questionIds: [...reads] });
    }
  }
  return out;
}

/* ------------------------------------------------------------ fieldwork advice */

export interface QuotaAdviceLine {
  severity: "critical" | "warning" | "suggestion" | "info";
  kind: "complete" | "full_while_open" | "under_pace" | "near_full" | "no_data" | "on_track";
  message: string;
  suggestion?: string;
  cellIds: string[];
  /** the adjustment, as a proposal */
  action?: QuotaAction;
}
export interface QuotaAdvice { quotaId: string; name: string; current: number; maximum: number | null; lines: QuotaAdviceLine[] }

const limitOf = (q: Quota, c: QuotaCell): number => (c.limitType === "percent" ? Math.floor((c.limit / 100) * (q.targetTotal ?? 0)) : c.limit);

/**
 * What the counts say, quota by quota: full cells while the rest is open
 * (those respondents are being turned away), cells filling well below their
 * share of what has come in so far (they will not fill at this pace, with
 * the projected shortfall), cells about to close — and the adjustment each
 * would take, as an `update_quota` the researcher previews and applies.
 */
export function quotaAdvice(def: SurveyDefinition, counts: QuotaCounts, opts: { nearFullPct?: number; minCompletes?: number } = {}): QuotaAdvice[] {
  const near = opts.nearFullPct ?? 90, min = opts.minCompletes ?? 30;
  return def.quotas.map((q) => {
    const rows = q.cells.map((c) => ({ c, limit: limitOf(q, c), count: counts[q.id]?.[c.id] ?? 0 }));
    const limited = rows.filter((r) => r.limit > 0);
    const maximum = limited.length ? limited.reduce((s, r) => s + r.limit, 0) : null;
    const current = rows.reduce((s, r) => s + r.count, 0);
    const lines: QuotaAdviceLine[] = [];
    const advice: QuotaAdvice = { quotaId: q.id, name: q.name, current, maximum, lines };
    if (!current) { lines.push({ severity: "info", kind: "no_data", message: `No completes counted yet for “${q.name}”.`, cellIds: [] }); return advice; }
    const full = limited.filter((r) => r.count >= r.limit), open = limited.filter((r) => r.count < r.limit);
    if (limited.length && !open.length) { lines.push({ severity: "info", kind: "complete", message: `Quota “${q.name}” is complete: every cell is full (${current}${maximum ? ` of ${maximum}` : ""}).`, cellIds: full.map((r) => r.c.id) }); return advice; }
    if (full.length && open.length) {
      const remaining = open.reduce((s, r) => s + r.limit - r.count, 0);
      lines.push({
        severity: q.mode === "hard" ? "warning" : "info", kind: "full_while_open",
        message: `${full.map((r) => `${r.c.label} (${r.count}/${r.limit})`).join(", ")} ${full.length === 1 ? "is" : "are"} full while ${plural(open.length, "cell")} still need${open.length === 1 ? "s" : ""} ${remaining} — ${q.mode === "hard" ? "respondents in the full cells are now screened out" : "respondents in the full cells are flagged"}.`,
        suggestion: q.mode === "hard" ? `If more of them are welcome, raise the full cells (or make the quota soft so they are counted, not stopped); otherwise redirect the sample towards ${open.slice(0, 3).map((r) => r.c.label).join(", ")}.` : undefined,
        cellIds: full.map((r) => r.c.id),
        action: { op: "update_quota", quota: q.id, cells: full.map((r) => ({ cell: r.c.id, limit: r.limit + Math.max(5, Math.ceil(r.limit * 0.1)) })) },
      });
    }
    if (current >= min && maximum) {
      // pace: a cell's share of what has come in, against its share of the maximum
      for (const r of open) {
        const expected = current * r.limit / maximum;
        const ratio = expected > 0 ? r.count / expected : 1;
        if (ratio < 0.5 && expected >= 3) {
          const projected = Math.round(r.count / current * maximum);
          lines.push({
            severity: "warning", kind: "under_pace",
            message: `${r.c.label} has ${r.count} of the ~${Math.round(expected)} expected at this point (${r.count}/${r.limit}); at this pace it reaches about ${projected} when the quota fills — ${r.limit - projected} short.`,
            suggestion: `Boost sample for this group, lower its limit to about ${Math.max(r.count, projected)}, or accept the shortfall and weight.`,
            cellIds: [r.c.id],
            action: { op: "update_quota", quota: q.id, cells: [{ cell: r.c.id, limit: Math.max(r.count, projected) }] },
          });
        }
      }
    }
    for (const r of open) if (r.count / r.limit * 100 >= near) lines.push({ severity: "info", kind: "near_full", message: `${r.c.label} is nearly full (${r.count}/${r.limit}).`, cellIds: [r.c.id] });
    if (!lines.length) lines.push({ severity: "info", kind: "on_track", message: `“${q.name}” is filling evenly: ${current}${maximum ? ` of ${maximum}` : ""} so far.`, cellIds: [] });
    return advice;
  });
}

/* ------------------------------------------------------------ diff */

/** Changes-panel lines for the quotas: added (by name), removed, changed, and the checks placed */
export function quotaDiff(before: SurveyDefinition, after: SurveyDefinition): string[] {
  const out: string[] = [];
  const b = new Map(before.quotas.map((q) => [q.id, q])), a = new Map(after.quotas.map((q) => [q.id, q]));
  const added = after.quotas.filter((q) => !b.has(q.id));
  if (added.length) out.push(`Add quota${added.length === 1 ? "" : "s"} ${added.map((x) => `“${x.name}”${x.cells.length > 1 ? ` (${x.cells.length} cells)` : ""}`).join(", ")}`);
  for (const q of before.quotas) if (!a.has(q.id)) out.push(`Remove quota “${q.name}”`);
  for (const q of after.quotas) {
    const p = b.get(q.id); if (!p) continue;
    const bits: string[] = [];
    if (p.name !== q.name) bits.push(`renamed from “${p.name}”`);
    if (p.mode !== q.mode) bits.push(q.mode);
    if ((p.targetTotal ?? null) !== (q.targetTotal ?? null)) bits.push(`total ${p.targetTotal ?? "—"} → ${q.targetTotal ?? "—"}`);
    if (p.onFull.kind !== q.onFull.kind || p.onFull.url !== q.onFull.url) bits.push(`when full: ${q.onFull.kind}`);
    const pc = new Map(p.cells.map((c) => [c.id, c]));
    const newCells = q.cells.filter((c) => !pc.has(c.id)), goneCells = p.cells.filter((c) => !q.cells.some((x) => x.id === c.id));
    const changedCells = q.cells.filter((c) => { const o = pc.get(c.id); return o && (o.limit !== c.limit || o.limitType !== c.limitType || o.label !== c.label); });
    if (newCells.length) bits.push(`${plural(newCells.length, "cell")} added`);
    if (goneCells.length) bits.push(`${plural(goneCells.length, "cell")} removed`);
    if (changedCells.length) bits.push(changedCells.length <= 4 ? changedCells.map((c) => `${c.label} ${pc.get(c.id)!.limit}${pc.get(c.id)!.limitType === "percent" ? "%" : ""} → ${c.limit}${c.limitType === "percent" ? "%" : ""}`).join(", ") : `${changedCells.length} limits changed`);
    if (bits.length) out.push(`Change quota “${q.name}”: ${bits.join("; ")}`);
  }
  const checks = (d: SurveyDefinition) => (d.flow as FlowNode[]).filter((n) => n.type === "quota_check").map((n) => `${n.id}:${(n as { quotaIds: string[] }).quotaIds.join(",")}`);
  const cb = new Set(checks(before)), ca = checks(after);
  const placed = ca.filter((x) => !cb.has(x));
  if (placed.length && !added.length) out.push(`Place ${plural(placed.length, "quota check")}`);
  return out;
}
