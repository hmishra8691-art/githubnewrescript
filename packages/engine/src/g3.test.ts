import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, variantRegistry } from "@rescript/schema";
import {
  createResponseState,
  validateQuestion,
  tournamentStep,
  tournamentOrder,
  estimateTournamentDuels,
  type EvalContext,
  type TournamentDuel,
  type TournamentCode,
} from "./index.js";

/**
 * Engine-side checks for the ranking / drag & drop / swipe variant batch.
 *
 * The only thing these variants added to the engine is the pure tournament
 * algorithm (`tournament.ts`) — everything else is presentation over base
 * types whose validation, variables and flattening already existed, which is
 * exactly what the second half of this file asserts.
 */

/* ------------------------------------------------------- a simulated respondent */

/**
 * Answer duels according to a fixed private preference order, the way a real
 * respondent with consistent opinions would.
 */
function runTournament(
  codes: TournamentCode[],
  preference: TournamentCode[],
  opts: { seed?: number; topN?: number } = {},
) {
  const rank = (c: TournamentCode) => preference.findIndex((x) => String(x) === String(c));
  const results: TournamentDuel[] = [];
  let step = tournamentStep({ codes, results, ...opts });
  let guard = 0;
  while (step.duel) {
    if (++guard > 500) throw new Error("tournament did not terminate");
    const { a, b } = step.duel;
    results.push({ a, b, winner: rank(a) < rank(b) ? a : b });
    step = tournamentStep({ codes, results, ...opts });
  }
  return { ranking: step.ranking, sorted: step.sorted, duels: results.length, step };
}

const SIX = ["a", "b", "c", "d", "e", "f"];
const TRUTH = ["d", "a", "f", "b", "e", "c"]; // the respondent's private order

test("a consistent respondent's duels reproduce their preference order exactly", () => {
  const r = runTournament(SIX, TRUTH, { seed: 12345 });
  assert.deepEqual(r.ranking, TRUTH);
  assert.equal(r.step.done, true);
  assert.equal(r.step.duel, null);
});

test("the sort costs no more than n·ceil(log2 n) duels — and asks each pair once", () => {
  const r = runTournament(SIX, TRUTH, { seed: 7 });
  const bound = SIX.length * Math.ceil(Math.log2(SIX.length)); // 6 × 3 = 18
  assert.ok(r.duels <= bound, `${r.duels} duels is within the ${bound} bound`);
  assert.ok(r.duels <= estimateTournamentDuels(SIX.length), "and within the shown estimate");
  // a round robin would be 15; binary insertion is meaningfully cheaper
  assert.ok(r.duels < 15, `${r.duels} < 15 (a full round robin)`);
  // no pair is ever put to the respondent twice
  const seen = new Set<string>();
  const results: TournamentDuel[] = [];
  let step = tournamentStep({ codes: SIX, results, seed: 7 });
  while (step.duel) {
    const key = [String(step.duel.a), String(step.duel.b)].sort().join("|");
    assert.ok(!seen.has(key), `pair ${key} is asked only once`);
    seen.add(key);
    const rank = (c: TournamentCode) => TRUTH.findIndex((x) => String(x) === String(c));
    results.push({ a: step.duel.a, b: step.duel.b, winner: rank(step.duel.a) < rank(step.duel.b) ? step.duel.a : step.duel.b });
    step = tournamentStep({ codes: SIX, results, seed: 7 });
  }
});

test("a top-N cutoff stops early and stores only the top N", () => {
  const full = runTournament(SIX, TRUTH, { seed: 99 });
  const top2 = runTournament(SIX, TRUTH, { seed: 99, topN: 2 });
  assert.deepEqual(top2.ranking, TRUTH.slice(0, 2), "the top 2, in order");
  assert.equal(top2.ranking.length, 2, "and nothing else is stored");
  assert.ok(top2.duels < full.duels, `${top2.duels} duels for the top 2 vs ${full.duels} for all 6`);
  assert.ok(
    estimateTournamentDuels(6, 2) < estimateTournamentDuels(6),
    "the estimate shown to the respondent drops too",
  );
});

test("the same seed always yields the same first duel; a different one need not", () => {
  const first = (seed: number) => {
    const s = tournamentStep({ codes: SIX, seed });
    return `${s.duel!.a}v${s.duel!.b}`;
  };
  assert.equal(first(4242), first(4242));
  assert.deepEqual(tournamentOrder(SIX, 4242), tournamentOrder(SIX, 4242));
  // and no seed at all keeps the option list's own order
  assert.deepEqual(tournamentOrder(SIX), SIX);
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8].map(first);
  assert.ok(new Set(seeds).size > 1, "different seeds shuffle to different opening duels");
});

