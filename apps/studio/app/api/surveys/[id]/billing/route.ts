import { NextRequest, NextResponse } from "next/server";
import { SPENDING_MODES, type SpendingMode } from "@rescript/billing";
import { can } from "@rescript/access";
import { isFailure, requireProject, audit } from "@/lib/guard";
import { getMeter, getSandboxMeter, isSandboxProject, meterContextFor, projectContext } from "@/lib/metering";
import { projectMeterView, stripInternalCosts } from "@/lib/billingView";

export const dynamic = "force-dynamic";

/**
 * THE PROJECT'S USAGE / METER SECTION (billing brief §10–§13, §18).
 *
 *   GET  /api/surveys/[id]/billing            wallet, usage by category, timeline, recent usage, forecast, thresholds
 *   POST /api/surveys/[id]/billing            { action: "request_credits", amount, reason, message } → a pending credit request
 *
 * `billing.read` to look, `billing.request_credits` to ask. The sandbox
 * project (`/sandbox`) reads the in-memory meter without a session so the
 * tab can be seen and tested without a database.
 *
 * AUDIENCE (change 2): a researcher receives the "user" view — charges,
 * balance, usage, never a cost, fee or margin; a platform administrator
 * opening the same tab receives the full view. The split happens in
 * `projectMeterView` and the user payload is additionally passed through
 * `stripInternalCosts`, so a future field cannot leak by omission.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (isSandboxProject(params.id)) {
    const view = await projectMeterView(getSandboxMeter(), meterContextFor(null, "sandbox"), { audience: "user" });
    return NextResponse.json(stripInternalCosts({ ok: true, sandbox: true, ...view, canBudget: true, requests: await getSandboxMeter().store.listCreditRequests({ surveyId: "sandbox" }) }));
  }
  const gate = await requireProject(req, params.id, "billing.read");
  if (isFailure(gate)) return gate.response;
  const meter = getMeter();
  const ctx = projectContext(gate);
  try {
    const audience = gate.user.isPlatformAdmin ? "admin" : "user";
    const view = await projectMeterView(meter, ctx, { audience });
    const requests = await meter.store.listCreditRequests({ surveyId: params.id });
    const payload = {
      ok: true, sandbox: false, ...view, requests: requests.slice(0, 20),
      canRequest: gate.role != null && ["owner", "editor"].includes(gate.role),
      /* the owner decides what this project may take from their wallet */
      canBudget: can(gate.role, "billing.set_budget") || gate.user.isPlatformAdmin,
    };
    return NextResponse.json(audience === "admin" ? payload : stripInternalCosts(payload));
  } catch (e) {
    const msg = (e as Error).message;
    // migration 0023 not applied yet: the section says so rather than failing the Studio
    const status = /relation .* does not exist|function .* does not exist|schema cache/i.test(msg) ? 501 : 503;
    return NextResponse.json({ error: status === 501 ? "Metered usage is not enabled on this installation yet (migration 0023)." : msg, code: status === 501 ? "billing_unavailable" : "billing_error" }, { status });
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  /*
   * HOW MUCH OF THE OWNER'S WALLET THIS PROJECT MAY SPEND.
   *
   *   POST { action: "set_spending", mode: "shared"|"budget"|"priority", limit? }
   *
   * Moves no money, which is the whole model: a project holds a permission
   * against a wallet, not a pot of its own. Raising a limit releases a
   * project that had frozen itself, in the same operation, because a person
   * who has just granted more room should not have to find a second switch.
   */
  if (body?.action === "set_spending") {
    const mode = String(body?.mode ?? "");
    if (!SPENDING_MODES.includes(mode as never)) {
      return NextResponse.json({ error: `mode must be one of: ${SPENDING_MODES.join(", ")}` }, { status: 400 });
    }
    const limit = body?.limit == null ? null : Number(body.limit);
    if (mode === "budget" && (!Number.isFinite(limit) || (limit as number) < 0 || (limit as number) > 1_000_000)) {
      return NextResponse.json({ error: "a budget needs a limit of zero or more" }, { status: 400 });
    }
    if (isSandboxProject(params.id)) {
      const spending = await getSandboxMeter().setSpending("sandbox", "sandbox", { mode: mode as SpendingMode, budgetLimit: limit ?? null });
      return NextResponse.json({ ok: true, spending });
    }
    const gate = await requireProject(req, params.id, "billing.set_budget");
    if (isFailure(gate)) return gate.response;
    const ctx = projectContext(gate);
    const spending = await getMeter().setSpending(params.id, ctx.customerId, { mode: mode as SpendingMode, budgetLimit: limit ?? null });
    await audit({
      action: "billing.project_budget_changed", userId: gate.user.userId, sessionId: gate.user.sessionId,
      surveyId: params.id, customerId: gate.user.customerId, entity: "project_spending", entityId: params.id,
      detail: { mode, limit: spending.budgetLimit, spent: spending.spent, state: spending.state },
    });
    return NextResponse.json({ ok: true, spending });
  }

  if (body?.action !== "request_credits") return NextResponse.json({ error: "unknown action" }, { status: 400 });
  const amount = Number(body?.amount);
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 200) : "";
  const message = typeof body?.message === "string" ? body.message.trim().slice(0, 2000) : "";
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
  if (!reason) return NextResponse.json({ error: "a reason is required" }, { status: 400 });

  if (isSandboxProject(params.id)) {
    const meter = getSandboxMeter();
    const wallet = await meter.walletFor(meterContextFor(null, "sandbox"), true);
    const r = await meter.store.createCreditRequest({ customerId: "sandbox", surveyId: "sandbox", walletId: wallet?.id ?? null, userId: "sandbox-user", requestedAmount: amount, reason, message: message || null });
    return NextResponse.json({ ok: true, request: r });
  }
  const gate = await requireProject(req, params.id, "billing.request_credits");
  if (isFailure(gate)) return gate.response;
  const meter = getMeter();
  const ctx = projectContext(gate);
  const wallet = await meter.walletFor(ctx, true);
  const r = await meter.store.createCreditRequest({ customerId: ctx.customerId, surveyId: params.id, walletId: wallet?.id ?? null, userId: gate.user.userId, requestedAmount: amount, reason, message: message || null });
  await audit({ action: "billing.credit_requested", userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId: params.id, customerId: gate.user.customerId, entity: "credit_request", entityId: r.id, detail: { amount, reason } });
  return NextResponse.json({ ok: true, request: r });
}
