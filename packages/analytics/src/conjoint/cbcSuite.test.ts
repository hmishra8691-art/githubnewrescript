import { test } from "node:test";
import assert from "node:assert/strict";
import { cbcStudy, MU, ATTRS, spec } from "./fixture.js";
import { runAnalysis } from "../analyses/index.js";
import { stackedChoiceData, flattenVariables } from "@rescript/engine";

/**
 * DUAL-RESPONSE NONE and BRAND-SPECIFIC / LABELLED CBC — recovery on real generated designs.
 *
 * Dual response: respondents make a forced choice (Gumbel), then say whether they would buy the
 * chosen concept — a binary logit of that concept against None, which is exactly Sawtooth's
 * "dual" coding. Measured at 800 × 12, no heterogeneity: part-worths within 0.025, None −0.394
 * (truth −0.4). The one-task coding ("None chosen when they would not buy") is a different model
 * and is BIASED when the truth is two-stage (measured: part-worths off by up to 0.4, None +0.74) —
 * offered because some teams use it, and the doc says so. With heterogeneity the aggregate None
 * is biased downward (the forced choice selects concepts the respondent likes more than the
 * pooled model knows): measured −0.50 at heterogeneity 0.2 — HB is the remedy.
 */
const C = (options: Record<string, unknown> = {}) => ({ name: "conjoint", kind: "conjoint" as const, dataset: spec, variables: ["CBC"], options });
const maxErr = (rows: Record<string, unknown>[], attrs = ATTRS, mu = MU) => { let e = 0; for (const a of attrs) a.levels.forEach((l, k) => { const row = rows.find((x) => x.attribute === a.name && x.level === l)!; e = Math.max(e, Math.abs((row.utility as number) - mu[a.name][k])); }); return e; };

test("dual-response None: the dual coding recovers the part-worths and the None constant; forced-only drops None; the one-task coding runs and is labelled", () => {
  const s = cbcStudy({ n: 800, dual: true, het: 0 });
  const dual = runAnalysis(C(), s.ds);
  assert.equal(dual.error, undefined, JSON.stringify(dual.warnings));
  const e = maxErr(dual.tables.find((t) => t.id === "partworths")!.rows);
  assert.ok(e < 0.08, `max |u − μ| = ${e.toFixed(3)}`);
  const none = dual.tables.find((t) => t.id === "simulation")!.rows.find((x) => x.profile === "None")!.utility as number;
  assert.ok(Math.abs(none - -0.4) < 0.08, `None ${none} vs −0.4`);
  const fit = dual.tables.find((t) => t.id === "fit")!;
  assert.match(String(fit.rows.find((x) => x.m === "Model")!.v), /forced choice plus a buy \/ no-buy task/);
  const noneRate = fit.rows.find((x) => x.m === "“None” chosen")!.v as string;
  const truthNo = s.rows.reduce((t, r) => t + Object.entries(r.answers!.q_cbc as Record<string, string>).filter(([k, v]) => k.endsWith("_buy") && v === "no").length, 0) / (800 * 12);
  assert.equal(noneRate, `${(truthNo * 100).toFixed(1)}%`, "None share = the “would not buy” answers");
  const forced = runAnalysis(C({ dualCoding: "forced" }), s.ds);
  assert.ok(maxErr(forced.tables.find((t) => t.id === "partworths")!.rows) < 0.08);
  assert.ok(!forced.tables.find((t) => t.id === "simulation")!.rows.some((x) => x.profile === "None"), "no None without a None parameter");
  const single = runAnalysis(C({ dualCoding: "single_none" }), s.ds);
  assert.match(String(single.tables.find((t) => t.id === "fit")!.rows.find((x) => x.m === "Model")!.v), /one task with None chosen when they would not buy/);
  console.log(`  dual-response: max |u−μ| = ${e.toFixed(3)}, None ${none} (truth −0.4)`);
});

