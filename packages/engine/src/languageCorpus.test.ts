import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SurveyDefinition } from "@rescript/schema";
import { corpusFromHistory, describeReplay, readingOf, recordCorpus, replayCorpus, type LanguageCorpus } from "./languageCorpus.js";

/**
 * THE LANGUAGE REGRESSION CORPUS (Phase 8): every corpus file in
 * `packages/engine/corpus` replays with no sentence worse and none changed —
 * the gate every change to the recognisers and the lexicon passes; and the
 * corpus built from a history keeps what a replay needs.
 */
const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
function survey(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "C", title: "Corpus" },
    questions: [{ id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" }, { id: "q2", code: "Q2", variableName: "BRAND", type: "single_select", text: "Which brand do you prefer?", options: opts("A", "B") }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }],
  });
}

test("every corpus in the repository replays with nothing worse and nothing changed", () => {
  const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 1, "the brand-tracker corpus is there");
  for (const f of files) {
    const corpus = JSON.parse(readFileSync(join(CORPUS_DIR, f), "utf8")) as LanguageCorpus;
    assert.equal(corpus.version, 1, f);
    assert.ok(corpus.entries.length >= 50, `${f}: ${corpus.entries.length} entries`);
    const report = replayCorpus(corpus);
    const bad = report.results.filter((r) => r.verdict === "worse" || r.verdict === "changed");
    assert.deepEqual(bad.map((r) => `${r.verdict}: “${r.entry.text}” — ${r.why}`), [], `${f}: ${report.counts.worse} worse, ${report.counts.changed} changed`);
    assert.equal(report.counts.same + report.counts.better, corpus.entries.length);
    assert.ok(corpus.entries.some((e) => e.kind === "actions" && e.ops?.length), "actions entries carry their ops");
    assert.equal(report.backlog.length, corpus.entries.filter((e) => e.kind === "model").length, "the backlog is what is still the model's");
  }
});

test("a corpus from the history: one entry per sentence, counted, the last reading, the engine's reading kept on a model record; replay verdicts", () => {
  const def = survey();
  const records = [
    { prompt: "make Q1 required", source: "engine", intent: { category: "survey_editing", kind: "actions", engine: "actions", ops: "update_question", selected: "q2" }, createdAt: "2026-10-01T10:00:00Z" },
    { prompt: "Make Q1 required", source: "engine", intent: { kind: "actions", engine: "actions", ops: "update_question" }, createdAt: "2026-10-02T10:00:00Z" },
    { prompt: "make q1 required → make Q1 optional", source: "engine", intent: { kind: "actions", engine: "actions", ops: "update_question" }, createdAt: "2026-10-03T10:00:00Z" },
    { prompt: "rewrite Q2 in a friendlier tone", source: "model", intent: { mode: "", kind: "proposal", engine: "model", engineCategory: "question_modification", engineReason: "rewording is writing" }, createdAt: "2026-10-01T11:00:00Z" },
    { prompt: "rewrite Q2 in a friendlier tone", source: "model", intent: { mode: "", kind: "proposal", engine: "model" }, createdAt: "2026-10-04T11:00:00Z" },
    { prompt: "delete Q2", source: "model", intent: { mode: "", kind: "proposal" }, createdAt: "2026-09-01T11:00:00Z" },
    { prompt: "explain Q1", source: "grammar", intent: { kind: "explain", engine: "grammar" }, createdAt: "2026-09-02T11:00:00Z" },
    { prompt: "what depends on Q1?", source: "engine", intent: { category: "dependency_analysis", kind: "answer", engine: "answer" }, createdAt: "2026-09-03T11:00:00Z" },
    { prompt: "a fix", source: "fix", intent: { kind: "fix" }, createdAt: "2026-09-04T11:00:00Z" },
    { prompt: "an import", source: "import", intent: {}, createdAt: "2026-09-05T11:00:00Z" },
    { prompt: "", source: "engine", intent: { kind: "answer" } },
  ];
  const corpus = corpusFromHistory(def, records, { id: "s", title: "Corpus" });
  assert.deepEqual(corpus.entries.map((e) => [e.text, e.kind, e.count]), [
    ["make Q1 required", "actions", 2],
    ["rewrite Q2 in a friendlier tone", "model", 2],
    ["delete Q2", "model", 1],
    ["explain Q1", "grammar", 1],
    ["make Q1 optional", "actions", 1],
    ["what depends on Q1?", "answer", 1],
  ], "most said first, the first spelling kept");
  const made = corpus.entries.find((e) => e.text === "make Q1 required")!;
  assert.deepEqual(made.ops, ["update_question"]);
  assert.equal(made.selected, undefined, "the last record's selection stands (it had none)");
  assert.equal(made.at, "2026-10-02T10:00:00Z");
  assert.equal(corpus.entries.find((e) => e.text === "rewrite Q2 in a friendlier tone")!.category, null, "the last record carried no category");
  const report = replayCorpus(corpus);
  const by = (t: string) => report.results.find((r) => r.entry.text === t)!;
  assert.equal(by("make Q1 required").verdict, "same");
  assert.equal(by("make Q1 optional").verdict, "changed", "Q1 is already optional in the survey as it is now: refused where the record had actions");
  assert.equal(by("make Q1 optional").why, "was actions, now refused");
  assert.equal(by("rewrite Q2 in a friendlier tone").verdict, "same");
  assert.equal(by("rewrite Q2 in a friendlier tone").why, "still the model's");
  assert.equal(by("delete Q2").verdict, "better", "the model's sentence the engine reads now");
  assert.equal(by("explain Q1").verdict, "same", "a hand-off to the grammar's read-only answer is the grammar's, as recorded");
  assert.equal(by("explain Q1").why, "still the grammar's");
  assert.equal(by("what depends on Q1?").verdict, "same");
  assert.deepEqual(report.counts, { same: 4, better: 1, worse: 0, changed: 1 });
  assert.deepEqual(report.backlog.map((e) => e.text), ["rewrite Q2 in a friendlier tone"], "most said first; the engine's sentences are not backlog");
  // worse and changed
  const regressed: LanguageCorpus = { ...corpus, entries: [{ text: "rewrite Q2 in a friendlier tone", kind: "actions", ops: ["update_question"] }, { text: "make Q1 required", kind: "actions", ops: ["delete_question"] }, { text: "what depends on Q1?", kind: "actions", ops: ["update_question"] }] };
  const r2 = replayCorpus(regressed);
  assert.deepEqual(r2.results.map((r) => r.verdict), ["worse", "changed", "changed"]);
  assert.match(r2.results[1].why, /delete_question → update_question/);
  const words = describeReplay(r2, regressed);
  assert.match(words, /3 sentences — 0 same, 0 better, 1 worse, 2 changed; 1 still the model's/);
  assert.match(words, /WORSE\s+“rewrite Q2 in a friendlier tone” — was actions, now handed to the model/);
  // record: the readings as they are now
  const rec = recordCorpus(regressed);
  assert.deepEqual(rec.entries.map((e) => e.kind), ["model", "actions", "answer"]);
  assert.deepEqual(rec.entries[1].ops, ["update_question"]);
  assert.deepEqual(replayCorpus(rec).counts, { same: 3, better: 0, worse: 0, changed: 0 });
  // the reading itself
  const r = readingOf(def, "Q2", { selectedId: "q1" });
  assert.equal(r.kind, "clarify");
  assert.equal(readingOf(def, "make Q1 required").ops?.join(), "update_question");
});
