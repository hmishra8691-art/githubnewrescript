import { test } from "node:test";
import assert from "node:assert/strict";
import { eraseRespondent, fingerprint, normaliseIdentifier, type ErasureDeps, type ErasureIdentifier } from "./erasureCore.ts";

/*
 * P1-11 gate: "an erasure request leaves no copy and a record". An in-memory project with two invited people,
 * each with a response, recordings, holds, a list-fill slot, a ledger row, reviews, edits and mail. Erasing Ana must
 * remove every row of hers — including the ones no foreign key cascades to — and leave Ben's untouched.
 */
type Row = Record<string, string | boolean | null>;
function project() {
  const t: Record<string, Row[]> = {
    respondents: [{ id: "inv-ana", email: "ana@example.test", external_id: "PAN-1" }, { id: "inv-ben", email: "ben@example.test", external_id: "PAN-2" }],
    responses: [
      { id: "r-ana", session_id: "s-ana", respondent_id: "inv-ana", respondent_code: "R-ANA", sample_source_respondent: "PAN-1", is_test: false },
      { id: "r-ben", session_id: "s-ben", respondent_id: "inv-ben", respondent_code: "R-BEN", sample_source_respondent: "PAN-2", is_test: false },
    ],
    quota_holds: [{ session_id: "s-ana" }, { session_id: "s-ben" }],
    balance_claims: [{ session_id: "s-ana" }],
    listfill_allocations: [{ session_id: "s-ana" }, { session_id: "s-ben" }],
    participation_ledger: [{ response_id: "r-ana" }, { response_id: "r-ben" }],
    response_reviews: [{ response_id: "r-ana" }], response_edits: [{ response_id: "r-ana" }, { response_id: "r-ben" }],
    media_objects: [{ response_id: "r-ana", session_id: "s-ana" }, { response_id: "r-ben", session_id: "s-ben" }],
    media_deliveries: [{ response_id: "r-ana" }], assessment_results: [],
    mail_deliveries: [{ to_email: "ana@example.test" }, { to_email: "ben@example.test" }],
    vendor_participant_mappings: [{ participant_id: "PAN-1" }],
  };
  const bucket = new Set(["s-ana/voice.webm", "s-ana/photo.jpg", "s-ben/voice.webm"]);
  const deps: ErasureDeps = {
    findInvitations: async (id) => t.respondents.filter((r) => (id.kind === "email" && String(r.email).toLowerCase() === id.value) || (id.kind === "panel_id" && r.external_id === id.value)).map((r) => ({ id: String(r.id), email: r.email as string })),
    findResponses: async (id, inv) => t.responses.filter((r) => inv.includes(String(r.respondent_id)) || (id.kind === "respondent_code" && r.respondent_code === id.value) || (id.kind === "panel_id" && r.sample_source_respondent === id.value) || (id.kind === "session_id" && r.session_id === id.value)).map((r) => ({ id: String(r.id), session_id: r.session_id as string, respondent_id: r.respondent_id as string, is_test: !!r.is_test })),
    purgeMedia: async (sessions) => { let n = 0; for (const k of [...bucket]) if (sessions.some((s) => k.startsWith(`${s}/`))) { bucket.delete(k); n++; } return { objects: n, warnings: [] }; },
    deleteWhere: async (table, col, values) => { const before = t[table].length; t[table] = t[table].filter((r) => !values.includes(String(r[col]))); return before - t[table].length; },
    purgeResponses: async (ids) => {
      const before = t.responses.length;
      t.responses = t.responses.filter((r) => !ids.includes(String(r.id)));
      for (const c of ["response_reviews", "response_edits", "media_objects", "media_deliveries", "assessment_results"]) t[c] = t[c].filter((r) => !ids.includes(String(r.response_id)));
      return before - t.responses.length;
    },
    countWhere: async (table, col, values) => t[table].filter((r) => values.includes(String(r[col]))).length,
    exportsBefore: async () => [{ at: "2026-11-10T09:00:00Z", format: "sav", by: "Research Lead" }],
  };
  return { t, bucket, deps };
}
const dump = (t: Record<string, Row[]>, bucket: Set<string>) => JSON.stringify(t) + [...bucket].join(",");

test("erasing by email leaves no copy of Ana anywhere — including rows no cascade reaches — and Ben is untouched", async () => {
  const p = project();
  const id = normaliseIdentifier({ kind: "email", value: " Ana@Example.test " })!;
  const r = await eraseRespondent(id, p.deps);
  assert.deepEqual(r.found, { responses: 1, invitations: 1 });
  assert.equal(r.mediaObjects, 2);
  assert.equal(r.verified, true, JSON.stringify(r.remaining));
  const left = dump(p.t, p.bucket);
  for (const trace of ["ana@example.test", "inv-ana", "r-ana", "s-ana", "R-ANA"]) assert.ok(!left.includes(trace), `${trace} is gone`);
  for (const kept of ["ben@example.test", "inv-ben", "r-ben", "s-ben", "R-BEN", "PAN-2"]) assert.ok(left.includes(kept), `${kept} is kept`);
  assert.equal(p.t.vendor_participant_mappings.length, 1, "the vendor mapping is only touched when the panel id is the identifier");
  assert.deepEqual(r.exportsBefore.map((e) => e.format), ["sav"], "earlier exports are listed for the controller");
});

test("by panel id and by respondent code; an identifier that names nobody erases nothing and still verifies", async () => {
  const p = project();
  const r = await eraseRespondent({ kind: "panel_id", value: "PAN-1" }, p.deps);
  assert.equal(r.verified, true);
  assert.equal(p.t.vendor_participant_mappings.length, 0);
  assert.ok(!dump(p.t, p.bucket).includes("PAN-1"));
  const q = project();
  const c = await eraseRespondent({ kind: "respondent_code", value: "R-BEN" }, q.deps);
  assert.equal(c.found.responses, 1);
  assert.ok(!dump(q.t, q.bucket).includes("r-ben") && dump(q.t, q.bucket).includes("r-ana"));
  const none = await eraseRespondent({ kind: "session_id", value: "s-nobody" }, project().deps);
  assert.deepEqual(none.found, { responses: 0, invitations: 0 });
  assert.equal(none.verified, true);
});

test("a check that finds a row left behind does not call the erasure verified", async () => {
  const p = project();
  const leaky: ErasureDeps = { ...p.deps, deleteWhere: async (table, col, values) => (table === "quota_holds" ? 0 : p.deps.deleteWhere(table, col, values)) };
  const r = await eraseRespondent({ kind: "email", value: "ana@example.test" }, leaky);
  assert.equal(r.verified, false);
  assert.equal(r.remaining.quota_holds, 1);
});

test("identifiers are validated, and the record's fingerprint is stable and unreadable", () => {
  assert.equal(normaliseIdentifier({ kind: "email", value: "not an email" }), null);
  assert.equal(normaliseIdentifier({ kind: "name", value: "Ana" }), null);
  const a: ErasureIdentifier = { kind: "email", value: "ana@example.test" };
  const f = fingerprint(a, "k");
  assert.equal(f, fingerprint({ ...a }, "k"));
  assert.notEqual(f, fingerprint(a, "other key"));
  assert.ok(!f.includes("ana") && /^[0-9a-f]{32}$/.test(f));
});
