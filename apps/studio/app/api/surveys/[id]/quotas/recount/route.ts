import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadQualityDefinition } from "@/lib/qualityDef";
import { parseEnvironment, missingResponseMigration, RESPONSE_MIGRATION_MESSAGE } from "@/lib/responseData";
import { generateQuotaFromData, recountQuotas } from "@/lib/quotaRecount";
import { isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * Quota counts, from the response data that exists.
 *
 *   POST { environment: "TEST" | "LIVE" | "ALL" }
 *        recount — replaces that environment's counters from the dataset in
 *        one transaction. What the Data manager calls after an edit, a
 *        delete or an import, and what the Quotas panel's "Recount" button
 *        calls when the researcher wants to be sure.
 *
 *   POST { environment, generate: true, questionIds: [...] }
 *        "Generate quota from current data" — read the distinct answers and
 *        their counts and hand back cells the researcher can save into
 *        `def.quotas`. Nothing is written to the survey here: the Studio
 *        applies it as an ordinary edit, so it autosaves, versions and can be
 *        undone like any other change.
 *
 * `environment` is required; a recount never touches the other environment's
 * counters.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.manage");
  if (isFailure(gate)) return gate.response;

  let body: any = {};
  try { body = await req.json(); } catch { /* optional */ }
  const environment = parseEnvironment(body?.environment);
  if (!environment) return NextResponse.json({ error: "environment must be TEST, LIVE or ALL" }, { status: 400 });

  const db = supabaseAdmin();
  const loaded = await loadQualityDefinition(db, params.id);
  if (!("def" in loaded)) return NextResponse.json({ error: loaded.error }, { status: loaded.status });

  try {
    if (body?.generate) {
      if (environment === "ALL") return NextResponse.json({ error: "generating a quota needs one environment — TEST or LIVE — so the counts are not mixed" }, { status: 400 });
      const questionIds = Array.isArray(body?.questionIds) ? body.questionIds.map(String) : [];
      if (!questionIds.length) return NextResponse.json({ error: "questionIds is required" }, { status: 400 });
      const res = await generateQuotaFromData(db, loaded.def, params.id, environment === "TEST", questionIds);
      console.info("[rescript:quota] generate", JSON.stringify({ surveyId: params.id, environment, responses: res.responses, questions: res.questions.map((q) => `${q.code}:${q.cells.length}`) }));
      return NextResponse.json({ ok: true, ...res });
    }
    const results: Record<string, unknown> = {};
    for (const isTest of environment === "ALL" ? [true, false] : [environment === "TEST"]) {
      results[isTest ? "TEST" : "LIVE"] = await recountQuotas(db, loaded.def, params.id, isTest);
    }
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    const msg = (e as Error).message;
    if (missingResponseMigration(msg)) return NextResponse.json({ error: RESPONSE_MIGRATION_MESSAGE, migration: "0006" }, { status: 503 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
