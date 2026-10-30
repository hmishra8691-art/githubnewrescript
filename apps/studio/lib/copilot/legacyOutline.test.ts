import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { migrateLegacyCustomCode } from "@rescript/engine";
import { copilotOutline } from "./outline.ts";

/* S1c item 4 (D17): Intelligent Mode's outline lists migrated code that will not run, with reasons and without the code */

const def = () => migrateLegacyCustomCode(SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Legacy" },
  questions: [{ id: "q1", code: "Q1", variableName: "A", type: "single_select", text: "A?", options: [{ code: 1, label: "Yes" }], customJs: "$('.rs-next').hide(); setInterval(function () { window.tick(); }, 50);" }],
  flow: [{ type: "block", id: "b", title: "B", children: [{ type: "page", id: "p", questionIds: ["q1"] }] }, { type: "end", id: "e", status: "complete" }],
})).def;

test("outline: 'Code that will NOT run' with the origin and the reasons (window, $, setInterval)", () => {
  const out = copilotOutline(def());
  const at = out.indexOf("Code that will NOT run (1;");
  assert.ok(at >= 0, out);
  const block = out.slice(at, at + 1200);
  assert.match(block, /from question Q1's Custom code/);
  assert.match(block, /\$ is not available/);
  assert.match(block, /setInterval/);
  assert.match(block, /window/);
  // a survey whose code all runs has no such block
  assert.ok(!copilotOutline(SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "T" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] })).includes("will NOT run"));
});
