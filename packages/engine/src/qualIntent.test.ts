import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretQualRequest, describeQualRequest } from "./qualIntent.js";

/* QUALITATIVE SYNTHESIS IN WORDS (2026-10-22): the brief's five sentences and their variants are classified; survey
 * edits and quantitative comparisons are not. */

test("the five sentences of the brief", () => {
  assert.deepEqual(interpretQualRequest("summarise the themes"), { op: "summarise_themes", text: "summarise the themes" });
  assert.deepEqual(interpretQualRequest("What are the key insights for objective 2?"), { op: "insights", text: "What are the key insights for objective 2", objective: 2 });
  assert.deepEqual(interpretQualRequest("compare Mumbai vs Delhi participants"), { op: "compare_groups", text: "compare Mumbai vs Delhi participants", a: "Mumbai", b: "Delhi" });
  assert.deepEqual(interpretQualRequest("make a highlight reel of pricing complaints"), { op: "highlight_reel", text: "make a highlight reel of pricing complaints", topic: "pricing complaints" });
  assert.deepEqual(interpretQualRequest("set up double coding with 20% overlap"), { op: "double_coding", text: "set up double coding with 20% overlap", overlapPct: 20, coder: "ai" });
});

test("variants: a named theme, an objective in words, a colleague as coder, ask, auto-coding, a group session", () => {
  assert.equal((interpretQualRequest("Write a summary of the price theme") as { theme?: string }).theme, "price");
  assert.equal((interpretQualRequest("key findings for the second objective") as { objective?: number }).objective, 2);
  assert.equal(interpretQualRequest("what are the key findings from the interviews")?.op, "insights");
  assert.equal((interpretQualRequest("set up blind double-coding of 15 percent with a colleague") as { coder: string; overlapPct: number }).coder, "colleague");
  assert.deepEqual(interpretQualRequest("What did Gen Z say about price?"), { op: "ask", text: "What did Gen Z say about price", question: "What did Gen Z say about price" });
  assert.deepEqual(interpretQualRequest("code new interviews automatically"), { op: "auto_code", text: "code new interviews automatically", enabled: true });
  assert.equal((interpretQualRequest("turn off automatic coding") as { enabled: boolean }).enabled, false);
  assert.deepEqual(interpretQualRequest("run a group session from the guide autonomously"), { op: "group_session", text: "run a group session from the guide autonomously", mode: "autonomous" });
  assert.equal(interpretQualRequest("how do switchers differ from stayers")?.op, "compare_groups");
  assert.match(describeQualRequest(interpretQualRequest("set up double coding with 20% overlap")!), /20% of each source/);
});

test("not ours: survey edits, quantitative comparisons, reports, video", () => {
  for (const s of ["How did you feel about your provider at that point?", "summarise the findings", "what are the key findings", "add a question about price", "compare Q3 by Q5", "make Q4 required", "create the findings report", "summarise the survey", "run a video focus group", "export the key findings deck", "delete the theme block"]) assert.equal(interpretQualRequest(s), null, s);
});
