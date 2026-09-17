import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODE_LANGUAGES, CODE_MAX_CHARS_CEILING, DEFAULT_CODE_SETTINGS,
  checkCodeAnswer, checkCodeSettings, codeAnswerLanguage, codeForAnalysis, codeStats, readCodeSettings,
} from "./code.js";
import { checkQuestion } from "./authoring.js";
import { KIND_TO_TYPE, TYPED_KINDS, answerValueOf, toSurveyDefinition } from "./definition.js";

test("settings read tolerantly: gaps filled, out-of-range clamped, garbage ignored", () => {
  assert.deepEqual(readCodeSettings(undefined), DEFAULT_CODE_SETTINGS);
  assert.deepEqual(readCodeSettings({ code: { language: "go", maxChars: 999_999, starter: "package main" } }), {
    language: "go", allowLanguageChoice: true, starter: "package main", maxChars: CODE_MAX_CHARS_CEILING,
  });
  assert.equal(readCodeSettings({ language: "brainfuck" }).language, "python", "an unknown language falls back, it does not throw");
  assert.equal(readCodeSettings({ maxChars: -4 }).maxChars, DEFAULT_CODE_SETTINGS.maxChars);
  assert.equal(readCodeSettings("nonsense").language, "python");
});

test("a code question's settings are checked with the question", () => {
  const bad = checkQuestion({ prompt: "Write it", kind: "code", settings: { code: { language: "cobol" } } });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0]!, /not a language/);

  const tooBig = checkCodeSettings({ maxChars: CODE_MAX_CHARS_CEILING + 1 });
  assert.equal(tooBig.errors.length, 1);

  const tiny = checkCodeSettings({ maxChars: 50 });
  assert.equal(tiny.errors.length, 0);
  assert.match(tiny.warnings[0]!, /very little room/);

  const ok = checkQuestion({ prompt: "Write it", kind: "code", settings: { code: { language: "rust" } } });
  assert.equal(ok.ok, true);
  /* a time limit on a code question is a setting that does nothing, and says so */
  const timed = checkQuestion({ prompt: "Write it", kind: "code", maxSeconds: 60 });
  assert.equal(timed.ok, true);
  assert.match(timed.warnings[0]!, /Time limits do not apply/);
});

test("THE STARTER IS NOT AN ANSWER — and neither is nothing", () => {
  const settings = readCodeSettings({ language: "python", starter: "def solve(xs):\n    pass\n", maxChars: 500 });
  assert.deepEqual(checkCodeAnswer("", undefined, settings), { ok: false, error: "Write something first.", code: "empty" });
  assert.equal(checkCodeAnswer("   \n\t", undefined, settings).ok, false);
  const same = checkCodeAnswer("def solve(xs):\r\n    pass", undefined, settings);
  assert.equal(same.ok, false);
  assert.equal((same as { code: string }).code, "unchanged", "CRLF and trailing whitespace do not make the starter an answer");
  const real = checkCodeAnswer("def solve(xs):\n    return sorted(xs)\n", undefined, settings);
  assert.equal(real.ok, true);
});

test("the size limit is stated, not silently applied", () => {
  const settings = readCodeSettings({ maxChars: 100 });
  const r = checkCodeAnswer("x".repeat(101), undefined, settings);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /101 characters; this question allows 100/);
});

test("language choice is the interviewer's to grant", () => {
  const fixed = readCodeSettings({ language: "java", allowLanguageChoice: false });
  const swap = checkCodeAnswer("class A {}", "python", fixed);
  assert.equal(swap.ok, false);
  assert.match((swap as { error: string }).error, /answered in Java/);
  assert.equal(checkCodeAnswer("class A {}", "java", fixed).ok, true, "naming the fixed language is not a change");

  const open = readCodeSettings({ language: "java", allowLanguageChoice: true });
  const picked = checkCodeAnswer("print(1)", "python", open);
  assert.equal(picked.ok, true);
  assert.equal((picked as { language: string }).language, "python");
  assert.equal(checkCodeAnswer("x", "klingon", open).ok, false);
});

test("the stored language reads back from either shape, and falls back to plain", () => {
  assert.equal(codeAnswerLanguage({ language: "rust" }), "rust");
  assert.equal(codeAnswerLanguage("sql"), "sql");
  assert.equal(codeAnswerLanguage(null), "plain");
  assert.equal(codeAnswerLanguage({ language: "nope" }, "go"), "go");
});

test("fenced for the analysis, verbatim inside — a quoted line still matches the stored text", () => {
  const text = "SELECT id\nFROM users\nWHERE active";
  const fenced = codeForAnalysis(text, "sql");
  assert.ok(fenced.startsWith("```sql\n"));
  assert.ok(fenced.includes(text));
  assert.ok(fenced.endsWith("\n```"));
  assert.deepEqual(codeStats(text), { lines: 3, chars: text.length });
  assert.deepEqual(codeStats(""), { lines: 0, chars: 0 });
});

test("code is a typed kind the engine walks as code_editor", () => {
  assert.equal(KIND_TO_TYPE.code, "code_editor");
  assert.ok(TYPED_KINDS.includes("code"));
  assert.equal(answerValueOf({ answerKind: "code", answerText: "print(1)", answerValue: { language: "python" } } as never), "print(1)");
  const def = toSurveyDefinition(
    { id: "p", name: "P" },
    [{ id: "q1", code: "Q1", kind: "code", prompt: "Write it", required: true }],
    ["q1"],
  );
  assert.equal(def.questions[0]!.type, "code_editor");
  assert.equal(CODE_LANGUAGES.length, 10);
});
