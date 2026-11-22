/**
 * THE REVIEW CONSOLE'S ARITHMETIC (Level 5 roadmap F11 — 2026-11-29).
 *
 * The quality panel already shows every assessment and records KEEP / REMOVE / REVIEW LATER with a reason, one at
 * a time or in bulk, with a history per response. What it did not do is decide what a reviewer should look at
 * next, learn from what reviewers decided, or say whether two reviewers agree. Three pure functions:
 *
 *   reviewQueue     what to review, in order. Flagged before review-class, riskier first, and ONE response per
 *                   coordinated cluster ahead of its siblings — decide the ring once, then confirm the rest.
 *                   Decided responses leave the queue; "review later" ones go to the back.
 *   ruleVerdicts    for each rule, how often reviewers removed a response it fired on: the precision of the rule
 *                   as people judged it, with a Wilson interval, and "too few to judge" under ten decisions. The
 *                   figure the false-positive banner has been waiting for, per rule.
 *   reviewerAgreement  responses decided by two different reviewers: observed agreement and Cohen's κ on
 *                   keep / remove. Without it nobody knows whether "remove" means the same thing to two people.
 */
export interface ConsoleRow {
  sessionId: string;
  classification: string | null;
  verdict: string | null;
  riskScore: number | null;
  flags: { ruleId: string; role?: string; title?: string }[];
  clusterId?: string | null;
  clusterSize?: number;
  reviewStatus?: string | null;
}
export interface QueueItem { sessionId: string; priority: number; why: string; clusterId: string | null; representsCluster: boolean }

export function reviewQueue(rows: ConsoleRow[], limit = 50): { items: QueueItem[]; remaining: number; decided: number } {
  const decided = rows.filter((r) => r.reviewStatus === "KEEP" || r.reviewStatus === "REMOVE").length;
  const open = rows.filter((r) => r.reviewStatus !== "KEEP" && r.reviewStatus !== "REMOVE" && ((r.verdict && r.verdict !== "PASS") || (r.classification && r.classification !== "CLEAN")));
  const seenCluster = new Set<string>();
  const scored = open
    .sort((a, b) => (b.riskScore ?? 0) - (a.riskScore ?? 0))
    .map((r) => {
      const later = r.reviewStatus === "REVIEW_LATER";
      const tier = r.verdict === "FLAGGED" ? 2 : 1;
      const cl = r.clusterId && (r.clusterSize ?? 0) > 1 ? r.clusterId : null;
      const lead = !!cl && !seenCluster.has(cl);
      if (cl) seenCluster.add(cl);
      const priority = (later ? 0 : 1000) + tier * 200 + (cl ? (lead ? 150 : -150) : 0) + (r.riskScore ?? 0);
      const strong = r.flags.filter((f) => f.role !== "informational").slice(0, 2).map((f) => f.title ?? f.ruleId);
      const why = [
        r.verdict === "FLAGGED" ? "flagged: confident evidence" : "worth a look",
        `risk ${Math.round(r.riskScore ?? 0)}`,
        ...(cl ? [lead ? `decides a cluster of ${r.clusterSize}` : "in a cluster already shown"] : []),
        ...(strong.length ? [strong.join(", ")] : []),
        ...(later ? ["put off earlier"] : []),
      ].join(" · ");
      return { sessionId: r.sessionId, priority: Math.round(priority * 10) / 10, why, clusterId: cl, representsCluster: lead };
    })
    .sort((a, b) => b.priority - a.priority);
  return { items: scored.slice(0, limit), remaining: scored.length, decided };
}

export interface RuleVerdict { ruleId: string; title: string; decided: number; removed: number; kept: number; precision: number | null; low: number | null; high: number | null; reading: string }

