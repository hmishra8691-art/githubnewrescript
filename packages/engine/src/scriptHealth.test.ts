import test from "node:test";
import assert from "node:assert/strict";
import { aggregateScriptHealth, mergeScriptHealth, redactScriptMessage, redactionSet, sanitizeScriptHealth, scriptHealthChipText, SCRIPT_HEALTH_LIMITS } from "./scriptHealth.js";

/* S1c item 1/2 (D11 / SE-30): the save route's sanitiser and the Studio's aggregate of live script failures */

test("redaction: answer and embedded values, e-mails and long digit runs never survive; 200 chars at most", () => {
  const red = redactionSet({ q1: "Jane Smith", q2: ["Coffee"], q3: 42, q4: 123456 }, { PANEL_ID: "PX-77" });
  const m = redactScriptMessage("TypeError: cannot read 'x' of Jane Smith (Coffee) id PX-77 mail jane@ex.com tel 0612345678 small 42", red);
  assert.ok(!m.includes("Jane"), m);
  assert.ok(!m.includes("Coffee"), m);
  assert.ok(!m.includes("PX-77"), m);
  assert.ok(!m.includes("jane@ex.com"), m);
  assert.ok(!m.includes("0612345678"), m);
  assert.ok(m.includes("small 42"), "short numbers stay (codes, counts)");
  assert.equal(redactScriptMessage("x".repeat(500)).length, SCRIPT_HEALTH_LIMITS.message);
  assert.equal(redactScriptMessage("a\u0000b\nc"), "a b c");
});

test("sanitise: known kinds only, bounded fields, counts clamped, duplicates merged, 50 entries at most", () => {
  const raw = [
    { script: "uxb_1", name: "Spend band", kind: "ux_error", page: "p1", message: "boom", count: 3, browser: "Chrome desktop", extra: "dropped" },
    { script: "uxb_1", kind: "ux_error", page: "p1", message: "boom again", count: 2 },
    { script: "uxb_2", kind: "nonsense", message: "x" },
    { kind: "ux_error", message: "no script" },
    { script: "s1", kind: "logic_timeout", message: "late", count: -5 },
    { script: "s2", kind: "write_refused", message: "big", count: 1e9 },
    "junk", null,
  ];
  const out = sanitizeScriptHealth(raw);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { script: "uxb_1", name: "Spend band", kind: "ux_error", page: "p1", message: "boom", count: 5, browser: "Chrome desktop" });
  assert.equal(out[1]!.count, 1);
  assert.equal(out[2]!.count, SCRIPT_HEALTH_LIMITS.count);
  assert.deepEqual(sanitizeScriptHealth("nope"), []);
  const many = Array.from({ length: 80 }, (_, i) => ({ script: `s${i}`, kind: "logic_error", message: "m" }));
  assert.equal(sanitizeScriptHealth(many).length, SCRIPT_HEALTH_LIMITS.entries);
  // the route redacts again against the save's own answers
  assert.equal(sanitizeScriptHealth([{ script: "a", kind: "ux_error", message: "bad value Jane Smith" }], ["Jane Smith"])[0]!.message, "bad value …");
});

test("merge keeps the larger count across a reload (the collector restarts from zero)", () => {
  const stored = [{ script: "a", kind: "ux_error", message: "first", count: 4 }];
  const posted = sanitizeScriptHealth([{ script: "a", kind: "ux_error", message: "second", count: 1 }, { script: "b", kind: "watchdog", message: "stopped", count: 1 }]);
  const m = mergeScriptHealth(stored, posted);
  assert.equal(m.length, 2);
  assert.deepEqual(m[0], { script: "a", kind: "ux_error", message: "first", count: 4 });
  assert.equal(mergeScriptHealth(undefined, posted), posted);
});

test("aggregate: per script failures, sessions affected, last seen, top messages, pages; the chip's words", () => {
  const rows = [
    { telemetry: { v: 1, scriptHealth: [{ script: "uxb_t", name: "Thrower", kind: "ux_error", page: "p1", message: "boom", count: 2, browser: "Chrome desktop" }] }, last_saved_at: "2026-10-30T10:00:00Z" },
    { telemetry: { scriptHealth: [{ script: "uxb_t", name: "Thrower", kind: "ux_error", page: "p2", message: "boom", count: 1 }, { script: "s_logic", name: "Spend band", kind: "logic_timeout", page: "p2", message: "late", count: 1 }] }, last_saved_at: "2026-10-30T11:00:00Z" },
    { telemetry: { v: 1 }, last_saved_at: "2026-10-30T12:00:00Z" },
    { telemetry: null },
  ];
  const s = aggregateScriptHealth(rows);
  assert.equal(s.sessions, 4);
  assert.equal(s.affected, 2);
  assert.equal(s.scripts.length, 2);
  const t = s.scripts[0]!;
  assert.equal(t.script, "uxb_t");
  assert.equal(t.name, "Thrower");
  assert.equal(t.failures, 3);
  assert.equal(t.sessions, 2);
  assert.equal(t.lastSeen, "2026-10-30T11:00:00Z");
  assert.deepEqual(t.messages, [{ message: "boom", kind: "ux_error", count: 3 }]);
  assert.deepEqual(t.pages, ["p1", "p2"]);
  assert.deepEqual(t.browsers, ["Chrome desktop"]);
  assert.equal(s.scripts[1]!.kinds.logic_timeout, 1);
  assert.equal(scriptHealthChipText(s, t), "failed in 2 of 4 sessions");
  assert.equal(scriptHealthChipText(s, undefined), "no errors in 4 sessions");
  assert.equal(scriptHealthChipText({ sessions: 0 }, undefined), "no sessions yet");
  assert.equal(scriptHealthChipText({ sessions: 1 }, undefined), "no errors in 1 session");
});
