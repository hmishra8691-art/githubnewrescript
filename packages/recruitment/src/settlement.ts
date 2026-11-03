import { round2 } from "./pricing.js";

/**
 * SETTLEMENT RECONCILIATION (Phase 6) — three records of the same work, and what to do when they disagree.
 *
 * At the end of a project there are three accounts of what happened, and they are never quite the same:
 *
 *   THE VENDOR'S     who it sent and what it believes it is owed for.
 *   THE PLATFORM'S   who actually arrived, finished, and passed quality (0084's admission ledger).
 *   WHAT IS PAYABLE  the platform's, minus anyone still held by an open fraud case (0085).
 *
 * The temptation is to produce one number. That number is always wrong for somebody, and worse, it hides WHY:
 * a vendor shown "we owe you £4,120" with no breakdown cannot tell a quality rejection from a clerical
 * mismatch, and neither can the researcher authorising it.
 *
 * So this produces a LINE PER DISAGREEMENT, each with its cause, and refuses to collapse them. The total is
 * reported three times — claimed, agreed, payable — because three different numbers is the truth.
 *
 * ## It does not decide
 *
 * Nothing here marks a dispute resolved. A participation the vendor claims and the platform never saw might be
 * a vendor error, a redirect that failed, or a respondent who closed the tab on the last screen — and the
 * difference matters commercially. It is reported, with everything known about it, for a human.
 */

export type DifferenceCause =
  /** the vendor billed for someone the platform has no record of arriving */
  | "not_seen"
  /** the platform recorded a complete the vendor has not claimed */
  | "unclaimed"
  /** both agree it happened; the platform rejected it on quality */
  | "rejected_on_quality"
  /** both agree; a fraud case is open and payment is held until a human resolves it */
  | "held_for_review"
  /** both agree it is payable; the amounts differ */
  | "amount_mismatch"
  /** the vendor claims an outcome the platform recorded differently (a complete we logged as a screenout) */
  | "outcome_mismatch";

export interface VendorClaim {
  participantId: string;
  outcome: "complete" | "screenout" | "quota_full" | "terminate" | "over_quota";
  billable: boolean;
  amount: number | null;
}

export interface PlatformRecord {
  participantId: string;
  outcome: "complete" | "screenout" | "quota_full" | "terminate" | "over_quota";
  /** passed the quality rules */
  accepted: boolean;
  /** an open fraud case holds this one's payment (0084/0085) */
  heldForReview: boolean;
  /** what the platform believes is owed at the agreed CPI */
  amount: number | null;
}

export interface Difference {
  participantId: string;
  cause: DifferenceCause;
  vendorAmount: number | null;
  platformAmount: number | null;
  /** positive = the vendor is claiming more than the platform agrees */
  delta: number;
  detail: string;
}

export interface Settlement {
  orderId: string;
  currency: string;
  /** every participation the vendor says it is owed for */
  claimedCount: number;
  claimedAmount: number;
  /** the ones both sides agree are complete and accepted */
  agreedCount: number;
  agreedAmount: number;
  /** agreed, minus anything a fraud case is holding. This is the figure to actually pay today. */
  payableCount: number;
  payableAmount: number;
  /** held rather than refused — a cleared case becomes payable later */
  heldCount: number;
  heldAmount: number;
  differences: Difference[];
  /** true when the three accounts agree completely, which does happen and is worth saying */
  clean: boolean;
  statement: string;
}

const EPSILON = 0.005;   // half a penny: float noise is not a dispute

/**
 * Reconcile one order.
 *
 * Both sides are keyed on the vendor's participant id, which is the only identifier they share. A claim with
 * no participant id cannot be matched to anything and is reported as `not_seen` rather than quietly dropped.
 */
