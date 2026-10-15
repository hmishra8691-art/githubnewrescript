import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MemoryAiStore } from "./store.ts";
import { overview, saveCredential, saveSetting, removeCredential, testConnection, modelsFor, probeAllowed, cleanKey, silentWav, type Deps } from "./service.ts";
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
  assert.equal(o.features.find((x) => x.feature === "stt")!.supported, true);
  assert.equal(o.features.find((x) => x.feature === "translation")!.supported, true);
  assert.equal(o.features.find((x) => x.feature === "translation")!.kind, "translate");
  assert.deepEqual(o.translateCatalog.map((p) => p.id), ["google-translate", "deepl", "deepl-free", "azure-translator", "llm"]);
  const res = await resolveConnection({ userId: ALICE, feature: "intelligent", store: d.store, env });
  assert.equal(res.kind, "user"); assert.equal((res as { scope: { key: string } }).scope.key, KEY);
});

test("refusals are explicit: no vault key, workspace blocked, unsupported feature, bad config, missing key", async () => {
  const s = (o: Partial<Parameters<typeof saveSetting>[1]>, d: Deps) => saveSetting(ALICE, { feature: "intelligent", mode: "user", config: cfg, apiKey: KEY, ...o }, d);
  const code = async (p: ReturnType<typeof s>) => { const r = await p; return r.ok ? "ok" : `${r.status}:${r.code}`; };
  assert.equal(await code(s({}, mk({ env: {} }))), "503:vault_unavailable");
  assert.equal(await code(s({}, mk({ workspaceAllows: false }))), "403:byok_blocked");
  assert.equal(await code(s({ feature: "translation" }, mk())), "422:invalid_config", "a chat provider is not a translation provider");
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


/* ------------------------------------------------------------------ speech-to-text */

const DAVE = "dddddddd-0000-0000-0000-000000000004", ERIN = "eeeeeeee-0000-0000-0000-000000000005", FRANK = "ffffffff-0000-0000-0000-000000000006", GINA = "99999999-0000-0000-0000-000000000007";
const sttCfg = { provider: "openai-stt", model: "whisper-1", language: "en-GB" };
type Call = { url: string; init: RequestInit };
const capture = (status: number, body: unknown, calls: Call[]): typeof fetch => (async (url: string | URL, init: RequestInit = {}) => { calls.push({ url: String(url), init }); return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }) as never;

test("STT: the OpenAI key saved for chat serves OpenAI speech (one vendor family); the speech setting is saved, resolved and listed as its own kind", async () => {
  const d = mk();
  await saveSetting(ALICE, { feature: "intelligent", mode: "user", config: cfg, apiKey: KEY }, d);
  const saved = (await d.store.listCredentials(ALICE))[0];
  assert.equal((await saveSetting(ALICE, { feature: "stt", mode: "user", config: sttCfg }, d)).ok, false, "a saved key is chosen explicitly, never picked up silently");
  const r = await saveSetting(ALICE, { feature: "stt", mode: "user", config: sttCfg, credentialId: saved.id }, d); // the user picks the OpenAI key they already saved
  assert.ok(r.ok, JSON.stringify(r)); assert.equal(leaks(r, KEY), false);
  assert.equal((await d.store.listCredentials(ALICE)).length, 1, "one key, two features");
  const o = await overview(ALICE, d);
  const f = o.features.find((x) => x.feature === "stt")!;
  assert.deepEqual([f.kind, f.mode, f.supported, (f.config as { provider: string; language: string }).provider, (f.config as { language: string }).language], ["stt", "user", true, "openai-stt", "en-GB"]);
  assert.deepEqual(o.sttCatalog.map((p) => p.id), ["openai-stt", "groq-stt", "openai-compatible-stt", "google-stt"]);
  assert.ok(o.catalog.every((p) => p.kind === "chat"));
  const res = await resolveConnection({ userId: ALICE, feature: "stt", store: d.store, env });
  assert.equal(res.kind, "user"); assert.equal((res as { scopeKind: string }).scopeKind, "stt"); assert.equal((res as { scope: { key: string } }).scope.key, KEY);
  /* the chat setting is untouched by saving the speech one */
  assert.equal((await resolveConnection({ userId: ALICE, feature: "intelligent", store: d.store, env })).kind, "user");
});

test("STT: kinds are enforced on save — a chat provider cannot be a speech provider, nor the reverse; a key is not carried across vendors", async () => {
  const d = mk();
  const code = async (p: ReturnType<typeof saveSetting>) => { const r = await p; return r.ok ? "ok" : `${r.status}:${r.code}`; };
  assert.equal(await code(saveSetting(DAVE, { feature: "stt", mode: "user", config: { provider: "openai", model: "whisper-1" }, apiKey: KEY }, d)), "422:invalid_config");
  assert.equal(await code(saveSetting(DAVE, { feature: "intelligent", mode: "user", config: sttCfg, apiKey: KEY }, d)), "422:invalid_config");
  assert.equal(await code(saveSetting(DAVE, { feature: "stt", mode: "user", config: { ...sttCfg, language: "english please" }, apiKey: KEY }, d)), "422:invalid_config");
  await saveSetting(DAVE, { feature: "intelligent", mode: "user", config: cfg, apiKey: KEY }, d);
  assert.equal(await code(saveSetting(DAVE, { feature: "stt", mode: "user", config: { provider: "groq-stt", model: "whisper-large-v3" } }, d)), "422:key_required", "the saved OpenAI key is not offered to Groq");
  assert.equal(await code(saveSetting(DAVE, { feature: "stt", mode: "user", config: { provider: "groq-stt", model: "whisper-large-v3" }, credentialId: (await d.store.listCredentials(DAVE))[0].id }, d)), "422:provider_mismatch");
  assert.equal(await code(saveSetting(DAVE, { feature: "stt", mode: "user", config: { provider: "google-stt", model: "latest_short" }, apiKey: "AIzaSyGOOGLEKEYGOOGLEKEY" }, d)), "ok");
  /* a speech fallback must be a speech provider, with its own key of the right family */
  const fb = (await d.store.listCredentials(DAVE)).find((c) => c.provider === "openai")!;
  assert.equal(await code(saveSetting(DAVE, { feature: "stt", mode: "user", config: sttCfg, credentialId: fb.id, fallbacks: [{ credentialId: fb.id, config: { provider: "openai", model: "gpt-4.1" } }] }, d)), "422:invalid_fallback");
  assert.equal(await code(saveSetting(DAVE, { feature: "stt", mode: "user", config: { provider: "google-stt", model: "latest_short" }, credentialId: (await d.store.listCredentials(DAVE)).find((c) => c.provider === "google-stt")!.id, fallbacks: [{ credentialId: fb.id, config: { provider: "openai-stt", model: "whisper-1" } }] }, d)), "ok", "an OpenAI speech fallback behind Google, on the OpenAI key");
});

test("STT test connection (OpenAI-compatible): one second of silence, the user's key, the real endpoint; the provider's words and the key never come back", async () => {
  const calls: Call[] = [];
  const d = mk({ fetcher: capture(200, { text: "" }, calls) });
  const r = await testConnection(ERIN, { feature: "stt", config: { provider: "openai-stt", model: "whisper-1", extra: { projectId: "proj_abc123" } }, apiKey: KEY }, d);
  assert.ok(r.ok && r.result.ok); assert.match(r.result.message, /silent test recording was transcribed/);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, "https://api.openai.com/v1/audio/transcriptions");
  const h = calls[0].init.headers as Record<string, string>; assert.equal(h.authorization, `Bearer ${KEY}`); assert.equal(h["openai-project"], "proj_abc123");
  const form = calls[0].init.body as FormData; assert.equal(form.get("model"), "whisper-1"); const file = form.get("file") as File; assert.equal(file.type, "audio/wav"); assert.ok(file.size > 8000 && file.size < 20000);
  assert.equal(leaks(r, KEY), false);
  const fail = await testConnection(ERIN, { feature: "stt", config: { provider: "openai-stt", model: "whisper-1" }, apiKey: KEY }, mk({ fetcher: capture(401, { error: { message: `Incorrect API key provided: ${KEY}` } }, []) }));
  assert.ok(fail.ok && !fail.result.ok); assert.equal(fail.result.code, "auth"); assert.equal(leaks(fail, KEY, "Incorrect API key"), false);
  const gone = await testConnection(ERIN, { feature: "stt", config: { provider: "openai-stt", model: "whisper-9" }, apiKey: KEY }, mk({ fetcher: capture(404, { error: { message: "model not found" } }, []) }));
  assert.ok(gone.ok && !gone.result.ok); assert.equal(gone.result.code, "model_not_found");
});

test("STT test connection (Google): its endpoint, its header, its own sentences for a bad key and a disabled API", async () => {
  const calls: Call[] = [];
  const g = { provider: "google-stt", model: "latest_short" };
  const ok = await testConnection(FRANK, { feature: "stt", config: g, apiKey: "AIzaSyGOOGLEKEYGOOGLEKEY" }, mk({ fetcher: capture(200, {}, calls) }));
  assert.ok(ok.ok && ok.result.ok);
  assert.equal(calls[0].url, "https://speech.googleapis.com/v1/speech:recognize");
  const h = calls[0].init.headers as Record<string, string>; assert.equal(h["x-goog-api-key"], "AIzaSyGOOGLEKEYGOOGLEKEY"); assert.equal(h.authorization, undefined);
  const body = JSON.parse(String(calls[0].init.body)); assert.deepEqual([body.config.languageCode, body.config.model], ["en-US", "latest_short"]); assert.ok(body.audio.content.length > 1000);
  const bad = await testConnection(FRANK, { feature: "stt", config: g, apiKey: "AIzaSyGOOGLEKEYGOOGLEKEY" }, mk({ fetcher: capture(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }, []) }));
  assert.ok(bad.ok && !bad.result.ok); assert.equal(bad.result.code, "auth");
  const off = await testConnection(FRANK, { feature: "stt", config: g, apiKey: "AIzaSyGOOGLEKEYGOOGLEKEY" }, mk({ fetcher: capture(403, { error: { message: "Cloud Speech-to-Text API has not been used in project 1" } }, []) }));
  assert.ok(off.ok && !off.result.ok); assert.match(off.result.message, /Enable the Cloud Speech-to-Text API/);
});

