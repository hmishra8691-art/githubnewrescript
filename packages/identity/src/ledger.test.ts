import test from "node:test";
import assert from "node:assert/strict";
import {
  canTransition, decideAdmission, deduplicationStatement, isLive, isTerminal,
  nextStates, PARTICIPATION_STATES, DEFAULT_PROBABILISTIC_THRESHOLD,
} from "./ledger.js";

test("the brief's ten states, and the terminal ones go nowhere", () => {
  assert.equal(PARTICIPATION_STATES.length, 10);
  for (const s of ["completed", "rejected", "duplicate", "expired"] as const) {
    assert.ok(isTerminal(s));
    assert.deepEqual(nextStates(s), []);
  }
  assert.equal(isTerminal("reserved"), false);
});

test("a quarantined person still holds their place — otherwise the review is pointless", () => {
  assert.ok(isLive("quarantined"), "they must not get back in through another vendor while held");
  assert.ok(isLive("completed"));
  assert.equal(isLive("duplicate"), false, "a refused attempt frees nothing and blocks nothing");
  assert.equal(isLive("expired"), false);
  // and a quarantine is resolved by a human, either way
  assert.ok(canTransition("quarantined", "eligible"));
  assert.ok(canTransition("quarantined", "rejected"));
  assert.equal(canTransition("quarantined", "completed"), false);
});

test("illegal moves are illegal", () => {
  assert.ok(canTransition("reserved", "in_survey"));
  assert.ok(canTransition("in_survey", "completed"));
  assert.equal(canTransition("completed", "in_survey"), false);
  assert.equal(canTransition("expired", "reserved"), false, "a swept row is not revived; a new one is made");
  assert.equal(canTransition("invited", "completed"), false, "nobody completes without passing through the survey");
});

const admit = (o: Partial<Parameters<typeof decideAdmission>[0]> = {}) => decideAdmission({
  mode: "enforce", resolution: "deterministic", confidence: 100, wouldBlock: true, ...o,
});

test("shadow mode refuses nobody, and says what it would have done", () => {
  const d = admit({ mode: "shadow", heldState: "completed" });
  assert.equal(d.admit, true);
  assert.equal(d.wouldBlock, true);
  assert.equal(d.code, "observed_only");
  assert.match(d.reason, /refuses nobody/);
});

test("a weak circumstantial match never refuses, in any mode", () => {
  const shadow = admit({ mode: "shadow", resolution: "probabilistic", confidence: 55 });
  assert.equal(shadow.admit, true);
  assert.equal(shadow.wouldBlock, false, "below the threshold it is not even counted as a would-block");
  assert.match(shadow.reason, /below the 85% needed/);

  const enforced = admit({ resolution: "probabilistic", confidence: 75 });
  assert.equal(enforced.admit, true, "a household on one router is two people");
  assert.equal(enforced.code, "admitted");
  assert.match(enforced.reason, /not enough to refuse a respondent/);
});

test("a strong circumstantial match does refuse under enforcement, at the threshold", () => {
  assert.equal(admit({ resolution: "probabilistic", confidence: DEFAULT_PROBABILISTIC_THRESHOLD }).admit, false);
  assert.equal(admit({ resolution: "probabilistic", confidence: DEFAULT_PROBABILISTIC_THRESHOLD - 1 }).admit, true);
  // and the threshold is configurable, because the cost of being wrong is somebody's earnings
  assert.equal(admit({ resolution: "probabilistic", confidence: 75, probabilisticThreshold: 70 }).admit, false);
});

test("the refusal names the fact, because a vendor reconciling an invoice needs the difference", () => {
  assert.equal(admit({ heldState: "completed" }).code, "already_completed");
  assert.equal(admit({ heldState: "quarantined" }).code, "under_review");
  assert.equal(admit({ heldState: "reserved" }).code, "duplicate");
  assert.equal(admit({ heldState: "in_survey" }).code, "duplicate");
  assert.match(admit({ heldState: "completed" }).reason, /already completed this study/);
});

test("nothing is refused when there is nothing to refuse, or when checking is off", () => {
  const clean = admit({ wouldBlock: false });
  assert.equal(clean.admit, true);
  assert.equal(clean.code, "admitted");
  const off = admit({ mode: "off", heldState: "completed" });
  assert.equal(off.admit, true);
  assert.equal(off.code, "not_checked");
});

test("the report says what can be supported, not 'zero duplicates'", () => {
  const s = deduplicationStatement({
    accepted: 5000, deterministicBlocks: 180, probabilisticBlocks: 24, observedOnly: 0, unresolved: 1430,
  });
  assert.match(s, /5,000 accepted completes/);
  assert.match(s, /180 duplicate attempts refused on a certain match/);
  assert.match(s, /24 on a circumstantial one/);
  assert.match(s, /1,430 arrivals could not be linked/);
  assert.match(s, /cannot be ruled out/);
  assert.doesNotMatch(s, /zero duplicates/i);

  // a clean project says less, and still does not overclaim
  const tidy = deduplicationStatement({ accepted: 100, deterministicBlocks: 2, probabilisticBlocks: 0, observedOnly: 0, unresolved: 0 });
  assert.doesNotMatch(tidy, /circumstantial|could not be linked/);
});
