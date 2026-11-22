import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewQueue, ruleVerdicts, reviewerAgreement, type ConsoleRow, type ReviewRecord } from "./reviewConsole.js";

const row = (id: string, verdict: string, risk: number, extra: Partial<ConsoleRow> = {}): ConsoleRow => ({ sessionId: id, classification: verdict === "PASS" ? "CLEAN" : "SUSPICIOUS", verdict, riskScore: risk, flags: [{ ruleId: "timing.speeder", title: "Speeder" }], ...extra });

test("queue: flagged first, one response per cluster ahead of its siblings, decided ones gone, later ones last", () => {
  const q = reviewQueue([
    row("clean", "PASS", 5),
    row("r1", "REVIEW", 40),
    row("f1", "FLAGGED", 70),
    row("c1", "FLAGGED", 90, { clusterId: "K", clusterSize: 3 }),
    row("c2", "FLAGGED", 88, { clusterId: "K", clusterSize: 3 }),
    row("done", "FLAGGED", 95, { reviewStatus: "REMOVE" }),
    row("later", "FLAGGED", 99, { reviewStatus: "REVIEW_LATER" }),
  ]);
  assert.deepEqual(q.items.map((i) => i.sessionId), ["c1", "f1", "c2", "r1", "later"]);
  assert.equal(q.decided, 1);
  assert.ok(q.items[0]!.representsCluster);
  assert.match(q.items[0]!.why, /decides a cluster of 3/);
  assert.match(q.items[4]!.why, /put off earlier/);
});

test("rule verdicts: reviewer-judged precision with an interval, and 'too few' under ten decisions", () => {
  const rows: ConsoleRow[] = [
    ...Array.from({ length: 12 }, (_, i) => row(`a${i}`, "FLAGGED", 80, { reviewStatus: i < 2 ? "REMOVE" : "KEEP", flags: [{ ruleId: "attention.fail", title: "Attention check" }] })),
    ...Array.from({ length: 4 }, (_, i) => row(`b${i}`, "FLAGGED", 80, { reviewStatus: "REMOVE", flags: [{ ruleId: "bot.webdriver", title: "Automation" }, { ruleId: "info", role: "informational" }] })),
  ];
  const v = ruleVerdicts(rows);
  const att = v.find((x) => x.ruleId === "attention.fail")!;
  assert.equal(att.removed, 2); assert.equal(att.kept, 10); assert.equal(att.precision, 0.167);
  assert.ok(att.low! < 0.167 && att.high! > 0.167 && att.high! < 0.5);
  assert.match(att.reading, /may be too sensitive/);
  assert.match(v.find((x) => x.ruleId === "bot.webdriver")!.reading, /too few to judge/);
  assert.ok(!v.some((x) => x.ruleId === "info"), "informational flags are not judged");
});

test("agreement: Cohen's kappa on two reviewers' latest keep/remove", () => {
  /* 10 pairs: 4 both remove, 4 both keep, 2 disagree → po 0.8; p1 = 0.5, p2 = 0.5 → pe 0.5 → κ 0.6 */
  const recs: ReviewRecord[] = [];
  const pairs: [string, string][] = [...Array(4).fill(["REMOVE", "REMOVE"]), ...Array(4).fill(["KEEP", "KEEP"]), ["REMOVE", "KEEP"], ["KEEP", "REMOVE"]];
  pairs.forEach(([a, b], i) => { recs.push({ responseId: `r${i}`, decision: a, decidedBy: "u1", decidedAt: "2026-11-01T10:00:00Z" }, { responseId: `r${i}`, decision: b, decidedBy: "u2", decidedAt: "2026-11-01T11:00:00Z" }); });
  recs.push({ responseId: "r0", decision: "KEEP", decidedBy: "u1", decidedAt: "2026-10-01T10:00:00Z" }, { responseId: "solo", decision: "KEEP", decidedBy: "u1", decidedAt: "2026-11-01T10:00:00Z" });
  const a = reviewerAgreement(recs);
  assert.equal(a.pairs, 10); assert.equal(a.observed, 0.8); assert.equal(a.kappa, 0.6);
  assert.match(a.reading, /κ 0.6 \(substantial\)/);
  assert.equal(reviewerAgreement([]).kappa, null);
});