test("STT model discovery: only what can transcribe; Google lists none and says to enter the model", async () => {
  const calls: Call[] = [];
  const d = mk({ fetcher: capture(200, { data: [{ id: "gpt-4.1" }, { id: "whisper-1" }, { id: "gpt-4o-mini-transcribe" }, { id: "text-embedding-3-small" }] }, calls) });
  const r = await modelsFor(GINA, { provider: "openai-stt", apiKey: KEY }, d);
  assert.ok(r.ok); if (r.ok) assert.deepEqual(r.models.map((m) => m.id).sort(), ["gpt-4o-mini-transcribe", "whisper-1"]);
  const g = await modelsFor(GINA, { provider: "google-stt", apiKey: "AIzaSyGOOGLEKEYGOOGLEKEY" }, mk({ fetcher: capture(200, {}, []) }));
  assert.ok(g.ok); if (g.ok) { assert.equal(g.discovered, false); assert.equal(g.reason, "unsupported"); assert.ok(g.suggestions.some((m) => m.id === "latest_long")); }
});

test("the silent probe recording is a valid WAV", () => {
  const w = silentWav(1), v = new DataView(w.buffer);
  assert.equal(String.fromCharCode(...w.slice(0, 4)), "RIFF"); assert.equal(String.fromCharCode(...w.slice(8, 12)), "WAVE");
  assert.equal(v.getUint32(4, true), w.length - 8); assert.equal(v.getUint32(40, true), w.length - 44); assert.equal(v.getUint32(24, true), 8000);
  assert.ok(w.slice(44).every((b) => b === 0));
});

