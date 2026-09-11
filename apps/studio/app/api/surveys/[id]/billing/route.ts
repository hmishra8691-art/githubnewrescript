import { NextRequest, NextResponse } from "next/server";
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
    return NextResponse.json(stripInternalCosts({ ok: true, sandbox: true, ...view, requests: await getSandboxMeter().store.listCreditRequests({ surveyId: "sandbox" }) }));
  }
  const gate = await requireProject(req, params.id, "billing.read");
  if (isFailure(gate)) return gate.response;
  const meter = getMeter();
  const ctx = projectContext(gate);
  try {
    const audience = gate.user.isPlatformAdmin ? "admin" : "user";
    const view = await projectMeterView(meter, ctx, { audience });
    const requests = await meter.store.listCreditRequests({ surveyId: params.id });
    const payload = { ok: true, sandbox: false, ...view, requests: requests.slice(0, 20), canRequest: gate.role != null && ["owner", "editor"].includes(gate.role) };
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
