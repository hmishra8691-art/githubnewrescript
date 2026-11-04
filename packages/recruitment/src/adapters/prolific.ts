import type { AudienceSpecification, FeasibilityEstimate, PricingSource, VendorCapability } from "@rescript/schema";
import {
  AdapterError, type AdapterContext, type FeasibilityRequest, type OrderAck, type OrderProgress,
  type OrderRequest, type QuotationRequest, type ReconciliationLine, type VendorAdapter,
} from "../adapter.js";
import { vendorFetch, type HttpOptions } from "../http.js";
import { round2 } from "../pricing.js";

/**
 * THE PROLIFIC ADAPTER (Phase 6), written against the published API at docs.prolific.com.
 *
 *   base            https://api.prolific.com/api/v1/
 *   auth            Authorization: Token <token>
 *   feasibility     POST /eligibility-count/            → { count }
 *   order           POST /studies/  (draft)             → { id, status: "UNPUBLISHED" }
 *                   POST /studies/{id}/transition/      → { action: "PUBLISH" }
 *   status          GET  /studies/{id}/
 *   submissions     GET  /studies/{id}/submissions/
 *   cancel          POST /studies/{id}/transition/      → { action: "STOP" }
 *
 * ## Prolific is not a sample exchange, and this adapter does not pretend otherwise
 *
 * Dynata or Cint sell completes at a CPI. Prolific pays a participant a REWARD and charges a fee on top, so
 * "CPI" here is a derived figure, not a quoted one. `source` is therefore `vendor_reported` and never `live`:
 * the number is arithmetic over the reward this platform chose, not a price Prolific returned.
 *
 * ## Two things the eligibility count does not mean
 *
 * `/eligibility-count/` answers how many people match the filters. It does NOT say how many will take the
 * study, and the docs are explicit that a returned **zero means "fewer than five", not "none"** — a privacy
 * floor. Both are honoured below: a zero becomes `null` with a reason rather than a confident nought, and the
 * count is never presented as available sample.
 *
 * ## Why ordering is two calls, and why that is a safety property
 *
 * Creating a draft commits nothing; publishing is what spends money. So the draft is created first, and only
 * then published. If the draft call times out ambiguously the worst case is an orphaned unpublished study,
 * which costs nothing and can be cleaned up — whereas a single combined call that timed out would leave a
 * study that may or may not be live and may or may not be paying people.
 */

const BASE = "https://api.prolific.com/api/v1";

/** Prolific's reward is in MINOR units of the account currency. Getting this wrong is a 100x error. */
function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}
function fromMinorUnits(minor: number): number {
  return round2(minor / 100);
}

interface ProlificFilter {
  filter_id: string;
  selected_values?: string[];
  selected_range?: { lower?: number; upper?: number };
}

/**
 * Map our audience onto Prolific's filters.
 *
 * Only two are mapped, deliberately. Prolific's filter ids are discovered at runtime from `/filters/`, and
 * guessing them produces a study that silently recruits the wrong people — far worse than recruiting a wider
 * group and saying so. Everything this adapter cannot express is returned in `unmapped`, which the comparison
 * screen shows beside the estimate, so a researcher reads "age and country were applied; income was not"
 * rather than assuming all of it was.
 */