test("dual-response HB runs on the dual coding; the exports carry the follow-up (VAR_T<n>_BUY, the stacked file's buy column)", { timeout: 120_000 }, () => {
  const s = cbcStudy({ n: 120, dual: true, het: 0.5, tasks: 12 });
  const r = runAnalysis({ name: "hb", kind: "hb", dataset: spec, variables: ["CBC"], options: { burnIn: 1500, draws: 1000, seed: 2, timeBudgetMs: 600_000 } }, s.ds);
  assert.ok(r.tables.some((t) => t.id === "hb_diagnostics"));
  assert.ok(r.tables.find((t) => t.id === "hb_diagnostics")!.rows.some((x) => /None constant/.test(String(x.v))), "the HB model has the None constant from the dual coding");
  const flat = flattenVariables(s.def, { answers: s.rows[0].answers, seed: s.rows[0].seed as number, calculated: {}, embedded: {} } as never);
  assert.ok(flat.CBC_T1_BUY === 0 || flat.CBC_T1_BUY === 1, JSON.stringify(flat));
  assert.equal(flat.CBC_T1_buy, undefined, "the follow-up is not mistaken for a task");
  const st = stackedChoiceData(s.def, s.rows.slice(0, 3).map((x) => ({ sessionId: String(x.session_id), seed: x.seed as number, answers: x.answers as Record<string, unknown> })));
  assert.ok(st.columns.includes("buy"));
  const t1 = st.rows.filter((x) => x.session_id === "s0" && x.task === 1);
  assert.equal(t1.length, 3, "three forced-choice concepts, no None row");
  assert.ok(t1.every((x) => x.buy === flat.CBC_T1_BUY));
});

test("brand-specific attributes: a 5G attribute only Alpha and Beta carry is shown as — elsewhere, coded as zeros, and recovered", () => {
  const s = cbcStudy({ n: 700, altSpecific: true, het: 0.1 });
  const gamma = s.design.rows.filter((r) => r.Brand === "Gamma");
  assert.ok(gamma.length > 0 && gamma.every((r) => r["5G"] === ""), "Gamma never carries 5G");
  assert.ok(s.design.rows.filter((r) => r.Brand === "Alpha" && Number(r.none_option) !== 1).every((r) => r["5G"] === "Yes" || r["5G"] === "No"));
  const r = runAnalysis(C(), s.ds);
  const pw = r.tables.find((t) => t.id === "partworths")!;
  assert.deepEqual(pw.rows.filter((x) => x.attribute === "5G").map((x) => x.level), ["No", "Yes"], "the blank is not a level");
  const e = maxErr(pw.rows, s.attrs, s.mu);
  assert.ok(e < 0.12, `max |u − μ| = ${e.toFixed(3)}`);
  const st = stackedChoiceData(s.def, s.rows.slice(0, 5).map((x) => ({ sessionId: String(x.session_id), seed: x.seed as number, answers: x.answers as Record<string, unknown> })));
  for (const row of st.rows.filter((x) => x.Brand === "Gamma")) assert.equal(row["5G_code"], 0);
  console.log(`  brand-specific: max |u−μ| = ${e.toFixed(3)}`);
});

test("labelled design: each brand once per task in brand order; the model and simulator run", () => {
  const s = cbcStudy({ n: 300, labelled: true, het: 0.1 });
  for (const t of new Set(s.design.rows.map((r) => `${r.version}:${r.task}`))) {
    const alts = s.design.rows.filter((r) => `${r.version}:${r.task}` === t && Number(r.none_option) !== 1).sort((a, b) => Number(a.alt) - Number(b.alt));
    assert.deepEqual(alts.map((a) => a.Brand), ["Alpha", "Beta", "Gamma"]);
  }
  const r = runAnalysis(C({ simulator: { products: [{ name: "Alpha phone", levels: { Brand: "Alpha", Screen: "6in", Battery: "2 days", Price: "$299" } }, { name: "Beta phone", levels: { Brand: "Beta", Screen: "6in", Battery: "2 days", Price: "$249" } }], rule: "rfc" } }), s.ds);
  assert.ok(maxErr(r.tables.find((t) => t.id === "partworths")!.rows) < 0.15);
  const sim = r.tables.find((t) => t.id === "sim_shares")!;
  assert.match(sim.title, /randomized first choice/);
  assert.equal(sim.rows[1].product, "Beta phone", "a price between the tested levels ($249) is interpolated, not extrapolated");
  assert.equal(sim.rows[1].price, 249);
});
