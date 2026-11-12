import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "@rescript/import";
import { memorySessionStore, type ImportSession } from "./sessions.ts";
import { coerceAnswers, intelligentFromSession, intelligenceView, isStoredAnswer } from "./intelligent.ts";
import { reanalyze } from "./reanalyze.ts";

/* 2026-11-13: the orchestrated import on a stored session — answers accumulate, are re-applied, and never break the earlier review flow */
const DOC = () => new TextEncoder().encode([
  "S1. Which brands do you own? [SELECT ALL THAT APPLY]", "1. Apex", "2. Nova", "3. None of these",
  "ASK ONLY EXISTING CUSTOMERS",
  "Q1. Why did you choose your brand?",
  "Q2. Which of these is the most important and which the least important to you?", "1. Price", "2. Quality", "3. Design", "4. Service",
].join("\n"));

async function session(): Promise<ImportSession> {
  const read = await readSource(DOC(), "doc.txt");
  const store = memorySessionStore();
  return store.create({ customerId: null, userId: null, surveyId: null, into: "new", scope: "full", fileName: "doc.docx", format: "docx", platform: "document", fingerprint: read.canonical!.source.fingerprint, sizeBytes: 1, reportDigest: { label: "Word questionnaire" } as never, canonical: read.canonical, decisions: [], priorDefinition: null, error: null, status: "analyzed" }, new Uint8Array([1]));
}
const det = { format: "docx", platform: "document", label: "Word questionnaire" };

test("answers are cleaned: an index or the person's own words, one per question, nothing else", () => {
  assert.deepEqual(coerceAnswers([{ id: "a", choice: 1 }, { id: "a", choice: 2 }, { id: "b", own: "  only buyers  ", choice: 0 }, { id: "", choice: 1 }, { id: "c" }, "x", { id: "d", choice: 1.5 }]), [{ id: "a", choice: 2 }, { id: "b", own: "only buyers" }]);
  assert.equal(coerceAnswers("nope"), null);
});

test("a first run asks; an answer is applied, stored, and still in force when the next one arrives", async () => {
  const s = await session();
  const first = intelligentFromSession(s, [], det);
  assert.ok(!("error" in first));
  if ("error" in first) return;
  const v = intelligenceView(first.run);
  assert.equal(v.stages.length, 8);
  const logic = v.clarifications.find((c) => c.about === "logic" && /Q1/.test(c.where))!;
  const method = v.clarifications.find((c) => c.about === "method")!;
  assert.ok(logic && method, v.clarifications.map((c) => c.id).join(" | "));
  assert.equal("session" in v, false, "the stored model is never sent to the browser");
  const q1 = () => (x: { run: { definition: { questions: { code?: string; displayLogic?: unknown }[] } | null } }) => x.run.definition!.questions.find((q) => q.code === "Q1")!;
  assert.equal(q1()(first as never).displayLogic ?? null, null);

  const second = intelligentFromSession(s, [{ id: logic.id, choice: 0 }], det);
  if ("error" in second) throw new Error(second.error);
  assert.ok(q1()(second as never).displayLogic, "the answer became Q1's condition");
  assert.equal(second.decisions.filter(isStoredAnswer).length, 1);
  /* the route stores `decisions`; the next answer arrives on the stored session */
  const stored = { ...s, decisions: second.decisions as never };
  const third = intelligentFromSession(stored, [{ id: method.id, choice: 1 }, { id: "ghost", choice: 0 }], det);
  if ("error" in third) throw new Error(third.error);
  assert.ok(q1()(third as never).displayLogic, "the first answer is still in force");
  assert.equal(third.run.definition!.questions.find((q) => q.code === "Q2")!.type, "maxdiff_task");
  assert.equal(third.decisions.filter(isStoredAnswer).length, 2, "an answer to a question that does not exist is not kept");
  assert.equal(third.run.rejected.length, 1);
  /* the earlier review flow reads the same session without tripping over the plain answers */
  const old = reanalyze({ ...s, decisions: third.decisions as never }, []);
  assert.ok(!("error" in old));
});

test("a session that cannot be continued says why", async () => {
  const s = await session();
  assert.deepEqual(intelligentFromSession({ ...s, canonical: null }, [], det), { error: "This import's reconstructed model was not kept, so it cannot be continued — import the file again.", status: 410 });
  assert.equal((intelligentFromSession({ ...s, status: "applied" }, [], det) as { status: number }).status, 409);
  assert.equal((intelligentFromSession({ ...s, into: "merge" }, [], det) as { status: number }).status, 409);
});