function mapAudience(audience: AudienceSpecification): { filters: ProlificFilter[]; unmapped: string[] } {
  const filters: ProlificFilter[] = [];
  const unmapped: string[] = [];
  const d = audience.demographics;

  /*
   * AGE is the one criterion mapped for real. Prolific exposes it as a range filter whose id is stable, and a
   * range cannot be silently wrong the way a value list can.
   */
  if (typeof d.ageMin === "number" || typeof d.ageMax === "number") {
    filters.push({
      filter_id: "age",
      selected_range: {
        ...(typeof d.ageMin === "number" ? { lower: d.ageMin } : {}),
        ...(typeof d.ageMax === "number" ? { upper: d.ageMax } : {}),
      },
    });
  }

  /*
   * Everything else is NAMED, NOT GUESSED.
   *
   * Prolific's other filter ids and their permitted values are account- and locale-specific, discovered at
   * runtime from /filters/. A wrong `selected_values` is not rejected — the API accepts it and the study
   * quietly recruits the wrong population, which is discovered weeks later in the data. Listing a criterion as
   * unmapped costs a line on a screen; guessing it costs the project.
   *
   * Country is the one that most deserves an eventual real mapping, since Prolific does support it and a
   * multi-market project is otherwise unbuyable here. It is left unmapped until the filter ids are read from
   * the live /filters/ endpoint rather than assumed.
   */
  const named: Array<[unknown[] | undefined, string]> = [
    [d.countries, "country"], [d.regions, "region"], [d.cities, "city"],
    [d.genders, "gender"], [d.incomeBands, "income"], [d.education, "education"],
    [d.employment, "employment"], [d.occupation, "occupation"],
    [d.householdSize, "household size"], [d.maritalStatus, "marital status"],
    [audience.advanced.industries, "industry"], [audience.advanced.jobTitles, "job title"],
    [audience.advanced.seniority, "seniority"], [audience.advanced.companySize, "company size"],
    [audience.advanced.productOwnership, "product ownership"], [audience.advanced.brandUsage, "brand usage"],
    [audience.advanced.purchaseBehaviour, "purchase behaviour"],
    [audience.advanced.technologyUsage, "technology usage"], [audience.advanced.lifestyle, "lifestyle"],
  ];
  for (const [list, label] of named) {
    if (Array.isArray(list) && list.length) unmapped.push(label);
  }
  if (d.children && d.children !== "any") unmapped.push("children");
  if (audience.advanced.decisionAuthority && audience.advanced.decisionAuthority !== "any") {
    unmapped.push("decision authority");
  }
  if (audience.conditions !== undefined) unmapped.push("nested conditions");

  /*
   * Screeners are NOT unmapped — they are asked inside the survey itself, so they are handled, just not by the
   * vendor. Calling them unmapped would tell a researcher their screening was dropped when it was not.
   */

  return { filters, unmapped };
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const token = ctx.credentials?.token ?? ctx.credentials?.apiKey;
  if (!token) {
    throw new AdapterError(
      "This Prolific integration has no API token. Add one in the vendor marketplace; it is sealed and never shown again.",
      { retryable: false },
    );
  }
  return { authorization: `Token ${token}` };
}

export interface ProlificOptions extends HttpOptions {
  /** overridable for the replay harness and for tests */
  baseUrl?: string;
}

