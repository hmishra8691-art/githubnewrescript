import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { requireBillingAdmin, billingError } from "@/lib/billingAdmin";

export const dynamic = "force-dynamic";

/**
 * WHO AND WHAT A TRANSFER CAN NAME (billing update, change 1): every person
 * and every project on the installation, with their current wallet balance
 * and available (unreserved) balance when a wallet exists, so the transfer
 * form can list them and show "Available balance" before anything is typed.
 * Projects carry their owner so "User B's projects" can be offered as
 * destinations. Administrators only; balances, never keys or costs.
 */
export async function GET(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  try {
    const wallets = await gate.meter.store.listWallets({});
    const byProject = new Map(wallets.filter((w) => w.surveyId).map((w) => [w.surveyId!, w]));
    const byUser = new Map(wallets.filter((w) => w.userId).map((w) => [w.userId!, w]));
    const bal = (w?: { balance: number; reserved: number; id: string; currency: string; state: string }) => (w ? { walletId: w.id, balance: w.balance, available: Math.max(0, Math.round((w.balance - w.reserved) * 1e6) / 1e6), currency: w.currency, state: w.state } : null);
    if (gate.sandbox) {
      return NextResponse.json({
        ok: true,
        users: [{ id: "sandbox-user", code: "USR-SANDBOX", name: "Sandbox user", email: "sandbox@example.test", wallet: bal(byUser.get("sandbox-user")) }, { id: "sandbox-user-2", code: "USR-SANDBOX2", name: "Second sandbox user", email: "second@example.test", wallet: bal(byUser.get("sandbox-user-2")) }],
        projects: [{ id: "sandbox", code: "SANDBOX", title: "Sandbox project", status: "draft", ownerId: "sandbox-user", wallet: bal(byProject.get("sandbox")) }, { id: "sandbox-b", code: "SANDBOX-B", title: "Second sandbox project", status: "draft", ownerId: "sandbox-user-2", wallet: bal(byProject.get("sandbox-b")) }],
      });
    }
    const db = supabaseAdmin();
    const [{ data: profiles }, { data: surveys }] = await Promise.all([
      db.from("profiles").select("id, user_code, full_name, email, status").order("full_name"),
      db.from("surveys").select("id, code, title, status, owner_id").order("title"),
    ]);
    return NextResponse.json({
      ok: true,
      users: (profiles ?? []).filter((p: any) => p.status !== "disabled").map((p: any) => ({ id: p.id, code: p.user_code, name: p.full_name || p.email, email: p.email, wallet: bal(byUser.get(p.id)) })),
      projects: (surveys ?? []).map((s: any) => ({ id: s.id, code: s.code, title: s.title, status: s.status, ownerId: s.owner_id, wallet: bal(byProject.get(s.id)) })),
    });
  } catch (e) { return billingError(e); }
}
