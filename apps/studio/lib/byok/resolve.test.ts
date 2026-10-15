import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MemoryAiStore, type CredentialRow, type SettingRow } from "./store.ts";
import { resolveConnection } from "./resolve.ts";
import { sealSecret, maskSecret } from "./vault.ts";

const env: Record<string, string | undefined> = { AI_CREDENTIAL_KEY: randomBytes(32).toString("hex") };
const ALICE = "aaaaaaaa-0000-0000-0000-000000000001", BOB = "bbbbbbbb-0000-0000-0000-000000000002";

async function seed(store: MemoryAiStore, userId: string, o: { id: string; provider?: string; key: string; model?: string; mode?: "user" | "platform"; feature?: "intelligent" | "additional" | "stt" | "translation"; fallbacks?: SettingRow["fallbacks"]; allowPlatformFallback?: boolean; config?: unknown }) {
  const provider = o.provider ?? "openai";
  const { sealed, keyId } = sealSecret(o.key, { userId, credentialId: o.id }, env);
  const row: CredentialRow = { id: o.id, userId, provider, label: null, sealed, mask: maskSecret(o.key), keyId, createdAt: new Date().toISOString(), rotatedAt: null, lastUsedAt: new Date().toISOString(), lastTest: null };
  await store.createCredential(row);
  await store.putSetting({ userId, feature: o.feature ?? "intelligent", mode: o.mode ?? "user", config: (o.config ?? { provider, base: "", model: o.model ?? "gpt-4.1", extra: {} }) as never, credentialId: o.id, fallbacks: o.fallbacks ?? [], allowPlatformFallback: o.allowPlatformFallback ?? false, lastTest: null, updatedAt: new Date().toISOString() });
}
const CRED1 = "c1000000-0000-0000-0000-000000000001", CRED2 = "c2000000-0000-0000-0000-000000000002";

test("no setting → the platform; platform mode → the platform", async () => {
  const store = new MemoryAiStore();
  assert.deepEqual(await resolveConnection({ userId: ALICE, feature: "intelligent", store, env }), { kind: "platform", reason: "default" });
  await seed(store, ALICE, { id: CRED1, key: "sk-proj-AAAAAAAAAAAAAAAAAAAA", mode: "platform" });
  assert.deepEqual(await resolveConnection({ userId: ALICE, feature: "intelligent", store, env }), { kind: "platform", reason: "user_platform" });
});

test("a user-managed feature resolves to the user's own key, model and the registry's address — and only that", async () => {
  const store = new MemoryAiStore();
  await seed(store, ALICE, { id: CRED1, key: "sk-proj-ALICEKEYALICEKEYALICE", model: "gpt-4.1" });
  const r = await resolveConnection({ userId: ALICE, feature: "intelligent", store, env });
  assert.equal(r.kind, "user"); if (r.kind !== "user") return;
  assert.equal(r.scope.key, "sk-proj-ALICEKEYALICEKEYALICE"); assert.equal(r.scope.base, "https://api.openai.com/v1"); assert.equal(r.scope.model, "gpt-4.1");
  assert.equal(r.scope.source, "user"); assert.deepEqual(r.scope.fallbacks, []);
  assert.deepEqual(r.scope.headers, {});
});

test("nobody can resolve another user's connection: Bob never gets Alice's key, even naming her credential in his own setting", async () => {
  const store = new MemoryAiStore();
  await seed(store, ALICE, { id: CRED1, key: "sk-proj-ALICEKEYALICEKEYALICE" });
  assert.equal((await resolveConnection({ userId: BOB, feature: "intelligent", store, env })).kind, "platform", "Bob has no setting");
  await store.putSetting({ userId: BOB, feature: "intelligent", mode: "user", config: { provider: "openai", base: "", model: "gpt-4.1", extra: {} } as never, credentialId: CRED1, fallbacks: [{ credentialId: CRED1, config: { provider: "openai", base: "", model: "gpt-4.1", extra: {} } }], allowPlatformFallback: false, lastTest: null, updatedAt: new Date().toISOString() });
  const r = await resolveConnection({ userId: BOB, feature: "intelligent", store, env });
  assert.equal(r.kind, "refused"); assert.equal((r as { code: string }).code, "credential_missing");
  assert.equal(JSON.stringify(r).includes("ALICEKEY"), false);
});

