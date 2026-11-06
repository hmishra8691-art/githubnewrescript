import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { interpretRequest } from "./nlIntent.js";

/* IM6 — cleaning sentences become a batch request the Studio previews */
const def = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [{ id: "q1", code: "Q1", variableName: "WHY", type: "open_text", text: "Why?" }], flow: [{ type: "page", id: "p1", questionIds: ["q1"] }] });
const req = (s: string) => { const o = interpretRequest(def, s) as unknown as { kind: string; request: Record<string, unknown> }; assert.equal(o.kind, "cleaning", `${s}: ${JSON.stringify(o).slice(0, 200)}`); return o.request; };

test("the harness's cleaning sentences", () => {
  assert.equal(req("Flag speeders and straightliners and exclude duplicates").decision, "REMOVE");
  assert.equal(req("Remove the gibberish open-ended responses").decision, "REMOVE");
  assert.deepEqual(req("Why was respondent 123 flagged?"), { explain: "123" });
});
test("decisions, verdicts, the model reading", () => {
  assert.equal(req("Mark the speeders for review").decision, "REVIEW_LATER");
  assert.deepEqual(req("Exclude the flagged responses").verdicts, ["FLAGGED"]);
  assert.deepEqual(req("Remove low-quality responses").recommendation, ["LIKELY EXCLUDE", "REVIEW BEFORE INCLUSION"]);
  assert.equal(req("Use AI to read the open ends and flag gibberish").judge, true);
  assert.equal(req("Keep the speeders").decision, "KEEP");
});
test("not cleaning", () => {
  for (const s of ["Add a question about duplicates", "What is a speeder?", "Remove Q1"]) assert.notEqual(interpretRequest(def, s).kind, "cleaning", s);
});
