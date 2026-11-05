import { NextRequest } from "next/server";
import { validateMarginBps, sellingPrice, equivalentMarkupBps, TARGET_MARGIN_BAND } from "@rescript/recruitment";
import { audit, isFailure, requireUser } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { noStore, recruitmentActor, refuseVendorVisibility } from "@/lib/recruitment/access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * COMMERCIAL MARGINS (0087) — the administrator's control over what recruitment is sold for.
 *
 *   GET                         every rule, what each one resolves for, and the recent calculations
 *   POST { scope, marginBps, market?, recruitmentProjectId?, recruitmentType?, note? }
 *   DELETE ?id=<rule>           ends a rule rather than deleting it where it has been used
 *
 * PLATFORM ADMINISTRATORS ONLY. This is the acquisition cost and the margin taken on it — the two figures a
 * researcher must never see, and the reason `canSeeVendors` exists.
 *
 * The margin is of the SELLING PRICE: `price = cost / (1 − margin)`. A worked example comes back with every
 * response, because the difference from a markup is a 9% error that looks entirely plausible on a screen.
 */

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v
  : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;

export async function GET(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = recruitmentActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canSeeVendors) return refuseVendorVisibility();

  const db = supabaseService();
  const [rules, applications] = await Promise.all([
    db.from("commercial_margins")
      .select("id, scope, margin_bps, market, recruitment_type, recruitment_project_id, note, effective_from, effective_to, created_at")
      .eq("customer_id", actor.customerId)
      .order("scope", { ascending: true })
      .order("effective_from", { ascending: false }),
    db.from("margin_applications")
      .select("id, recruitment_project_id, market, purpose, completes, cost_amount, margin_bps, margin_scope, price_amount, profit_amount, currency, because, within_target_band, computed_at")
      .eq("customer_id", actor.customerId)
      .order("computed_at", { ascending: false })
      .limit(50),
  ]);

  if (rules.error) return noStore({ error: rules.error.message }, 500);

  return noStore({
    ok: true,
    rules: rules.data ?? [],
    applications: applications.data ?? [],
    targetBand: TARGET_MARGIN_BAND,
    /*
     * Returned so the screen can show the arithmetic rather than assert it. The markup that produces the same
     * price is shown beside it, because an agreement written as a markup has to be converted by somebody, and
     * doing that conversion by hand is how the original error was made.
     */
    worked: {
      cost: 7000,
      examples: [2500, 3000].map((bps) => ({
        marginBps: bps,
        price: sellingPrice(7000, bps),
        equivalentMarkupBps: equivalentMarkupBps(bps),
      })),
    },
  });
}

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = recruitmentActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canSeeVendors) return refuseVendorVisibility();

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return noStore({ error: "Expected a JSON body." }, 400); }

  const scope = str(body.scope);
  const marginBps = num(body.marginBps);
  if (!scope || !["default", "market", "recruitment_type", "project", "override"].includes(scope)) {
    return noStore({ error: "scope must be default, market, recruitment_type, project or override." }, 400);
  }
  if (marginBps === null) return noStore({ error: "marginBps is required." }, 400);

  const check = validateMarginBps(marginBps);
  if (!check.ok) return noStore({ error: check.reason }, 400);

  const note = str(body.note);
  if (scope === "override" && (!note || note.length < 3)) {
    return noStore({ error: "An override needs a note. An exception nobody can explain later is a mistake made permanent." }, 400);
  }

  const db = supabaseService();
  const market = str(body.market)?.toUpperCase() ?? null;
  const projectId = str(body.recruitmentProjectId);
  const recruitmentType = str(body.recruitmentType);

  /*
   * One LIVE rule per target, so the applicable rate is never a matter of sort order. A replacement ends the
   * one it supersedes rather than deleting it: what a project was quoted at six months ago has to stay
   * answerable.
   */
  const supersede = db.from("commercial_margins")
    .update({ effective_to: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("customer_id", actor.customerId).eq("scope", scope).is("effective_to", null);
  if (scope === "market") supersede.eq("market", market ?? "");
  if (scope === "recruitment_type") supersede.eq("recruitment_type", recruitmentType ?? "");
  if (scope === "project" || scope === "override") supersede.eq("recruitment_project_id", projectId ?? "");
  await supersede;

  const { data, error } = await db.from("commercial_margins").insert({
    customer_id: actor.customerId, scope, margin_bps: Math.round(marginBps),
    market: scope === "market" ? market : null,
    recruitment_type: scope === "recruitment_type" ? recruitmentType : null,
    recruitment_project_id: scope === "project" || scope === "override" ? projectId : null,
    note, created_by: actor.userId,
  }).select("id, scope, margin_bps").single();

  if (error) return noStore({ error: error.message }, 400);

  await audit({
    action: "recruitment.vendor_configured", userId: actor.userId, customerId: actor.customerId,
    entity: "commercial_margin", entityId: String((data as { id: string }).id),
    detail: { scope, marginBps: Math.round(marginBps), market, note: note ?? undefined },
  });

  return noStore({
    ok: true, rule: data,
    worked: { cost: 7000, price: sellingPrice(7000, marginBps), equivalentMarkupBps: equivalentMarkupBps(marginBps) },
  });
}

export async function DELETE(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = recruitmentActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canSeeVendors) return refuseVendorVisibility();

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return noStore({ error: "Which rule?" }, 400);

  /*
   * Ended, not deleted. A margin rule is the reason a price was what it was, and a deleted one leaves a
   * margin_applications row pointing at nothing — which is exactly the question an auditor asks.
   */
  const { error } = await supabaseService().from("commercial_margins")
    .update({ effective_to: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id).eq("customer_id", actor.customerId).is("effective_to", null);
  if (error) return noStore({ error: error.message }, 400);

  await audit({
    action: "recruitment.vendor_configured", userId: actor.userId, customerId: actor.customerId,
    entity: "commercial_margin", entityId: id, detail: { ended: true },
  });
  return noStore({ ok: true, ended: id });
}
