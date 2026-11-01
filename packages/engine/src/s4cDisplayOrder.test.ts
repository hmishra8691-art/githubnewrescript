import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  createResponseState, compileFlow, recordDisplayOrders, displayOrders, displayOrderLabel, randomizerOrderVariable,
  questionOrderVariable, buildVariableDictionary, flattenVariables, checkSubmission, effectiveQuestion,
} from "./index.js";

/*
 * S4c item 3 (RK-04, RA-07, SM-10): the order each respondent saw is stored — ORDER_<RANDOMIZER> by default,
 * <VAR>_ORDER opt-in — exported, and derived identically by the server's replay.
 */

const page = (id: string, q: string) => ({ type: "page", id, questionIds: [q] });
const qn = (id: string, extra: Record<string, unknown> = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "open_text", text: id, settings: {}, ...extra });
const opts = ["1", "2", "3", "4", "5"].map((c) => ({ code: c, label: `Opt ${c}` }));
const def = (rand: Record<string, unknown> = {}, qExtra: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "do", code: "DO", title: "Display order", version: "1" },
  questions: [
    qn("q0", { type: "single_select", options: opts, randomization: { enabled: true }, settings: { recordOrder: true }, ...qExtra }),
    qn("a"), qn("b"), qn("c"), qn("z"),
  ],
  flow: [
    page("p0", "q0"),
    { type: "randomizer", id: "concepts", title: "Concepts", ...rand, children: [page("pa", "a"), page("pb", "b"), page("pc", "c")] },
    page("pz", "z"),
    { type: "end", id: "end", status: "complete" },
  ],
});
const pages = (st: ReturnType<typeof createResponseState>, d: SurveyDefinition) => compileFlow(d, st).filter((s) => s.kind === "page");

test("every page inside a randomizer carries ORDER_<ID> = the children in the order shown (default on); recordOrder:false = none", () => {
  const d = def();
  const st = createResponseState(d, { seed: 11 });
  const ps = pages(st, d);
  const shown = ps.map((p) => (p as { pageId: string }).pageId).filter((id) => /^p[abc]$/.test(id));
  for (const p of ps) {
    const inside = /^p[abc]$/.test((p as { pageId: string }).pageId);
    assert.deepEqual((p as { orders?: unknown }).orders, inside ? [{ variable: "ORDER_CONCEPTS", value: shown.join(",") }] : undefined);
  }
  const off = def({ recordOrder: false });
  assert.ok(pages(createResponseState(off, { seed: 11 }), off).every((p) => !("orders" in p)));
});

test("recordDisplayOrders writes ORDER_<ID> and the opted-in <VAR>_ORDER (option codes as displayed) into the state", () => {
  const d = def();
  const st = createResponseState(d, { seed: 23 });
  const ps = pages(st, d);
  recordDisplayOrders(d, st, ps[0]);
  const shownOpts = effectiveQuestion(d.questions[0]!, { def: d, state: st, loop: null } as never).options.map((o) => String(o.code)).join(",");
  assert.equal(st.calculated.Q0_ORDER, shownOpts);
  assert.equal(st.calculated.Q0_ORDER.split(",").sort().join(","), "1,2,3,4,5");
  recordDisplayOrders(d, st, ps[1]);
  assert.equal(st.calculated.ORDER_CONCEPTS, ps.slice(1, 4).map((p) => (p as { pageId: string }).pageId).join(","));
  // a question without recordOrder records nothing
  const plain = def({}, { settings: {} });
  const st2 = createResponseState(plain, { seed: 23 });
  assert.deepEqual(Object.keys(displayOrders(plain, st2, pages(st2, plain)[0])), []);
});

test("sequential monadic: across 300 respondents every concept appears first about equally often (rotation), and the order is in the data", () => {
  const d = def({ evenPresentation: true });
  const first: Record<string, number> = {};
  for (let i = 1; i <= 300; i++) {
    const st = createResponseState(d, { seed: i * 101 });
    const ps = pages(st, d);
    recordDisplayOrders(d, st, ps[1]);
    const order = String(st.calculated.ORDER_CONCEPTS).split(",");
    assert.equal(order.length, 3);
    first[order[0]!] = (first[order[0]!] ?? 0) + 1;
    assert.equal(flattenVariables(d, st as never).ORDER_CONCEPTS, order.join(","));
  }
  assert.equal(Object.keys(first).length, 3);
});

