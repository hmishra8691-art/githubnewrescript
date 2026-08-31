import test from "node:test";
import assert from "node:assert/strict";
import { designGeneratorRegistry } from "@rescript/schema";
import {
  conjointPlugin,
  maxdiffPlugin,
  customPlugin,
  designToCSV,
  designFileName,
  registerBuiltinDesignGenerators,
  type ConjointConfig,
  type MaxDiffConfig,
  type CustomDesignConfig,
} from "./index.js";

const conjointConfig: ConjointConfig = {
  attributes: [
    { name: "brand", levels: ["Acme", "Globex", "Initech"] },
    { name: "price", levels: ["$10", "$20", "$30"] },
    { name: "warranty", levels: ["1 year", "2 years", "3 years"] },
  ],
  tasks: 12,
  alternativesPerTask: 3,
  noneOption: true,
  holdoutTasks: 2,
  versions: 2,
};

const maxdiffConfig: MaxDiffConfig = {
  items: ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
  itemsPerTask: 4,
  tasks: 9,
  versions: 2,
};

const customConfig: CustomDesignConfig = {
  rows: 20,
  versions: 2,
  columnsSpec: [
    { name: "seq", kind: "sequence" },
    { name: "cell", kind: "random_int", min: 1, max: 4 },
    { name: "arm", kind: "random_level", levels: ["control", "test1", "test2"] },
    { name: "study", kind: "constant", value: "S-100" },
    { name: "blk", kind: "block", blockSize: 5 },
    { name: "expr", kind: "expression", expression: "price * 1.2" },
  ],
};

test("registry: built-in generators are registered at module load", () => {
  registerBuiltinDesignGenerators(); // idempotent
  for (const kind of ["conjoint", "maxdiff", "custom"]) {
    assert.ok(designGeneratorRegistry.has(kind), `missing ${kind}`);
  }
  assert.equal(designGeneratorRegistry.get("conjoint"), conjointPlugin);
});

test("determinism: same seed gives identical rows, different seed differs", () => {
  for (const [plugin, config] of [
    [conjointPlugin, conjointConfig],
    [maxdiffPlugin, maxdiffConfig],
    [customPlugin, customConfig],
  ] as const) {
    const a = plugin.generate(config as never, 12345);
    const b = plugin.generate(config as never, 12345);
    assert.deepEqual(a.rows, b.rows, `${plugin.kind}: same seed must match`);
    assert.deepEqual(a.columns, b.columns);

    const c = plugin.generate(config as never, 99999);
    assert.notDeepEqual(
      a.rows,
      c.rows,
      `${plugin.kind}: different seed should differ`,
    );
  }
});

test("conjoint: columns, row count, and holdout flags", () => {
  const out = conjointPlugin.generate(conjointConfig, 42);
  assert.deepEqual(out.columns, [
    "version",
    "task",
    "alt",
    "is_holdout",
    "brand",
    "price",
    "warranty",
    "none_option",
  ]);
  // 2 versions x (12 + 2 holdout) tasks x (3 alternatives + 1 none row)
  assert.equal(out.rows.length, 2 * 14 * 4);
  for (const row of out.rows) {
    const holdout = (row.task as number) > 12 ? 1 : 0;
    assert.equal(row.is_holdout, holdout);
    if (row.none_option === 1) {
      assert.equal(row.brand, "");
    } else {
      assert.ok(["Acme", "Globex", "Initech"].includes(row.brand as string));
    }
  }
});

test("conjoint: one-way level balance within factor 2", () => {
  const config: ConjointConfig = {
    attributes: [
      { name: "a1", levels: ["x", "y", "z"] },
      { name: "a2", levels: ["p", "q", "r"] },
      { name: "a3", levels: ["u", "v", "w"] },
    ],
    tasks: 12,
    alternativesPerTask: 3,
    versions: 1,
  };
  const out = conjointPlugin.generate(config, 7);
  const summary = out.summary as {
    levelFrequencies: Record<string, Record<string, number>>;
    balanceScores: Record<string, number>;
  };
  for (const attr of ["a1", "a2", "a3"]) {
    const counts = Object.values(summary.levelFrequencies[attr]);
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    assert.ok(min > 0, `${attr}: every level must appear`);
    assert.ok(
      max / min <= 2,
      `${attr}: balance ratio ${max}/${min} exceeds 2`,
    );
    assert.equal(summary.balanceScores[attr], max / min);
  }
});

test("conjoint: no duplicate alternatives within a task", () => {
  const out = conjointPlugin.generate(conjointConfig, 42);
  const byTask = new Map<string, string[]>();
  for (const row of out.rows) {
    if (row.none_option === 1) continue;
    const key = `${row.version}|${row.task}`;
    const profile = `${row.brand}|${row.price}|${row.warranty}`;
    const list = byTask.get(key) ?? [];
    list.push(profile);
    byTask.set(key, list);
  }
  for (const [key, profiles] of byTask) {
    assert.equal(
      new Set(profiles).size,
      profiles.length,
      `duplicate alternative in task ${key}`,
    );
  }
});

