import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { designRowsFor, designVersionFor, mulberry32 } from "@rescript/engine";
import { buildDataset, type AnalyticsRow } from "../dataset.js";
import { runAnalysis } from "./index.js";
import type { AnalysisDefinition } from "../types.js";

/**
 * MAXDIFF ON A MULTI-VERSION DESIGN, AND ON DIRTY ANSWERS.
 *
 * METHOD-02: the runner read `answers[<qid>_version]`, which nothing writes,
 * and fell through to version 1 for everyone — so respondents of versions
 * 2..N were scored against item sets they never saw. On a four-version design
 * about a quarter of all choices vanished and the rest were attributed to the
 * wrong competitors. The runner now resolves the version the way the conjoint
 * runner does, through `<VAR>_VERSION`, which flatten derives from the seed.
 *
 * METHOD-03: one task answered with the same item as best and worst produced
 * a choice set with `chosen: -1`, the logit threw, and the whole study came
 * back "not computable". Such tasks are skipped, counted and reported.
 */

const ITEMS = ["Battery", "Camera", "Screen", "Price", "Weight", "Design", "Colour", "Brand"];
/* planted utilities, in a deliberately non-alphabetical order */
const TRUE_U = [1.6, 1.0, 0.5, 0.1, -0.3, -0.7, -1.0, -1.2];

/**
 * Four versions of 6 tasks × 4 items; every version is a different cyclic
 * block of the 8 items, so no two versions share a task's set.
 */
function designRows(versions = 4): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let v = 1; v <= versions; v++) {
    for (let t = 1; t <= 6; t++) {
      const start = (v * 3 + t * 5) % 8;
      const set = [0, 1, 2, 3].map((k) => ((start + k * (v + 1)) % 8) + 1);
      /* a cyclic step that lands on a repeat is nudged apart, so each task holds 4 distinct items */
      const distinct = [...new Set(set)];
      while (distinct.length < 4) distinct.push(((distinct[distinct.length - 1] + 2) % 8) + 1);
      distinct.slice(0, 4).forEach((itemIndex, pos) => out.push({ version: v, task: t, position: pos + 1, item_index: itemIndex, item_label: ITEMS[itemIndex - 1] }));
    }
  }
  return out;
}

const DESIGN_COLUMNS = ["version", "task", "position", "item_index", "item_label"];

function survey(rows: Record<string, unknown>[]) {
  return SurveyDefinition.parse({
    meta: { id: "mdv", code: "MDV", title: "Versioned MaxDiff", version: "1.0" },
    designs: [{ id: "d_md", kind: "maxdiff", name: "MD", config: { items: ITEMS, itemsPerTask: 4, versions: 4 }, file: { format: "json", columns: DESIGN_COLUMNS, rows } }],
    questions: [{ id: "q_md", code: "Q1", variableName: "MD", type: "maxdiff_task", text: "Best/worst", settings: { designRef: "d_md" } }],
    flow: [{ type: "page", id: "p1", questionIds: ["q_md"] }],
  });
}

const gumbel = (r: () => number) => -Math.log(-Math.log(Math.max(r(), 1e-9)));

/**
 * Each respondent answers THE VERSION THEIR SEED GIVES THEM — the rows the
 * renderer would have shown — so a runner that reads version 1 for everyone
 * is wrong about most of them.
 */
function rowsFor(def: SurveyDefinition, n: number, seed: number, poison: (i: number, task: string) => boolean = () => false): AnalyticsRow[] {
  const r = mulberry32(seed);
  const q = def.questions[0];
  const design = def.designs[0].file!.rows as Record<string, unknown>[];
  const out: AnalyticsRow[] = [];
  for (let i = 0; i < n; i++) {
    const respondentSeed = 1000 + i;
    const shown = designRowsFor(q, design, respondentSeed);
    const tasks = [...new Set(shown.map((x) => String(x.task)))];
    const ans: Record<string, { best: string; worst: string }> = {};
    for (const t of tasks) {
      const alts = shown.filter((x) => String(x.task) === t);
      const u = alts.map((a) => TRUE_U[Number(a.item_index) - 1] + gumbel(r));
      const bi = u.indexOf(Math.max(...u));
      const rest = alts.map((_, k) => k).filter((k) => k !== bi);
      const uw = rest.map((k) => -TRUE_U[Number(alts[k].item_index) - 1] + gumbel(r));
      const wi = rest[uw.indexOf(Math.max(...uw))];
      const best = String(alts[bi].item_index);
      ans[t] = poison(i, t) ? { best, worst: best } : { best, worst: String(alts[wi].item_index) };
    }
    out.push({
      id: `r${i}`, session_id: `s${i}`, respondent_code: `LIVE_${i}`, status: "complete", seed: respondentSeed,
      is_test: false, started_at: "2026-06-01T10:00:00.000Z", completed_at: "2026-06-01T10:07:00.000Z",
      quality: { classification: "CLEAN", qualityScore: 90, riskScore: 5 },
      answers: { q_md: ans }, calculated: {}, embedded: {}, flags: [],
    } as AnalyticsRow);
  }
  return out;
}

