import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MemoryAiStore } from "./store.ts";
import { overview, saveCredential, saveSetting, removeCredential, testConnection, modelsFor, probeAllowed, cleanKey, type Deps } from "./service.ts";
import { resolveConnection } from "./resolve.ts";

const env: Record<string, string | undefined> = { AI_CREDENTIAL_KEY: randomBytes(32).toString("hex") };
const ALICE = "aaaaaaaa-0000-0000-0000-000000000001", BOB = "bbbbbbbb-0000-0000-0000-000000000002", CAROL = "cccccccc-0000-0000-0000-000000000003";
const KEY = "sk-proj-ALICESECRETKEYVALUE1234567890";
const cfg = { provider: "openai", model: "gpt-4.1" };
const mk = (extra: Partial<Deps> = {}): Deps => ({ store: new MemoryAiStore(), env, ...extra });
const reply = (status: number, body: unknown) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const leaks = (v: unknown, ...secrets: string[]) => { const j = JSON.stringify(v); return secrets.some((s) => j.includes(s)) || /"sealed"/.test(j); };

test("saving user-managed AI seals the key, masks it, and returns neither — and the resolver then uses exactly that key", async () => {
  const d = mk();
  const r = await saveSetting(ALICE, { feature: "intelligent", mode: "user", config: cfg, apiKey: KEY, label: "Work key" }, d);
  assert.equal(r.ok, true); assert.equal(leaks(r, KEY), false);
  const o = await overview(ALICE, d);
  assert.equal(leaks(o, KEY, "ALICESECRET"), false, "no secret, no ciphertext in what a screen is told");
  const f = o.features.find((x) => x.feature === "intelligent")!;
  assert.equal(f.mode, "user"); assert.equal(f.credential!.mask, "sk-proj-••••••••7890"); assert.equal(f.credential!.label, "Work key");
  assert.equal(o.features.find((x) => x.feature === "stt")!.supported, false);
  const res = await resolveConnection({ userId: ALICE, feature: "intelligent", store: d.store, env });
  assert.equal(res.kind, "user"); assert.equal((res as { scope: { key: string } }).scope.key, KEY);
});

test("refusals are explicit: no vault key, workspace blocked, unsupported feature, bad config, missing key", async () => {
  const s = (o: Partial<Parameters<typeof saveSetting>[1]>, d: Deps) => saveSetting(ALICE, { feature: "intelligent", mode: "user", config: cfg, apiKey: KEY, ...o }, d);
  const code = async (p: ReturnType<typeof s>) => { const r = await p; return r.ok ? "ok" : `${r.status}:${r.code}`; };
  assert.equal(await code(s({}, mk({ env: {} }))), "503:vault_unavailable");
  assert.equal(await code(s({}, mk({ workspaceAllows: false }))), "403:byok_blocked");
  assert.equal(await code(s({ feature: "stt" }, mk())), "422:unsupported_feature");
  assert.equal(await code(s({ feature: "nope" }, mk())), "422:invalid_feature");
  assert.equal(await code(s({ mode: "maybe" }, mk())), "422:invalid_mode");
  assert.equal(await code(s({ config: { provider: "openai", model: "bad model!" } }, mk())), "422:invalid_config");
  assert.equal(await code(s({ config: { provider: "nope", model: "x" } }, mk())), "422:invalid_config");
  assert.equal(await code(s({ apiKey: undefined }, mk())), "422:key_required");
  assert.equal(await code(s({ apiKey: "has space inside" }, mk())), "422:invalid_key");
  assert.equal(await code(s({ config: { provider: "openai-compatible", base: "https://10.0.0.5/v1", model: "m" } }, mk())), "422:invalid_config");
  assert.equal(await code(s({ config: { provider: "openai-compatible", base: "http://example.com/v1", model: "m" } }, mk())), "422:invalid_config");
  assert.equal(await code(s({ config: { provider: "openai-compatible", base: "https://llm.example.com/v1", model: "m" } }, mk())), "ok");
  const e = await s({ config: { provider: "openai", model: "bad model!" } }, mk()); assert.ok(!e.ok && e.errors?.model);
});

