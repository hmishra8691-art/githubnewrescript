import { NextRequest } from "next/server";
import { parseObserverNote } from "@rescript/engine";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { json, refuse, UUID } from "@/lib/qual/qualStore";
import { sandboxCall } from "@/lib/aiInterviews/sandboxProxy";
import { addObserverNote, observerNotes, withdrawObserverQuestion, isMissing0115, MISSING_0115 } from "@/lib/aiInterviews/observer";

export const dynamic = "force-dynamic";

/**
 * THE OBSERVER ROOM OF ONE AI INTERVIEW (Level 5 roadmap Q5, migration 0115) — never seen by the participant.
 *
 *   GET                                         the room's notes (chat, markers, questions with their status)
 *   POST { note: { kind: "chat", text } }       a private message to the other observers — Data view
 *   POST { note: { kind: "marker", text, turnSeq? } }   mark this moment (the latest turn, or the turn named)
 *   POST { note: { kind: "question", text } }   a question for the AI moderator, asked after the participant's next
 *                                               answer — Data edit (it changes the interview)
 *   POST { withdraw: "<note id>" }              take back a question not yet asked — Data edit
 * The live transcript is the interview's own GET (../route.ts), polled beside this.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string; interviewId: string } }) {
  const authed = await requireUser(req);
  if (params.id === "sandbox") {
    const r = await sandboxCall({ action: "observer", observerKey: req.nextUrl.searchParams.get("key"), id: params.interviewId });
    return json(r.body, r.status);
  }
  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability("read"));
  if (isFailure(gate)) return gate.response;
  if (!UUID.test(params.interviewId)) return json({ error: "which interview" }, 400);
  try {
    return json({ ok: true, notes: await observerNotes(gate.db, params.id, params.interviewId) });
  } catch (e) {
    const m = (e as Error).message;
    return json({ error: isMissing0115(m) ? MISSING_0115 : m }, isMissing0115(m) ? 503 : 500);
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string; interviewId: string } }) {
  const authed = await requireUser(req);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "send a note or a question to withdraw" }, 400);
  const note = body.note !== undefined ? parseObserverNote(body.note) : null;
  if (note && "error" in note) return json({ error: note.error }, 400);
  const withdraw = typeof body.withdraw === "string" ? body.withdraw : null;
  if (!note && !withdraw) return json({ error: "send a note or a question to withdraw" }, 400);
  if (params.id === "sandbox") {
    const r = await sandboxCall({ action: "observer", observerKey: body.observerKey, id: params.interviewId, ...(note ? { note: { kind: note.kind, text: note.text, ...(note.turnSeq !== undefined ? { turnSeq: note.turnSeq } : {}) } } : {}), ...(withdraw ? { withdraw } : {}), author: "You" });
    return json(r.body, r.status);
  }
  if (isFailure(authed)) return authed.response;
  /* chat and markers need only to read the interview; a question or a withdrawal changes it */
  const op = note && note.kind !== "question" ? "read" : "manage";
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability(op));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, op);
  if (refused) return refused;
  if (!UUID.test(params.interviewId) || (withdraw && !UUID.test(withdraw))) return json({ error: "which interview" }, 400);
  try {
    const label = (gate.user.fullName || gate.user.email || "Observer").slice(0, 200);
    if (note) {
      const r = await addObserverNote(gate.db, params.id, params.interviewId, note, { userId: gate.user.userId, label });
      if ("error" in r) return json({ error: r.error }, r.status);
      if (note.kind === "question") await gate.db.from("qual_events").insert({ survey_id: params.id, actor: gate.user.userId, actor_label: label, action: "ai_interview.observer_question", detail: `Asked the AI moderator, from the observer room: “${note.text.slice(0, 200)}”`, ids: [params.interviewId] });
    } else if (withdraw) {
      await withdrawObserverQuestion(gate.db, params.id, params.interviewId, withdraw);
    }
    return json({ ok: true, notes: await observerNotes(gate.db, params.id, params.interviewId) });
  } catch (e) {
    const m = (e as Error).message;
    return json({ error: isMissing0115(m) ? MISSING_0115 : m }, isMissing0115(m) ? 503 : 500);
  }
}
