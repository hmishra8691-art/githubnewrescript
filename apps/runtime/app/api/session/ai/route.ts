import { NextRequest, NextResponse } from "next/server";
import { serverResolvedQuestions } from "@rescript/engine";
import { classify, sentiment } from "@/lib/ai";
import { definitionForAiCall } from "@/lib/aiSession";
import { meteredSessionAi } from "@/lib/metering";

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
 * Who may call it, and with which definition: `definitionForAiCall`.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const gate = await definitionForAiCall(body);
  if ("response" in gate) return gate.response;
  const { def, billing } = gate;
  const { answers, questionIds } = body ?? {};

  const wanted = new Set<string>(Array.isArray(questionIds) ? questionIds : []);
  const targets = serverResolvedQuestions(def).filter((t) => !wanted.size || wanted.has(t.question.id));
  const out: Record<string, string | null> = {};
  const a = (answers ?? {}) as Record<string, unknown>;

  for (const { question, call, source } of targets) {
    if (!source) continue;
    const text = textOf(a[source.id]);
    if (!text) continue;
    try {
      // METERED: one AI request per variable, on the session's project wallet; a refusal leaves the value unset
      const m = await meteredSessionAi(billing, { estimateText: `${text} ${(call.categories ?? []).join(" ")}`, maxTokens: 40, operation: call.fn }, () =>
        call.fn === "ai_classify" ? classify(text, call.categories ?? []) : sentiment(text));
      out[question.id] = "refused" in m ? null : m.value;
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
