import { test } from "node:test";
import assert from "node:assert/strict";
import type { SurveyDefinition } from "@rescript/schema";
import { codeGate, validateUxScript } from "@rescript/engine";
import { codeDiagnostics, fieldDiagnostics, gateFor, locateMessage, sanitizerDiagnostics } from "./diagnostics.ts";

/* S3a item 3: the real gates' sentences mapped to line / column */

const def = {
  meta: { code: "T" },
  questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "single_choice", text: "Pick", options: [{ code: "1", label: "A" }] }],
  flow: [], calculations: [], scripts: [],
} as unknown as SurveyDefinition;

const lineOf = (code: string, at: number) => code.slice(0, at).split("\n").length;
const colOf = (code: string, at: number) => at - code.lastIndexOf("\n", at - 1);

test("an unknown rs method is marked where it is called (line 3), not on line 1", () => {
  const code = 'rs.listen("select", "self", () => {\n  rs.log("x");\n  rs.wiggle("self");\n});';
  const v = validateUxScript(code, def);
  assert.ok(v.errors.some((e) => e.startsWith("rs.wiggle")), JSON.stringify(v.errors));
  const d = codeDiagnostics(code, v).find((x) => x.message.startsWith("rs.wiggle"))!;
  assert.equal(d.severity, "error");
  assert.equal(d.located, true);
  assert.equal(lineOf(code, d.from), 3);
  assert.equal(code.slice(d.from, d.to), "rs.wiggle");
});

test("a question that does not exist: the argument of the call is marked", () => {
  const code = 'const a = 1;\nconst v = rs.getAnswer("Q9");';
  const d = codeDiagnostics(code, validateUxScript(code, def));
  const m = d.find((x) => /no question “Q9”/.test(x.message))!;
  assert.equal(code.slice(m.from, m.to), "Q9");
  assert.equal(lineOf(code, m.from), 2);
  assert.equal(colOf(code, m.from), 25);
});

test("the label prefix of validateUxItem is ignored when locating", () => {
  const code = "\n\nrs.nope();";
  const d = codeDiagnostics(code, { errors: ["“My script”: rs.nope is not part of the survey api (listen, …)"], warnings: [] })[0]!;
  assert.equal(lineOf(code, d.from), 3);
});

test("logic gate: a forbidden name in code is marked, the same word in a comment is not", () => {
  const code = "// window is mentioned here\nconst t = get('Q1');\nwindow.x = 1;";
  const v = codeGate(code, "logic");
  assert.equal(v.ok, false);
  const d = codeDiagnostics(code, { errors: v.errors, warnings: [] }).find((x) => x.message.startsWith("window"))!;
  assert.equal(lineOf(code, d.from), 3);
  assert.equal(code.slice(d.from, d.to), "window");
});

test("a string spelling a forbidden name, and computed access", () => {
  const code = "const k = 1;\nconst o = {};\nconst c = o['constructor'];";
  const v = codeGate(code, "logic");
  const ds = codeDiagnostics(code, { errors: v.errors, warnings: [] });
  assert.ok(ds.length >= 1);
  for (const d of ds) assert.equal(lineOf(code, d.from), 3, d.message);
});

test("component gate: document used beyond creating elements", () => {
  const code = "el.textContent = 'hi';\nconst b = document.body;";
  const v = codeGate(code, "component");
  const d = codeDiagnostics(code, { errors: v.errors, warnings: [] })[0]!;
  assert.equal(lineOf(code, d.from), 2);
});

test("a parse error goes where the parser gave up; without that, line 1 and it says so", () => {
  const code = "const a = 1;\nif (a > {\n}";
  const v = codeGate(code, "logic");
  assert.match(v.errors[0]!, /does not parse/);
  const at = code.indexOf("{");
  const d = codeDiagnostics(code, { errors: v.errors, warnings: [] }, { syntaxErrorAt: at })[0]!;
  assert.equal(lineOf(code, d.from), 2);
  assert.match(code.slice(d.from, d.to), /if \(a > \{/);
  const none = codeDiagnostics(code, { errors: v.errors, warnings: [] })[0]!;
  assert.equal(none.located, false);
  assert.equal(none.from, 0);
  assert.match(none.message, /gives no position — shown on line 1/);
});

test("loops without braces point at the loop keyword", () => {
  const code = "let n = 0;\nwhile (n < 3) n++;";
  const v = codeGate(code, "logic");
  const d = codeDiagnostics(code, { errors: v.errors, warnings: [] })[0]!;
  assert.equal(lineOf(code, d.from), 2, v.errors.join());
});

test("warnings are warnings; a selector guess is marked at the selector", () => {
  const code = 'rs.listen("page", () => {});\nconst b = document.querySelector(".next-button");';
  const v = validateUxScript(code, def);
  const d = codeDiagnostics(code, v).find((x) => /next-button/.test(x.message))!;
  assert.equal(d.severity, "warning");
  assert.equal(code.slice(d.from, d.to), ".next-button");
});

test("CSS and HTML: the line the sanitiser would change is marked, as a warning", () => {
  const css = ".a { color: red; }\n.b { background: url(javascript:alert(1)); }\n@import url(x.css);";
  const d = sanitizerDiagnostics(css, "css");
  assert.deepEqual(d.map((x) => lineOf(css, x.from)), [2, 3]);
  assert.ok(d.every((x) => x.severity === "warning"));
  const html = '<p>Hello</p>\n<img src="x" onerror="alert(1)">';
  assert.deepEqual(sanitizerDiagnostics(html, "html").map((x) => lineOf(html, x.from)), [2]);
  assert.deepEqual(sanitizerDiagnostics(".a { color: red; }", "css"), []);
  const multi = "<div>ok</div>\n<script>\nalert(1)\n</script>";
  assert.ok(sanitizerDiagnostics(multi, "html").length >= 1);
  assert.equal(fieldDiagnostics(css, "css", undefined).length, 2);
});

test("gateFor: logic and component use the code gate; an empty field has nothing to say", () => {
  assert.deepEqual(gateFor("logic")!(""), { errors: [], warnings: [] });
  assert.ok(gateFor("logic")!("fetch('x')").errors.length > 0);
  assert.ok(gateFor("component")!("window.top").errors.length > 0);
  assert.equal(gateFor("css"), undefined);
  assert.ok(gateFor("ux", def)!("rs.bogus()").errors.length > 0);
});

test("locateMessage returns null when the sentence names nothing in the code", () => {
  assert.equal(locateMessage("rs.log(1)", "the script is longer than 20,000 characters"), null);
});
