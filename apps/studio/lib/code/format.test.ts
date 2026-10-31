import { test } from "node:test";
import assert from "node:assert/strict";
import { reindent } from "./format.ts";

/* S3a item 1: "Format" re-indents from the syntax tree — and changes nothing else */

test("JavaScript: nested blocks are re-indented two spaces a level; code is not rewritten", () => {
  const code = 'rs.listen("select", "self", (e) => {\nif (e.option === "1") {\n      rs.animate("self", "pop");\n}\n});';
  assert.equal(reindent(code, "js"), 'rs.listen("select", "self", (e) => {\n  if (e.option === "1") {\n    rs.animate("self", "pop");\n  }\n});');
});

test("only leading and trailing whitespace changes: the non-space characters are identical", () => {
  const code = "const t = expr('Q1 + Q2');   \nif (t > 10) {\nsetCalc('TOTAL', t);flag('big')\n}";
  const out = reindent(code, "js");
  assert.equal(out.replace(/\s+/g, ""), code.replace(/\s+/g, ""));
  assert.equal(out.split("\n").length, code.split("\n").length, "no line is split or joined");
  assert.ok(!/[ \t]$/m.test(out), "trailing spaces trimmed");
  assert.match(out, /\n {2}setCalc/);
});

test("a string spanning a template literal is left alone", () => {
  const code = "const s = `line one\n   kept as is`;\nlog(s);";
  assert.equal(reindent(code, "js"), code);
});

test("CSS and HTML", () => {
  assert.equal(reindent(".rs-card {\ncolor: red;\n  }", "css"), ".rs-card {\n  color: red;\n}");
  assert.equal(reindent("<div>\n<p>Hi</p>\n</div>", "html"), "<div>\n  <p>Hi</p>\n</div>");
});

test("already indented code is unchanged; empty code is fine", () => {
  const code = "if (x) {\n  log(1);\n}";
  assert.equal(reindent(code, "js"), code);
  assert.equal(reindent("", "js"), "");
});
