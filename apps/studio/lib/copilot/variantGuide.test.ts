import { test } from "node:test";
import assert from "node:assert/strict";
import { variantFamiliesNamed, variantGuideFor } from "./guideSelect.ts";
import { copilotUserPrompt } from "./prompt.ts";

/* S2b item 2: the variant catalogue guide is sent when the sentence or the selected question names an interaction — not on every turn */

test("interaction words select the families; plain requests send nothing", () => {
  assert.deepEqual(variantFamiliesNamed("add a hotspot question"), ["hotspot"]);
  assert.ok(variantFamiliesNamed("show the pack shot above Q3").includes("image"));
  assert.ok(variantFamiliesNamed("make Q4 a swipe deck").includes("swipe"));
  assert.ok(variantFamiliesNamed("add a 30 second countdown").includes("gamified"));
  assert.ok(variantFamiliesNamed("ask them to drop a pin on a map").includes("location"));
  assert.ok(variantFamiliesNamed("an NPS question").includes("single_select"));
  assert.ok(variantFamiliesNamed("collect a signature").includes("upload"));
  assert.ok(variantFamiliesNamed("let them annotate the ad").includes("image"));
  assert.ok(variantFamiliesNamed("video testing with a timeline").includes("media"));
  assert.deepEqual(variantFamiliesNamed("Show Q5 only when Q2 = 1"), []);
  assert.deepEqual(variantFamiliesNamed("translate the survey into Hindi"), []);
  assert.equal(variantGuideFor("rename Q3 to AGE"), null);
});

test("the selected question's interactive variant sends the guide on its own; a plain one does not", () => {
  assert.deepEqual(variantFamiliesNamed("make it faster", "gamified.timed"), ["gamified"]);
  assert.deepEqual(variantFamiliesNamed("make it faster", "single_select.radio"), []);
});

test("the guide carries the named families in full and only an index of the rest", () => {
  const g = variantGuideFor("add a hotspot question")!;
  assert.match(g, /^QUESTION VARIANTS/);
  assert.match(g, /\nhotspot\.\w+ \(/);
  assert.match(g, /OTHER FAMILIES \(ids only\): .*gamified: .*timed/);
  assert.ok(!/\ngamified\.timed \(/.test(g), "an unnamed family is not in full");
  assert.ok(g.length < 9000, `compact (${g.length})`);
  const big = variantGuideFor("interactive cards, swipe, sliders, quiz, a map and a video")!;
  assert.ok(big.length < 16000, `bounded (${big.length})`);
});

test("copilotUserPrompt adds it only when named", () => {
  const base = { outline: "Q1 x", surveyLanguage: "en", mode: "edit" as const };
  assert.match(copilotUserPrompt({ ...base, message: "add a heatmap question on the logo" }), /QUESTION VARIANTS/);
  assert.doesNotMatch(copilotUserPrompt({ ...base, message: "Show Q5 only when Q2 = 1" }), /QUESTION VARIANTS/);
  assert.match(copilotUserPrompt({ ...base, message: "make it faster", selected: "Q5", selectedVariant: "gamified.timed" }), /QUESTION VARIANTS/);
  assert.doesNotMatch(copilotUserPrompt({ ...base, message: "add a heatmap", planOnly: true }), /QUESTION VARIANTS/);
  assert.doesNotMatch(copilotUserPrompt({ ...base, message: "add a heatmap", variants: false }), /QUESTION VARIANTS/);
});
