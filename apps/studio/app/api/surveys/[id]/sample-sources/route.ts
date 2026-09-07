import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { parseEnvironment } from "@/lib/responseData";
import { audit, isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * SAMPLE SOURCES AND FIELDWORK PERFORMANCE (§23).
 *
 *   GET    ?environment=TEST|LIVE       declared sources + performance
 *   POST   { code, label, targetCompletes?, costPerComplete?, notes? }
 *   DELETE ?code=…                      undeclare one
 *
 * Two things at one address, because they are two halves of one answer. The
 * DECLARED sources are what the team contracted for — "Cint, 400 completes at
 * £3.20" — and live in `public.sample_sources`. The PERFORMANCE is what
 * actually arrived, computed by `rescript_source_stats` over the responses.
 * A fieldwork view needs both at once: a target with no delivery and a
 * delivery with no target are each half a sentence.
 *
 * Sources that were never declared still appear, with `declared: false`.
 * That is the point of capturing the value as free text (migration 0012): a
 * typo in one supplier's link, or a supplier nobody wrote down, shows up as
 * an unexpected row rather than as data quietly missing from every total.
 *
 * ENVIRONMENT is required and never assumed, like every other per-response
 * read in the platform: test traffic must never appear in a fieldwork figure
 * someone is about to invoice against.
 */

/** Deliberately narrow: a code travels in a URL and is joined on. */
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;

  const environment = parseEnvironment(req.nextUrl.searchParams.get("environment") ?? "LIVE");
  if (!environment) return NextResponse.json({ error: "environment must be TEST, LIVE or ALL" }, { status: 400 });

  const db = supabaseAdmin();
  const declared = await db
    .from("sample_sources")
    .select("id, code, label, target_completes, cost_per_complete, notes, created_at")
    .eq("survey_id", params.id)
    .order("code", { ascending: true });

  if (declared.error) {
    /*
     * Migration 0012 not applied: answer with an empty, explicitly
     * unavailable panel rather than an error. The same shape every
     * migration-gated panel here uses — a researcher should see "this needs a
     * migration", not a stack trace where their fieldwork was.
     */
    if (/sample_sources|does not exist|schema cache/i.test(declared.error.message)) {
      return NextResponse.json({
        sources: [], stats: [], environment, available: false,
        note: "Sample source tracking needs migration 0012.",
      }, { headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({ error: declared.error.message }, { status: 500 });
  }

  /*
   * ALL means both environments, and the function takes one — so it is called
   * twice and the rows are tagged. Summing them into one row would be the
   * wrong answer: a supplier's incidence is a property of the live field, and
   * mixing a programmer's test session into it changes the number.
   */
  const envs: { environment: "TEST" | "LIVE"; isTest: boolean }[] =
    environment === "ALL"
      ? [{ environment: "LIVE", isTest: false }, { environment: "TEST", isTest: true }]
      : [{ environment, isTest: environment === "TEST" }];

  const stats: Record<string, unknown>[] = [];
  for (const e of envs) {
    const { data, error } = await db.rpc("rescript_source_stats", { p_survey: params.id, p_is_test: e.isTest });
    if (error) {
      if (/rescript_source_stats|does not exist|schema cache/i.test(error.message)) {
        return NextResponse.json({
          sources: [], stats: [], environment, available: false,
          note: "Sample source tracking needs migration 0012.",
        }, { headers: { "cache-control": "no-store" } });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      stats.push({
        environment: e.environment,
        code: row.sample_source,
        declared: row.declared,
        label: row.label,
        targetCompletes: row.target_completes,
        starts: Number(row.starts ?? 0),
        completes: Number(row.completes ?? 0),
        partials: Number(row.partials ?? 0),
        screened: Number(row.screened ?? 0),
        quotaFull: Number(row.quota_full ?? 0),
        terminated: Number(row.terminated ?? 0),
        incidence: row.incidence == null ? null : Number(row.incidence),
        completionRate: row.completion_rate == null ? null : Number(row.completion_rate),
        medianSeconds: row.median_seconds == null ? null : Number(row.median_seconds),
        firstResponse: row.first_response ?? null,
        lastResponse: row.last_response ?? null,
      });
    }
  }

  return NextResponse.json({
    available: true,
    environment,
    sources: (declared.data ?? []).map((s) => ({
      id: s.id, code: s.code, label: s.label,
      targetCompletes: s.target_completes, costPerComplete: s.cost_per_complete,
      notes: s.notes, createdAt: s.created_at,
    })),
    stats,
  }, { headers: { "cache-control": "no-store" } });
}

/**
 * Declare a source, or correct one.
 *
 * `survey.edit` rather than `responses.manage`: declaring a supplier is part
 * of setting the study up, and it changes no response data. Saving over an
 * existing code UPDATES it — a code is the handle a supplier's links already
 * carry, so re-declaring must not mint a second row that splits the source in
 * two in every report.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const code = String(body?.code ?? "").trim();
  if (!CODE_RE.test(code)) {
    return NextResponse.json({
      error: "A source code is what arrives in the invitation link: letters, digits, and - _ . : — up to 64 characters.",
    }, { status: 400 });
  }
  const label = String(body?.label ?? "").trim() || code;
  if (label.length > 120) return NextResponse.json({ error: "that label is too long" }, { status: 400 });

  const num = (v: unknown, name: string): number | null | { error: string } => {
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { error: `${name} must be a number that is not negative` };
    return n;
  };
  const target = num(body?.targetCompletes, "The completes target");
  if (target && typeof target === "object") return NextResponse.json(target, { status: 400 });
  const cost = num(body?.costPerComplete, "The cost per complete");
  if (cost && typeof cost === "object") return NextResponse.json(cost, { status: 400 });

  const db = supabaseAdmin();
  /*
   * Matched case-insensitively, exactly as the unique index and the stats
   * join do. Without that, declaring "CINT" over "cint" would hit the index
   * and read to the user as a database error rather than as the edit it is.
   */
  const { data: existing } = await db
    .from("sample_sources").select("id, code")
    .eq("survey_id", params.id).ilike("code", code).maybeSingle();

  const row = {
    survey_id: params.id,
    code,
    label,
    target_completes: target === null ? null : Math.round(target as number),
    cost_per_complete: cost === null ? null : (cost as number),
    notes: typeof body?.notes === "string" ? body.notes.slice(0, 2000) : null,
  };

  const { data, error } = existing
    ? await db.from("sample_sources").update(row).eq("id", existing.id).select("id, code, label").single()
    : await db.from("sample_sources").insert({ ...row, created_by: gate.user.userId }).select("id, code, label").single();

  if (error) {
    if (/sample_sources|does not exist|schema cache/i.test(error.message)) {
      return NextResponse.json({ error: "Sample source tracking needs migration 0012.", migration: "0012" }, { status: 503 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await audit({
    action: "survey.modified", userId: gate.user.userId, sessionId: gate.user.sessionId,
    surveyId: params.id, customerId: gate.user.customerId,
    entity: "sample_source", entityId: data.id,
    detail: { summary: `${existing ? "updated" : "declared"} the sample source “${code}”` },
  });

  return NextResponse.json({ ok: true, source: data, replaced: !!existing });
}

/**
 * Undeclare a source.
 *
 * The RESPONSES keep their `sample_source` value — undeclaring is saying "we
 * are not tracking a target for this any more", not "these interviews did not
 * come from anywhere". The source simply reappears in the fieldwork table
 * with `declared: false`, which is the honest description of what it now is.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;

  const code = req.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.json({ error: "code is required" }, { status: 400 });

  const db = supabaseAdmin();
  const { error } = await db.from("sample_sources").delete()
    .eq("survey_id", params.id).ilike("code", code);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await audit({
    action: "survey.modified", userId: gate.user.userId, sessionId: gate.user.sessionId,
    surveyId: params.id, customerId: gate.user.customerId,
    entity: "sample_source", entityId: code,
    detail: { summary: `stopped tracking the sample source “${code}” (the responses keep their source)` },
  });

  return NextResponse.json({ ok: true });
}
