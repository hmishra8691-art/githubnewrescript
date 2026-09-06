import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import {
  createResponseState,
  validateQuestion,
  validatePage,
  blockingErrors,
  warnings,
  runScripts,
  effectiveQuestion,
  resolveQuestionMedia,
  resolveMediaUrl,
  allEmbeddedFields,
  setAnswer,
} from "./index.js";

/**
 * WAVE 1 — the parts of the platform that were configurable and inert.
 *
 * Each test below pins a behaviour that a programmer could already ASK for
 * through the schema or the Studio, and that the engine did not deliver: a
 * script event that never fired, a validation kind that always passed, a
 * severity that did not exist, a piped URL that was never resolved, an
 * embedded field the runtime never looked for. The point of the tests is
 * less the new feature than the promise the product was already making.
 */

function survey(extra: Record<string, unknown> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Wave 1", version: "1.0" },
    questions: [
      {
        id: "q_name", code: "Q1", variableName: "NAME", type: "open_text",
        text: "Your name?",
      },
      {
        id: "q_spend", code: "Q2", variableName: "SPEND", type: "numeric",
        text: "Monthly spend?",
        validation: [
          { kind: "max_value", value: 500, severity: "warning", message: "That is unusually high — is it right?" },
          { kind: "max_value", value: 100000 },
        ],
      },
      {
        id: "q_phone", code: "Q3", variableName: "PHONE", type: "open_text",
        text: "Phone?", validation: [{ kind: "phone" }],
      },
      {
        id: "q_when", code: "Q4", variableName: "WHEN", type: "date",
        text: "When?", settings: { minDate: "2026-01-01", maxDate: "2026-12-31" },
      },
      {
        id: "q_pack", code: "Q5", variableName: "PACK", type: "single_select",
        text: "Pick a pack",
        settings: { imageUrl: "https://cdn.example.com/{{ed.REGION}}/hero.png" },
        options: [
          { code: 1, label: "Blue", imageUrl: "https://cdn.example.com/{{ed.REGION}}/blue.png" },
          { code: 2, label: "Red" },
        ],
      },
      {
        id: "q_grid", code: "Q6", variableName: "GRID", type: "composite",
        text: "Split 100 points down each column",
        rows: [{ code: "r1", label: "Jan" }, { code: "r2", label: "Feb" }],
        columns: [
          { id: "c_a", label: "Brand A", responseType: "numeric", variableStem: "A" },
          { id: "c_b", label: "Brand B", responseType: "numeric", variableStem: "B" },
        ],
        validation: [{ kind: "column_sum_equals", value: 100, ref: "c_a" }],
      },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q_name", "q_spend", "q_phone", "q_when", "q_pack", "q_grid"] }],
    ...extra,
  });
}

const ctxFor = (def: ReturnType<typeof survey>) => {
  const state = createResponseState(def, { sessionId: "t", seed: 1 });
  return { def, state, loop: null };
};

/* ------------------------------------------------------------ §9 severity */

test("a warning rule reports without blocking, and a plain rule still blocks", () => {
  const def = survey();
  const ctx = ctxFor(def);
  const q = def.questions.find((x) => x.code === "Q2")!;

  const soft = validateQuestion(def, q, 900, ctx);
  assert.equal(soft.length, 1);
  assert.equal(soft[0].severity, "warning");
  assert.equal(blockingErrors(soft).length, 0, "a warning must never stop the page");
  assert.equal(warnings(soft).length, 1);

  const hard = validateQuestion(def, q, 200000, ctx);
  assert.equal(blockingErrors(hard).length, 1, "the hard ceiling still blocks");
});

test("severity is absent on every rule that predates it, and absent means blocking", () => {
  const def = survey();
  const ctx = ctxFor(def);
  const q = def.questions.find((x) => x.code === "Q3")!;
  const errs = validateQuestion(def, q, "12", ctx);
  assert.equal(errs.length, 1);
  // the engine normalises: a rule that did not ask for a severity reports
  // "error", so no caller has to remember what an absent field means
  assert.equal(errs[0].severity, "error");
  assert.equal(blockingErrors(errs).length, 1);
});

/* --------------------------------------------------------- §9 new rule kinds */

test("phone accepts the shapes people type and rejects a stub", () => {
  const def = survey();
  const ctx = ctxFor(def);
  const q = def.questions.find((x) => x.code === "Q3")!;
  for (const ok of ["+44 20 7946 0958", "(415) 555-2671", "9876543210"]) {
    assert.equal(validateQuestion(def, q, ok, ctx).length, 0, `${ok} should pass`);
  }
  for (const bad of ["12345", "not a phone"]) {
    assert.equal(validateQuestion(def, q, bad, ctx).length, 1, `${bad} should fail`);
  }
});

test("date bounds are enforced by the engine, not only by the picker", () => {
  const def = survey();
  const ctx = ctxFor(def);
  const q = def.questions.find((x) => x.code === "Q4")!;
  assert.equal(validateQuestion(def, q, "2026-06-15", ctx).length, 0);
  assert.equal(validateQuestion(def, q, "2025-12-31", ctx).length, 1, "before minDate");
  assert.equal(validateQuestion(def, q, "2027-01-01", ctx).length, 1, "after maxDate");
});

test("a column total is checked down the column, across every row", () => {
  const def = survey();
  const ctx = ctxFor(def);
  const q = def.questions.find((x) => x.code === "Q6")!;
  const good = { r1: { c_a: 60, c_b: 10 }, r2: { c_a: 40, c_b: 90 } };
  assert.equal(validateQuestion(def, q, good, ctx).length, 0, "column A totals 100");
  const bad = { r1: { c_a: 60, c_b: 10 }, r2: { c_a: 10, c_b: 90 } };
  const errs = validateQuestion(def, q, bad, ctx);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].columnId, "c_a");
  assert.match(errs[0].message, /70/);
});

