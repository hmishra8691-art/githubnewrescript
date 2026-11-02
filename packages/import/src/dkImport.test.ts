import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeImport } from "./index.js";
import { wordDocFixture } from "./fixtures.js";

/** 2026-11-02 — a questionnaire's "ALLOW DON'T KNOW" and "Something else" arrive as the native features */
let n = 0;
const uid = (p: string) => `${p}_${++n}`;

test("Word: [ALLOW DON'T KNOW] on an open or numeric question turns on the native choice; on a choice question it is said, not forced", async () => {
  const doc = wordDocFixture([
    "Q1. How much did you spend last month, in pounds?", "[ALLOW DON'T KNOW]",
    "Q2. Why did you choose your provider?", "[DK ALLOWED]",
    "Q3. Which provider do you use?", "[INCLUDE A DON'T KNOW OPTION]", "1. Acme", "2. Globex", "3. Something else",
    "Q4. Any comments?",
  ]);
  const a = await analyzeImport(doc, "dk.docx", { surveyId: "s", uid });
  const qs = a.result!.def!.questions;
  const q = (c: string) => qs.find((x) => x.code === c)!;
  assert.equal(q("Q1").type, "numeric");
  assert.equal(q("Q1").settings.dontKnow, true);
  assert.equal(q("Q2").settings.dontKnow, true);
  assert.equal(q("Q4").settings.dontKnow, undefined, "only where the document asked");
  assert.equal(q("Q3").settings.dontKnow, undefined);
  assert.ok([...a.result!.issues, ...a.canonical!.issues].some((i) => /asks for a “don't know” choice/.test(i.message)));
  assert.deepEqual(q("Q3").options.filter((o) => o.flags?.includes("other_specify")).map((o) => o.label), ["Something else"], "“Something else” gets its specify box");
});
