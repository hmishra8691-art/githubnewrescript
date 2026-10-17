import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { conjointPlugin } from "@rescript/designs";
import { mulberry32, designVersionFor } from "@rescript/engine";
import { buildDataset, type AnalyticsRow } from "../dataset.js";
import { runAnalysis } from "./index.js";
import { logitShares } from "../stats/choice.js";
import type { AnalysisDefinition } from "../types.js";

/**
 * CONJOINT AUDIT 2026-10-17 — the estimator recovers what it is given.
 *
 * Respondents are simulated from KNOWN part-worths (Gumbel errors, so the
 * multinomial logit is the true model) on a multi-version efficient design
 * with a None option; each answer is the design alternative chosen, exactly
 * as the renderer stores it, and each respondent's version comes from their
 * seed. The aggregate MNL must give the part-worths back within sampling
 * error, the importances from the part-worth ranges, the None constant, and a
 * share simulation that matches the true logit shares. Counts are reported
 * and labelled as counts.
 */

const TRUE: Record<string, Record<string, number>> = {
  Brand: { Alpha: 0.5, Beta: 0, Gamma: -0.5 },
  Screen: { "5in": -0.3, "6in": 0.1, "7in": 0.2 },
  Battery: { "1 day": -0.6, "2 days": 0.1, "3 days": 0.5 },
  Price: { "$199": 1.0, "$299": 0.1, "$399": -1.1 },
};
const NONE_U = -0.8;
const attributes = Object.entries(TRUE).map(([name, l]) => ({ name, levels: Object.keys(l) }));
const config = { attributes, tasks: 12, alternativesPerTask: 3, noneOption: true, versions: 6, method: "efficient" as const };
const design = conjointPlugin.generate(config, 2026);

