import { test } from "node:test";
import assert from "node:assert/strict";
import { researchRequest } from "./researchRequest.ts";

test("Intelligent mode starts the research agents from plain sentences, with the options the launcher used to send", () => {
  assert.deepEqual(researchRequest("Run the analysis plan"), { planner: "analysis", options: { environment: "LIVE", dataset: "all" }, label: "Run the analysis plan" });
  assert.deepEqual(researchRequest("please run every planned analysis on the test responses, clean dataset")?.options, { environment: "TEST", dataset: "clean" });
  assert.equal(researchRequest("Analyse the data")?.planner, "analysis");
  const r = researchRequest("Draft the findings report for an executive audience, leading with the NPS gap");
  assert.equal(r?.planner, "report");
  assert.deepEqual(r?.options, { audience: "executive", focus: "the NPS gap" });
  assert.deepEqual(researchRequest("write a findings report")?.options, { audience: "client", focus: undefined });
  const d = researchRequest("Recommend next steps for the decision: should we launch the premium tier in Q1?");
  assert.equal(d?.planner, "decision");
  assert.deepEqual(d?.options, { question: "should we launch the premium tier in Q1?" });
  assert.equal(researchRequest("recommend next steps from the findings")?.planner, "decision");
});

test("…and leaves every other sentence to the Copilot", () => {
  for (const s of ["Add a question about the annual report", "Explain the analysis framework", "Create a 40 question survey on banking", "Translate the survey into French", "Make Q4 shorter", "add a question asking what should we do next", ""]) {
    assert.equal(researchRequest(s), null, s);
  }
});