export function reconcileSettlement(
  orderId: string,
  currency: string,
  claims: readonly VendorClaim[],
  records: readonly PlatformRecord[],
): Settlement {
  const byParticipant = new Map<string, PlatformRecord>();
  for (const r of records) if (r.participantId) byParticipant.set(r.participantId, r);

  const differences: Difference[] = [];
  let claimedCount = 0, claimedAmount = 0;
  let agreedCount = 0, agreedAmount = 0;
  let heldCount = 0, heldAmount = 0;

  const seen = new Set<string>();

  for (const c of [...claims].sort((a, b) => a.participantId.localeCompare(b.participantId))) {
    if (!c.billable) continue;
    claimedCount++;
    claimedAmount += c.amount ?? 0;
    seen.add(c.participantId);

    const r = c.participantId ? byParticipant.get(c.participantId) : undefined;

    if (!r) {
      differences.push({
        participantId: c.participantId || "(no id)",
        cause: "not_seen",
        vendorAmount: c.amount, platformAmount: null, delta: c.amount ?? 0,
        detail: "The vendor is billing for a participant this platform has no record of. Check whether the redirect back from the survey failed before deciding.",
      });
      continue;
    }

    if (r.outcome !== c.outcome) {
      differences.push({
        participantId: c.participantId, cause: "outcome_mismatch",
        vendorAmount: c.amount, platformAmount: r.amount, delta: (c.amount ?? 0) - (r.amount ?? 0),
        detail: `The vendor recorded this as a ${c.outcome.replace(/_/g, " ")}; the platform recorded a ${r.outcome.replace(/_/g, " ")}.`,
      });
      continue;
    }

    if (!r.accepted) {
      differences.push({
        participantId: c.participantId, cause: "rejected_on_quality",
        vendorAmount: c.amount, platformAmount: 0, delta: c.amount ?? 0,
        detail: "Both sides agree this person finished; the platform's quality rules rejected the response.",
      });
      continue;
    }

    if (r.heldForReview) {
      heldCount++;
      heldAmount += r.amount ?? c.amount ?? 0;
      differences.push({
        participantId: c.participantId, cause: "held_for_review",
        vendorAmount: c.amount, platformAmount: r.amount, delta: 0,
        detail: "Accepted, but an open fraud case is holding payment. It becomes payable if the case is cleared, and is not owed if it is upheld.",
      });
      continue;
    }

    const vendorAmt = c.amount ?? 0;
    const platformAmt = r.amount ?? 0;
    if (c.amount !== null && r.amount !== null && Math.abs(vendorAmt - platformAmt) > EPSILON) {
      differences.push({
        participantId: c.participantId, cause: "amount_mismatch",
        vendorAmount: c.amount, platformAmount: r.amount, delta: round2(vendorAmt - platformAmt),
        detail: `The vendor is claiming ${currency} ${vendorAmt.toFixed(2)}; the agreed rate makes it ${currency} ${platformAmt.toFixed(2)}.`,
      });
      /*
       * Still counted as agreed, at the PLATFORM's figure. The participation is not in dispute — only its
       * price is — and withholding the whole payment over a rounding disagreement helps nobody.
       */
      agreedCount++;
      agreedAmount += platformAmt;
      continue;
    }

    agreedCount++;
    agreedAmount += platformAmt || vendorAmt;
  }

  /*
   * The other direction, which a one-sided reconciliation misses entirely: participations the platform accepted
   * and the vendor has NOT billed for. Reporting these is not generosity — an unclaimed complete usually means
   * the vendor's own records are incomplete, and that is worth knowing before the next invoice arrives.
   */
  for (const r of [...records].sort((a, b) => a.participantId.localeCompare(b.participantId))) {
    if (seen.has(r.participantId)) continue;
    if (r.outcome !== "complete" || !r.accepted) continue;
    differences.push({
      participantId: r.participantId, cause: "unclaimed",
      vendorAmount: null, platformAmount: r.amount, delta: -(r.amount ?? 0),
      detail: "The platform accepted this complete and the vendor has not billed for it.",
    });
  }

  const payableCount = agreedCount;
  const payableAmount = round2(agreedAmount);

  const clean = differences.length === 0;
  const statement = clean
    ? `All ${agreedCount.toLocaleString()} claimed completes reconcile. ${currency} ${payableAmount.toLocaleString()} is payable.`
    : [
        `${claimedCount.toLocaleString()} claimed (${currency} ${round2(claimedAmount).toLocaleString()}),`,
        `${agreedCount.toLocaleString()} agreed (${currency} ${payableAmount.toLocaleString()}),`,
        heldCount ? `${heldCount.toLocaleString()} held pending fraud review (${currency} ${round2(heldAmount).toLocaleString()}),` : "",
        `${differences.length.toLocaleString()} ${differences.length === 1 ? "difference" : "differences"} to settle.`,
      ].filter(Boolean).join(" ");

  return {
    orderId, currency,
    claimedCount, claimedAmount: round2(claimedAmount),
    agreedCount, agreedAmount: payableAmount,
    payableCount, payableAmount,
    heldCount, heldAmount: round2(heldAmount),
    differences, clean, statement,
  };
}

/** Group the differences by cause, for a screen that shows the shape of a dispute before its detail. */
export function summariseDifferences(s: Settlement): Array<{ cause: DifferenceCause; count: number; delta: number }> {
  const by = new Map<DifferenceCause, { count: number; delta: number }>();
  for (const d of s.differences) {
    const cur = by.get(d.cause) ?? { count: 0, delta: 0 };
    by.set(d.cause, { count: cur.count + 1, delta: round2(cur.delta + d.delta) });
  }
  return [...by.entries()]
    .map(([cause, v]) => ({ cause, ...v }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.cause.localeCompare(b.cause));
}
