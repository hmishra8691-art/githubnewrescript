import { test } from "node:test";
import assert from "node:assert/strict";
import { conjointPlugin, effectiveProhibition, conceptMatches, type ConjointConfig } from "./conjoint.js";
import { choiceDEfficiency, measureConjointDesign, maxDifferingPairs, type ConjointEfficiency } from "./conjointEfficiency.js";

const eff = (f: { summary?: Record<string, unknown> }) => f.summary!.efficiency as ConjointEfficiency;

/**
 * CONJOINT AUDIT 2026-10-17 — the CBC design contract.
 *
 * What a fielded design must never do (show a prohibited concept, repeat a
 * concept inside a task, silently produce a smaller design than configured)
 * and what it must measurably do (balance levels, be reproducible from its
 * seed, report its D-efficiency), for both methods.
 */

const A = (name: string, levels: string[]) => ({ name, levels });
const four = [A("Brand", ["Alpha", "Beta", "Gamma"]), A("Screen", ["5in", "6in", "7in"]), A("Battery", ["1 day", "2 days", "3 days"]), A("Price", ["$199", "$299", "$399"])];
const base: ConjointConfig = { attributes: four, tasks: 12, alternativesPerTask: 3, versions: 10 };
const METHODS = ["balanced", "efficient"] as const;

const conceptsOf = (rows: Record<string, unknown>[], attrs = four) =>
  rows.filter((r) => Number(r.none_option) !== 1).map((r) => Object.fromEntries(attrs.map((a) => [a.name, String(r[a.name])])));
const tasksOf = (rows: Record<string, unknown>[]) => {
  const m = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) { const k = `${r.version}|${r.task}`; (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
  return m;
};

test("no prohibited concept is ever generated — pair and combination prohibitions, both methods, many seeds", () => {
  const prohibitions = [
    { a: { attribute: "Brand", level: "Gamma" }, b: { attribute: "Price", level: "$399" } },
    { a: { attribute: "Brand", level: "Alpha" }, b: { attribute: "Battery", level: "1 day" }, also: [{ attribute: "Screen", level: "7in" }, { attribute: "Price", level: "$199" }], alsoOp: "or" as const },
  ];
  for (const method of METHODS) {
    for (let seed = 1; seed <= 12; seed++) {
      const f = conjointPlugin.generate({ ...base, prohibitions, method }, seed);
      const bad = conceptsOf(f.rows).filter((c) => prohibitions.some((p) => conceptMatches(c, effectiveProhibition(p))));
      assert.equal(bad.length, 0, `${method} seed ${seed}: ${bad.length} prohibited concepts`);
    }
  }
});

test("no task ever shows the same concept twice", () => {
  for (const method of METHODS) {
    for (const cfg of [base, { ...base, attributes: [A("A", ["1", "2"]), A("B", ["x", "y"]), A("C", ["p", "q"])], alternativesPerTask: 4 }]) {
      const f = conjointPlugin.generate({ ...cfg, method }, 3);
      const attrs = cfg.attributes;
      for (const [k, alts] of tasksOf(f.rows)) {
        const keys = conceptsOf(alts, attrs).map((c) => JSON.stringify(c));
        assert.equal(new Set(keys).size, keys.length, `${method} task ${k} repeats a concept`);
      }
      assert.equal(eff(f).duplicateConceptTasks, 0);
    }
  }
});

test("level balance: pooled counts within 1, every version within 2, and the efficient method keeps the balanced counts exactly", () => {
  const balanced = conjointPlugin.generate({ ...base, method: "balanced" }, 11);
  const efficient = conjointPlugin.generate({ ...base, method: "efficient" }, 11);
  assert.deepEqual(efficient.summary!.levelFrequencies, balanced.summary!.levelFrequencies, "swapping must not change how often a level is shown");
  for (const f of [balanced, efficient]) {
    const concepts = conceptsOf(f.rows);
    for (const a of four) {
      const counts = a.levels.map((l) => concepts.filter((c) => c[a.name] === l).length);
      assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `${a.name} pooled ${counts}`);
      for (let v = 1; v <= 10; v++) {
        const vc = conceptsOf(f.rows.filter((r) => r.version === v));
        const c = a.levels.map((l) => vc.filter((x) => x[a.name] === l).length);
        assert.ok(Math.max(...c) - Math.min(...c) <= 2, `${a.name} version ${v}: ${c}`);
      }
    }
  }
});

test("the efficient method raises per-version D-efficiency well above the balanced one, and the summary reports it", () => {
  const b = eff(conjointPlugin.generate({ ...base, method: "balanced" }, 5));
  const e = eff(conjointPlugin.generate({ ...base, method: "efficient" }, 5));
  assert.ok(b.perVersion.mean! < 0.92, `balanced per-version ${b.perVersion.mean}`);
  assert.ok(e.perVersion.mean! >= 0.97, `efficient per-version ${e.perVersion.mean}`);
  assert.ok(e.perVersion.min! >= 0.95, `efficient worst version ${e.perVersion.min}`);
  assert.ok(e.pooled! >= 0.98, `efficient pooled ${e.pooled}`);
  assert.equal(e.avoidableOverlapPct <= 1, true, `avoidable overlap ${e.avoidableOverlapPct}%`);
  assert.equal(e.perVersion.versions, 10);
});

test("reproducible: same config and seed give identical rows; another seed gives another design", () => {
  for (const method of METHODS) {
    const a = conjointPlugin.generate({ ...base, method }, 42);
    const b = conjointPlugin.generate({ ...base, method }, 42);
    const c = conjointPlugin.generate({ ...base, method }, 43);
    assert.deepEqual(a.rows, b.rows);
    assert.notDeepEqual(a.rows, c.rows);
  }
});