function wilson(k: number, n: number, z = 1.96): [number, number] | null {
  if (!n) return null;
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

export function ruleVerdicts(rows: ConsoleRow[], minDecisions = 10): RuleVerdict[] {
  const by = new Map<string, { title: string; removed: number; kept: number }>();
  for (const r of rows) {
    if (r.reviewStatus !== "KEEP" && r.reviewStatus !== "REMOVE") continue;
    for (const f of new Map(r.flags.filter((x) => x.role !== "informational").map((x) => [x.ruleId, x])).values()) {
      const e = by.get(f.ruleId) ?? { title: f.title ?? f.ruleId, removed: 0, kept: 0 };
      if (r.reviewStatus === "REMOVE") e.removed++; else e.kept++;
      by.set(f.ruleId, e);
    }
  }
  return [...by.entries()].map(([ruleId, e]) => {
    const n = e.removed + e.kept, w = wilson(e.removed, n);
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const reading = n < minDecisions
      ? `${n} decision${n === 1 ? "" : "s"} so far — too few to judge this rule.`
      : `Reviewers removed ${e.removed} of ${n} responses it fired on (${pct(e.removed / n)}, 95% interval ${pct(w![0])}–${pct(w![1])}).${w![1] < 0.5 ? " Mostly kept: this rule may be too sensitive here." : ""}`;
    return { ruleId, title: e.title, decided: n, removed: e.removed, kept: e.kept, precision: n ? Math.round((e.removed / n) * 1000) / 1000 : null, low: w ? Math.round(w[0] * 1000) / 1000 : null, high: w ? Math.round(w[1] * 1000) / 1000 : null, reading };
  }).sort((a, b) => b.decided - a.decided);
}

export interface ReviewRecord { responseId: string; decision: string; decidedBy: string | null; decidedAt: string }
export interface Agreement { pairs: number; agree: number; observed: number | null; kappa: number | null; reading: string }

export function reviewerAgreement(reviews: ReviewRecord[], minPairs = 10): Agreement {
  /* the latest keep/remove of each reviewer on each response */
  const latest = new Map<string, Map<string, { d: string; at: string }>>();
  for (const r of reviews) {
    if (!r.decidedBy || (r.decision !== "KEEP" && r.decision !== "REMOVE")) continue;
    const m = latest.get(r.responseId) ?? new Map();
    const cur = m.get(r.decidedBy);
    if (!cur || r.decidedAt > cur.at) m.set(r.decidedBy, { d: r.decision, at: r.decidedAt });
    latest.set(r.responseId, m);
  }
  const pairs: [string, string][] = [];
  for (const m of latest.values()) {
    if (m.size < 2) continue;
    const two = [...m.values()].sort((a, b) => (a.at < b.at ? -1 : 1)).slice(0, 2);
    pairs.push([two[0]!.d, two[1]!.d]);
  }
  const n = pairs.length;
  if (!n) return { pairs: 0, agree: 0, observed: null, kappa: null, reading: "No response has been decided by two different reviewers yet." };
  const agree = pairs.filter(([a, b]) => a === b).length;
  const po = agree / n;
  const p1 = pairs.filter(([a]) => a === "REMOVE").length / n, p2 = pairs.filter(([, b]) => b === "REMOVE").length / n;
  const pe = p1 * p2 + (1 - p1) * (1 - p2);
  const kappa = pe === 1 ? null : (po - pe) / (1 - pe);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const label = kappa == null ? "" : kappa >= 0.8 ? "strong" : kappa >= 0.6 ? "substantial" : kappa >= 0.4 ? "moderate" : kappa >= 0.2 ? "fair" : "poor";
  return {
    pairs: n, agree, observed: r3(po), kappa: kappa == null ? null : r3(kappa),
    reading: `${agree} of ${n} double-reviewed responses got the same decision (${Math.round(po * 100)}%)${kappa == null ? "; κ is undefined because every decision was the same" : `; κ ${r3(kappa)} (${label})`}${n < minPairs ? ` — only ${n} pair${n === 1 ? "" : "s"}, read as indicative` : ""}.`,
  };
}
