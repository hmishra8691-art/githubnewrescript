/**
 * TRUST SCORE WITH ACTIONS (Level 5 roadmap F6 — 2026-11-29).
 *
 * The identity table keeps a STANDING RISK: the highest risk any arrival has shown, lowered when a case is
 * cleared. It answers "how bad was the worst moment", not "how much should we trust this person now", and it
 * says nothing good about a respondent with forty clean completes. This is the second number.
 *
 * ## How it is computed
 *
 * A Beta-style average: a prior worth ten observations at 70 (a stranger is neither trusted nor distrusted), plus
 * the record. Each clean complete counts one in favour. Against: a rejected complete 3, a duplicate 3, an upheld
 * case 5, a complete classified suspicious or worse 1 (review-class 0.5), an open strong cross-survey finding 2.
 * A cleared case counts one in favour — the person was checked and was fine. The current standing risk then
 * caps the score: trust cannot exceed 100 − risk/2, so an identity mid-incident does not read as trusted on the
 * strength of its past.
 *
 * Confidence is the amount of evidence, kept apart from the score, so "new" is never confused with "bad".
 *
 * ## Actions
 *
 * The score recommends; it never blocks. The actions are steps a person or the gateway's existing policy can take,
 * from lightest to heaviest: allow · watch · verify (extra checks: attention items, identity verification) ·
 * review before payment (hold the complete, open a case) · quarantine (already upheld, or trust very low with
 * enough evidence). Quarantine is never recommended on low confidence alone: a newcomer with one bad complete is
 * verified, not quarantined. Every component and the action carry a sentence a reviewer can repeat.
 */
export interface TrustHistory {
  completes: number;
  /** completes by quality classification; the rest of `completes` are unclassified */
  classified?: { CLEAN?: number; REVIEW?: number; SUSPICIOUS?: number; HIGHLY_SUSPICIOUS?: number; CRITICAL?: number };
  rejections?: number;
  duplicates?: number;
  cases?: { status: "open" | "cleared" | "upheld" | "appealed" | "withdrawn"; kind?: string; risk?: number }[];
  /** open strong cross-survey findings (F3) against this identity */
  crossSurveyStrong?: number;
  /** 0–100, the identity's standing risk */
  standingRisk?: number;
  status?: "active" | "quarantined" | "blocked";
  firstSeen?: string | null;
}
export type TrustAction = "allow" | "watch" | "verify" | "review_before_payment" | "quarantine";
export interface TrustPolicy { verifyBelow: number; reviewBelow: number; quarantineBelow: number; minEvidenceToQuarantine: number }
export const DEFAULT_TRUST_POLICY: TrustPolicy = Object.freeze({ verifyBelow: 65, reviewBelow: 50, quarantineBelow: 30, minEvidenceToQuarantine: 5 });
export interface TrustComponent { what: string; effect: "for" | "against" | "cap"; weight: number; sentence: string }
export interface TrustScore {
  score: number;
  confidence: "low" | "medium" | "high";
  evidence: number;
  action: TrustAction;
  why: string;
  components: TrustComponent[];
}

const PRIOR_MEAN = 0.7, PRIOR_WEIGHT = 10;