test("progress counts up and the ranking is only complete when the duels are", () => {
  const results: TournamentDuel[] = [];
  const s0 = tournamentStep({ codes: SIX, results, seed: 5 });
  assert.equal(s0.duelNumber, 1);
  assert.equal(s0.done, false);
  results.push({ a: s0.duel!.a, b: s0.duel!.b, winner: s0.duel!.a });
  const s1 = tournamentStep({ codes: SIX, results, seed: 5 });
  assert.equal(s1.duelNumber, 2);
  assert.equal(s1.used, 1);
  assert.ok(s1.ranking.length < SIX.length, "a half-sorted list is not a ranking");
});

test("duels recorded against options that no longer exist are re-asked, not trusted", () => {
  const s0 = tournamentStep({ codes: SIX, seed: 3 });
  const stale: TournamentDuel[] = [{ a: "zz", b: "yy", winner: "zz" }];
  const s1 = tournamentStep({ codes: SIX, results: stale, seed: 3 });
  assert.equal(s1.used, 0, "the stale duel is not consumed");
  assert.deepEqual([s1.duel!.a, s1.duel!.b], [s0.duel!.a, s0.duel!.b], "and the real duel is asked");
});

test("degenerate item counts do not hang or throw", () => {
  assert.deepEqual(tournamentStep({ codes: [] }).ranking, []);
  assert.equal(tournamentStep({ codes: [] }).done, true);
  assert.deepEqual(tournamentStep({ codes: ["only"] }).ranking, ["only"]);
  assert.equal(tournamentStep({ codes: ["only"] }).done, true);
  const two = runTournament(["x", "y"], ["y", "x"]);
  assert.deepEqual(two.ranking, ["y", "x"]);
  assert.equal(two.duels, 1);
});

test("numeric option codes survive the round trip", () => {
  const r = runTournament([1, 2, 3, 4], [3, 1, 4, 2], { seed: 11 });
  assert.deepEqual(r.ranking, [3, 1, 4, 2]);
});

/* ---------------------------------------- the variants ride existing engine rules */

function survey(q: Record<string, unknown>) {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" },
    questions: [{
      id: "q1", code: "Q1", variableName: "Q1", text: "", required: true,
      options: [], rows: [], columns: [], validation: [], settings: {}, ...q,
    }],
    flow: [{ type: "page", id: "p", questionIds: ["q1"] }],
  });
}
function ctxFor(def: SurveyDefinition): EvalContext {
  return { def, state: createResponseState(def, {}), loop: null };
}
const messages = (def: SurveyDefinition, value: unknown) =>
  validateQuestion(def, def.questions[0], value, ctxFor(def)).map((e) => e.message);

test("tournament completeness follows the top-N cap, through rankMode alone", () => {
  const opts = [1, 2, 3, 4, 5, 6].map((n) => ({ code: String(n), label: `I${n}` }));
  // no cap: rankMode "top_n" with no maxSelections means "rank everything"
  const all = survey({ type: "ranking", variant: "ranking.tournament", options: opts, settings: { rankMode: "top_n" } });
  assert.deepEqual(messages(all, ["1", "2", "3"]), ["Please rank your top 6."]);
  assert.deepEqual(messages(all, ["1", "2", "3", "4", "5", "6"]), []);
  // capped: the Studio writes maxSelections beside tournamentTopN
  const top2 = survey({
    type: "ranking", variant: "ranking.tournament", options: opts,
    settings: { rankMode: "top_n", tournamentTopN: 2, maxSelections: 2 },
  });
  assert.deepEqual(messages(top2, ["1", "2"]), [], "two ranks satisfy a top-2 tournament");
  assert.deepEqual(messages(top2, ["1"]), ["Please rank your top 2."]);
  assert.deepEqual(messages(top2, null), ["This question is required."]);
});

test("bucket ranking's slots are the same top-N rule", () => {
  const opts = [1, 2, 3, 4].map((n) => ({ code: String(n), label: `I${n}` }));
  const three = survey({
    type: "ranking", variant: "ranking.buckets", options: opts,
    settings: { rankMode: "top_n", maxSelections: 3 },
  });
  assert.deepEqual(messages(three, ["2", "4", "1"]), []);
  assert.deepEqual(messages(three, ["2", "4"]), ["Please rank your top 3."]);
});

