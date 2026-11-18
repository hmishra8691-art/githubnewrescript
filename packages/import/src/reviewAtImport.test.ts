import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeImport } from "./index.js";

/* audit 2026-11-17, P1-02: a questionnaire that contradicts itself is told so at import, beside everything else */
const DOC = `S1. How old are you?
1. 18-25
2. 25-34
3. 35-44
4. 50+
Q1. Do you own a car?
1. Yes
2. No
ASK IF Q1 = 1 AND Q1 = 2
Q2. Which brand is your car?
1. Toyota
2. Ford
Q3. How satisfied are you with your car?
1. Very satisfied
2. Dissatisfied
`;

test("an impossible condition, overlapping ranges and a gap in a range are reported by the import itself", async () => {
  const r = await analyzeImport(new TextEncoder().encode(DOC), "spec.txt", { surveyId: "c" });
  const msgs = r.result!.issues.filter((i) => i.location.startsWith("Review")).map((i) => `${i.severity}: ${i.message}`);
  assert.ok(msgs.some((m) => /^high: Q2 can never be shown: .*cannot be both 1 and 2/.test(m)), msgs.join("\n"));
  assert.ok(msgs.some((m) => /^medium: S1: options “18-25” and “25-34” overlap/.test(m)), msgs.join("\n"));
  assert.ok(msgs.some((m) => /^medium: S1: nothing between “35-44” and “50\+”/.test(m)), msgs.join("\n"));
});

test("a clean questionnaire gets no review findings", async () => {
  const r = await analyzeImport(new TextEncoder().encode("S1. Age?\n1. 18-24\n2. 25-34\n3. 35+\nQ1. Own a car?\n1. Yes\n2. No\n"), "ok.txt", { surveyId: "ok" });
  assert.deepEqual(r.result!.issues.filter((i) => i.location.startsWith("Review") && i.severity !== "low"), []);
});
