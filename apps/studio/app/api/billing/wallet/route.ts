import { NextRequest, NextResponse } from "next/server";
import { walletOverview } from "@rescript/billing";
import { isFailure, requireUser } from "@/lib/guard";
import { getMeter } from "@/lib/metering";
import { meterThresholds } from "@/lib/projectMeters";

export const dynamic = "force-dynamic";

/**
 * THE SIGNED-IN PERSON'S WALLET, AND NOTHING ELSE (dashboard brief §3): the
 * balance the compact wallet in the header shows, with the level the colour
 * reads. The same `walletOverview` the usage pages use, so the figure can
 * never differ from theirs; no project meters, no usage lists — the header
 * asks on every page and must be cheap. A Studio without the billing tables
 * answers `billing_unavailable`, and the header shows nothing.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  const meter = getMeter();
  try {
    const cfg = await meter.config();
    const wallets = await meter.store.listWallets({ customerId: user.customerId ?? undefined });
    const mine = wallets.find((w) => w.userId === user.userId) ?? null;
    const ledger = mine ? await meter.store.listLedger(mine.id, 500) : [];
    const wallet = walletOverview(mine, ledger, cfg);
    return NextResponse.json({ ok: true, wallet, thresholds: meterThresholds(cfg) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = (e as Error).message;
    const unavailable = /relation .* does not exist|function .* does not exist|schema cache/i.test(msg);
    return NextResponse.json(unavailable ? { ok: false, code: "billing_unavailable" } : { ok: false, code: "billing_error", error: msg }, { headers: { "cache-control": "no-store" } });
  }
}
