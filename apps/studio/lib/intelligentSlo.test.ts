import { test } from "node:test";
import assert from "node:assert/strict";
import { intelligentSlo } from "./intelligentSlo.ts";

test("service levels from the operation history: met, missed with a sentence, unmeasured when empty", () => {
  const rows = [
    ...Array.from({ length: 60 }, () => ({ source: "engine", status: "saved", created_at: "2026-11-06" })),
    ...Array.from({ length: 38 }, () => ({ source: "model", status: "answered", created_at: "2026-11-06" })),
    { source: "model", status: "failed", created_at: "2026-11-06" }, { source: "model", status: "failed", created_at: "2026-11-06" }, { source: "model", status: "failed", created_at: "2026-11-06" },
  ];
  const r = intelligentSlo(rows);
  const by = Object.fromEntries(r.slos.map((x) => [x.id, x]));
  assert.equal(by.answered.met, false); assert.match(by.answered.breach!, /3 of 101/);
  assert.equal(by.saved.met, true); assert.equal(by.engine.met, true);
  assert.match(r.summary, /1 objective missed/);
  assert.equal(intelligentSlo([]).summary, "No Intelligent Mode activity in the period.");
});
