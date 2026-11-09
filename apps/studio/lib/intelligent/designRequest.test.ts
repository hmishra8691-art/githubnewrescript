import { test } from "node:test";
import assert from "node:assert/strict";
import { designRequestAnswer, designRequestQuestion } from "./designRequest.ts";

test("reads design requests, not method questions", () => {
  assert.ok(designRequestQuestion("I want to create a choice-based conjoint study with six attributes and 12 tasks"));
  assert.ok(designRequestQuestion("Generate a MaxDiff of 15 claims"));
  assert.ok(designRequestQuestion("Design a Williams latin square for 4 ads"));
  assert.ok(!designRequestQuestion("Which method should I use to price our plan?"));
  assert.ok(!designRequestQuestion("make Q3 required"));
});

test("the answer explains, asks for what is missing, and never claims a design exists", () => {
  const a = designRequestAnswer("I want to create a choice-based conjoint study with six attributes and three to four levels per attribute, 12 choice tasks and three alternatives per task.");
  assert.equal(a.kind, "conjoint");
  assert.match(a.answer, /still need: Name the 6 attributes/);
  assert.match(a.answer, /nothing has been generated yet/);
  assert.ok(a.sections.find((s) => s.title === "Why this configuration")!.items.length >= 4);
});
