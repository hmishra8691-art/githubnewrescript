/**
 * THE VENDOR ABSTRACTION LAYER.
 *
 * Deliberately NOT `server-only`, unlike credentials.ts beside it: this file holds no secret and touches no
 * server API. It is pure functions over plain data, so it can be unit tested directly — and the guarantee it
 * provides is worth far more as a test that runs than as a module nothing can import.
 *
 * A researcher plans recruitment, authorises spend and watches it arrive without ever learning which panel
 * company supplied it. That is a commercial requirement, and the only way to meet it that actually holds is to
 * never put the information in the response — not to omit it from a screen. A field that reaches the browser
 * has reached the researcher, whatever the component chose to render: it is in the network tab, in the page
 * source, and in any log that captured the payload.
 *
 * So these functions do not filter a view. They BUILD the researcher's payload from scratch out of the fields
 * a researcher is entitled to, and `assertNoVendorIdentity` exists so a test can prove nothing slipped in.
 *
 * ## What a researcher is entitled to
 *
 * Everything about THEIR project: how many completes, in which markets, at what price, by when, how it is
 * progressing, and how good the data is. None of it needs a supplier's name to be useful, and the quantities
 * are real — the same arithmetic the admin view reports, over the same rows.
 *
 * ## What is withheld, and why it is not merely renamed
 *
 * Vendor names, slugs, integration ids, per-vendor CPI, per-vendor allocation and per-vendor delivery. Note
 * that pseudonyms are NOT used: calling them "Source A" and "Source B" would still disclose the shape of the
 * supply chain — how many suppliers there are, how the sample was split, which one is failing — and a
 * researcher who sees "Source B is behind" learns the thing §5 says must stay invisible. The researcher's
 * plan is one plan.
 */

export interface InternalMarketRow {
  market: string;
  required: number;
  allocated: number;
  delivered: number;
  accepted: number;
  /** internal cost, before margin */
  cost: number;
  expectedDeliveryDays: number | null;
}

export interface ResearcherPlanInput {
  currency: string;
  requiredCompletes: number;
  markets: readonly InternalMarketRow[];
  /** how many distinct sources are behind this. Used ONLY to judge confidence; never reported as a number. */
  sourceCount: number;
  /** the price the researcher pays, margin already applied */
  price: number;
  feasible: boolean;
  shortfall: number;
  expectedDeliveryDays: number | null;
  /** 0-100 or null when there is not enough history, exactly as the vendor quality engine reports it */
  qualityScore: number | null;
  qualityConfidence: "none" | "low" | "medium" | "high";
  notes?: readonly string[];
}

export interface ResearcherPlan {
  currency: string;
  requiredCompletes: number;
  /** per MARKET, never per source */
  markets: Array<{
    market: string;
    required: number;
    planned: number;
    delivered: number;
    accepted: number;
    expectedDeliveryDays: number | null;
  }>;
  price: number;
  pricePerComplete: number | null;
  feasible: boolean;
  shortfall: number;
  expectedDeliveryDays: number | null;
  /**
   * How much recruitment capacity stands behind this plan, as a WORD. "Broad" and "limited" are honest about
   * resilience — which is what a researcher needs in order to judge risk — without disclosing a count that
   * would describe the supply chain.
   */
  capacity: "broad" | "adequate" | "limited" | "unknown";
  quality: { score: number | null; confidence: "none" | "low" | "medium" | "high" };
  notes: string[];
}

function capacityOf(sourceCount: number, feasible: boolean): ResearcherPlan["capacity"] {
  if (!feasible) return "limited";
  if (sourceCount <= 0) return "unknown";
  if (sourceCount >= 3) return "broad";
  if (sourceCount === 2) return "adequate";
  return "limited";
}

