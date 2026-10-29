/**
 * THE EXECUTE LOOP'S CLOCK, PROVED ON THE ROUTE (2026-10-29, D-1 close-out, audit C2 guard).
 *
 * `/api/copilot/turn` with `stage: "execute"`, the fake provider's seams only: `budgetMs` (this request's clock in
 * place of ROUTE_BUDGET_MS = 165 s; the item deadline is budgetMs − 15 s) and `faults[]` (one entry per model call:
 * `delayMs` sleeps in front of the call, ≤ 5 s; `kind` throws that ProviderError). The fake `completeJson` answers at
 * once and never waits on a deadline, so a SLOW item is scripted as a delay followed by the very error the real
 * `completeJson` throws when its deadline passes: `ProviderError { kind: "timeout", exhausted: true }`
 * (packages/ai/src/index.ts) — retryable, so the loop's catch takes the "waiting" branch. The 91–150 s window itself
 * cannot be waited out here; its arithmetic is pinned by lib/copilot/stageCap.test.ts.
 *
 *   (a) a single item that takes longer than anything but the item deadline still completes in ONE request —
 *       the first item is never broken out of, never cut short (stage "executed", one item call, latency ≥ delay)
 *   (b) a first item that times out at the item deadline returns `stage: "progress"` with `built: []` and
 *       `pending` = every item (`context.firstItemPaused: true`), NOT the `!built.length` failure path (no 5xx, no
 *       `failure` at the top, so the browser keeps its checkpoint) — and the next request builds it with nothing lost
 *   (c) a later item is still bounded: after a slow first item the loop stops when what is left is under
 *       max(MIN_ITEM_MS, slowest × 1.5) — what is built is handed back, the rest pending; the second request finishes
 *
 *   AI_API_URL=fake: node scripts/stage-cap-api-test.mjs     (Studio :3000; no browser, no runtime)
 */
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function turn(body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${STUDIO}/api/copilot/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const text = await r.text();
      try { return { status: r.status, d: JSON.parse(text) }; } catch { throw new Error(`non-JSON ${r.status}: ${text.slice(0, 120)}`); }
    } catch (e) {
      if (attempt >= 14) throw e;
      console.log(`  …   the Studio did not answer (${String(e.message ?? e).slice(0, 80)}) — waiting for it (${attempt})`);
      await sleep(6000);
    }
  }
}

const BLANK = {
  meta: { id: "sandbox", code: "CAP", title: "Stage cap", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [], flow: [{ type: "end", id: "e1", status: "complete" }],
  logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], designs: [], variables: [], embeddedData: [], listFills: [], scripts: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
};
const message = "Create a two-part survey about coffee";
const plan = { summary: "Coffee survey", items: [
  { id: "p1", title: "Add the habit questions", kind: "create", objects: ["Habits"], reason: "Usage." },
  { id: "p2", title: "Add the closing question", kind: "create", objects: ["Close"], reason: "Open end." },
] };
const reply1 = { kind: "edit", reply: "Habits.", actions: [{ op: "create_question", ref: "FREQ", type: "single_select", text: "How often do you drink coffee?", options: ["Daily", "Weekly", "Rarely"] }] };
const reply2 = { kind: "edit", reply: "Close.", actions: [{ op: "create_question", ref: "THANKS", type: "long_text", text: "Anything else?" }] };
const execute = (extra) => turn({ surveyId: "sandbox", message, definition: BLANK, mode: "generate", stage: "execute", plan, items: ["p1", "p2"], done: [], ...extra });

/*
 * THE MIRROR ROWS THIS SUITE LEAVES BEHIND. Every execute request dual-writes a task row for the sandbox (the
 * durable mirror), and the sandbox's memory store survives a dev-server restart (dumped to a file outside
 * production) — so a `progress` answer leaves a task "running" that the Intelligent Mode panel would reattach in
 * the next suite. Closed here: the open sandbox tasks before this suite (an earlier run's), and the ones it made.
 */