test("conjoint: validateConfig catches bad configs", () => {
  assert.ok(
    conjointPlugin.validateConfig!({
      attributes: [{ name: "only", levels: ["a", "b"] }],
    }).length > 0,
    "needs >= 2 attributes",
  );
  assert.ok(
    conjointPlugin.validateConfig!({
      attributes: [
        { name: "a", levels: ["x"] },
        { name: "b", levels: ["p", "q"] },
      ],
    }).length > 0,
    "needs >= 2 levels per attribute",
  );
  assert.ok(
    conjointPlugin.validateConfig!({
      ...conjointConfig,
      alternativesPerTask: 1,
    }).length > 0,
    "alternativesPerTask >= 2",
  );
  assert.ok(
    conjointPlugin.validateConfig!({ ...conjointConfig, tasks: 0 }).length > 0,
    "tasks >= 1",
  );
  assert.equal(conjointPlugin.validateConfig!(conjointConfig).length, 0);
});

test("maxdiff: shape, coverage, and show-count balance within +/-2 of mean", () => {
  const out = maxdiffPlugin.generate(maxdiffConfig, 2024);
  assert.deepEqual(out.columns, [
    "version",
    "task",
    "position",
    "item_index",
    "item_label",
  ]);
  // 2 versions x 9 tasks x 4 items
  assert.equal(out.rows.length, 2 * 9 * 4);

  // No repeated item within a task; positions 1..itemsPerTask.
  const byTask = new Map<string, number[]>();
  for (const row of out.rows) {
    const key = `${row.version}|${row.task}`;
    const list = byTask.get(key) ?? [];
    list.push(row.item_index as number);
    byTask.set(key, list);
    assert.ok((row.position as number) >= 1 && (row.position as number) <= 4);
  }
  for (const [key, items] of byTask) {
    assert.equal(new Set(items).size, 4, `repeat item in task ${key}`);
  }

  const summary = out.summary as {
    itemShowCounts: Record<string, number>;
    meanShowsPerItem: number;
    pairCooccurrence: { min: number; max: number };
  };
  const mean = summary.meanShowsPerItem;
  for (const [item, count] of Object.entries(summary.itemShowCounts)) {
    assert.ok(
      Math.abs(count - mean) <= 2,
      `item ${item} shown ${count}, mean ${mean}`,
    );
  }
  assert.ok(summary.pairCooccurrence.max >= summary.pairCooccurrence.min);
});

test("maxdiff: validateConfig catches bad configs", () => {
  assert.ok(
    maxdiffPlugin.validateConfig!({ items: ["A", "B", "C", "D"], itemsPerTask: 4 })
      .length > 0,
    "needs itemsPerTask + 1 items",
  );
  assert.ok(
    maxdiffPlugin.validateConfig!({
      items: ["A", "B", "C", "D", "E"],
      itemsPerTask: 2,
    }).length > 0,
    "itemsPerTask >= 3",
  );
  assert.equal(maxdiffPlugin.validateConfig!(maxdiffConfig).length, 0);
});

test("custom: column kinds behave as specified", () => {
  const out = customPlugin.generate(customConfig, 11);
  assert.deepEqual(out.columns, [
    "version",
    "row",
    "seq",
    "cell",
    "arm",
    "study",
    "blk",
    "expr",
  ]);
  assert.equal(out.rows.length, 40);
  for (const row of out.rows) {
    assert.equal(row.seq, row.row); // sequence restarts per version
    assert.ok((row.cell as number) >= 1 && (row.cell as number) <= 4);
    assert.ok(["control", "test1", "test2"].includes(row.arm as string));
    assert.equal(row.study, "S-100");
    assert.equal(row.blk, Math.ceil((row.row as number) / 5));
    assert.equal(row.expr, "price * 1.2");
  }
  // random_level frequency balancing: 40 picks over 3 levels -> 13/13/14.
  const summary = out.summary as {
    levelCounts: Record<string, Record<string, number>>;
  };
  const counts = Object.values(summary.levelCounts.arm);
  assert.equal(counts.reduce((a, b) => a + b, 0), 40);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
});

test("custom: validateConfig catches bad configs", () => {
  assert.ok(
    customPlugin.validateConfig!({ rows: 0, columnsSpec: [] }).length > 0,
  );
  assert.ok(
    customPlugin.validateConfig!({
      rows: 5,
      columnsSpec: [{ name: "x", kind: "random_int" }],
    }).length > 0,
    "random_int needs min/max",
  );
  assert.equal(customPlugin.validateConfig!(customConfig).length, 0);
});

test("CSV export: shape and quoting", () => {
  const csv = designToCSV({
    columns: ["a", "b", "c"],
    rows: [
      { a: 1, b: 'He said "hi"', c: "x,y" },
      { a: 2, b: "line\nbreak", c: null },
    ],
  });
  const lines = csv.split("\n");
  assert.equal(lines[0], "a,b,c");
  assert.equal(lines[1], '1,"He said ""hi""","x,y"');
  assert.equal(lines[2], '2,"line');
  assert.equal(lines[3], 'break",');
  assert.ok(csv.endsWith("\n"));

  // Round shape: a generated design serializes to header + one line per row.
  const out = maxdiffPlugin.generate(maxdiffConfig, 5);
  const designCsv = designToCSV(out);
  const designLines = designCsv.trimEnd().split("\n");
  assert.equal(designLines.length, 1 + out.rows.length);
  assert.equal(designLines[0], out.columns.join(","));
});

test("designFileName builds a clean slug", () => {
  assert.equal(
    designFileName("conjoint", "Pricing Study 2026!", 3, "csv"),
    "conjoint_pricing-study-2026_v3.csv",
  );
  assert.equal(
    designFileName("maxdiff", "Brand List", 1, ".csv"),
    "maxdiff_brand-list_v1.csv",
  );
});
