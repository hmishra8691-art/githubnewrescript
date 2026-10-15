import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { publicCatalog } from "@rescript/ai";
import { MemoryAiStore } from "./store.ts";
import { overview, saveSetting, saveCredential } from "./service.ts";
import {
  blockedReason, changes, chooseProvider, draftFromFeature, emptyDraft, fallbackKeysToSave, isDirty, keysFor, modeWords, platformBackstopAvailable, problems, providerIndex, saveBody, testBody, testWords,
  type Overview,
} from "./settingsModel.ts";

const env: Record<string, string | undefined> = { AI_CREDENTIAL_KEY: randomBytes(32).toString("hex"), AI_API_URL: "https://platform.example/v1", AI_API_KEY: "platform-secret", AI_MODEL: "pm" };
const U = "bbbbbbbb-0000-0000-0000-0000000000e1";
const SECRET = "sk-proj-SETTINGSMODELSECRETKEY0001";
const fresh = async () => { const store = new MemoryAiStore(); return { store, deps: { store, env } }; };
const ov = async (deps: { store: MemoryAiStore; env: typeof env }) => (await overview(U, deps)) as unknown as Overview;

test("the overview the screen reads has a catalog per kind, no secret, and four features", async () => {
  const { deps } = await fresh();
  await saveSetting(U, { feature: "intelligent", mode: "user", config: { provider: "openai", model: "gpt-4.1" }, apiKey: SECRET }, deps);
  const o = await ov(deps);
  assert.equal(o.features.length, 4);
  assert.ok(o.catalog.length && o.sttCatalog.length && o.translateCatalog.length);
  assert.equal(JSON.stringify(o).includes(SECRET), false, "the key is never in what the screen reads");
  assert.match(o.credentials[0].mask, /••|\.\.\.|…/);
});

test("a saved feature becomes a clean draft; any edit is a named change; discarding is equality", async () => {
  const { deps } = await fresh();
  await saveSetting(U, { feature: "intelligent", mode: "user", config: { provider: "openai", model: "gpt-4.1" }, apiKey: SECRET }, deps);
  const o = await ov(deps); const f = o.features.find((x) => x.feature === "intelligent")!;
  const saved = draftFromFeature(f);
  assert.equal(saved.mode, "user"); assert.equal(saved.provider, "openai"); assert.equal(saved.model, "gpt-4.1"); assert.equal(saved.newKey, "", "a key is never prefilled");
  assert.deepEqual(changes(saved, saved), []);
  assert.deepEqual(changes({ ...saved, model: "gpt-4.1-mini" }, saved), ["model"]);
  assert.ok(changes({ ...saved, newKey: "typed-new-key-value" }, saved).includes("key"));
  assert.deepEqual(changes({ ...saved, model: "  gpt-4.1  " }, saved), [], "whitespace is not a change");
  assert.ok(isDirty({ ...saved, allowPlatformFallback: true }, saved));
  assert.deepEqual(changes({ ...saved, mode: "platform" }, saved), ["mode"]);
  assert.deepEqual(changes(draftFromFeature(o.features.find((x) => x.feature === "stt")!), draftFromFeature(o.features.find((x) => x.feature === "stt")!)), [], "a platform-managed feature is clean");
});

test("choosing a provider resets what belonged to the last one: address, model, identifiers and key", async () => {
  const { deps } = await fresh();
  await saveCredential(U, { provider: "openai", apiKey: SECRET }, deps);
  const o = await ov(deps); const idx = providerIndex(o);
  const d0 = { ...emptyDraft("openai"), model: "gpt-4.1", extra: { organizationId: "org-1" }, credentialId: o.credentials[0].id, newKey: "typed" };
  const d1 = chooseProvider(d0, idx.get("anthropic"), keysFor(o, "anthropic"));
  assert.equal(d1.provider, "anthropic"); assert.equal(d1.credentialId, null, "an OpenAI key is not carried to Anthropic"); assert.equal(d1.newKey, ""); assert.deepEqual(d1.extra, {});
  const d2 = chooseProvider(d0, idx.get("openai"), keysFor(o, "openai"));
  assert.equal(d2.credentialId, o.credentials[0].id, "the only saved key of the same vendor is offered");
  const custom = chooseProvider(d0, idx.get(o.catalog.find((p) => p.customBase)!.id), []);
  assert.equal(custom.base, "", "a custom provider starts with no address");
});

