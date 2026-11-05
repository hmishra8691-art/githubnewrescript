import { NextRequest } from "next/server";
import { reconcileSettlement, summariseDifferences, type PlatformRecord, type VendorClaim } from "@rescript/recruitment";
import { audit, isFailure, requireUser } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { noStore, recruitmentActor, refuseVendorVisibility } from "@/lib/recruitment/access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * SETTLEMENT (0086) — three accounts of the same work, and what to do where they disagree.
 *
 *   GET    ?order=<id>                       the latest reconciliation for an order, with its differences
 *   POST   { orderId, claims: [...] }        reconcile the vendor's claim against the platform's record
 *   PATCH  { differenceId, resolution }      a human's decision on one line: pay / decline / credit / waived
 *
 * PLATFORM ADMINISTRATORS ONLY. Everything here is acquisition cost and a supplier's invoice — the figures
 * `canSeeVendors` exists to keep away from researchers.
 *
 * ## Why the claims are posted rather than fetched
 *
 * No vendor adapter in this build exposes a settlement feed; Prolific's does not exist and the manual
 * relationships have none by definition. So the claim comes from the invoice, entered by whoever is holding
 * it. Pretending otherwise would mean inventing an integration and reconciling against our own guess, which
 * is the one thing a reconciliation must never do.
 *
 * ## What the platform's own record is, exactly
 *
 * Per participation, keyed by the vendor's participant id (`panel_entries.pid`) — the only identifier the two
 * sides share:
 *
 *   outcome        what the panel entry recorded on the way out
 *   accepted       the response completed and no reviewer marked it REMOVE. A quality classification alone
 *                  does not reject anything: a machine opens cases and a human decides, which is the same
 *                  rule the fraud queue runs on.
 *   heldForReview  an open or appealed fraud case holding payment, OR a severe classification nobody has
 *                  reviewed yet. Held is not refused — it becomes payable if the case clears.
 *   amount         the agreed CPI on the order, for the ones the platform agrees are payable
 *
 * ## Nothing here settles itself
 *
 * The reconciliation computes and records. Every difference waits for a person, and `settled_at` is only ever
 * written by the PATCH below. A system that closed its own disputes would close them in whichever direction
 * its own records happened to favour — which is exactly the direction nobody should trust it to choose.
 */

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const OUTCOMES = new Set(["complete", "screenout", "quota_full", "terminate", "over_quota"]);
const RESOLUTIONS = new Set(["pay", "decline", "credit", "waived"]);

/** The vendor's invoice, read defensively: a malformed line is refused by name rather than silently dropped. */
function parseClaims(raw: unknown): { ok: true; claims: VendorClaim[] } | { ok: false; problems: string[] } {
  if (!Array.isArray(raw)) return { ok: false, problems: ["`claims` must be a list of invoice lines."] };
  if (raw.length > 50_000) return { ok: false, problems: ["That is more than 50,000 lines; split the invoice."] };
  const problems: string[] = [];
  const claims: VendorClaim[] = [];
  raw.forEach((item, i) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const participantId = str(o.participantId);
    if (!participantId) { problems.push(`Line ${i + 1} has no participant id, so it cannot be matched to anything.`); return; }
    const outcome = str(o.outcome) ?? "complete";
    if (!OUTCOMES.has(outcome)) { problems.push(`Line ${i + 1} has an outcome of "${outcome}", which is not one this platform records.`); return; }
    const amount = typeof o.amount === "number" && Number.isFinite(o.amount) ? o.amount : null;
    claims.push({
      participantId,
      outcome: outcome as VendorClaim["outcome"],
      /* absent means billable: an invoice line is a claim for payment unless it says otherwise */
      billable: o.billable === undefined ? true : o.billable === true,
      amount,
    });
  });
  return problems.length ? { ok: false, problems: problems.slice(0, 20) } : { ok: true, claims };
}

type Db = ReturnType<typeof supabaseService>;

/**
 * The platform's own account of who took part under this order.
 *
 * Four reads rather than one join, because the chain crosses tables that are deliberately not foreign-keyed
 * to each other: a panel entry knows its session, a ledger row knows its session, a fraud case knows its
 * ledger row. Each step is an indexed lookup on a bounded set.
 */
