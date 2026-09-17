/**
 * RETIREMENT MUST BE INVISIBLE TO A SURVEY IN FIELD.
 *
 * The review asked for seven duplicate question types to be removed. What
 * makes that safe is that "removed" means removed from the picker and from
 * newly written data — never from the resolver, because a stored id that
 * resolves to nothing loses its renderer, and a Tile Select would stop being
 * drawn as cards at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, resolveVariant, variantRegistry, isSelectableVariant } from "@rescript/schema";
import { migrateRetiredVariants } from "./retireVariants.js";

const RETIRED_BY_THE_REVIEW = [
  ["single_select.tiles", "single_select.cards"],
  ["multi_select.top_n", "multi_select.checkbox"],
  ["ranking.rank_all", "ranking.click"],
  ["ranking.top_n", "ranking.click"],
  ["slider.discrete", "slider.single"],
  ["numeric.percentage_slider", "slider.single"],
] as const;

test("each duplicate the review named is retired to the one that survived it", () => {
  for (const [id, survivor] of RETIRED_BY_THE_REVIEW) {
    const v = variantRegistry.get(id);
    assert.ok(v, `${id} must stay registered — a survey in field stores this id`);
    assert.equal(v!.supersededBy, survivor, `${id} should retire to ${survivor}`);
    assert.equal(isSelectableVariant(v!), false, `${id} should be gone from the picker`);
    assert.equal(resolveVariant(id)!.id, survivor, "and still resolve, so it keeps rendering");
  }
});

test("a retirement never changes what a stored answer means", () => {
  for (const [id] of RETIRED_BY_THE_REVIEW) {
    const from = variantRegistry.get(id)!;
    const to = resolveVariant(id)!;
    assert.equal(to.responseModel, from.responseModel, `${id} → ${to.id} changes the response model`);
    assert.equal(to.baseType, from.baseType, `${id} → ${to.id} changes the base type`);
    assert.equal(to.renderer ?? null, from.renderer ?? null, `${id} → ${to.id} changes how it is drawn`);
  }
});

test("opening a survey rewrites the stored id, keeping the settings that made it that preset", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Retired", version: "1.0" },
    questions: [
      {
        id: "q1", code: "Q1", variableName: "Q1", type: "single_select", variant: "single_select.tiles",
        text: "Pick one", settings: { columnsLayout: 3 },
        options: [{ code: 1, label: "A" }, { code: 2, label: "B" }],
      },
      {
        id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", variant: "multi_select.checkbox",
        text: "Pick some", options: [{ code: 1, label: "A" }],
      },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }],
  });

  const out = migrateRetiredVariants(def);
  assert.equal(out.def.questions[0].variant, "single_select.cards", "the id catches up with the resolver");
  assert.equal(out.def.questions[0].settings.columnsLayout, 3,
    "and the three columns that made it a Tile Select are still on the question");
  assert.deepEqual(out.rewritten, { q1: ["single_select.tiles", "single_select.cards"] });
  assert.equal(out.def.questions[1].variant, "multi_select.checkbox", "a live variant is left alone");

  const again = migrateRetiredVariants(out.def);
  assert.equal(again.clean, true, "and running it twice does nothing the second time");
});

test("a survey with no retired ids is returned untouched", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s2", code: "S2", title: "Clean", version: "1.0" },
    questions: [{
      id: "q1", code: "Q1", variableName: "Q1", type: "single_select", variant: "single_select.radio",
      text: "Pick one", options: [{ code: 1, label: "A" }],
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }],
  });
  const out = migrateRetiredVariants(def);
  assert.equal(out.clean, true);
  assert.equal(out.def, def, "the same object — nothing was copied, so nothing can have changed");
});
