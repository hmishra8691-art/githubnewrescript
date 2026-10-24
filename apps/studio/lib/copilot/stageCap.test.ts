import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * THE ~160-SECOND STOP, AND WHY THIS FILE EXISTS (2026-10-24).
 *
 * The 2026-10-17 work added STAGE_SOFT_MS = 90 s so that no new plan item is
 * started past 90 s and the browser drives the next request. The guard was
 * written as
 *
 *     if (newlyBuilt.length && (… || Date.now() >= softStop)) break;
 *
 * so the cap engaged only AFTER an item had come back. A request whose FIRST
 * item was slow was never capped: it ran against `itemDeadline`
 * (ROUTE_BUDGET_MS − GATE_RESERVE_MS = 150 s) and could sit open and silent
 * to ~160 s — exactly the symptom the cap was added to remove, still
 * reachable on every first item.
 *
 * Two things fix it and both are pinned here, because both are one careless
 * edit away from coming back:
 *   1. the stop test is unconditional;
 *   2. the item's own provider deadline is bounded by the cap, so an item
 *      started at 89 s cannot run to 150 s.
 *
 * Neither raises a budget. ROUTE_BUDGET_MS stays 165 s deliberately: it
 * bounds the cost of a request that goes wrong, and the fix is that no single
 * request needs to finish the work.
 */

const here = dirname(fileURLToPath(import.meta.url));
const route = readFileSync(join(here, "..", "..", "app", "api", "copilot", "turn", "route.ts"), "utf8");

test("the budgets are unchanged: 165 s route, 90 s stage, 15 s gate reserve", () => {
  assert.match(route, /const ROUTE_BUDGET_MS = 165_000;/, "the route clock is not raised");
  assert.match(route, /const STAGE_SOFT_MS = 90_000;/, "the stage cap is still 90 s");
  assert.match(route, /const GATE_RESERVE_MS = 15_000;/);
  assert.match(route, /export const maxDuration = 180;/);
});

test("the stage cap applies to the FIRST item, not only to later ones", () => {
  const loop = route.slice(route.indexOf("if (!finalize) for (let i = 0"), route.indexOf("const failedIds"));
  assert.ok(loop.length > 0, "the item loop is found");
  assert.match(loop, /\n\s*if \(Date\.now\(\) >= softStop\) break;/, "the soft stop is tested unconditionally");
  assert.doesNotMatch(
    loop,
    /newlyBuilt\.length && \([^)]*Date\.now\(\) >= softStop/,
    "the soft stop must NOT sit behind `newlyBuilt.length` — that is the first-item hole",
  );
});

test("the 'is there time for another' test keeps its guard, because it needs a timed item", () => {
  const loop = route.slice(route.indexOf("if (!finalize) for (let i = 0"), route.indexOf("const failedIds"));
  assert.match(loop, /if \(newlyBuilt\.length && itemDeadline - Date\.now\(\) < Math\.max\(MIN_ITEM_MS, slowest \* 1\.5\)\) break;/);
});

test("an item's own deadline is bounded by the cap, so a slow first item cannot reach the route budget", () => {
  assert.match(route, /const stepDeadline = Math\.min\(itemDeadline, Math\.max\(Date\.now\(\) \+ MIN_ITEM_MS, softStop\)\);/);
  assert.match(route, /deadline: stepDeadline, schema: COPILOT_REPLY_SCHEMA/, "the item call uses the bounded deadline");
  assert.doesNotMatch(route, /deadline: itemDeadline, schema:/, "nothing still passes the unbounded item deadline to a model call");
});

test("the arithmetic: a first item started at t=0 is cut at the cap, not at the route budget", () => {
  const ROUTE_BUDGET_MS = 165_000, GATE_RESERVE_MS = 15_000, STAGE_SOFT_MS = 90_000, MIN_ITEM_MS = 30_000;
  const startedAt = 0, budgetMs = ROUTE_BUDGET_MS;
  const deadline = startedAt + budgetMs;
  const itemDeadline = deadline - GATE_RESERVE_MS;
  const softStop = startedAt + Math.min(STAGE_SOFT_MS, budgetMs);
  const stepDeadlineAt = (now: number) => Math.min(itemDeadline, Math.max(now + MIN_ITEM_MS, softStop));
  assert.equal(stepDeadlineAt(0), 90_000, "the first item is cut at the cap, not at 150 s");
  assert.equal(stepDeadlineAt(80_000), 110_000, "an item started late still gets its MIN_ITEM_MS floor");
  assert.equal(stepDeadlineAt(140_000), 150_000, "and never past the gate reserve");
  assert.ok(stepDeadlineAt(0) < itemDeadline, "the bound is tighter than the old one");
});

test("the durable mirror cannot fail the turn: every call is optional-chained and the module swallows its own errors", () => {
  assert.match(route, /await mirrorStart\(\{/, "the mirror is started in the execute stage");
  for (const call of [/await mirror\?\.step\(/, /await mirror\?\.finish\(/]) assert.match(route, call);
  assert.doesNotMatch(route, /await mirror\.step\(|await mirror\.finish\(/, "never called without the optional chain");
  const mirrorSrc = readFileSync(join(here, "taskMirror.ts"), "utf8");
  for (const guarded of ["mirrorStart", "step(itemId", "finish(def"]) assert.ok(mirrorSrc.includes(guarded), guarded);
  assert.equal((mirrorSrc.match(/catch \(e\)/g) ?? []).length >= 3, true, "start, commit and finish each catch");
});

test("the completion gate runs against the APPLIED survey, never the editor's copy", () => {
  assert.match(route, /await mirror\?\.finish\(applied\?\.valid \? applied\.def : null\);/);
  assert.ok(
    route.indexOf("await mirror?.finish(applied?.valid") > route.indexOf("let applied = reply.actions.length"),
    "the gate is after the actions are applied to a clone",
  );
});