test("user-managed never silently becomes platform: every unusable state is a refusal with a sentence", async () => {
  const mk = async () => { const s = new MemoryAiStore(); await seed(s, ALICE, { id: CRED1, key: "sk-proj-ALICEKEYALICEKEYALICE" }); return s; };
  const code = async (o: Partial<Parameters<typeof resolveConnection>[0]>, e = env, s?: MemoryAiStore) => { const r = await resolveConnection({ userId: ALICE, feature: "intelligent", store: s ?? await mk(), env: e, ...o }); return r.kind === "refused" ? r.code : r.kind; };
  assert.equal(await code({ workspaceAllows: false }), "byok_blocked");
  assert.equal(await code({}, {}), "vault_unavailable", "no master key");
  assert.equal(await code({}, { AI_CREDENTIAL_KEY: randomBytes(32).toString("hex") }), "credential_unreadable", "wrong master key");
  assert.equal(await code({ feature: "stt" as never }), "platform", "no stt setting and no project choice: platform");
  const s = await mk(); await s.deleteCredential(ALICE, CRED1);
  assert.equal(await code({}, env, s), "platform", "deleting the credential returns the feature to platform mode explicitly");
  const bad = new MemoryAiStore(); await seed(bad, ALICE, { id: CRED1, key: "sk-x-12345678", config: { provider: "openai", base: "", model: "not a model!!", extra: {} } });
  assert.equal(await code({}, env, bad), "invalid_config");
  const mismatch = new MemoryAiStore(); await seed(mismatch, ALICE, { id: CRED1, key: "sk-x-12345678", provider: "anthropic", config: { provider: "openai", base: "", model: "gpt-4.1", extra: {} } });
  assert.equal(await code({}, env, mismatch), "invalid_config", "a key saved for Anthropic is never sent to OpenAI");
  const tr = new MemoryAiStore(); await seed(tr, ALICE, { id: CRED1, key: "sk-x-12345678", feature: "translation" as never, config: { provider: "openai", base: "", model: "x", extra: {} } });
  assert.equal(await code({ feature: "translation" as never }, env, tr), "invalid_config", "a chat provider saved for translation is not a translation provider");
  assert.equal(await code({ need: ["embeddings"] as never }, env, await mk()), "user", "openai supports embeddings");
});

test("precedence: project platform beats the user's key; project user-managed needs the acting user's own connection", async () => {
  const store = new MemoryAiStore();
  await seed(store, ALICE, { id: CRED1, key: "sk-proj-ALICEKEYALICEKEYALICE" });
  assert.deepEqual(await resolveConnection({ userId: ALICE, feature: "intelligent", store, env, project: { mode: "platform" } }), { kind: "platform", reason: "project_platform" });
  const a = await resolveConnection({ userId: ALICE, feature: "intelligent", store, env, project: { mode: "user" } });
  assert.equal(a.kind, "user"); assert.equal((a as { source: string }).source, "project");
  const b = await resolveConnection({ userId: BOB, feature: "intelligent", store, env, project: { mode: "user" } });
  assert.equal(b.kind, "refused"); assert.equal((b as { code: string }).code, "no_connection"); assert.match((b as { message: string }).message, /Settings/);
});

test("fallbacks are the user's own list, in order; a broken one is skipped and reported, never replaced; the platform only when allowed", async () => {
  const store = new MemoryAiStore();
  await seed(store, ALICE, { id: CRED1, key: "sk-proj-PRIMARYPRIMARYPRIMARY", fallbacks: [] });
  const { sealed, keyId } = sealSecret("sk-ant-SECONDSECONDSECOND", { userId: ALICE, credentialId: CRED2 }, env);
  await store.createCredential({ id: CRED2, userId: ALICE, provider: "anthropic", label: null, sealed, mask: "x", keyId, createdAt: new Date().toISOString(), rotatedAt: null, lastUsedAt: null, lastTest: null });
  const set = (await store.getSetting(ALICE, "intelligent"))!;
  await store.putSetting({ ...set, fallbacks: [{ credentialId: CRED2, config: { provider: "anthropic", base: "", model: "claude-sonnet-4-5", extra: {} } }, { credentialId: "c9000000-0000-0000-0000-000000000009", config: { provider: "openai", base: "", model: "gpt-4.1", extra: {} } }] });
  const r = await resolveConnection({ userId: ALICE, feature: "intelligent", store, env: { ...env, AI_API_URL: "https://platform.example/v1", AI_API_KEY: "platform-secret", AI_MODEL: "pm" } });
  assert.equal(r.kind, "user"); if (r.kind !== "user") return;
  assert.deepEqual(r.scope.fallbacks.map((f) => [f.provider, f.key]), [["anthropic", "sk-ant-SECONDSECONDSECOND"]]);
  assert.equal(r.skippedFallbacks.length, 1);
  assert.equal(r.scope.fallbacks.some((f) => f.platform), false, "platform not allowed");
});

