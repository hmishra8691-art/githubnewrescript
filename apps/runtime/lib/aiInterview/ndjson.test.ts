import { test } from "node:test";
import assert from "node:assert/strict";
import { ndjsonResponse, readNdjson, wantsNdjson } from "./ndjson.ts";

test("NDJSON: start, text pieces, exactly one terminal result; errors keep their status; plain JSON still reads", async () => {
  assert.ok(wantsNdjson("application/x-ndjson, application/json")); assert.ok(!wantsNdjson("*/*"));
  const res = ndjsonResponse(async (emit) => { emit({ type: "text", delta: "Hel" }); emit({ type: "text", delta: "lo?" }); return { status: 200, body: { ok: true } }; });
  const seen: string[] = [];
  const r = await readNdjson(res, (e) => { if (e.type === "text") seen.push(String(e.delta)); });
  assert.deepEqual(seen, ["Hel", "lo?"]); assert.deepEqual(r, { status: 200, body: { ok: true } });
  const bad = await readNdjson(ndjsonResponse(async () => ({ status: 409, body: { error: "x" } })), () => {});
  assert.deepEqual(bad, { status: 409, body: { error: "x" } });
  const crash = await readNdjson(ndjsonResponse(async () => { throw new Error("boom"); }), () => {});
  assert.equal(crash.status, 500);
  const plain = await readNdjson(new Response(JSON.stringify({ a: 1 }), { status: 201, headers: { "content-type": "application/json" } }), () => {});
  assert.deepEqual(plain, { status: 201, body: { a: 1 } });
});
