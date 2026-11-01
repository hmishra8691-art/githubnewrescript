import type { ExactBalance, FlowNode, Question, SurveyDefinition } from "@rescript/schema";
import type { LoopContext, ResponseState } from "./state.js";
import type { RuntimeStep } from "./flow.js";
import { loopKeySuffix } from "./state.js";
import { subSeed, seededShuffle } from "./random.js";
import { matchingCells } from "./quotas.js";
import { designFor, designVersionFor, designVersionVariable } from "./designVersion.js";
import { compileFlow } from "./flow.js";
import { weightedSample } from "./randomizerDesign.js";

/**
 * EXACT EVEN PRESENTATION (2026-10-22, engine item #15).
 *
 * Two features hand each respondent one of several ARMS: a flow randomizer with
 * "evenly present" (show N of its M children — blocks, pages / questions,
 * elements) and a design question's VERSION (MaxDiff, CBC, menu, CVA, ACBC).
 * Both used to derive the arm from the respondent's random seed, which is
 * balanced ON AVERAGE only: 1,000 respondents, show 1 of 4, spread 14–62.
 *
 * With `balance: { exact: true }` (randomizer) or `settings.versionBalance:
 * { exact: true }` (design question) the arm is CLAIMED instead — the same
 * idea as List Fill's least fill, but made exact: the claim is ONE atomic
 * operation per (survey, environment, slot) that counts, picks the
 * least-filled arm(s) and records the claim while holding a lock, so two
 * respondents arriving together can never both see the same count. That is
 * also why it cannot herd under bursts (least fill decided on a snapshot
 * could: 25 respondents on one snapshot → spread 17).
 *
 *   counted    `completed` (default): completes + active in-progress claims; an
 *              abandoned session's claim expires after `holdMinutes` and a
 *              screened-out / terminated one is released, so the FINAL
 *              completes balance. `started`: every claim ever made counts.
 *   tie-break  deterministic: `seeded` (a per-respondent order from the
 *              session seed — reproducible) or `sequential` (authored order).
 *   scope      per slot = per randomizer (per loop iteration inside a loop),
 *              nested randomizers each their own slot, or per design
 *              question; `byQuota` balances within the respondent's cell.
 *
 * WHERE THE CLAIM HAPPENS. Just in time: before the respondent is shown the
 * first page inside an unclaimed exact randomizer (or a page holding an
 * unclaimed exact design question), the Runner asks `/api/session/balance`
 * (live / test → `rescript_claim_balance`, migration 0073; sandbox → the
 * process memory store) or, in a preview, the tab's `MemoryBalanceStore`.
 * The answer is written into `state.calculated` (`RANDOMIZER_<ID>` = the
 * child ids shown, `<VAR>_VERSION` = the design version), so it is stable on
 * Back, resume and export, and every reader (flow, renderer, validation,
 * flatten, choice files) takes it from there. A claim that cannot be made
 * (network, a database without 0073) stores the seed-derived arm — the old
 * behaviour — and says so; it is never left to change mid-interview.
 *
 * Surveys without the setting are untouched: no slot, no call, no variable.
 */

export const BALANCE_HOLD_MINUTES_DEFAULT = 120;

export interface BalanceSlot {
  /**
   * `randomizer:<nodeId><@loop codes>` (children), `latin:<nodeId><@loop codes>` (S4c: the row of a Latin square /
   * Williams randomizer), `design:<questionId>` or `arm:<questionId><@loop codes>` (S4c: an experiment's arm), plus
   * `|cell:<cellId>` when balanced within a quota cell
   */
  key: string;
  kind: "randomizer" | "design" | "design_row" | "arm";
  nodeId: string;
  questionId?: string;
  /** the arms this respondent may get (children eligible for them, or the design's versions), authored order */
  arms: string[];
  /** how many arms one respondent gets (the randomizer's `show`; 1 for a design) */
  count: number;
  basis: "completed" | "started";
  tieBreak: "seeded" | "sequential";
  holdMinutes: number;
  /** where the assignment is stored in `state.calculated` (exported with the response) */
  variable: string;
  cell: string | null;
  /** what is stored already, or null when the slot still has to be claimed */
  assigned: string[] | null;
  /** the seed-derived arms (the pre-#15 behaviour), stored when a claim cannot be made */
  fallback: string[];
  /** S4c (RA-05): relative weight per arm, aligned with `arms` — absent when every arm weighs the same */
  weights?: number[];
}