const def = SurveyDefinition.parse({
  meta: { id: "rec", code: "REC", title: "Recovery", version: "1.0" },
  designs: [
    { id: "d_cbc", kind: "conjoint", name: "CBC", version: 1, config, file: { format: "json", columns: design.columns, rows: design.rows } },
    { id: "d_menu", kind: "menu", name: "Menu", version: 1, config: { noneOption: true }, file: { format: "json", columns: ["version", "task", "item", "item_label", "price", "price_index", "price_value", "required"], rows: [
      { version: 1, task: 1, item: 1, item_label: "Base", price: "$10", price_index: 1, price_value: 10, required: 1 },
      { version: 1, task: 1, item: 2, item_label: "Extra", price: "$2", price_index: 1, price_value: 2, required: 0 },
      { version: 1, task: 2, item: 1, item_label: "Base", price: "$12", price_index: 2, price_value: 12, required: 1 },
      { version: 1, task: 2, item: 2, item_label: "Extra", price: "$4", price_index: 2, price_value: 4, required: 0 },
    ] } },
    { id: "d_acbc", kind: "acbc", name: "ACBC", version: 1, config: { attributes }, file: { format: "json", columns: ["stage"], rows: [{ stage: "byo" }] } },
  ],
  questions: [
    { id: "q_cbc", code: "Q1", variableName: "CBC", type: "conjoint_task", text: "Choose", settings: { designRef: "d_cbc" } },
    { id: "q_menu", code: "Q2", variableName: "MENU", type: "conjoint_task", variant: "conjoint.menu", text: "Build", settings: { designRef: "d_menu" } },
    { id: "q_acbc", code: "Q3", variableName: "ACBC", type: "acbc_task", variant: "conjoint.acbc", text: "Adaptive", settings: { designRef: "d_acbc" } },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_cbc", "q_menu", "q_acbc"] }, { type: "end", id: "e1", status: "complete" }],
});

const gumbel = (r: () => number) => -Math.log(-Math.log(Math.max(r(), 1e-12)));
const utilityOf = (row: Record<string, unknown>) =>
  Number(row.none_option) === 1 ? NONE_U : attributes.reduce((t, a) => t + TRUE[a.name][String(row[a.name])], 0);

function respondents(n: number): AnalyticsRow[] {
  const r = mulberry32(99);
  const q = def.questions[0];
  const out: AnalyticsRow[] = [];
  for (let i = 0; i < n; i++) {
    const seed = Math.floor(r() * 2 ** 31);
    const version = designVersionFor(q, design.rows, seed);
    const answers: Record<string, string> = {};
    for (let t = 1; t <= config.tasks; t++) {
      const alts = design.rows.filter((x) => String(x.version) === version && x.task === t);
      const u = alts.map((a) => utilityOf(a) + gumbel(r));
      answers[String(t)] = String(alts[u.indexOf(Math.max(...u))].alt);
    }
    out.push({
      id: `r${i}`, session_id: `s${i}`, seed, status: "complete", is_test: false,
      started_at: "2026-10-01T10:00:00Z", completed_at: "2026-10-01T10:10:00Z",
      answers: { q_cbc: answers, q_menu: { "1": i % 3 === 0 ? ["none"] : i % 2 ? ["2"] : [], "2": i % 4 === 0 ? ["2"] : [] } },
      calculated: {}, embedded: {}, flags: [],
    } as AnalyticsRow);
  }
  return out;
}

const spec = { environment: "LIVE" as const, dataset: "all" as const };
const ds = buildDataset(def, respondents(900), { spec });
const D = (variables: string[]): AnalysisDefinition => ({ name: "conjoint", kind: "conjoint", dataset: spec, variables });

test("aggregate MNL recovers planted part-worths, the None constant and importances on a 6-version efficient design", () => {
  const r = runAnalysis(D(["CBC"]), ds);
  const pw = r.tables.find((t) => t.id === "partworths")!;
  assert.match(pw.title, /aggregate multinomial logit/i, "the model is named for what it is");
  for (const [attr, levels] of Object.entries(TRUE)) {
    for (const [level, truth] of Object.entries(levels)) {
      const est = pw.rows.find((x) => x.attribute === attr && x.level === level)!.utility as number;
      // planted values are zero-centred per attribute, which is what effects coding estimates
      const centred = truth - Object.values(levels).reduce((t, v) => t + v, 0) / 3;
      assert.ok(Math.abs(est - centred) < 0.1, `${attr}=${level}: estimated ${est}, planted ${centred.toFixed(3)}`);
    }
  }
  // the levels come back in the configured order, not first-appearance order
  assert.deepEqual(pw.rows.filter((x) => x.attribute === "Price").map((x) => x.level), ["$199", "$299", "$399"]);
  // importance = each attribute's part-worth range over the sum of ranges
  const ranges = Object.fromEntries(Object.entries(TRUE).map(([a, l]) => [a, Math.max(...Object.values(l)) - Math.min(...Object.values(l))]));
  const total = Object.values(ranges).reduce((t, v) => t + v, 0);
  const imp = r.tables.find((t) => t.id === "importance")!;
  assert.deepEqual(imp.rows.map((x) => x.attribute), ["Price", "Battery", "Brand", "Screen"]);
  for (const row of imp.rows) assert.ok(Math.abs((row.importance as number) - (100 * ranges[String(row.attribute)]) / total) < 3, `${row.attribute} importance ${row.importance}`);
  // the None constant, against the attributes' zero-centred scale
  const meanAttr = attributes.reduce((t, a) => t + Object.values(TRUE[a.name]).reduce((s, v) => s + v, 0) / 3, 0);
  const sim = r.tables.find((t) => t.id === "simulation")!;
  const noneU = sim.rows.find((x) => x.profile === "None")!.utility as number;
  assert.ok(Math.abs(noneU - (NONE_U - meanAttr)) < 0.12, `None constant ${noneU} vs ${(NONE_U - meanAttr).toFixed(3)}`);
  // share of preference: best profile, worst profile and None, against the true logit shares
  const best = { Brand: "Alpha", Screen: "7in", Battery: "3 days", Price: "$199" }, worst = { Brand: "Gamma", Screen: "5in", Battery: "1 day", Price: "$399" };
  const trueShares = logitShares([utilityOf(best), utilityOf(worst), NONE_U]);
  sim.rows.forEach((row, k) => assert.ok(Math.abs((row.share as number) - 100 * trueShares[k]) < 3, `${row.profile} share ${row.share} vs ${(100 * trueShares[k]).toFixed(1)}`));
  const fit = r.tables.find((t) => t.id === "fit")!;
  assert.equal(fit.rows.find((x) => x.m === "Converged")!.v, "yes");
  assert.equal(fit.rows.find((x) => x.m === "Choice tasks")!.v, 900 * 12);
  assert.match(String(fit.rows.find((x) => x.m === "Model")!.v), /Aggregate multinomial logit/);
});

test("raw counts are reported separately and labelled as counts, not utilities", () => {
  const r = runAnalysis(D(["CBC"]), ds);
  const counts = r.tables.find((t) => t.id === "counts")!;
  assert.match(counts.title, /raw, not a model/);
  const share = (l: string) => counts.rows.find((x) => x.level === l)!.share as number;
  assert.ok(share("$199") > share("$299") && share("$299") > share("$399"));
  const shown = counts.rows.filter((x) => x.attribute === "Price").reduce((t, x) => t + (x.shown as number), 0);
  assert.equal(shown, 900 * 12 * 3, "every concept of every answered task counted once per attribute");
  assert.equal(r.tables[0].id, "importance", "the model's tables keep their places");
  assert.equal(r.tables[1].id, "partworths");
});

test("a menu question gets take-rate counts, said to be counts; an ACBC question is refused in words, never swapped for another question", () => {
  const m = runAnalysis(D(["MENU"]), ds);
  const t = m.tables.find((x) => x.id === "menu_counts")!;
  assert.ok(t, JSON.stringify(m.warnings));
  assert.match(t.title, /counts, not a model/);
  assert.ok(m.warnings.some((w) => /no choice model is estimated/.test(w)));
  const extra = t.rows.find((x) => x.item === "Extra" && x.price === "$2")!;
  assert.equal(extra.shown, 900);
  const a = runAnalysis(D(["ACBC"]), ds);
  assert.equal(a.tables.length, 0);
  assert.ok(a.warnings.some((w) => /Adaptive CBC/.test(w) && /No ACBC estimator/.test(w)), JSON.stringify(a.warnings));
});
