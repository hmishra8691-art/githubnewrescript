import { NextRequest, NextResponse } from "next/server";
import type { Decision } from "@rescript/import";
import { callerFrom, canSee, notFound } from "@/lib/import/sessionAccess";
import { importSessionStore } from "@/lib/import/sessionsServer";
import { applyReviewAcceptance } from "@/lib/import/sessions";
import { reanalyze } from "@/lib/import/reanalyze";
import { isFailure, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * THE SIDE-BY-SIDE REVIEW'S ACCEPTANCE, KEPT WITH THE IMPORT (I6, migration 0113).
 *
 *   GET                                   what is accepted now (against the current comparison), and what was dropped
 *                                         because the question changed since it was accepted
 *   POST { accept?: id[], unaccept?: id[] }   accept or un-accept questions (by source id); a question with a lost
 *                                         part or an unresolved reference is held, with why — the same rule as the
 *                                         bulk buttons
 *
 * The comparison is computed again from the stored model and the decisions made so far, so acceptance always refers
 * to what the import produces now. Who may call: whoever may see the import (its owner's workspace; the sandbox
 * fixture's anonymous session on a fake-provider Studio).
 */
type Authed = Awaited<ReturnType<typeof requireUser>>;
async function load(authed: Authed, id: string) {
  const store = importSessionStore(isFailure(authed) ? null : authed.customerId);
  const s = await store.get(id).catch(() => null);
  if (isFailure(authed) && !(s && s.customerId === null)) return { response: authed.response };
  const caller = callerFrom(authed, !!s && s.customerId === null);
  if ("response" in caller) return { response: caller.response };
  if (!s || !canSee(s, caller)) return { response: notFound() };
  if (!s.canonical) return { response: NextResponse.json({ error: "This import's reconstructed model was not kept, so its review cannot be compared again — import the file again." }, { status: 410 }) };
  const r = reanalyze(s, (s.decisions as Decision[]) ?? []);
  if ("error" in r) return { response: NextResponse.json({ error: r.error }, { status: r.status }) };
  return { s, store, pairs: r.report.sideBySide ?? [], by: isFailure(authed) ? null : authed.userId };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  /* a signed-out caller reaches only the sandbox fixture's anonymous import */
  if (isFailure(authed)) { const anon = await importSessionStore(null).get(params.id).catch(() => null); if (!anon || anon.customerId !== null) return authed.response; }
  const l = await load(authed, params.id);
  if ("response" in l) return l.response;
  const r = applyReviewAcceptance(l.s.reviewAccepted ?? [], l.pairs, {}, { by: l.by, at: new Date().toISOString() });
  return NextResponse.json({ accepted: r.accepted, dropped: r.dropped, total: l.pairs.length });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  if (isFailure(authed)) { const anon = await importSessionStore(null).get(params.id).catch(() => null); if (!anon || anon.customerId !== null) return authed.response; }
  const l = await load(authed, params.id);
  if ("response" in l) return l.response;
  let body: { accept?: unknown; unaccept?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 5000) : []);
  const r = applyReviewAcceptance(l.s.reviewAccepted ?? [], l.pairs, { accept: ids(body.accept), unaccept: ids(body.unaccept) }, { by: l.by, at: new Date().toISOString() });
  try { await l.store.update(l.s.id, { reviewAccepted: r.accepted }); }
  catch (e) { return NextResponse.json({ error: (e as Error).message, accepted: r.accepted, saved: false }, { status: /0113/.test((e as Error).message) ? 503 : 500 }); }
  return NextResponse.json({ accepted: r.accepted, held: r.held, dropped: r.dropped, saved: true, total: l.pairs.length });
}