export interface BalanceSettings { basis: "completed" | "started"; tieBreak: "seeded" | "sequential"; holdMinutes: number; byQuota: string | null }
export function balanceSettings(b: ExactBalance | null | undefined): BalanceSettings | null {
  if (!b?.exact) return null;
  return {
    basis: b.basis === "started" ? "started" : "completed",
    tieBreak: b.tieBreak === "sequential" ? "sequential" : "seeded",
    holdMinutes: Number.isFinite(b.holdMinutes) && (b.holdMinutes as number) >= 5 ? Math.min(10_080, Math.round(b.holdMinutes as number)) : BALANCE_HOLD_MINUTES_DEFAULT,
    byQuota: b.byQuota || null,
  };
}

const ident = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
/** the variable a randomizer's claimed children are stored under: `RANDOMIZER_<ID>` (+ `_<loop code>` inside a loop) */
export function randomizerVariable(nodeId: string, loop: LoopContext | null | undefined): string {
  const suffix = loopKeySuffix(loop ?? null);
  return `RANDOMIZER_${ident(nodeId)}${suffix ? suffix.split("@").filter(Boolean).map((c) => `_${ident(c)}`).join("") : ""}`;
}
export { designVersionVariable };

/**
 * The variable a stored claim's balance key is written under (D7, S0b: the save route compares the posted
 * assignment with the claim it stored). `randomizer:<nodeId>@loop@codes|cell:…` → `RANDOMIZER_<ID>_<CODES>`;
 * `design:<questionId>|cell:…` → `<VAR>_VERSION`. Null for a key this survey does not have.
 */
export function balanceVariableForKey(def: SurveyDefinition, key: string): string | null {
  const bare = String(key).split("|cell:")[0]!;
  if (bare.startsWith("latin:")) {
    const v = balanceVariableForKey(def, `randomizer:${bare.slice("latin:".length)}`);
    return v ? `${v}_ROW` : null;
  }
  if (bare.startsWith("arm:")) {
    const rest = bare.slice("arm:".length);
    const at = rest.indexOf("@");
    const q = def.questions.find((x) => x.id === (at >= 0 ? rest.slice(0, at) : rest));
    const codes = at >= 0 ? rest.slice(at).split("@").filter(Boolean) : [];
    return q ? `${armVariableBase(q)}${codes.map((c) => `_${ident(c)}`).join("")}_ARM` : null;
  }
  if (bare.startsWith("randomizer:")) {
    const rest = bare.slice("randomizer:".length);
    const at = rest.indexOf("@");
    const nodeId = at >= 0 ? rest.slice(0, at) : rest;
    const codes = at >= 0 ? rest.slice(at).split("@").filter(Boolean) : [];
    return `RANDOMIZER_${ident(nodeId)}${codes.map((c) => `_${ident(c)}`).join("")}`;
  }
  if (bare.startsWith("design:")) {
    const q = def.questions.find((x) => x.id === bare.slice("design:".length));
    return q ? designVersionVariable(q) : null;
  }
  return null;
}

/** the respondent's cell of the balancing quota, or null (no quota set, no cell matched yet — the whole sample then) */
export function balanceCell(def: SurveyDefinition, state: ResponseState, quotaId: string | null): string | null {
  if (!quotaId) return null;
  const quota = (def.quotas ?? []).find((q) => q.id === quotaId);
  if (!quota) return null;
  try { return matchingCells(def, state as never, quota)[0] ?? null; } catch { return null; }
}

