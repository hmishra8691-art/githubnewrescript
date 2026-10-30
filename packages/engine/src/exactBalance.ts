import type { ExactBalance, FlowNode, Question, SurveyDefinition } from "@rescript/schema";
import type { LoopContext, ResponseState } from "./state.js";
import type { RuntimeStep } from "./flow.js";
import { loopKeySuffix } from "./state.js";
import { subSeed, seededShuffle } from "./random.js";
import { matchingCells } from "./quotas.js";
import { designFor, designVersionFor, designVersionVariable } from "./designVersion.js";
import { compileFlow } from "./flow.js";

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
  /** `randomizer:<nodeId><@loop codes>` or `design:<questionId>`, plus `|cell:<cellId>` when balanced within a quota cell */
  key: string;
  kind: "randomizer" | "design";
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

/** THE PICK: the `count` least-filled arms, ties in preference order (exactly what the SQL does) */
export function pickLeastFilled(counts: Readonly<Record<string, number>>, preference: readonly string[], count: number): string[] {
  const n = Math.max(1, Math.min(preference.length, Math.floor(count) || 1));
  return preference
    .map((a, i) => ({ a, i, c: counts[a] ?? 0 }))
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
  return walk(def.flow ?? []) || (def.questions ?? []).some((q) => !!(q.settings as { versionBalance?: ExactBalance } | undefined)?.versionBalance?.exact && !!q.settings?.designRef);
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
export function randomizerSlot(def: SurveyDefinition, state: ResponseState, node: Extract<FlowNode, { type: "randomizer" }>, eligibleIds: readonly string[], loop: LoopContext | null, fallback: readonly string[]): BalanceSlot | null {
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
  };
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
    const arms = pickLeastFilled(counts, [...new Set(r.preference)], r.count);
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
  return { scope, key: slot.key, session, preference: tiePreference(slot.arms, slot.tieBreak, Number(seed) || 0, slot.key), count: slot.count, basis: slot.basis, holdMinutes: slot.holdMinutes };
}

/** the window of children a seed-derived randomizer would show (the pre-#15 behaviour; also the claim's fallback) */
export function seedWindow<T>(eligible: readonly T[], show: number, seed: number, nodeKey: string, even: boolean): T[] {
  if (even) {
    const offset = Math.abs(subSeed(seed, `even:${nodeKey}`)) % eligible.length;
    return Array.from({ length: show }, (_, i) => eligible[(offset + i) % eligible.length]);
  }
  return seededShuffle([...eligible], subSeed(seed, `flow:${nodeKey}`)).slice(0, show);
}
