import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PROVIDERS, providerById, publicCatalog, validateConnection, headersFor, discoverModels, inferCapabilities, suggestionsFor } from "./registry.js";

test("the catalog: every entry is complete, fixed providers have https bases, only the custom one takes an address", () => {
  const ids = new Set<string>();
  for (const p of PROVIDERS) {
    assert.ok(!ids.has(p.id), `duplicate ${p.id}`); ids.add(p.id);
    assert.ok(p.label && p.capabilities.includes("chat"), p.id);
    if (p.customBase) assert.equal(p.base, null, p.id); else assert.match(p.base!, /^https:\/\/[a-z0-9.-]+(\/[\w./-]*)?$/, p.id);
    assert.ok(!p.base?.endsWith("/"), `${p.id}: no trailing slash`);
    for (const f of p.fields) { assert.ok(f.header && f.pattern.test(f.example.replace("…", "abc123")), `${p.id}.${f.id}`); }
  }
  assert.deepEqual(PROVIDERS.filter((p) => p.customBase).map((p) => p.id), ["openai-compatible"]);
  for (const id of ["openai", "anthropic", "google-gemini", "openai-compatible"]) assert.ok(providerById(id), id);
  const pub = JSON.stringify(publicCatalog("chat"));
  assert.ok(!/function|=>|RegExp/.test(pub)); assert.equal(publicCatalog("stt").length, 0, "no speech-to-text entry until its adapter exists");
});

test("validation: a fixed provider's address is the registry's whatever was sent; a custom one must pass the endpoint guard; identifiers have a shape", () => {
  const v = (input: Record<string, unknown>, allowPrivate = false) => validateConnection("chat", input, { allowPrivate });
  const a = v({ provider: "openai", base: "https://evil.example.com/v1", model: "gpt-4.1", extra: { projectId: "proj_abc123" } });
  assert.ok(a.ok); if (a.ok) { assert.equal(a.config.base, "https://api.openai.com/v1"); assert.deepEqual(a.config.extra, { projectId: "proj_abc123" }); }
  const bad = v({ provider: "openai", model: "gpt 4;rm -rf", extra: { projectId: "bad id!" } });
  assert.ok(!bad.ok); if (!bad.ok) { assert.ok(bad.errors.model); assert.ok(bad.errors["extra.projectId"]); }
  assert.ok(!v({ provider: "nope", model: "x" }).ok); assert.ok(!v({ model: "x" }).ok); assert.ok(!v({ provider: "openai" }).ok);
  /* an unknown field is dropped, not carried */
  const c = v({ provider: "anthropic", model: "claude-x", extra: { workspaceId: "wrkspc_123", authorization: "Bearer stolen", host: "evil" } });
  assert.ok(c.ok); if (c.ok) assert.deepEqual(c.config.extra, { workspaceId: "wrkspc_123" });
  const custom = v({ provider: "openai-compatible", base: "https://llm.example.org/v1/", model: "my-model:7b" });
  assert.ok(custom.ok); if (custom.ok) assert.equal(custom.config.base, "https://llm.example.org/v1");
  for (const base of ["http://llm.example.org/v1", "https://127.0.0.1/v1", "https://169.254.169.254/", "https://user:p@llm.example.org/v1", "", "https://localhost/v1"]) { const r = v({ provider: "openai-compatible", base, model: "m" }); assert.ok(!r.ok, base); if (!r.ok) assert.ok(r.errors.base, base); }
  assert.ok(v({ provider: "openai-compatible", base: "http://127.0.0.1:11434/v1", model: "llama" }, true).ok, "the operator's own network, when the server environment says so");
});

test("identifiers become headers from the registry's closed set, never from free text", () => {
  assert.deepEqual(headersFor(providerById("anthropic")!, { workspaceId: "wrkspc_1", authorization: "x" }), { "anthropic-workspace-id": "wrkspc_1" });
  assert.deepEqual(headersFor(providerById("openai")!, { organizationId: "org-1", projectId: "proj_1" }), { "openai-organization": "org-1", "openai-project": "proj_1" });
  assert.deepEqual(headersFor(providerById("groq")!, { organizationId: "org-1" }), {});
});