/* ------------------------------------------------------- §21 custom_script */

test("a custom_script validation rule actually runs, and can pass or fail", () => {
  const def = survey({
    scripts: [{
      id: "sc1", name: "even only", scope: "survey", event: "on_validate", enabled: true,
      code: 'if (Number(value) % 2 !== 0) error("Please enter an even number.");',
    }],
  });
  def.questions.find((q) => q.code === "Q2")!.validation = [
    { kind: "custom_script", value: "sc1" } as never,
  ];
  const ctx = ctxFor(def);
  const q = def.questions.find((x) => x.code === "Q2")!;
  assert.equal(validateQuestion(def, q, 4, ctx).length, 0, "an even answer passes");
  const errs = validateQuestion(def, q, 7, ctx);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].message, "Please enter an even number.");
});

/* ------------------------------------------------------ §21 script events */

test("on_validate and on_complete scripts run when asked for", () => {
  const def = survey({
    scripts: [
      {
        id: "v1", name: "gate", scope: "survey", event: "on_validate", enabled: true,
        code: 'error("no entry", "q_name");',
      },
      {
        id: "c1", name: "stamp", scope: "survey", event: "on_complete", enabled: true,
        code: 'setCalc("FINISHED", 1);',
      },
    ],
  });
  const ctx = ctxFor(def);
  const v = runScripts(def, ctx.state, "on_validate");
  assert.deepEqual(v.errors, [{ message: "no entry", questionRef: "q_name" }]);

  const c = runScripts(def, ctx.state, "on_complete");
  assert.equal(c.errors.length, 0);
  assert.equal(ctx.state.calculated.FINISHED, 1, "an on_complete script's write reaches the response");
});

test("a script's logs come back named, and a broken script names itself", () => {
  const def = survey({
    scripts: [
      { id: "l1", name: "noisy", scope: "survey", event: "on_load", enabled: true, code: 'log("hello");' },
      { id: "l2", name: "broken", scope: "survey", event: "on_load", enabled: true, code: "nope();" },
    ],
  });
  const ctx = ctxFor(def);
  const r = runScripts(def, ctx.state, "on_load");
  assert.ok(r.logs.some((l) => l === "[noisy] hello"), `expected a named log, got ${JSON.stringify(r.logs)}`);
  assert.ok(r.logs.some((l) => l.startsWith("[broken] ERROR:")));
});

test("a script cannot reach the globals it has no business reaching", () => {
  const def = survey({
    scripts: [{
      id: "s1", name: "probe", scope: "survey", event: "on_load", enabled: true,
      code: 'setCalc("REACHED", typeof fetch + "/" + typeof window + "/" + typeof process);',
    }],
  });
  const ctx = ctxFor(def);
  runScripts(def, ctx.state, "on_load");
  assert.equal(ctx.state.calculated.REACHED, "undefined/undefined/undefined");
});

/* ------------------------------------------------------------ §12 media */

test("piping resolves in a question's stimulus and in option images", () => {
  const def = survey();
  const ctx = ctxFor(def);
  ctx.state.embedded.REGION = "uk";
  const q = def.questions.find((x) => x.code === "Q5")!;

  assert.equal(resolveQuestionMedia(q, ctx).imageUrl, "https://cdn.example.com/uk/hero.png");
  const view = effectiveQuestion(q, ctx);
  assert.equal(view.options[0].imageUrl, "https://cdn.example.com/uk/blue.png");
  assert.equal(view.options[1].imageUrl, undefined, "an option without a token is untouched");
});

test("a URL with no tokens is returned unchanged, so nothing re-allocates", () => {
  const def = survey();
  const ctx = ctxFor(def);
  const q = def.questions.find((x) => x.code === "Q1")!;
  assert.deepEqual(resolveQuestionMedia(q, ctx), { imageUrl: undefined, mediaUrl: undefined });
});

/* -------------------------------------------------------------- §20 audio */

test("an audio URL resolves as media rather than as a broken image", () => {
  for (const ext of ["mp3", "wav", "m4a", "ogg"]) {
    const m = resolveMediaUrl(`https://cdn.example.com/clip.${ext}`);
    assert.equal(m.kind, "video", `${ext} should resolve to a playable media element`);
  }
  assert.equal(resolveMediaUrl("https://cdn.example.com/pack.png").kind, "image");
});

/* --------------------------------------------------- §11 nested url fields */

test("an embedded field declared inside a block or a branch is still declared", () => {
  const def = survey({
    flow: [
      {
        type: "block", id: "b1", children: [
          { type: "embedded_data", id: "e1", fields: [{ name: "PANEL_ID", source: "url" }] },
          { type: "page", id: "p1", questionIds: ["q_name"] },
        ],
      },
      {
        type: "branch", id: "br1",
        branches: [{
          id: "x", when: cond.rule("q_name", "answered"), children: [
            { type: "embedded_data", id: "e2", fields: [{ name: "SOURCE", source: "url" }] },
          ],
        }],
      },
    ],
  });
  const names = allEmbeddedFields(def).map((f) => f.name);
  assert.deepEqual(names.sort(), ["PANEL_ID", "SOURCE"]);
});

/* ------------------------------------------------------------- regression */

test("validatePage still returns one entry per failing question, severity and all", () => {
  const def = survey();
  const ctx = ctxFor(def);
  setAnswer(def, ctx.state, "q_spend", 900, null);
  setAnswer(def, ctx.state, "q_phone", "123", null);
  const errs = validatePage(def, def.questions, ctx);
  assert.equal(blockingErrors(errs).length, 1, "only the phone blocks");
  assert.equal(warnings(errs).length, 1, "the spend warns");
});
