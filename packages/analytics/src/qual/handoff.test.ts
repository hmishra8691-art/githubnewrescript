import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureState } from "./fixture.js";
import { qualHandoff } from "./handoff.js";
import type { ThemeSynthesis } from "./synthesis.js";

const synthesis = (themeId: string, themeName: string, first: string): ThemeSynthesis => ({
  kind: "theme", themeId, themeName,
  summary: [{ text: first, excerptIds: ["x1"], origin: "ai" }], nuance: [], tensions: [], bySegment: [], contradicting: [],
  counts: { excerpts: 2, segments: 2, sources: 2, participants: 2, sessions: 2, totalSources: 3, totalSegments: 20, byGroup: {} },
  coverage: { sources: 2, totalSources: 3, label: "moderate", words: "" } as ThemeSynthesis["coverage"],
  fingerprint: "f", codebookVersion: 3, status: "ai", dropped: [], generatedAt: "2026-11-05T00:00:00Z", note: "",
});

test("every reviewed top-level theme becomes a hypothesis, a research question, a construct with its codes as facets, and a row of the agreement grid", () => {
  const p = qualHandoff(fixtureState(), [synthesis("th1", "Cost and value", "Price rises are the first thing participants mention")], { population: "customers" });
  assert.equal(p.themes.length, 2);
  assert.deepEqual(p.hypotheses.length, 2);
  assert.match(p.hypotheses[0], /“Cost and value” is widespread among customers/);
  assert.match(p.hypotheses[0], /2 of 3 qualitative sources — Price rises are the first thing participants mention\./);
  assert.match(p.researchQuestions[1], /“Service problems”/);
  assert.deepEqual(p.constructs[0].facets, ["Price rise", "Willing to pay"]);
  assert.equal(p.constructs[0].origin, "qualitative");
  assert.equal(p.questions.length, 2);
  assert.equal(p.questions[0].type, "matrix_single");
  assert.deepEqual(p.questions[0].rows!.map((r) => r.label), ["Cost and value", "Service problems"]);
  assert.equal(p.questions[1].type, "single_select");
  assert.equal(p.questions[0].code, "QUAL_THEMES");
  assert.match(p.statement, /2 reviewed themes handed/);
});

test("a theme nobody reviewed is skipped unless asked for; a rejected theme never goes", () => {
  const st = fixtureState();
  st.codebook.themes.push({ id: "th3", name: "Coverage", status: "ai_suggested" }, { id: "th4", name: "Old plan", status: "rejected" });
  const p = qualHandoff(st, []);
  assert.deepEqual(p.skipped.map((s) => [s.name, s.why]), [["Coverage", "not yet reviewed by a person"], ["Old plan", "rejected by a reviewer"]]);
  const wide = qualHandoff(st, [], { includeAiSuggested: true });
  assert.equal(wide.themes.length, 3);
  assert.equal(wide.skipped.length, 1);
});

test("run a second time, what is already in the research design is skipped, and the question codes do not collide", () => {
  const first = qualHandoff(fixtureState(), []);
  const second = qualHandoff(fixtureState(), [], { existing: { hypotheses: first.hypotheses, constructs: first.constructs, researchQuestions: first.researchQuestions }, takenCodes: ["QUAL_THEMES"] });
  assert.equal(second.themes.length, 0);
  assert.ok(second.skipped.every((s) => /already/.test(s.why)));
  assert.match(second.statement, /Nothing to hand over/);
  const third = qualHandoff(fixtureState(), [], { takenCodes: ["QUAL_THEMES", "QUAL_THEMES_2"] });
  assert.equal(third.questions[0].code, "QUAL_THEMES_3");
});

test("a subtheme rides along as a facet of its parent rather than becoming a construct of its own", () => {
  const st = fixtureState();
  st.codebook.themes.push({ id: "th1a", name: "Hidden fees", parentId: "th1", status: "human_reviewed" });
  const p = qualHandoff(st, []);
  assert.equal(p.themes.length, 2);
  assert.ok(p.constructs[0].facets.includes("Hidden fees"));
  assert.ok(p.skipped.some((s) => s.name === "Hidden fees" && /facet/.test(s.why)));
});
