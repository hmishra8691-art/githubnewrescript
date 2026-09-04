import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { assessAndStore, clientIp, deviceHashFrom, hashIdentifier, loadPeers, recomputeSurvey, rowToPeer, rowToResponse } from "./server.js";

/**
 * A minimal in-memory stand-in for the Supabase query builder: enough of the
 * `.from().select().eq().neq().order().limit()` chain to serve the server
 * glue, plus `.update().eq()` that mutates the rows. Every filter the glue
 * uses is implemented; anything else throws so a new call is noticed.
 */
function fakeDb(tables: Record<string, any[]>) {
  const calls: { table: string; op: string; args: any }[] = [];
  const builder = (table: string) => {
    let rows = tables[table] ?? [];
    let op = "select";
    let patch: any = null;
    const filters: ((r: any) => boolean)[] = [];
    const apply = () => rows.filter((r) => filters.every((f) => f(r)));
    const b: any = {
      select() { op = op === "update" ? "update" : "select"; return b; },
      update(p: any) { op = "update"; patch = p; return b; },
      insert(p: any) { calls.push({ table, op: "insert", args: p }); (tables[table] ??= []).push(p); return Promise.resolve({ data: p, error: null }); },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b; },
      neq(k: string, v: any) { filters.push((r) => r[k] !== v); return b; },
      in(k: string, vs: any[]) { filters.push((r) => vs.includes(r[k])); return b; },
      not(k: string, _op: string, _v: any) { filters.push((r) => r[k] !== null && r[k] !== undefined); return b; },
      order(k: string, o?: { ascending?: boolean }) { rows = [...rows].sort((a, c) => (String(a[k]) < String(c[k]) ? -1 : 1) * (o?.ascending === false ? -1 : 1)); return b; },
      limit(n: number) { rows = rows.slice(0, n); return b; },
      maybeSingle() { return Promise.resolve({ data: apply()[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: apply()[0] ?? null, error: null }); },
      then(res: any, rej: any) {
        if (op === "update") {
          const hit = apply();
          for (const r of hit) Object.assign(r, patch);
          calls.push({ table, op: "update", args: { patch, n: hit.length } });
          return Promise.resolve({ data: hit, error: null }).then(res, rej);
        }
        calls.push({ table, op: "select", args: null });
        return Promise.resolve({ data: apply(), error: null }).then(res, rej);
      },
    };
    return b;
  };
  return { from: builder, calls, tables, rpc: async () => ({ data: null, error: null }) };
}

const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "s", version: "1" },
  quality: { enabled: true, strictness: "standard" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Pick", options: [{ code: "a", label: "A" }, { code: "b", label: "B" }, { code: "c", label: "C" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Select B", options: [{ code: "a", label: "A" }, { code: "b", label: "B" }], attentionCheck: { expected: ["b"] } },
    { id: "q3", code: "Q3", variableName: "Q3", type: "long_text", text: "Why?" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }, { type: "end", id: "e", status: "complete" }],
});

const row = (i: number, over: any = {}) => ({
  id: `id${i}`, survey_id: "S1", session_id: `sess${String(i).padStart(3, "0")}`, respondent_id: null, status: "complete", is_test: false,
  answers: { q1: ["a", "b", "c"][i % 3], q2: "b", q3: `Reason number ${i} about the product.` }, calculated: {}, embedded: {}, flags: [],
  started_at: new Date(1_700_000_000_000 + i * 60_000).toISOString(), completed_at: new Date(1_700_000_000_000 + i * 60_000 + 240_000).toISOString(),
  telemetry: null, ip_hash: `ip${i}`, device_hash: `dev${i}`, quality: null, review_status: null, ...over,
});

