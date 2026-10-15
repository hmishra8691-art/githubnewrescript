import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { guardScriptLoops, selectorGuesses, SCRIPT_LOOP_LIMIT } from "./uxScriptGuard.js";
import { migrateLegacyCustomCode } from "./legacyScripts.js";
import { validateUxScript } from "./ux.js";

/**
 * ONE SCRIPT PIPELINE: loops are bounded rather than banned, selectors that
 * match nothing are called out, and the old Custom code fields are moved into
 * Styles, animations & scripts without losing or duplicating a script.
 */
const survey = (extra: Record<string, unknown> = {}, qs: Record<string, unknown>[] = []) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "T" },
  questions: [
    { id: "q1", code: "Q1", variableName: "A", type: "single_select", text: "A?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }], ...(qs[0] ?? {}) },
    { id: "q2", code: "Q2", variableName: "B", type: "custom_component", text: "B?", customJs: "component code", ...(qs[1] ?? {}) },
  ],
  flow: [{ type: "block", id: "b", title: "B", children: [{ type: "page", id: "p", questionIds: ["q1", "q2"] }] }, { type: "end", id: "e", status: "complete" }],
  ...extra,
});

test("guardScriptLoops: every braced loop body gets a counter; braceless loops are refused", () => {
  const g = guardScriptLoops(`for (let i = 0; i < 3; i++) { a(i); } while (x) { y(); } do { z(); } while (w);`);
  assert.deepEqual(g.errors, []);
  assert.equal((g.code.match(/__g\(\);/g) ?? []).length, 3, g.code);
  assert.ok(SCRIPT_LOOP_LIMIT >= 10_000);
  assert.match(guardScriptLoops(`for (;;) a();`).errors.join(" "), /braces/);
  assert.match(guardScriptLoops(`while (1);`).errors.join(" "), /braces|empty/);
  // loop words in strings and comments are not loops
  const text = guardScriptLoops(`const s = "for (;;) {}"; // while (1) {}`);
  assert.deepEqual(text.errors, []); assert.equal(text.code, `const s = "for (;;) {}"; // while (1) {}`);
  // for…of over a collection, and arrow functions inside a loop body
  const nested = guardScriptLoops(`for (const el of document.querySelectorAll("a")) { el.addEventListener("click", () => { for (const x of []) { x(); } }); }`);
  assert.deepEqual(nested.errors, []); assert.equal((nested.code.match(/__g\(\);/g) ?? []).length, 2);
});

test("selectorGuesses: selectors the runtime does not have are named, with the real hook", () => {
  assert.match(selectorGuesses(`document.querySelector('.next-button')`).join(" "), /rs-next/);
  assert.match(selectorGuesses(`document.querySelectorAll(".question")`).join(" "), /data-qid/);
  assert.deepEqual(selectorGuesses(`document.querySelector('[data-testid="rs-next"]')`), []);
  assert.deepEqual(selectorGuesses(`document.querySelector('[data-qid="q1"]')`), []);
});

test("validateUxScript: document is allowed, window and the rest are not, answers stay the respondent's", () => {
  const d = survey();
  assert.deepEqual(validateUxScript(`document.querySelector('[data-testid="rs-next"]').addEventListener("click", () => rs.log("x"));`, d).errors, []);
  for (const bad of [`window.location = "x"`, `fetch("x")`, `document.cookie`, `top.postMessage(1)`, `parent.x`, `eval("1")`]) assert.ok(validateUxScript(bad, d).errors.length, bad);
  assert.match(validateUxScript(`document.querySelector("input").checked = true;`, d).errors.join(" "), /answer/i);
  assert.match(validateUxScript(`document.querySelector('.next-button').addEventListener("click", () => rs.log("x"))`, d).warnings.join(" "), /rs-next/);
});

test("migrateLegacyCustomCode: a question's customJs and the survey's become script behaviours, once", () => {
  const d = survey({ branding: { customJs: "document.body.setAttribute('data-x', '1');" } }, [{ customJs: "el.classList.add('mine');" }]);
  const m = migrateLegacyCustomCode(d);
  assert.equal(m.blocked.length, 0, JSON.stringify(m.blocked));
  assert.equal(m.changes.length, 2);
  assert.equal(m.def.questions[0].customJs, undefined);
  assert.equal(m.def.branding.customJs, undefined);
  const bs = m.def.ux!.behaviors;
  const q = bs.find((b) => b.source === "question_custom_js")!, s = bs.find((b) => b.source === "branding_custom_js")!;
  assert.equal(q.target.kind, "question"); assert.equal(q.target.questionId, "q1");
  assert.match(q.script!, /el\.classList\.add\('mine'\)/); assert.match(q.script!, /data-qid/);
  assert.equal(s.target.kind, "survey"); assert.match(s.script!, /data-x/);
  // a custom component keeps its own code — it IS the component
  assert.equal(m.def.questions[1].customJs, "component code");
  // idempotent: the moved fields are gone, so a second pass changes nothing
  const again = migrateLegacyCustomCode(m.def);
  assert.equal(again.changes.length, 0); assert.equal(again.def, m.def);
  assert.equal(again.def.ux!.behaviors.length, 2);
  // the input is never mutated
  assert.equal(d.questions[0].customJs, "el.classList.add('mine');");
});

test("migrateLegacyCustomCode: nothing to move is the same object; a script the sandbox refuses is moved, not dropped, and reported", () => {
  const clean = survey();
  assert.equal(migrateLegacyCustomCode(clean).def, clean);
  const d = survey({}, [{ customJs: `fetch("https://x.example/track");` }]);
  const m = migrateLegacyCustomCode(d);
  assert.equal(m.def.questions[0].customJs, undefined);
  assert.equal(m.def.ux!.behaviors.length, 1);
  assert.equal(m.blocked.length, 1); assert.match(m.blocked[0].errors.join(" "), /fetch/);
  // blank customJs is just cleared
  const blank = migrateLegacyCustomCode(survey({}, [{ customJs: "   " }]));
  assert.equal(blank.def.questions[0].customJs, undefined); assert.equal(blank.def.ux?.behaviors.length ?? 0, 0);
  // too long to be a script: left where it is, and said so
  const long = migrateLegacyCustomCode(survey({}, [{ customJs: "a();".repeat(7000) }]));
  assert.equal(long.def.questions[0].customJs?.length, 28000); assert.match(long.blocked[0].errors.join(" "), /longer than/);
});
