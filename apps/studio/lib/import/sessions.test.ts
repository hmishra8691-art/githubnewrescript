import { test } from "node:test";
import assert from "node:assert/strict";
import { IMPORT_BUCKET, bounded, digestReport, expiryFrom, memorySessionStore, rollbackPlan, sourceKey, summarize, type ImportSession, type NewSession } from "./sessions.ts";

/** I4 — import sessions: keys, expiry, the rollback rules, the memory store */
const base = (over: Partial<NewSession> = {}): NewSession => ({ customerId: "c1", userId: "u1", surveyId: null, into: "new", scope: "full", fileName: "Tracker wave 3.qsf", format: "qsf", platform: "qualtrics", fingerprint: "fp", sizeBytes: 3, reportDigest: { title: "T", ok: true, summary: [], questions: 3, review: 0, risks: { high: 0, medium: 0, low: 0 }, mapping: {}, fidelity: null, graph: { findings: {}, first: [] }, scripts: [] }, canonical: { q: 1 }, decisions: [], priorDefinition: null, error: null, ...over });

test("keys stay under the organisation's prefix and never carry a path from the file name", () => {
  assert.equal(sourceKey("c1", "s9", "Tracker wave 3.qsf"), "c1/imports/s9/Tracker_wave_3.qsf");
  assert.equal(sourceKey(null, "s9", "../../etc/passwd"), "sandbox/imports/s9/passwd");
  assert.equal(sourceKey("c1", "s9", "..hidden..qsf"), "c1/imports/s9/hidden.qsf");
  assert.equal(sourceKey("c1", "s9", "a/b\\c.docx"), "c1/imports/s9/c.docx", "a path in the name is not a folder");
  assert.equal(expiryFrom(new Date("2026-11-01T00:00:00Z")), "2027-01-30T00:00:00.000Z", "90 days");
  assert.equal(bounded({ a: "x".repeat(10) }, 5), null); assert.deepEqual(bounded({ a: 1 }), { a: 1 });
});

test("rollback rules: only applied imports; a merge restores the prior survey; a new project with responses is refused", () => {
  const s = (over: Partial<ImportSession>): ImportSession => ({ ...base(), id: "s", createdAt: "", appliedAt: "", rolledBackAt: null, storageProvider: null, bucket: null, storageKey: null, sourceExpiresAt: "", status: "applied", ...over } as ImportSession);
  assert.equal(rollbackPlan(s({ status: "analyzed" }), { responses: 0 }).action, "refuse");
  assert.equal(rollbackPlan(s({ status: "rolled_back" }), { responses: 0 }).action, "refuse");
  assert.deepEqual(rollbackPlan(s({ into: "merge", priorDefinition: { meta: 1 } }), { responses: 0 }), { action: "restore_definition", definition: { meta: 1 } });
  const noPrior = rollbackPlan(s({ into: "merge", priorDefinition: null }), { responses: 0 });
  assert.equal(noPrior.action, "refuse"); assert.equal((noPrior as { status: number }).status, 410);
  assert.deepEqual(rollbackPlan(s({ surveyId: "p1" }), { responses: 0 }), { action: "delete_project", surveyId: "p1" });
  const kept = rollbackPlan(s({ surveyId: "p1" }), { responses: 12 });
  assert.equal(kept.action, "refuse"); assert.match((kept as { reason: string }).reason, /12 responses.*never deletes collected data/);
});

test("the memory store: create keeps the file under a key, lists by organisation newest first, expires after 90 days", async () => {
  let t = Date.parse("2026-11-01T10:00:00Z");
  const store = memorySessionStore(() => new Date(t));
  const a = await store.create(base(), new Uint8Array([1, 2, 3]));
  t += 1000; const b = await store.create(base({ fileName: "b.docx", format: "docx" }), null);
  t += 1000; await store.create(base({ customerId: "other" }), new Uint8Array([9]));
  assert.equal(a.bucket, IMPORT_BUCKET); assert.ok(a.storageKey?.startsWith("c1/imports/"));
  assert.equal(b.storageKey, null);
  assert.deepEqual((await store.list({ customerId: "c1" })).map((x) => x.fileName), ["b.docx", "Tracker wave 3.qsf"], "newest first, this organisation only");
  assert.equal((await store.list({ customerId: null })).length, 0, "the sandbox sees nothing of an organisation's");
  const sum = summarize(a);
  assert.equal(sum.hasSource, true); assert.equal((sum as Record<string, unknown>).canonical, undefined, "the list never carries the model");
  assert.equal((await store.expired(10)).length, 0);
  t += 91 * 86_400_000;
  const due = await store.expired(10);
  assert.equal(due.length, 2, "both stored files are due, the one without a file is not");
  for (const d of due) await store.dropSource(d);
  assert.equal((await store.get(a.id))!.storageKey, null);
  assert.equal((await store.expired(10)).length, 0, "idempotent");
  assert.equal((await store.update(a.id, { status: "applied", surveyId: "p1" }))!.status, "applied");
});

test("digestReport keeps the counts a history needs, not the report", () => {
  const r = { source: { title: "X" }, ok: true, summary: ["a", "b"], created: { questions: 7 }, detected: { questions: 9 }, review: [1, 2], risks: { high: [1], medium: [], low: [1, 2], info: [] }, mapping: { summary: { exact: 5, components: 2 } }, fidelity: { totals: { detected: 10, imported: 8, partial: 1, unsupported: 1 }, importedPct: 80 }, graph: { stats: { findings: { missing_reference: 1 } }, findings: [{ kind: "missing_reference", severity: "high", location: "Q1", message: "m" }, { kind: "unused_embedded", severity: "info", location: "e", message: "i" }] }, scripts: [{ location: "QID1", verdict: "native", summary: "s" }] } as never;
  const d = digestReport(r);
  assert.equal(d.questions, 7); assert.deepEqual(d.risks, { high: 1, medium: 0, low: 2 });
  assert.equal(d.graph.first.length, 1, "info findings are not carried"); assert.equal(d.scripts[0].verdict, "native");
  assert.equal(d.fidelity!.importedPct, 80);
});
