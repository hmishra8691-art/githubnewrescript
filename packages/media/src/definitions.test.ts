import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryStorageProvider } from "@rescript/storage";
import { providerObjectStore } from "./objectStore.js";
import { canonicalJson, definitionHash, definitionKey, readDefinition, storeDefinition, DEFINITIONS_BUCKET } from "./definitions.js";

const store = () => providerObjectStore(new MemoryStorageProvider());
const demo = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL("../../../docs/master-demo/MASTER_DEMO_2026_v1.0.json", import.meta.url), "utf8"));

test("canonical JSON ignores key order at every level, keeps array order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 2 } }), canonicalJson({ a: { c: 2, d: [3, { x: 2, y: 1 }] }, b: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
});

test("a real survey round-trips, compressed, and identical content is stored once", async () => {
  const s = store();
  const def = demo();
  const first = await storeDefinition(s, def);
  assert.equal(first.written, true);
  assert.ok(first.storedBytes * 4 < first.bytes, `compressed ${first.bytes} → ${first.storedBytes}`);
  // the same survey with its keys in another order is the same object
  const reordered = Object.fromEntries(Object.entries(def).reverse());
  const second = await storeDefinition(s, reordered);
  assert.equal(second.hash, first.hash);
  assert.equal(second.written, false);
  assert.deepEqual(JSON.parse(canonicalJson(await readDefinition(s, first.hash))), JSON.parse(canonicalJson(def)));
});

test("a different definition gets a different object", async () => {
  const s = store();
  const a = await storeDefinition(s, { title: "A", questions: [] });
  const b = await storeDefinition(s, { title: "B", questions: [] });
  assert.notEqual(a.hash, b.hash);
  assert.equal(definitionKey(a.hash), `sha256/${a.hash.slice(0, 2)}/${a.hash.slice(2, 4)}/${a.hash}.json.gz`);
});

test("a corrupted or swapped object is refused, not served", async () => {
  const s = store();
  const a = await storeDefinition(s, { title: "A" });
  const b = await storeDefinition(s, { title: "B" });
  // swap: put B's bytes under A's key in a fresh store
  const t = store();
  const bytes = await s.read(DEFINITIONS_BUCKET, definitionKey(b.hash));
  await t.put(DEFINITIONS_BUCKET, definitionKey(a.hash), bytes);
  await assert.rejects(readDefinition(t, a.hash), /integrity/);
});

test("a write that races another writer of the same content succeeds", async () => {
  const s = store();
  const def = { title: "race" };
  const { hash } = await definitionHash(def);
  let heads = 0;
  const racy = { ...s, name: s.name,
    head: async (b: string, p: string) => (heads++ === 0 ? null : s.head(b, p)),
    put: async (b: string, p: string, bytes: Uint8Array) => { await s.put(b, p, bytes); throw new Error("already exists"); },
  } as typeof s;
  const r = await storeDefinition(racy, def);
  assert.equal(r.hash, hash);
  assert.equal(r.written, false);
});

test("non-objects and bad hashes are refused", async () => {
  await assert.rejects(storeDefinition(store(), null), /object/);
  assert.throws(() => definitionKey("../etc/passwd"), /sha256/);
});
