import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { mulberry32 } from "@rescript/engine";
import { buildDataset, type AnalyticsRow } from "../dataset.js";
import { runAnalysis } from "./index.js";
import type { AnalysisDefinition } from "../types.js";

/**
 * ANCHORED MAXDIFF, WHERE IT ACTUALLY MATTERS (§17).
 *
 * A standard MaxDiff cannot answer "does any of this matter?". Its utilities
 * are relative by construction, so a list where nothing is important produces
 * exactly the same ranking as a list where everything is.
 *
 * These tests plant a population where that distinction is real — two items
 * people care about, four they do not — and check that the anchored analysis
 * recovers it while the standard analysis, correctly, cannot. That asymmetry
 * is the whole reason the variant exists, and it is the one property a
 * regression here would quietly destroy: an anchored study would still
 * produce plausible numbers, just meaningless ones.
 */

const ITEMS = ["Reliability", "Price", "Colour", "Packaging", "Advert", "Slogan"];
/*
 * True utilities against the respondent's own threshold. The first two are
 * above it, the rest below — so "importance" is not the same thing as
 * "rank", which is exactly the confusion anchoring resolves.
 */
const TRUE_U = [1.4, 0.7, -0.6, -0.9, -1.3, -1.8];

/** A small balanced design: 6 items, 4 per task, 6 tasks, one version. */
function designRows(): Record<string, unknown>[] {
  const sets = [
    [1, 2, 3, 4], [1, 2, 5, 6], [3, 4, 5, 6],
    [1, 3, 4, 5], [2, 3, 4, 6], [1, 2, 4, 5],
  ];
  const out: Record<string, unknown>[] = [];
  sets.forEach((set, t) => {
    set.forEach((itemIndex, pos) => {
      out.push({
        version: 1, task: t + 1, position: pos + 1,
        item_index: itemIndex, item_label: ITEMS[itemIndex - 1],
      });
    });
  });
  return out;
}

const DESIGN_COLUMNS = ["version", "task", "position", "item_index", "item_label"];

