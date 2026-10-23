import {
  exactBalanceSlots, claimRequestFor, writeAssignment, designVersionVariable, MemoryBalanceStore,
  type BalanceClaimRequest, type ResponseState,
} from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";

/**
 * THE SERVER HALF OF EXACT BALANCE (engine item #15) — without Next.js or
 * Supabase in it, so `/api/session/balance` is a thin adapter and this is
 * tested with a fake store (`balanceClaim.test.ts`).
 *
 * The client says WHICH slots it needs (keys); the server decides WHAT each
 * slot is — its arms, how many, the basis, the hold — from the session's
 * pinned definition and the respondent's answers (`exactBalanceSlots`), so a
 * respondent cannot claim an arm that is not one, nor ask for a different
 * count. The store's answer is the truth.
 */

export interface BalanceStore {
  claim(r: BalanceClaimRequest): Promise<{ ok: true; arms: string[] } | { ok: false; error: string }>;
}

export interface BalanceAssignment { key: string; variable: string; arms: string[]; source: "claim" | "fallback"; reason?: string }

/** a database without migration 0073 (or the function missing from the schema cache) */
export const missingBalanceMigration = (e: string) => /rescript_claim_balance|balance_claims|balance_keys|does not exist|schema cache/i.test(e);

export async function claimBalances(
  def: SurveyDefinition,
  state: ResponseState,
  keys: readonly string[],
  scope: string,
  store: BalanceStore,
): Promise<{ assignments: BalanceAssignment[]; unknown: string[] }> {
  const wanted = new Set(keys);
  const out: BalanceAssignment[] = [];
  /*
   * What the client says it holds is not evidence: every slot is (re)claimed
   * from the store, which answers a session that already holds the slot with
   * the same arms — so a respondent cannot award themselves an arm by writing
   * the variable, and a genuine holder loses nothing.
   */
  const held = new Set<string>();
  for (const k of Object.keys(state.calculated)) if (isBalanceVariable(def, k)) { held.add(k); delete state.calculated[k]; }
  const done = new Set<string>();
  /*
   * Nested randomizers: an inner slot exists on the respondent's path only
   * once the outer one has chosen the child that holds it. So claim, write,
   * look again — outermost first — at most a few rounds.
   */
  for (let round = 0; round < 6; round++) {
    /* the slots asked for, and the ones the client said it held (re-read from the store: an outer randomizer decides whether an inner one is on the path) */
    const slots = exactBalanceSlots(def, state).filter((s) => (wanted.has(s.key) || held.has(s.variable)) && !done.has(s.key));
    if (!slots.length) break;
    for (const slot of slots) {
      done.add(slot.key);
      if (slot.assigned) { out.push({ key: slot.key, variable: slot.variable, arms: slot.assigned, source: "claim" }); continue; }
      const r = await store.claim(claimRequestFor(slot, scope, state.sessionId, state.seed));
      /* a session that already held the slot gets its arms back even if one is no longer eligible for it (Back + a change): the store is the truth */
      if (r.ok && r.arms.length) {
        writeAssignment(state, slot, r.arms);
        out.push({ key: slot.key, variable: slot.variable, arms: r.arms, source: "claim" });
      } else {
        /* never left unassigned: the seed-derived arm (the pre-#15 behaviour), said so */
        const reason = r.ok ? "the claim returned no usable arm" : r.error;
        writeAssignment(state, slot, slot.fallback);
        out.push({ key: slot.key, variable: slot.variable, arms: slot.fallback, source: "fallback", reason });
      }
    }
  }
  return { assignments: out.filter((a) => wanted.has(a.key) || held.has(a.variable)), unknown: [...wanted].filter((k) => !done.has(k)) };
}

/** a calculated variable that holds an exact-balance assignment (`RANDOMIZER_*`, or `<VAR>_VERSION` of an exact design question) */
export function isBalanceVariable(def: SurveyDefinition, name: string): boolean {
  if (name.startsWith("RANDOMIZER_")) return true;
  return def.questions.some((q) => !!(q.settings as { versionBalance?: { exact?: boolean } } | undefined)?.versionBalance?.exact && name === designVersionVariable(q));
}

/** the sandbox runtime (no database): one memory store per process — the same semantics as 0073 */
export function sandboxBalanceStore(): MemoryBalanceStore {
  const g = globalThis as unknown as { __rescriptBalance?: MemoryBalanceStore };
  return (g.__rescriptBalance ??= new MemoryBalanceStore());
}
