import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { interpretRequest, REPORT_THEME_NAMES, type Interpretation } from "./nlIntent.js";

/*
 * REPORT THEMES BY SENTENCE (2026-10-18). The engine classifies; the Studio reads the words into a theme
 * (`@rescript/analytics` interpretThemeRequest), previews it and applies it on approval. The survey has its own
 * theme (what respondents see, composed by the model), so a sentence is a REPORT theme only when it says so;
 * a survey look is left to the model as before, and a look that could be either is asked about.
 */
const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "T" }, research: { objective: "Why people switch", hypotheses: ["Price drives switching"] },
  questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Gender", options: [{ code: 1, label: "M" }, { code: 2, label: "F" }] }],
  flow: [{ type: "page", id: "p", questionIds: ["q1"] }],
});
const themeOf = (t: string) => { const r = interpretRequest(def, t); assert.equal(r.kind, "theme", `${t} → ${JSON.stringify(r).slice(0, 240)}`); return r as Extract<Interpretation, { kind: "theme" }>; };

test("the example sentences: a report look is read as a theme request with the words intact; an ambiguous one is asked about", () => {
  for (const t of ["Executive consulting-style layout with clean tables", "Healthcare research presentation, restrained colors, clear statistical annotations", "Make the findings deck navy and gold with Georgia headings"]) {
    const r = themeOf(t);
    assert.equal(r.request.op, "describe", t);
    assert.equal(r.request.text, t.replace(/[.!]+$/, ""));
    assert.equal(r.category, "reporting");
  }
  for (const t of ["Apply our premium corporate theme with navy headings, subtle cyan accents, and clean white backgrounds", "Use our uploaded logo and brand colors"]) {
    const c = interpretRequest(def, t);
    assert.equal(c.kind, "clarify", t);
    const choices = c.kind === "clarify" ? c.choices : [];
    assert.deepEqual(choices.map((x) => x.label), ["The report documents and decks", "The survey respondents see"]);
    /* each choice is a sentence this layer reads: the report one as a theme, the survey one as before (the model) */
    assert.equal(themeOf(choices[0].text).request.op, "describe");
    assert.equal(interpretRequest(def, choices[1].text).kind, "model");
  }
  const s = themeOf("Keep the content but reorganize around the main hypotheses and recommendations");
  assert.equal(s.request.op, "restructure");
});

test("a theme by name, saving a theme, listing themes; the built-in names are the five", () => {
  assert.deepEqual([...REPORT_THEME_NAMES], ["Executive Research", "Healthcare Analytics", "Brand Performance", "Consumer Insights", "Academic Research"]);
  const a = themeOf("Apply the Healthcare Analytics theme");
  assert.deepEqual(a.request, { op: "apply_named", text: "Apply the Healthcare Analytics theme", name: "Healthcare Analytics" });
  assert.equal(themeOf("use the Board Pack theme for the report").request.name, "Board Pack");
  assert.deepEqual(themeOf("Save this theme as Board Pack").request, { op: "save_as", text: "Save this theme as Board Pack", name: "Board Pack" });
  assert.equal(themeOf("which report themes are available?").request.op, "list");
  /* a named theme with more look words is a description on top of it */
  assert.equal(themeOf("Apply the Consumer Insights theme with Georgia headings").request.op, "describe");
});

test("not a report theme: the survey's look, a long brief, an executive summary, a question order", () => {
  for (const t of ["make the survey dark with navy headings", "apply a dark theme to the questionnaire", "reorder the questions", "Write the executive summary for the client report", "create the findings deck with three slides per hypothesis"]) {
    assert.notEqual(interpretRequest(def, t).kind, "theme", t);
  }
  const brief = `${"We need a presentation for the board about switching, with our brand colors and logo. ".repeat(5)}\nDesign the questionnaire.`;
  assert.notEqual(interpretRequest(def, brief).kind, "theme");
});

test("a document with a theme by name, and 'update the Word document' asks for a new version", () => {
  const o = interpretRequest(def, "create the findings deck in the Healthcare Analytics theme");
  assert.equal(o.kind, "output");
  assert.deepEqual(o.kind === "output" && o.output, { type: "findings_pptx", audience: "client", words: "the findings presentation (PowerPoint, client edition)", theme: "Healthcare Analytics" });
  assert.match(o.kind === "output" ? o.understood : "", /in the Healthcare Analytics theme\.$/);
  const w = interpretRequest(def, "write the findings report as a Word document with the Executive Research theme for the board");
  assert.equal(w.kind === "output" && w.output.theme, "Executive Research");
  assert.equal(w.kind === "output" && w.output.audience, "executive");
  const u = interpretRequest(def, "update the Word document");
  assert.equal(u.kind === "output" && u.output.regenerate, true);
  const p = interpretRequest(def, "prepare a Word research plan");
  assert.equal(p.kind === "output" && p.output.regenerate, undefined, "a first request is not a forced regeneration");
});
