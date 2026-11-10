import { randomBytes } from "node:crypto";

/**
 * HANDING A HELP CONVERSATION TO A PERSON (2026-11-10) — the ticket, built from what Help already knows, so the
 * support engineer starts where the assistant stopped and the user never repeats themselves:
 *
 *   transcript   every question and answer (answers clipped), with the guides each answer used
 *   diagnostics  the latest survey check (Level 2): what was checked, the verdict and the findings
 *   attempts     each answer given: its level (guides / survey check / AI), why, and its sources
 *   context      where the user was (surface, tab, survey summary, selected question) — the same description Help
 *                itself was given; never the whole survey definition
 *
 * `sharedSummary` is what the user is shown BEFORE sending — the ticket contains exactly that and nothing else.
 */
export interface StoredTurn { role: "user" | "assistant"; content: Record<string, unknown> }
export interface TranscriptTurn { role: "user" | "assistant"; text: string; level?: number; sources?: string[] }
export interface Attempt { level: number; reason: string; sources: string[]; modelUsed: boolean }
export interface TicketDraft {
  subject: string;
  transcript: TranscriptTurn[];
  attempts: Attempt[];
  diagnostics: Record<string, unknown> | null;
  reason: string | null;
}

const clip = (s: unknown, n: number) => { const t = String(s ?? "").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** a reference people can read out on a call: HLP- and 8 characters without look-alikes */
export function ticketReference(rand: (n: number) => Buffer = randomBytes): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `HLP-${[...rand(8)].map((b) => A[b % A.length]).join("")}`;
}

export function draftTicket(turns: StoredTurn[], opts: { reason?: string | null } = {}): TicketDraft {
  const transcript: TranscriptTurn[] = [];
  const attempts: Attempt[] = [];
  let diagnostics: Record<string, unknown> | null = null;
  for (const t of turns.slice(-40)) {
    const c = t.content ?? {};
    if (t.role === "user") { transcript.push({ role: "user", text: clip(c.text, 2000) }); continue; }
    const sources = Array.isArray(c.sources) ? (c.sources as { title?: string; heading?: string }[]).map((s) => clip(`${s.title ?? ""}${s.heading ? ` — ${s.heading}` : ""}`, 160)).filter(Boolean).slice(0, 6) : [];
    const route = (c.route ?? null) as { level?: number; reason?: string; modelUsed?: boolean; cached?: boolean } | null;
    transcript.push({ role: "assistant", text: clip(c.answer, 3000), ...(route?.level ? { level: route.level } : {}), ...(sources.length ? { sources } : {}) });
    if (route?.level) attempts.push({ level: route.level, reason: clip(route.reason, 200), sources, modelUsed: !!(route.modelUsed || route.cached) });
    if (c.diagnosis && typeof c.diagnosis === "object") diagnostics = c.diagnosis as Record<string, unknown>;
  }
  const firstQuestion = transcript.find((t) => t.role === "user")?.text ?? "Help request";
  return { subject: clip(firstQuestion.replace(/\s+/g, " "), 120) || "Help request", transcript, attempts, diagnostics, reason: opts.reason ?? null };
}

const LEVEL = ["", "guides", "survey check", "AI"];

/** the plain-text e-mail to the support address */
export function ticketText(o: { reference: string; draft: TicketDraft; userEmail: string | null; message: string | null; context: Record<string, unknown> | null; surveyId: string | null }): string {
  const lines = [
    `Help escalation ${o.reference}`,
    `From: ${o.userEmail ?? "(unknown)"}${o.surveyId ? ` — project ${o.surveyId}` : ""}`,
    o.draft.reason ? `Why escalated: ${o.draft.reason}` : "",
    o.message ? `\nThe user's note:\n${o.message}` : "",
    `\nSubject: ${o.draft.subject}`,
  ];
  if (o.draft.diagnostics) {
    const d = o.draft.diagnostics as { summary?: string; findings?: { severity?: string; message?: string }[] };
    lines.push("\nSurvey check:", `  ${d.summary ?? ""}`, ...(d.findings ?? []).map((f) => `  - [${f.severity}] ${f.message}`));
  }
  if (o.draft.attempts.length) lines.push("\nTried so far:", ...o.draft.attempts.map((a, i) => `  ${i + 1}. ${LEVEL[a.level] ?? a.level}: ${a.reason}${a.sources.length ? ` (${a.sources.join("; ")})` : ""}`));
  if (o.context) lines.push("\nWhere the user was:", `  ${JSON.stringify(o.context).slice(0, 1500)}`);
  lines.push("\nConversation:", ...o.draft.transcript.map((t) => `${t.role === "user" ? "USER" : `HELP${t.level ? ` (${LEVEL[t.level]})` : ""}`}: ${t.text}`));
  return lines.filter((l) => l !== "").join("\n");
}

/** what the user is told will be shared, before they confirm */
export function sharedSummary(o: { turns: number; hasDiagnostics: boolean; attempts: number; hasContext: boolean }): string[] {
  return [
    `this conversation (${o.turns} message${o.turns === 1 ? "" : "s"})`,
    ...(o.attempts ? [`the ${o.attempts} answer${o.attempts === 1 ? "" : "s"} tried and how each was produced`] : []),
    ...(o.hasDiagnostics ? ["what the checks of your survey found"] : []),
    ...(o.hasContext ? ["where you were: the Studio tab, your survey's title and size, and the selected question"] : []),
    "your account e-mail, so the support team can reply",
  ];
}
