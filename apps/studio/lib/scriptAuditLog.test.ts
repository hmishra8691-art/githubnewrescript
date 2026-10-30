import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { recordSandboxDefinition, resetSandboxScriptAudit, sandboxScriptAudit, scriptAuditRows, sha256Short } from "./scriptAuditLog.ts";

/* S1c item 3 (SE-29): the rows the draft route writes, and the sandbox's in-memory log */

const def = (scripts: { id: string; name: string; code: string; enabled?: boolean }[]) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "T" },
  questions: [{ id: "q1", code: "Q1", variableName: "A", type: "single_select", text: "A?", options: [{ code: 1, label: "Yes" }] }],
  flow: [{ type: "block", id: "b", title: "B", children: [{ type: "page", id: "p", questionIds: ["q1"] }] }, { type: "end", id: "e", status: "complete" }],
  scripts: scripts.map((s) => ({ enabled: true, ...s })),
});

test("rows: sha-256 fingerprints, never the code; capped per save with the overflow counted", () => {
  const rows = scriptAuditRows(def([]), def([{ id: "a", name: "Spend band", code: "set('X', 'SECRET');" }]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.action, "script.added");
  assert.equal(rows[0]!.entityId, "a");
  assert.equal(rows[0]!.detail.afterHash, sha256Short("set('X', 'SECRET');"));
  assert.equal(String(rows[0]!.detail.afterHash).length, 16);
  assert.equal(rows[0]!.detail.verdict, "passed");
  assert.ok(!JSON.stringify(rows).includes("SECRET"));
  const many = def(Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, code: `set('X', ${i});` })));
  const capped = scriptAuditRows(def([]), many, 4);
  assert.equal(capped.length, 4);
  assert.equal(capped[3]!.detail.more, 6);
  assert.deepEqual(scriptAuditRows(many, many), []);
});

test("sandbox memory: the first definition is the baseline; later saves log one entry per change, newest first", () => {
  resetSandboxScriptAudit();
  const v0 = def([{ id: "a", name: "Spend band", code: "set('X', 1);" }]);
  assert.deepEqual(recordSandboxDefinition(v0, "2026-10-30T10:00:00Z"), []);
  recordSandboxDefinition(def([{ id: "a", name: "Spend band", code: "set('X', 2);" }]), "2026-10-30T10:01:00Z");
  recordSandboxDefinition(def([{ id: "a", name: "Spend band", code: "set('X', 2);", enabled: false }]), "2026-10-30T10:02:00Z");
  const log = sandboxScriptAudit();
  assert.deepEqual(log.map((e) => e.action), ["script.disabled", "script.changed"]);
  assert.equal(log[1]!.text, "Logic script ‘Spend band’ changed by You (sandbox) — passed the check");
  assert.equal(log[0]!.at, "2026-10-30T10:02:00Z");
});