/* ---------------------------------------------------------------- translation (Phase D) */

test("translation settings: a service with its own key; the model and address are the registry's; the key is sealed and never returned", async () => {
  const d = mk();
  const bad = await saveSetting(ALICE, { feature: "translation", mode: "user", config: { provider: "openai", model: "gpt-4.1" }, apiKey: KEY }, d);
  assert.equal(bad.ok, false);
  const r = await saveSetting(ALICE, { feature: "translation", mode: "user", config: { provider: "deepl-free", base: "https://evil.example/v2", model: "whatever" }, apiKey: "abcd1234-efgh-5678:fx" }, d);
  assert.ok(r.ok, JSON.stringify(r)); assert.equal(leaks(r, "abcd1234"), false);
  const o = await overview(ALICE, d);
  const f = o.features.find((x) => x.feature === "translation")!;
  assert.equal(f.mode, "user"); assert.deepEqual({ p: (f.config as { provider: string }).provider, b: (f.config as { base: string }).base, m: (f.config as { model: string }).model }, { p: "deepl-free", b: "https://api-free.deepl.com/v2", m: "v2" });
  assert.equal(leaks(o, "abcd1234", "efgh-5678"), false);
  assert.equal(f.credential!.mask.endsWith(":fx"), true);
  /* a Google Cloud key saved for speech is offered to Translation (same family) but an OpenAI key is not */
  const g = mk();
  assert.ok((await saveSetting(ALICE, { feature: "stt", mode: "user", config: { provider: "google-stt", model: "latest_short" }, apiKey: "AIzaSyALICE-CLOUD-KEY-0123456789" }, g)).ok);
  const cred = (await overview(ALICE, g)).credentials[0];
  assert.ok((await saveSetting(ALICE, { feature: "translation", mode: "user", config: { provider: "google-translate" }, credentialId: cred.id }, g)).ok, "the same Google Cloud key");
  const o2 = mk();
  assert.ok((await saveSetting(ALICE, { feature: "additional", mode: "user", config: cfg, apiKey: KEY }, o2)).ok);
  const oc = (await overview(ALICE, o2)).credentials[0];
  const mism = await saveSetting(ALICE, { feature: "translation", mode: "user", config: { provider: "deepl" }, credentialId: oc.id }, o2);
  assert.equal(mism.ok, false); assert.equal((mism as { code: string }).code, "provider_mismatch");
});