export function createProlificAdapter(opts: ProlificOptions = {}): VendorAdapter {
  const base = opts.baseUrl ?? BASE;

  const capabilities: VendorCapability[] = ["feasibility", "order", "status", "cancel", "reconcile", "webhook"];
  /*
   * `quote` is absent on purpose. Prolific does not quote a CPI; a price here is this platform's own
   * arithmetic over a reward it chose, and the capability registry refuses to dispatch what is not declared.
   */

  const maxSource: PricingSource = "vendor_reported";

  const estimateShell = (ctx: AdapterContext): FeasibilityEstimate => ({
    integrationId: ctx.integrationId,
    vendorName: ctx.vendorName,
    mode: ctx.mode,
    available: null, expectedIr: null, cpi: null, currency: ctx.currency,
    loiMinutes: null, expectedRejectionRate: null, expectedDuplicateRate: null,
    deliveryDays: null, qualityScore: null, qualityConfidence: "none",
    source: maxSource, unmapped: [],
  });

  return {
    id: "prolific",
    capabilities,
    maxSource,

    async authenticate(ctx) {
      try {
        const res = await vendorFetch(ctx.integrationId, "authenticate", {
          url: `${base}/users/me/`, retry: "safe", signal: ctx.signal,
          headers: authHeaders(ctx),
        }, opts);
        return { ok: res.ok };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "could not reach Prolific" };
      }
    },

    async feasibility(ctx, req) {
      const { filters, unmapped } = mapAudience(req.audience);
      const out = estimateShell(ctx);
      out.unmapped = unmapped;
      out.loiMinutes = req.loiMinutes;

      const res = await vendorFetch(ctx.integrationId, "feasibility", {
        url: `${base}/eligibility-count/`, method: "POST", retry: "safe",
        headers: authHeaders(ctx), body: { filters }, signal: ctx.signal,
      }, opts);

      const count = (res.body as { count?: unknown })?.count;
      if (typeof count !== "number" || !Number.isFinite(count)) {
        out.unavailableReason = "Prolific did not return a participant count for this audience.";
        return out;
      }

      if (count === 0) {
        /*
         * Zero is a PRIVACY FLOOR, not a measurement: the docs say it means fewer than five match. Writing 0
         * into `available` would let the optimiser treat "we are not allowed to tell you" as "there is nobody",
         * and silently drop a vendor that may well have sample.
         */
        out.available = null;
        out.unavailableReason = "Fewer than five participants match this audience — Prolific does not report exact counts below five.";
        return out;
      }

      /*
       * A match count is NOT available sample. Prolific tells you how many people fit the filters, not how many
       * will take the study, and the gap between those is the entire recruitment problem. It is reported as the
       * matching pool with that said plainly, and the optimiser's own capacity ceiling still applies.
       */
      out.available = count;
      out.unavailableReason = unmapped.length
        ? `This is how many Prolific participants match the criteria it could apply; ${unmapped.join(", ")} could not be expressed as a Prolific filter. It is a pool size, not a forecast of completes.`
        : "This is how many Prolific participants match the criteria, not a forecast of how many will complete.";
      return out;
    },

    async createOrder(ctx, req): Promise<OrderAck> {
      const headers = authHeaders(ctx);
      /*
       * No audience means no targeting, and on Prolific that recruits the general pool at full price. Refuse
       * rather than place it: an order that quietly ignored the researcher's criteria would be discovered only
       * once the data came back wrong and the money was gone.
       */
      if (!req.audience) {
        throw new AdapterError(
          "This order carries no audience, and ordering from Prolific without targeting would recruit the general population and bill for it.",
          { retryable: false },
        );
      }
      const { filters, unmapped } = mapAudience(req.audience);

      /*
       * Step one: the draft. `retry: "never"` — Prolific issues no idempotency key for study creation, so a
       * repeated attempt after an ambiguous timeout would create a second study. An orphaned draft costs
       * nothing; a duplicate published study pays strangers.
       */
      const draft = await vendorFetch(ctx.integrationId, "createOrder.draft", {
        url: `${base}/studies/`, method: "POST", retry: "never",
        headers, signal: ctx.signal,
        body: {
          name: `Rescript project ${req.recruitmentProjectId.slice(0, 8)}`,
          internal_name: req.orderId,
          description: "Market research survey.",
          external_study_url: req.entryUrl,
          prolific_id_option: "url_parameters",
          total_available_places: req.completes,
          estimated_completion_time: 10,
          reward: toMinorUnits(req.cpi),
          device_compatibility: [],
          filters,
          completion_codes: [
            { code_type: "COMPLETED", actions: [{ action: "MANUALLY_REVIEW" }] },
          ],
        },
      }, opts);

      const studyId = (draft.body as { id?: string })?.id;
      if (!studyId) {
        throw new AdapterError("Prolific accepted the study but returned no id, so it cannot be published or tracked.", { retryable: false });
      }

      /*
       * Step two: publish. This is the call that spends money, and it IS safe to retry — the transition is
       * declarative (publish an already-published study and the status is simply already ACTIVE), so a repeat
       * after a timeout cannot publish twice.
       */
      try {
        const published = await vendorFetch(ctx.integrationId, "createOrder.publish", {
          url: `${base}/studies/${studyId}/transition/`, method: "POST", retry: "idempotent",
          headers, body: { action: "PUBLISH" }, signal: ctx.signal,
        }, opts);
        const status = String((published.body as { status?: string })?.status ?? "").toUpperCase();
        const caveat = unmapped.length
          ? ` Note: ${unmapped.join(", ")} could not be expressed as a Prolific filter, so this study is open to participants who do not meet those criteria.`
          : "";
        return {
          vendorOrderRef: studyId,
          status: status === "ACTIVE" ? "live" : "placed",
          message: `Prolific study ${studyId} is ${status || "created"}.${caveat}`,
        };
      } catch (e) {
        /*
         * The draft exists and is NOT live. Say exactly that: an operator who is told "failed" will re-order
         * and end up with two studies, while one who is told there is an unpublished draft can publish or
         * delete it.
         */
        return {
          vendorOrderRef: studyId,
          status: "failed",
          message: `The study was created on Prolific as ${studyId} but could not be published, so nobody has been recruited and nothing has been spent. Publish or delete it in Prolific. (${e instanceof Error ? e.message : "unknown error"})`,
        };
      }
    },

    async orderStatus(ctx, vendorOrderRef): Promise<OrderProgress> {
      const headers = authHeaders(ctx);
      const [study, counts] = await Promise.all([
        vendorFetch(ctx.integrationId, "orderStatus.study", {
          url: `${base}/studies/${vendorOrderRef}/`, retry: "safe", headers, signal: ctx.signal,
        }, opts),
        vendorFetch(ctx.integrationId, "orderStatus.submissions", {
          url: `${base}/studies/${vendorOrderRef}/submissions/count/`, retry: "safe", headers, signal: ctx.signal,
        }, opts).catch(() => null),
      ]);

      const s = study.body as { status?: string; total_available_places?: number };
      const c = (counts?.body ?? {}) as Record<string, number>;
      const approved = Number(c.APPROVED ?? c.approved ?? 0);
      const rejected = Number(c.REJECTED ?? c.rejected ?? 0);
      const awaiting = Number(c.AWAITING_REVIEW ?? c["AWAITING REVIEW"] ?? 0);

      const statusMap: Record<string, OrderProgress["status"]> = {
        UNPUBLISHED: "placed", SCHEDULED: "placed", PUBLISHING: "placed",
        ACTIVE: "live", PAUSED: "paused", COMPLETED: "complete",
        "AWAITING REVIEW": "live",
      };

      return {
        vendorOrderRef,
        delivered: approved + rejected + awaiting,
        accepted: approved,
        rejected,
        /*
         * Prolific does not report duplicates: its participants are a known, de-duplicated pool, so the vendor
         * has no such number to give. Zero here means "not applicable to this vendor", and the platform's own
         * cross-vendor ledger (0083) is what actually catches a person arriving twice.
         */
        duplicates: 0,
        spend: null,
        status: statusMap[String(s.status ?? "").toUpperCase()] ?? "live",
        idempotencyKey: `prolific:${vendorOrderRef}:${approved}:${rejected}:${awaiting}`,
      };
    },

    async cancelOrder(ctx, vendorOrderRef, reason) {
      await vendorFetch(ctx.integrationId, "cancelOrder", {
        url: `${base}/studies/${vendorOrderRef}/transition/`, method: "POST", retry: "idempotent",
        headers: authHeaders(ctx), body: { action: "STOP" }, signal: ctx.signal,
      }, opts);
      return { cancelled: true, message: `Stopped on Prolific: ${reason}` };
    },

    async reconcile(ctx, vendorOrderRef): Promise<ReconciliationLine[]> {
      const res = await vendorFetch(ctx.integrationId, "reconcile", {
        url: `${base}/studies/${vendorOrderRef}/submissions/`, retry: "safe",
        headers: authHeaders(ctx), signal: ctx.signal,
      }, opts);

      const results = (res.body as { results?: unknown[] })?.results ?? [];
      const outcomeOf = (status: string): ReconciliationLine["outcome"] =>
        status === "APPROVED" ? "complete"
        : status === "RETURNED" ? "terminate"
        : status === "TIMED-OUT" ? "terminate"
        : status === "REJECTED" ? "terminate"
        : "screenout";

      return results.map((r) => {
        const row = r as {
          participant_id?: string; participant?: string; status?: string;
          reward?: number; completed_at?: string; started_at?: string;
        };
        const status = String(row.status ?? "").toUpperCase();
        return {
          vendorOrderRef,
          participantId: String(row.participant_id ?? row.participant ?? ""),
          outcome: outcomeOf(status),
          // only an APPROVED submission is owed for; a rejection is explicitly not billable
          billable: status === "APPROVED",
          amount: typeof row.reward === "number" ? fromMinorUnits(row.reward) : null,
          occurredAt: row.completed_at ?? row.started_at ?? null,
        };
      });
    },
  };
}

/* ------------------------------------------------------------ webhook signature */

/**
 * Prolific signs `timestamp + body` with HMAC-SHA256 and sends it base64 in `X-Prolific-Request-Signature`,
 * alongside `X-Prolific-Request-Timestamp` and a globally unique `X-Event-ID` that is REUSED on retries.
 *
 * The body must be the RAW bytes as received. Prolific's own example re-serialises a parsed body with
 * `json.dumps`, which only works while both sides happen to serialise identically — a different key order or
 * one space of difference and a genuine event is rejected. Verifying the bytes that actually arrived has no
 * such failure mode, so that is what `verifyProlificWebhook` in webhook.ts does.
 */
export const PROLIFIC_WEBHOOK = Object.freeze({
  signatureHeader: "x-prolific-request-signature",
  timestampHeader: "x-prolific-request-timestamp",
  eventIdHeader: "x-event-id",
  encoding: "base64" as const,
  /** signed string = timestamp followed immediately by the raw body */
  payload: (timestamp: string, rawBody: string) => `${timestamp}${rawBody}`,
});