test("a custom endpoint is re-validated on every resolve: a private address saved earlier is refused", async () => {
  const store = new MemoryAiStore();
  await seed(store, ALICE, { id: CRED1, key: "sk-custom-1234567890", provider: "openai-compatible", config: { provider: "openai-compatible", base: "https://10.0.0.5/v1", model: "llama", extra: {} } });
  const r = await resolveConnection({ userId: ALICE, feature: "intelligent", store, env });
  assert.equal(r.kind, "refused"); assert.equal((r as { code: string }).code, "invalid_config");
});


/* ------------------------------------------------------------------ speech-to-text */

const STT = (provider: string, model: string, extra: Record<string, unknown> = {}) => ({ provider, base: "", model, extra, ...extra });

test("STT resolves to its own kind of scope: the speech provider's address, key, model, limits and language — never a chat scope", async () => {
  const store = new MemoryAiStore();
  /* the OpenAI key saved for chat also serves OpenAI speech: one vendor family */
  await seed(store, ALICE, { id: CRED1, provider: "openai", key: "sk-proj-SPEECHKEYSPEECHKEY", feature: "stt", config: { provider: "openai-stt", base: "", model: "whisper-1", language: "pt-BR", extra: { projectId: "proj_abc123" } } });
  const r = await resolveConnection({ userId: ALICE, feature: "stt", store, env });
  assert.equal(r.kind, "user"); if (r.kind !== "user") return;
  assert.equal(r.scopeKind, "stt");
  const sc = r.scope as import("@rescript/ai").SttScope;
  assert.deepEqual([sc.provider, sc.protocol, sc.base, sc.model, sc.key, sc.language], ["openai-stt", "openai-stt", "https://api.openai.com/v1", "whisper-1", "sk-proj-SPEECHKEYSPEECHKEY", "pt-BR"]);
  assert.deepEqual(sc.headers, { "openai-project": "proj_abc123" }); assert.equal(sc.limits?.maxBytes, 25 * 1024 * 1024);
  assert.equal("modelSmall" in sc, false, "no chat fields on a speech scope");
});

test("STT: Google keeps its protocol and its one-minute limit; a key is never offered across vendors or across kinds", async () => {
  const g = new MemoryAiStore();
  await seed(g, ALICE, { id: CRED1, provider: "google-stt", key: "AIzaSyGOOGLEKEYGOOGLEKEY", feature: "stt", config: { provider: "google-stt", base: "", model: "latest_short", extra: {} } });
  const r = await resolveConnection({ userId: ALICE, feature: "stt", store: g, env });
  assert.equal(r.kind, "user"); if (r.kind !== "user") return;
  const sc = r.scope as import("@rescript/ai").SttScope; assert.deepEqual([sc.protocol, sc.base, sc.limits?.maxSeconds], ["google-stt", "https://speech.googleapis.com/v1", 60]);
  const code = async (provider: string, config: unknown) => { const st = new MemoryAiStore(); await seed(st, ALICE, { id: CRED1, provider, key: "sk-x-12345678", feature: "stt", config }); const x = await resolveConnection({ userId: ALICE, feature: "stt", store: st, env }); return x.kind === "refused" ? x.code : x.kind; };
  assert.equal(await code("anthropic", STT("openai-stt", "whisper-1")), "invalid_config", "an Anthropic key is never sent to OpenAI");
  assert.equal(await code("openai", STT("groq-stt", "whisper-large-v3")), "invalid_config", "an OpenAI key is never sent to Groq");
  assert.equal(await code("google-gemini", STT("google-stt", "latest_short")), "invalid_config", "a Gemini key is not a Cloud Speech key");
  assert.equal(await code("openai", { provider: "openai", base: "", model: "gpt-4.1", extra: {} }), "invalid_config", "a chat provider is not a speech provider");
  assert.equal(await code("groq", STT("groq-stt", "whisper-large-v3")), "user", "Groq's chat key serves Groq speech");
});

