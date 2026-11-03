import test from "node:test";
import assert from "node:assert/strict";
import { reconcileSettlement, summariseDifferences, type PlatformRecord, type VendorClaim } from "./settlement.js";

const claim = (id: string, over: Partial<VendorClaim> = {}): VendorClaim =>
  ({ participantId: id, outcome: "complete", billable: true, amount: 5, ...over });
const record = (id: string, over: Partial<PlatformRecord> = {}): PlatformRecord =>
  ({ participantId: id, outcome: "complete", accepted: true, heldForReview: false, amount: 5, ...over });

const run = (claims: VendorClaim[], records: PlatformRecord[]) =>
  reconcileSettlement("o1", "GBP", claims, records);

test("when the three accounts agree, it says so plainly", () => {
  const s = run([claim("p1"), claim("p2")], [record("p1"), record("p2")]);
  assert.equal(s.clean, true);
  assert.deepEqual(s.differences, []);
  assert.equal(s.payableAmount, 10);
  assert.match(s.statement, /All 2 claimed completes reconcile/);
});

test("three totals are reported, because three different numbers is the truth", () => {
  const s = run(
    [claim("p1"), claim("p2"), claim("p3"), claim("p4")],
    [record("p1"), record("p2", { accepted: false }), record("p3", { heldForReview: true }), record("p4")],
  );
  assert.equal(s.claimedCount, 4, "the vendor claims four");
  assert.equal(s.agreedCount, 2, "two are agreed");
  assert.equal(s.heldCount, 1, "one is held, not refused");
  assert.equal(s.payableAmount, 10);
  assert.notEqual(s.claimedAmount, s.payableAmount);
});

test("a claim for someone we never saw is reported, with where to look", () => {
  const s = run([claim("ghost")], []);
  assert.equal(s.differences[0].cause, "not_seen");
  assert.equal(s.differences[0].delta, 5);
  assert.match(s.differences[0].detail, /redirect back from the survey failed/);
});

test("a complete WE accepted that the vendor has not billed for is reported too", () => {
  // the direction a one-sided reconciliation misses entirely
  const s = run([], [record("p1")]);
  assert.equal(s.differences[0].cause, "unclaimed");
  assert.equal(s.differences[0].delta, -5, "negative: the vendor is claiming less than we agree");
});

test("a quality rejection is named as one, not hidden in a net figure", () => {
  const s = run([claim("p1")], [record("p1", { accepted: false })]);
  assert.equal(s.differences[0].cause, "rejected_on_quality");
  assert.equal(s.payableAmount, 0);
  assert.match(s.differences[0].detail, /quality rules rejected/);
});

test("a fraud hold is held, not refused — and says it may yet become payable", () => {
  const s = run([claim("p1")], [record("p1", { heldForReview: true })]);
  assert.equal(s.differences[0].cause, "held_for_review");
  assert.equal(s.differences[0].delta, 0, "a hold is not a dispute about the amount");
  assert.equal(s.heldAmount, 5);
  assert.equal(s.payableAmount, 0, "not payable today");
  assert.match(s.differences[0].detail, /payable if the case is cleared/);
});

test("a price disagreement does not withhold the whole participation", () => {
  const s = run([claim("p1", { amount: 6 })], [record("p1", { amount: 5 })]);
  assert.equal(s.differences[0].cause, "amount_mismatch");
  assert.equal(s.differences[0].delta, 1);
  assert.equal(s.agreedCount, 1, "the participation is not in dispute, only its price");
  assert.equal(s.payableAmount, 5, "settled at the agreed rate, and the £1 is reported");
});

test("float noise is not a dispute", () => {
  const s = run([claim("p1", { amount: 5.001 })], [record("p1", { amount: 5 })]);
  assert.equal(s.clean, true);
});

test("an outcome disagreement is its own cause, not a quality rejection", () => {
  const s = run([claim("p1")], [record("p1", { outcome: "screenout" })]);
  assert.equal(s.differences[0].cause, "outcome_mismatch");
  assert.match(s.differences[0].detail, /vendor recorded this as a complete.*platform recorded a screenout/);
});

test("nothing is marked resolved — every difference waits for a human", () => {
  const s = run([claim("p1"), claim("ghost")], [record("p1", { accepted: false }), record("p9")]);
  assert.ok(s.differences.length >= 3);
  for (const d of s.differences) {
    assert.ok(d.detail.length > 20, "each difference carries its own explanation");
  }
  assert.ok(!("resolved" in s), "settlement reports; it does not decide");
});

test("non-billable claims are not counted as claims", () => {
  const s = run([claim("p1", { billable: false, outcome: "screenout" })], []);
  assert.equal(s.claimedCount, 0);
  assert.equal(s.clean, true, "a screenout nobody is billing for is not a disagreement");
});

test("the output is deterministic regardless of input order", () => {
  const a = run([claim("p2"), claim("p1")], [record("p1", { accepted: false }), record("p2", { accepted: false })]);
  const b = run([claim("p1"), claim("p2")], [record("p2", { accepted: false }), record("p1", { accepted: false })]);
  assert.deepEqual(a.differences.map((d) => d.participantId), b.differences.map((d) => d.participantId));
  assert.deepEqual(a.differences.map((d) => d.participantId), ["p1", "p2"]);
});

test("the summary ranks causes by how much money they move", () => {
  const s = run(
    [claim("g1", { amount: 50 }), claim("p1"), claim("p2")],
    [record("p1", { accepted: false }), record("p2", { amount: 5.5 })],
  );
  const sum = summariseDifferences(s);
  assert.equal(sum[0].cause, "not_seen", "the £50 claim for a stranger comes first");
  assert.equal(sum[0].delta, 50);
});