export function trustScore(h: TrustHistory, policy: TrustPolicy = DEFAULT_TRUST_POLICY): TrustScore {
  const c = h.classified ?? {};
  const cases = h.cases ?? [];
  const upheld = cases.filter((x) => x.status === "upheld").length;
  const cleared = cases.filter((x) => x.status === "cleared").length;
  const open = cases.filter((x) => x.status === "open" || x.status === "appealed");
  const suspicious = (c.SUSPICIOUS ?? 0) + (c.HIGHLY_SUSPICIOUS ?? 0) + (c.CRITICAL ?? 0);
  const review = c.REVIEW ?? 0;
  /* a complete with no classification counts as clean only if nothing else is known against it: unclassified completes are half-weight */
  const classifiedTotal = (c.CLEAN ?? 0) + review + suspicious;
  const unclassified = Math.max(0, h.completes - classifiedTotal - (h.rejections ?? 0));
  const components: TrustComponent[] = [];
  const add = (what: string, effect: TrustComponent["effect"], weight: number, sentence: string) => { if (weight > 0) components.push({ what, effect, weight, sentence }); };
  add("clean completes", "for", c.CLEAN ?? 0, `${c.CLEAN ?? 0} complete${c.CLEAN === 1 ? "" : "s"} passed the quality checks.`);
  add("unclassified completes", "for", unclassified * 0.5, `${unclassified} complete${unclassified === 1 ? "" : "s"} without a quality assessment (counted at half weight).`);
  add("cleared cases", "for", cleared, `${cleared} case${cleared === 1 ? " was" : "s were"} reviewed and cleared.`);
  add("rejected completes", "against", (h.rejections ?? 0) * 3, `${h.rejections} complete${h.rejections === 1 ? " was" : "s were"} rejected.`);
  add("duplicates", "against", (h.duplicates ?? 0) * 3, `${h.duplicates} duplicate entr${h.duplicates === 1 ? "y" : "ies"}.`);
  add("upheld cases", "against", upheld * 5, `${upheld} fraud case${upheld === 1 ? " was" : "s were"} upheld by a reviewer.`);
  add("suspicious completes", "against", suspicious, `${suspicious} complete${suspicious === 1 ? " was" : "s were"} classified suspicious or worse.`);
  add("review-class completes", "against", review * 0.5, `${review} complete${review === 1 ? " was" : "s were"} classified for review.`);
  add("cross-survey findings", "against", (h.crossSurveyStrong ?? 0) * 2, `${h.crossSurveyStrong} open strong cross-survey duplicate finding${h.crossSurveyStrong === 1 ? "" : "s"}.`);
  const pro = components.filter((x) => x.effect === "for").reduce((a, x) => a + x.weight, 0);
  const con = components.filter((x) => x.effect === "against").reduce((a, x) => a + x.weight, 0);
  let score = (100 * (PRIOR_MEAN * PRIOR_WEIGHT + pro)) / (PRIOR_WEIGHT + pro + con);
  const risk = Math.max(0, Math.min(100, h.standingRisk ?? 0));
  const cap = 100 - risk / 2;
  if (score > cap) { components.push({ what: "standing risk", effect: "cap", weight: risk, sentence: `The identity's standing risk is ${Math.round(risk)}, which caps trust at ${Math.round(cap)}.` }); score = cap; }
  score = Math.round(score * 10) / 10;
  const evidence = Math.round((pro + con) * 10) / 10;
  const confidence = evidence < 3 ? "low" : evidence < 10 ? "medium" : "high";

  let action: TrustAction, why: string;
  if (h.status === "quarantined" || h.status === "blocked") { action = "quarantine"; why = `The identity is already ${h.status}; a reviewer reinstates it by clearing its case.`; }
  else if (score < policy.quarantineBelow && evidence >= policy.minEvidenceToQuarantine) { action = "quarantine"; why = `Trust ${score} is below ${policy.quarantineBelow} on ${confidence} evidence: hold completes and have a person review the identity.`; }
  else if (score < policy.reviewBelow) { action = evidence >= policy.minEvidenceToQuarantine || open.length ? "review_before_payment" : "verify"; why = action === "review_before_payment" ? `Trust ${score} is below ${policy.reviewBelow}: review the next complete before it is paid for.` : `Trust ${score} is low but rests on little evidence (${evidence}): add verification rather than holding payment.`; }
  else if (score < policy.verifyBelow) { action = "verify"; why = `Trust ${score} is below ${policy.verifyBelow}: add verification (attention items, identity check) to this person's next survey.`; }
  else if (open.length) { action = "watch"; why = `Trust ${score}, but ${open.length} case${open.length === 1 ? " is" : "s are"} open: allow, and let the case decide.`; }
  else { action = "allow"; why = confidence === "low" ? `A newcomer (little history): allowed, trust starts at ${score}.` : `Trust ${score} on ${confidence} evidence.`; }
  return { score, confidence, evidence, action, why, components };
}
