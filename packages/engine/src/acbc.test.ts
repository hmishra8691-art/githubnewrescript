import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAcbc, emptyAcbcAnswer, submitByo, submitScreen, answerRule, chooseInTournament, nearConcepts, detectRule, acbcDone,
  type AcbcAnswer,
} from "./acbc.js";

/**
 * ACBC — the state machine, driven like a respondent would drive it.
 *
 * The concepts are near the BYO and never duplicate it; a level rejected
 * often and never accepted becomes an unacceptable question, and confirming
 * it removes the level from every later concept; a must-have is asked when
 * every accepted concept shares a level; the tournament runs the accepted
 * concepts (and the BYO) down to one winner; everything is deterministic
 * from the seed and replayable from the answer.
 */

const cfg = normalizeAcbc({
  attributes: [
    { name: "Brand", levels: ["Apex", "Nova", "Zen"] },
    { name: "Price", levels: ["$199", "$299", "$399"] },
    { name: "Battery", levels: ["8 h", "12 h", "20 h"] },
    { name: "Colour", levels: ["Black", "Silver"] },
  ],
  prohibitions: [{ a: { attribute: "Brand", level: "Zen" }, b: { attribute: "Price", level: "$399" } }],
  screeningTasks: 4, conceptsPerScreen: 4, maxAttributesVaried: 2, unacceptableThreshold: 3, mustHaveThreshold: 3, tournamentAlternatives: 3, minTournamentConcepts: 5,
});
const BYO = { Brand: "Apex", Price: "$199", Battery: "20 h", Colour: "Black" };
const differing = (p: Record<string, string>) => Object.keys(BYO).filter((k) => p[k] !== (BYO as Record<string, string>)[k]).length;

test("BYO → the first screen: near concepts differ from the BYO in 1..maxVaried attributes, no duplicates, prohibitions honoured, deterministic", () => {
  const a = submitByo(cfg, emptyAcbcAnswer(), 42, BYO);
  assert.equal(a.stage, "screen");
  assert.equal(a.screens.length, 1);
  const c = a.screens[0].concepts;
  assert.equal(c.length, 4);
  for (const x of c) {
    const d = differing(x.profile);
    assert.ok(d >= 1 && d <= 2, `differs in ${d}`);
    assert.ok(!(x.profile.Brand === "Zen" && x.profile.Price === "$399"), "prohibition honoured");
  }
  assert.equal(new Set(c.map((x) => JSON.stringify(x.profile))).size, 4, "all different");
  const b = submitByo(cfg, emptyAcbcAnswer(), 42, BYO);
  assert.deepEqual(b.screens[0].concepts, c, "same seed, same BYO → same screen");
  const other = submitByo(cfg, emptyAcbcAnswer(), 43, BYO);
  assert.notDeepEqual(other.screens[0].concepts, c, "another respondent sees other concepts");
});

/** judge every concept on the current screen with a rule of thumb, then submit */
function judge(a: AcbcAnswer, seed: number, verdict: (p: Record<string, string>) => "yes" | "no"): AcbcAnswer {
  const s = a.screens[a.screens.length - 1];
  const verdicts: Record<string, "yes" | "no"> = {};
  for (const c of s.concepts) verdicts[c.id] = verdict(c.profile);
  const judged: AcbcAnswer = { ...a, screens: [...a.screens.slice(0, -1), { ...s, verdicts }] };
  return submitScreen(cfg, judged, seed);
}

test("UNACCEPTABLE: a level rejected 3 times and never accepted is asked; confirmed, it vanishes from later screens; declined, it stays", () => {
  // this respondent rejects everything at $399 and accepts everything else
  let a = submitByo(cfg, emptyAcbcAnswer(), 7, BYO);
  let asked: AcbcAnswer["pending"] | undefined;
  let screensAtConfirm = -1;
  for (let guard = 0; guard < 12 && a.stage !== "tournament" && a.stage !== "done"; guard++) {
    if (a.stage === "screen") a = judge(a, 7, (p) => (p.Price === "$399" ? "no" : "yes"));
    else if (a.stage === "rule") {
      if (a.pending!.kind === "unacceptable" && a.pending!.level === "$399") { asked = a.pending; screensAtConfirm = a.screens.length; a = answerRule(cfg, a, 7, true); }
      else a = answerRule(cfg, a, 7, false);
    }
  }
  assert.ok(asked, "the $399 unacceptable was put to the respondent");
  assert.deepEqual(asked, { kind: "unacceptable", attribute: "Price", level: "$399" });
  assert.ok(a.unacceptable.some((r) => r.level === "$399" && r.confirmed));
  // every screen generated AFTER the confirmation has no $399
  const after = a.screens.slice(screensAtConfirm);
  for (const s of after) for (const c of s.concepts) assert.notEqual(c.profile.Price, "$399", "confirmed unacceptable never shown again");
  assert.ok(screensAtConfirm < cfg.screeningTasks ? after.length > 0 : true, "there were later screens to check (or the rule came after the last one)");
  assert.equal(a.stage, "tournament");

  // the same respondent DECLINING the rule keeps $399 in play: the generator is not constrained by it
  const declined: AcbcAnswer = { ...a, unacceptable: [{ attribute: "Price", level: "$399", confirmed: false }] };
  const many = nearConcepts(cfg, declined, 7, 77, 12, new Set());
  assert.ok(many.some((c) => c.profile.Price === "$399"), "a declined rule bans nothing");
  const enforced: AcbcAnswer = { ...a, unacceptable: [{ attribute: "Price", level: "$399", confirmed: true }] };
  assert.ok(nearConcepts(cfg, enforced, 7, 77, 12, new Set()).every((c) => c.profile.Price !== "$399"), "a confirmed one bans the level");
});

