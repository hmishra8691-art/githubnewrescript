import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { buildVariableDictionary } from "./variables.js";
import { flattenVariables } from "./flatten.js";
import { createResponseState } from "./state.js";

/**
 * The dictionary and the runtime must agree about what an image select IS.
 *
 * `namingParity.test.ts` in the templates package sweeps the master demo and
 * is the broad guard, but the demo's image question is single-choice — so it
 * could not see this. The bug was that `variables.ts` grouped `image_select`
 * with single_select while `flatten.ts` grouped it with multi_select, and a
 * MULTIPLE-choice image question therefore had its per-option flags written
 * at interview time and declared nowhere. Every exporter builds its columns
 * from the dictionary, so those answers reached no delivered file.
 */

const survey = (maxSelections: number) =>
  SurveyDefinition.parse({
    meta: { id: "img", code: "IMG", title: "Image select", version: "1.0", status: "draft" },
    questions: [{
      id: "q", code: "Q1", variableName: "PICK", type: "image_select", text: "Which?",
      settings: { maxSelections },
      options: [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }],
    }],
    flow: [{ type: "page", id: "p", questionIds: ["q"] }, { type: "end", id: "e", status: "complete" }],
  });

const namesFor = (maxSelections: number, answer: unknown) => {
  const def = survey(maxSelections);
  const state = createResponseState(def);
  state.answers = { q: answer } as any;
  return {
    declared: buildVariableDictionary(def).filter((v) => v.questionId === "q").map((v) => v.name),
    written: Object.keys(flattenVariables(def, state as any, {})).filter((n) => n.startsWith("PICK")),
    flat: flattenVariables(def, state as any, {}),
  };
};

test("a single-choice image select is one column, in both files", () => {
  const { declared, written, flat } = namesFor(1, "a");
  assert.deepEqual(declared, ["PICK"]);
  assert.deepEqual(written, ["PICK"], "no orphan flags are written for a single choice");
  assert.equal(flat.PICK, "a", "and the answer is the code, not a one-element list");
});

test("a multiple-choice image select declares the flags it writes", () => {
  /*
   * The regression. Before the fix the dictionary declared only `PICK`, so
   * the export carried one column of `a;b` instead of the per-option columns
   * a crosstab needs — and `PICK_a` / `PICK_b` were written and thrown away.
   */
  const { declared, written, flat } = namesFor(2, ["a", "b"]);
  assert.ok(declared.includes("PICK_a") && declared.includes("PICK_b"),
    `the flags must be declared, got ${declared.join(", ")}`);
  for (const name of written) {
    if (name === "PICK") continue;   // the list form, as for any multiple response
    assert.ok(declared.includes(name), `${name} is written but not declared, so no export would carry it`);
  }
  assert.equal(flat.PICK_a, 1);
  assert.equal(flat.PICK_b, 1);
});

test("the flags say which options were NOT chosen too", () => {
  const { flat } = namesFor(2, ["a"]);
  assert.equal(flat.PICK_a, 1);
  assert.equal(flat.PICK_b, 0, "an unchosen option is 0, not missing — that is what makes a base");
});