test("chip allocation is an ordinary constant sum", () => {
  const def = survey({
    type: "allocation", variant: "allocation.drag",
    options: [1, 2].map((n) => ({ code: String(n), label: `I${n}` })),
    settings: { sumTarget: 100, chipValue: 10 },
  });
  assert.deepEqual(messages(def, { "1": 60, "2": 40 }), []);
  assert.deepEqual(messages(def, { "1": 60, "2": 30 }), ["Total must equal 100 (currently 90)."]);
  assert.deepEqual(messages(def, {}), ["This question is required."]);
});

test("both swipe decks validate as the single-select matrices they are", () => {
  for (const variant of ["swipe.rate", "swipe.four_direction"]) {
    const def = survey({
      type: "matrix_single", variant,
      options: [{ code: "1", label: "One" }, { code: "2", label: "Two" }],
      rows: [
        { code: "r1", label: "Card 1", flags: [], validation: [], required: false },
        { code: "r2", label: "Card 2", flags: [], validation: [], required: false },
      ],
    });
    assert.deepEqual(messages(def, { r1: "1", r2: "2" }), [], `${variant} complete`);
    assert.deepEqual(messages(def, { r1: "1" }), ['Please answer for "Card 2".'], `${variant} partial`);
  }
});

test("drag onto scale stores numbers per row, like any numeric matrix", () => {
  const def = survey({
    type: "matrix_numeric", variant: "dragdrop.scale",
    rows: [
      { code: "r1", label: "Item 1", flags: [], validation: [], required: false },
      { code: "r2", label: "Item 2", flags: [], validation: [], required: false },
    ],
    settings: { minValue: 0, maxValue: 100 },
  });
  assert.deepEqual(messages(def, { r1: 0, r2: 73 }), [], "zero is a real answer, not an empty one");
  assert.deepEqual(messages(def, { r1: 73 }), ['Please answer for "Item 2".']);
});

/* ------------------------------------------------------------ registry shape */

test("all nine variants are stable, wired to a renderer, and born usable", () => {
  const expected: [string, string, string, string][] = [
    // id, base type, renderer, response model
    ["ranking.tournament", "ranking", "tournament", "rank_order"],
    ["ranking.buckets", "ranking", "rankbuckets", "rank_order"],
    ["comparison.tournament", "ranking", "tournament", "rank_order"],
    ["dragdrop.buckets", "matrix_single", "dragbuckets", "per_row"],
    ["dragdrop.scale", "matrix_numeric", "dragscale", "per_row"],
    ["dragdrop.allocation", "allocation", "chipallocation", "allocation"],
    ["allocation.drag", "allocation", "chipallocation", "allocation"],
    ["swipe.rate", "matrix_single", "swiperate", "per_row"],
    ["swipe.four_direction", "matrix_single", "swipe4", "per_row"],
  ];
  for (const [id, baseType, renderer, model] of expected) {
    const v = variantRegistry.get(id);
    assert.ok(v, `${id} is registered`);
    assert.equal(v!.status, "stable", `${id} is stable`);
    assert.equal(v!.baseType, baseType, `${id} base type`);
    assert.equal(v!.renderer, renderer, `${id} renderer`);
    assert.equal(v!.responseModel, model, `${id} response model`);
    assert.ok(v!.validations.includes("required"), `${id} offers required`);
    // nothing may be born empty: a deck with no cards or a duel with no
    // items renders an apology instead of a question
    if (["matrix_single", "matrix_numeric"].includes(baseType)) {
      assert.ok((v!.defaults?.rows?.length ?? 0) > 0, `${id} seeds rows`);
    }
    if (baseType !== "matrix_numeric") {
      assert.ok((v!.defaults?.options?.length ?? 0) > 0, `${id} seeds options`);
    }
  }
});

test("the two tournament entries and the two chip entries are one renderer each", () => {
  assert.equal(
    variantRegistry.get("ranking.tournament")!.renderer,
    variantRegistry.get("comparison.tournament")!.renderer,
  );
  assert.equal(
    variantRegistry.get("dragdrop.allocation")!.renderer,
    variantRegistry.get("allocation.drag")!.renderer,
  );
  // the sibling entries other batches built are merged alongside: all stable now
  assert.equal(variantRegistry.get("comparison.attributes")!.status, "stable");
  assert.equal(variantRegistry.get("allocation.slider_allocation")!.status, "stable");
});

test("the four swipe directions default to the option order", () => {
  const v = variantRegistry.get("swipe.four_direction")!;
  assert.equal(v.defaults!.options!.length, 4, "four options, one per direction");
  assert.equal(v.defaults!.settings, undefined, "no mapping stored — the order IS the default");
});
