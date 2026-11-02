import { test } from "node:test";
import assert from "node:assert/strict";
import { readDocx } from "./adapters/docx.js";
import { readSource, analyzeImport, clarifications, askable, coerceSuggestions, withSuggestions, fakeSuggest, surveyListing, choicesListing, applyDecisions, ZIP_LIMITS } from "./index.js";
import { wordDocFixture, TINY_JPEG } from "./fixtures.js";

/**
 * I6 — Word: pictures and nested tables are read; instructions the rules cannot decide get an AI SUGGESTION that
 * can only choose among the engine's checked alternatives (here the fake provider's deterministic stand-in).
 */
const doc = () => wordDocFixture([
  { p: "Car Owner Study", style: "Title" },
  { p: "S1. Do you currently own a car?", bold: true }, { p: "Yes", num: 1, level: 1 }, { p: "No", num: 1, level: 1 },
  { p: "S2. Which brand is your car?", bold: true }, "[ASK ONLY IF THEY OWN A CAR]", { p: "Alpha", num: 2, level: 1 }, { p: "Beta", num: 2, level: 1 },
  { p: "Q1. Look at this advert. How appealing is it?", bold: true },
  { image: TINY_JPEG, name: "advert", alt: "The new Alpha advert" },
  { p: "Very appealing", num: 3, level: 1 }, { p: "Not appealing", num: 3, level: 1 },
  { p: "Q2. Please rate each feature.", bold: true },
  { table: [["", "Poor", "Good"], ["Comfort", "", ""], [{ table: [["Seats", "front"], ["Seats", "rear"]] }, "", ""]] },
]);

test("pictures embedded in the document travel with their question; nested table cells are not dropped", async () => {
  const { blocks } = readDocx(doc());
  const img = blocks.find((b) => b.kind === "para" && b.images?.length);
  assert.ok(img && img.kind === "para" && img.images![0].contentType === "image/jpeg" && img.images![0].alt === "The new Alpha advert");
  const tbl = blocks.find((b) => b.kind === "table");
  assert.ok(tbl && tbl.kind === "table" && tbl.rows[2][0] === "Seats | front\nSeats | rear", "the nested table is flattened into its cell");
  const c = (await readSource(doc(), "cars.docx")).canonical!;
  const q1 = c.questions.find((q) => q.sourceId === "Q1")!;
  assert.match(q1.text, /<img src="data:image\/jpeg;base64,[A-Za-z0-9+/=]+" alt="The new Alpha advert" \/>/);
  assert.ok(c.assets?.some((a) => a.hosting === "embedded" && a.location.startsWith("Q1")));
  const a = await analyzeImport(doc(), "cars.docx", { surveyId: "s" });
  assert.equal(a.report!.fidelity.features.find((f) => f.feature === "asset")?.imported, 1);
});

test("the rules cannot decide “ASK ONLY IF THEY OWN A CAR”; the AI may suggest S1 = Yes — from the engine's own choices only", async () => {
  const c = (await readSource(doc(), "cars.docx")).canonical!;
  const asks = clarifications(c);
  const own = asks.find((x) => x.questionId === "S2" && x.kind === "missing_condition")!;
  assert.equal(own.recommended, null, "the rules see no answer named “they own a car”");
  const open = askable(asks);
  assert.ok(open.includes(own));
  assert.match(choicesListing(open), /instruction: ASK ONLY IF THEY OWN A CAR[\s\S]*0: S1 = Yes/);
  assert.match(surveyListing(c), /S1 \[single\] Do you currently own a car\? — answers: 1=Yes; 2=No/);
  const fake = fakeSuggest(c, open);
  const sug = coerceSuggestions(fake, open);
  const next = withSuggestions(asks, sug).find((x) => x.id === own.id)!;
  assert.equal(next.recommended!.label, "S1 = Yes"); assert.equal(next.suggestedBy, "ai");
  /* the suggestion is an ordinary checked decision: applying it writes the rule */
  const r = applyDecisions(c, [next.recommended!.decision]);
  assert.deepEqual(r.canonical.questions.find((q) => q.sourceId === "S2")!.displayLogic, { t: "cmp", ref: { kind: "question", id: "S1", choice: "1" }, op: "selected" });
});

test("a model reply is checked: unknown ids, out-of-range or 'leave it' choices, duplicates and non-integers are dropped", async () => {
  const c = (await readSource(doc(), "cars.docx")).canonical!;
  const open = askable(clarifications(c));
  const id = open[0].id;
  const n = open[0].alternatives.filter((x) => x.decision.type !== "dismiss").length;
  const got = coerceSuggestions({ suggestions: [{ id: "invented", choice: 0 }, { id, choice: n }, { id, choice: 1.5 }, { id, choice: -1 }, { id, choice: 0, because: "x".repeat(900) }, { id, choice: 1 }] }, open);
  assert.equal(got.length, 1); assert.equal(got[0].choice, 0); assert.equal(got[0].because.length, 300);
  assert.deepEqual(coerceSuggestions("not json at all", open), []);
  assert.deepEqual(coerceSuggestions({ suggestions: [{ id, choice: null }] }, open), [], "null = no suggestion");
});

test("no overlap, no suggestion: the stand-in never guesses", async () => {
  const c = (await readSource(new TextEncoder().encode("S1. Do you own a car?\n1. Yes\n2. No\nQ1. Rate us\n[ASK ONLY IF EXISTING CUSTOMER]\n1. Good\n2. Bad\n"), "t.txt")).canonical!;
  assert.deepEqual(fakeSuggest(c, askable(clarifications(c))).suggestions, []);
  assert.ok(ZIP_LIMITS.maxEntries > 0);
});