test("translation settings: 'My AI model' needs no key but needs Other AI features to be the user's own provider; fallbacks are services with their own keys", async () => {
  const d = mk();
  const early = await saveSetting(ALICE, { feature: "translation", mode: "user", config: { provider: "llm" } }, d);
  assert.equal(early.ok, false); assert.equal((early as { code: string }).code, "chat_required");
  assert.ok((await saveSetting(ALICE, { feature: "additional", mode: "user", config: cfg, apiKey: KEY }, d)).ok);
  const ok = await saveSetting(ALICE, { feature: "translation", mode: "user", config: { provider: "llm" }, allowPlatformFallback: true }, d);
  assert.ok(ok.ok);
  const s = await d.store.getSetting(ALICE, "translation");
  assert.equal(s!.credentialId, null); assert.equal(s!.allowPlatformFallback, false, "its backstop is the one on Other AI features");
  assert.equal((await saveSetting(ALICE, { feature: "translation", mode: "user", config: { provider: "llm" }, fallbacks: [{ credentialId: "x", config: {} }] }, d)).ok, false);
  const d2 = mk();
  assert.ok((await saveSetting(ALICE, { feature: "additional", mode: "user", config: cfg, apiKey: KEY }, d2)).ok);
  const key = (await overview(ALICE, d2)).credentials[0];
  assert.ok((await saveSetting(ALICE, { feature: "translation", mode: "user", config: { provider: "deepl" }, apiKey: "deeplkey-0123456789" }, d2)).ok);
  const fb = await saveSetting(ALICE, { feature: "translation", mode: "user", config: { provider: "deepl" }, fallbacks: [{ credentialId: key.id, config: { provider: "llm" } }] }, d2);
  assert.equal(fb.ok, false); assert.equal((fb as { code: string }).code, "invalid_fallback");
});

let nextUser = 1000;
/* each probe is rate-limited per user, so a test that makes many uses a user per probe */
const fresh = () => `dddddddd-0000-0000-0000-${String(nextUser++).padStart(12, "0")}`;

