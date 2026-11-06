import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { aiModelName, completeJson } from "@rescript/ai";
import { gateJudgements, judgementFlag, openEndPrompt, type OpenEndItem, type QualityAssessment } from "@rescript/quality";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/guard";
import { loadQualityDefinition } from "@/lib/qualityDef";
import { aiAllowed } from "@/lib/aiPolicy";
import { aiReadyFor } from "@/lib/byok/connect";
import { billingProjectFor, meteredAi } from "@/lib/metering";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * A LANGUAGE MODEL READS THE OPEN ENDS — AS EVIDENCE (Intelligent Mode IM6, 2026-11-06).
 *
 *   POST { limit?: 1–60, environment? }
 *
 * The finished responses whose open-text answers have no model reading yet, up to `limit` answers per call, sent
 * as fenced data under fixed instructions (`openEndPrompt`), metered to the project like every model call, refused
 * when the project's AI policy says so. What comes back passes `gateJudgements` — a known item, a known verdict, a
 * quote that is VERBATIM in the answer — and each kept judgement is stored as one INFORMATIONAL flag
 * (`openend.model`, the model named) on that response's assessment. It never classifies and never removes: a batch
 * ("exclude the responses the model read as gibberish") or a person does that, on review.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.manage");
  if (isFailure(gate)) return gate.response;
  const body = (await req.json().catch(() => ({}))) as { limit?: unknown; environment?: unknown };
  const limit = typeof body.limit === "number" ? Math.max(1, Math.min(60, Math.round(body.limit))) : 40;
  const isTest = body.environment === "TEST";
  const operation = "openend_judgement";

  if (!(await aiReadyFor(gate.user, params.id, operation))) return NextResponse.json({ error: "No language model is configured — the rules' open-end checks stand on their own." }, { status: 409 });
  const allowed = await aiAllowed(params.id, operation);
  if (!allowed.allowed) return NextResponse.json({ error: allowed.message ?? "AI is off for this project." }, { status: 403 });

  const db = supabaseAdmin();
  const loaded = await loadQualityDefinition(db, params.id);
  if ("error" in loaded) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const openQs = loaded.def.questions.filter((q) => q.type === "open_text" || q.type === "long_text");
  if (!openQs.length) return NextResponse.json({ ok: true, judged: 0, note: "This survey has no open-text questions." });

  const { data, error } = await db.from("responses").select("id, session_id, answers, quality").eq("survey_id", params.id).eq("is_test", isTest).is("deleted_at", null).neq("status", "in_progress").not("quality", "is", null).order("completed_at", { ascending: false }).limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const items: OpenEndItem[] = [];
  const rowOf = new Map<string, { id: string; quality: QualityAssessment }>();
  for (const r of (data ?? []) as { id: string; session_id: string; answers: Record<string, unknown> | null; quality: QualityAssessment }[]) {
    const judged = new Set(r.quality.flags.filter((f) => f.ruleId === "openend.model").flatMap((f) => f.questionIds));
    for (const q of openQs) {
      const a = r.answers?.[q.id];
      if (typeof a !== "string" || a.trim().length < 2 || judged.has(q.id)) continue;
      items.push({ sessionId: r.session_id, questionId: q.id, questionCode: q.code, question: (q.text ?? "").replace(/<[^>]*>/g, ""), answer: a });
      rowOf.set(r.session_id, { id: r.id, quality: r.quality });
      if (items.length >= limit) break;
    }
    if (items.length >= limit) break;
  }
  if (!items.length) return NextResponse.json({ ok: true, judged: 0, note: "Every open-ended answer already has a model reading (or none is long enough to read)." });

  const billing = await billingProjectFor(gate.user, params.id, "responses.manage");
  if ("response" in billing) return billing.response;
  const prompt = openEndPrompt(items, randomBytes(6).toString("hex"));
  const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: prompt, maxTokens: 120 * items.length + 200, operation }, () => completeJson("You check survey data quality. Answer with JSON only.", prompt, 160 * items.length + 400, { timeoutMs: 90_000 }))
    .catch((e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : "the model call failed" }));
  if (!m.ok) return NextResponse.json({ error: `The model could not read the answers: ${(m as { message?: string }).message ?? "refused"}` }, { status: 502 });
  const model = aiModelName("large");
  const { kept, dropped } = gateJudgements(m.value, items);
  const at = new Date().toISOString();
  const byRow = new Map<string, ReturnType<typeof judgementFlag>[]>();
  for (const j of kept) {
    const it = items.find((x) => x.sessionId === j.sessionId && x.questionId === j.questionId)!;
    (byRow.get(j.sessionId) ?? byRow.set(j.sessionId, []).get(j.sessionId)!).push(judgementFlag(j, it, model, at));
  }
  let written = 0;
  for (const [sessionId, flags] of byRow) {
    const r = rowOf.get(sessionId)!;
    const quality = { ...r.quality, flags: [...r.quality.flags.filter((f) => !(f.ruleId === "openend.model" && flags.some((n) => n.questionIds[0] === f.questionIds[0]))), ...flags] };
    const { error: e } = await db.from("responses").update({ quality }).eq("id", r.id);
    if (!e) written++;
  }
  const tally: Record<string, number> = {};
  for (const j of kept) tally[j.verdict] = (tally[j.verdict] ?? 0) + 1;
  console.info("[rescript:quality] open-end reading", JSON.stringify({ survey: params.id, sent: items.length, kept: kept.length, dropped: dropped.length, written, model }));
  return NextResponse.json({ ok: true, sent: items.length, judged: kept.length, dropped: dropped.length, droppedReasons: [...new Set(dropped.map((d) => d.reason))], responses: written, verdicts: tally, model, charge: m.event?.customerCharge ?? 0 });
}