async function platformRecords(db: Db, surveyId: string, cpi: number, isTest: boolean): Promise<PlatformRecord[]> {
  const { data: entries } = await db
    .from("panel_entries")
    .select("pid, outcome, session_ref")
    .eq("survey_id", surveyId).eq("is_test", isTest)
    .not("pid", "eq", "")
    .limit(50_000);
  const rows = (entries ?? []) as Array<{ pid: string; outcome: string | null; session_ref: string | null }>;
  if (!rows.length) return [];

  const sessions = [...new Set(rows.map((r) => r.session_ref).filter((v): v is string => !!v))];

  const responses = new Map<string, { status: string; review: string | null; classification: string | null }>();
  const heldSessions = new Set<string>();
  if (sessions.length) {
    for (let i = 0; i < sessions.length; i += 500) {
      const slice = sessions.slice(i, i + 500);
      const { data: resp } = await db
        .from("responses")
        .select("session_id, status, review_status, quality")
        .in("session_id", slice);
      for (const r of (resp ?? []) as Array<Record<string, unknown>>) {
        responses.set(String(r.session_id), {
          status: String(r.status ?? ""),
          review: (r.review_status as string | null) ?? null,
          classification: ((r.quality as { classification?: string } | null)?.classification) ?? null,
        });
      }

      const { data: ledger } = await db
        .from("participation_ledger").select("id, session_ref").in("session_ref", slice);
      const ledgerRows = (ledger ?? []) as Array<{ id: string; session_ref: string | null }>;
      if (ledgerRows.length) {
        const { data: cases } = await db
          .from("fraud_cases").select("ledger_id")
          .in("ledger_id", ledgerRows.map((l) => l.id))
          .in("status", ["open", "appealed"]).eq("holds_payment", true);
        const heldLedgers = new Set((cases ?? []).map((c) => String((c as { ledger_id: string }).ledger_id)));
        for (const l of ledgerRows) if (heldLedgers.has(l.id) && l.session_ref) heldSessions.add(l.session_ref);
      }
    }
  }

  const out: PlatformRecord[] = [];
  for (const r of rows) {
    const resp = r.session_ref ? responses.get(r.session_ref) : undefined;
    const outcome = (OUTCOMES.has(String(r.outcome)) ? r.outcome : "screenout") as PlatformRecord["outcome"];
    /*
     * A reviewer's REMOVE rejects. A classification on its own does not: the platform's rule everywhere else
     * is that a machine opens a case and a person decides, and billing is not the place to break it.
     */
    const accepted = resp?.status === "complete" && resp.review !== "REMOVE";
    const severe = resp?.classification === "CRITICAL" || resp?.classification === "HIGHLY_SUSPICIOUS";
    const heldForReview = accepted && ((r.session_ref ? heldSessions.has(r.session_ref) : false) || (severe && !resp?.review));
    out.push({
      participantId: r.pid,
      outcome,
      accepted,
      heldForReview,
      amount: accepted ? cpi : 0,
    });
  }
  return out;
}

export async function GET(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = recruitmentActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canSeeVendors) return refuseVendorVisibility();

  const orderId = req.nextUrl.searchParams.get("order") ?? "";
  if (!orderId) return noStore({ error: "An order id is required." }, 400);

  const db = supabaseService();
  const { data: recon, error } = await db
    .from("settlement_reconciliations")
    .select("id, order_id, currency, claimed_count, claimed_amount, agreed_count, agreed_amount, payable_count, payable_amount, held_count, held_amount, clean, statement, computed_at, settled_at, settled_by")
    .eq("order_id", orderId).eq("customer_id", actor.customerId)
    .order("computed_at", { ascending: false }).limit(1).maybeSingle();
  /* a database without 0086 has no such table; that is "nothing reconciled yet", not a failure */
  if (error) return noStore({ ok: true, reconciliation: null, differences: [], note: "No settlement record is available for this order yet." });
  if (!recon) return noStore({ ok: true, reconciliation: null, differences: [] });

  const { data: diffs } = await db
    .from("settlement_differences")
    .select("id, participant_ref, cause, vendor_amount, platform_amount, delta, detail, resolution, resolved_at")
    .eq("reconciliation_id", (recon as { id: string }).id)
    .order("cause", { ascending: true }).order("participant_ref", { ascending: true });

  return noStore({ ok: true, reconciliation: recon, differences: diffs ?? [] });
}

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = recruitmentActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canSeeVendors) return refuseVendorVisibility();

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return noStore({ error: "bad json" }, 400); }

  const orderId = str(body.orderId);
  if (!orderId) return noStore({ error: "An order id is required." }, 400);
  const parsed = parseClaims(body.claims);
  if (!parsed.ok) return noStore({ error: "This invoice cannot be reconciled as written.", problems: parsed.problems }, 400);

  const db = supabaseService();
  const { data: order, error: oErr } = await db
    .from("recruitment_orders")
    .select("id, agreed_cpi, currency, recruitment_project_id, recruitment_projects!inner(customer_id, survey_id)")
    .eq("id", orderId).maybeSingle();
  if (oErr) return noStore({ error: oErr.message }, 500);
  if (!order) return noStore({ error: "No such order." }, 404);

  const project = (order as { recruitment_projects?: { customer_id?: string; survey_id?: string } | Array<{ customer_id?: string; survey_id?: string }> }).recruitment_projects;
  const p = Array.isArray(project) ? project[0] : project;
  /* an order belonging to another organisation is not found, rather than refused — it is not theirs to know about */
  if (!p || p.customer_id !== actor.customerId) return noStore({ error: "No such order." }, 404);

  const cpi = Number((order as { agreed_cpi: number }).agreed_cpi ?? 0);
  const currency = String((order as { currency: string }).currency ?? "USD");
  const records = await platformRecords(db, String(p.survey_id), cpi, false);
  const settlement = reconcileSettlement(orderId, currency, parsed.claims, records);

  const { data: inserted, error: rErr } = await db.from("settlement_reconciliations").insert({
    customer_id: actor.customerId, order_id: orderId, currency,
    claimed_count: settlement.claimedCount, claimed_amount: settlement.claimedAmount,
    agreed_count: settlement.agreedCount, agreed_amount: settlement.agreedAmount,
    payable_count: settlement.payableCount, payable_amount: settlement.payableAmount,
    held_count: settlement.heldCount, held_amount: settlement.heldAmount,
    clean: settlement.clean, statement: settlement.statement.slice(0, 500),
  }).select("id").single();
  if (rErr) {
    /* 0086 not applied: the reconciliation is still correct and still worth showing, it just is not kept */
    return noStore({
      ok: true, stored: false, reconciliationId: null,
      settlement, summary: summariseDifferences(settlement),
      note: "This database has not run migration 0086 yet, so the reconciliation was computed but not recorded.",
    });
  }

  const reconciliationId = (inserted as { id: string }).id;
  if (settlement.differences.length) {
    const lines = settlement.differences.map((d) => ({
      reconciliation_id: reconciliationId,
      participant_ref: d.participantId.slice(0, 128),
      cause: d.cause,
      vendor_amount: d.vendorAmount, platform_amount: d.platformAmount,
      delta: d.delta, detail: d.detail.slice(0, 400),
    }));
    for (let i = 0; i < lines.length; i += 500) {
      const { error: dErr } = await db.from("settlement_differences").insert(lines.slice(i, i + 500));
      if (dErr) return noStore({ error: `The totals were recorded but the differences were not: ${dErr.message}`, reconciliationId }, 500);
    }
  }

  await audit({
    action: "recruitment.settlement_reconciled", userId: actor.userId, customerId: actor.customerId,
    entity: "recruitment_order", entityId: orderId,
    /* counts and totals, never the participant ids: an audit entry is read by people who are not reconciling */
    detail: {
      claimed: settlement.claimedCount, agreed: settlement.agreedCount, payable: settlement.payableAmount,
      held: settlement.heldCount, differences: settlement.differences.length, currency,
    },
  });

  return noStore({
    ok: true, stored: true, reconciliationId,
    settlement, summary: summariseDifferences(settlement),
    /* what the platform had to compare against, so a reconciliation of nothing is obvious rather than clean */
    platformRecords: records.length,
  });
}

