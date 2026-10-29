import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * THE STAGE CAP, AND A FIX THAT WAS WORSE THAN THE BUG (2026-10-25).
 *
 * 2026-10-17 added STAGE_SOFT_MS = 90 s: past it no NEW plan item is started,
 * what is built is handed back as a checkpoint, and the browser asks for the
 * next batch. The test sits behind `newlyBuilt.length`.
 *
 * On 2026-10-24 that guard was split in two, the soft-stop half made
 * unconditional, and each item given its own deadline bounded by the cap
 * (`stepDeadline`), on the reasoning that a request whose FIRST item is slow
 * is never capped and can sit open to ~160 s. The reasoning was right. The
 * fix was wrong on both halves, and this file now exists to stop it being
 * made again:
 *
 *   • UNCONDITIONAL SOFT STOP — at i = 0 the clock reads a few hundred ms, far
 *     below `softStop`, so the test does not fire there and nothing was
 *     fixed. What it did do is break out with nothing built whenever the work
 *     BEFORE the loop (auth, the survey, the research context, the brief
 *     layering, and the durable mirror's first round trip) ran past 90 s —
 *     straight into the `!built.length` path, which answers `unusable`, and
 *     `unusable` is in the browser's `forget()` list, so the checkpoint is
 *     DISCARDED. A new way to lose work, in the name of not losing work.
 *
 *   • BOUNDED PER-ITEM DEADLINE — `min(itemDeadline, max(now + MIN_ITEM_MS,
 *     softStop))` is a `min` against `itemDeadline` evaluated while
 *     `now < softStop`, so it was never larger and in production always
 *     smaller: the first item went from 150 s to 90 s and every later item
 *     from `150 − t` to `max(30, 90 − t)`. An item that legitimately needed
 *     91–150 s stopped working: it timed out, the turn failed, and Resume
 *     re-entered with the same cap and timed out again. A survey that used to
 *     build became one that could never build.
 *
 * What actually remains, and who owns it. The multi-item case is already
 * handled by the `slowest * 1.5` half: an item that took 80 s stops the next
 * from starting, because 1.5 × 80 s does not fit in what is left. The case
 * that reaches ~160 s is ONE item that itself needs more than the clock, and
 * no amount of stopping earlier fixes that — you cannot checkpoint the middle
 * of a single model call. It is fixed by not having to finish it in this
 * request, which is the durable runner's job (lib/copilot/runner.ts), not
 * this loop's. Being slow beats being impossible.
 */

const here = dirname(fileURLToPath(import.meta.url));
const route = readFileSync(join(here, "..", "..", "app", "api", "copilot", "turn", "route.ts"), "utf8");
const loop = route.slice(route.indexOf("if (!finalize) for (let i = 0"), route.indexOf("const failedIds"));

test("the budgets are unchanged: 165 s route, 90 s stage, 15 s gate reserve, 30 s minimum item", () => {
  assert.match(route, /const ROUTE_BUDGET_MS = 165_000;/, "the route clock is not raised");
  assert.match(route, /const STAGE_SOFT_MS = 90_000;/, "the stage cap is still 90 s");
  assert.match(route, /const GATE_RESERVE_MS = 15_000;/);
  assert.match(route, /const MIN_ITEM_MS = 30_000;/);
  assert.match(route, /export const maxDuration = 180;/);
});

test("the stop test is ONE statement and stays behind `newlyBuilt.length`", () => {
  assert.ok(loop.length > 0, "the item loop is found");
  assert.match(
    loop,
    /if \(newlyBuilt\.length && \(itemDeadline - Date\.now\(\) < Math\.max\(MIN_ITEM_MS, slowest \* 1\.5\) \|\| Date\.now\(\) >= softStop\)\) break;/,
    "both halves in one test, guarded",
  );
  assert.doesNotMatch(
    loop,
    /\n\s*if \(Date\.now\(\) >= softStop\) break;/,
    "an UNGUARDED soft stop breaks with nothing built and makes the browser discard its checkpoint",
  );
});

test("the per-item deadline (D-1, 2026-10-29): the FIRST item keeps the whole item deadline; later items are bounded by one cap plus one minimum item from their own start", () => {
  assert.doesNotMatch(route, /stepDeadline/, "the 2026-10-24 shape — a per-item deadline bounded by the cap for EVERY item — is not back");
  assert.match(route, /const callDeadline = newlyBuilt\.length \? Math\.min\(itemDeadline, t0 \+ STAGE_SOFT_MS \+ MIN_ITEM_MS\) : itemDeadline;/, "the first item is never shortened");
  assert.match(route, /deadline: callDeadline, schema: COPILOT_REPLY_SCHEMA/, "the item call uses it");
  assert.equal((route.match(/const itemDeadline = deadline - GATE_RESERVE_MS;/g) ?? []).length, 1);
});

test("a 91–150 s single item still completes (audit C2); a 170 s first item yields a progress checkpoint, not a loss", () => {
  const ROUTE_BUDGET_MS = 165_000, GATE_RESERVE_MS = 15_000, STAGE_SOFT_MS = 90_000, MIN_ITEM_MS = 30_000;
  const itemDeadline = ROUTE_BUDGET_MS - GATE_RESERVE_MS;
  const callDeadline = (t0: number, built: number) => (built ? Math.min(itemDeadline, t0 + STAGE_SOFT_MS + MIN_ITEM_MS) : itemDeadline);
  /* the first item of a request: the full 150 s, so an item that needs 91–150 s builds */
  for (const needs of [91_000, 120_000, 150_000]) assert.ok(needs <= callDeadline(500, 0), `${needs / 1000} s first item completes`);
  /* a 170 s first item cannot be built in one request: it times out at the item deadline … */
  assert.ok(170_000 > callDeadline(500, 0));
  /* … and the route answers a progress checkpoint — nothing built, everything pending, the browser keeps what earlier rounds built and asks again */
  assert.match(route, /if \(waiting && !finalize && !halted\) \{/, "the pause-before-the-first-item path");
  assert.match(route, /stage: "progress", built: \[\], builtIds: \[\], pending: planPending/, "a checkpoint with nothing built");
  assert.ok(route.indexOf('stage: "progress", built: [], builtIds: []') < route.indexOf('describeFailure("unusable")'), "before the unusable failure path, which makes the browser discard its checkpoint");
  /* a later item: never larger than the item deadline, never longer than one cap plus one minimum item from its start */
  assert.equal(callDeadline(10_000, 1), 130_000);
  assert.equal(callDeadline(60_000, 1), 150_000);
  assert.ok(callDeadline(85_000, 2) <= itemDeadline);
});

test("a SLOW first item, not only a paused one, reaches the checkpoint: the provider's deadline is a retryable timeout, the meter rethrows it, the loop waits (D-1 close-out, 2026-10-29)", () => {
  /*
   * The chain a 170 s first item takes in production, pinned link by link so the `progress` path above is not
   * a path only a 429 can reach: the item call carries `callDeadline` → `completeJson` turns its own abort at
   * that deadline into ProviderError { kind: "timeout", exhausted } → "timeout" is RETRYABLE → `meteredCore`
   * rethrows (never swallows into { ok: false }) → the loop's catch sees a retryable provider error and sets
   * `waiting` (retryAfterMs 0 for a timeout) → nothing built + waiting → stage "progress", pending = all.
   * The behavioural proof on the route's seams is scripts/stage-cap-api-test.mjs.
   */
  const ai = readFileSync(join(here, "..", "..", "..", "..", "packages", "ai", "src", "index.ts"), "utf8");
  const provider = readFileSync(join(here, "..", "..", "..", "..", "packages", "ai", "src", "provider.ts"), "utf8");
  const meterRun = readFileSync(join(here, "..", "meterRun.ts"), "utf8");
  assert.match(ai, /if \(\(e as Error\)\?\.name === "AbortError"\) \{\s*throw new ProviderError\(\{ kind: "timeout", detail: `\$\{Math\.round\(timeoutMs \/ 1000\)\} seconds`, exhausted: true \}\);/, "an abort at the deadline is a timeout ProviderError");
  assert.match(ai, /const timeoutMs = Number\.isFinite\(options\.deadline\) \? Math\.max\(1_000, Math\.min\(askedMs, Math\.round\(\(options\.deadline as number\) - startedAt\)\)\) : askedMs;/, "the caller's deadline is the call's timeout");
  assert.match(provider, /const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set\(\[[^\]]*"timeout"[^\]]*\]\);/, "a timeout is retryable");
  assert.ok((meterRun.match(/\} catch \(e\) \{\s*(?:if \(holdOk\) )?await meter\.release\(hold(?:Ok)?\)\.catch\(\(\) => \{\}\);\s*throw e;/g) ?? []).length >= 2, "the meter releases its hold and rethrows — the error reaches the loop");
  assert.match(loop, /\} catch \(e\) \{\s*const failure = failureOfError\(e, `plan item \$\{item\.id\}`\);\s*if \(isProviderError\(e\) && \(e\.retryable \|\| !\["bad_request"\]\.includes\(e\.kind\)\)\) \{/, "the loop's catch classifies a provider error");
  assert.match(loop, /if \(e\.retryable\) waiting = \{ retryAfterMs: Math\.max\(0, Math\.round\(e\.retryAfterMs \?\? \(e\.kind === "timeout" \? 0 : 5000 \+ Math\.random\(\) \* 5000\)\)\), failure \};/, "a retryable error (a timeout among them) WAITS, it does not halt");
  assert.ok(loop.indexOf("if (e.retryable) waiting =") < loop.indexOf("planFailures.push({ id: item.id, failure });"), "and breaks before the item could be marked failed");
  /* the fake provider never waits on a deadline: the suite scripts the same error after a delay */
  assert.match(ai, /if \(aiProviderName\(\) === "fake"\) \{[\s\S]*?reportFake\("chat", systemText \+ user, 20\);\s*return \{\};/, "the fake completeJson answers at once (so a slow item is scripted as delay + timeout)");
  assert.match(route, /if \(f\?\.delayMs\) await sleepMs\(Math\.min\(5000, f\.delayMs\)\);\s*if \(f\?\.kind\) throw new ProviderError\(\{ kind: f\.kind, status: f\.status, retryAfterMs: f\.retryAfterMs, detail: "scripted", host: "fake", exhausted: true \}\);/, "the seam: a delay, then a scripted ProviderError");
});

test("the arithmetic: the `slowest * 1.5` half already stops a SECOND item running into an overrun", () => {
  const ROUTE_BUDGET_MS = 165_000, GATE_RESERVE_MS = 15_000, STAGE_SOFT_MS = 90_000, MIN_ITEM_MS = 30_000;
  const startedAt = 0;
  const itemDeadline = startedAt + ROUTE_BUDGET_MS - GATE_RESERVE_MS;   // 150 s
  const softStop = startedAt + Math.min(STAGE_SOFT_MS, ROUTE_BUDGET_MS); // 90 s
  const stops = (now: number, slowest: number, built: number) =>
    built > 0 && (itemDeadline - now < Math.max(MIN_ITEM_MS, slowest * 1.5) || now >= softStop);

  assert.equal(stops(80_000, 80_000, 1), true, "after a slow 80 s item the next does not start (1.5x does not fit)");
  assert.equal(stops(95_000, 5_000, 1), true, "past the 90 s cap nothing new starts, however fast the items are");
  assert.equal(stops(20_000, 20_000, 1), false, "two quick items still both run");
  assert.equal(stops(0, 0, 0), false, "the FIRST item always gets its attempt — this is the point of the guard");
  assert.equal(stops(95_000, 5_000, 0), false, "even a late start attempts one item rather than returning nothing");
});

test("the known limitation is a limitation, not a regression: one slow item may still reach the item deadline", () => {
  /*
   * Asserted so that it is a deliberate, visible property rather than a
   * surprise — and so the next person to notice it reaches for the runner
   * instead of shortening the item again.
   */
  const itemDeadline = 165_000 - 15_000;
  assert.equal(itemDeadline, 150_000, "a single item may run to 150 s; the gate reserve then takes it to ~165 s");
  assert.match(route, /ONE item that itself needs more than the/, "the route says so where the guard is");
  assert.match(route, /belongs to the durable runner, not to this loop/, "and says who owns it");
});

test("the durable mirror cannot fail the turn: every call is optional-chained and the module swallows its own errors", () => {
  assert.match(route, /await mirrorStart\(\{/, "the mirror is started in the execute stage");
  for (const call of [/await mirror\?\.step\(/, /await mirror\?\.finish\(/]) assert.match(route, call);
  assert.doesNotMatch(route, /await mirror\.step\(|await mirror\.finish\(/, "never called without the optional chain");
  const mirrorSrc = readFileSync(join(here, "taskMirror.ts"), "utf8");
  assert.ok((mirrorSrc.match(/catch \(e\)/g) ?? []).length >= 3, "start, commit and finish each catch");
});

test("the completion gate runs against the APPLIED survey, never the editor's copy", () => {
  assert.match(route, /await mirror\?\.finish\(applied\?\.valid \? applied\.def : null, charge\);/, "with the turn's own spend, so the task total reconciles (audit M7)");
  assert.ok(
    route.indexOf("await mirror?.finish(applied?.valid") > route.indexOf("let applied = reply.actions.length"),
    "the gate is after the actions are applied to a clone",
  );
});
