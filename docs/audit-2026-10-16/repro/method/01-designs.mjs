// Design-generation audit: conjoint balance + prohibitions, maxdiff exposure balance, ACBC engine prohibitions.
import { conjointPlugin, maxdiffPlugin, acbcPlugin, designToCSV } from "/home/claude/rescript/packages/designs/dist/index.js";
import { designVersionFor, shuffleAlternatives, normalizeAcbc, submitByo, nearConcepts, emptyAcbcAnswer } from "/home/claude/rescript/packages/engine/dist/index.js";

const out = [];
const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };

/* ---------------- Conjoint: 3 attributes ---------------- */
const cfg = {
  attributes: [
    { name: "Brand", levels: ["Alpha", "Beta", "Gamma"] },
    { name: "Price", levels: ["$10", "$20", "$30", "$40"] },
    { name: "Warranty", levels: ["1 year", "3 years"] },
  ],
  prohibitions: [{ a: { attribute: "Brand", level: "Gamma" }, b: { attribute: "Price", level: "$40" } }],
  tasks: 12, alternativesPerTask: 3, noneOption: true, holdoutTasks: 2, versions: 4,
};
log("## Conjoint validateConfig:", JSON.stringify(conjointPlugin.validateConfig(cfg)));
const d = conjointPlugin.generate(cfg, 12345);
const d2 = conjointPlugin.generate(cfg, 12345);
log("deterministic (same seed → same rows):", JSON.stringify(d.rows) === JSON.stringify(d2.rows));
const d3 = conjointPlugin.generate(cfg, 999);
log("different seed → different rows:", JSON.stringify(d.rows) !== JSON.stringify(d3.rows));
log("columns:", d.columns.join(","));
log("rows:", d.rows.length, "(expected", 4 * 14 * 4, ")");
const concepts = d.rows.filter((r) => r.none_option !== 1);
// one-way balance
for (const a of cfg.attributes) {
  const counts = {};
  for (const r of concepts) counts[r[a.name]] = (counts[r[a.name]] ?? 0) + 1;
  const v = Object.values(counts);
  log(`balance ${a.name}:`, JSON.stringify(counts), "max/min =", (Math.max(...v) / Math.min(...v)).toFixed(3));
}
log("summary.balanceScores:", JSON.stringify(d.summary.balanceScores));
// two-way balance: Brand x Price
const two = {};
for (const r of concepts) { const k = `${r.Brand}|${r.Price}`; two[k] = (two[k] ?? 0) + 1; }
const twoVals = Object.values(two);
log("two-way Brand×Price cells:", Object.keys(two).length, "of 12 (11 legal); counts min/max:", Math.min(...twoVals), Math.max(...twoVals));
log("two-way table:", JSON.stringify(two));
// prohibition honoured
const viol = concepts.filter((r) => r.Brand === "Gamma" && r.Price === "$40");
log("prohibition violations (Gamma × $40):", viol.length);
// no duplicate concepts within task
let dup = 0;
for (let v = 1; v <= 4; v++) for (let t = 1; t <= 14; t++) {
  const keys = concepts.filter((r) => r.version === v && r.task === t).map((r) => cfg.attributes.map((a) => r[a.name]).join("|"));
  if (new Set(keys).size !== keys.length) dup++;
}
log("tasks with duplicate concepts:", dup);
// holdout flags
log("holdout rows:", d.rows.filter((r) => r.is_holdout === 1).length, "(expected", 4 * 2 * 4, ")");
log("summary extra:", JSON.stringify({ legalConcepts: d.summary.legalConcepts, totalConcepts: d.summary.totalConcepts, spaceRemaining: d.summary.spaceRemaining }));
// infeasible prohibitions refused?
const bad = { ...cfg, prohibitions: [
  { a: { attribute: "Brand", level: "Alpha" }, b: { attribute: "Warranty", level: "1 year" } },
  { a: { attribute: "Brand", level: "Alpha" }, b: { attribute: "Warranty", level: "3 years" } },
] };
log("level-unreachable prohibitions → validateConfig:", JSON.stringify(conjointPlugin.validateConfig(bad)));
// combination prohibition
const combo = { ...cfg, prohibitions: [{ a: { attribute: "Brand", level: "Gamma" }, b: { attribute: "Price", level: "$30" }, also: [{ attribute: "Warranty", level: "3 years" }], alsoOp: "and" }] };
const dc = conjointPlugin.generate(combo, 7);
log("combination prohibition violations:", dc.rows.filter((r) => r.Brand === "Gamma" && r.Price === "$30" && r.Warranty === "3 years").length);
// D-efficiency? just note there is no such metric in summary
log("summary keys:", Object.keys(d.summary).join(","));