test("a configuration without `method` generates exactly what it generated before (balanced)", () => {
  const absent = conjointPlugin.generate({ ...base }, 9);
  const explicit = conjointPlugin.generate({ ...base, method: "balanced" }, 9);
  assert.deepEqual(absent.rows, explicit.rows);
  assert.equal(absent.summary!.method, "balanced");
});

test("versions and tasks: every version has every task with the configured number of alternatives, plus None", () => {
  const f = conjointPlugin.generate({ ...base, versions: 4, holdoutTasks: 2, noneOption: true, method: "efficient" }, 2);
  const tasks = tasksOf(f.rows);
  assert.equal(tasks.size, 4 * 14);
  for (const [k, alts] of tasks) {
    assert.equal(alts.length, 4, `task ${k}`);
    const none = alts.filter((r) => Number(r.none_option) === 1);
    assert.equal(none.length, 1);
    assert.equal(none[0].alt, 4, "None is alternative m + 1");
    for (const a of four) assert.equal(none[0][a.name], "", "the None row carries no levels");
  }
  assert.equal(f.rows.filter((r) => Number(r.is_holdout) === 1).length, 4 * 2 * 4);
});

test("infeasible or ambiguous configurations are refused with a message, never generated short", () => {
  const two = [A("A", ["a1", "a2"]), A("B", ["b1", "b2"])];
  const msgs = (cfg: ConjointConfig) => conjointPlugin.validateConfig!(cfg);
  assert.match(msgs({ attributes: two, alternativesPerTask: 5, tasks: 2 }).join(" "), /only 4 different concepts/);
  assert.throws(() => conjointPlugin.generate({ attributes: two, alternativesPerTask: 5, tasks: 2 }, 1), /only 4 different concepts/);
  assert.match(msgs({ attributes: [A("task", ["x", "y"]), A("B", ["1", "2"])] }).join(" "), /cannot be an attribute name/);
  assert.match(msgs({ attributes: [A("A", ["x", "x", "y"]), A("B", ["1", "2"])] }).join(" "), /more than once/);
  assert.match(msgs({ attributes: [A("A", ["x", " ", "y"]), A("B", ["1", "2"])] }).join(" "), /blank level/);
  assert.match(msgs({ attributes: two, tasks: 2.5 }).join(" "), /whole number/);
  assert.match(msgs({ attributes: two, method: "random" as never }).join(" "), /Unknown design method/);
  // an infeasible prohibition set: every Gamma concept forbidden
  assert.match(msgs({ ...base, prohibitions: four[3].levels.map((l) => ({ a: { attribute: "Brand", level: "Gamma" }, b: { attribute: "Price", level: l } })) }).join(" "), /appears in no legal concept/);
});

test("D-efficiency: 100% for an optimal design, 0 when an attribute never varies inside a task", () => {
  const attrs = [A("X", ["0", "1"]), A("Y", ["0", "1"])];
  // the foldover pairs of a 2² factorial: every pair differs on every attribute, and X ⟂ Y
  const optimal = [[{ X: "0", Y: "0" }, { X: "1", Y: "1" }], [{ X: "0", Y: "1" }, { X: "1", Y: "0" }]];
  assert.ok(Math.abs(choiceDEfficiency(attrs, optimal)! - 1) < 1e-9);
  const flat = [[{ X: "0", Y: "0" }, { X: "0", Y: "1" }], [{ X: "1", Y: "0" }, { X: "1", Y: "1" }]];
  assert.equal(choiceDEfficiency(attrs, flat), 0);
  assert.equal(maxDifferingPairs(3, 3), 3);
  assert.equal(maxDifferingPairs(4, 2), 4);
  assert.equal(maxDifferingPairs(3, 2), 2);
  const m = measureConjointDesign(attrs, [
    { version: 1, task: 1, alt: 1, X: "0", Y: "0" }, { version: 1, task: 1, alt: 2, X: "1", Y: "1" },
    { version: 1, task: 2, alt: 1, X: "0", Y: "1" }, { version: 1, task: 2, alt: 2, X: "1", Y: "0" },
    { version: 1, task: 2, alt: 3, none_option: 1, X: "", Y: "" },
  ]);
  assert.equal(m.pooled, 1);
  assert.equal(m.overlapPct, 0);
});

test("the design method and the None text are offered in the editor", () => {
  const names = conjointPlugin.configFields.map((f) => f.name);
  assert.ok(names.includes("method") && names.includes("noneLabel"));
  const method = conjointPlugin.configFields.find((f) => f.name === "method")!;
  assert.equal(method.default, "efficient", "new designs are efficient by default");
  assert.doesNotMatch(conjointPlugin.description ?? "", /balanced-overlap/i, "it was never balanced overlap — measured 0% overlap");
});

test("a version too short to identify the model per respondent is reported, not shown as a bare 0%", () => {
  const short = conjointPlugin.generate({ ...base, tasks: 3, versions: 3, method: "efficient" }, 1);
  const e = eff(short);
  assert.equal(e.parameters, 8);
  assert.equal(e.minVersionDegreesOfFreedom, 6);
  assert.equal(e.perVersion.min, 0);
  assert.ok((short.summary!.warnings as string[]).some((w) => /cannot identify the model/.test(w) && /at least 4 tasks/.test(w)));
  assert.ok(!(conjointPlugin.generate(base, 1).summary!.warnings as string[] | undefined ?? []).some((w) => /cannot identify/.test(w)));
});
