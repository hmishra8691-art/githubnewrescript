import { NextRequest, NextResponse } from "next/server";
import { summarizeWallet, balanceLevel } from "@rescript/billing";
import { supabaseAdmin } from "@/lib/admin";
import { audit } from "@/lib/guard";
import { requireBillingAdmin, billingError } from "@/lib/billingAdmin";
import { projectMeterView } from "@/lib/billingView";

export const dynamic = "force-dynamic";

/**
 * WALLETS, for the administrator (billing brief §17, §20).
 *   GET   → every wallet with its project, owner, balance, state, level; ?survey=<id> → that project's full meter view + ledger
 *   POST  → { action: "ensure", surveyId } create the project's wallet if missing (so credits can be assigned before first use)
 *   PATCH → { walletId, state?, overdraftEnabled?, overdraftLimit?, sharedWalletId? }
 */
export async function GET(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  const surveyId = req.nextUrl.searchParams.get("survey");
  try {
    const cfg = await gate.meter.config();
    if (surveyId) {
      const wallets = await gate.meter.store.listWallets({});
      const w = wallets.find((x) => x.surveyId === surveyId) ?? null;
      const customerId = w?.customerId ?? (gate.sandbox ? "sandbox" : null);
      if (!customerId) return NextResponse.json({ ok: true, view: null });
      const view = await projectMeterView(gate.meter, { customerId, surveyId }, { recent: 200, audience: "admin" });
      return NextResponse.json({ ok: true, view, requests: await gate.meter.store.listCreditRequests({ surveyId }) });
    }
    const wallets = await gate.meter.store.listWallets({});
    let projects: Record<string, { code: string; title: string; status: string; owner: string | null; customer: string | null }> = {};
    if (!gate.sandbox && wallets.length) {
      const db = supabaseAdmin();
      /* survey policies only — an interview policy's `surveyId` is null, and a
         null in an `in ('…')` list asks `surveys` about nothing */
      const policyIds = (await gate.meter.store.listSpending({}))
        .map((p) => p.surveyId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      const ids = [...new Set([...wallets.map((w) => w.surveyId).filter(Boolean) as string[], ...policyIds])];
      const { data } = await db.from("surveys").select("id, code, title, status, owner_id, customer_id, profiles:owner_id(full_name, email), customers:customer_id(name)").in("id", ids);
      for (const r of (data ?? []) as any[]) projects[r.id] = { code: r.code, title: r.title, status: r.status, owner: r.profiles?.full_name ?? r.profiles?.email ?? null, customer: r.customers?.name ?? null };
      const userIds = wallets.map((w) => w.userId).filter(Boolean) as string[];
      if (userIds.length) {
        const { data: ps } = await db.from("profiles").select("id, user_code, full_name, email").in("id", userIds);
        for (const p of (ps ?? []) as any[]) projects[`user:${p.id}`] = { code: p.user_code, title: `Personal wallet — ${p.full_name || p.email}`, status: "", owner: p.full_name || p.email, customer: null };
      }
    }
    const rows = await Promise.all(wallets.map(async (w) => {
      const events = await gate.meter.store.listUsage({ walletId: w.id, limit: 5000 });
      const ledger = await gate.meter.store.listLedger(w.id, 500);
      const s = summarizeWallet(w, ledger, events, cfg);
      return {
        id: w.id, surveyId: w.surveyId, customerId: w.customerId, sharedWalletId: w.sharedWalletId, currency: w.currency,
        project: w.surveyId
          ? projects[w.surveyId] ?? (gate.sandbox ? { code: w.surveyId === "sandbox" ? "SANDBOX" : w.surveyId.toUpperCase(), title: w.surveyId === "sandbox" ? "Sandbox project" : `Sandbox project ${w.surveyId}`, status: "draft", owner: null, customer: null } : null)
          : w.userId
            ? projects[`user:${w.userId}`] ?? { code: "—", title: `Personal wallet — ${gate.sandbox ? w.userId : "user"}`, status: "", owner: null, customer: null }
            : { code: "—", title: "Workspace wallet", status: "", owner: null, customer: null },
        userId: w.userId,
        balance: w.balance, reserved: w.reserved, totalAdded: w.totalAdded, totalUsed: w.totalUsed, state: s.state, level: balanceLevel(w.balance, cfg),
        overdraftEnabled: w.overdraftEnabled, overdraftLimit: w.overdraftLimit, usage: s.usage, costs: s.costs, events: events.length, updatedAt: w.updatedAt,
      };
    }));
    /*
     * PROJECT SPENDING, beside the wallets.
     *
     * Under the central-wallet model a project has no balance to list, so a
     * table of wallets no longer answers "what is this study costing and what
     * is it allowed to cost". These rows do: one per project with a policy,
     * carrying what it has spent, its limit and whether its own rule has
     * stopped it.
     */
    const policies = await gate.meter.store.listSpending({});

    /*
     * The interview projects among them, by id. One query rather than one per
     * row, and skipped entirely when there are no interview policies — which
     * is every installation that has not enabled the second product.
     */
    const interviewIds = policies.filter((p) => p.subjectKind === "interview").map((p) => p.subjectId);
    const interviewProjects: Record<string, { code: string; title: string; status: string; owner: string | null; customer: string | null }> = {};
    if (interviewIds.length && !gate.sandbox) {
      const { data: ivp } = await supabaseAdmin()
        .from("interview_projects")
        .select("id, code, name, status, customer_id, profiles:owner_id(full_name, email), customers:customer_id(name)")
        .in("id", interviewIds);
      /* the same joins the survey rows use, so the Owner column is not blank for
         half the table */
      for (const row of (ivp ?? []) as any[]) {
        interviewProjects[row.id] = {
          code: row.code, title: row.name, status: row.status,
          owner: row.profiles?.full_name ?? row.profiles?.email ?? null,
          customer: row.customers?.name ?? null,
        };
      }
    }
    const spending = policies.map((p) => ({
      subjectKind: p.subjectKind,
      surveyId: p.surveyId,
      subjectId: p.subjectId,
      /*
       * A survey's name comes from `projects`; an interview project's from its
       * own table. Looking up both is the difference between an administrator
       * seeing "Beverage study · spent $4.10" and a blank row with a uuid — and
       * a blank row is exactly what this view existed to replace.
       */
      project: p.subjectKind === "interview"
        ? interviewProjects[p.subjectId] ?? null
        : p.surveyId ? projects[p.surveyId] ?? null : null,
      mode: p.mode, limit: p.budgetLimit, spent: p.spent, reserved: p.reserved,
      state: p.state, frozenAt: p.frozenAt,
    })).sort((a, b) => b.spent - a.spent);

    return NextResponse.json({
      ok: true, wallets: rows, spending,
      pendingRequests: (await gate.meter.store.listCreditRequests({ status: "pending" })).length,
    });
  } catch (e) { return billingError(e); }
}

export async function POST(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  /*
   * An administrator setting a project's limit. Same function as the owner's
   * control, so there is one rule and one place it is enforced — the
   * difference is only who is allowed to reach it.
   */
  /*
   * `subjectId` is the name now, because the subject may be an interview
   * project — `surveyId` is kept working for anything that still sends it, and
   * means the same thing it always did.
   */
  const subjectId = typeof body?.subjectId === "string" ? body.subjectId
    : typeof body?.surveyId === "string" ? body.surveyId : null;
  const subjectKind = body?.subjectKind === "interview" ? "interview" : "survey";

  if (body?.action === "set_spending" && subjectId) {
    try {
      let customerId = "sandbox";
      if (!gate.sandbox) {
        /* the subject's own table — an interview project is not in `surveys` */
        const table = subjectKind === "interview" ? "interview_projects" : "surveys";
        const { data } = await supabaseAdmin().from(table).select("customer_id").eq("id", subjectId).maybeSingle();
        if (!data) return NextResponse.json({ error: "Unknown project." }, { status: 404 });
        customerId = data.customer_id;
      }
      const mode = String(body?.mode ?? "shared");
      const limit = body?.limit == null ? null : Number(body.limit);
      const spending = await gate.meter.setSpending(subjectId, customerId, { mode: mode as never, budgetLimit: limit, subjectKind });
      if (gate.user) {
        await audit({
          action: "billing.project_budget_changed", userId: gate.user.userId, sessionId: gate.user.sessionId, customerId: gate.user.customerId,
          surveyId: body.surveyId, entity: "project_spending", entityId: body.surveyId,
          detail: { mode, limit: spending.budgetLimit, spent: spending.spent, state: spending.state, byAdmin: true },
        });
      }
      return NextResponse.json({ ok: true, spending });
    } catch (e) { return billingError(e); }
  }

  if (body?.action !== "ensure" || typeof body?.surveyId !== "string") return NextResponse.json({ error: "action ensure or set_spending, and surveyId, are required" }, { status: 400 });
  try {
    let customerId = "sandbox";
    if (!gate.sandbox) {
      const { data } = await supabaseAdmin().from("surveys").select("customer_id").eq("id", body.surveyId).maybeSingle();
      if (!data) return NextResponse.json({ error: "Unknown project." }, { status: 404 });
      customerId = data.customer_id;
    }
    const wallet = await gate.meter.walletFor({ customerId, surveyId: body.surveyId }, true);
    return NextResponse.json({ ok: true, wallet });
  } catch (e) { return billingError(e); }
}

export async function PATCH(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (typeof body?.walletId !== "string") return NextResponse.json({ error: "walletId is required" }, { status: 400 });
  const patch: Record<string, unknown> = {};
  if (["active", "suspended"].includes(body?.state)) patch.state = body.state;
  if (typeof body?.overdraftEnabled === "boolean" || body?.overdraftEnabled === null) patch.overdraftEnabled = body.overdraftEnabled;
  if (typeof body?.overdraftLimit === "number" || body?.overdraftLimit === null) patch.overdraftLimit = body.overdraftLimit;
  if (typeof body?.sharedWalletId === "string" || body?.sharedWalletId === null) patch.sharedWalletId = body.sharedWalletId;
  if (!Object.keys(patch).length) return NextResponse.json({ error: "nothing to change" }, { status: 400 });
  try {
    const wallet = await gate.meter.store.setWallet(body.walletId, patch);
    if (gate.user) await audit({ action: "billing.wallet_changed", userId: gate.user.userId, sessionId: gate.user.sessionId, customerId: gate.user.customerId, surveyId: wallet.surveyId ?? undefined, entity: "wallet", entityId: wallet.id, detail: patch });
    return NextResponse.json({ ok: true, wallet });
  } catch (e) { return billingError(e); }
}
