import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState, designVersionFor, shuffleAlternatives } from "@rescript/engine";
import { choiceDataToCSV, responsesToCSV } from "./index.js";

/**
 * Conjoint audit 2026-10-17: the stacked CBC file, from a four-version design
 * with a None alternative — the file a client runs
 * MNL / HB on. Every shown alternative is a row; the chosen one is the stored
 * design alternative; its levels are that alternative's levels; the wide file
 * carries the same order in VAR_T<n>_ORDER.
 */
const config = {
  attributes: [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Price", levels: ["$199", "$299", "$399"] }, { name: "Battery", levels: ["1 day", "2 days"] }],
  tasks: 4, alternativesPerTask: 3, noneOption: true, versions: 4,
};
// a four-version design laid out like the generator's (exporters does not depend on @rescript/designs)
const design = { columns: ["version", "task", "alt", "is_holdout", "Brand", "Price", "Battery", "none_option"], rows: [] as Record<string, unknown>[] };
for (let version = 1; version <= 4; version++) for (let task = 1; task <= 4; task++) {
  for (let alt = 1; alt <= 3; alt++) {
    design.rows.push({ version, task, alt, is_holdout: 0, Brand: config.attributes[0].levels[(alt + task) % 3], Price: config.attributes[1].levels[(alt + version + task) % 3], Battery: config.attributes[2].levels[(alt + version) % 2], none_option: 0 });
  }
  design.rows.push({ version, task, alt: 4, is_holdout: 0, Brand: "", Price: "", Battery: "", none_option: 1 });
}
const def = SurveyDefinition.parse({
  meta: { id: "x", code: "X", title: "Stacked", version: "1.0" },
  designs: [{ id: "d1", kind: "conjoint", name: "CBC", version: 1, config, file: { format: "json", columns: design.columns, rows: design.rows } }],
  questions: [{ id: "q1", code: "Q1", variableName: "CJ", type: "conjoint_task", text: "Choose", required: true, settings: { designRef: "d1" } }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
});

function parse(csv: string) {
  const [head, ...lines] = csv.trim().split("\n");
  const cols = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((c, i) => [cols[i], c])));
}

test("the stacked CBC file (four versions, None): one row per shown alternative, the stored choice joined to that design alternative's levels", () => {
  const states = [11, 12, 13, 14, 15].map((seed, i) => {
    const s = createResponseState(def, { sessionId: `s${i}`, seed });
    s.answers.q1 = { "1": "1", "2": "2", "3": "4", "4": "3" };
    return { ...s, respondentId: `R${i}` };
  });
  const out = choiceDataToCSV(def, states);
  assert.equal(out.rows, 5 * 4 * 4);
  assert.equal(out.skippedNoSeed, 0);
  const rows = parse(out.csv);
  assert.deepEqual(Object.keys(rows[0]).slice(0, 11), ["respondent", "session_id", "question", "version", "task", "is_holdout", "alt", "concept_id", "position", "none", "chosen"]);
  assert.ok(Object.keys(rows[0]).includes("Price_code"));
  for (const [i, st] of states.entries()) {
    const version = designVersionFor(def.questions[0], design.rows, st.seed);
    const mine = rows.filter((r) => r.respondent === `R${i}`);
    assert.ok(mine.every((r) => r.version === version), "the respondent's own version");
    for (const t of ["1", "2", "3", "4"]) {
      const task = mine.filter((r) => r.task === t);
      const chosen = task.filter((r) => r.chosen === "1");
      assert.equal(chosen.length, 1);
      assert.equal(chosen[0].alt, String((st.answers.q1 as Record<string, string>)[t]));
      const shown = shuffleAlternatives(design.rows.filter((r) => String(r.version) === version && String(r.task) === t), st.seed, `q1:${t}`);
      assert.deepEqual(task.map((r) => r.alt), shown.map((r) => String(r.alt)));
      for (const r of task) {
        if (r.none === "1") { assert.equal(r.Brand, ""); continue; }
        const d = design.rows.find((x) => String(x.version) === version && String(x.task) === t && String(x.alt) === r.alt)!;
        assert.equal(r.Brand, d.Brand); assert.equal(r.Price, d.Price); assert.equal(r.Battery, d.Battery);
        assert.equal(r.Price_code, String(config.attributes[1].levels.indexOf(String(d.Price)) + 1));
      }
    }
    // the wide file says the same thing about the order
    const wide = parse(responsesToCSV(def, [st]))[0];
    const stacked = mine.filter((r) => r.task === "1").map((r) => r.alt).join("|");
    assert.equal(wide.CJ_T1_ORDER, stacked);
    assert.equal(wide.CJ_VERSION, version);
  }
});

test("a response with no seed is skipped and counted, not given a guessed version", () => {
  const s = createResponseState(def, { sessionId: "n", seed: 3 });
  s.answers.q1 = { "1": "1" };
  const out = choiceDataToCSV(def, [{ ...s, seed: null as never }]);
  assert.equal(out.rows, 0);
  assert.equal(out.skippedNoSeed, 1);
  const wide = parse(responsesToCSV(def, [{ ...s, seed: undefined } as never]))[0];
  assert.equal(wide.CJ_VERSION, "", "no version invented");
  assert.equal(wide.CJ_T1, "1");
});
