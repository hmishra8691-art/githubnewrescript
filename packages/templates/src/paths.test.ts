import { test } from "node:test";
import assert from "node:assert/strict";
import { MASTER_DEMO_TEST_PATHS, buildMasterDemoSurvey, explorePaths, comparePaths } from "./index.js";

const def = buildMasterDemoSurvey("paths");

test("explorePaths: reach per element, endings, routes, and a page added behind an impossible branch is never reached", () => {
  const x = explorePaths(def, { count: 60, seed: 7 });
  assert.ok(x.respondents >= 50);
  assert.equal(Object.values(x.endings).reduce((a, b) => a + b, 0), x.respondents);
  assert.ok(x.pages.length > 3);
  assert.equal(x.pages[0]!.reached, x.respondents, "everyone sees the first page");
  assert.ok(x.routes.length >= 1 && x.routes[0]!.count >= 1);
  for (const e of x.elements) assert.ok(e.reached <= x.respondents);

  // a page behind a branch nobody can satisfy shows up as never reached
  const d = structuredClone(def);
  d.flow.push({ id: "br_never", type: "branch", branches: [{ id: "p_never", label: "impossible", condition: { op: "embedded", key: "NOPE_NEVER", operator: "eq", value: "zzz" } as any, children: [{ id: "pg_never", type: "page", questionIds: [] } as any] }], otherwise: [] } as any);
  const y = explorePaths(d, { count: 30, seed: 3 });
  assert.ok(y.neverReached.some((n) => n.id === "pg_never"), JSON.stringify(y.neverReached));
});

test("comparePaths: identical answers never part; two documented paths part with page diffs", () => {
  const p = MASTER_DEMO_TEST_PATHS;
  const same = comparePaths(def, p[0]!.answers, p[0]!.answers, { seed: p[0]!.seed, embedded: p[0]!.embedded });
  assert.equal(same.partsAt, null);
  assert.deepEqual(same.differences, []);
  const a = p.find((x) => x.id === "A")!, b = p.find((x) => x.id === "B")!;
  const c = comparePaths(def, a.answers, b.answers, { seed: a.seed });
  assert.ok(c.partsAt !== null || c.differences.length > 0, "two different documented paths differ somewhere");
});
