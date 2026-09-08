import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { __clearVersionDefinitionCacheForTests, assessAndStore, clientIp, deviceHashFrom, getCachedVersionDefinition, hashIdentifier, loadPeers, recomputeSurvey, resolveRunDefinition, rowToPeer, rowToResponse } from "./server.js";

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
      /*
       * Real PostgREST projects `col->path` (or `alias:col->path`) onto a
       * flat field, which is how `loadPeers` now asks for just
       * `quality->system` instead of the whole assessment blob. This stub
       * never dropped unselected fields anyway, so the only thing worth
       * emulating here is that flattening — enough to prove `rowToPeer`
       * reads the projected shape, not the nested one.
       */
      select(cols?: string) {
        op = op === "update" ? "update" : "select";
        if (typeof cols === "string" && cols.includes("->")) {
          const projections = cols.split(",").map((s) => s.trim())
            .map((spec) => spec.match(/^(?:(\w+):)?(\w+)->>?(\w+)$/))
            .filter((m): m is RegExpMatchArray => !!m)
            .map((m) => ({ alias: m[1] ?? m[3], col: m[2], path: m[3] }));
          if (projections.length) {
            rows = rows.map((r) => {
              const out = { ...r };
              for (const p of projections) out[p.alias] = r[p.col]?.[p.path] ?? null;
              return out;
            });
          }
        }
        return b;
      },
      update(p: any) { op = "update"; patch = p; return b; },
      insert(p: any) { calls.push({ table, op: "insert", args: p }); (tables[table] ??= []).push(p); return Promise.resolve({ data: p, error: null }); },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b; },
      neq(k: string, v: any) { filters.push((r) => r[k] !== v); return b; },
      in(k: string, vs: any[]) { filters.push((r) => vs.includes(r[k])); return b; },
      not(k: string, _op: string, _v: any) { filters.push((r) => r[k] !== null && r[k] !== undefined); return b; },
      order(k: string, o?: { ascending?: boolean }) { rows = [...rows].sort((a, c) => (String(a[k]) < String(c[k]) ? -1 : 1) * (o?.ascending === false ? -1 : 1)); return b; },
      limit(n: number) { rows = rows.slice(0, n); return b; },
      maybeSingle() { calls.push({ table, op: "select", args: null }); return Promise.resolve({ data: apply()[0] ?? null, error: null }); },
      single() { calls.push({ table, op: "select", args: null }); return Promise.resolve({ data: apply()[0] ?? null, error: null }); },
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

test("row mapping: telemetry, hashes and the compact system record travel; in-progress rows are not peers; peers carry quality->system, never the full assessment", async () => {
  const rows = [row(0), row(1, { status: "in_progress" }), row(2, { quality: { system: { SYSTEM_TOTAL_DURATION: 240 }, classification: "CLEAN", flags: [{ ruleId: "x" }] } })];
  const db = fakeDb({ responses: rows });
  const peers = await loadPeers(db, "S1", false, "sess000", 100);
  assert.deepEqual(peers.map((p) => p.sessionId), ["sess002"], "excludes self and in-progress");
  assert.equal(peers[0].system?.SYSTEM_TOTAL_DURATION, 240, "quality->system is projected onto the row");
  assert.ok(!("classification" in peers[0]), "the rest of the assessment (classification, flags, ...) is never fetched for a peer");
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

test("resolveRunDefinition: a test session is graded with the draft it ran, a live session with its version, ?v= with the requested version", async () => {
  __clearVersionDefinitionCacheForTests(); // this test reuses versionId "V1" against a fresh survey_versions table
  const versionDef = { ...def, quality: { ...def.quality, enabled: false, strictness: "standard" } };
  const draftDef = { ...def, quality: { ...def.quality, enabled: true, strictness: "strict" } };
  const db = fakeDb({
    surveys: [{ id: "S1", draft_definition: draftDef, revision: 120 }, { id: "S2", draft_definition: null, revision: 7 }, { id: "S3", draft_definition: { meta: "broken" }, revision: 9 }],
    survey_versions: [{ id: "V1", definition: versionDef }],
  });
  // test session, no ?v= → the draft (strict, enabled) — what the test link served
  const t = await resolveRunDefinition(db, { survey_id: "S1", version_id: "V1", is_test: true }, { source: "draft", versionId: "V1", revision: 120 });
  assert.equal(t.source, "draft"); assert.equal(t.def?.quality.strictness, "strict"); assert.equal(t.def?.quality.enabled, true); assert.equal(t.revision, 120); assert.equal(t.versionId, "V1");
  // an old runner sends no hint: still the draft
  const t2 = await resolveRunDefinition(db, { survey_id: "S1", version_id: "V1", is_test: true }, undefined);
  assert.equal(t2.source, "draft");
  // ?v= requested → the version, even though a draft exists
  const r = await resolveRunDefinition(db, { survey_id: "S1", version_id: "V1", is_test: true }, { source: "requested", versionId: "V1" });
  assert.equal(r.source, "version"); assert.equal(r.def?.quality.enabled, false); assert.match(r.note ?? "", /requested/);
  // live session → the version it is recorded against, whatever the draft says
  const l = await resolveRunDefinition(db, { survey_id: "S1", version_id: "V1", is_test: false }, undefined);
  assert.equal(l.source, "version"); assert.equal(l.def?.quality.strictness, "standard");
  // no draft → the version
  const n = await resolveRunDefinition(db, { survey_id: "S2", version_id: "V1", is_test: true }, { source: "current" });
  assert.equal(n.source, "version"); assert.equal(n.note, undefined);
  // a draft that does not parse → the version, with the reason
  const b = await resolveRunDefinition(db, { survey_id: "S3", version_id: "V1", is_test: true }, { source: "draft" });
  assert.equal(b.source, "version"); assert.match(b.note ?? "", /draft does not parse/);
  // the hint cannot point at a definition the survey does not own: only the row's version is loaded
  const x = await resolveRunDefinition(db, { survey_id: "S1", version_id: "V1", is_test: true }, { source: "requested", versionId: "SOMEBODY_ELSES" });
  assert.equal(x.versionId, "V1");

  // five of the calls above (r, l, n, b, x) resolved to the "version" source for the
  // SAME versionId — that must be ONE database read, not five, because a published
  // version's definition can never change (migration 0012's immutability trigger)
  const versionReads = db.calls.filter((c) => c.table === "survey_versions" && c.op === "select").length;
  assert.equal(versionReads, 1, `V1's definition should be read from the database once and served from memory after that, got ${versionReads} reads`);
});

test("getCachedVersionDefinition: caches per versionId, and a schema failure is not cached (never silently sticks)", async () => {
  __clearVersionDefinitionCacheForTests();
  const db = fakeDb({ survey_versions: [{ id: "V-good", definition: def }, { id: "V-bad", definition: { meta: "broken" } }] });
  const a = await getCachedVersionDefinition(db, "V-good");
  const b = await getCachedVersionDefinition(db, "V-good");
  assert.ok(a && b);
  assert.equal(a, b, "the exact same parsed object is returned from cache — no re-parse");
  assert.equal(db.calls.filter((c) => c.table === "survey_versions").length, 1);

  const bad1 = await getCachedVersionDefinition(db, "V-bad");
  const bad2 = await getCachedVersionDefinition(db, "V-bad");
  assert.equal(bad1, null); assert.equal(bad2, null);
});