/* ---------------- Version assignment per respondent ---------------- */
const q = { id: "q1", settings: {} };
const vc = {};
for (let s = 1; s <= 4000; s++) { const v = designVersionFor(q, d.rows, s * 7919); vc[v] = (vc[v] ?? 0) + 1; }
log("version assignment over 4000 seeds:", JSON.stringify(vc));
const alts = d.rows.filter((r) => r.version === 1 && r.task === 1);
const o1 = shuffleAlternatives(alts, 42, "q1:1").map((r) => r.alt), o2 = shuffleAlternatives(alts, 42, "q1:1").map((r) => r.alt), o3 = shuffleAlternatives(alts, 43, "q1:1").map((r) => r.alt);
log("alt order seed42:", o1.join(","), "| again:", o2.join(","), "| seed43:", o3.join(","), "| none last:", o1[o1.length - 1] === 4);

/* ---------------- MaxDiff ---------------- */
const items = Array.from({ length: 12 }, (_, i) => `Item ${i + 1}`);
const mcfg = { items, itemsPerTask: 4, tasks: 9, versions: 5 };
log("\n## MaxDiff validateConfig:", JSON.stringify(maxdiffPlugin.validateConfig(mcfg)));
const m = maxdiffPlugin.generate(mcfg, 2024);
log("rows:", m.rows.length, "(expected", 5 * 9 * 4, ")");
log("itemShowCounts:", JSON.stringify(m.summary.itemShowCounts));
const sc = Object.values(m.summary.itemShowCounts);
log("exposure min/max:", Math.min(...sc), Math.max(...sc), "mean", m.summary.meanShowsPerItem);
log("pairCooccurrence:", JSON.stringify(m.summary.pairCooccurrence));
// per-version exposure
for (let v = 1; v <= 5; v++) {
  const c = {};
  for (const r of m.rows.filter((r) => r.version === v)) c[r.item_index] = (c[r.item_index] ?? 0) + 1;
  const vals = items.map((_, i) => c[i + 1] ?? 0);
  log(`version ${v} exposure:`, vals.join(","), "min/max", Math.min(...vals), Math.max(...vals));
}
// pair matrix
const pairs = new Map();
for (let v = 1; v <= 5; v++) for (let t = 1; t <= 9; t++) {
  const ids = m.rows.filter((r) => r.version === v && r.task === t).map((r) => r.item_index);
  for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) { const k = [ids[a], ids[b]].sort((x, y) => x - y).join(":"); pairs.set(k, (pairs.get(k) ?? 0) + 1); }
}
log("pairs seen:", pairs.size, "of", 66, "; pair count min/max:", Math.min(...pairs.values()), Math.max(...pairs.values()));
// duplicates within task
let mdup = 0;
for (let v = 1; v <= 5; v++) for (let t = 1; t <= 9; t++) { const ids = m.rows.filter((r) => r.version === v && r.task === t).map((r) => r.item_index); if (new Set(ids).size !== ids.length) mdup++; }
log("tasks with duplicate items:", mdup);
// position balance
const pos = {};
for (const r of m.rows) { pos[r.item_index] = pos[r.item_index] ?? [0, 0, 0, 0]; pos[r.item_index][r.position - 1]++; }
log("position counts item1..3:", JSON.stringify([pos[1], pos[2], pos[3]]));
// express
const ex = { items: Array.from({ length: 30 }, (_, i) => `I${i + 1}`), itemsPerTask: 4, itemsPerVersion: 12, versions: 4, tasks: 9 };
log("express validate:", JSON.stringify(maxdiffPlugin.validateConfig(ex)));
const me = maxdiffPlugin.generate(ex, 5);
log("express neverShown:", JSON.stringify(me.summary.neverShown), "itemsCovered", me.summary.itemsCovered);
log("express exposure min/max:", Math.min(...Object.values(me.summary.itemShowCounts)), Math.max(...Object.values(me.summary.itemShowCounts)));
// minimum validation
log("maxdiff 4 items, 4 per task:", JSON.stringify(maxdiffPlugin.validateConfig({ items: ["a","b","c","d"], itemsPerTask: 4 })));
log("csv head:", designToCSV(m).split("\n").slice(0, 2).join(" / "));