/** the stored assignment of a slot, if any — only arms that are still real arms */
export function readAssignment(state: Pick<ResponseState, "calculated">, variable: string, arms?: readonly string[]): string[] | null {
  const raw = state.calculated?.[variable];
  if (raw == null || raw === "") return null;
  const list = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return null;
  return arms ? list.filter((a) => arms.includes(a)) : list;
}

/** write a claimed (or fallback) assignment into the response */
export function writeAssignment(state: Pick<ResponseState, "calculated">, slot: Pick<BalanceSlot, "variable" | "kind">, arms: readonly string[]): void {
  state.calculated[slot.variable] = arms.join(",");
}

/**
 * The tie-break order: the arms as the claim should prefer them when their
 * counts are equal. Deterministic — the same respondent and slot always give
 * the same order, so a retried claim asks for the same thing.
 */
export function tiePreference(arms: readonly string[], tieBreak: "seeded" | "sequential", seed: number, key: string): string[] {
  const uniq = [...new Set(arms)];
  if (tieBreak === "sequential") return uniq;
  return uniq
    .map((a, i) => ({ a, i, h: subSeed(seed >>> 0, `tie:${key}:${a}`) }))
    .sort((x, y) => x.h - y.h || x.i - y.i)
    .map((x) => x.a);
}

/**
 * THE PICK: the `count` least-filled arms, ties in preference order (exactly what the SQL does).
 *
 * S4c (RA-05) WEIGHTED: with `weights` (aligned with `preference`) the arm furthest below its target share
 * (weight / total) goes first — ordered by (count + ½) / weight, Sainte-Laguë's divisor, which keeps every arm
 * within about one claim of its target at any sample size. Equal weights order by count alone: the unweighted rule.
 */
export function pickLeastFilled(counts: Readonly<Record<string, number>>, preference: readonly string[], count: number, weights?: readonly number[] | null): string[] {
  const n = Math.max(1, Math.min(preference.length, Math.floor(count) || 1));
  const w = (i: number) => { const x = weights?.[i]; return x != null && Number.isFinite(x) && x > 0 ? x : 1; };
  return preference
    .map((a, i) => ({ a, i, c: weights ? ((counts[a] ?? 0) + 0.5) / w(i) : counts[a] ?? 0 }))
    .sort((x, y) => x.c - y.c || x.i - y.i)
    .slice(0, n)
    .map((x) => x.a);
}

/** does any part of this survey ask for exact balance? (cheap: settings only) */
export function hasExactBalance(def: SurveyDefinition): boolean {
  const walk = (nodes: readonly FlowNode[]): boolean => nodes.some((n) => {
    if (n.type === "randomizer" && n.balance?.exact) return true;
    const kids = (n as { children?: FlowNode[] }).children;
    if (kids && walk(kids)) return true;
    if (n.type === "branch") return n.branches.some((b) => walk(b.children)) || (n.otherwise ? walk(n.otherwise) : false);
    return false;
  });
  return walk(def.flow ?? []) || (def.questions ?? []).some((q) => (!!(q.settings as { versionBalance?: ExactBalance } | undefined)?.versionBalance?.exact && !!q.settings?.designRef)
    || (q.type === "experiment" && !!(q.settings as { armBalance?: ExactBalance } | undefined)?.armBalance?.exact));
}

/** the slot of a design question with exact version balance, or null */
export function designSlot(def: SurveyDefinition, state: ResponseState, q: Question): BalanceSlot | null {
  const cfg = balanceSettings((q.settings as { versionBalance?: ExactBalance } | undefined)?.versionBalance);
  if (!cfg) return null;
  const design = designFor(def, q);
  if (!design) return null;
  const versions = [...new Set(design.rows.map((r) => String(r.version ?? "1")))].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  if (versions.length <= 1) return null;
  const cell = balanceCell(def, state, cfg.byQuota);
  const variable = designVersionVariable(q);
  const seedNum = Number(state.seed);
  return {
    key: `design:${q.id}${cell ? `|cell:${cell}` : ""}`, kind: "design", nodeId: q.id, questionId: q.id,
    arms: versions, count: 1, basis: cfg.basis, tieBreak: cfg.tieBreak, holdMinutes: cfg.holdMinutes,
    variable, cell, assigned: readAssignment(state, variable, versions),
    fallback: Number.isFinite(seedNum) ? [designVersionFor(q, design.rows, seedNum)] : [versions[0]],
  };
}

