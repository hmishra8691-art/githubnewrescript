import { NextRequest, NextResponse } from "next/server";
import { probeSourceText, probeTranscript, type ResponseState } from "@rescript/engine";
import { writeProbe } from "@/lib/ai";
import { definitionForAiCall } from "@/lib/aiSession";

export const dynamic = "force-dynamic";

/**
 * WRITE THE WORDING OF ONE FOLLOW-UP PROBE.
 *
 * The Runner has already decided that a probe is due (engine `nextProbe`) and
 * that its wording is not fixed in the definition; it asks here for the
 * words. The body carries the probed question's id, the follow-up number and
 * the current answers; the response is `{ prompt }` — a question, or null
 * when the provider had nothing usable, in which case the Runner skips the
 * probe and the interview continues.
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
  if (!q?.probe) return NextResponse.json({ error: "that question has no probe" }, { status: 400 });
  const n = Number(body?.n);
  if (!Number.isInteger(n) || n < 1 || n > q.probe.maxProbes) return NextResponse.json({ error: "invalid probe number" }, { status: 400 });

  const answers = (body?.answers ?? {}) as Record<string, unknown>;
  const answer = probeSourceText(answers[q.id]);
  if (!answer) return NextResponse.json({ ok: true, prompt: null });
  const transcript = probeTranscript({ answers } as ResponseState, q.id)
    .filter((t) => t.n < n)
    .map((t) => ({ prompt: t.prompt, answer: probeSourceText(t.answer) }));

  try {
    const prompt = await writeProbe({ questionText: q.text, answer, transcript, n, instruction: q.probe.instruction });
    return NextResponse.json({ ok: true, prompt });
  } catch (e) {
    console.warn("[rescript:ai] probe failed", JSON.stringify({ q: q.code, error: (e as Error).message }));
    return NextResponse.json({ ok: true, prompt: null });
  }
}
