import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyNavigation, parseSurvey } from "./index.js";

/** SECTION NAVIGATION (2026-10-30): `def.navigation` is optional and additive. */
const base = {
  meta: { id: "s1", title: "Paper" },
  questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "?", options: [{ code: "1", label: "A" }] }],
};

test("a survey without navigation parses unchanged (no navigation key appears)", () => {
  const def = parseSurvey(base);
  assert.equal(def.navigation, undefined);
  assert.equal("navigation" in def, false);
});

test("navigation parses with defaults: sectionNav off, position top", () => {
  assert.deepEqual(parseSurvey({ ...base, navigation: {} }).navigation, { sectionNav: "off", position: "top" });
  assert.deepEqual(parseSurvey({ ...base, navigation: { sectionNav: "free", position: "side" } }).navigation, { sectionNav: "free", position: "side" });
  assert.equal(SurveyNavigation.parse({ sectionNav: "visited" }).position, "top");
});

test("unknown modes and positions are refused", () => {
  assert.throws(() => parseSurvey({ ...base, navigation: { sectionNav: "anywhere" } }));
  assert.throws(() => parseSurvey({ ...base, navigation: { position: "bottom" } }));
});

test("navigation round-trips through JSON", () => {
  const def = parseSurvey({ ...base, navigation: { sectionNav: "visited", position: "side" } });
  assert.deepEqual(parseSurvey(JSON.parse(JSON.stringify(def))).navigation, def.navigation);
});
