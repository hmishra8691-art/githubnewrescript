import test from "node:test";
import assert from "node:assert/strict";
import { compileFlow, resumeAt, start, createResponseState } from "./index.js";
import type { SurveyDefinition } from "@rescript/schema";

/*
 * THE INFINITE LOADING SCREEN.
 *
 * A survey whose flow begins with anything that is not a page — an
 * `embedded_data` node capturing URL parameters, a `quota_check`, a redirect —
 * compiles to a steps array whose step 0 cannot be rendered.
 *
 * `start()` has always been fine: it walks from -1 through `moveForward`,
 * which executes the non-page steps and stops at the first page. The RESUME
 * path did not. It restored the saved index directly:
 *
 *     state.stepIndex = Math.max(0, Math.min(saved.stepIndex ?? 0, len - 1));
 *
 * and a row saved before the first page was ever submitted has
 * `step_index = 0`. So resume parked the runtime on the `embedded_data` step,
 * `pageStep` was null, and the Runner rendered "Loading…" — for ever, because
 * the only things that call `advance()` are the Next and Back handlers and
 * both begin `if (!pageStep) return;`.
 *
 * Nothing threw, no request failed, no promise was pending. The survey had
 * finished loading and was parked on a step it could not draw.
 *
 * These tests are about the SETTLING rule, not about embedded data: the same
 * deadlock follows from any leading non-page node, and from a saved index that
 * points at a page which has since become invisible.
 */

const page = (id: string, questionIds: string[], extra: Record<string, unknown> = {}) =>
  ({ type: "page", id, questionIds, ...extra }) as never;

const q = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id, code: id.toUpperCase(), variableName: id.toUpperCase(),
    type: "single_select", text: id, required: false,
    options: [{ id: `${id}_a`, code: "1", label: "A" }, { id: `${id}_b`, code: "2", label: "B" }],
    settings: {},
    ...extra,
  }) as never;

/** A survey whose flow starts by capturing embedded data, exactly like the demo. */
function defWithLeadingEmbeddedData(): SurveyDefinition {
  return {
    meta: { id: "s1", code: "S1", title: "Leading embedded data", status: "draft", version: "1.0", schemaVersion: 1 },
    /* the collections the engine walks unconditionally; a real definition always has them */
    calculations: [], displayRules: [], variables: [], listFills: [],
    quotas: [], scripts: [], namedExpressions: [],
    questions: [q("q1"), q("q2")],
    embeddedData: [
      { id: "ed_wave", name: "WAVE", source: "url", key: "wave", defaultValue: "2026-W37" },
      { id: "ed_panel", name: "PANEL", source: "url", key: "panel", defaultValue: "DEMO-PANEL" },
    ],
    flow: [
      { type: "embedded_data", id: "ed_capture", fields: [
        { id: "ed_wave", name: "WAVE", source: "url", key: "wave", defaultValue: "2026-W37" },
        { id: "ed_panel", name: "PANEL", source: "url", key: "panel", defaultValue: "DEMO-PANEL" },
      ] },
      page("p1", ["q1"]),
      page("p2", ["q2"]),
      { type: "end", id: "end_complete", status: "complete" },
    ],
  } as never;
}

test("the flow really does begin with a step that cannot be rendered", () => {
  /*
   * The premise. If this ever stops being true the tests below are proving
   * nothing, so it is asserted rather than assumed.
   */
  const def = defWithLeadingEmbeddedData();
  const state = createResponseState(def, { seed: 1 });
  const steps = compileFlow(def, state, {});
  assert.notEqual(steps[0]?.kind, "page", "step 0 should be the embedded_data node");
  assert.equal(steps[0]?.kind, "embedded_data");
});

test("a fresh start was never the problem — it settles on the first page", () => {
  const def = defWithLeadingEmbeddedData();
  const state = createResponseState(def, { seed: 1 });
  const nav = start(def, state, {});
  assert.equal(nav.steps[nav.stepIndex]?.kind, "page");
  assert.equal(state.stepIndex, nav.stepIndex);
});

test("RESUMING AT 0 MUST NOT PARK ON THE EMBEDDED-DATA STEP", () => {
  /*
   * The bug, exactly. `responses.step_index` is 0 for a row created when the
   * session started and never advanced — which is every test session somebody
   * opened and closed without answering anything.
   */
  const def = defWithLeadingEmbeddedData();
  const state = createResponseState(def, { seed: 1 });
  const nav = resumeAt(def, state, {}, 0);
  const at = nav.steps[nav.stepIndex];
  assert.equal(at?.kind, "page",
    `resume landed on a ${at?.kind ?? "missing"} step, which renders as an infinite spinner`);
  assert.equal(state.stepIndex, nav.stepIndex, "state and result must agree on where we are");
  assert.equal(nav.done, false);
});