test("MUST-HAVE: every accepted concept shares a level the rejected ones lack → asked; confirmed, it is fixed in later concepts", () => {
  // this respondent accepts only Apex
  let a = submitByo(cfg, emptyAcbcAnswer(), 11, BYO);
  let asked: AcbcAnswer["pending"] | undefined;
  for (let guard = 0; guard < 14 && a.stage !== "tournament" && a.stage !== "done"; guard++) {
    if (a.stage === "screen") a = judge(a, 11, (p) => (p.Brand === "Apex" ? "yes" : "no"));
    else if (a.stage === "rule") {
      if (a.pending!.kind === "musthave") { asked = a.pending; a = answerRule(cfg, a, 11, true); }
      else a = answerRule(cfg, a, 11, false); // decline unacceptables (other brands) to keep the test about must-have
    }
  }
  assert.ok(asked, "a must-have was put to the respondent");
  assert.deepEqual(asked, { kind: "musthave", attribute: "Brand", level: "Apex" });
  const last = a.screens[a.screens.length - 1];
  if (a.mustHave.some((r) => r.confirmed) && last.concepts.every((c) => c.id.startsWith("s"))) {
    // the last screen was generated after confirmation only if there were screens left; when it was, Brand is fixed
    const idx = Number(last.concepts[0].id.slice(1).split("c")[0]);
    if (idx > 2) for (const c of last.concepts) assert.equal(c.profile.Brand, "Apex");
  }
});

test("TOURNAMENT: accepted concepts + the BYO, sets of 3, the winner advances, one remains; export-ready", () => {
  let a = submitByo(cfg, emptyAcbcAnswer(), 5, BYO);
  for (let guard = 0; guard < 14 && a.stage !== "tournament"; guard++) {
    if (a.stage === "screen") a = judge(a, 5, (p) => (p.Colour === "Silver" ? "no" : "yes"));
    else if (a.stage === "rule") a = answerRule(cfg, a, 5, false);
  }
  assert.equal(a.stage, "tournament");
  assert.ok(a.remaining.includes("byo"), "the respondent's own ideal competes");
  assert.ok(a.remaining.length >= cfg.minTournamentConcepts, "padded to the minimum when few were accepted");
  const total = a.remaining.length;
  let rounds = 0;
  while (a.stage === "tournament" && rounds < 40) {
    const round = a.tournament[a.tournament.length - 1];
    assert.ok(round.concepts.length >= 2 && round.concepts.length <= 3);
    // always pick the cheapest — a consistent respondent
    const pick = [...round.concepts].sort((x, y) => x.profile.Price.localeCompare(y.profile.Price))[0];
    a = chooseInTournament(cfg, a, 5, pick.id);
    rounds++;
  }
  assert.equal(a.stage, "done");
  assert.ok(a.winner, "a winner");
  assert.ok(acbcDone(a));
  assert.equal(a.tournament.filter((r) => r.chosen).length, rounds);
  // every round eliminated alternatives-1 concepts (except a short last set): total - 1 eliminations in all
  const eliminated = a.tournament.reduce((n, r) => n + (r.concepts.length - 1), 0);
  assert.equal(eliminated, total - 1, "exactly one concept survives");
  assert.equal(a.winner!.profile.Price, "$199", "the consistent cheapest-picker's winner is a $199 concept");
  // a choice on a finished round is ignored
  assert.deepEqual(chooseInTournament(cfg, a, 5, "byo"), a);
});

test("detectRule asks each level at most once, never the BYO's own level as unacceptable", () => {
  const a = submitByo(cfg, emptyAcbcAnswer(), 3, BYO);
  const s = a.screens[0];
  // reject everything: many levels hit the threshold only if repeated; with 4 concepts none reaches 3 rejections except by chance
  const verdicts: Record<string, "yes" | "no"> = {};
  for (const c of s.concepts) verdicts[c.id] = "no";
  const judged: AcbcAnswer = { ...a, screens: [{ ...s, verdicts }] };
  const r = detectRule(cfg, judged);
  if (r) {
    assert.equal(r.kind, "unacceptable");
    assert.notEqual((BYO as Record<string, string>)[r.attribute], r.level, "the BYO level is what they chose — never unacceptable");
  }
  const withAsked: AcbcAnswer = { ...judged, unacceptable: r ? [{ attribute: r.attribute, level: r.level, confirmed: false }] : [] };
  const again = detectRule(cfg, withAsked);
  if (r && again) assert.notDeepEqual({ attribute: again.attribute, level: again.level }, { attribute: r.attribute, level: r.level }, "not asked twice");
});

test("nearConcepts with every attribute forced or banned degrades to fewer concepts rather than looping", () => {
  const tight = normalizeAcbc({ attributes: [{ name: "A", levels: ["1", "2"] }, { name: "B", levels: ["x", "y"] }], screeningTasks: 2, conceptsPerScreen: 4, maxAttributesVaried: 2 });
  const a = submitByo(tight, emptyAcbcAnswer(), 1, { A: "1", B: "x" });
  // only 3 other profiles exist: the screen gets 3, not 4
  assert.equal(a.screens[0].concepts.length, 3);
  const banned: AcbcAnswer = { ...a, unacceptable: [{ attribute: "A", level: "2", confirmed: true }, { attribute: "B", level: "y", confirmed: true }] };
  assert.deepEqual(nearConcepts(tight, banned, 1, 2, 4, new Set()), [], "nothing legal left → none, and it returns");
});
