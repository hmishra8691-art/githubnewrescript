import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { SurveyDefinition } from "@rescript/schema";
import { buildVariableDictionary, createResponseState, designVersionFor, flattenVariables, shuffleAlternatives } from "@rescript/engine";
import { maxdiffChoiceRows, maxdiffChoiceCSV, MAXDIFF_LONG_COLUMNS, responsesToCSV, exportResponsesXlsx } from "./index.js";

/**
 * MD-P1: what a MaxDiff answer looks like once it leaves the platform.
 *
 *   long choice file   one row per respondent × task × item shown, with the
 *                      version, the on-screen position, best / worst flags
 *   wide export        best-only has no worst column; a practice task is
 *                      labelled; item indices carry their labels
 *   xlsx               the version is the seed's, not "1" for everyone
 */

const ITEMS = ["Battery", "Camera", "Screen", "Price", "Weight", "Design"];

/** three versions × 2 tasks × 3 items (+ optional practice task 0) */
function rows(practice = false) {
  const out: Record<string, unknown>[] = [];
  for (let v = 1; v <= 3; v++) {
    if (practice) [1, 2, 3].forEach((i, p) => out.push({ version: v, task: 0, position: p + 1, item_index: i, item_label: ITEMS[i - 1], practice: 1 }));
    for (let t = 1; t <= 2; t++) {
      const set = [0, 1, 2].map((k) => ((v + t * 2 + k) % 6) + 1);
      set.forEach((i, p) => out.push({ version: v, task: t, position: p + 1, item_index: i, item_label: ITEMS[i - 1], ...(practice ? { practice: 0 } : {}) }));
    }
  }
  return out;
}

function survey(config: Record<string, unknown> = {}, practice = false) {
  const r = rows(practice);
  return SurveyDefinition.parse({
    meta: { id: "ml", code: "ML", title: "MaxDiff long", version: "1.0" },
    designs: [{ id: "d1", kind: "maxdiff", name: "MD", version: 1, config: { items: ITEMS, ...config }, file: { columns: Object.keys(r[0]), rows: r } }],
    questions: [{ id: "q1", code: "Q1", variableName: "MD", type: "maxdiff_task", text: "Choose", required: true, settings: { designRef: "d1" } }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
  });
}

/** answer every task of the respondent's version: best = first shown, worst = last shown */
function answered(def: SurveyDefinition, seed: number, bestOnly = false) {
  const state = createResponseState(def, { seed, sessionId: `s${seed}` });
  state.respondentId = `R${seed}`;
  const all = def.designs[0].file!.rows as Record<string, unknown>[];
  const version = designVersionFor(def.questions[0], all, seed);
  const mine = all.filter((r) => String(r.version) === version);
  const ans: Record<string, { best: string; worst?: string }> = {};
  for (const t of [...new Set(mine.map((r) => String(r.task)))]) {
    const shown = shuffleAlternatives(mine.filter((r) => String(r.task) === t), seed, `q1:${t}`);
    ans[t] = bestOnly ? { best: String(shown[0].item_index) } : { best: String(shown[0].item_index), worst: String(shown[shown.length - 1].item_index) };
  }
  state.answers.q1 = ans;
  return { state, version };
}

test("long file: one row per item shown, with version, task, on-screen position and best/worst flags", () => {
  const def = survey();
  const seeds = [3, 8, 21, 34, 55];
  const states = seeds.map((s) => answered(def, s));
  const { columns, rows: out, skipped } = maxdiffChoiceRows(def, states.map((x) => x.state));
  assert.deepEqual([...columns], [...MAXDIFF_LONG_COLUMNS]);
  assert.deepEqual(skipped, []);
  assert.equal(out.length, seeds.length * 2 * 3, "5 respondents × 2 tasks × 3 items");
  for (const [i, s] of seeds.entries()) {
    const mine = out.filter((r) => r.SESSION_ID === `s${s}`);
    assert.ok(mine.every((r) => r.VERSION === states[i].version && r.RESP_ID === `R${s}` && r.QUESTION === "MD" && r.QUESTION_ID === "q1"));
    /* the wide export's version is the same one */
    assert.equal(flattenVariables(def, states[i].state).MD_VERSION, states[i].version);
    for (const t of ["1", "2"]) {
      const task = mine.filter((r) => r.TASK === t);
      assert.deepEqual(task.map((r) => r.POSITION), [1, 2, 3]);
      assert.equal(task.filter((r) => r.BEST === 1).length, 1);
      assert.equal(task.filter((r) => r.WORST === 1).length, 1);
      assert.equal(task[0].BEST, 1, "the first item on screen was picked best");
      assert.equal(task[2].WORST, 1, "the last item on screen was picked worst");
      /* and the order is the one the wide export's _ORDER column records */
      assert.equal(task.map((r) => r.ITEM_INDEX).join("|"), flattenVariables(def, states[i].state)[`MD_T${t}_ORDER`]);
      assert.ok(task.every((r) => r.ITEM_LABEL === ITEMS[Number(r.ITEM_INDEX) - 1]));
    }
  }
  /* across five respondents more than one version is used */
  assert.ok(new Set(out.map((r) => r.VERSION)).size > 1);
});

test("long file: practice rows are flagged, best-only leaves WORST empty, a response without a seed is skipped and said so", () => {
  const prac = survey({ practiceTask: true }, true);
  const { state } = answered(prac, 13);
  const out = maxdiffChoiceRows(prac, [state]).rows;
  assert.equal(out.filter((r) => r.TASK === "0").length, 3);
  assert.ok(out.filter((r) => r.TASK === "0").every((r) => r.PRACTICE === 1));
  assert.ok(out.filter((r) => r.TASK !== "0").every((r) => r.PRACTICE === 0));

  const bo = survey({ responseMode: "best_only" });
  const one = maxdiffChoiceRows(bo, [answered(bo, 5, true).state]).rows;
  assert.ok(one.every((r) => r.WORST === ""));
  assert.equal(one.filter((r) => r.BEST === 1).length, 2);

  const noSeed = { ...answered(bo, 5, true).state, seed: undefined as unknown as number };
  const res = maxdiffChoiceRows(bo, [noSeed]);
  assert.equal(res.rows.length, 0);
  assert.match(res.skipped[0].reason, /no response seed/);
});

test("long CSV has the header and one line per row", () => {
  const def = survey();
  const csv = maxdiffChoiceCSV(def, [answered(def, 3).state]);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], MAXDIFF_LONG_COLUMNS.join(","));
  assert.equal(lines.length, 1 + 6);
});

