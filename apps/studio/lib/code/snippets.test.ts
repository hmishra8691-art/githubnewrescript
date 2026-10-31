import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { codeGate, validateUxScript } from "@rescript/engine";
import { SNIPPETS, snippetCompletions, snippetsFor } from "./snippets.ts";
import { codeCompletions } from "./completions.ts";

/* S3b item 7 (MM-12): the built-in snippets — every one passes its own gate as written, and is offered by completion */

const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "T" },
  questions: ["Q1", "Q2", "AGE", "YEARS_DRIVING"].map((c, i) => ({ id: `q${i}`, code: c, variableName: c, type: "numeric", text: c })),
  flow: [{ type: "block", id: "b1", title: "Section 1", children: [{ type: "page", id: "p1", questionIds: ["q0", "q1"] }] }, { type: "block", id: "b2", title: "Section 2", children: [{ type: "page", id: "p2", questionIds: ["q2", "q3"] }] }, { type: "end", id: "e", status: "complete" }],
});

test("the eight snippets the task names, by kind", () => {
  assert.deepEqual(SNIPPETS.map((s) => s.id), ["highlight-on-select", "live-total-warning", "countdown-display", "message-after-answer", "section-jump-button", "logic-calc", "logic-validation", "component-skeleton"]);
  assert.equal(snippetsFor("ux").length, 5);
  assert.equal(snippetsFor("logic").length, 2);
  assert.equal(snippetsFor("component").length, 1);
  assert.equal(snippetsFor("css").length, 0);
});

test("every snippet passes its gate as written (behaviour: validateUxScript; logic / component: codeGate)", () => {
  for (const s of SNIPPETS) {
    if (s.kind === "ux") { const v = validateUxScript(s.body, def); assert.deepEqual(v.errors, [], `${s.id}: ${v.errors.join("; ")}`); }
    else { const v = codeGate(s.body, s.kind); assert.ok(v.ok, `${s.id}: ${v.errors.join("; ")}`); }
  }
});

test("completion offers them as type snippet at a bare name, inserting the body; never inside a string or after rs.", () => {
  assert.ok(snippetCompletions("ux").every((c) => c.type === "snippet" && c.apply && c.label.startsWith("snippet ")));
  const at = codeCompletions("ux", def, "high", 4)!;
  assert.ok(at.options.some((o) => o.type === "snippet" && o.label === "snippet highlight on select"));
  const logic = codeCompletions("logic", def, "val", 3)!;
  assert.ok(logic.options.some((o) => o.label === "snippet logic script validation"));
  assert.ok(!logic.options.some((o) => o.label === "snippet highlight on select"), "kind-specific");
  assert.ok(!(codeCompletions("ux", def, "rs.", 3)?.options ?? []).some((o) => o.type === "snippet"));
  assert.ok(!(codeCompletions("ux", def, 'rs.getAnswer("', 14)?.options ?? []).some((o) => o.type === "snippet"));
});