test("model capabilities are hints from the id: embeddings, speech and image models are not offered as chat", () => {
  assert.deepEqual(inferCapabilities("text-embedding-3-small"), ["embeddings"]);
  assert.deepEqual(inferCapabilities("whisper-1"), ["stt"]); assert.deepEqual(inferCapabilities("gpt-4o-transcribe"), ["stt"]);
  assert.deepEqual(inferCapabilities("tts-1"), ["tts"]); assert.deepEqual(inferCapabilities("dall-e-3"), []); assert.deepEqual(inferCapabilities("omni-moderation-latest"), []);
  assert.ok(inferCapabilities("gpt-4.1").includes("chat")); assert.ok(inferCapabilities("claude-sonnet-4").includes("json_object")); assert.ok(inferCapabilities("some-local-model").includes("chat"));
  assert.ok(suggestionsFor(providerById("openai")!).every((m) => m.source === "suggestion"));
});

async function srv(handler: http.RequestListener) {
  const seen: { url?: string; headers: http.IncomingHttpHeaders }[] = [];
  const s = http.createServer((q, r) => { seen.push({ url: q.url, headers: q.headers }); handler(q, r); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { seen, base: `http://127.0.0.1:${(s.address() as { port: number }).port}/v1`, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
}

test("model discovery: the provider's own list, sorted chat-first; each failure is a reason in words, never the provider's body", async () => {
  const list = await srv((_q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify({ data: [{ id: "whisper-1" }, { id: "gpt-4.1" }, { id: "text-embedding-3-small" }, { id: "models/gemini-2.5-pro", display_name: "Gemini Pro" }, { notAnId: 1 }] })); });
  const codes: Record<string, number> = { auth: 401, forbidden: 403, rate_limited: 429, unsupported: 404, unexpected: 500 };
  try {
    const def = providerById("openai")!;
    const ok = await discoverModels(def, list.base, "KEY-1", { "openai-project": "proj_1" }, { allowPrivate: true });
    assert.equal(ok.ok, true); assert.deepEqual(ok.models.map((m) => m.id), ["gemini-2.5-pro", "gpt-4.1", "text-embedding-3-small", "whisper-1"]);
    assert.equal(ok.models[0].label, "Gemini Pro"); assert.ok(ok.models.every((m) => m.source === "provider"));
    assert.equal(list.seen[0].headers.authorization, "Bearer KEY-1"); assert.equal(list.seen[0].headers["openai-project"], "proj_1");
    /* Anthropic lists models with its own header scheme */
    await discoverModels(providerById("anthropic")!, list.base, "KEY-2", {}, { allowPrivate: true });
    assert.equal(list.seen[1].headers["x-api-key"], "KEY-2"); assert.equal(list.seen[1].headers["anthropic-version"], "2023-06-01"); assert.equal(list.seen[1].headers.authorization, undefined);
  } finally { await list.close(); }
  for (const [reason, status] of Object.entries(codes)) {
    const s = await srv((_q, r) => { r.writeHead(status); r.end('{"error":"SECRET-PROVIDER-BODY sk-live-abcdef0123456789"}'); });
    try {
      const out = await discoverModels(providerById("openai")!, s.base, "K", {}, { allowPrivate: true });
      assert.equal(out.ok, false); assert.equal(out.reason, reason); assert.equal(JSON.stringify(out).includes("SECRET-PROVIDER-BODY"), false); assert.equal(JSON.stringify(out).includes("sk-live"), false);
    } finally { await s.close(); }
  }
  const refused = await discoverModels(providerById("openai-compatible")!, "https://169.254.169.254/v1", "K", {});
  assert.equal(refused.reason, "invalid_endpoint");
});