test("wide export: best-only declares no WORST, a practice task is labelled, BEST carries item labels", () => {
  const bo = survey({ responseMode: "best_only" });
  const header = responsesToCSV(bo, [answered(bo, 5, true).state]).split("\n")[0].split(",");
  assert.ok(header.includes("MD_T1_BEST"));
  assert.ok(!header.some((h) => h.endsWith("_WORST")), header.join(","));

  const prac = survey({ practiceTask: true }, true);
  const dict = buildVariableDictionary(prac);
  const t0 = dict.find((v) => v.name === "MD_T0_BEST")!;
  assert.match(t0.label, /practice task \(not analysed\)/);
  const t1 = dict.find((v) => v.name === "MD_T1_BEST")!;
  assert.equal(t1.valueLabels["2"], "Camera");
  assert.deepEqual(t1.valueCodes, [1, 2, 3, 4, 5, 6]);
});

test("xlsx: the MaxDiff version comes from the response's seed (the route used to drop it, so every row said 1)", async () => {
  const def = survey();
  const picks = [3, 8, 21, 34, 55].map((s) => answered(def, s));
  const buf = await exportResponsesXlsx(def, picks.map((p) => ({ state: p.state, quality: null, review: { status: null } })));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const sheet = wb.getWorksheet("Main Data")!;
  const head = (sheet.getRow(1).values as unknown[]).map(String);
  const col = head.indexOf("MD_VERSION");
  assert.ok(col > 0, head.join(","));
  const got = picks.map((_, i) => String(sheet.getRow(i + 2).getCell(col).value));
  assert.deepEqual(got, picks.map((p) => p.version));
  assert.ok(new Set(got).size > 1);
});
