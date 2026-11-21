import { test } from "node:test";
import assert from "node:assert/strict";
import { REQUEST_HELP, readResolve } from "./portalRequestsCore.ts";

const ID = "c0000000-0000-0000-0000-0000000105b1";

test("answering a privacy request: done or declined, and a refusal owes the person a reason", () => {
  assert.deepEqual(readResolve({ id: ID, status: "done" }), { id: ID, status: "done", note: "" });
  assert.deepEqual(readResolve({ id: ID, status: "done", note: "  Corrected on 21 November.  " }), { id: ID, status: "done", note: "Corrected on 21 November." });
  assert.deepEqual(readResolve({ id: ID, status: "declined", note: "We must keep this record for seven years by law." }), { id: ID, status: "declined", note: "We must keep this record for seven years by law." });
  for (const bad of [{ id: ID, status: "declined" }, { id: ID, status: "declined", note: "No." }, { id: ID, status: "open" }, { id: "1", status: "done" }, { status: "done" }, { id: ID, status: "done", note: "x".repeat(2001) }, null]) {
    assert.ok("error" in readResolve(bad), JSON.stringify(bad)?.slice(0, 70));
  }
  assert.deepEqual(Object.keys(REQUEST_HELP).sort(), ["access", "correction", "deletion"]);
});
