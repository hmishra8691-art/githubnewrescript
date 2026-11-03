import { NextRequest } from "next/server";
import { PRICING_SOURCES, VENDOR_CAPABILITIES, VENDOR_MODES, type PricingSource, type VendorCapability, type VendorMode } from "@rescript/schema";
import { capabilityMatrix, integrationSummary, createManualAdapter, pricedMarkets } from "@rescript/recruitment";
import { audit, isFailure, requireUser } from "@/lib/guard";
import { noStore, recruitmentActor, refuseManage } from "@/lib/recruitment/access";
import { recruitmentStore } from "@/lib/recruitment/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE VENDOR MARKETPLACE (2026-11-03) — Fieldwork → Vendor Marketplace, and Settings → Sample vendors.
 *
 *   GET                                        the directory: every catalogue vendor and this organisation's own,
 *                                              each with its REAL integration state, the capability matrix, the
 *                                              markets its rate card actually covers, and a sentence saying what
 *                                              the relationship is. A vendor with no integration is returned as
 *                                              "awaiting", never omitted and never implied to be live.
 *   POST { action: "integration", vendorId, mode?, markupBps?, currency?, notes?, enabled? }
 *   POST { action: "capability", integrationId, capability, supported, notes? }
 *   POST { action: "pricing", integrationId, market, irMin, irMax, loiMin, loiMax, cpi, currency, source, sourceNote?, validFrom?, validTo? }
 *   DELETE ?pricing=<id>                       remove a rate-card row
 *
 * Reading and changing: the organisation's programmers, researchers and administrators (lib/recruitment/access.ts).
 * CPI and margin are commercial information about the organisation, so clients and viewers see none of this.
 *
 * PHASE 1 HAS NO LIVE VENDOR ADAPTER. `mode: "api"` is refused here with the reason, because an API integration
 * needs sealed credentials and there is no adapter to use them — and a mode that claims an API this platform
 * cannot speak is exactly the misrepresentation the brief forbids.
 */

const MANUAL = createManualAdapter({ pricing: async () => [], history: async () => undefined });
const CURRENCY = /^[A-Z]{3}$/;
const MARKET = /^[A-Z]{2}$/;

function num(v: unknown, fallback: number | null = null): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

