import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { designRowsFor, mulberry32 } from "@rescript/engine";
import { type AnalyticsRow } from "../dataset.js";
import { runAnalysis } from "./index.js";
import { buildDataset } from "../dataset.js";
import type { AnalysisDefinition } from "../types.js";

/**
 * MD-P1: THE MAXDIFF ESTIMATOR RECOVERS KNOWN UTILITIES — numbers, not ranks.
 *
 * The analysis has always fitted an aggregate conditional logit (sequential
 * best-worst: best from the set, worst from the rest with reversed sign,
 * Newton–Raphson). Earlier tests checked the ORDER it recovers. These check
 * the MAGNITUDES: respondents are simulated from planted utilities under the
 * same model, and the zero-centred estimates must land within tolerance of
 * the truth. They also pin the two MD-P1 behaviours of the runner: practice
 * tasks are not modelled, and a best-only design is estimated from best
 * choices alone.
 */

const ITEMS = ["Battery", "Camera", "Screen", "Price", "Weight", "Design", "Colour", "Brand"];
/* planted utilities, already zero-centred (they sum to 0) */
const TRUE_U = [1.6, 1.0, 0.5, 0.1, -0.3, -0.7, -1.0, -1.2];

/** three versions × 8 tasks × 4 items; every item 4 times per version (a cyclic construction) */
function designRows(practice = false): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let v = 1; v <= 3; v++) {
    if (practice) {
      [1, 2, 3, 4].forEach((itemIndex, pos) => out.push({ version: v, task: 0, position: pos + 1, item_index: itemIndex, item_label: ITEMS[itemIndex - 1], practice: 1 }));
    }
    for (let t = 1; t <= 8; t++) {
      const set = [0, 1, 2, 3].map((k) => ((t - 1 + k * (v === 2 ? 3 : v === 3 ? 5 : 1)) % 8) + 1);
      const distinct = [...new Set(set)];
      for (let x = 1; distinct.length < 4; x++) if (!distinct.includes(x)) distinct.push(x);
      distinct.forEach((itemIndex, pos) => out.push({ version: v, task: t, position: pos + 1, item_index: itemIndex, item_label: ITEMS[itemIndex - 1], ...(practice ? { practice: 0 } : {}) }));
    }
  }
  return out;
}

function survey(rows: Record<string, unknown>[], config: Record<string, unknown> = {}) {
  const columns = Object.keys(rows[0]);
  return SurveyDefinition.parse({
    meta: { id: "mdr", code: "MDR", title: "MaxDiff recovery", version: "1.0" },
    designs: [{ id: "d_md", kind: "maxdiff", name: "MD", config: { items: ITEMS, itemsPerTask: 4, versions: 3, ...config }, file: { format: "json", columns, rows } }],
    questions: [{ id: "q_md", code: "Q1", variableName: "MD", type: "maxdiff_task", text: "Best/worst", settings: { designRef: "d_md" } }],
    flow: [{ type: "page", id: "p1", questionIds: ["q_md"] }],
  });
}

const gumbel = (r: () => number) => -Math.log(-Math.log(Math.max(r(), 1e-12)));

