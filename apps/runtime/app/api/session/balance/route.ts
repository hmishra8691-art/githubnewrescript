import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { hasExactBalance, type ResponseState } from "@rescript/engine";
import { resolveRunDefinition } from "@rescript/quality/server";
import { supabaseAdmin } from "@/lib/admin";
import { aiProviderName } from "@/lib/ai";
import { claimBalances, missingBalanceMigration, sandboxBalanceStore, type BalanceStore } from "@/lib/balanceClaim";

export const dynamic = "force-dynamic";

/**
 * EXACT BALANCE — claim the arm(s) of a randomizer / the version of a design
 * (engine item #15). Called by the Runner just before it shows the first page
 * that needs an unclaimed slot; same slot, same reasons as List Fill.
 *
 * POST { sessionId, keys: string[], answers, calculated, embedded, flags, build }
 *   → { ok, assignments: [{ key, variable, arms, source: "claim" | "fallback" }] }
 *
 * LIVE / TEST: the session is a live in-progress `responses` row; the slot's
 * arms come from the session's PINNED definition and the claim is
 * `rescript_claim_balance` (0073) — atomic, least-filled, deterministic
 * tie-break, TEST and LIVE apart. Without 0073 the seed-derived arm is
 * returned as `fallback` (the old behaviour) and logged.
 *
 * SANDBOX (no database on this runtime, fake AI provider, not production): the
 * definition travels in the body and the claim is the process's in-memory
 * store with the same rules — what the browser suite drives. Also
 * `{ op: "complete" | "release" | "counts" }` there, so a harness can finish
 * or abandon its simulated respondents.
 */
const MAX_KEYS = 32;
const sandboxAllowed = () => !process.env.SUPABASE_URL && aiProviderName() === "fake" && process.env.VERCEL_ENV !== "production";

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const sessionId = body?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length < 16 || sessionId.length > 200) return NextResponse.json({ error: "invalid session" }, { status: 400 });
  const keys: string[] = Array.isArray(body?.keys) ? body.keys.filter((k: unknown) => typeof k === "string" && k.length <= 300).slice(0, MAX_KEYS) : [];

  if (sandboxAllowed()) {
    const store = sandboxBalanceStore();
    const scope = `sandbox:${String(body?.scope ?? "default").slice(0, 80)}`;
    if (body?.op === "complete") return NextResponse.json({ ok: true, n: store.complete(scope, sessionId) });
    if (body?.op === "release") return NextResponse.json({ ok: true, n: store.release(scope, sessionId) });
    const parsed = SurveyDefinition.safeParse(body?.definition);
    if (!parsed.success) return NextResponse.json({ error: "the sandbox needs the definition in the body" }, { status: 400 });
    if (body?.op === "counts") return NextResponse.json({ ok: true, counts: Object.fromEntries(keys.map((k) => [k, store.counts(scope, k)])) });
    const state = stateOf(body, sessionId, Number(body?.seed) || 0);
    const out = await claimBalances(parsed.data, state, keys, scope, { claim: async (r) => ({ ok: true, arms: store.claim(r) }) });
    return NextResponse.json({ ok: true, environment: "SANDBOX", ...out });
  }

  let db;
  try { db = supabaseAdmin(); }
  catch { return NextResponse.json({ error: "this runtime has no database configured" }, { status: 501 }); }
  const { data: existing } = await db
    .from("responses")
    .select("id, survey_id, version_id, status, is_test, seed, deleted_at")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "unknown session" }, { status: 404 });
  if (existing.deleted_at) return NextResponse.json({ error: "this response was deleted by the survey owner" }, { status: 410 });
  if (existing.status !== "in_progress") return NextResponse.json({ error: "this session is already finalised" }, { status: 409 });
  const run = await resolveRunDefinition(db, existing as never, body?.build);
  if (!run.def) return NextResponse.json({ error: "the survey definition for this session could not be read" }, { status: 500 });
  if (!hasExactBalance(run.def)) return NextResponse.json({ ok: true, assignments: [] });

  const isTest = !!existing.is_test;
  // the SERVER's seed: the tie-break order is derived from it, not from anything the client says
  const state = stateOf(body, sessionId, Number(existing.seed ?? 0) || 0, run.def);
  let missing = false;
  const store: BalanceStore = {
    async claim(r) {
      if (missing) return { ok: false, error: "migration 0073 is not applied" };
      const { data, error } = await db.rpc("rescript_claim_balance", {
        p_survey: existing.survey_id, p_test: isTest, p_session: sessionId, p_key: r.key,
        p_arms: [...r.preference], p_count: r.count, p_basis: r.basis, p_hold_seconds: Math.round(r.holdMinutes * 60),
      });
      if (error) {
        if (missingBalanceMigration(error.message)) missing = true;
        return { ok: false, error: error.message };
      }
      return { ok: true, arms: Array.isArray(data) ? (data as unknown[]).map(String) : [] };
    },
  };
  const out = await claimBalances(run.def, state, keys, `${existing.survey_id}:${isTest ? "TEST" : "LIVE"}`, store);
  for (const a of out.assignments) {
    if (a.source === "fallback") console.warn("[rescript:balance] claim failed — the seed-derived arm is used", JSON.stringify({ surveyId: existing.survey_id, sessionId: sessionId.slice(0, 8), key: a.key, error: a.reason, needsMigration: missing ? "0073" : undefined }));
    else console.info("[rescript:balance] claimed", JSON.stringify({ surveyId: existing.survey_id, sessionId: sessionId.slice(0, 8), environment: isTest ? "TEST" : "LIVE", key: a.key, arms: a.arms }));
  }
  return NextResponse.json({ ok: true, environment: isTest ? "TEST" : "LIVE", ...out });
}

function stateOf(body: any, sessionId: string, seed: number, def?: SurveyDefinition): ResponseState {
  return {
    surveyId: def?.meta.id ?? "", surveyVersion: def?.meta.version ?? "", sessionId, seed, startedAt: "", status: "in_progress",
    answers: body?.answers && typeof body.answers === "object" ? body.answers : {},
    embedded: body?.embedded && typeof body.embedded === "object" ? body.embedded : {},
    calculated: body?.calculated && typeof body.calculated === "object" ? { ...body.calculated } : {},
    flags: Array.isArray(body?.flags) ? [...body.flags] : [],
    stepIndex: 0,
  } as unknown as ResponseState;
}
