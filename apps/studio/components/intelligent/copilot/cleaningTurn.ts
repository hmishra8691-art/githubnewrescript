"use client";
import type { CleaningRequest } from "@rescript/engine";
import { rulesNamed } from "@rescript/quality";

/**
 * A CLEANING TURN IN THE COPILOT (IM6, 2026-11-06). The engine read the sentence into a request; this turns it into
 * criteria (the words → rule families by `rulesNamed`), asks the server for the PROPOSAL (every match with the flags
 * that put it there), and — only when the researcher presses Apply — applies it as one batch that Undo reverses. With
 * `judge`, the model's reading of the open ends runs first (gated, informational evidence) so the proposal can use it.
 */
export interface CleaningCard {
  request: CleaningRequest;
  status: "preview" | "applying" | "applied" | "undone" | "failed" | "answered";
  title: string;
  lines: string[];
  matches: { sessionId: string; because: string[] }[];
  matchCount: number;
  criteria?: Record<string, unknown>;
  environment?: string;
  batch?: string;
  error?: string;
}
type Post = (body: Record<string, unknown>) => Promise<{ ok: boolean; status: number; data: any }>;
const poster = (surveyId: string, path: string): Post => async (body) => {
  const r = await fetch(`/api/surveys/${surveyId}/quality/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
};

export function criteriaOf(req: CleaningRequest): Record<string, unknown> {
  const rules = req.words ? rulesNamed(req.words) : [];
  if (req.judge && !rules.some((r) => r.startsWith("openend."))) rules.push("openend.model");
  if (req.judge && /gibberish|nonsense|off[-\s]topic|irrelevant|generic|ai/i.test(req.words ?? "")) rules.push("openend.model");
  return { decision: req.decision ?? "REVIEW_LATER", ...(rules.length ? { rules: [...new Set(rules)] } : {}), ...(req.verdicts ? { verdicts: req.verdicts } : {}), ...(req.recommendation ? { recommendation: req.recommendation } : {}) };
}

export async function cleaningTurn(surveyId: string, req: CleaningRequest): Promise<{ card: CleaningCard; said: string }> {
  const fail = (title: string, error: string): { card: CleaningCard; said: string } => ({ card: { request: req, status: "failed", title, lines: [], matches: [], matchCount: 0, error }, said: error });
  if (surveyId === "sandbox") return fail("Cleaning", "The sandbox has no stored responses to clean. Open a survey with fieldwork and ask there.");
  const bulk = poster(surveyId, "bulk");
  if (req.explain) {
    const r = await bulk({ action: "explain", ref: req.explain });
    if (!r.ok) return fail(`Response ${req.explain}`, r.data?.error ?? `The response could not be read (HTTP ${r.status}).`);
    const e = r.data.explain;
    const q = e.quality;
    const lines = q ? [
      `${q.verdict} · ${q.recommendation} · risk ${q.risk}, quality ${q.score}${q.because ? ` — ${q.because}` : ""}`,
      ...q.flags.map((f: any) => `${f.role === "informational" ? "(informational) " : ""}${f.title} — ${f.observed}${f.expected ? ` (expected ${f.expected})` : ""}${f.caveat ? ` · ${f.caveat}` : ""}`),
      ...(e.review ? [`Decided by ${e.review.by ?? "a person"}: ${e.review.status}${e.review.reason ? ` (${e.review.reason})` : ""}`] : []),
    ] : ["This response has no quality assessment yet — the five-minute sweep assesses it."];
    return { card: { request: req, status: "answered", title: `Response ${e.respondentCode ?? e.sessionId.slice(0, 8)}`, lines, matches: [], matchCount: 0 }, said: lines[0] };
  }
  const pre: string[] = [];
  if (req.judge) {
    const j = await poster(surveyId, "open-ends")({ ...(req.environment ? { environment: req.environment } : {}) });
    if (!j.ok) pre.push(`The model's reading of the open ends did not run: ${j.data?.error ?? `HTTP ${j.status}`}. The proposal uses the rules alone.`);
    else if (j.data?.sent) pre.push(`The model (${j.data.model}) read ${j.data.sent} open-ended answers: ${j.data.judged} judgements kept${j.data.dropped ? `, ${j.data.dropped} dropped by the gate (${(j.data.droppedReasons ?? []).join("; ")})` : ""} — ${Object.entries(j.data.verdicts ?? {}).map(([k, v]) => `${k.replace("_", " ")} ${v}`).join(", ") || "no verdicts"}. Stored as informational evidence.`);
    else if (j.data?.note) pre.push(j.data.note);
  }
  const criteria = criteriaOf(req);
  const r = await bulk({ action: "preview", criteria, ...(req.environment ? { environment: req.environment } : {}) });
  if (!r.ok) return fail("Cleaning", r.data?.error ?? `The proposal could not be built (HTTP ${r.status}).`);
  const p = r.data.proposal;
  const card: CleaningCard = { request: req, status: p.matchCount ? "preview" : "answered", title: `${p.environment} responses — ${criteria.decision === "REMOVE" ? "exclude" : criteria.decision === "KEEP" ? "keep" : "mark for review"}`, lines: [...pre, ...p.lines], matches: p.matches.map((m: any) => ({ sessionId: m.sessionId, because: m.because })), matchCount: p.matchCount, criteria, environment: p.environment };
  return { card, said: [...pre, p.lines[0]].join(" ") };
}

export async function applyCleaning(surveyId: string, card: CleaningCard): Promise<CleaningCard> {
  const r = await poster(surveyId, "bulk")({ action: "apply", criteria: card.criteria, expect: card.matchCount, ...(card.environment === "TEST" ? { environment: "TEST" } : {}) });
  if (r.status === 409 && r.data?.proposal) return { ...card, status: r.data.proposal.matchCount ? "preview" : "answered", lines: [r.data.error, ...r.data.proposal.lines], matches: r.data.proposal.matches.map((m: any) => ({ sessionId: m.sessionId, because: m.because })), matchCount: r.data.proposal.matchCount };
  if (!r.ok) return { ...card, status: "failed", error: r.data?.error ?? `Not applied (HTTP ${r.status}). Nothing was changed.` };
  return { ...card, status: "applied", batch: r.data.batch, lines: [`Applied to ${r.data.applied} response${r.data.applied === 1 ? "" : "s"}${r.data.failed?.length ? ` (${r.data.failed.length} could not be written)` : ""}. Each decision is in the audit trail with this batch; Undo restores what was there before.`, ...card.lines.slice(-1)] };
}

export async function undoCleaning(surveyId: string, card: CleaningCard): Promise<CleaningCard> {
  if (!card.batch) return card;
  const r = await poster(surveyId, "bulk")({ action: "undo", batch: card.batch });
  if (!r.ok) return { ...card, error: r.data?.error ?? `Undo failed (HTTP ${r.status}).` };
  return { ...card, status: "undone", lines: [`Undone: ${r.data.restored} response${r.data.restored === 1 ? "" : "s"} back to their earlier decision.`] };
}
