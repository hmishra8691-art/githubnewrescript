import { NextRequest, NextResponse } from "next/server";
import { BillingConfig, BILLING_CONFIG_FIELDS, DEFAULT_BILLING_CONFIG, depositProjection, priceOperation } from "@rescript/billing";
import { audit } from "@/lib/guard";
import { requireBillingAdmin, billingError } from "@/lib/billingAdmin";

export const dynamic = "force-dynamic";

/**
 * BILLING CONFIGURATION (billing brief §2, §13, §21).
 *   GET  → the effective configuration, its field table, the defaults, and a worked example
 *   PUT  → replace it (validated by the same schema the meter reads)
 */
export async function GET(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  try {
    gate.meter.invalidate();
    const cfg = await gate.meter.config();
    return NextResponse.json({ ok: true, config: cfg, defaults: DEFAULT_BILLING_CONFIG, fields: BILLING_CONFIG_FIELDS, example: { deposit100: depositProjection(100, cfg), cost10: priceOperation({ providerCost: 10 }, cfg), cost1: priceOperation({ providerCost: 1 }, cfg) } });
  } catch (e) { return billingError(e); }
}

export async function PUT(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const parsed = BillingConfig.safeParse(body?.config ?? body);
  if (!parsed.success) return NextResponse.json({ error: "invalid configuration", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const cfg = parsed.data;
  if (cfg.criticalBalanceThreshold > cfg.lowBalanceThreshold) return NextResponse.json({ error: "the critical threshold must not exceed the low-balance threshold" }, { status: 400 });
  if (cfg.readOnlyThreshold > cfg.criticalBalanceThreshold) return NextResponse.json({ error: "the read-only threshold must not exceed the critical threshold" }, { status: 400 });
  if (cfg.targetMarginPct / 100 + cfg.paymentProcessorFeePct / 100 + cfg.taxReservePct / 100 >= 0.95) return NextResponse.json({ error: "margin + processor fee + reserve must leave room for the cost itself (below 95% of the charge)" }, { status: 400 });
  try {
    await gate.meter.store.saveConfig(cfg, gate.user?.userId ?? null);
    gate.meter.invalidate();
    if (gate.user) await audit({ action: "billing.config_changed", userId: gate.user.userId, sessionId: gate.user.sessionId, customerId: gate.user.customerId, entity: "billing_config", entityId: "1", detail: { config: cfg } });
    return NextResponse.json({ ok: true, config: cfg, example: { deposit100: depositProjection(100, cfg), cost10: priceOperation({ providerCost: 10 }, cfg) } });
  } catch (e) { return billingError(e); }
}
