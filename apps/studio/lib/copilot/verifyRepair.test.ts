import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeVerifyRepair, executionRepairNote, copilotUserPrompt, COPILOT_UX_GUIDE, EXECUTION_REPAIR_REASON } from "./prompt.ts";

/* S2c item 4 — the repair reason "execution": what the browser may send, and what the model is told */

test("the execution report is bounded and its items are plain", () => {
  assert.equal(sanitizeVerifyRepair(null), null);
  assert.equal(sanitizeVerifyRepair({ report: "  " }), null, "no report, no repair");
  const r = sanitizeVerifyRepair({ report: "x".repeat(9000), items: [{ key: "behaviour:b1", label: "hl", verdict: "ran-no-effect", extra: { a: 1 } }, { label: "no key" }, ...Array(20).fill({ key: "k", label: "l" })] })!;
  assert.equal(r.report.length, 4000);
  assert.equal(r.items.length, 9, "≤ 10 taken, the one without a key dropped");
  assert.deepEqual(r.items[0], { key: "behaviour:b1", label: "hl", verdict: "ran-no-effect" });
  assert.equal(EXECUTION_REPAIR_REASON, "execution");
});

test("the prompt carries the fenced report after the guides, with what to answer", () => {
  const note = executionRepairNote("<<FENCE>> - hl [ran-no-effect]: did nothing <<END>>");
  assert.match(note, /RAN THE SCRIPTS OF THE OPEN PROPOSAL IN A TEST SESSION/);
  assert.match(note, /update_behavior \{"id"/);
  assert.match(note, /"expect"/);
  const p = copilotUserPrompt({ message: "Repair the script that did not pass the test session: “hl”", outline: "Q1 · single", surveyLanguage: "en", mode: "edit", ux: true, executionReport: "<<FENCE>> report <<END>>" } as Parameters<typeof copilotUserPrompt>[0]);
  assert.ok(p.indexOf(COPILOT_UX_GUIDE) < p.indexOf("<<FENCE>> report"), "the guide first, then the report");
  assert.match(COPILOT_UX_GUIDE, /RUN in a test session before it is offered/);
});