/** Build the researcher's plan. Takes internal rows, returns only what a researcher may have. */
export function researcherPlan(input: ResearcherPlanInput): ResearcherPlan {
  const markets = [...input.markets]
    .sort((a, b) => a.market.localeCompare(b.market))
    .map((m) => ({
      market: m.market,
      required: m.required,
      planned: m.allocated,
      delivered: m.delivered,
      accepted: m.accepted,
      expectedDeliveryDays: m.expectedDeliveryDays,
      /* m.cost is deliberately not carried: it is the internal acquisition cost, before margin */
    }));

  const accepted = markets.reduce((s, m) => s + m.accepted, 0);
  return {
    currency: input.currency,
    requiredCompletes: input.requiredCompletes,
    markets,
    price: input.price,
    pricePerComplete: input.requiredCompletes > 0
      ? Math.round((input.price / input.requiredCompletes) * 100) / 100
      : null,
    feasible: input.feasible,
    shortfall: input.shortfall,
    expectedDeliveryDays: input.expectedDeliveryDays,
    capacity: capacityOf(input.sourceCount, input.feasible),
    quality: { score: input.qualityScore, confidence: input.qualityConfidence },
    notes: [...(input.notes ?? [])],
  };
}

/**
 * Field names that must never appear in a researcher-facing payload.
 *
 * Checked by key name rather than by value, because a value check cannot see a vendor id that happens not to
 * be in the test's list of known vendors. A key called `integrationId` is wrong whatever it contains.
 */
const FORBIDDEN_KEYS = Object.freeze([
  "vendorname", "vendorslug", "vendorid", "vendor", "vendors", "integrationid", "integration",
  "integrations", "cpi", "agreedcpi", "markupbps", "markup", "cost", "acquisitioncost",
  "vendororderref", "ratecard", "pricing", "margin", "marginbps", "credentials", "hint",
]);

/**
 * Fragments that make a key forbidden wherever they appear in it.
 *
 * Exact matching is not enough, and the case that proved it was real: `totals.blendedCpi` is the average
 * price paid to suppliers, it reached every researcher, and a list containing "cpi" did not catch it because
 * the key was not called "cpi". A cost is a cost whatever it has been named — `blendedCpi`, `committed`,
 * `spend`, `acquisitionCost`, `costPerValidComplete` — so the fragments are checked as substrings.
 *
 * `price` is deliberately absent: what the researcher pays is theirs to see. Only what it cost US is not.
 */
const FORBIDDEN_FRAGMENTS = Object.freeze([
  "cpi", "cost", "margin", "markup", "vendor", "integration", "credential", "spend", "committed",
]);

export interface LeakReport { ok: boolean; found: string[] }

/**
 * Walk a payload and report any forbidden key, at any depth.
 *
 * This is the guarantee, not the comment above it. A route may be rewritten by somebody who has not read this
 * file; a test calling this will fail the moment a vendor field is spread back in — which is exactly how such
 * a field returns, as `{ ...row }` in a hurry rather than as a deliberate decision.
 */
export function findVendorIdentity(payload: unknown, path = "$"): LeakReport {
  const found: string[] = [];

  const walk = (node: unknown, at: string, depth: number): void => {
    if (depth > 12 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${at}[${i}]`, depth + 1));
      return;
    }
    if (typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const k = key.toLowerCase();
      if (FORBIDDEN_KEYS.includes(k) || FORBIDDEN_FRAGMENTS.some((f) => k.includes(f))) {
        found.push(`${at}.${key}`);
      }
      walk(value, `${at}.${key}`, depth + 1);
    }
  };

  walk(payload, path, 0);
  return { ok: found.length === 0, found };
}

/** The names of this organisation's vendors must not appear as VALUES either, however they got there. */
export function findVendorNames(payload: unknown, names: readonly string[]): LeakReport {
  if (!names.length) return { ok: true, found: [] };
  const text = JSON.stringify(payload ?? null);
  const found = names.filter((n) => n.trim().length >= 3 && text.toLowerCase().includes(n.toLowerCase()));
  return { ok: found.length === 0, found };
}
