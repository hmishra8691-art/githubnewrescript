import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireEditRightFor, requireProjectFor, requireUser, type AuthedUser, type GuardFailure } from "@/lib/guard";
import { coerceOperation, type OperationStore } from "@/lib/copilot/operations";
import { operationStoreFor } from "@/lib/copilot/operationsStore";

export const dynamic = "force-dynamic";

/**
 * THE INTELLIGENT MODE OPERATION HISTORY (Intelligent Mode upgrade, Phase 5;
 * migration 0047). Every Intelligent operation — an engine reading, a model
 * turn, a grammar proposal, a fix from a review — is a record here, and the
 * History tab reads them back, so the history survives a reload and its
 * numbering does not restart at #001.
 *
 *   GET   ?surveyId=            the survey's operations, newest first, WITHOUT
 *                               the surveys before / after → { operations, durable }
 *   GET   ?surveyId=&id=        one operation WITH before / after → { operation, durable }
 *   POST  { surveyId, prompt, source, status, intent, detected, targets,
 *           proposed, applied, excluded, failed, warnings, engineOps,
 *           apiCalls, statusDetail }                → { id, durable, warnings }
 *         (created as proposed / answered / refused / clarify / failed)
 *   PATCH { surveyId, id, status?, …the fields that come with it,
 *           before?, after?, savedRevision? }       → { operation, changeN, durable, warnings }
 *         The status moves only along the allowed transitions (409
 *         otherwise). The first move to `applied` assigns `change_n` — the
 *         survey's next AI change number (max + 1, retried once when another
 *         change took it at the same moment) — and returns it: that is the
 *         number the editor shows and the audit record carries.
 *
 * Every field is bounded by `coerceOperation` (prompt ≤ 4000, lists ≤ 200,
 * strings ≤ 500, surveys ≤ 2 MB and only once applied); what was cut or
 * dropped comes back in `warnings`.
 *
 * Who may call: reads need access to the project; writes need the edit
 * right — the same gate as the audit record (/api/copilot/record): only
 * whoever holds the editing lock is making the changes this describes. The
 * SANDBOX has no row and no session: its history is kept in this server's
 * memory, per browser tab — `scope`, a random key the tab keeps in
 * sessionStorage — so it survives a reload of that tab and two people
 * trying the sandbox on one server never see each other's history.
 *
 * `durable: false` says the records are in this server's memory: the sandbox,
 * or an installation that has not applied migration 0047 yet.
 */

type Gate = { store: OperationStore; key: string; surveyId: string; userId: string | null } | GuardFailure;

/** the caller's right to this survey's history, and the store and key that hold it */
async function gate(user: AuthedUser | GuardFailure, surveyId: string, scope: string | null, write: boolean): Promise<Gate> {
  if (surveyId === "sandbox") {
    const tab = scope && /^[A-Za-z0-9_-]{6,64}$/.test(scope) ? scope : "shared";
    return { store: await operationStoreFor("sandbox"), key: `sandbox:${tab}`, surveyId, userId: isFailure(user) ? null : user.userId };
  }
  if (isFailure(user)) return user;
  const ctx = await requireProjectFor(user, surveyId, write ? "survey.edit" : "project.read");
  if (isFailure(ctx)) return ctx;
  if (write) { const g = await requireEditRightFor(ctx); if (isFailure(g)) return g; }
  try {
    return { store: await operationStoreFor(surveyId), key: surveyId, surveyId, userId: user.userId };
  } catch (e) {
    return { response: NextResponse.json({ error: `The operation history could not be opened: ${(e as Error).message}` }, { status: 503 }) };
  }
}
const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  const sp = req.nextUrl.searchParams;
  const surveyId = sp.get("surveyId") ?? "";
  // no session: only the sandbox's history (which has no project to protect) may be read
  if (isFailure(user) && surveyId !== "sandbox") return user.response;
  const g = await gate(user, surveyId, sp.get("scope"), false);
  if ("response" in g) return g.response;
  const id = sp.get("id");
  try {
    if (id) {
      const operation = await g.store.get(g.key, id);
      return operation ? NextResponse.json({ ok: true, durable: g.store.durable, operation }) : bad("No such operation.", 404);
    }
    const limit = Math.min(200, Math.max(1, Number(sp.get("limit")) || 200));
    return NextResponse.json({ ok: true, durable: g.store.durable, operations: await g.store.list(g.key, limit) });
  } catch (e) { return bad(`The operation history could not be read: ${(e as Error).message}`, 500); }
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return isFailure(user) ? user.response : bad("bad json"); }
  const g = await gate(user, typeof body.surveyId === "string" ? body.surveyId : "", typeof body.scope === "string" ? body.scope : null, true);
  if ("response" in g) return g.response;
  const c = coerceOperation(body, "create");
  if (!c.ok) return bad(c.error);
  try {
    const rec = await g.store.create(g.key, c.value, { userId: g.userId, surveyId: g.surveyId });
    return NextResponse.json({ ok: true, id: rec.id, createdAt: rec.createdAt, durable: g.store.durable, warnings: c.warnings });
  } catch (e) { return bad(`The operation could not be recorded: ${(e as Error).message}`, 500); }
}

export async function PATCH(req: NextRequest) {
  const user = await requireUser(req);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return isFailure(user) ? user.response : bad("bad json"); }
  const g = await gate(user, typeof body.surveyId === "string" ? body.surveyId : "", typeof body.scope === "string" ? body.scope : null, true);
  if ("response" in g) return g.response;
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return bad("say which operation (id)");
  const c = coerceOperation(body, "update");
  if (!c.ok) return bad(c.error);
  try {
    const r = await g.store.update(g.key, id, c.value);
    if (!r.ok) return bad(r.error, r.status);
    const { before: _b, after: _a, ...operation } = r.record;
    return NextResponse.json({ ok: true, durable: g.store.durable, operation: { ...operation, hasBefore: !!r.record.before, hasAfter: !!r.record.after }, changeN: r.record.changeN, warnings: [...c.warnings, ...r.warnings] });
  } catch (e) { return bad(`The operation could not be updated: ${(e as Error).message}`, 500); }
}
