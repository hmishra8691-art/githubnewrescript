import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import * as engine from "@rescript/engine";
import { NATIVE_CAPABILITIES } from "./nativeRegistry.js";

/** the registry describes what the platform does: every sample survives the schema whole, every runtime function exists */
const missing = (want: unknown, got: unknown, path = ""): string[] => {
  if (want === null || typeof want !== "object") return want === got || (typeof want === "number" && got === want) ? [] : [`${path || "value"}: wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`];
  if (Array.isArray(want)) return Array.isArray(got) ? want.flatMap((w, i) => missing(w, got[i], `${path}[${i}]`)) : [`${path}: not an array`];
  if (!got || typeof got !== "object") return [`${path}: missing`];
  return Object.entries(want).flatMap(([k, v]) => (k in (got as object) ? missing(v, (got as Record<string, unknown>)[k], path ? `${path}.${k}` : k) : [`${path ? `${path}.` : ""}${k}: stripped by the schema`]));
};

test("every native capability's JSON is accepted by the schema as written, and its runtime is an engine export", () => {
  assert.ok(NATIVE_CAPABILITIES.length >= 20);
  for (const c of NATIVE_CAPABILITIES) {
    const q1 = { id: "q1", code: "Q1", variableName: "Q1", type: "multi_select", text: "Which?", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }] };
    const q2 = { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "And?", options: [{ code: 1, label: "Yes" }], ...(c.at === "question" ? c.sample : {}) };
    const raw = {
      meta: { id: "s", code: "S", title: "S" },
      questions: [q1, q2],
      flow: [{ type: "block", id: "b0", children: [{ type: "page", id: "p0", questionIds: ["q1", "q2"] }] }, ...(c.at === "flow" ? [c.sample] : []), ...(c.at === "flow" && c.sample.type === "end" ? [] : [{ type: "end", id: "eend", status: "complete" }])],
      ...(c.at === "survey" ? c.sample : {}),
    };
    const parsed = SurveyDefinition.safeParse(raw);
    assert.ok(parsed.success, `${c.id}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))}`);
    const got = c.at === "question" ? parsed.data!.questions[1] : c.at === "flow" ? parsed.data!.flow[1] : parsed.data;
    assert.deepEqual(missing(c.sample, got), [], c.id);
    assert.equal(typeof (engine as Record<string, unknown>)[c.runtime], "function", `${c.id}: engine.${c.runtime}`);
  }
});