/** simulate under the sequential best-worst logit; `practicePick` answers the practice task against the truth on purpose */
function respondents(def: SurveyDefinition, n: number, seed: number, opts: { bestOnly?: boolean; practiceBest?: string } = {}): AnalyticsRow[] {
  const r = mulberry32(seed);
  const q = def.questions[0];
  const design = def.designs[0].file!.rows as Record<string, unknown>[];
  const out: AnalyticsRow[] = [];
  for (let i = 0; i < n; i++) {
    const respondentSeed = 5000 + i;
    const shown = designRowsFor(q, design, respondentSeed);
    const ans: Record<string, { best: string; worst?: string }> = {};
    for (const t of [...new Set(shown.map((x) => String(x.task)))]) {
      const alts = shown.filter((x) => String(x.task) === t);
      if (Number(alts[0].practice) === 1 && opts.practiceBest) {
        ans[t] = { best: opts.practiceBest, worst: String(alts.find((a) => String(a.item_index) !== opts.practiceBest)!.item_index) };
        continue;
      }
      const u = alts.map((a) => TRUE_U[Number(a.item_index) - 1] + gumbel(r));
      const bi = u.indexOf(Math.max(...u));
      const best = String(alts[bi].item_index);
      if (opts.bestOnly) { ans[t] = { best }; continue; }
      const rest = alts.map((_, k) => k).filter((k) => k !== bi);
      const uw = rest.map((k) => -TRUE_U[Number(alts[k].item_index) - 1] + gumbel(r));
      ans[t] = { best, worst: String(alts[rest[uw.indexOf(Math.max(...uw))]].item_index) };
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

const D: AnalysisDefinition = { name: "maxdiff", kind: "maxdiff", dataset: { environment: "LIVE", dataset: "all" }, variables: ["MD"] };
const utilities = (res: ReturnType<typeof runAnalysis>) => {
  const rows = res.tables.find((t) => t.id === "maxdiff")!.rows as { item: string; utility: number }[];
  return ITEMS.map((it) => Number(rows.find((x) => x.item === it)!.utility));
};
const fit = (res: ReturnType<typeof runAnalysis>, m: string) => res.tables.find((t) => t.id === "fit")!.rows.find((x) => x.m === m)!.v;
const corr = (a: number[], b: number[]) => {
  const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db);
};

test("best-worst: the logit recovers the planted utilities within ±0.15 (1,500 respondents × 8 tasks)", () => {
  const def = survey(designRows());
  const res = runAnalysis(D, buildDataset(def, respondents(def, 1500, 11), { spec: D.dataset }));
  const u = utilities(res);
  const worst = Math.max(...u.map((x, i) => Math.abs(x - TRUE_U[i])));
  assert.ok(worst < 0.15, `max |estimate − truth| = ${worst.toFixed(3)}; estimates ${u.map((x) => x.toFixed(2)).join(", ")}`);
  assert.ok(corr(u, TRUE_U) > 0.995);
  assert.equal(fit(res, "Converged"), "yes");
  /* sequential best-worst: one best set and one worst set per task */
  assert.equal(fit(res, "Choices modelled"), 1500 * 8 * 2);
});

test("the descriptive B−W count is labelled as a count, not as the model", () => {
  const def = survey(designRows());
  const res = runAnalysis(D, buildDataset(def, respondents(def, 200, 3), { spec: D.dataset }));
  const table = res.tables.find((t) => t.id === "maxdiff")!;
  assert.ok(table.columns.some((c) => c.key === "bw" && /B−W score/.test(c.label)));
  assert.ok(table.columns.some((c) => c.key === "utility" && /Logit utility/.test(c.label)));
  const notes = (table.notes ?? []).join(" ");
  assert.match(notes, /descriptive COUNT/);
  assert.match(notes, /not a model estimate/);
  assert.match(notes, /individual-level \(HB\) utilities are not estimated/);
});

test("best-only: estimated from best choices alone, and still recovers the truth", () => {
  const def = survey(designRows(), { responseMode: "best_only" });
  const res = runAnalysis(D, buildDataset(def, respondents(def, 2500, 21, { bestOnly: true }), { spec: D.dataset }));
  const u = utilities(res);
  const worst = Math.max(...u.map((x, i) => Math.abs(x - TRUE_U[i])));
  assert.ok(worst < 0.2, `max |estimate − truth| = ${worst.toFixed(3)}`);
  assert.equal(fit(res, "Choices modelled"), 2500 * 8, "one choice per task — there is no worst stage");
  const notes = (res.tables.find((t) => t.id === "maxdiff")!.notes ?? []).join(" ");
  assert.match(notes, /on the best choices/);
});

test("a practice task is answered but never modelled", () => {
  const def = survey(designRows(true), { practiceTask: true });
  /* every respondent picks Price (item 4) as best in the practice task; were that modelled, Price would be inflated */
  const res = runAnalysis(D, buildDataset(def, respondents(def, 800, 7, { practiceBest: "4" }), { spec: D.dataset }));
  assert.equal(fit(res, "Choices modelled"), 800 * 8 * 2, "practice choices are not in the model");
  const u = utilities(res);
  assert.ok(Math.abs(u[3] - TRUE_U[3]) < 0.2, `Price stays near its true utility (${u[3].toFixed(2)} vs ${TRUE_U[3]})`);
});
