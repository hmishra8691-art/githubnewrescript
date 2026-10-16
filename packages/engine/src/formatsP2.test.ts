import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { checkUrl, isValidEmail, hasPhoneFormat, hasPostalFormat } from "./formats.js";
import { validateFieldValue } from "./fields.js";
import { validateQuestion } from "./validate.js";
import { createResponseState } from "./state.js";

/** QT-05 / QT-06 / QT-07 */
test("QT-05: one email validator — a@b.c and a..b@c.com are refused, ordinary and international addresses pass", () => {
  for (const bad of ["a@b.c", "a..b@c.com", ".a@c.com", "a.@c.com", "a@b", "a@@b.com", "a b@c.com", "broken@", "@x.com", "a@-b.com", "a@b..com"]) {
    assert.equal(isValidEmail(bad), false, bad);
  }
  for (const good of ["a@b.co", "first.last+tag@sub.example.museum", "josé@exämple.com", "o'brien@example.ie", "x_y@a-b.example.org"]) {
    assert.equal(isValidEmail(good), true, good);
  }
});

test("QT-05: both call sites agree (email rule on a question, email field in a form)", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "e", code: "E", title: "E", version: "1" },
    questions: [{ id: "q1", code: "Q1", variableName: "EM", type: "open_text", text: "Email?", validation: [{ id: "v1", kind: "email" }] }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }],
  });
  const st = createResponseState(def);
  for (const v of ["a@b.c", "a..b@c.com", "a@b.co"]) {
    const rule = validateQuestion(def, def.questions[0]!, v, { def, state: st }).length === 0;
    const field = validateFieldValue("email", v) === null;
    assert.equal(rule, field, `${v}: rule=${rule} field=${field}`);
    assert.equal(rule, isValidEmail(v), v);
  }
});

test("QT-07: checkUrl refuses non-web schemes, userinfo and mailto; keeps bare hosts, ports and https", () => {
  for (const bad of ["mailto:a@b.com", "tel:+15551234567", "javascript:alert(1)", "data:text/html,hi", "ftp://example.com", "a@b.com", "https://user:pw@example.com"]) {
    assert.notEqual(checkUrl(bad), null, bad);
  }
  for (const good of ["example.com", "https://example.com/x?y=1", "http://example.co.uk", "example.com:8080/path", "www.example.com"]) {
    assert.equal(checkUrl(good), null, good);
  }
});

test("QT-06: hasPhoneFormat / hasPostalFormat say whether a strict format exists", () => {
  assert.equal(hasPhoneFormat("IN"), true);
  assert.equal(hasPhoneFormat("BR"), false);
  assert.equal(hasPhoneFormat(undefined), false);
  assert.equal(hasPostalFormat("US"), true);
  assert.equal(hasPostalFormat("BR"), false);
});