test("hashes: salted, comparable, not the raw value; device hash uses coarse fields only", () => {
  const h1 = hashIdentifier("salt:S1", "203.0.113.7");
  assert.equal(h1?.length, 32);
  assert.equal(h1, hashIdentifier("salt:S1", "203.0.113.7"));
  assert.notEqual(h1, hashIdentifier("salt:S2", "203.0.113.7"), "a different survey salt gives a different hash");
  assert.ok(!h1!.includes("203"));
  assert.equal(hashIdentifier("s", null), null);
  const d = { browser: "Chrome", os: "macOS", screen: "1440x900", timezone: "Europe/London", language: "en", dpr: 2, platform: "macOS" };
  assert.equal(deviceHashFrom("s", d), deviceHashFrom("s", { ...d, viewport: "800x600", locale: "en-GB" } as any), "viewport / locale do not change the device hash");
  assert.notEqual(deviceHashFrom("s", d), deviceHashFrom("s", { ...d, screen: "1920x1080" }));
  assert.equal(clientIp({ get: (n) => (n === "x-forwarded-for" ? "198.51.100.4, 10.0.0.1" : null) }), "198.51.100.4");
  assert.equal(clientIp({ get: (n) => (n === "x-real-ip" ? "198.51.100.9" : null) }), "198.51.100.9");
  assert.equal(clientIp({ get: () => null }), null);
});

test("row mapping: telemetry, hashes and the compact system record travel; in-progress rows are not peers", async () => {
  const rows = [row(0), row(1, { status: "in_progress" }), row(2, { quality: { system: { SYSTEM_TOTAL_DURATION: 240 }, classification: "CLEAN" } })];
  const db = fakeDb({ responses: rows });
  const peers = await loadPeers(db, "S1", false, "sess000", 100);
  assert.deepEqual(peers.map((p) => p.sessionId), ["sess002"], "excludes self and in-progress");
  assert.equal(peers[0].system?.SYSTEM_TOTAL_DURATION, 240);
  assert.equal(peers[0].classification, "CLEAN");
  const r = rowToResponse(rows[0]);
  assert.equal(r.ipHash, "ip0"); assert.equal(r.deviceHash, "dev0"); assert.equal(r.status, "complete");
  assert.equal(rowToPeer(rows[1]).status, "in_progress");
});

test("assessAndStore writes the assessment onto the row and returns it", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(i));
  // the response under test: failed the attention check
  rows[0].answers = { ...rows[0].answers, q2: "a" };
  const db = fakeDb({ responses: rows });
  const a = await assessAndStore(db, def, rows[0]);
  assert.ok(a.flags.some((f) => f.ruleId === "attention.failed"));
  assert.notEqual(a.classification, "CLEAN");
  assert.equal(rows[0].quality.classification, a.classification, "stored on the row");
  assert.ok(rows[0].quality_computed_at);
  const upd = db.calls.find((c) => c.op === "update");
  assert.ok(upd && upd.args.n === 1);
});

test("recomputeSurvey assesses every finished response, stamps shared cluster ids, and reports counts", async () => {
  const rows = Array.from({ length: 14 }, (_, i) => row(i, { answers: { q1: ["a", "b", "c"][i % 3], q2: "b", q3: `Distinct reason ${i} about ${["price", "service", "style", "speed", "colour", "size", "range"][i % 7]}.` } }));
  // a ring of 4 on one device with identical answers and text
  for (let i = 10; i < 14; i++) rows[i] = row(i, { device_hash: "ring", ip_hash: "ringip", answers: { q1: "c", q2: "b", q3: "The dealer near my office gave me a very fair trade-in price and free servicing." } });
  const db = fakeDb({ responses: rows });
  const res = await recomputeSurvey(db, def, "S1", false);
  assert.equal(res.assessed, 14);
  const ring = rows.slice(10);
  const ids = new Set(ring.map((r) => r.quality.system.SYSTEM_CLUSTER_ID));
  assert.equal(ids.size, 1, `one cluster id across the ring: ${[...ids]}`);
  assert.ok([...ids][0]);
  for (const r of ring) assert.ok(["SUSPICIOUS", "HIGHLY_SUSPICIOUS", "CRITICAL"].includes(r.quality.classification), r.quality.reasons.join(" | "));
  for (const r of rows.slice(0, 10)) assert.equal(r.quality.system.SYSTEM_CLUSTER_ID, null, r.quality.reasons.join(" | "));
  assert.ok((res.byClass.CLEAN ?? 0) >= 8, JSON.stringify(res.byClass));
});