/**
 * One line, decided by a person.
 *
 * `settled_at` on the reconciliation is written only when every difference has a resolution — a dispute is
 * settled when the last line is, not when somebody presses a button that says so.
 */
export async function PATCH(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = recruitmentActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canSeeVendors) return refuseVendorVisibility();

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return noStore({ error: "bad json" }, 400); }

  const differenceId = str(body.differenceId);
  const resolution = str(body.resolution);
  if (!differenceId) return noStore({ error: "A difference id is required." }, 400);
  if (!resolution || !RESOLUTIONS.has(resolution)) {
    return noStore({ error: "A resolution must be one of: pay, decline, credit, waived." }, 400);
  }

  const db = supabaseService();
  const { data: diff } = await db
    .from("settlement_differences")
    .select("id, reconciliation_id, settlement_reconciliations!inner(customer_id)")
    .eq("id", differenceId).maybeSingle();
  const owner = (diff as { settlement_reconciliations?: { customer_id?: string } | Array<{ customer_id?: string }> } | null)?.settlement_reconciliations;
  const o = Array.isArray(owner) ? owner[0] : owner;
  if (!diff || !o || o.customer_id !== actor.customerId) return noStore({ error: "No such difference." }, 404);

  const reconciliationId = String((diff as { reconciliation_id: string }).reconciliation_id);
  const { error } = await db.from("settlement_differences")
    .update({ resolution, resolved_at: new Date().toISOString(), resolved_by: actor.userId })
    .eq("id", differenceId);
  if (error) return noStore({ error: error.message }, 500);

  const { count: open } = await db
    .from("settlement_differences")
    .select("id", { count: "exact", head: true })
    .eq("reconciliation_id", reconciliationId).is("resolution", null);

  let settled = false;
  if ((open ?? 0) === 0) {
    await db.from("settlement_reconciliations")
      .update({ settled_at: new Date().toISOString(), settled_by: actor.userId })
      .eq("id", reconciliationId);
    settled = true;
  }

  await audit({
    action: "recruitment.settlement_line_resolved", userId: actor.userId, customerId: actor.customerId,
    entity: "settlement_difference", entityId: differenceId,
    detail: { resolution, remaining: open ?? 0, settled },
  });

  return noStore({
    ok: true, resolution, remaining: open ?? 0, settled,
    statement: settled
      ? "Every difference on this reconciliation now has a decision, so it is settled."
      : `${(open ?? 0).toLocaleString()} ${open === 1 ? "difference" : "differences"} still waiting on a decision.`,
  });
}
