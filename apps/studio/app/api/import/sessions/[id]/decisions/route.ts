import { NextRequest, NextResponse } from "next/server";
import type { Decision } from "@rescript/import";
import { callerFrom, canSee, notFound } from "@/lib/import/sessionAccess";
import { importSessionStore } from "@/lib/import/sessionsServer";
import { digestReport } from "@/lib/import/sessions";
import { reanalyze } from "@/lib/import/reanalyze";
import { isFailure, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * ANSWER AN IMPORT'S OPEN QUESTIONS (I5). Body: `{ decisions: Decision[] }` — each the structured answer to one
 * clarification (the recommended one, an alternative, or "leave it"). The session remembers every decision
 * (a later answer to the same question replaces the earlier one); the import is re-analysed from its stored
 * model with all of them and the new preview is returned: definition, report (with the questions still open),
 * map, verification, and which decisions were applied or refused (with the reason). Nothing is written to a
 * project — applying the import is still Create project / Add to this survey.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const store = importSessionStore();
  const s = await store.get(params.id).catch(() => null);
  if (isFailure(authed) && !(s && s.customerId === null)) return authed.response;
  const caller = callerFrom(authed, !!s && s.customerId === null);
  if ("response" in caller) return caller.response;
  if (!s || !canSee(s, caller)) return notFound();
  let body: { decisions?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const decisions = Array.isArray(body.decisions) ? (body.decisions as Decision[]).filter((d) => d && typeof d === "object" && typeof d.id === "string" && typeof d.type === "string").slice(0, 500) : null;
  if (!decisions) return NextResponse.json({ error: "decisions must be a list" }, { status: 400 });
  const r = reanalyze(s, decisions);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  await store.update(s.id, { decisions: r.decisions, reportDigest: digestReport(r.report) });
  return NextResponse.json({ ok: r.report.ok, definition: r.definition, report: r.report, mapping: r.mapping, confidence: r.confidence, verification: r.verification, applied: r.applied, rejected: r.rejected, decisions: r.decisions.length });
}