/* ---------------- ACBC: prohibitions + key collision ---------------- */
const acfg = { attributes: [
  { name: "A", levels: ["AB", "A"] },
  { name: "B", levels: ["C", "BC"] },
  { name: "Price", levels: ["1", "2", "3"] },
], prohibitions: [{ a: { attribute: "A", level: "AB" }, b: { attribute: "Price", level: "3" } }], screeningTasks: 6, conceptsPerScreen: 4 };
log("\n## ACBC validate:", JSON.stringify(acbcPlugin.validateConfig(acfg)));
const plan = acbcPlugin.generate(acfg, 1);
log("ACBC stage plan rows:", plan.rows.length, JSON.stringify(plan.rows.map((r) => r.stage)));
const n = normalizeAcbc(acfg);
let violations = 0, total = 0, collisions = 0;
for (let seed = 1; seed <= 200; seed++) {
  const a = submitByo(n, emptyAcbcAnswer(), seed, { A: "A", B: "C", Price: "1" });
  for (const c of a.screens[0].concepts) { total++; if (c.profile.A === "AB" && c.profile.Price === "3") violations++; }
  const keys = a.screens[0].concepts.map((c) => `${c.profile.A}|${c.profile.B}|${c.profile.Price}`);
  if (new Set(keys).size !== keys.length) collisions++;
}
log("ACBC near concepts:", total, "prohibition violations:", violations, "screens with duplicate concept:", collisions);
// key collision: profiles {A:"AB",B:"C"} and {A:"A",B:"BC"} both key to "ABC" + price → one is wrongly treated as a duplicate of the other
let missing = 0;
for (let seed = 1; seed <= 200; seed++) {
  const a = submitByo(n, emptyAcbcAnswer(), seed, { A: "A", B: "BC", Price: "1" });
  // BYO key = "A"+"BC"+"1" = "ABC1"; concept {AB, C, 1} key = "AB"+"C"+"1" = "ABC1" → identical to BYO → never generated
  if (a.screens[0].concepts.some((c) => c.profile.A === "AB" && c.profile.B === "C" && c.profile.Price === "1")) missing++;
}
log("ACBC: concept {AB,C,1} generated in first screen (BYO {A,BC,1}) across 200 seeds:", missing, "(>0 → no key collision: engine acbc.ts joins levels with a literal U+0001 separator, invisible in source)");
// compare with a config where labels cannot collide
const n2 = normalizeAcbc({ ...acfg, attributes: [{ name: "A", levels: ["X", "A"] }, { name: "B", levels: ["C", "Y"] }, { name: "Price", levels: ["1", "2", "3"] }] });
let present = 0;
for (let seed = 1; seed <= 200; seed++) {
  const a = submitByo(n2, emptyAcbcAnswer(), seed, { A: "A", B: "Y", Price: "1" });
  if (a.screens[0].concepts.some((c) => c.profile.A === "X" && c.profile.B === "C" && c.profile.Price === "1")) present++;
}
log("ACBC control (non-colliding labels): equivalent 2-attribute-varied concept generated in first screen across 200 seeds:", present);

import { writeFileSync } from "node:fs";
writeFileSync("/tmp/audit/method/01-designs.out.txt", out.join("\n"));