test("a fixed provider's address cannot be redirected by the request; platform mode clears everything and keeps stored keys", async () => {
  const d = mk();
  await saveSetting(ALICE, { feature: "intelligent", mode: "user", config: { ...cfg, base: "https://evil.example/v1" }, apiKey: KEY }, d);
  const res = await resolveConnection({ userId: ALICE, feature: "intelligent", store: d.store, env });
  assert.equal((res as { scope: { base: string } }).scope.base, "https://api.openai.com/v1");
  await saveSetting(ALICE, { feature: "intelligent", mode: "platform" }, d);
  assert.deepEqual(await resolveConnection({ userId: ALICE, feature: "intelligent", store: d.store, env }), { kind: "platform", reason: "user_platform" });
  assert.equal((await d.store.listCredentials(ALICE)).length, 1, "the key is still saved, ready to use again");
});

test("another user can never use, replace, list or delete Alice's key", async () => {
  const d = mk();
  const a = await saveSetting(ALICE, { feature: "intelligent", mode: "user", config: cfg, apiKey: KEY }, d);
  assert.ok(a.ok);
  const aliceCred = (await d.store.listCredentials(ALICE))[0]!;
  assert.deepEqual((await overview(BOB, d)).credentials, []);
  const useIt = await saveSetting(BOB, { feature: "intelligent", mode: "user", config: cfg, credentialId: aliceCred.id }, d);
  assert.ok(!useIt.ok && useIt.code === "key_required");
  const rotate = await saveCredential(BOB, { provider: "openai", apiKey: "sk-proj-BOBSKEYBOBSKEYBOBSKEY", credentialId: aliceCred.id }, d);
  assert.ok(!rotate.ok && rotate.status === 404);
  const asFallback = await saveSetting(BOB, { feature: "intelligent", mode: "user", config: cfg, apiKey: "sk-proj-BOBSKEYBOBSKEYBOBSKEY", fallbacks: [{ credentialId: aliceCred.id, config: { provider: "openai", model: "gpt-4.1-mini" } }] }, d);
  assert.ok(!asFallback.ok && asFallback.code === "invalid_fallback");
  const del = await removeCredential(BOB, aliceCred.id, d);
  assert.ok(!del.ok && del.status === 404);
  const t = await testConnection(BOB, { config: cfg, credentialId: aliceCred.id }, { ...d, fetcher: reply(200, {}) as never });
  assert.ok(!t.ok && t.code === "key_required");
  assert.equal((await d.store.getCredential(ALICE, aliceCred.id))!.sealed, aliceCred.sealed, "untouched");
});

test("replacing a key rotates it in place: same credential, new secret, new mask, old key gone", async () => {
  const d = mk();
  await saveSetting(ALICE, { feature: "intelligent", mode: "user", config: cfg, apiKey: KEY }, d);
  const before = (await d.store.listCredentials(ALICE))[0]!;
  const NEW = "sk-proj-NEWKEYNEWKEYNEWKEY999999";
  const r = await saveSetting(ALICE, { feature: "intelligent", mode: "user", config: cfg, credentialId: before.id, apiKey: NEW }, d);
  assert.ok(r.ok && r.credentialSaved);
  const after = await d.store.listCredentials(ALICE);
  assert.equal(after.length, 1); assert.equal(after[0]!.id, before.id); assert.notEqual(after[0]!.sealed, before.sealed); assert.ok(after[0]!.rotatedAt);
  assert.equal((await resolveConnection({ userId: ALICE, feature: "intelligent", store: d.store, env }) as { scope: { key: string } }).scope.key, NEW);
  assert.equal(after[0]!.mask, "sk-proj-••••••••9999");
});

