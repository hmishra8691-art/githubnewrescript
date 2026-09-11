import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { audit } from "@/lib/guard";
import { requireBillingAdmin, billingError } from "@/lib/billingAdmin";

export const dynamic = "force-dynamic";

/**
 * CREDIT REQUESTS (billing brief §18).
 *   GET  ?status=pending|approved|rejected  → requests, with project and requester names
 *   POST { id, decision: "approve" | "reject", amount?, note? } → decide; approval credits the wallet through the ledger
 */
export async function GET(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  const status = req.nextUrl.searchParams.get("status") as "pending" | "approved" | "rejected" | null;
  try {
    const list = await gate.meter.store.listCreditRequests(status ? { status } : {});
    let names: Record<string, string> = {}, projects: Record<string, { code: string; title: string }> = {};
    if (!gate.sandbox && list.length) {
      const db = supabaseAdmin();
      const { data: ps } = await db.from("profiles").select("id, full_name, email").in("id", [...new Set(list.map((r) => r.userId))]);
      for (const p of ps ?? []) names[p.id] = p.full_name || p.email || p.id;
      const { data: ss } = await db.from("surveys").select("id, code, title").in("id", [...new Set(list.map((r) => r.surveyId).filter(Boolean) as string[])]);
      for (const s of ss ?? []) projects[s.id] = { code: s.code, title: s.title };
    }
    return NextResponse.json({ ok: true, requests: list.map((r) => ({ ...r, requester: names[r.userId] ?? (gate.sandbox ? "Sandbox user" : r.userId), project: r.surveyId ? projects[r.surveyId] ?? (gate.sandbox ? { code: "SANDBOX", title: "Sandbox project" } : null) : null })) });
  } catch (e) { return billingError(e); }
}

export async function POST(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const id = typeof body?.id === "string" ? body.id : "";
  const decision = body?.decision === "approve" ? "approved" : body?.decision === "reject" ? "rejected" : null;
  if (!id || !decision) return NextResponse.json({ error: "id and decision (approve | reject) are required" }, { status: 400 });
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 2000) : null;
  try {
    const all = await gate.meter.store.listCreditRequests({});
    const r = all.find((x) => x.id === id);
    if (!r) return NextResponse.json({ error: "Unknown request." }, { status: 404 });
    if (r.status !== "pending") return NextResponse.json({ error: "This request was already decided." }, { status: 409 });
    const amount = decision === "approved" ? (typeof body?.amount === "number" && body.amount > 0 ? body.amount : r.requestedAmount) : null;
    const decided = await gate.meter.store.decideCreditRequest(id, { status: decision, by: gate.user?.userId ?? "sandbox-admin", amount, note });
    let wallet = null;
    if (decision === "approved" && amount) {
      const walletId = r.walletId ?? (await gate.meter.walletFor({ customerId: r.customerId, surveyId: r.surveyId }, true))?.id;
      if (walletId) ({ wallet } = await gate.meter.credit(walletId, amount, { reason: "credit_request_approved", note: note ?? `Request ${r.id}`, by: gate.user?.userId ?? null }));
    }
    if (gate.user) await audit({ action: "billing.credit_request_decided", userId: gate.user.userId, sessionId: gate.user.sessionId, customerId: gate.user.customerId, surveyId: r.surveyId ?? undefined, entity: "credit_request", entityId: id, detail: { decision, amount, note } });
    return NextResponse.json({ ok: true, request: decided, wallet });
  } catch (e) { return billingError(e); }
}
