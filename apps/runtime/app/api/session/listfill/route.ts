import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadQuotaCounts } from "@/lib/session";
import { pendingListFills, type ResponseState } from "@rescript/engine";
import { allocateListFills, countersFromRows, type CounterRow, type ListFillStore } from "@/lib/listFillAllocate";
import { resolveRunDefinition } from "@rescript/quality/server";

export const dynamic = "force-dynamic";

/**
 * List Fill allocation.
 *
 * The whole decision happens HERE, on the server, and nowhere else:
 *
 *   1  the definition is the one this session is pinned to (§37) — a survey
 *      running in the field allocates with the configuration its deployed
 *      version carries, whatever the builder has since changed
 *   2  the sample-level counters and the quota counters are read for THIS
 *      environment, so a test link can never consume live capacity
 *   3  the pure engine decides an ordered preference and a trace (§38 — the
 *      same function the builder's simulator runs)
 *   4  `rescript_allocate_listfill` claims a slot atomically and says which
 *      option was actually won (§27); if the preferred one filled up in
 *      between, the confirmed answer is the next one down
 *   5  the confirmed items become LISTFILL_* variables and destination
 *      answers, which is all the rest of the platform ever sees
 *   6  a list that ALREADY allocated and whose answers changed (Back + a new
 *      answer) is reconciled: still-valid items are kept, the slots of the
 *      ones that no longer qualify are given back and the free positions are
 *      claimed again — `rescript_reallocate_listfill` (0061). The logic lives
 *      in `lib/listFillAllocate.ts` (tested with a fake store).
 *
 * The client is told the result, never asked for it. A respondent editing
 * their own JavaScript cannot award themselves a full option, because the
 * cap is enforced by the database inside the claim.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { sessionId, answers, calculated, embedded, flags, listFillIds } = body ?? {};
  if (typeof sessionId !== "string" || sessionId.length < 16)
    return NextResponse.json({ error: "invalid session" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: existing } = await db
    .from("responses")
    .select("id, survey_id, version_id, status, is_test, seed, deleted_at")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "unknown session" }, { status: 404 });
  if (existing.deleted_at) return NextResponse.json({ error: "this response was deleted by the survey owner" }, { status: 410 });
  if (existing.status !== "in_progress")
    return NextResponse.json({ error: "this session is already finalised" }, { status: 409 });

  const run = await resolveRunDefinition(db, existing as never, body?.build);
  const def = run.def;
  if (!def) return NextResponse.json({ error: "the survey definition for this session could not be read" }, { status: 500 });
  if (!def.listFills.length) return NextResponse.json({ ok: true, allocations: [] });

  const isTest = !!existing.is_test;

  // the state the decision is made against — the client's answers, but the
  // SERVER's definition, counters and randomisation seed
  const state = {
    surveyId: def.meta.id,
    surveyVersion: def.meta.version,
    sessionId,
    seed: Number(existing.seed ?? 0) || 0,
    startedAt: "",
    status: "in_progress",
    answers: answers ?? {},
    embedded: embedded ?? {},
    calculated: calculated ?? {},
    flags: Array.isArray(flags) ? [...flags] : [],
    stepIndex: 0,
  } as unknown as ResponseState;

  // counters for this environment only — read first: whether a stored list is
  // stale can depend on them (a short list with nothing left to top up is not)
  const { data: countRows, error: countErr } = await db
    .from("listfill_counts")
    .select("list_fill_id, option_code, allocated_count, completed_count")
    .eq("survey_id", existing.survey_id)
    .eq("is_test", isTest);
  if (countErr && !/does not exist|relation/.test(countErr.message)) {
    console.error("[rescript:listfill] counters unreadable", { sessionId: sessionId.slice(0, 8), error: countErr.message });
  }
  const counters = countersFromRows(def, (countRows ?? []) as CounterRow[]);

  // which lists to run: the ones the client says are due, narrowed to the
  // ones the definition agrees are actually ready. A client asking for a list
  // whose source is empty, whose condition fails, or which has already
  // allocated and not changed gets nothing — the server decides readiness too.
  // the rebuilt state has stepIndex 0 and cannot tell the source page was passed; the client only asks after it was
  const ready = pendingListFills(def, state, { assumeSourcesSettled: true, counts: counters.counts });
  const requested = Array.isArray(listFillIds) && listFillIds.length
    ? ready.filter((lf) => listFillIds.includes(lf.id))
    : ready;
  if (!requested.length) return NextResponse.json({ ok: true, allocations: [] });

  const quotaCounts = await loadQuotaCounts(existing.survey_id, isTest);

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(fn, {
      p_survey: existing.survey_id, p_test: isTest, p_session: sessionId, p_version: run.versionId ?? null, ...args,
    });
    if (error) return { ok: false as const, error: error.message };
    const codes = ((data ?? []) as { slot_no: number; option_code: string }[])
      .slice().sort((a, b) => a.slot_no - b.slot_no).map((r) => String(r.option_code));
    return { ok: true as const, codes };
  };
  const store: ListFillStore = {
    allocate: (a) => rpc("rescript_allocate_listfill", {
      p_list_fill: a.listFillId, p_preference: a.preference, p_count: a.count, p_use_completed: a.useCompleted,
    }),
    reallocate: async (a) => {
      const r = await rpc("rescript_reallocate_listfill", {
        p_list_fill: a.listFillId, p_keep: a.keep, p_preference: a.preference, p_count: a.count, p_use_completed: a.useCompleted,
      });
      // a database without migration 0061 cannot re-allocate: the respondent keeps
      // what they hold (the pre-0061 behaviour) rather than the page failing
      if (!r.ok && /rescript_reallocate_listfill|does not exist|schema cache/i.test(r.error)) {
        console.warn("[rescript:listfill] re-allocation needs migration 0061 — keeping the stored allocation", { listFill: a.listFillId });
        return { ok: true as const, codes: a.held };
      }
      return r;
    },
  };

  const out = await allocateListFills(def, state, requested, counters, quotaCounts, store);
  if (!out.ok) {
    // The claim is the only thing that may hand out a capped slot, so a
    // failure here must NOT fall back to the optimistic decision — that is
    // exactly how two respondents end up sharing the last slot.
    console.error("[rescript:listfill] allocation failed", JSON.stringify({
      sessionId: sessionId.slice(0, 8), listFill: out.listFillId, error: out.error,
    }));
    return NextResponse.json({ error: "the allocation could not be recorded", listFillId: out.listFillId }, { status: 503 });
  }

  const allocations = out.allocations.map((a) => {
    console.info("[rescript:listfill] allocated", JSON.stringify({
      surveyId: existing.survey_id, sessionId: sessionId.slice(0, 8), environment: isTest ? "TEST" : "LIVE",
      listFill: a.listFillId, requested: a.result.trace.requestedCount, items: a.items.map((i) => i.code),
      preference: a.result.preference, change: a.change, version: run.versionId, source: run.source,
    }));
    return {
      listFillId: a.listFillId,
      name: a.name,
      items: a.items,
      variables: a.variables,
      destinations: a.destinations,
      change: a.change,
      // the trace travels in test and preview only: it names every option and
      // its capacity, which is not a respondent's business
      trace: isTest ? a.result.trace : undefined,
    };
  });

  return NextResponse.json({ ok: true, allocations, environment: isTest ? "TEST" : "LIVE" });
}