export async function GET(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = recruitmentActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canManage) return refuseManage();

  const store = recruitmentStore();
  const [vendors, integrations, capabilities, pricing] = await Promise.all([
    store.vendors(actor.customerId),
    store.integrations(actor.customerId),
    store.capabilities(actor.customerId),
    store.pricing(actor.customerId),
  ]);
  const history = await store.history(actor.customerId, integrations.map((i) => i.id));
  const byVendor = new Map(integrations.map((i) => [i.vendorId, i]));

  return noStore({
    ok: true,
    /** every mode and capability the UI may offer, so the client never invents one */
    modes: VENDOR_MODES, capabilities: VENDOR_CAPABILITIES, sources: PRICING_SOURCES,
    /** Phase 1: no adapter speaks to a vendor, and the UI says so rather than offering a switch that lies */
    liveAdaptersAvailable: false,
    vendors: vendors.map((v) => {
      const integ = byVendor.get(v.id) ?? null;
      const mode: VendorMode = integ?.mode ?? "awaiting";
      const recorded = integ ? capabilities[integ.id] ?? [] : [];
      // the manual adapter is what serves every configured relationship in Phase 1
      const implemented = mode === "manual" ? MANUAL.capabilities : [];
      const matrix = capabilityMatrix(mode, implemented, recorded);
      const rates = integ ? pricing[integ.id] ?? [] : [];
      return {
        id: v.id, slug: v.slug, name: v.name, legalName: v.legalName, website: v.website, logoUrl: v.logoUrl,
        description: v.description, panelPreset: v.panelPreset, own: v.customerId !== null,
        integration: integ
          ? { id: integ.id, mode: integ.mode, health: integ.health, hint: integ.hint, markupBps: integ.markupBps,
              currency: integ.currency, notes: integ.notes, enabled: integ.enabled, lastContactAt: integ.lastContactAt,
              lastError: integ.lastError }
          : null,
        mode, summary: integrationSummary(mode, matrix), capabilities: matrix,
        /** the markets this vendor can actually be priced in — not the markets it claims to cover */
        pricedMarkets: pricedMarkets(rates),
        rateCardRows: rates.length,
        history: integ ? history[integ.id] ?? null : null,
      };
    }),
    pricing,
  });
}

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = recruitmentActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canManage) return refuseManage();

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return noStore({ error: "bad json" }, 400); }
  const store = recruitmentStore();
  const action = String(body.action ?? "");

  try {
    if (action === "integration") {
      const vendorId = String(body.vendorId ?? "");
      if (!vendorId) return noStore({ error: "vendorId is required" }, 400);
      const vendors = await store.vendors(actor.customerId);
      if (!vendors.some((v) => v.id === vendorId)) return noStore({ error: "No such vendor" }, 404);

      const mode = body.mode === undefined ? undefined : String(body.mode) as VendorMode;
      if (mode !== undefined && !VENDOR_MODES.includes(mode)) return noStore({ error: `mode must be one of ${VENDOR_MODES.join(", ")}` }, 400);
      if (mode === "api") {
        return noStore({
          error: "No live vendor adapter exists yet, so this integration cannot be set to API mode. Use Manual while an operator enters feasibility and orders by hand; live adapters arrive with vendor contracts.",
          code: "no_live_adapter",
        }, 409);
      }
      const markupBps = num(body.markupBps);
      if (markupBps !== null && (markupBps < 0 || markupBps > 10_000)) return noStore({ error: "markupBps must be between 0 and 10000" }, 400);
      const currency = body.currency === undefined ? undefined : String(body.currency).toUpperCase();
      if (currency !== undefined && !CURRENCY.test(currency)) return noStore({ error: "currency must be a three-letter code" }, 400);

      const row = await store.upsertIntegration(actor.customerId, vendorId, {
        ...(mode !== undefined ? { mode } : {}),
        ...(markupBps !== null ? { markupBps } : {}),
        ...(currency !== undefined ? { currency } : {}),
        ...(body.notes !== undefined ? { notes: body.notes === null ? null : String(body.notes).slice(0, 1000) } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}),
      }, actor.userId);
      await audit({
        action: "recruitment.vendor_configured", userId: actor.userId, customerId: actor.customerId,
        entity: "vendor_integration", entityId: row.id,
        detail: { vendor: vendors.find((v) => v.id === vendorId)?.name ?? vendorId, mode: row.mode, markupBps: row.markupBps },
      });
      return noStore({ ok: true, integration: row });
    }

    if (action === "capability") {
      const integrationId = String(body.integrationId ?? "");
      const capability = String(body.capability ?? "") as VendorCapability;
      if (!VENDOR_CAPABILITIES.includes(capability)) return noStore({ error: `capability must be one of ${VENDOR_CAPABILITIES.join(", ")}` }, 400);
      await store.setCapability(actor.customerId, integrationId, capability, body.supported === true,
        body.notes === undefined ? null : String(body.notes).slice(0, 300));
      return noStore({ ok: true });
    }

    if (action === "pricing") {
      const integrationId = String(body.integrationId ?? "");
      const market = String(body.market ?? "").toUpperCase();
      if (!MARKET.test(market)) return noStore({ error: "market must be a two-letter country code" }, 400);
      const cpi = num(body.cpi);
      if (cpi === null || cpi < 0) return noStore({ error: "cpi is required" }, 400);
      const source = String(body.source ?? "") as PricingSource;
      if (!PRICING_SOURCES.includes(source)) return noStore({ error: `source must be one of ${PRICING_SOURCES.join(", ")}` }, 400);
      if (source === "live") {
        return noStore({
          error: "A rate-card row entered by a person is not a live quotation. Record it as 'vendor_reported' (the vendor stated it) or 'administrator' (your own figure).",
          code: "not_live",
        }, 400);
      }
      const irMin = num(body.irMin, 0)!, irMax = num(body.irMax, 100)!;
      const loiMin = num(body.loiMin, 0)!, loiMax = num(body.loiMax, 120)!;
      if (irMax <= irMin || loiMax <= loiMin) return noStore({ error: "the incidence and length bands must be non-empty ranges" }, 400);
      const currency = String(body.currency ?? "USD").toUpperCase();
      if (!CURRENCY.test(currency)) return noStore({ error: "currency must be a three-letter code" }, 400);

      const row = await store.addPricing(actor.customerId, integrationId, {
        market, irMin, irMax, loiMin, loiMax, cpi, currency, source,
        ...(body.sourceNote ? { sourceNote: String(body.sourceNote).slice(0, 300) } : {}),
        ...(body.validFrom ? { validFrom: String(body.validFrom) } : {}),
        ...(body.validTo ? { validTo: String(body.validTo) } : {}),
      }, actor.userId);
      await audit({
        action: "recruitment.pricing_added", userId: actor.userId, customerId: actor.customerId,
        entity: "vendor_pricing", entityId: row.id ?? null,
        detail: { market, cpi, source, integrationId },
      });
      return noStore({ ok: true, pricing: row });
    }

    return noStore({ error: "unknown action" }, 400);
  } catch (e) {
    return noStore({ error: e instanceof Error ? e.message : "Could not save" }, 400);
  }
}

export async function DELETE(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = recruitmentActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canManage) return refuseManage();
  const id = req.nextUrl.searchParams.get("pricing");
  if (!id) return noStore({ error: "pricing is required" }, 400);
  const gone = await recruitmentStore().deletePricing(actor.customerId, id);
  return noStore({ ok: gone }, gone ? 200 : 404);
}
