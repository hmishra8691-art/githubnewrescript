/**
 * RESPONDENTS' PRIVACY REQUESTS, THE RESEARCHER'S SIDE — THE DECISIONS (phase 5, 2026-11-20). Pure.
 *
 * A respondent asks the organiser of one assessment for a copy of their data, a correction or deletion (the
 * portal's account page). Here the organiser ANSWERS: done or declined, with a sentence the respondent will read.
 * Answering records the outcome; it does not copy, change or delete anything itself — that is done with the
 * project's own tools (export, the response editor, erasure), and then the request is marked.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolveRequest { id: string; status: "done" | "declined"; note: string }

export function readResolve(body: unknown): ResolveRequest | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof b.id !== "string" || !UUID.test(b.id)) return { error: "Choose a request." };
  if (b.status !== "done" && b.status !== "declined") return { error: "Mark the request as done or declined." };
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (note.length > 2000) return { error: "Please keep the answer under 2,000 characters." };
  /* a refusal owes the person a reason */
  if (b.status === "declined" && note.length < 10) return { error: "Say why the request is declined. The respondent will read this." };
  return { id: b.id, status: b.status, note };
}

/** what the organiser is expected to have done before marking each kind as done */
export const REQUEST_HELP: Record<string, string> = {
  access: "Export this person's answers from Data and send them a copy, then mark it done.",
  correction: "Correct the answer in Data (the response editor records the change), then mark it done.",
  deletion: "Erase the person from this survey with the erasure tool in Data, then mark it done.",
};
