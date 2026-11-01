import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState, compileFlow, recordDisplayOrders } from "@rescript/engine";
import { responsesToCSV } from "./csv.js";
import { buildResponseMatrix, responsesToSav } from "./statisticalExport.js";

/* S4c item 3 (RK-04): the stored display order reaches CSV, SPSS (with a variable label) and the shared matrix (Excel / Stata / SAS) */

const page = (id: string, q: string) => ({ type: "page", id, questionIds: [q] });
const qn = (id: string, extra: Record<string, unknown> = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "open_text", text: id, settings: {}, ...extra });
const def = SurveyDefinition.parse({
  meta: { id: "dox", code: "DOX", title: "Display order export", version: "1" },
  questions: [qn("q0", { type: "single_select", options: [{ code: "1", label: "A" }, { code: "2", label: "B" }, { code: "3", label: "C" }], randomization: { enabled: true }, settings: { recordOrder: true } }), qn("a"), qn("b")],
  flow: [page("p0", "q0"), { type: "randomizer", id: "seq", title: "Sequential monadic", children: [page("pa", "a"), page("pb", "b")] }, { type: "end", id: "end", status: "complete" }],
});
const states = [3, 4, 5].map((seed) => {
  const st = createResponseState(def, { seed, sessionId: `dox-session-${seed}` });
  for (const p of compileFlow(def, st)) recordDisplayOrders(def, st, p);
  return st;
});

test("CSV and the export matrix carry ORDER_<ID> and <VAR>_ORDER with each respondent's order", () => {
  const csv = responsesToCSV(def, states as never);
  const header = csv.split(/\r?\n/)[0]!;
  assert.match(header, /ORDER_SEQ/);
  assert.match(header, /Q0_ORDER/);
  const m = buildResponseMatrix(def, states as never);
  assert.ok(m.names.includes("ORDER_SEQ") && m.names.includes("Q0_ORDER"));
  for (const [i, st] of states.entries()) {
    assert.equal(m.rows[i]!.ORDER_SEQ, st.calculated.ORDER_SEQ);
    assert.equal(String(m.rows[i]!.Q0_ORDER).split(",").sort().join(","), "1,2,3");
  }
});

test("SPSS: the order variables are labelled (what they list), not bare names", () => {
  const sav = responsesToSav(def, states as never).toString("latin1");
  assert.ok(sav.includes("Order shown") , "a variable label for the order variables");
  assert.ok(sav.includes("randomizer Sequential monadic"));
});