test("keys are offered only within a vendor family: a Google Cloud key serves speech and translation, never DeepL", async () => {
  const { deps } = await fresh();
  const g = await saveCredential(U, { provider: "google-translate", apiKey: "AIzaSyGOOGLECLOUDKEY000000000001" }, deps);
  assert.ok(g.ok);
  const o = await ov(deps);
  assert.equal(keysFor(o, "google-stt").length, 1, "same family");
  assert.equal(keysFor(o, "deepl").length, 0, "another vendor");
  assert.equal(keysFor(o, "openai").length, 0);
});

test("local problems name what is missing before any round trip", async () => {
  const { deps } = await fresh();
  const o = await ov(deps); const idx = providerIndex(o);
  const none = () => false;
  assert.equal(problems({ ...emptyDraft(""), mode: "user" }, undefined, none).provider, "Choose a provider.");
  const openai = idx.get("openai")!;
  const p = problems(emptyDraft("openai"), openai, none);
  assert.ok(p.model && p.key, "model and key are missing");
  assert.deepEqual(problems({ ...emptyDraft("openai"), model: "gpt-4.1", newKey: "sk-abcdefgh1234" }, openai, none), {});
  assert.ok(problems({ ...emptyDraft("openai"), model: "m", newKey: "sk abcd efgh" }, openai, none).key, "a key has no spaces");
  const deepl = idx.get("deepl")!;
  assert.deepEqual(problems({ ...emptyDraft("deepl"), newKey: "abc:fx-123456" }, deepl, none), {}, "a translation service has no model to choose");
  const azure = idx.get("azure-translator")!;
  const az = problems({ ...emptyDraft("azure-translator"), newKey: "abcdefgh12345678" }, azure, none);
  assert.deepEqual(Object.keys(az).filter((k) => k.startsWith("extra.")), azure.fields.filter((f) => f.required).map((f) => `extra.${f.id}`));
  assert.deepEqual(problems({ ...emptyDraft("llm") }, idx.get("llm")!, none), {}, "My AI model needs no key of its own");
  const fb = problems({ ...emptyDraft("openai"), model: "m", newKey: "sk-abcdefgh1234", fallbacks: [{ provider: "groq", base: "", model: "", extra: {}, credentialId: null, newKey: "" }] }, openai, none);
  assert.ok(fb["fallback.0.key"] && fb["fallback.0.model"]);
});

test("a save sends the typed key once and a saved key by id; a fixed provider's address and a service's model are not sent", async () => {
  const { deps } = await fresh();
  const o = await ov(deps); const idx = providerIndex(o);
  const typed = saveBody("intelligent", { ...emptyDraft("openai"), model: "gpt-4.1", base: "https://evil.example/v1", newKey: `  ${SECRET} ` }, idx);
  assert.equal((typed as { apiKey: string }).apiKey, SECRET);
  assert.equal((typed as { config: { base?: string } }).config.base, undefined, "a fixed provider's address is the registry's");
  assert.equal("credentialId" in typed, false);
  const byId = saveBody("intelligent", { ...emptyDraft("openai"), model: "gpt-4.1", credentialId: "c-1" }, idx);
  assert.equal((byId as { credentialId: string }).credentialId, "c-1"); assert.equal("apiKey" in byId, false);
  const dl = saveBody("translation", { ...emptyDraft("deepl"), model: "ignored", newKey: "abc:fx-123456" }, idx);
  assert.equal((dl as { config: { model?: string } }).config.model, undefined);
  const plat = saveBody("stt", { ...emptyDraft(), mode: "platform" }, idx);
  assert.deepEqual(plat, { feature: "stt", mode: "platform" });
  const custom = o.catalog.find((p) => p.customBase)!;
  assert.equal((saveBody("intelligent", { ...emptyDraft(custom.id), base: " https://llm.example.com/v1 ", model: "m", newKey: "sk-abcdefgh1234" }, idx) as { config: { base: string } }).config.base, "https://llm.example.com/v1");
});

