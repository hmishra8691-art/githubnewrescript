import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorageProvider } from "@rescript/storage";
import { providerObjectStore, readDefinition, type ObjectStore } from "@rescript/media";
import { copyVersionDefinition, copyVersionDefinitionWithin, sweepVersionDefinitions } from "./definitionStore.ts";

type Row = { id: string; definition: unknown; created_at: string; definition_hash: string | null; definition_stored_at: string | null; definition_store?: string; definition_bytes?: number };

/* survey_versions as the sweep sees it: select/is/order/limit/not and update/eq/is, nothing more */
function fakeDb(rows: Row[], opts: { missingColumns?: boolean } = {}) {
  return {
    rows,
    from(table: string) {
      assert.equal(table, "survey_versions");
      const f: { nulls?: string; notIn?: string[]; limit?: number; patch?: Partial<Row>; id?: string } = {};
      const q = {
        select() { return q; },
        update(p: Partial<Row>) { f.patch = p; return q; },
        eq(_c: string, v: string) { f.id = v; return q; },
        is(c: string) { f.nulls = c; return q; },
        order() { return q; },
        not(_c: string, _op: string, list: string) { f.notIn = list.slice(1, -1).split(","); return q; },
        limit(n: number) { f.limit = n; return q; },
        then(resolve: (r: unknown) => void) {
          if (opts.missingColumns) return resolve({ data: null, error: { message: "column survey_versions.definition_stored_at does not exist" } });
          if (f.patch) {
            const r = rows.find((x) => x.id === f.id && x.definition_stored_at === null);
            if (r) Object.assign(r, f.patch);
            return resolve({ data: null, error: null });
          }
          const out = rows.filter((r) => r.definition_stored_at === null && !(f.notIn ?? []).includes(r.id))
            .sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, f.limit ?? 1000)
            .map((r) => ({ id: r.id, definition: r.definition }));
          return resolve({ data: out, error: null });
        },
      };
      return q;
    },
  };
}
const row = (id: string, definition: unknown, i: number): Row => ({ id, definition, created_at: `2026-11-0${i}`, definition_hash: null, definition_stored_at: null });
const memStore = () => providerObjectStore(new MemoryStorageProvider());

test("one version is copied and its hash recorded; reading it back gives the same definition", async () => {
  const db = fakeDb([row("v1", { title: "A", questions: [{ id: "Q1" }] }, 1)]);
  const store = memStore();
  const r = await copyVersionDefinition(db, store, "v1", db.rows[0].definition);
  assert.equal(r.error, undefined);
  assert.equal(db.rows[0].definition_hash, r.hash);
  assert.ok(db.rows[0].definition_stored_at);
  assert.deepEqual(await readDefinition(store, r.hash!), { questions: [{ id: "Q1" }], title: "A" });
});

test("the sweep copies everything outstanding, deduplicates identical versions, and stops when done", async () => {
  const same = { title: "template", questions: [] };
  const db = fakeDb(Array.from({ length: 25 }, (_, i) => row(`v${i}`, i < 5 ? same : { title: `S${i}` }, (i % 9) + 1)));
  const r = await sweepVersionDefinitions(db, memStore(), { batch: 4 });
  assert.equal(r.copied, 21);
  assert.equal(r.deduplicated, 4);
  assert.equal(r.remaining, false);
  assert.ok(db.rows.every((x) => x.definition_hash));
});

test("a version the store refuses is reported and skipped, the rest still copied", async () => {
  const db = fakeDb([row("bad", { title: "x" }, 1), row("ok", { title: "y" }, 2)]);
  const real = memStore();
  let puts = 0;
  /* the first write (version "bad", oldest) fails; every later one succeeds */
  const flaky: ObjectStore = { ...real, name: real.name, head: real.head, put: async (b, p, bytes, o) => {
    if (puts++ === 0) throw new Error("store down");
    return real.put(b, p, bytes, o);
  } };
  const r = await sweepVersionDefinitions(db, flaky, { batch: 10 });
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].id, "bad");
  assert.equal(db.rows.find((x) => x.id === "ok")!.definition_hash !== null, true);
  assert.equal(db.rows.find((x) => x.id === "bad")!.definition_hash, null);
});

test("the time budget bounds the sweep and says work remains", async () => {
  const db = fakeDb(Array.from({ length: 30 }, (_, i) => row(`v${i}`, { title: `S${i}` }, (i % 9) + 1)));
  let t = 0;
  const r = await sweepVersionDefinitions(db, memStore(), { batch: 5, budgetMs: 10, now: () => (t += 4) });
  assert.equal(r.remaining, true);
  assert.ok(r.copied > 0 && r.copied < 30);
});

test("a database without 0112 is skipped, not failed", async () => {
  const r = await sweepVersionDefinitions(fakeDb([], { missingColumns: true }), memStore());
  assert.equal(r.skipped, "migration 0112 not applied");
});

test("a slow store never holds the publish request beyond its bound", async () => {
  const real = memStore();
  const slow: ObjectStore = { ...real, name: real.name, head: () => new Promise(() => {}) };
  const r = await copyVersionDefinitionWithin(30, fakeDb([row("v1", { a: 1 }, 1)]), slow, "v1", { a: 1 });
  assert.match(r.error ?? "", /not copied within 30 ms/);
});
