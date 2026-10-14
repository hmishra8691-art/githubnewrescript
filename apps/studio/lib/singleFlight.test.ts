import { test } from "node:test";
import assert from "node:assert/strict";
import { singleFlight } from "./singleFlight.ts";

test("F-1: simultaneous callers with the same key share one piece of work", async () => {
  const flight = singleFlight<number>();
  let runs = 0;
  const work = async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return 42; };
  const all = await Promise.all([flight("a", work), flight("a", work), flight("a", work), flight("b", work)]);
  assert.deepEqual(all, [42, 42, 42, 42]);
  assert.equal(runs, 2, "one run for key a, one for key b");
});

test("F-1: a later caller starts fresh, and a failure is not remembered", async () => {
  const flight = singleFlight<number>();
  let runs = 0;
  await assert.rejects(flight("k", async () => { runs++; throw new Error("boom"); }));
  assert.equal(await flight("k", async () => { runs++; return 7; }), 7);
  assert.equal(await flight("k", async () => { runs++; return 8; }), 8);
  assert.equal(runs, 3);
});