/** the slot of an exact randomizer as the flow walks it (eligible children already known) */
export function randomizerSlot(def: SurveyDefinition, state: ResponseState, node: Extract<FlowNode, { type: "randomizer" }>, eligibleIds: readonly string[], loop: LoopContext | null, fallback: readonly string[], weights?: readonly number[] | null): BalanceSlot | null {
  const cfg = balanceSettings(node.balance);
  if (!cfg) return null;
  const show = node.show ?? eligibleIds.length;
  if (!(show < eligibleIds.length) || eligibleIds.length < 2) return null;
  const cell = balanceCell(def, state, cfg.byQuota);
  const variable = randomizerVariable(node.id, loop);
  const assigned = readAssignment(state, variable, node.children.map((c) => c.id));
  return {
    key: `randomizer:${node.id}${loopKeySuffix(loop)}${cell ? `|cell:${cell}` : ""}`, kind: "randomizer", nodeId: node.id,
    arms: [...eligibleIds], count: show, basis: cfg.basis, tieBreak: cfg.tieBreak, holdMinutes: cfg.holdMinutes,
    variable, cell, assigned: assigned && assigned.length ? assigned : null, fallback: [...fallback],
    ...(weights && weights.length === eligibleIds.length ? { weights: [...weights] } : {}),
  };
}

/**
 * S4c (RA-06): the slot of a Latin square / Williams randomizer with exact balance — the arms are the design's
 * ROWS ("1" … "K"), one per respondent, stored in `RANDOMIZER_<ID>[_<loop codes>]_ROW`.
 */
export function designRowSlot(def: SurveyDefinition, state: ResponseState, node: Extract<FlowNode, { type: "randomizer" }>, rows: number, loop: LoopContext | null, fallbackRow: number): BalanceSlot | null {
  const cfg = balanceSettings(node.balance);
  if (!cfg || rows < 2) return null;
  const cell = balanceCell(def, state, cfg.byQuota);
  const variable = `${randomizerVariable(node.id, loop)}_ROW`;
  const arms = Array.from({ length: rows }, (_, i) => String(i + 1));
  const assigned = readAssignment(state, variable, arms);
  return {
    key: `latin:${node.id}${loopKeySuffix(loop)}${cell ? `|cell:${cell}` : ""}`, kind: "design_row", nodeId: node.id,
    arms, count: 1, basis: cfg.basis, tieBreak: cfg.tieBreak, holdMinutes: cfg.holdMinutes,
    variable, cell, assigned: assigned && assigned.length ? assigned.slice(0, 1) : null, fallback: [String(fallbackRow)],
  };
}

/** S4c (RA-08): the base of an experiment question's arm variable (`<VAR>`; `_ARM` is appended) */
export function armVariableBase(q: Pick<Question, "id"> & { variableName?: string }): string {
  return String(q.variableName || q.id);
}

/** every exact-balance slot on the respondent's current path, with what is assigned — the flow decides which are on it */
export function exactBalanceSlots(def: SurveyDefinition, state: ResponseState, quotaCounts?: Parameters<typeof compileFlow>[2]): BalanceSlot[] {
  if (!hasExactBalance(def)) return [];
  const slots = new Map<string, BalanceSlot>();
  compileFlow(def, state, quotaCounts, { onBalance: (s) => { if (!slots.has(s.key)) slots.set(s.key, s); } });
  return [...slots.values()];
}

/**
 * The slots that must be claimed BEFORE this page is shown: the exact
 * randomizers it sits inside and the exact design questions on it, not
 * claimed yet. Outer randomizers come first (a nested one is only reached once
 * the outer one has chosen it).
 */