test("resuming mid-survey keeps the respondent exactly where they were", () => {
  /*
   * The settling must not become "always jump forward". Somebody resuming on
   * page 2 resumes on page 2.
   */
  const def = defWithLeadingEmbeddedData();
  const state = createResponseState(def, { seed: 1 });
  const steps = compileFlow(def, state, {});
  const p2 = steps.findIndex((s) => s.kind === "page" && s.pageId === "p2");
  assert.ok(p2 > 0);

  const nav = resumeAt(def, state, {}, p2);
  assert.equal(nav.stepIndex, p2, "a resumable page must be resumed, not skipped");
  assert.equal((nav.steps[nav.stepIndex] as { pageId: string }).pageId, "p2");
});

test("the embedded data is captured on the way past, not skipped over", () => {
  /*
   * Settling forward runs the non-page steps it walks through. If it merely
   * jumped the index, WAVE and PANEL would be unset and every piping
   * reference to them would render empty — a quieter version of the same bug.
   */
  const def = defWithLeadingEmbeddedData();
  const state = createResponseState(def, { seed: 1 });
  resumeAt(def, state, {}, 0);
  assert.equal(state.embedded.WAVE, "2026-W37");
  assert.equal(state.embedded.PANEL, "DEMO-PANEL");
});

test("a quota_check first is the same deadlock, and settles the same way", () => {
  /* The rule is about non-page steps, not about embedded data specifically. */
  const def = {
    ...defWithLeadingEmbeddedData(),
    flow: [
      { type: "quota_check", id: "qc", quotaIds: [], onFull: { kind: "end" } },
      page("p1", ["q1"]),
      { type: "end", id: "end_complete", status: "complete" },
    ],
  } as never as SurveyDefinition;
  const state = createResponseState(def, { seed: 1 });
  const nav = resumeAt(def, state, {}, 0);
  assert.equal(nav.steps[nav.stepIndex]?.kind, "page");
});

test("a saved index pointing at a page that is now hidden moves on rather than hanging", () => {
  /*
   * The survey was edited between sessions, or an answer changed and the page
   * the respondent was on no longer has a visible question. Landing on it
   * would render an empty page — the same dead end wearing a different face.
   */
  const def = {
    ...defWithLeadingEmbeddedData(),
    questions: [q("q1"), q("q2", { displayLogic: { type: "rule", source: { kind: "embedded", ref: "NOPE" }, operator: "eq", value: "never-matches" } })],
    flow: [
      { type: "embedded_data", id: "ed_capture", fields: [] },
      page("p1", ["q1"]),
      page("p2", ["q2"]),
      page("p3", ["q1"]),
      { type: "end", id: "end_complete", status: "complete" },
    ],
  } as never as SurveyDefinition;
  const state = createResponseState(def, { seed: 1 });
  const steps = compileFlow(def, state, {});
  const p2 = steps.findIndex((s) => s.kind === "page" && s.pageId === "p2");
  const nav = resumeAt(def, state, {}, p2);
  const at = nav.steps[nav.stepIndex];
  assert.equal(at?.kind, "page");
  assert.notEqual((at as { pageId: string }).pageId, "p2", "an empty page must not be resumed onto");
});

test("a saved index past the end of a shortened survey completes rather than hanging", () => {
  const def = defWithLeadingEmbeddedData();
  const state = createResponseState(def, { seed: 1 });
  const nav = resumeAt(def, state, {}, 9999);
  assert.equal(nav.done, true, "there is nowhere to go, so the response is finished");
  assert.equal(nav.endStatus, "complete");
});

test("a negative or absent saved index behaves like a fresh start", () => {
  const def = defWithLeadingEmbeddedData();
  for (const saved of [-1, undefined, null, Number.NaN]) {
    const state = createResponseState(def, { seed: 1 });
    const nav = resumeAt(def, state, {}, saved as never);
    assert.equal(nav.steps[nav.stepIndex]?.kind, "page", `saved index ${String(saved)} must still land on a page`);
  }
});

test("a flow with no pages at all ENDS — it does not sit on a step that cannot be drawn", () => {
  /*
   * The second half of the fix. Whatever the reason there is nothing to show,
   * the answer is a finished response or an error, never a spinner.
   */
  const def = {
    ...defWithLeadingEmbeddedData(),
    flow: [
      { type: "embedded_data", id: "ed_capture", fields: [] },
      { type: "end", id: "end_complete", status: "complete" },
    ],
  } as never as SurveyDefinition;
  const state = createResponseState(def, { seed: 1 });
  const nav = resumeAt(def, state, {}, 0);
  assert.equal(nav.done, true);
  assert.notEqual(nav.steps[nav.stepIndex]?.kind, undefined);
});
