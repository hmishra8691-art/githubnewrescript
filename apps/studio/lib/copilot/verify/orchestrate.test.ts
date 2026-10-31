import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyProposal, withDeadline, notRunReport, VERIFY_HARD_LIMIT_MS, REPAIR_WAIT_MS, PROPOSAL_LIMIT_MS, type VerifyState } from "./orchestrate.ts";
import type { VerificationReport } from "@rescript/engine";

/* S2c regression (production-intents ACCEPTED NOW): the test session ALWAYS ends in a terminal state within its budget */

const items = [{ key: "behaviour:b1", label: "Survey script" }];
const never = <T,>() => new Promise<T>(() => {});
const failing = (sig: string): VerificationReport => ({ signature: sig, at: "", durationMs: 1, items: [], verdicts: [{ key: "behaviour:b1", label: "Survey script", verdict: "ran-no-effect", summary: "did nothing", detail: [], scenarios: 1 }] });
const passing = (sig: string): VerificationReport => ({ ...failing(sig), verdicts: [{ ...failing(sig).verdicts[0]!, verdict: "ran-ok", summary: "ran" }] });
function deps(over: Partial<Parameters<typeof verifyProposal>[0]> = {}) {
  const states: VerifyState[] = [];
  let repairs = 0;
  const d: Parameters<typeof verifyProposal>[0] = {
    signature: "s1", items, run: async () => passing("s1"), repair: async () => undefined,
    canRepair: () => { if (repairs >= 1) return false; repairs++; return true; }, current: () => true, repaired: () => repairs,
    onState: (s) => states.push(s), runMs: 60, repairMs: 60, settleMs: 5, ...over,
  };
  return { d, states };
}

test("the budgets: running is bounded by the harness limit plus a grace; the repair by its own wait", () => {
  assert.equal(PROPOSAL_LIMIT_MS, 20000);
  assert.ok(VERIFY_HARD_LIMIT_MS > PROPOSAL_LIMIT_MS && VERIFY_HARD_LIMIT_MS <= 30000);
  assert.ok(REPAIR_WAIT_MS > 0 && Number.isFinite(REPAIR_WAIT_MS));
});

test("a harness that never settles ends as not-run with the reason, within the run budget", async () => {
  const { d, states } = deps({ run: never, canRepair: () => false });
  const t0 = Date.now();
  const end = await verifyProposal(d);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(end?.status, "done");
  assert.equal(end?.report?.verdicts[0]?.verdict, "not-run");
  assert.match(end!.report!.verdicts[0]!.summary, /did not finish within/);
  assert.equal(end?.ok, true, "not-run is not the script's fault: Apply is open");
  assert.deepEqual(states.map((s) => s.status), ["running", "done"]);
});

test("a harness that throws ends as not-run; a passing run ends ok without a repair", async () => {
  const a = deps({ run: async () => { throw new Error("no frame"); } });
  assert.match((await verifyProposal(a.d))!.report!.verdicts[0]!.summary, /the test session failed: no frame/);
  const b = deps();
  const end = await verifyProposal(b.d);
  assert.equal(end?.ok, true);
  assert.deepEqual(b.states.map((s) => s.status), ["running", "done"]);
});

test("a repair that never comes back ends as the previous verdict, failing (Apply anyway), within the repair budget", async () => {
  const { d, states } = deps({ run: async () => failing("s1"), repair: never });
  const t0 = Date.now();
  const end = await verifyProposal(d);
  assert.ok(Date.now() - t0 < 500);
  assert.deepEqual(states.map((s) => s.status), ["running", "repairing", "done"]);
  assert.equal(end?.ok, false);
  assert.equal(end?.repaired, 1);
  assert.equal(end?.report?.verdicts[0]?.verdict, "ran-no-effect");
});

test("a repair that answers (in words) ends failing; one that revised the proposal hands the card to the new run", async () => {
  const words = deps({ run: async () => failing("s1") });
  assert.equal((await verifyProposal(words.d))?.status, "done");
  let cur = true;
  const revised = deps({ run: async () => failing("s1"), repair: async () => { cur = false; }, current: () => cur });
  assert.equal(await verifyProposal(revised.d), null, "the revision's run owns the card");
  assert.deepEqual(revised.states.map((s) => s.status), ["running", "repairing"]);
  const second = deps({ run: async () => failing("s1"), canRepair: () => false });
  assert.deepEqual((await verifyProposal(second.d), second.states.map((s) => s.status)), ["running", "done"], "the one repair was used: straight to done");
});

test("withDeadline never rejects and never waits past its deadline", async () => {
  assert.equal(await withDeadline(never<number>(), 20, () => 7), 7);
  assert.equal(await withDeadline(Promise.reject(new Error("x")), 1000, (why) => (why === "error" ? 8 : 0)), 8);
  assert.equal(await withDeadline(Promise.resolve(9), 1000, () => 0), 9);
  assert.equal(notRunReport("s", items, "why").verdicts[0]!.verdict, "not-run");
});