test("STT is a separate setting: a user-managed chat setting does not make transcription user-managed, and a project's choice still needs the speech setting", async () => {
  const store = new MemoryAiStore();
  await seed(store, ALICE, { id: CRED1, key: "sk-proj-CHATONLYCHATONLY" });
  assert.deepEqual(await resolveConnection({ userId: ALICE, feature: "stt", store, env }), { kind: "platform", reason: "default" }, "no speech setting: the platform transcribes, as before");
  const r = await resolveConnection({ userId: ALICE, feature: "stt", store, env, project: { mode: "user" } });
  assert.equal(r.kind, "refused"); assert.equal((r as { code: string }).code, "no_connection"); assert.match((r as { message: string }).message, /speech-to-text/);
});

test("STT platform backstop: the installation's speech provider, only when the user allowed it and only when it can transcribe", async () => {
  const mk = async (allow: boolean) => { const st = new MemoryAiStore(); await seed(st, ALICE, { id: CRED1, provider: "openai", key: "sk-proj-SPEECHKEYSPEECHKEY", feature: "stt", allowPlatformFallback: allow, config: STT("openai-stt", "whisper-1") }); return st; };
  const platform = { ...env, AI_API_URL: "https://chat.example/v1", AI_API_KEY: "chat-key", AI_STT_API_URL: "https://stt.example/v1", AI_STT_API_KEY: "stt-key", AI_STT_MODEL: "whisper-large" };
  const on = await resolveConnection({ userId: ALICE, feature: "stt", store: await mk(true), env: platform });
  assert.equal(on.kind, "user"); if (on.kind !== "user") return;
  assert.deepEqual(on.scope.fallbacks.map((f) => [f.platform, f.base, f.key, f.model]), [[true, "https://stt.example/v1", "stt-key", "whisper-large"]]);
  const off = await resolveConnection({ userId: ALICE, feature: "stt", store: await mk(false), env: platform });
  assert.equal(off.kind === "user" && off.scope.fallbacks.length, 0, "not allowed: not listed");
  /* a platform whose chat provider has no speech endpoint offers no speech backstop */
  const anthropicOnly = await resolveConnection({ userId: ALICE, feature: "stt", store: await mk(true), env: { ...env, AI_API_URL: "https://api.anthropic.com/v1", AI_API_KEY: "k" } });
  assert.equal(anthropicOnly.kind === "user" && anthropicOnly.scope.fallbacks.length, 0);
});

/* ---------------------------------------------------------------- translation (Phase D) */

test("translation: a saved Google / DeepL / Azure connection resolves to a translate scope — registry address, their key, region header — and only that", async () => {
  const store = new MemoryAiStore();
  await seed(store, ALICE, { id: CRED1, provider: "azure-translator", key: "AZUREKEY-ALICE-0123456789", feature: "translation", config: { provider: "azure-translator", base: "", model: "3.0", extra: { region: "westeurope" } } });
  const r = await resolveConnection({ userId: ALICE, feature: "translation", store, env });
  assert.equal(r.kind, "user"); if (r.kind !== "user" || r.scopeKind !== "translate") return assert.fail("a translate scope");
  assert.equal(r.scope.key, "AZUREKEY-ALICE-0123456789"); assert.equal(r.scope.base, "https://api.cognitive.microsofttranslator.com");
  assert.equal(r.scope.protocol, "azure-v3"); assert.deepEqual(r.scope.headers, { "ocp-apim-subscription-region": "westeurope" });
  assert.equal(r.scope.source, "user"); assert.deepEqual(r.scope.fallbacks, []);
  assert.equal((await resolveConnection({ userId: BOB, feature: "translation", store, env })).kind, "platform", "Bob never gets Alice's");
});

test("translation: one Google Cloud key serves Speech-to-Text and Translation; a Gemini key and another vendor's key never do", async () => {
  const store = new MemoryAiStore();
  await seed(store, ALICE, { id: CRED1, provider: "google-stt", key: "AIza-ALICE-CLOUD-KEY-0123456789", feature: "translation", config: { provider: "google-translate", base: "", model: "v2", extra: {} } });
  assert.equal((await resolveConnection({ userId: ALICE, feature: "translation", store, env })).kind, "user", "same vendor family");
  const bad = new MemoryAiStore();
  await seed(bad, ALICE, { id: CRED1, provider: "google-gemini", key: "AIza-ALICE-GEMINI-KEY-0123456789", feature: "translation", config: { provider: "google-translate", base: "", model: "v2", extra: {} } });
  const r = await resolveConnection({ userId: ALICE, feature: "translation", store: bad, env });
  assert.equal(r.kind, "refused"); assert.equal((r as { code: string }).code, "invalid_config");
});

