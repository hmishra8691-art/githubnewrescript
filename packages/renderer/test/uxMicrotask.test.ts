/**
 * AUDIT 2026-10-30 D8 (a) — the sandboxed frame bounds promise chains (renderer src/uxSandbox.ts UX_MICROTASK_GUARD).
 *
 *   node --experimental-strip-types --no-warnings --test packages/renderer/test/*.test.ts
 *
 * The guard is the frame's own source text; it runs here in a vm context of its own (its own Promise), exactly as
 * the frame runs it, so wrapping `then` there never touches the test runner's promises.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { UX_MICROTASK_GUARD, UX_MICROTASK_LIMIT, uxSandboxDoc } from "../src/uxSandbox.ts";

function frame(limit = 50) {
  const errors: string[] = [];
  const ctx = vm.createContext({ errors, setTimeout, queueMicrotask });
  vm.runInContext(`var window = globalThis; var CFG = { microLimit: ${limit} }; function fail(e) { errors.push(e.message); }\n${UX_MICROTASK_GUARD}\nglobalThis.microReset = microReset;`, ctx);
  return { ctx, errors, run: (code: string) => vm.runInContext(code, ctx) };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

test("an endless promise chain is stopped past the limit, with the loop guard's kind of message", async () => {
  const f = frame(50);
  f.run(`globalThis.steps = 0; function spin() { steps++; return Promise.resolve().then(spin); } spin();`);
  await settle();
  const steps = f.run("steps") as number;
  assert.ok(steps >= 2 && steps <= 51, `stopped at the limit: ${steps}`);
  assert.equal(f.errors.length, 1, "reported once");
  assert.match(f.errors[0] ?? "", /a promise chain ran more than 50 steps in one go, so the script was stopped/);
});

test("queueMicrotask recursion is stopped too; a later entry (slice) starts counting again", async () => {
  const f = frame(20);
  f.run(`globalThis.n = 0; function q() { n++; queueMicrotask(q); }`);
  f.run("q()");
  await settle();
  assert.ok((f.run("n") as number) <= 21, `bounded: ${f.run("n")}`);
  assert.match(f.errors[0] ?? "", /promise chain ran more than 20 steps/);
  f.run("microReset(); n = 0");
  f.run(`Promise.resolve(1).then((v) => v + 1).then((v) => { globalThis.done = v; })`);
  await settle();
  assert.equal(f.run("done"), 2, "an ordinary short chain still runs after a reset");
});

test("ordinary promise use (catch/finally, a few dozen steps) is untouched, and `then` cannot be swapped back", async () => {
  const f = frame(UX_MICROTASK_LIMIT);
  f.run(`globalThis.out = []; let p = Promise.resolve(0); for (let i = 0; i < 40; i++) p = p.then((v) => v + 1); p.then((v) => out.push(v)).finally(() => out.push("f")); Promise.reject(new Error("x")).catch((e) => out.push(e.message));`);
  await settle();
  assert.ok((f.run("out") as unknown[]).includes(40) && (f.run("out") as unknown[]).includes("f") && (f.run("out") as unknown[]).includes("x"));
  f.run(`try { Promise.prototype.then = function () { return "native"; }; } catch (e) {}`);
  assert.notEqual(f.run(`typeof Promise.resolve().then(() => 1)`), "string", "the wrapped then stays");
});

test("the frame document carries the guard and resets it with the loop counter", () => {
  const doc = uxSandboxDoc({ aliases: {} });
  assert.ok(doc.includes("function microTick()"));
  assert.ok(doc.includes("function slice() { loops = 0; microReset(); }"));
  assert.ok(doc.includes(`"microLimit":${UX_MICROTASK_LIMIT}`));
  assert.ok(doc.includes('m.type === "ping"') && doc.includes('send("pong"'), "the frame answers the host's heartbeat");
  assert.ok(!doc.includes("__MICRO__") && !doc.includes("__CFG__"));
});
