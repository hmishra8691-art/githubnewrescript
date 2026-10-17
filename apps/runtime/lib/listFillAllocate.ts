import {
  decideListFill, confirmListFill, allocationPayload, listFillVariables, applyListFillDestinations,
  needsAllocation, reconcileListFill, countsWithout, listFillCapBasis, listFillBalanceBasis, listFillStoredCodes,
  type ListFillCounts, type ListFillResult, type ResponseState, type QuotaCounts,
} from "@rescript/engine";
import type { ListFill, SurveyDefinition } from "@rescript/schema";

/**
 * THE SERVER HALF OF LIST FILL, without Next.js or Supabase in it — so the
 * route (`app/api/session/listfill/route.ts`) is a thin adapter and this can be
 * tested with a fake store (`listFillAllocate.test.ts`).
 *
 * Per list that is due:
 *   first allocation   decide → `rescript_allocate_listfill` (idempotent claim)
 *   stored + changed   `reconcileListFill` says which held items still qualify;
 *                      decide AROUND them (`retain`), with the dropped items'
 *                      claims taken off the counts → `rescript_reallocate_listfill`
 *                      gives back the dropped slots, keeps the rest, claims the
 *                      new positions (0061). Nothing changed = no call at all.
 * The database's answer is the truth (`confirmListFill`), and the in-memory
 * counters move with it, so a second list decided in the same request sees
 * the capacity the first one just took or gave back.
 */

export interface CounterRow { list_fill_id: string; option_code: string; allocated_count: number; completed_count: number }

export interface ListFillCounters {
  /** the number each list's CAP is judged on (allocated, or completed for countOnCompleteOnly) */
  counts: ListFillCounts;
  allocated: ListFillCounts;
  completed: ListFillCounts;
}

export function countersFromRows(def: SurveyDefinition, rows: CounterRow[]): ListFillCounters {
  const out: ListFillCounters = { counts: {}, allocated: {}, completed: {} };
  for (const r of rows) {
    const lf = def.listFills.find((x) => x.id === r.list_fill_id);
    for (const [map, n] of [[out.allocated, r.allocated_count], [out.completed, r.completed_count]] as const) {
      (map[r.list_fill_id] = map[r.list_fill_id] ?? {})[r.option_code] = Number(n) || 0;
    }
    (out.counts[r.list_fill_id] = out.counts[r.list_fill_id] ?? {})[r.option_code] =
      lf && listFillCapBasis(lf) === "completed" ? Number(r.completed_count) || 0 : Number(r.allocated_count) || 0;
  }
  return out;
}

export type ClaimResult = { ok: true; codes: string[] } | { ok: false; error: string };

/** The two database calls, injectable. The route binds them to Supabase RPCs. */
export interface ListFillStore {
  allocate(a: { listFillId: string; preference: { code: string; maximum?: number }[]; count: number; useCompleted: boolean }): Promise<ClaimResult>;
  /** `held` = what the respondent holds now (for a store that cannot re-allocate: answer that, unchanged) */
  reallocate(a: { listFillId: string; keep: string[]; held: string[]; preference: { code: string; maximum?: number }[]; count: number; useCompleted: boolean }): Promise<ClaimResult>;
}

export interface ListFillAllocation {
  listFillId: string;
  name: string;
  items: { code: string; label: string; position: number }[];
  variables: Record<string, string | number | boolean | null>;
  destinations: string[];
  /** what happened to a stored allocation: first, kept/dropped/added on a change */
  change?: { kept: string[]; dropped: string[]; added: string[]; reason: string };
  result: ListFillResult;
}

export async function allocateListFills(
  def: SurveyDefinition,
  state: ResponseState,
  lists: ListFill[],
  counters: ListFillCounters,
  quotaCounts: QuotaCounts,
  store: ListFillStore,
): Promise<{ ok: true; allocations: ListFillAllocation[] } | { ok: false; error: string; listFillId: string }> {
  const allocations: ListFillAllocation[] = [];
  const bump = (lf: ListFill, code: string, by: number) => {
    const lfId = lf.id;
    // a claim moves the allocated number; the cap number only when the cap is judged on it
    for (const map of listFillCapBasis(lf) === "allocated" ? [counters.counts, counters.allocated] : [counters.allocated]) {
      map[lfId] = map[lfId] ?? {};
      map[lfId][code] = Math.max(0, (map[lfId][code] ?? 0) + by);
    }
  };
  for (const lf of lists) {
    const key = `LISTFILL_${(lf.name ?? lf.id).toUpperCase()}`;
    const stored = state.calculated[`${key}_COUNT`] != null;
    const rec = stored ? reconcileListFill(def, lf, state, { counts: counters.counts }) : null;
    if (stored && !rec!.stale) continue; // the client thought it changed; the server's counters say nothing would
    const retain = rec?.keep ?? [];
    const dropped = rec?.drop ?? [];
    const sample = needsAllocation(lf);
    // the dropped items' slots are about to be given back: do not let them count against this decision
    const counts = sample ? countsWithout(counters.counts, lf.id, dropped) : counters.counts;
    const balanceSrc = listFillBalanceBasis(lf) === "completed" ? counters.completed : counters.allocated;
    const balanceCounts = sample ? countsWithout(balanceSrc, lf.id, listFillBalanceBasis(lf) === "completed" ? [] : dropped) : balanceSrc;
    const decided = decideListFill({ def, listFill: lf, state, counts, balanceCounts, quotaCounts, retain });

    let final = decided;
    if (sample) {
      let claim: ClaimResult | null = null;
      if (stored) {
        const keepNow = decided.items.filter((i) => retain.includes(i.code)).map((i) => i.code);
        claim = await store.reallocate({
          listFillId: lf.id, keep: keepNow, held: listFillStoredCodes(lf, state),
          preference: allocationPayload(lf, decided, keepNow),
          count: decided.trace.requestedCount,
          useCompleted: listFillCapBasis(lf) === "completed",
        });
      } else if (decided.preference.length) {
        claim = await store.allocate({
          listFillId: lf.id, preference: allocationPayload(lf, decided),
          count: decided.trace.requestedCount,
          useCompleted: listFillCapBasis(lf) === "completed",
        });
      }
      if (claim && !claim.ok) return { ok: false, error: claim.error, listFillId: lf.id };
      if (claim) {
        final = confirmListFill(lf, decided, claim.codes);
        const before = stored ? listFillStoredCodes(lf, state) : [];
        for (const c of before) if (!claim.codes.includes(c)) bump(lf, c, -1);
        for (const c of claim.codes) if (!before.includes(c)) bump(lf, c, +1);
      }
    }

    const variables = listFillVariables(lf, final);
    Object.assign(state.calculated, variables);
    const written = applyListFillDestinations(lf, final, state);
    const now = final.items.map((i) => i.code);
    const was = rec ? rec.keep.concat(rec.drop) : []; // computed before the variables above were replaced
    allocations.push({
      listFillId: lf.id, name: final.name, items: final.items, variables, destinations: written, result: final,
      ...(rec ? { change: { kept: now.filter((c) => was.includes(c)), dropped: was.filter((c) => !now.includes(c)), added: now.filter((c) => !was.includes(c)), reason: rec.reason } } : {}),
    });
  }
  return { ok: true, allocations };
}
