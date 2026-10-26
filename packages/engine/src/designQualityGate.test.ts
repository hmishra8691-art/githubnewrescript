import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, designGeneratorRegistry } from "@rescript/schema";
import { runQualityCheck } from "./qualityCheck.js";

/*
 * THE WIRING, not the verdicts.
 *
 * What a sound design IS belongs to the generator that owns the method and is
 * tested in @rescript/designs. What this file pins is the thing that was
 * missing: that the publish gate ASKS, that an error makes the survey
 * undeployable, that a warning does not, and that a bare engine with no
 * generators loaded behaves exactly as it did before — because the engine
 * must never import @rescript/designs (dependency-boundaries R3) and so can
 * only ever ask a registry that may be empty.
 */

const def = (extra: Record<string, unknown> = {}) =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [{ id: "q1", code: "Q1", variableName: "MD", type: "maxdiff_task", text: "Pick", settings: { designRef: "d1" } }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
    deployment: { clientSlug: "c", studySlug: "s" },
    designs: [{ id: "d1", kind: "probe", name: "Features", version: 1, config: {}, file: { format: "json", columns: [], rows: [{ a: 1 }] } }],
    ...extra,
  });

function withPlugin<T>(inspect: (() => { level: "error" | "warning"; message: string }[]) | null, run: () => T): T {
  const had = designGeneratorRegistry.get("probe");
  designGeneratorRegistry.register({
    kind: "probe", label: "Probe", configFields: [],
    generate: () => ({ columns: [], rows: [] }),
    ...(inspect ? { inspect: () => inspect() } : {}),
  } as never);
  try { return run(); } finally { if (had) designGeneratorRegistry.register(had); }
}

test("with no generator loaded the gate behaves exactly as before — no design rules, and it still deploys", () => {
  const r = runQualityCheck(def());
  assert.equal(r.deployable, true, "a bare engine must not start refusing surveys it used to pass");
  assert.equal(JSON.stringify(r.areas).includes("never shows"), false);
});

test("a design ERROR makes the survey undeployable, and the researcher's sentence survives", () => {
  const r = withPlugin(() => [{ level: "error", message: "“Features” never shows 1 item to anyone (Warranty)." }], () => runQualityCheck(def()));
  assert.equal(r.deployable, false, "the publish gate refuses");
  assert.equal(r.errors >= 1, true);
  const text = JSON.stringify(r.areas);
  assert.match(text, /never shows 1 item to anyone/, "the message is passed through verbatim, not summarised into a code");
  assert.match(text, /Warranty/);
});

test("a design WARNING is reported and still deploys", () => {
  const r = withPlugin(() => [{ level: "warning", message: "“Features” shows its items between 4 and 7 times (ideal 5.5)." }], () => runQualityCheck(def()));
  assert.equal(r.deployable, true, "an imperfect but usable design is not blocked");
  assert.equal(r.warnings >= 1, true);
  assert.match(JSON.stringify(r.areas), /between 4 and 7 times/, "with the numbers, so the researcher can judge");
});

test("the finding lands in the Design files area, against the question that uses it", () => {
  const r = withPlugin(() => [{ level: "error", message: "bad" }], () => runQualityCheck(def()));
  const area = r.areas.find((a) => a.key === "designs" || a.label === "Design files");
  assert.ok(area, "a design finding is filed under designs, not swept into logic");
  assert.match(JSON.stringify(area), /Q1/, "and names the question whose design it is");
});

test("a design nothing points at is NOT checked — a draft must not block a publish", () => {
  const d = def({
    designs: [
      { id: "d1", kind: "probe", name: "Used", version: 1, config: {}, file: { format: "json", columns: [], rows: [{ a: 1 }] } },
      { id: "d2", kind: "probe", name: "Draft", version: 1, config: {}, file: { format: "json", columns: [], rows: [] } },
    ],
  });
  let asked = 0;
  const r = withPlugin(() => { asked++; return []; }, () => runQualityCheck(d));
  assert.equal(asked, 1, "only the referenced design is inspected");
  assert.equal(r.deployable, true);
});

test("a check that throws is an error, never a silent pass", () => {
  const r = withPlugin(() => { throw new Error("rows are not readable"); }, () => runQualityCheck(def()));
  assert.equal(r.deployable, false);
  assert.match(JSON.stringify(r.areas), /could not be checked/);
  assert.match(JSON.stringify(r.areas), /rows are not readable/);
});

test("one design used by two questions is inspected once", () => {
  const d = def({
    questions: [
      { id: "q1", code: "Q1", variableName: "A", type: "maxdiff_task", text: "x", settings: { designRef: "d1" } },
      { id: "q2", code: "Q2", variableName: "B", type: "maxdiff_task", text: "y", settings: { designRef: "d1" } },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e1", status: "complete" }],
  });
  let asked = 0;
  withPlugin(() => { asked++; return []; }, () => runQualityCheck(d));
  assert.equal(asked, 1, "the same design is not reported twice");
});