test("translation: fallbacks are the user's listed services, in order; the platform's own provider only when they allowed it — and a project choosing 'user' for a user with none is a refusal, not the platform", async () => {
  const store = new MemoryAiStore();
  process.env.GOOGLE_TRANSLATE_API_KEY = "PLATFORM-GKEY";
  try {
    await seed(store, ALICE, { id: CRED1, provider: "deepl", key: "DEEPL-ALICE-0123456789:fx", feature: "translation", config: { provider: "deepl-free", base: "", model: "v2", extra: {} }, allowPlatformFallback: true });
    const { sealed, keyId } = sealSecret("AZ-KEY-FALLBACK-0123456789", { userId: ALICE, credentialId: CRED2 }, env);
    await store.createCredential({ id: CRED2, userId: ALICE, provider: "azure-translator", label: null, sealed, mask: "x", keyId, createdAt: new Date().toISOString(), rotatedAt: null, lastUsedAt: null, lastTest: null });
    const s = (await store.getSetting(ALICE, "translation"))!;
    await store.putSetting({ ...s, fallbacks: [{ credentialId: CRED2, config: { provider: "azure-translator", base: "", model: "3.0", extra: {} } as never }] });
    const r = await resolveConnection({ userId: ALICE, feature: "translation", store, env });
    assert.ok(r.kind === "user" && r.scopeKind === "translate");
    if (r.kind === "user" && r.scopeKind === "translate") assert.deepEqual(r.scope.fallbacks.map((f) => f.platform ? "platform" : f.provider), ["azure-translator", "platform"]);
    /* the platform without a provider offers no backstop at all */
    delete process.env.GOOGLE_TRANSLATE_API_KEY;
    const r2 = await resolveConnection({ userId: ALICE, feature: "translation", store, env });
    if (r2.kind === "user" && r2.scopeKind === "translate") assert.deepEqual(r2.scope.fallbacks.map((f) => f.provider), ["azure-translator"]);
  } finally { delete process.env.GOOGLE_TRANSLATE_API_KEY; }
  const none = await resolveConnection({ userId: BOB, feature: "translation", store: new MemoryAiStore(), env, project: { mode: "user" } });
  assert.equal(none.kind, "refused"); assert.equal((none as { code: string }).code, "no_connection"); assert.match((none as { message: string }).message, /translation/);
});

test("translation by 'My AI model' resolves to the CHAT connection of Other AI features (their key, model, fallbacks); if that is not their own provider it is a refusal, never the platform's model", async () => {
  const store = new MemoryAiStore();
  await seed(store, ALICE, { id: CRED1, provider: "openai", key: "sk-proj-ALICECHATKEYALICECHATKEY", model: "gpt-4.1", feature: "additional" });
  const tr = { userId: ALICE, feature: "translation" as const, mode: "user" as const, config: { provider: "llm", base: "", model: "chat", extra: {} } as never, credentialId: null, fallbacks: [], allowPlatformFallback: false, lastTest: null, updatedAt: new Date().toISOString() };
  await store.putSetting(tr);
  const r = await resolveConnection({ userId: ALICE, feature: "translation", store, env });
  assert.ok(r.kind === "user" && r.scopeKind === "chat", "a chat scope");
  if (r.kind === "user") assert.equal((r.scope as { key: string }).key, "sk-proj-ALICECHATKEYALICECHATKEY");
  await store.putSetting({ ...(await store.getSetting(ALICE, "additional"))!, mode: "platform" });
  const refused = await resolveConnection({ userId: ALICE, feature: "translation", store, env });
  assert.equal(refused.kind, "refused"); assert.equal((refused as { code: string }).code, "no_connection"); assert.match((refused as { message: string }).message, /Other AI features/);
  /* and it is never accepted as a fallback service */
  const only = new MemoryAiStore();
  await seed(only, ALICE, { id: CRED1, provider: "deepl", key: "DEEPL-ALICE-0123456789:fx", feature: "translation", config: { provider: "deepl-free", base: "", model: "v2", extra: {} } });
  const s = (await only.getSetting(ALICE, "translation"))!;
  await only.putSetting({ ...s, fallbacks: [{ credentialId: CRED1, config: { provider: "llm", base: "", model: "chat", extra: {} } as never }] });
  const f = await resolveConnection({ userId: ALICE, feature: "translation", store: only, env });
  assert.ok(f.kind === "user" && f.scope.fallbacks.length === 0 && f.skippedFallbacks.length === 1, "the unusable fallback is skipped and reported");
});