test("removing a key returns its features to the platform, explicitly, and drops it from fallback lists", async () => {
  const d = mk();
  await saveSetting(ALICE, { feature: "intelligent", mode: "user", config: cfg, apiKey: KEY }, d);
  const second = await saveCredential(ALICE, { provider: "anthropic", apiKey: "sk-ant-api03-SECONDSECONDSECOND" }, d);
  assert.ok(second.ok);
  await saveSetting(ALICE, { feature: "additional", mode: "user", config: cfg, credentialId: (await d.store.listCredentials(ALICE))[0]!.id, fallbacks: [{ credentialId: (second as { credential: { id: string } }).credential.id, config: { provider: "anthropic", model: "claude-sonnet-4-5" } }] }, d);
  const r = await removeCredential(ALICE, (second as { credential: { id: string } }).credential.id, d);
  assert.ok(r.ok);
  assert.deepEqual((await d.store.getSetting(ALICE, "additional"))!.fallbacks, []);
  await removeCredential(ALICE, (await d.store.listCredentials(ALICE))[0]!.id, d);
  assert.equal((await d.store.getSetting(ALICE, "intelligent"))!.mode, "platform");
  assert.deepEqual(await resolveConnection({ userId: ALICE, feature: "intelligent", store: d.store, env }), { kind: "platform", reason: "user_platform" });
});

test("fallbacks: at most three, no duplicates, none equal to the primary", async () => {
  const d = mk();
  await saveSetting(ALICE, { feature: "intelligent", mode: "user", config: cfg, apiKey: KEY }, d);
  const id = (await d.store.listCredentials(ALICE))[0]!.id;
  const fb = (model: string) => ({ credentialId: id, config: { provider: "openai", model } });
  const code = async (fallbacks: unknown[]) => { const r = await saveSetting(ALICE, { feature: "intelligent", mode: "user", config: cfg, credentialId: id, fallbacks }, d); return r.ok ? "ok" : r.code; };
  assert.equal(await code([fb("gpt-4.1-mini")]), "ok");
  assert.equal(await code([fb("gpt-4.1")]), "invalid_fallback");
  assert.equal(await code([fb("a1x"), fb("a1x")]), "invalid_fallback");
  assert.equal(await code([fb("a1x"), fb("b2x"), fb("c3x"), fb("d4x")]), "too_many_fallbacks");
});

