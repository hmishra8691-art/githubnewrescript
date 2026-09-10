import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { resolveRunDefinition } from "@rescript/quality/server";
import { serverResolvedQuestions } from "@rescript/engine";
import { aiConfigured, aiProviderName, classify, sentiment } from "@/lib/ai";
import { SurveyDefinition } from "@rescript/schema";

export const dynamic = "force-dynamic";

/**
 * RESOLVE THE AI-DERIVED VARIABLES FOR ONE PAGE SUBMIT.
 *
 * Called by the Runner in the same slot as List Fill — after the page's
 * answers are valid and BEFORE the flow advances — so a display rule or quota
 * on the next page that reads `Q5_CAT` sees the classification rather than a
 * blank. Deciding it after navigation would build the next page from a value
 * the respondent had not been given yet, which is the exact mistake List Fill
 * exists to avoid.
 *
 * The body carries the current answers; the response carries only the
 * variables this call decided, keyed by question id. The Runner merges them
 * into `state.answers`, and the ordinary save that follows persists them like
 * any other answer. This route writes nothing.
 *
 * Authentication is the session: a live in-progress `responses` row, exactly
 * as `/api/session/listfill` requires. Unconfigured provider → 501 and the
 * Runner carries on without the values; the respondent never sees this.
 *
 * ONE CARVE-OUT, AND WHY. A preview has no session, and a real provider must
 * never be reachable without one — that is a cost and abuse surface. But a
 * programmer needs to SEE the mechanism work before fielding, and the browser
 * suite needs to prove the whole path without a database. So a preview may
 * resolve against the FAKE provider only: `sessionId: "preview"` with the
 * definition in the body is accepted when `AI_API_URL=fake:`, and refused
 * with 403 otherwise. The fake provider is deterministic and free, so the
 * carve-out costs nothing and leaks nothing.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const { sessionId, answers, questionIds } = body ?? {};
  if (typeof sessionId !== "string" || (sessionId !== "preview" && sessionId.length < 16))
    return NextResponse.json({ error: "invalid session" }, { status: 400 });
  if (!aiConfigured()) return NextResponse.json({ error: "AI is not configured on this runtime" }, { status: 501 });

  let def: SurveyDefinition | null = null;
  if (sessionId === "preview") {
    if (aiProviderName() !== "fake") {
      return NextResponse.json({ error: "a preview cannot use the AI provider; open a test link to see real classifications" }, { status: 403 });
    }
    const parsed = SurveyDefinition.safeParse(body?.definition);
    if (!parsed.success) return NextResponse.json({ error: "preview needs the definition in the body" }, { status: 400 });
    def = parsed.data;
  } else {
    const db = supabaseAdmin();
    const { data: existing } = await db
      .from("responses")
      .select("id, survey_id, version_id, status, is_test, deleted_at")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (!existing) return NextResponse.json({ error: "unknown session" }, { status: 404 });
    if (existing.deleted_at) return NextResponse.json({ error: "this response was deleted by the survey owner" }, { status: 410 });
    if (existing.status !== "in_progress") return NextResponse.json({ error: "this session is already finalised" }, { status: 409 });

    const run = await resolveRunDefinition(db, existing as never, body?.build);
    def = run.def ?? null;
  }
  if (!def) return NextResponse.json({ error: "the survey definition for this session could not be read" }, { status: 500 });

  const wanted = new Set<string>(Array.isArray(questionIds) ? questionIds : []);
  const targets = serverResolvedQuestions(def).filter((t) => !wanted.size || wanted.has(t.question.id));
  const out: Record<string, string | null> = {};
  const a = (answers ?? {}) as Record<string, unknown>;

  for (const { question, call, source } of targets) {
    if (!source) continue;
    const text = textOf(a[source.id]);
    if (!text) continue;
    try {
      out[question.id] = call.fn === "ai_classify"
        ? await classify(text, call.categories ?? [])
        : await sentiment(text);
    } catch (e) {
      console.warn("[rescript:ai] resolution failed", JSON.stringify({ q: question.code, error: (e as Error).message }));
      out[question.id] = null;
    }
  }
  return NextResponse.json({ ok: true, answers: out });
}

/** The text of an open-end answer, whatever shape the type stores it in. */
function textOf(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object") {
    // text_list / fields: join the field values
    return Object.values(v as Record<string, unknown>).map((x) => (x == null ? "" : String(x))).filter(Boolean).join("\n").trim();
  }
  return String(v).trim();
}
