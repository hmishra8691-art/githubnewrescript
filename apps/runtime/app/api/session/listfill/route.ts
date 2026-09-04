import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadQuotaCounts } from "@/lib/session";
import {
  decideListFill, confirmListFill, allocationPayload, listFillVariables,
  pendingListFills, applyListFillDestinations, needsAllocation,
  type ListFillCounts, type ResponseState,
} from "@rescript/engine";
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

  // which lists to run: the ones the client says are due, narrowed to the
  // ones the definition agrees are actually ready. A client asking for a list
  // whose source is empty, whose condition fails, or which has already
  // allocated gets nothing — the server decides readiness too.
  const ready = pendingListFills(def, state);
  const requested = Array.isArray(listFillIds) && listFillIds.length
    ? ready.filter((lf) => listFillIds.includes(lf.id))
    : ready;
  if (!requested.length) return NextResponse.json({ ok: true, allocations: [] });

  // counters for this environment only
  const counts: ListFillCounts = {};
  const { data: countRows, error: countErr } = await db
    .from("listfill_counts")
    .select("list_fill_id, option_code, allocated_count, completed_count")
    .eq("survey_id", existing.survey_id)
    .eq("is_test", isTest);
  if (countErr && !/does not exist|relation/.test(countErr.message)) {
    console.error("[rescript:listfill] counters unreadable", { sessionId: sessionId.slice(0, 8), error: countErr.message });
  }
  for (const row of countRows ?? []) {
    counts[row.list_fill_id] = counts[row.list_fill_id] ?? {};
    // a list capped on completes is judged on completes; the engine is told
    // the number its own configuration cares about
    const lf = def.listFills.find((x) => x.id === row.list_fill_id);
    counts[row.list_fill_id][row.option_code] = lf?.tracking.countOnCompleteOnly
      ? row.completed_count
      : row.allocated_count;
  }
  const quotaCounts = await loadQuotaCounts(existing.survey_id, isTest);

  const allocations: {
    listFillId: string;
    name: string;
    items: { code: string; label: string; position: number }[];
    variables: Record<string, string | number | boolean | null>;
    destinations: string[];
    trace: unknown;
  }[] = [];

  for (const lf of requested) {
    const decided = decideListFill({ def, listFill: lf, state, counts, quotaCounts });

    let final = decided;
    if (needsAllocation(lf) && decided.preference.length) {
      const { data: granted, error } = await db.rpc("rescript_allocate_listfill", {
        p_survey: existing.survey_id,
        p_test: isTest,
        p_list_fill: lf.id,
        p_session: sessionId,
        p_preference: allocationPayload(lf, decided),
        p_count: decided.trace.requestedCount,
        p_use_completed: !!lf.tracking.countOnCompleteOnly,
        p_version: run.versionId ?? null,
      });
      if (error) {
        // The claim is the only thing that may hand out a capped slot, so a
        // failure here must NOT fall back to the optimistic decision — that
        // is exactly how two respondents end up sharing the last slot.
        console.error("[rescript:listfill] allocation failed", JSON.stringify({
          sessionId: sessionId.slice(0, 8), listFill: lf.id, error: error.message,
        }));
        return NextResponse.json({ error: "the allocation could not be recorded", listFillId: lf.id }, { status: 503 });
      }
      const confirmed = (granted ?? [])
        .slice()
        .sort((a: any, b: any) => a.slot_no - b.slot_no)
        .map((r: any) => String(r.option_code));
      final = confirmListFill(lf, decided, confirmed);
      // keep the in-memory counters moving, so a second list decided in this
      // same request sees the capacity the first one just took
      counts[lf.id] = counts[lf.id] ?? {};
      for (const item of final.items) counts[lf.id][item.code] = (counts[lf.id][item.code] ?? 0) + 1;
    }

    const variables = listFillVariables(lf, final);
    Object.assign(state.calculated, variables);
    const written = applyListFillDestinations(lf, final, state);

    allocations.push({
      listFillId: lf.id,
      name: final.name,
      items: final.items,
      variables,
      destinations: written,
      // the trace travels in test and preview only: it names every option and
      // its capacity, which is not a respondent's business
      trace: isTest ? final.trace : undefined,
    });

    console.info("[rescript:listfill] allocated", JSON.stringify({
      surveyId: existing.survey_id, sessionId: sessionId.slice(0, 8), environment: isTest ? "TEST" : "LIVE",
      listFill: lf.id, requested: final.trace.requestedCount, items: final.items.map((i) => i.code),
      preference: final.preference, version: run.versionId, source: run.source,
    }));
  }

  return NextResponse.json({ ok: true, allocations, environment: isTest ? "TEST" : "LIVE" });
}