export function balanceSlotsDue(def: SurveyDefinition, state: ResponseState, step: RuntimeStep | null | undefined, quotaCounts?: Parameters<typeof compileFlow>[2]): BalanceSlot[] {
  if (!step || step.kind !== "page" || !step.balance?.length) return [];
  const all = exactBalanceSlots(def, state, quotaCounts);
  return step.balance
    .map((k) => all.find((s) => s.key === k))
    .filter((s): s is BalanceSlot => !!s && !s.assigned);
}

/* ------------------------------------------------------------ the in-memory claim */

export type ClaimStatus = "active" | "completed" | "released" | "expired";
export interface BalanceClaimRequest {
  /** S4c: relative weights aligned with `preference` (absent: every arm weighs the same) */
  weights?: readonly number[];
  /** survey + environment: test claims never count against live ones */
  scope: string;
  key: string;
  session: string;
  /** the arms in tie-break preference order (`tiePreference`) */
  preference: readonly string[];
  count: number;
  basis: "completed" | "started";
  holdMinutes: number;
}
interface Claim { session: string; arms: string[]; status: ClaimStatus; expiresAt: number; at: number }

/**
 * THE SAME CLAIM AS `rescript_claim_balance` (0073), IN MEMORY — for the
 * Studio/runtime sandbox (no database) and the preview. Every method is
 * synchronous, so in a single JavaScript thread each claim is atomic exactly
 * as the SQL one is under its row lock: count → pick → record with nothing in
 * between. Same rules: an existing claim of the session is returned (and
 * re-activated if it had expired or been released); expired in-progress
 * claims stop counting; `completed` counts active + completed, `started`
 * counts every claim.
 */
export class MemoryBalanceStore {
  private claims = new Map<string, Map<string, Claim>>();
  constructor(private now: () => number = () => Date.now()) {}
  private slot(scope: string, key: string): Map<string, Claim> {
    const k = `${scope}\u0000${key}`;
    let m = this.claims.get(k);
    if (!m) { m = new Map(); this.claims.set(k, m); }
    return m;
  }
  claim(r: BalanceClaimRequest): string[] {
    const m = this.slot(r.scope, r.key);
    const t = this.now();
    const hold = Math.max(5, r.holdMinutes) * 60_000;
    const mine = m.get(r.session);
    if (mine) {
      if (mine.status !== "completed") { mine.status = "active"; mine.expiresAt = t + hold; }
      return [...mine.arms];
    }
    for (const c of m.values()) if (c.status === "active" && c.expiresAt < t) c.status = "expired";
    const counts: Record<string, number> = {};
    for (const c of m.values()) {
      if (r.basis !== "started" && c.status !== "active" && c.status !== "completed") continue;
      for (const a of c.arms) counts[a] = (counts[a] ?? 0) + 1;
    }
    const pref = [...new Set(r.preference)];
    const arms = pickLeastFilled(counts, pref, r.count, r.weights ? pref.map((a) => r.weights![r.preference.indexOf(a)] ?? 1) : null);
    m.set(r.session, { session: r.session, arms, status: "active", expiresAt: t + hold, at: t });
    return [...arms];
  }
  /** a completed interview: its claims stay counted for good */
  complete(scope: string, session: string): number {
    let n = 0;
    for (const [k, m] of this.claims) if (k.startsWith(`${scope}\u0000`)) { const c = m.get(session); if (c && (c.status === "active" || c.status === "expired")) { c.status = "completed"; n++; } }
    return n;
  }
  /** screened out, terminated, quota-full, deleted: its claims are given back */
  release(scope: string, session: string): number {
    let n = 0;
    for (const [k, m] of this.claims) if (k.startsWith(`${scope}\u0000`)) { const c = m.get(session); if (c && (c.status === "active" || c.status === "expired")) { c.status = "released"; n++; } }
    return n;
  }
  /** counts per arm of one slot, by status — what a dashboard or a test reads */
  counts(scope: string, key: string): Record<string, { active: number; completed: number; released: number; expired: number }> {
    const out: Record<string, { active: number; completed: number; released: number; expired: number }> = {};
    const t = this.now();
    for (const c of this.slot(scope, key).values()) {
      const st: ClaimStatus = c.status === "active" && c.expiresAt < t ? "expired" : c.status;
      for (const a of c.arms) { const o = (out[a] = out[a] ?? { active: 0, completed: 0, released: 0, expired: 0 }); o[st]++; }
    }
    return out;
  }
  /** serialisable, so a preview can keep its counters in the tab (sessionStorage) */
  toJSON(): Record<string, Claim[]> { return Object.fromEntries([...this.claims].map(([k, m]) => [k, [...m.values()]])); }
  static from(data: unknown, now?: () => number): MemoryBalanceStore {
    const s = new MemoryBalanceStore(now);
    if (data && typeof data === "object") for (const [k, list] of Object.entries(data as Record<string, Claim[]>)) {
      if (!Array.isArray(list)) continue;
      const m = new Map<string, Claim>();
      for (const c of list) if (c && typeof c.session === "string" && Array.isArray(c.arms)) m.set(c.session, { session: c.session, arms: c.arms.map(String), status: (["active", "completed", "released", "expired"] as const).includes(c.status) ? c.status : "active", expiresAt: Number(c.expiresAt) || 0, at: Number(c.at) || 0 });
      s.claims.set(k, m);
    }
    return s;
  }
}