function survey(anchored: boolean) {
  return SurveyDefinition.parse({
    meta: { id: "mda", code: "MDA", title: "Anchored MaxDiff", version: "1.0" },
    designs: [{
      id: "d_md", kind: "maxdiff", name: "MD",
      config: anchored
        ? { items: ITEMS, itemsPerTask: 4, anchored: true, anchorPrompt: "How many of these are important to you?" }
        : { items: ITEMS, itemsPerTask: 4 },
      file: { format: "json", columns: DESIGN_COLUMNS, rows: designRows() },
    }],
    questions: [
      { id: "q_md", code: "Q1", variableName: "MD", type: "maxdiff_task", text: "Best/worst", settings: { designRef: "d_md" } },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q_md"] }],
  });
}

const gumbel = (r: () => number) => -Math.log(-Math.log(Math.max(r(), 1e-9)));

/**
 * A synthetic population.
 *
 * The anchor answers are DERIVED from the same true utilities that drive the
 * best/worst choices, which is what makes this a fair test rather than a
 * restatement: nothing tells the analysis which items are important except
 * the respondents' own answers.
 */
function rowsFor(n: number, seed: number, withAnchor: boolean): AnalyticsRow[] {
  const r = mulberry32(seed);
  const design = designRows();
  const tasks = [...new Set(design.map((x) => String(x.task)))];
  const out: AnalyticsRow[] = [];
  for (let i = 0; i < n; i++) {
    const ans: Record<string, { best: string; worst: string; anchor?: string }> = {};
    for (const t of tasks) {
      const alts = design.filter((x) => String(x.task) === t);
      const u = alts.map((a) => TRUE_U[Number(a.item_index) - 1] + gumbel(r));
      const bi = u.indexOf(Math.max(...u));
      const rest = alts.map((_, k) => k).filter((k) => k !== bi);
      const uw = rest.map((k) => -TRUE_U[Number(alts[k].item_index) - 1] + gumbel(r));
      const wi = rest[uw.indexOf(Math.max(...uw))];
      const entry: { best: string; worst: string; anchor?: string } = {
        best: String(alts[bi].item_index),
        worst: String(alts[wi].item_index),
      };
      if (withAnchor) {
        /* how many items in THIS set are above the respondent's threshold */
        const above = alts.filter((a) => TRUE_U[Number(a.item_index) - 1] > 0).length;
        entry.anchor = above === alts.length ? "all" : above === 0 ? "none" : "some";
      }
      ans[t] = entry;
    }
    out.push({
      id: `r${i}`, session_id: `s${i}`, respondent_code: `LIVE_${i}`, status: "complete",
      is_test: false, started_at: "2026-06-01T10:00:00.000Z", completed_at: "2026-06-01T10:07:00.000Z",
      quality: { classification: "CLEAN", qualityScore: 90, riskScore: 5 },
      answers: { q_md: ans }, calculated: {}, embedded: {}, flags: [],
    } as AnalyticsRow);
  }
  return out;
}

const spec = { environment: "LIVE" as const, dataset: "all" as const };
const run = (anchored: boolean, withAnchorAnswers = anchored, n = 500) => {
  const def = survey(anchored);
  const ds = buildDataset(def, rowsFor(n, 7, withAnchorAnswers), { spec });
  const d: AnalysisDefinition = { name: "maxdiff", kind: "maxdiff", dataset: spec, variables: ["MD"] };
  return runAnalysis(d, ds);
};

const scores = (r: ReturnType<typeof run>) =>
  new Map(r.tables[0].rows.map((x) => [String(x.item), Number(x.utility)]));

/* ================================================== the standard baseline */

test("a standard MaxDiff recovers the RANKING and centres it on zero", () => {
  const r = run(false);
  const order = r.tables[0].rows.map((x) => x.item);
  assert.equal(order[0], "Reliability");
  assert.equal(order[order.length - 1], "Slogan");
  const total = [...scores(r).values()].reduce((t, v) => t + v, 0);
  assert.ok(Math.abs(total) < 1e-6, `effects coding forces the utilities to sum to zero, got ${total}`);
});

test("and it says out loud that its scale cannot answer “does this matter”", () => {
  const r = run(false);
  const notes = (r.tables[0].notes ?? []).join(" ");
  assert.match(notes, /RELATIVE/);
  assert.match(notes, /anchored/i, "and points at the variant that can");
});

/* ==================================================== anchored behaviour */

test("AN ANCHORED MAXDIFF SEPARATES IMPORTANT FROM MERELY TOP-RANKED", () => {
  const r = run(true);
  const s = scores(r);
  for (const item of ["Reliability", "Price"]) {
    assert.ok(s.get(item)! > 0, `${item} is important and should clear the anchor (got ${s.get(item)})`);
  }
  for (const item of ["Colour", "Packaging", "Advert", "Slogan"]) {
    assert.ok(s.get(item)! < 0, `${item} is not important and should fall below it (got ${s.get(item)})`);
  }
});

test("the ranking is unchanged by anchoring — only the zero point moves", () => {
  const standard = run(false).tables[0].rows.map((x) => x.item);
  const anchored = run(true).tables[0].rows.map((x) => x.item);
  assert.deepEqual(anchored, standard);
});

test("the utilities are no longer forced to sum to zero", () => {
  // if they were, the anchor would be fighting the parameterisation and
  // "above zero" would mean nothing at all
  const total = [...scores(run(true)).values()].reduce((t, v) => t + v, 0);
  assert.ok(Math.abs(total) > 0.5, `an anchored scale must be free to move, sum was ${total}`);
});

test("both scales are reported, so an anchored study still compares with a standard one", () => {
  const r = run(true);
  const cols = r.tables[0].columns.map((c) => c.key);
  assert.ok(cols.includes("utility"));
  assert.ok(cols.includes("centred"));
  assert.ok(cols.includes("important"));
  const centred = r.tables[0].rows.reduce((t, x) => t + Number(x.centred), 0);
  /* zero by construction, then rounded to 3dp for display — so not exactly zero */
  assert.ok(Math.abs(centred) < 0.01, `the centred column should sum to zero, got ${centred}`);
});

test("each item is labelled above or below the anchor", () => {
  const r = run(true);
  const flags = new Map(r.tables[0].rows.map((x) => [String(x.item), String(x.important)]));
  assert.equal(flags.get("Reliability"), "yes");
  assert.equal(flags.get("Slogan"), "no");
});

test("the insight states how much of the list is worth anything", () => {
  const r = run(true);
  const line = r.insights.find((x) => /clear the anchor/.test(x));
  assert.ok(line, `expected an anchor insight, got: ${r.insights.join(" | ")}`);
  assert.match(line, /^2 of 6 items clear the anchor/);
});

test("the fit table accounts for the anchor answers it used", () => {
  const r = run(true);
  const fit = r.tables.find((t) => t.id === "fit")!;
  const rows = new Map(fit.rows.map((x) => [String(x.m), x.v]));
  assert.ok(Number(rows.get("Anchor observations")) > 0);
  assert.ok(Number(rows.get("“Some important”")) > 0, "the modal answer is present");
  assert.ok(Number(rows.get("“None important”")) > 0, "and so is the set with nothing important in it");
});

/* ==================================================== the honest failure */

test("an anchored design with no anchor answers WARNS rather than pretending", () => {
  // the silent version of this is the dangerous one: an absolute-looking
  // scale identified by nothing at all
  const r = run(true, false);
  assert.ok(
    r.warnings.some((w) => /anchored but no anchor answers/i.test(w)),
    `expected a warning, got: ${r.warnings.join(" | ")}`,
  );
});

test("a standard design ignores anchor answers that happen to be present", () => {
  // an anchored design regenerated as standard must not half-anchor itself
  const r = run(false, true);
  const total = [...scores(r).values()].reduce((t, v) => t + v, 0);
  assert.ok(Math.abs(total) < 1e-6);
  assert.ok(!r.tables[0].columns.some((c) => c.key === "important"));
});

test("an empty dataset still returns a result rather than throwing", () => {
  const ds = buildDataset(survey(true), [], { spec });
  const r = runAnalysis({ name: "maxdiff", kind: "maxdiff", dataset: spec, variables: ["MD"] }, ds);
  assert.equal(r.kind, "maxdiff");
  assert.ok(Array.isArray(r.tables));
});