const spec = { environment: "LIVE" as const, dataset: "all" as const };
const D: AnalysisDefinition = { name: "maxdiff", kind: "maxdiff", dataset: spec, variables: ["MD"] };
const fitRow = (r: ReturnType<typeof runAnalysis>, m: string) => r.tables.find((t) => t.id === "fit")!.rows.find((x) => x.m === m)!.v;

test("the synthetic sample really spans all four versions", () => {
  const def = survey(designRows());
  const rows = def.designs[0].file!.rows as Record<string, unknown>[];
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) seen.add(designVersionFor(def.questions[0], rows, 1000 + i));
  assert.equal(seen.size, 4);
});

test("METHOD-02: a four-version MaxDiff models every answered choice and recovers the planted order", () => {
  const def = survey(designRows());
  const n = 600;
  const ds = buildDataset(def, rowsFor(def, n, 11), { spec });
  const r = runAnalysis(D, ds);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  /* every respondent answers 6 tasks, each a best and a worst — nothing is dropped for being "not in version 1's set" */
  assert.equal(fitRow(r, "Choices modelled"), n * 6 * 2);
  assert.equal(fitRow(r, "Respondents"), n);
  const order = r.tables[0].rows.map((x) => String(x.item));
  assert.deepEqual(order, ITEMS, `planted order not recovered: ${order.join(" > ")}`);
  /* utilities within ±0.15 of the planted ones (zero-centred, as the planted scale is near enough) */
  const mean = TRUE_U.reduce((t, v) => t + v, 0) / TRUE_U.length;
  for (const row of r.tables[0].rows) {
    const planted = TRUE_U[ITEMS.indexOf(String(row.item))] - mean;
    assert.ok(Math.abs(Number(row.utility) - planted) < 0.15, `${row.item}: got ${row.utility}, planted ${planted.toFixed(3)}`);
  }
  assert.ok(!r.warnings.some((w) => /ignored/.test(w)), r.warnings.join(" | "));
});

test("METHOD-03: best == worst on a few tasks is skipped and reported, not fatal", () => {
  const def = survey(designRows());
  const n = 400;
  /* three respondents each spoil one task */
  const poisoned = new Set(["7:1", "42:3", "99:6"]);
  const ds = buildDataset(def, rowsFor(def, n, 11, (i, t) => poisoned.has(`${i}:${t}`)), { spec });
  const r = runAnalysis(D, ds);
  assert.equal(r.error, undefined, `the analysis must not be "not computable": ${JSON.stringify(r.error)}`);
  assert.equal(r.tables[0].rows.length, ITEMS.length, "utilities for every item");
  assert.equal(fitRow(r, "Choices modelled"), (n * 6 - 3) * 2, "the three spoiled tasks contribute nothing");
  assert.ok(r.warnings.includes("3 tasks ignored: best and worst were the same item."), r.warnings.join(" | "));
  const order = r.tables[0].rows.map((x) => String(x.item));
  assert.equal(order[0], "Battery");
  assert.equal(order[order.length - 1], "Brand");
});

test("METHOD-03: a single spoiled task reads in the singular, and an out-of-set code is reported separately", () => {
  const def = survey(designRows());
  const rows = rowsFor(def, 200, 5, (i, t) => i === 3 && t === "2");
  /* respondent 10 answers task 4 with an item that is in the study but not in that task's set */
  const ans10 = (rows[10].answers as Record<string, Record<string, { best: string; worst: string }>>).q_md;
  const shown = new Set(designRowsFor(def.questions[0], def.designs[0].file!.rows as Record<string, unknown>[], 1010).filter((x) => String(x.task) === "4").map((x) => String(x.item_index)));
  const outside = ITEMS.map((_, k) => String(k + 1)).find((code) => !shown.has(code))!;
  ans10["4"] = { best: outside, worst: ans10["4"].worst };
  const r = runAnalysis(D, buildDataset(def, rows, { spec }));
  assert.equal(r.error, undefined);
  assert.ok(r.warnings.includes("1 task ignored: best and worst were the same item."), r.warnings.join(" | "));
  assert.ok(r.warnings.includes("1 task ignored: the best or worst was not an item of that task."), r.warnings.join(" | "));
  assert.equal(fitRow(r, "Choices modelled"), (200 * 6 - 2) * 2);
});