test("test connection: success; every provider failure becomes a sentence; the provider's own text and the key never come back", async () => {
  const d = mk();
  await saveSetting(ALICE, { feature: "intelligent", mode: "user", config: cfg, apiKey: KEY }, d);
  const credentialId = (await d.store.listCredentials(ALICE))[0]!.id;
  let sent: { url: string; init: RequestInit } | null = null;
  const ok = await testConnection(ALICE, { config: cfg, credentialId, feature: "intelligent" }, { ...d, fetcher: (async (url: string, init: RequestInit) => { sent ??= { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }); }) as never });
  assert.ok(ok.ok && ok.result.ok && ok.result.code === "ok" && ok.result.jsonMode === true);
  assert.equal(sent!.url, "https://api.openai.com/v1/chat/completions");
  assert.equal((sent!.init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  assert.equal((await d.store.getCredential(ALICE, credentialId))!.lastTest!.ok, true);
  assert.equal((await d.store.getSetting(ALICE, "intelligent"))!.lastTest!.code, "ok");
  const body = { error: { message: `Incorrect API key provided: ${KEY}. secret-provider-text` } };
  const cases: [number, unknown, string][] = [
    [401, body, "auth"], [403, body, "forbidden"], [404, body, "model_not_found"], [429, { error: { message: "Rate limit reached" } }, "rate_limited"],
    [400, { error: { message: "Your credit balance is too low to access the Anthropic API" } }, "quota"], [500, body, "provider_error"], [503, body, "provider_error"],
  ];
  for (const [status, b, code] of cases) {
    const dd = { ...d, now: () => Date.now() + Math.random() * 1000 };
    const r = await testConnection(ALICE, { config: cfg, credentialId }, { ...dd, fetcher: reply(status, b) as never });
    assert.ok(r.ok, String(status)); assert.equal(r.result.ok, false); assert.ok(["auth", "forbidden", "model_not_found", "rate_limited", "quota", "provider_error", "overloaded"].includes(r.result.code), `${status} → ${r.result.code}`);
    if (status !== 503 && status !== 500) assert.equal(r.result.code, code, String(status));
    assert.equal(leaks(r, KEY, "secret-provider-text"), false);
  }
  const refused = await testConnection(ALICE, { config: cfg, credentialId }, { ...d, fetcher: (async () => { throw Object.assign(new Error("That address is not allowed."), { name: "EndpointRefused", code: "private" }); }) as never });
  assert.ok(refused.ok && refused.result.code === "invalid_endpoint");
  const down = await testConnection(ALICE, { config: cfg, credentialId }, { ...d, fetcher: (async () => { throw new Error(`connect ECONNREFUSED ${KEY}`); }) as never });
  assert.ok(down.ok && down.result.code === "unreachable" && !leaks(down, KEY));
});

test("test connection works on a typed, unsaved key (nothing is stored), and refuses when the workspace forbids it", async () => {
  const d = mk();
  const r = await testConnection(ALICE, { config: cfg, apiKey: KEY }, { ...d, fetcher: reply(200, {}) as never });
  assert.ok(r.ok && r.result.ok); assert.deepEqual(await d.store.listCredentials(ALICE), []);
  const blocked = await testConnection(ALICE, { config: cfg, apiKey: KEY }, { ...d, workspaceAllows: false, fetcher: reply(200, {}) as never });
  assert.ok(!blocked.ok && blocked.code === "byok_blocked");
  const bad = await testConnection(ALICE, { config: cfg, apiKey: "no spaces allowed here" }, { ...d, fetcher: reply(200, {}) as never });
  assert.ok(!bad.ok && bad.code === "invalid_key");
});

test("probe endpoints are rate limited per user", () => {
  const t = Date.now();
  for (let i = 0; i < 12; i++) assert.equal(probeAllowed("rl-user", t + i), true);
  assert.equal(probeAllowed("rl-user", t + 20), false);
  assert.equal(probeAllowed("other-user", t + 20), true);
  assert.equal(probeAllowed("rl-user", t + 61_000), true);
});

test("model discovery: the provider's list for this key; an unlisting provider yields suggestions and a sentence", async () => {
  const d = mk();
  const ok = await modelsFor(CAROL, { provider: "openai", apiKey: KEY }, { ...d, fetcher: reply(200, { data: [{ id: "gpt-4.1" }, { id: "text-embedding-3-small" }] }) as never });
  assert.ok(ok.ok && "models" in ok && ok.discovered && ok.models.some((m) => m.id === "gpt-4.1"));
  const nolist = await modelsFor(CAROL, { provider: "openai", apiKey: KEY }, { ...d, fetcher: reply(404, {}) as never });
  assert.ok(nolist.ok && "suggestions" in nolist && !nolist.discovered && nolist.suggestions.length > 0 && nolist.message);
  const auth = await modelsFor(CAROL, { provider: "openai", apiKey: KEY }, { ...d, fetcher: reply(401, { error: "bad key " + KEY }) as never });
  assert.ok(auth.ok && "reason" in auth && auth.reason === "auth" && !leaks(auth, KEY));
  const priv = await modelsFor(CAROL, { provider: "openai-compatible", base: "https://192.168.1.4/v1", apiKey: KEY }, { ...d, fetcher: reply(200, {}) as never });
  assert.ok(!priv.ok && priv.code === "invalid_config");
});

test("key cleaning", () => {
  assert.equal(cleanKey("  sk-abc12345  "), "sk-abc12345"); assert.equal(cleanKey("Bearer sk-abc12345"), "sk-abc12345");
  for (const bad of ["short", "has a space1234", "tab\tkey12345", "línea-ñ-12345", 42, null, "x".repeat(401)]) assert.equal(cleanKey(bad), null);
});
