import { NextRequest, NextResponse } from "next/server";
import { probeSourceText, probeSourceTextFor, probeTranscript, effectiveProbe, questionAi, createResponseState, type ResponseState } from "@rescript/engine";
import { writeProbe } from "@/lib/ai";
import { definitionForAiCall } from "@/lib/aiSession";

export const dynamic = "force-dynamic";

/**
 * WRITE THE WORDING OF ONE FOLLOW-UP PROBE.
 *
 * The Runner has already decided that a probe is due (engine `dueProbes`) and
 * that its wording is not fixed in the definition; it asks here for the
 * words. The body carries the probed question's id, the follow-up number and
 * the current answers; the response is `{ prompt }` — a question, or null
 * when the provider had nothing usable, in which case the Runner skips the
 * probe and the interview continues.
 *
 * Which probe applies is decided HERE from the definition, never taken from
 * the body: the question's own `probe`, or the one the survey's adaptive
 * settings give it (`effectiveProbe`) — with the research objective, allowed
 * and restricted topics and interviewer guardrails as the instruction the
 * writer receives. The answers are needed for that too: an adaptive rule
 * ("IF Q10 = Dissatisfied THEN allow up to 2") reads them.
 *
 * This route writes nothing and decides nothing about the flow. Who may
 * call it, and with which definition: `definitionForAiCall`.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const gate = await definitionForAiCall(body);
  if ("response" in gate) return gate.response;
  const { def } = gate;

  const q = def.questions.find((x) => x.id === body?.questionId);
  if (!q) return NextResponse.json({ error: "unknown question" }, { status: 400 });
  const answers = (body?.answers ?? {}) as Record<string, unknown>;
  const state: ResponseState = { ...createResponseState(def), answers: answers as ResponseState["answers"] };
  const probe = effectiveProbe(def, q, { def, state, loop: null }, questionAi(def, q));
  if (!probe) return NextResponse.json({ error: "that question has no probe" }, { status: 400 });
  const n = Number(body?.n);
  if (!Number.isInteger(n) || n < 1 || n > probe.maxProbes) return NextResponse.json({ error: "invalid probe number" }, { status: 400 });

  const answer = probeSourceTextFor(q, answers[q.id]);
  if (!answer) return NextResponse.json({ ok: true, prompt: null });
  const transcript = probeTranscript(state, q.id)
    .filter((t) => t.n < n)
    .map((t) => ({ prompt: t.prompt, answer: probeSourceText(t.answer) }));

  try {
    const language = typeof body?.language === "string" ? body.language.slice(0, 20) : undefined;
    const prompt = await writeProbe({ questionText: q.text, answer, transcript, n, instruction: probe.instruction, language });
    return NextResponse.json({ ok: true, prompt });
  } catch (e) {
    console.warn("[rescript:ai] probe failed", JSON.stringify({ q: q.code, error: (e as Error).message }));
    return NextResponse.json({ ok: true, prompt: null });
  }
}
