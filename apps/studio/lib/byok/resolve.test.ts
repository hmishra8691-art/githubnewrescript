import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MemoryAiStore, type CredentialRow, type SettingRow } from "./store.ts";
import { resolveConnection } from "./resolve.ts";
import { sealSecret, maskSecret } from "./vault.ts";

const env: Record<string, string | undefined> = { AI_CREDENTIAL_KEY: randomBytes(32).toString("hex") };
const ALICE = "aaaaaaaa-0000-0000-0000-000000000001", BOB = "bbbbbbbb-0000-0000-0000-000000000002";

async function seed(store: MemoryAiStore, userId: string, o: { id: string; provider?: string; key: string; model?: string; mode?: "user" | "platform"; feature?: "intelligent" | "additional" | "stt"; fallbacks?: SettingRow["fallbacks"]; allowPlatformFallback?: boolean; config?: unknown }) {
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
  const st = new MemoryAiStore(); await seed(st, ALICE, { id: CRED1, key: "sk-x-12345678", feature: "stt", config: { provider: "openai", base: "", model: "whisper-1", extra: {} } });
  assert.equal(await code({ feature: "stt" }, env, st), "unsupported_feature");
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
