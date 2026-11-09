import { test } from "node:test";
import assert from "node:assert/strict";
import { conjointPlugin } from "./conjoint.js";
import { inspectConjointDesign } from "./quality.js";

const attrs = ["Brand", "Price", "Screen", "Battery", "Memory", "Storage", "Weight", "Warranty"].map((n) => ({ name: n, levels: ["L1", "L2", "L3"] }));

test("partial profile: k attributes per task, balanced, the rest blank in every alternative", () => {
  const r = conjointPlugin.generate({ attributes: attrs, tasks: 16, alternativesPerTask: 3, versions: 4, attributesPerTask: 4, noneOption: true }, 3);
  const tasks = new Map<string, Record<string, unknown>[]>();
  for (const x of r.rows) { if (Number(x.none_option) === 1) continue; const k = `${x.version}:${x.task}`; (tasks.get(k) ?? tasks.set(k, []).get(k)!).push(x); }
  for (const [k, alts] of tasks) {
    const shown = attrs.filter((a) => alts.some((x) => x[a.name] !== ""));
    assert.equal(shown.length, 4, k);
    for (const a of attrs) { const blanks = alts.filter((x) => x[a.name] === "").length; assert.ok(blanks === 0 || blanks === alts.length, `${k} ${a.name}: all or none blank`); }
  }
  const pp = r.summary!.partialProfile as { shownPerAttribute: { min: number; max: number }; pairsTogether: { min: number; max: number } };
  assert.ok(pp.shownPerAttribute.max - pp.shownPerAttribute.min <= 4, JSON.stringify(pp));
  assert.ok(pp.pairsTogether.min > 0, "every pair of attributes appears together somewhere");
});

test("partial profile: validated, and the design inspector accepts the blanks", () => {
  assert.match(conjointPlugin.validateConfig!({ attributes: attrs, attributesPerTask: 8 }).join(" "), /fewer attributes/);
  assert.match(conjointPlugin.validateConfig!({ attributes: attrs, attributesPerTask: 1 }).join(" "), /at least 2/);
  const r = conjointPlugin.generate({ attributes: attrs, tasks: 16, alternativesPerTask: 3, versions: 2, attributesPerTask: 5 }, 9);
  const issues = inspectConjointDesign({ id: "d", kind: "conjoint", name: "pp", version: 1, seed: 9, config: { attributes: attrs, attributesPerTask: 5 }, file: { format: "json", columns: r.columns, rows: r.rows, summary: r.summary, generatedAt: "" } } as never);
  assert.ok(!issues.some((i) => i.level === "error"), JSON.stringify(issues.filter((i) => i.level === "error")).slice(0, 400));
});

test("the library's partial-profile CBC sample generates: 5 of 10 attributes per task, balanced, no errors", async () => {
  const { DESIGN_VARIANTS } = await import("./designRequest.js");
  const v = DESIGN_VARIANTS["conjoint@partial"];
  assert.equal(v.kind, "conjoint");
  const plugin = conjointPlugin;
  assert.deepEqual(plugin.validateConfig!(v.config as never), []);
  const f = plugin.generate(structuredClone(v.config) as never, 20261109);
  const pp = (f.summary as any).partialProfile;
  assert.equal(pp.attributesPerTask, 5);
  assert.ok(pp.shownPerAttribute.max - pp.shownPerAttribute.min <= 1, JSON.stringify(pp));
  assert.deepEqual([pp.tasksPerVersion, pp.shownPerVersion], [18, { min: 9, max: 9 }], "every respondent sees each attribute in 9 of 18 tasks");
});
