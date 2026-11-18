import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { validateUxScript, UX_SCRIPT_API } from "./ux.js";
import { SANDBOX_API } from "./capabilityRegistry.js";

/* audit 2026-11-17, P1-03: rs.lock / rs.unlock and the per-field handle rs.field(code) pass the script check, their targets are checked */
const def = SurveyDefinition.parse({
  meta: { id: "f", code: "F", title: "F", version: "1.0" },
  questions: [
    { id: "s1", code: "S1", variableName: "S1", type: "single_select", text: "Specialty", options: [{ code: 1, label: "A" }] },
    { id: "q3", code: "Q3", variableName: "Q3", type: "open_text", text: "Filled" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["s1", "q3"] }],
});

test("a script that fills a field from another and locks it passes the check", () => {
  const r = validateUxScript(`rs.listen("change", "S1", async function () { await rs.field("Q3").set(rs.field("S1").value()); rs.field("Q3").lock(); rs.unlock("Q3"); });`, def);
  assert.deepEqual(r.errors, []);
});

test("a lock or a field handle naming a question that does not exist is refused before it reaches a respondent", () => {
  assert.match(validateUxScript(`rs.lock("Q99");`, def).errors.join(" "), /rs\.lock\("Q99"\)/);
  assert.match(validateUxScript(`rs.field("Q77").lock();`, def).errors.join(" "), /rs\.field\("Q77"\)/);
});

test("the new calls are documented where the AI and the docs read the api", () => {
  for (const n of ["lock", "unlock", "field"]) assert.ok((UX_SCRIPT_API as readonly string[]).includes(n));
  for (const n of ["lock", "unlock", "field"] as const) assert.match(SANDBOX_API[n].sig, new RegExp(`rs\\.${n}`));
});
