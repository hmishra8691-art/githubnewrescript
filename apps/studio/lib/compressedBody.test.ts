import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipJson, readJsonBody, sendJson, resetGzipRefusal, isGzipRefused, GZIP_MIN_BYTES } from "./compressedBody.ts";

/* a survey-shaped body: repetitive, like a real definition */
function bigDefinition(questions = 400) {
  return {
    definition: {
      questions: Array.from({ length: questions }, (_, i) => ({
        id: `Q${i + 1}`, type: "single", text: `How satisfied are you with item ${i + 1}?`,
        options: [1, 2, 3, 4, 5].map((c) => ({ code: c, label: `Option ${c}` })),
      })),
    },
    baseRevision: 7,
  };
}

const req = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://x/api/surveys/1/draft", { method: "PUT", body, headers, ...(body ? { duplex: "half" } : {}) } as RequestInit);

test("small bodies are not compressed", async () => {
  assert.equal(await gzipJson("{}"), null);
  assert.equal(await gzipJson("x".repeat(GZIP_MIN_BYTES - 1)), null);
});

test("a large definition round-trips through gzip and shrinks several times", async () => {
  const json = JSON.stringify(bigDefinition());
  const packed = await gzipJson(json);
  assert.ok(packed, "compressed");
  assert.ok(packed!.byteLength * 5 < json.length, `ratio ${json.length / packed!.byteLength}`);
  const r = await readJsonBody(req(packed, { "content-encoding": "gzip" }));
  assert.deepEqual(r, { ok: true, value: JSON.parse(json) });
});

test("plain JSON is still accepted (older editors)", async () => {
  const r = await readJsonBody(req(JSON.stringify({ definition: { a: 1 } })));
  assert.deepEqual(r, { ok: true, value: { definition: { a: 1 } } });
});

test("bad bodies are refused, never thrown", async () => {
  assert.equal((await readJsonBody(req("not json"))).ok, false);
  const notGzip = await readJsonBody(req("plain text", { "content-encoding": "gzip" }));
  assert.deepEqual(notGzip.ok ? null : notGzip.status, 400);
  const br = await readJsonBody(req("x", { "content-encoding": "br" }));
  assert.deepEqual(br.ok ? null : br.status, 415);
});

test("the decompressed size is capped (a small gzip can expand enormously)", async () => {
  const bomb = await gzipJson(JSON.stringify({ pad: "0".repeat(5_000_000) }));
  assert.ok(bomb && bomb.byteLength < 50_000);
  const r = await readJsonBody(req(bomb, { "content-encoding": "gzip" }), 1_000_000);
  assert.deepEqual(r.ok ? null : r.status, 413);
});

test("sendJson gzips large bodies and the server reads them", async () => {
  resetGzipRefusal();
  const json = JSON.stringify(bigDefinition());
  const seen: Array<string | null> = [];
  const fake = (async (url: string, init: RequestInit) => {
    const r = req(init.body as BodyInit, init.headers as Record<string, string>);
    seen.push(r.headers.get("content-encoding"));
    const body = await readJsonBody(r);
    return Response.json({ ok: body.ok }, { status: body.ok ? 200 : 400 });
  }) as unknown as typeof fetch;
  const r = await sendJson("http://x/d", json, { method: "PUT" }, fake);
  assert.equal(r.status, 200);
  assert.deepEqual(seen, ["gzip"]);
});

test("an older server that cannot read gzip gets one plain retry, then plain for the rest of the tab", async () => {
  resetGzipRefusal();
  const json = JSON.stringify(bigDefinition());
  const seen: Array<string | null> = [];
  // the pre-change draft route: req.json() on gzip bytes fails → "definition required"
  const oldServer = (async (_url: string, init: RequestInit) => {
    const enc = (init.headers as Record<string, string>)["content-encoding"] ?? null;
    seen.push(enc);
    if (enc) return Response.json({ error: "definition required" }, { status: 400 });
    return Response.json({ revision: 8 });
  }) as unknown as typeof fetch;
  const first = await sendJson("http://x/d", json, { method: "PUT" }, oldServer);
  assert.equal(first.status, 200);
  assert.equal(isGzipRefused(), true);
  await sendJson("http://x/d", json, { method: "PUT" }, oldServer);
  assert.deepEqual(seen, ["gzip", null, null]);
  resetGzipRefusal();
});

test("a real refusal of the content (a 400 for another reason) is not retried", async () => {
  resetGzipRefusal();
  let calls = 0;
  const strict = (async () => { calls++; return Response.json({ error: "draft failed validation and was not saved" }, { status: 422 }); }) as unknown as typeof fetch;
  const r = await sendJson("http://x/d", JSON.stringify(bigDefinition()), { method: "PUT" }, strict);
  assert.equal(r.status, 422);
  assert.equal(calls, 1);
  assert.equal(isGzipRefused(), false);
});
