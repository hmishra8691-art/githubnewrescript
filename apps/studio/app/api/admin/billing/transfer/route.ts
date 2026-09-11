import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { audit } from "@/lib/guard";
import { requireBillingAdmin, billingError } from "@/lib/billingAdmin";

export const dynamic = "force-dynamic";

/**
 * CREDIT TRANSFERS (billing update, change 1) — administrators only.
 *
 *   POST /api/admin/billing/transfer
 *        { source: { type: "user" | "project", id }, destination: { type, id }, amount, reason?, note? }
 *        → { ok, transfer, source, destination }   402 when the available balance is short
 *   POST … { action: "reverse", transferId, note }  → a NEW reversal transfer; the original is marked, never edited
 *   GET  /api/admin/billing/transfer?user=&project=&admin=&status=&from=&to=&min=&max=
 *        → history with names resolved
 *
 * Rules enforced by the store (one SQL transaction, both wallets locked):
 * only `balance − reserved` may move; source and destination change
 * together or not at all; two ledger lines share the transfer id.
 */
type Ref = { type: "user" | "project"; id: string };

function parseRef(v: unknown): Ref | null {
  if (!v || typeof v !== "object") return null;
  const t = (v as { type?: unknown }).type, id = (v as { id?: unknown }).id;
  return (t === "user" || t === "project") && typeof id === "string" && id.trim() ? { type: t, id: id.trim() } : null;
}

export async function POST(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const by = gate.user?.userId ?? null;
  try {
    if (body?.action === "reverse") {
      const id = typeof body?.transferId === "string" ? body.transferId : "";
      const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 2000) : "";
      if (!id || !note) return NextResponse.json({ error: "transferId and a note are required" }, { status: 400 });
      const r = await gate.meter.reverseTransfer(id, by, note);
      if (!r.ok) return NextResponse.json({ error: r.message, code: `transfer_${r.reason}` }, { status: r.reason === "insufficient_available" ? 402 : 409 });
      if (gate.user) await audit({ action: "billing.transfer_reversed", userId: gate.user.userId, sessionId: gate.user.sessionId, customerId: gate.user.customerId, entity: "credit_transfer", entityId: r.transfer.id, detail: { reversalOf: id, amount: r.transfer.amount, note } });
      return NextResponse.json({ ok: true, transfer: r.transfer, source: r.source, destination: r.destination });
    }
    const source = parseRef(body?.source), destination = parseRef(body?.destination);
    const amount = Number(body?.amount);
    if (!source || !destination) return NextResponse.json({ error: "source and destination ({ type: user | project, id }) are required" }, { status: 400 });
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
    const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 200) || null : null;
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, 2000) || null : null;
    const resolve = async (ref: Ref, create: boolean) => {
      let customerId = "sandbox";
      if (!gate.sandbox) {
        const db = supabaseAdmin();
        if (ref.type === "project") {
          const { data } = await db.from("surveys").select("customer_id").eq("id", ref.id).maybeSingle();
          if (!data) return null; customerId = data.customer_id;
        } else {
          const { data } = await db.from("profiles").select("customer_id").eq("id", ref.id).maybeSingle();
          if (!data) return null; customerId = data.customer_id ?? (gate.user?.customerId ?? "");
        }
      }
      return ref.type === "project" ? gate.meter.walletFor({ customerId, surveyId: ref.id }, create) : gate.meter.store.walletForUser(customerId, ref.id, { create });
    };
    const src = await resolve(source, false);
    if (!src) return NextResponse.json({ error: `The source ${source.type} has no wallet, or does not exist.` }, { status: 404 });
    const dst = await resolve(destination, true);
    if (!dst) return NextResponse.json({ error: `The destination ${destination.type} does not exist.` }, { status: 404 });
    const r = await gate.meter.transfer({ sourceWalletId: src.id, destinationWalletId: dst.id, amount, reason, note, by });
    if (!r.ok) return NextResponse.json({ error: r.message, code: `transfer_${r.reason}`, available: r.available ?? null }, { status: r.reason === "insufficient_available" ? 402 : 400 });
    if (gate.user) await audit({ action: "billing.credits_transferred", userId: gate.user.userId, sessionId: gate.user.sessionId, customerId: gate.user.customerId, entity: "credit_transfer", entityId: r.transfer.id, detail: { code: r.transfer.code, source, destination, amount, reason, note } });
    return NextResponse.json({ ok: true, transfer: r.transfer, source: r.source, destination: r.destination });
  } catch (e) { return billingError(e); }
}

export async function GET(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  const q = req.nextUrl.searchParams;
  const num = (k: string) => { const v = q.get(k); const n = v == null || v === "" ? null : Number(v); return n != null && Number.isFinite(n) ? n : undefined; };
  try {
    const list = await gate.meter.store.listTransfers({
      ref: q.get("project") || q.get("user") || undefined, adminId: q.get("admin") || undefined,
      status: (q.get("status") as "completed" | "reversed" | null) || undefined,
      since: q.get("from") ? new Date(q.get("from")!).toISOString() : undefined,
      until: q.get("to") ? new Date(new Date(q.get("to")!).getTime() + 86_400_000).toISOString() : undefined,
      minAmount: num("min"), maxAmount: num("max"), limit: 500,
    });
    // names for the history table
    const names: Record<string, string> = {};
    if (gate.sandbox) {
      Object.assign(names, { sandbox: "Sandbox project", "sandbox-b": "Second sandbox project", "sandbox-user": "Sandbox user", "sandbox-user-2": "Second sandbox user", "sandbox-admin": "Sandbox administrator" });
    } else if (list.length) {
      const db = supabaseAdmin();
      const refs = [...new Set(list.flatMap((t) => [t.sourceRef, t.destinationRef, t.transferredBy]).filter(Boolean) as string[])];
      const [{ data: ss }, { data: ps }] = await Promise.all([db.from("surveys").select("id, code, title").in("id", refs), db.from("profiles").select("id, full_name, email, user_code").in("id", refs)]);
      for (const s of ss ?? []) names[s.id] = `${s.title} · ${s.code}`;
      for (const p of ps ?? []) names[p.id] = p.full_name || p.email || p.user_code;
    }
    const label = (kind: string, ref: string | null) => (ref ? names[ref] ?? (kind === "workspace" ? "Workspace wallet" : ref) : kind === "workspace" ? "Workspace wallet" : "—");
    return NextResponse.json({
      ok: true,
      transfers: list.map((t) => ({ ...t, sourceLabel: label(t.sourceKind, t.sourceRef), destinationLabel: label(t.destinationKind, t.destinationRef), adminLabel: t.transferredBy ? names[t.transferredBy] ?? t.transferredBy : (gate.sandbox ? "Sandbox administrator" : "—") })),
    });
  } catch (e) { return billingError(e); }
}
