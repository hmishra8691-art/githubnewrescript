import { test } from "node:test";
import assert from "node:assert/strict";
import { randomAxes, toggleRandomAxis } from "./randomAxes.ts";

/*
 * ONE RANDOMIZATION SETTING, TWO PLACES TO EDIT IT. The builder's
 * "randomize images / buckets / cards" toggles write the same
 * `randomization` Properties → Randomization edits.
 */
test("randomAxes — off, a single scope, several scopes", () => {
  assert.deepEqual(randomAxes(undefined), []);
  assert.deepEqual(randomAxes({ enabled: false, method: "shuffle", scope: "rows" } as never), []);
  assert.deepEqual(randomAxes({ enabled: true, method: "none" } as never), []);
  assert.deepEqual(randomAxes({ enabled: true, method: "shuffle" } as never), ["options"], "the default scope is options");
  assert.deepEqual(randomAxes({ enabled: true, method: "shuffle", scope: "rows", scopes: ["rows", "options"] } as never), ["rows", "options"]);
});

test("toggleRandomAxis — on, a second axis, off again; other fields survive", () => {
  const a = toggleRandomAxis(undefined, "rows", true);
  assert.deepEqual(randomAxes(a), ["rows"]);
  assert.equal(a?.method, "shuffle");
  const b = toggleRandomAxis({ ...(a as object), showOnly: 3 } as never, "options", true);
  assert.deepEqual(randomAxes(b), ["rows", "options"]);
  assert.equal((b as { showOnly?: number }).showOnly, 3, "unrelated settings are kept");
  assert.equal(b?.scope, "rows", "the primary scope stays");
  const c = toggleRandomAxis(b, "rows", false);
  assert.deepEqual(randomAxes(c), ["options"]);
  assert.equal(c?.scopes, undefined);
  const d = toggleRandomAxis(c, "options", false);
  assert.equal(d?.enabled, false);
  assert.deepEqual(randomAxes(d), []);
});