/** the request a slot makes of a store, for this respondent */
export function claimRequestFor(slot: BalanceSlot, scope: string, session: string, seed: number): BalanceClaimRequest {
  const preference = tiePreference(slot.arms, slot.tieBreak, Number(seed) || 0, slot.key);
  const weights = slot.weights && slot.weights.length === slot.arms.length ? preference.map((a) => slot.weights![slot.arms.indexOf(a)] ?? 1) : null;
  return { scope, key: slot.key, session, preference, count: slot.count, basis: slot.basis, holdMinutes: slot.holdMinutes, ...(weights ? { weights } : {}) };
}

/** the window of children a seed-derived randomizer would show (the pre-#15 behaviour; also the claim's fallback) */
export function seedWindow<T>(eligible: readonly T[], show: number, seed: number, nodeKey: string, even: boolean, weights?: readonly number[] | null): T[] {
  /* S4c: weighted children are drawn in proportion to their weights (the rotation cannot honour weights) */
  if (weights && weights.length === eligible.length) return weightedSample(eligible, weights, show, subSeed(seed, `weighted:${nodeKey}`));
  if (even) {
    const offset = Math.abs(subSeed(seed, `even:${nodeKey}`)) % eligible.length;
    return Array.from({ length: show }, (_, i) => eligible[(offset + i) % eligible.length]);
  }
  return seededShuffle([...eligible], subSeed(seed, `flow:${nodeKey}`)).slice(0, show);
}

/* ------------------------------------------------------------ S4c item 4: experiment arms (RA-08) */

type ArmDef = { code: string | number; weight?: number };
const armsOf = (q: Question): ArmDef[] => ((q.settings as { arms?: ArmDef[] } | undefined)?.arms ?? []).filter((a) => a && a.code != null && String(a.code) !== "");
const armWeight = (a: ArmDef) => { const n = a.weight == null ? 1 : Number(a.weight); return Number.isFinite(n) && n > 0 ? n : 0; };

/** `<VAR>[_<loop codes>]_ARM` — where an experiment's claimed arm is stored */
export function experimentArmVariable(q: Pick<Question, "id"> & { variableName?: string }, loop?: LoopContext | null): string {
  const suffix = loopKeySuffix(loop ?? null);
  return `${armVariableBase(q)}${suffix ? suffix.split("@").filter(Boolean).map((c) => `_${ident(c)}`).join("") : ""}_ARM`;
}

/**
 * The seed-derived arm — EXACTLY the renderer's draw (`pickArm(arms, rng(seedFor(p, "arm"))())`: FNV-1a of
 * `<seed>:<question id>:arm`, mulberry32, weighted pick), so a survey that turns exact balance on keeps the same
 * fallback, and one without it is untouched.
 */
