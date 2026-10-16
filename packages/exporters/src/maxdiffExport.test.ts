import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState, shuffleAlternatives } from "@rescript/engine";
import { responsesToCSV } from "./index.js";

/** METHOD-04 / METHOD-14: an anchored MaxDiff reaches the flat export with its anchors and shown order. */
function survey(anchored: boolean): SurveyDefinition {
  const rows = [1, 2].flatMap((t) =>
    [1, 2, 3, 4].map((pos) => ({ version: 1, task: t, position: pos, item_index: pos + t, item_label: `Item ${pos + t}` })));
  return SurveyDefinition.parse({
    meta: { id: "t", code: "T", title: "Tasks", version: "1.0" },
    designs: [{
      id: "d1", kind: "maxdiff", name: "MD", version: 1, config: anchored ? { anchored: true } : {},
      file: { columns: ["version", "task", "position", "item_index", "item_label"], rows },
    }],
    questions: [{ id: "q1", code: "Q1", variableName: "MD", type: "maxdiff_task", text: "Choose", required: true, settings: { designRef: "d1" } }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
  });
}

function parseCsv(csv: string): Record<string, string>[] {
  const [head, ...lines] = csv.trim().split(/\r?\n/);
  const cols = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((c, i) => [cols[i], c.replace(/^"|"$/g, "")])));
}

test("anchored MaxDiff exports one anchor column per task", () => {
  const def = survey(true);
  const state = createResponseState(def, { seed: 7 });
  state.answers.q1 = { "1": { best: "2", worst: "3", anchor: "some" }, "2": { best: "3", worst: "4", anchor: "all" } };
  const csv = responsesToCSV(def, [state]);
  const header = csv.split(/\r?\n/)[0].split(",");
  assert.ok(header.includes("MD_T1_ANCHOR") && header.includes("MD_T2_ANCHOR"), header.join(","));
  assert.ok(!header.includes("MD_ANCHOR"));
  const row = parseCsv(csv)[0];
  assert.equal(row.MD_T1_ANCHOR, "some");
  assert.equal(row.MD_T2_ANCHOR, "all");
  assert.equal(row.MD_T1_BEST, "2");
});

test("a non-anchored design declares no anchor columns", () => {
  const def = survey(false);
  const state = createResponseState(def, { seed: 7 });
  state.answers.q1 = { "1": { best: "2", worst: "3" } };
  const header = responsesToCSV(def, [state]).split(/\r?\n/)[0].split(",");
  assert.ok(!header.some((h) => h.includes("ANCHOR")));
});

test("the shown order is exported and equals what the renderer shows for that respondent", () => {
  const def = survey(false);
  const rows = (def.designs[0].file!.rows as Record<string, unknown>[]);
  const seen = new Set<string>();
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const state = createResponseState(def, { seed });
    state.answers.q1 = { "1": { best: "2", worst: "3" }, "2": { best: "3", worst: "4" } };
    const row = parseCsv(responsesToCSV(def, [state]))[0];
    for (const t of ["1", "2"]) {
      const shown = shuffleAlternatives(rows.filter((r) => String(r.task) === t), seed, `q1:${t}`)
        .map((r) => String(r.item_index)).join("|");
      assert.equal(row[`MD_T${t}_ORDER`], shown, `seed ${seed} task ${t}`);
      seen.add(row[`MD_T${t}_ORDER`]);
    }
  }
  // respondents see different orders, which is why the design's own `position` was not enough
  assert.ok(seen.size > 2, [...seen].join(" / "));
});