test("translation Test Connection: two characters translated the way the Studio does; each provider's failure said in words; the provider's own text and the key never come back", async () => {
  const d = mk();
  const seen: { url: string; init: RequestInit }[] = [];
  const ok = (body: unknown) => (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response(JSON.stringify(body), { status: 200 }); }) as never;
  const t = await testConnection(fresh(), { feature: "translation", config: { provider: "deepl" }, apiKey: "deeplkey-0123456789:fx" }, mk({ fetcher: ok({ translations: [{ text: "OK" }] }) }));
  assert.ok(t.ok && t.result.ok, JSON.stringify(t)); assert.match((t as { result: { message: string } }).result.message, /translated/);
  assert.equal(seen[0].url, "https://api.deepl.com/v2/translate"); assert.equal((seen[0].init.headers as Record<string, string>).authorization, "DeepL-Auth-Key deeplkey-0123456789:fx");
  assert.deepEqual(JSON.parse(String(seen[0].init.body)).text, ["OK"]);
  const az = await testConnection(fresh(), { feature: "translation", config: { provider: "azure-translator", extra: { region: "westeurope" } }, apiKey: "azurekey-0123456789" }, mk({ fetcher: ok([{ translations: [{ text: "OK", to: "es" }] }]) }));
  assert.ok(az.ok && az.result.ok); assert.equal((seen.at(-1)!.init.headers as Record<string, string>)["ocp-apim-subscription-region"], "westeurope");
  const g = await testConnection(fresh(), { feature: "translation", config: { provider: "google-translate" }, apiKey: "AIzaSyGOOGLE-0123456789" }, mk({ fetcher: ok({ data: { translations: [{ translatedText: "OK" }] } }) }));
  assert.ok(g.ok && g.result.ok); assert.equal((seen.at(-1)!.init.headers as Record<string, string>)["x-goog-api-key"], "AIzaSyGOOGLE-0123456789"); assert.ok(!seen.at(-1)!.url.includes("AIza"), "the key is not in the URL");
  /* failures */
  const fail = async (status: number, body: unknown, provider = "deepl", apiKey = "deeplkey-0123456789") => (await testConnection(fresh(), { feature: "translation", config: { provider }, apiKey }, mk({ fetcher: reply(status, body) as never }))) as { ok: true; result: { ok: boolean; code: string; message: string } };
  const a = await fail(403, { message: "Authorization failure SECRET-PROVIDER-TEXT" });
  assert.equal(a.result.ok, false); assert.equal(a.result.code, "auth"); assert.match(a.result.message, /:fx/); assert.equal(leaks(a, "SECRET-PROVIDER-TEXT", "deeplkey"), false);
  assert.equal((await fail(456, {})).result.code, "quota");
  assert.equal((await fail(429, {})).result.code, "rate_limited");
  assert.equal((await fail(401, { error: { code: 401000, message: "x" } }, "azure-translator", "azurekey-0123456789")).result.code, "auth");
  const html = await testConnection(fresh(), { feature: "translation", config: { provider: "deepl" }, apiKey: "deeplkey-0123456789" }, mk({ fetcher: reply(200, "<html>captive portal</html>") as never }));
  assert.ok(html.ok && !html.result.ok && html.result.code === "unexpected");
  /* "My AI model" tests the chat connection it uses */
  const d3 = mk({ fetcher: reply(200, { choices: [{ message: { content: "OK" } }] }) as never });
  const L = fresh();
  assert.equal(((await testConnection(L, { feature: "translation", config: { provider: "llm" } }, d3)) as { code: string }).code, "chat_required");
  assert.ok((await saveSetting(L, { feature: "additional", mode: "user", config: cfg, apiKey: KEY }, d3)).ok);
  const viaChat = await testConnection(L, { feature: "translation", config: { provider: "llm" } }, d3);
  assert.ok(viaChat.ok && viaChat.result.ok);
  void d;
});

test("translation has no model list to fetch", async () => {
  const r = await modelsFor(ALICE, { provider: "deepl", apiKey: "deeplkey-0123456789" }, mk());
  assert.ok(r.ok); if (r.ok) { assert.equal(r.discovered, false); assert.deepEqual(r.models, []); }
});
