// Audit repro (CLEAN): do soft-deleted (binned) responses still act as peers and get re-assessed?
import { loadPeers, recomputeSurvey } from "/home/claude/rescript/packages/quality/dist/server.js";
import { datasetDefinition, variedAnswers } from "/home/claude/rescript/packages/quality/dist/index.js";

function fakeDb(tables) {
  const builder = (table) => {
    let rows = tables[table] ?? []; let op = "select"; let patch = null; const filters = [];
    let lim = Infinity;
    const apply = () => rows.filter((r) => filters.every((f) => f(r))).slice(0, lim);
    const b = {
      select() { return b; }, update(p) { op = "update"; patch = p; return b; },
      eq(k, v) { filters.push((r) => r[k] === v); return b; }, neq(k, v) { filters.push((r) => r[k] !== v); return b; },
      is(k, v) { filters.push((r) => r[k] === v || (v === null && r[k] === undefined)); b.usedIs = true; return b; },
      gt(k, v) { filters.push((r) => String(r[k]) > String(v)); return b; },
      order(k) { rows = [...rows].sort((a, c) => (String(a[k]) < String(c[k]) ? -1 : 1)); return b; }, limit(n) { lim = n; return b; },
      then(res, rej) { if (op === "update") { for (const r of apply()) Object.assign(r, patch); return Promise.resolve({ data: apply(), error: null }).then(res, rej); } return Promise.resolve({ data: apply(), error: null }).then(res, rej); },
    };
    return b;
  };
  return { from: builder, tables };
}
const def = datasetDefinition();
const row = (i, extra = {}) => ({ id: `id${i}`, survey_id: "S", session_id: `s${i}`, status: "complete", is_test: false, answers: variedAnswers(i), started_at: new Date(1_700_000_000_000 + i * 60000).toISOString(), completed_at: new Date(1_700_000_000_000 + i * 60000 + 200000).toISOString(), telemetry: null, ...extra });
const rows = [row(1), row(2), row(3, { deleted_at: "2026-10-01T00:00:00Z", deletion_reason: "bot" }), row(4, { answers: variedAnswers(3), deleted_at: "2026-10-01T00:00:00Z" })];
const db = fakeDb({ responses: rows });
const peers = await loadPeers(db, "S", false, "s1", 3000);
console.log("loadPeers returned:", peers.map((p) => p.sessionId).join(","), "-> includes soft-deleted rows:", peers.some((p) => p.sessionId === "s3" || p.sessionId === "s4"));
const r = await recomputeSurvey(db, def, "S", false);
console.log("recomputeSurvey assessed:", r.assessed, "byClass:", JSON.stringify(r.byClass));
console.log("deleted row s3 received a fresh assessment:", !!rows[2].quality, "| s4 flagged as duplicate of (deleted) s3:", (rows[3].quality?.flags ?? []).map((f) => f.ruleId).join(","));
