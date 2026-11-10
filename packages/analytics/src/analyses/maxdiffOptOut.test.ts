import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { mulberry32 } from "@rescript/engine";
import { buildDataset, type AnalyticsRow } from "../dataset.js";
import { runAnalysis } from "./index.js";
import type { AnalysisDefinition } from "../types.js";

/**
 * MAXDIFF TASK OPT-OUTS IN THE ANALYSIS (2026-11-10).
 *
 * A set answered "None of these" / "No preference" / "I cannot choose" is not a choice between items. The analysis
 * must (1) leave it out of the counts and the model, so it cannot move an item's score, (2) say how many there were,
 * by kind, and (3) in an ANCHORED design use "None of these" as the anchor answer "none", which is what it says.
 */
const ITEMS = ["Reliability", "Price", "Colour", "Packaging", "Advert", "Slogan"];
const TRUE_U = [1.4, 0.7, -0.6, -0.9, -1.3, -1.8];
const SETS = [[1, 2, 3, 4], [1, 2, 5, 6], [3, 4, 5, 6], [1, 3, 4, 5], [2, 3, 4, 6], [1, 2, 4, 5]];
const designRows = () => SETS.flatMap((set, t) => set.map((i, p) => ({ version: 1, task: t + 1, position: p + 1, item_index: i, item_label: ITEMS[i - 1] })));
const survey = (config: Record<string, unknown>) => SurveyDefinition.parse({
  meta: { id: "mdo", code: "MDO", title: "MaxDiff opt-outs", version: "1.0" },
  designs: [{ id: "d", kind: "maxdiff", name: "MD", config: { items: ITEMS, itemsPerTask: 4, ...config }, file: { format: "json", columns: ["version", "task", "position", "item_index", "item_label"], rows: designRows() } }],
  questions: [{ id: "q", code: "Q1", variableName: "MD", type: "maxdiff_task", text: "Best/worst", settings: { designRef: "d" } }],
  flow: [{ type: "page", id: "p1", questionIds: ["q"] }],
});
const gumbel = (r: () => number) => -Math.log(-Math.log(Math.max(r(), 1e-9)));

/** `optOut(i, task)` returns the kind this respondent opts out of that set with, or null to choose */
function rowsFor(n: number, optOut: (i: number, task: number) => string | null): AnalyticsRow[] {
  const r = mulberry32(7);
  return Array.from({ length: n }, (_, i) => {
    const ans: Record<string, unknown> = {};
    SETS.forEach((set, t) => {
      const u = set.map((x) => TRUE_U[x - 1] + gumbel(r));
      const bi = u.indexOf(Math.max(...u));
      const rest = set.map((_, k) => k).filter((k) => k !== bi);
      const uw = rest.map((k) => -TRUE_U[set[k] - 1] + gumbel(r));
      const wi = rest[uw.indexOf(Math.max(...uw))];
      const kind = optOut(i, t + 1);
      ans[String(t + 1)] = kind ? { optOut: kind } : { best: String(set[bi]), worst: String(set[wi]) };
    });
    return { id: `r${i}`, session_id: `s${i}`, respondent_code: `L${i}`, status: "complete", is_test: false, started_at: "2026-06-01T10:00:00.000Z", completed_at: "2026-06-01T10:07:00.000Z", quality: { classification: "CLEAN", qualityScore: 90, riskScore: 5 }, answers: { q: ans }, calculated: {}, embedded: {}, flags: [] } as AnalyticsRow;
  });
}
const spec = { environment: "LIVE" as const, dataset: "all" as const };
const analyse = (config: Record<string, unknown>, rows: AnalyticsRow[]) => runAnalysis({ name: "maxdiff", kind: "maxdiff", dataset: spec, variables: ["MD"] } as AnalysisDefinition, buildDataset(survey(config), rows, { spec }));
const table = (r: ReturnType<typeof analyse>, id: string) => r.tables.find((t) => t.id === id);

test("opted-out sets are left out of the counts and the model, and reported by kind", () => {
  /* every third respondent opts out of set 3 (the set with nothing important in it) with None; every tenth cannot choose set 1 */
  const rows = rowsFor(300, (i, t) => (t === 3 && i % 3 === 0 ? "none" : t === 1 && i % 10 === 0 ? "cannot_choose" : null));
  const r = analyse({ optOutNone: true, optOutCannotChoose: true }, rows);
  const items = table(r, "maxdiff")!.rows;
  assert.equal(items[0].item, "Reliability");
  assert.equal(items[items.length - 1].item, "Slogan");
  /* Colour is in sets 1, 3, 4 and 5: 300 respondents × 4 sets − the 100 opted-out showings of set 3 − the 30 of set 1 */
  assert.equal(items.find((x) => x.item === "Colour")!.shown, 1070);
  const opt = table(r, "optouts")!;
  assert.deepEqual(opt.rows.map((x) => [x.optout, x.n]), [["None of these", 100], ["I cannot choose", 30]]);
  assert.match(opt.notes!.join(" "), /130 of 1800 answered sets/);
  assert.match(opt.notes!.join(" "), /an opt-out is not an item and has no utility/);
  assert.ok(!items.some((x) => /None of these|cannot choose/i.test(String(x.item))), "no opt-out among the scored items");
  /* the same choices with the opt-outs simply missing give the same scores: an opt-out moves nothing */
  const without = analyse({}, rows.map((x) => ({ ...x, answers: { q: Object.fromEntries(Object.entries(x.answers!.q as Record<string, { optOut?: string }>).filter(([, v]) => !v.optOut)) } })) as AnalyticsRow[]);
  assert.deepEqual(table(without, "maxdiff")!.rows.map((x) => [x.item, x.utility]), items.map((x) => [x.item, x.utility]));
  assert.equal(table(without, "optouts"), undefined, "a design without opt-outs has no opt-out table");
});

test("an opt-out the design does not offer is not counted as one", () => {
  const rows = rowsFor(120, (i, t) => (t === 2 && i % 4 === 0 ? "no_preference" : null));
  const r = analyse({ optOutNone: true }, rows);
  assert.deepEqual(table(r, "optouts")!.rows.map((x) => x.n), [0]);
});

test("in an anchored design “None of these” is the anchor answer “none”: it pulls the set's items below the bar", () => {
  const anchorOf = (set: number[]) => { const above = set.filter((x) => TRUE_U[x - 1] > 0).length; return above === set.length ? "all" : above === 0 ? "none" : "some"; };
  const base = rowsFor(400, () => null).map((row) => ({ ...row, answers: { q: Object.fromEntries(Object.entries(row.answers!.q as Record<string, object>).map(([t, v]) => [t, { ...v, anchor: anchorOf(SETS[Number(t) - 1]) }])) } })) as AnalyticsRow[];
  /* set 3 holds only unimportant items: half the respondents say so with the opt-out instead of choosing */
  const opted = base.map((row, i) => (i % 2 ? row : { ...row, answers: { q: { ...(row.answers!.q as object), "3": { optOut: "none" } } } })) as AnalyticsRow[];
  const r = analyse({ anchored: true, anchorPrompt: "How many matter?", optOutNone: true }, opted);
  const items = table(r, "maxdiff")!.rows;
  const above = items.filter((x) => x.important === "yes").map((x) => x.item);
  assert.deepEqual(above.sort(), ["Price", "Reliability"]);
  assert.match(String(table(r, "optouts")!.rows[0].meaning), /anchor answer “none”/);
  assert.equal(table(r, "optouts")!.rows[0].n, 200);
});