test("names: loop codes go before the suffix; labels say what is listed", () => {
  assert.equal(randomizerOrderVariable("r-1", null), "ORDER_R_1");
  assert.equal(randomizerOrderVariable("r1", { code: "apple" } as never), "ORDER_R1_APPLE");
  assert.equal(questionOrderVariable({ id: "x", variableName: "BRAND" }, "rows"), "BRAND_ROW_ORDER");
  const d = def();
  assert.match(displayOrderLabel(d, "ORDER_CONCEPTS") ?? "", /randomizer Concepts \(pa, pb, pc\)/);
  assert.match(displayOrderLabel(d, "Q0_ORDER") ?? "", /Q0 options/);
  assert.equal(displayOrderLabel(d, "SOMETHING_ELSE"), null);
});

test("the variable dictionary declares ORDER_<ID> and <VAR>_ORDER (so every export has the columns)", () => {
  const names = buildVariableDictionary(def()).map((v) => v.name);
  assert.ok(names.includes("ORDER_CONCEPTS"));
  assert.ok(names.includes("Q0_ORDER"));
  const none = buildVariableDictionary(def({ recordOrder: false }, { settings: {} })).map((v) => v.name);
  assert.ok(!none.includes("ORDER_CONCEPTS") && !none.includes("Q0_ORDER"));
});

test("server replay: the posted order is derived identically (no mismatch); a forged one is a soft server_mismatch with the server's value", () => {
  const d = def();
  const st = createResponseState(d, { seed: 7, sessionId: "s4c-order-replay-01" });
  const ps = pages(st, d);
  recordDisplayOrders(d, st, ps[0]);
  st.answers.q0 = "2";
  recordDisplayOrders(d, st, ps[1]);
  const prior = { seed: 7, sessionId: "s4c-order-replay-01" };
  const good = checkSubmission({ def: d, prior, posted: { answers: st.answers, calculated: { ...st.calculated }, stepIndex: 1, status: "in_progress" } });
  assert.equal(good.ok, true);
  assert.deepEqual(good.soft.filter((x) => x.code === "server_mismatch"), []);
  const forged = { ...st.calculated, ORDER_CONCEPTS: "pc,pb,pa" === st.calculated.ORDER_CONCEPTS ? "pa,pb,pc" : "pc,pb,pa" };
  const bad = checkSubmission({ def: d, prior, posted: { answers: st.answers, calculated: forged, stepIndex: 1, status: "in_progress" } });
  const m = bad.soft.find((x) => x.code === "server_mismatch" && x.variable === "ORDER_CONCEPTS");
  assert.ok(m, JSON.stringify(bad.soft));
  assert.equal(bad.recomputed?.calculated.ORDER_CONCEPTS, st.calculated.ORDER_CONCEPTS);
});

import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";
test("IM: set_option_randomization recordOrder:true opts the question in (and false out)", () => {
  const d = def({}, { settings: {} });
  const on = applySurveyActions(d, coerceSurveyActions([{ op: "set_option_randomization", target: "Q0", enabled: true, recordOrder: true }]).actions, { ids: (p: string) => `${p}_1` });
  assert.equal(on.results[0]!.ok, true, on.results[0]!.error);
  assert.equal((on.def.questions[0]!.settings as { recordOrder?: boolean }).recordOrder, true);
  assert.match(on.results[0]!.description ?? "", /Q0_ORDER/);
  const off = applySurveyActions(on.def, coerceSurveyActions([{ op: "set_option_randomization", target: "Q0", enabled: true, recordOrder: false }]).actions, { ids: (p: string) => `${p}_2` });
  assert.equal((off.def.questions[0]!.settings as { recordOrder?: boolean }).recordOrder, undefined);
});

test("server replay: an older client that posts no ORDER_* gets the server's order stored, without a mismatch line", () => {
  const d = def();
  const st = createResponseState(d, { seed: 7, sessionId: "s4c-order-replay-02" });
  st.answers.q0 = "2";
  const r = checkSubmission({ def: d, prior: { seed: 7, sessionId: "s4c-order-replay-02" }, posted: { answers: st.answers, calculated: {}, stepIndex: 1, status: "in_progress" } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.soft.filter((x) => x.code === "server_mismatch"), []);
  assert.ok(String(r.recomputed?.calculated.ORDER_CONCEPTS ?? "").split(",").length === 3, JSON.stringify(r.recomputed));
});
