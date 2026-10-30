import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState, resolveAuthorHtml, sanitizeHtml } from "./index.js";

/**
 * AUDIT 2026-10-30 D5 — AUTHOR HTML IS SANITISED AT RENDER. Branding header / footer (Runner.tsx) and a custom
 * component's HTML (QuestionRenderer.tsx) are drawn through `resolveAuthorHtml` = piping + `sanitizeHtml`, the
 * sanitiser option labels already use. Handlers and scripts go; inline styles and classes stay.
 */
const def = SurveyDefinition.parse({
  meta: { id: "s", title: "t" },
  questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "text", text: "Name", settings: {}, options: [] }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }],
  scripts: [], branding: {},
});
const ctx = () => { const state = createResponseState(def, { sessionId: "x" }); state.answers.q1 = '<img src=x onerror="alert(2)">'; return { def, state }; };

test("D5: <img onerror> and <script> are removed from header / footer / component HTML", () => {
  const out = resolveAuthorHtml('<div class="brand" style="color:#c00;font-weight:600">Acme <img src=x onerror="fetch(\'//evil\')"><script>alert(1)</script><a href="javascript:alert(3)">x</a></div>', ctx());
  assert.doesNotMatch(out, /onerror/i);
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /alert\(1\)/);
  assert.doesNotMatch(out, /javascript:/i);
  assert.match(out, /class="brand"/, "classes are kept");
  assert.match(out, /style="color:#c00;\s*font-weight:600"/, "inline styles are kept");
  assert.match(out, /Acme/);
});

test("D5: piped respondent values stay escaped, the template is sanitised", () => {
  const out = resolveAuthorHtml("<p>Hello {{Q1}}</p><svg onload=alert(1)></svg>", ctx());
  assert.match(out, /&lt;img/);
  assert.doesNotMatch(out, /onload/i);
  assert.equal(resolveAuthorHtml(undefined, ctx()), "");
  assert.equal(resolveAuthorHtml("Plain footer © 2026", ctx()), "Plain footer © 2026");
});

test("D5: the same sanitiser option labels use", () => {
  const html = '<b style="color:red" onclick="x()">Yes</b>';
  assert.equal(resolveAuthorHtml(html, ctx()), sanitizeHtml(html));
});