export function seededExperimentArm(q: Question, seed: number | string | undefined): string | null {
  const arms = armsOf(q);
  if (!arms.length) return null;
  const s = `${seed ?? ""}:${q.id}:arm`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const rand = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  let total = arms.reduce((n, x) => n + armWeight(x), 0);
  const w = total > 0 ? armWeight : () => 1;
  if (total <= 0) total = arms.length;
  let r = Math.min(Math.max(rand, 0), 0.999999999) * total;
  for (const x of arms) { r -= w(x); if (r < 0) return String(x.code); }
  return String(arms[arms.length - 1]!.code);
}

/**
 * The slot of an experiment question with `settings.armBalance.exact`: its arms (codes), WEIGHTED by the arms'
 * weights, one per respondent, claimed by the Runner before the page is shown (never in a renderer effect) and
 * stored in `<VAR>_ARM`; the question's answer is that arm.
 */
export function experimentArmSlot(def: SurveyDefinition, state: ResponseState, q: Question, loop: LoopContext | null = null): BalanceSlot | null {
  if (q.type !== "experiment") return null;
  const cfg = balanceSettings((q.settings as { armBalance?: ExactBalance } | undefined)?.armBalance);
  if (!cfg) return null;
  const all = armsOf(q);
  /* a weight of 0 parks an arm (the editor's rule): it is never claimed — unless no arm has a positive weight */
  const arms = all.some((a) => armWeight(a) > 0) ? all.filter((a) => armWeight(a) > 0) : all;
  const codes = [...new Set(arms.map((a) => String(a.code)))];
  if (codes.length < 2) return null;
  const cell = balanceCell(def, state, cfg.byQuota);
  const variable = experimentArmVariable(q, loop);
  const ws = codes.map((c) => armWeight(arms.find((a) => String(a.code) === c)!) || 1);
  const assigned = readAssignment(state, variable, codes);
  return {
    key: `arm:${q.id}${loopKeySuffix(loop)}${cell ? `|cell:${cell}` : ""}`, kind: "arm", nodeId: q.id, questionId: q.id,
    arms: codes, count: 1, basis: cfg.basis, tieBreak: cfg.tieBreak, holdMinutes: cfg.holdMinutes,
    variable, cell, assigned: assigned && assigned.length ? assigned.slice(0, 1) : null,
    fallback: [seededExperimentArm(q, state.seed) ?? codes[0]!],
    ...(ws.every((x) => x === ws[0]) ? {} : { weights: ws }),
  };
}

/** the claimed arm of an experiment question, if its arm is balanced and claimed — what the renderer shows */
export function claimedExperimentArm(state: Pick<ResponseState, "calculated">, q: Question, loop?: LoopContext | null): string | null {
  if (!(q.settings as { armBalance?: ExactBalance } | undefined)?.armBalance?.exact) return null;
  const v = readAssignment(state, experimentArmVariable(q, loop), armsOf(q).map((a) => String(a.code)));
  return v?.[0] ?? null;
}

/**
 * The Runner, at page entry, after the claims: each exact experiment on the page whose arm is claimed gets that arm
 * as its answer (the answer IS the arm) — so the arm never depends on a renderer effect. Returns the questions set.
 */
export function applyClaimedArms(def: SurveyDefinition, state: ResponseState, step: RuntimeStep | null | undefined): string[] {
  if (!step || step.kind !== "page") return [];
  const out: string[] = [];
  for (const qid of step.questionIds) {
    const q = def.questions.find((x) => x.id === qid);
    if (!q || q.type !== "experiment") continue;
    const arm = claimedExperimentArm(state, q, step.loop ?? null);
    if (!arm) continue;
    const key = `${q.id}${loopKeySuffix(step.loop ?? null)}`;
    if (String(state.answers[key] ?? "") === arm) continue;
    state.answers[key] = arm;
    out.push(q.id);
  }
  return out;
}