test("fallback keys typed on the screen are saved first and named by id; the setting never carries the secret", async () => {
  const { deps } = await fresh();
  const o = await ov(deps); const idx = providerIndex(o);
  const d = { ...emptyDraft("openai"), model: "gpt-4.1", newKey: SECRET, fallbacks: [{ provider: "groq", base: "", model: "llama-3.3-70b", extra: {}, credentialId: null, newKey: "gsk_FALLBACKKEY000000000001" }, { provider: "mistral", base: "", model: "mistral-large-latest", extra: {}, credentialId: "c-9", newKey: "" }] };
  assert.deepEqual(fallbackKeysToSave(d), [{ index: 0, provider: "groq", apiKey: "gsk_FALLBACKKEY000000000001" }]);
  const body = saveBody("intelligent", d, idx, ["new-id", null]);
  assert.equal((body as { fallbacks: { credentialId: string }[] }).fallbacks[0].credentialId, "new-id");
  assert.equal((body as { fallbacks: { credentialId: string }[] }).fallbacks[1].credentialId, "c-9");
  assert.equal(JSON.stringify((body as { fallbacks: unknown }).fallbacks).includes("FALLBACKKEY"), false);
});

test("a test sends the draft with the typed key or the saved one — never both", async () => {
  const { deps } = await fresh();
  const idx = providerIndex(await ov(deps));
  const a = testBody("stt", { ...emptyDraft("openai-stt"), model: "whisper-1", newKey: "sk-abcdefgh1234", credentialId: "c-1" }, idx);
  assert.equal("apiKey" in a, true); assert.equal("credentialId" in a, false);
  const b = testBody("stt", { ...emptyDraft("openai-stt"), model: "whisper-1", credentialId: "c-1" }, idx);
  assert.equal((b as { credentialId: string }).credentialId, "c-1"); assert.equal("apiKey" in b, false);
});

test("what each feature says about itself, in words", async () => {
  const { deps } = await fresh();
  await saveSetting(U, { feature: "intelligent", mode: "user", config: { provider: "openai", model: "gpt-4.1" }, apiKey: SECRET }, deps);
  await saveSetting(U, { feature: "translation", mode: "user", config: { provider: "deepl" }, apiKey: "abc:fx-123456789" }, deps);
  const o = await ov(deps); const idx = providerIndex(o);
  const f = (id: string) => o.features.find((x) => x.feature === id)!;
  assert.deepEqual(modeWords(f("stt"), idx), { headline: "Platform AI", detail: "Provided and billed by the platform." });
  assert.match(modeWords(f("intelligent"), idx).detail, /OpenAI · gpt-4\.1 · your own key/);
  assert.equal(modeWords(f("translation"), idx).detail.includes("undefined"), false);
  assert.match(modeWords(f("translation"), idx).detail, /DeepL.*your own key/);
  assert.equal(testWords(null).tone, "none"); assert.equal(testWords({ at: "", ok: true, code: "ok", message: "fine" }).tone, "ok");
  assert.match(testWords({ at: "", ok: false, code: "auth", message: "rejected the key" }).text, /rejected the key/);
});

test("why a feature cannot use its own provider is said, in this order: workspace, vault, feature", () => {
  assert.match(blockedReason({ vault: { ready: true }, workspaceAllows: false }, { supported: true })!, /administrator/);
  assert.match(blockedReason({ vault: { ready: false, reason: "AI_CREDENTIAL_KEY is not set." }, workspaceAllows: true }, { supported: true })!, /AI_CREDENTIAL_KEY/);
  assert.match(blockedReason({ vault: { ready: true }, workspaceAllows: true }, { supported: false })!, /not available/);
  assert.equal(blockedReason({ vault: { ready: true }, workspaceAllows: true }, { supported: true }), null);
  const o = { platformFallbackAvailable: true, platformSttFallbackAvailable: false, platformTranslateFallbackAvailable: true };
  assert.equal(platformBackstopAvailable(o, "chat"), true); assert.equal(platformBackstopAvailable(o, "stt"), false); assert.equal(platformBackstopAvailable(o, "translate"), true);
});

test("the catalog the screen gets matches the registry's public catalog (it does not invent providers)", async () => {
  const { deps } = await fresh();
  const o = await ov(deps);
  assert.deepEqual(o.catalog.map((p) => p.id), publicCatalog("chat").map((p) => p.id));
  assert.deepEqual(o.translateCatalog.map((p) => p.id), publicCatalog("translate").map((p) => p.id));
});