const DONE = new Set(["completed", "failed", "cancelled"]);
async function closeOpenTasks() {
  const r = await fetch(`${STUDIO}/api/copilot/tasks?surveyId=sandbox`).then((x) => x.json()).catch(() => null);
  let n = 0;
  for (const t of r?.tasks ?? []) if (!DONE.has(t.status)) { n++; await fetch(`${STUDIO}/api/copilot/tasks/${t.id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: "sandbox" }) }).catch(() => {}); }
  return n;
}
console.log(`  …   ${await closeOpenTasks()} open sandbox task(s) from earlier runs cancelled`);

/* ================================================================ (a) */
console.log("— (a) a slow single item completes in one request —");
{
  /* budget 20 s → item deadline 5 s; the one item waits 4 s in front of its call: the first item keeps the whole item deadline, nothing stops it early */
  const t0 = Date.now();
  const { status, d } = await turn({ surveyId: "sandbox", message, definition: BLANK, mode: "generate", stage: "execute", plan: { ...plan, items: [plan.items[0]] }, items: ["p1"], done: [], fake: [reply1], budgetMs: 20_000, faults: [{ delayMs: 4000 }] });
  const ms = Date.now() - t0;
  assert.equal(status, 200, JSON.stringify(d).slice(0, 300));
  assert.equal(d.stage, "executed", `one request built it: ${JSON.stringify(d).slice(0, 200)}`);
  assert.equal(d.context.calls.filter((c) => /_item$/.test(c.operation)).length, 1, "one item call");
  assert.ok(ms >= 4000, `the item was given its time (${ms} ms)`);
  assert.ok(d.validation.results.every((r) => r.ok), JSON.stringify(d.validation.errors));
  ok(`a single item that took ${ms} ms of a 5 s item deadline completed in one request (stage executed, applied)`);
}

/* ================================================================ (b) */
console.log("— (b) a first item that times out at the item deadline is a checkpoint, not a loss —");
{
  /* the real provider: a call past its deadline throws ProviderError kind "timeout" (exhausted); scripted here after a 1.5 s wait */
  const { status, d } = await execute({ fake: [reply1, reply2], budgetMs: 20_000, faults: [{ delayMs: 1500, kind: "timeout" }] });
  assert.equal(status, 200, `not a failure status: ${status} ${JSON.stringify(d).slice(0, 200)}`);
  assert.equal(d.ok, true);
  assert.equal(d.stage, "progress", JSON.stringify(d).slice(0, 300));
  assert.deepEqual(d.built, [], "nothing built");
  assert.deepEqual(d.builtIds, []);
  assert.deepEqual(d.pending, ["p1", "p2"], "every item is still pending");
  assert.deepEqual(d.failed, [], "no item is marked failed");
  assert.equal(d.context.firstItemPaused, true, "the pause-before-the-first-item path");
  assert.ok(d.waiting && typeof d.waiting.retryAfterMs === "number", "the browser is told to wait and ask again");
  assert.equal(d.failure, undefined, "no top-level failure: the browser does not forget its checkpoint");
  assert.equal(d.waiting.failure.code === "unusable", false, `the failure named is the timeout, never unusable: ${JSON.stringify(d.waiting.failure)}`);
  ok(`a first item that timed out answered stage: progress, built [], pending [p1, p2], firstItemPaused (retryAfterMs ${d.waiting.retryAfterMs})`);

  /* the browser asks again with the same (empty) checkpoint: the items build, nothing was lost (a 60 s budget: 45 s of item deadline leaves the second item its 30 s minimum) */
  const again = await execute({ fake: [reply1, reply2], budgetMs: 60_000 });
  assert.equal(again.status, 200);
  assert.equal(again.d.stage, "executed", JSON.stringify(again.d).slice(0, 200));
  assert.equal(again.d.context.calls.filter((c) => /_item$/.test(c.operation)).length, 2, "both items built in the next request");
  ok("the next request built both items from the empty checkpoint");

  /* the same pause with an item ALREADY built by an earlier request in `done`: it stays built, the paused one pending */
  const kept = await execute({ fake: [reply2], done: [{ id: "p1", raw: reply1 }], budgetMs: 20_000, faults: [{ delayMs: 500, kind: "timeout" }] });
  assert.equal(kept.status, 200);
  assert.equal(kept.d.stage, "progress", JSON.stringify(kept.d).slice(0, 200));
  assert.deepEqual(kept.d.builtIds, ["p1"], "what an earlier request built is still in the answer");
  assert.deepEqual(kept.d.pending, ["p2"]);
  ok("with p1 built earlier (done[]) and p2 timing out: progress with builtIds [p1], pending [p2]");
}

/* ================================================================ (c) */
console.log("— (c) a later item is bounded by what is left after a slow first item —");
{
  /* budget 50 s → item deadline 35 s; the first item takes 5 s, so 30 s minus a little is left: under max(MIN_ITEM_MS 30 s, slowest × 1.5) — the second item is not started in this request */
  const t0 = Date.now();
  const { status, d } = await execute({ fake: [reply1, reply2], budgetMs: 50_000, faults: [{ delayMs: 5000 }] });
  const ms = Date.now() - t0;
  assert.equal(status, 200, JSON.stringify(d).slice(0, 300));
  assert.equal(d.stage, "progress", JSON.stringify(d).slice(0, 300));
  assert.deepEqual(d.builtIds, ["p1"], "the slow first item is built and handed back");
  assert.equal(d.built.length, 1);
  assert.equal(d.built[0].id, "p1");
  assert.deepEqual(d.pending, ["p2"], "the second item is pending, not lost and not attempted on a clock it cannot fit");
  assert.equal(d.context.calls.filter((c) => /_item$/.test(c.operation)).length, 1, "exactly one item call in this request");
  assert.ok(ms < 15_000, `the request answered as soon as the bound said so (${ms} ms)`);
  ok(`after a ${Math.round(d.context.calls[0].latencyMs / 100) / 10} s first item with 35 s of item deadline, the second item was held back: progress, builtIds [p1], pending [p2] (${ms} ms)`);

  /* and the same two items with time to spare both run in one request */
  const both = await execute({ fake: [reply1, reply2], budgetMs: 60_000, faults: [{ delayMs: 5000 }] });
  assert.equal(both.status, 200);
  assert.equal(both.d.stage, "executed", JSON.stringify(both.d).slice(0, 200));
  assert.equal(both.d.context.calls.filter((c) => /_item$/.test(c.operation)).length, 2);
  ok("with 45 s of item deadline the same slow first item (5 s) leaves room: both items in one request");

  /* the checkpoint continues: the second request builds only p2 */
  const rest = await execute({ fake: [reply2], done: [{ id: "p1", raw: reply1 }], budgetMs: 50_000 });
  assert.equal(rest.d.stage, "executed", JSON.stringify(rest.d).slice(0, 200));
  assert.equal(rest.d.context.calls.filter((c) => /_item$/.test(c.operation)).length, 1, "only the pending item is built");
  ok("the continuation builds only p2 from the checkpoint (one item call), stage executed");
}

console.log(`  …   ${await closeOpenTasks()} mirror task(s) this suite left running cancelled`);
console.log(`\nstage-cap-api-test: ${passed} checks passed`);
