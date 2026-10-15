import test from "node:test";
import assert from "node:assert/strict";
import { Meter, MemoryMeterStore, type MeterContext } from "@rescript/billing";
import { currentAiScope, reportUsage, type ChatScope, type SttScope, type TranslateScope } from "@rescript/ai";
import { meteredCore, type RunDeps } from "./meterRun.ts";
import { setAiSettingsLoader } from "./aiPolicy.ts";
import type { Resolution } from "./byok/resolve.ts";

const OPEN = { mode: "cloud" as const, disabled: [] as string[] };
const ctx = (over: Partial<MeterContext> = {}): MeterContext => ({ customerId: "c1", surveyId: "s1", userId: "u1", environment: "LIVE", ...over });
const spec = () => ({ eventType: "AI_REQUEST", provider: "openai-compatible", service: "chat", model: "gpt-4o-mini", inputUnits: 2000, outputUnits: 1000, metadata: { operation: "copilot_turn" } });
const scopeOf = (over: Partial<ChatScope> = {}): ChatScope => ({ source: "user", provider: "openai", base: "https://api.openai.com/v1", key: "sk-proj-USERKEYUSERKEYUSERKEY", model: "gpt-4.1", fallbacks: [], ...over });
const PLATFORM_TARGET = { provider: "platform", base: "https://platform.example/v1", key: "platform-key", model: "pm", platform: true as const };
const userRes = (over: Partial<ChatScope> = {}): Resolution => ({ kind: "user", source: "user", scopeKind: "chat", scope: scopeOf(over), credentialId: "c", settingUpdatedAt: "", skippedFallbacks: [] });
const deps = (r: Resolution | ((ask: { userId?: string | null }) => Resolution), calls: unknown[] = []): RunDeps => ({ connectionFor: async (ask) => { calls.push(ask); return typeof r === "function" ? r(ask) : r; }, allowPrivate: () => false });
const mk = (balance = 10) => { const store = new MemoryMeterStore(); const meter = new Meter(store, { seedBalance: balance, cacheMs: 0 }); return { store, meter }; };
const walletOf = async (meter: Meter, c = ctx()) => (await meter.walletFor(c, true))!;
const opts = { operation: "copilot_turn", kind: "chat" as const, reserve: spec };
setAiSettingsLoader(async () => OPEN);

test("platform path is unchanged: a hold, the call, the wallet debited for the usage", async () => {
  const { meter, store } = mk();
  const r = await meteredCore(deps({ kind: "platform", reason: "default" }), meter, ctx(), opts, async () => { reportUsage({ kind: "chat", provider: "openai-compatible", model: "gpt-4o-mini", inputTokens: 1500, outputTokens: 400, requests: 1, estimated: false }); return "answer"; });
  assert.ok(r.ok && r.value === "answer" && r.event);
  assert.equal(r.event!.eventType, "AI_REQUEST");
  assert.ok(r.event!.customerCharge > 0, "the platform charged for platform AI");
  assert.ok((await walletOf(meter)).balance < 10);
  assert.equal(store.usage.length, 1);
});

test("own provider: runs inside the user's scope, costs the wallet nothing, and is recorded at zero charge with its provider and model", async () => {
  const { meter, store } = mk();
  let seen: ChatScope | undefined;
  const r = await meteredCore(deps(userRes()), meter, ctx(), opts, async () => {
    seen = currentAiScope()?.chat;
    reportUsage({ kind: "chat", provider: "openai-compatible", model: "gpt-4.1", inputTokens: 900, outputTokens: 300, requests: 1, estimated: false, source: "user", providerId: "openai" });
    return 42;
  });
  assert.ok(r.ok && r.value === 42);
  assert.equal(seen?.key, "sk-proj-USERKEYUSERKEYUSERKEY"); assert.equal(seen?.source, "user");
  const w = await walletOf(meter);
  assert.equal(w.balance, 10, "no wallet debit"); assert.equal(w.reserved ?? 0, 0);
  assert.equal(store.ledger.filter((l) => l.kind === "debit").length, 0);
  assert.equal(store.usage.length, 1);
  const e = store.usage[0]!;
  assert.equal(e.eventType, "AI_REQUEST_BYOK"); assert.equal(e.customerCharge, 0); assert.equal(e.providerCost, 0); assert.equal(e.walletId, null);
  assert.equal(e.provider, "openai"); assert.equal(e.userId, "u1"); assert.equal(e.surveyId, "s1");
  assert.equal(e.inputUnits, 900); assert.equal(e.outputUnits, 300);
  assert.equal(e.metadata.byok, true); assert.equal(e.metadata.operation, "copilot_turn"); assert.equal(e.metadata.usedFallback, false);
  assert.equal(JSON.stringify(e).includes("USERKEY"), false, "no key in the record");
  assert.equal(currentAiScope(), undefined, "the scope does not leak out of the call");
});

test("own provider needs no balance: an empty, read-only wallet still runs it — platform work stays refused", async () => {
  const { meter, store } = mk(0);
  const byok = await meteredCore(deps(userRes()), meter, ctx(), opts, async () => { reportUsage({ kind: "chat", provider: "openai-compatible", model: "gpt-4.1", inputTokens: 10, outputTokens: 5, requests: 1, estimated: true, source: "user" }); return "ok"; });
  assert.ok(byok.ok, "BYOK ran with a zero balance");
  const plat = await meteredCore(deps({ kind: "platform", reason: "default" }), meter, ctx(), opts, async () => "never");
  assert.equal(plat.ok, false, "the platform's AI is refused on an empty wallet");
  assert.equal(store.usage.length, 1);
});

test("a refused connection stops before any money or provider: the call never runs, nothing is reserved", async () => {
  const { meter, store } = mk();
  let ran = false;
  const r = await meteredCore(deps({ kind: "refused", code: "no_connection", message: "Add your key.", source: "user" }), meter, ctx(), opts, async () => { ran = true; return 1; });
  assert.equal(r.ok, false); assert.equal((r as { reason: string }).reason, "ai_connection"); assert.equal((r as { code: string }).code, "no_connection");
  assert.equal(ran, false); assert.equal(store.usage.length, 0); assert.equal(store.reservations.size, 0);
});

test("the project's AI switch is asked first: an off project never even resolves a connection", async () => {
  const { meter } = mk();
  setAiSettingsLoader(async () => ({ mode: "internal", disabled: [] }));
  try {
    const calls: unknown[] = [];
    const r = await meteredCore(deps(userRes(), calls), meter, ctx(), opts, async () => "x");
    assert.equal(r.ok, false); assert.equal((r as { reason: string }).reason, "ai_off"); assert.equal(calls.length, 0);
  } finally { setAiSettingsLoader(async () => OPEN); }
});

test("the project's choice reaches the resolver, and the answer is not asked for twice", async () => {
  const { meter } = mk();
  setAiSettingsLoader(async () => ({ ...OPEN, source: "user" as const }));
  try {
    const calls: { source?: string; sourceKnown?: boolean; operation?: string }[] = [];
    await meteredCore(deps(userRes(), calls), meter, ctx(), opts, async () => "x");
    assert.deepEqual(calls.map((c) => [c.source, c.sourceKnown, c.operation]), [["user", true, "copilot_turn"]]);
  } finally { setAiSettingsLoader(async () => OPEN); }
});

test("platform backstop: a hold is reserved; only what the platform served is charged; the rest is returned", async () => {
  const { meter, store } = mk();
  const withBackstop = userRes({ fallbacks: [PLATFORM_TARGET] });
  /* the user's provider answered: the hold is released, nothing charged */
  const a = await meteredCore(deps(withBackstop), meter, ctx(), opts, async () => { reportUsage({ kind: "chat", provider: "openai-compatible", model: "gpt-4.1", inputTokens: 100, outputTokens: 50, requests: 1, estimated: false, source: "user", providerId: "openai" }); return "mine"; });
  assert.ok(a.ok); assert.equal((await walletOf(meter)).balance, 10); assert.equal([...store.reservations.values()].filter((r) => r.status === "held").length, 0);
  assert.deepEqual(store.usage.map((e) => e.eventType), ["AI_REQUEST_BYOK"]);
  /* the user's provider failed and the platform answered: THAT usage is the platform's, billed */
  const b = await meteredCore(deps(withBackstop), meter, ctx(), opts, async () => { reportUsage({ kind: "chat", provider: "openai-compatible", model: "gpt-4o-mini", inputTokens: 1200, outputTokens: 300, requests: 1, estimated: false, source: "platform", providerId: "platform", usedFallback: true }); return "platform"; });
  assert.ok(b.ok && b.event); assert.equal(b.event!.eventType, "AI_REQUEST"); assert.ok(b.event!.customerCharge > 0); assert.equal(b.event!.metadata.source, "platform_fallback");
  assert.ok((await walletOf(meter)).balance < 10);
});

test("platform backstop with an unfunded wallet: it is not offered for that call (never an unpaid platform call), and the user's own provider still runs", async () => {
  const { meter } = mk(0);
  let scopeSeen: ChatScope | undefined;
  const r = await meteredCore(deps(userRes({ fallbacks: [PLATFORM_TARGET] })), meter, ctx(), opts, async () => { scopeSeen = currentAiScope()?.chat; reportUsage({ kind: "chat", provider: "openai-compatible", model: "gpt-4.1", inputTokens: 5, outputTokens: 5, requests: 1, estimated: true, source: "user" }); return "ok"; });
  assert.ok(r.ok);
  assert.equal(scopeSeen!.fallbacks.some((f) => f.platform), false);
});

test("usage on the user's provider and on a fallback of theirs are recorded separately, each under its own provider", async () => {
  const { meter, store } = mk();
  const second = { provider: "anthropic", base: "https://api.anthropic.com/v1", key: "sk-ant-SECONDKEYSECONDKEY", model: "claude-sonnet-4-5" };
  await meteredCore(deps(userRes({ fallbacks: [second] })), meter, ctx(), opts, async () => {
    reportUsage({ kind: "chat", provider: "openai-compatible", model: "gpt-4.1", inputTokens: 10, outputTokens: 0, requests: 1, estimated: true, source: "user", providerId: "openai" });
    reportUsage({ kind: "chat", provider: "openai-compatible", model: "claude-sonnet-4-5", inputTokens: 500, outputTokens: 200, requests: 1, estimated: false, source: "user", providerId: "anthropic", usedFallback: true });
    return 1;
  });
  assert.deepEqual(store.usage.map((e) => [e.provider, e.metadata.usedFallback]).sort(), [["anthropic", true], ["openai", false]]);
  assert.ok(store.usage.every((e) => e.customerCharge === 0));
});

test("a call that throws gives its hold back and records nothing", async () => {
  const { meter, store } = mk();
  await assert.rejects(meteredCore(deps(userRes({ fallbacks: [PLATFORM_TARGET] })), meter, ctx(), opts, async () => { throw new Error("boom"); }), /boom/);
  assert.equal([...store.reservations.values()].filter((r) => r.status === "held").length, 0); assert.equal(store.usage.length, 0);
  await assert.rejects(meteredCore(deps({ kind: "platform", reason: "default" }), meter, ctx(), opts, async () => { throw new Error("boom2"); }), /boom2/);
  assert.equal([...store.reservations.values()].filter((r) => r.status === "held").length, 0);
});

test("two users at once never see each other's connection: 40 interleaved calls, each with its own key", async () => {
  const { meter } = mk(100);
  const byUser = (ask: { userId?: string | null }): Resolution => userRes({ key: `sk-${ask.userId}-KEYKEYKEYKEY`, model: `m-${ask.userId}` });
  const d = deps(byUser);
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => {
    const userId = i % 2 ? "alice" : "bob";
    return meteredCore(d, meter, ctx({ userId }), opts, async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 15));
      const s = currentAiScope()?.chat;
      reportUsage({ kind: "chat", provider: "openai-compatible", model: s!.model, inputTokens: 1, outputTokens: 1, requests: 1, estimated: true, source: "user" });
      return `${s!.key}|${s!.model}`;
    }).then((r) => ({ userId, r }));
  }));
  for (const { userId, r } of results) { assert.ok(r.ok); assert.equal((r as { value: string }).value, `sk-${userId}-KEYKEYKEYKEY|m-${userId}`); }
});

test("text-to-speech on the user's own provider is recorded in characters at zero charge", async () => {
  const { meter, store } = mk();
  const tts = { operation: "tts_preview", kind: "tts" as const, reserve: () => ({ eventType: "TEXT_TO_SPEECH_CHARACTER", provider: "openai-compatible", service: "tts", model: "tts-1", quantity: 100 }) };
  const r = await meteredCore(deps(userRes()), meter, ctx(), tts, async () => { reportUsage({ kind: "tts", provider: "openai-compatible", model: "tts-1", inputTokens: 0, outputTokens: 0, characters: 120, requests: 1, estimated: false, source: "user", providerId: "openai" }); return "audio"; });
  assert.ok(r.ok);
  const e = store.usage[0]!;
  assert.equal(e.eventType, "AI_REQUEST_BYOK"); assert.equal(e.service, "tts"); assert.equal(e.quantity, 120); assert.equal(e.unit, "character"); assert.equal(e.customerCharge, 0);
});

test("no report, no record: a call that never reached a provider leaves no usage and no hold", async () => {
  const { meter, store } = mk();
  const r = await meteredCore(deps(userRes({ fallbacks: [PLATFORM_TARGET] })), meter, ctx(), opts, async () => null);
  assert.ok(r.ok && r.event === null); assert.equal(store.usage.length, 0);
  assert.equal([...store.reservations.values()].filter((x) => x.status === "held").length, 0);
});


/* ------------------------------------------------------------------ speech-to-text */

const sttScopeOf = (over: Partial<SttScope> = {}): SttScope => ({ source: "user", provider: "openai-stt", base: "https://api.openai.com/v1", key: "sk-proj-STTKEYSTTKEYSTTKEY", model: "whisper-1", fallbacks: [], ...over });
const sttRes = (over: Partial<SttScope> = {}): Resolution => ({ kind: "user", source: "user", scopeKind: "stt", scope: sttScopeOf(over), credentialId: "c", settingUpdatedAt: "", skippedFallbacks: [] });
const sttSpec = () => ({ eventType: "SPEECH_TO_TEXT_MINUTE", provider: "openai-compatible", service: "stt", model: "whisper-1", quantity: 2, metadata: { operation: "intelligent_voice", seconds: 120 } });
const sttOpts = { operation: "intelligent_voice", kind: "stt" as const, reserve: sttSpec, tolerateMeterOutage: true };
const heard = (over: Record<string, unknown> = {}) => reportUsage({ kind: "stt", provider: "openai-compatible", model: "whisper-1", seconds: 90, requests: 1, estimated: false, source: "user", providerId: "openai-stt", ...over } as never);

test("STT, platform path: a hold for the minutes, settled from what the provider reported", async () => {
  const { meter, store } = mk();
  const r = await meteredCore(deps({ kind: "platform", reason: "default" }), meter, ctx(), sttOpts, async () => { heard({ source: undefined, providerId: undefined, seconds: 120 }); return "heard"; });
  assert.ok(r.ok && r.value === "heard" && r.event);
  assert.equal(r.event!.eventType, "SPEECH_TO_TEXT_MINUTE"); assert.equal(r.event!.quantity, 2);
  assert.equal(store.usage.length, 1);
});

test("STT, own provider: runs inside the STT scope (not a chat one), costs the wallet nothing, and is recorded in minutes at zero charge under its provider", async () => {
  const { meter, store } = mk(0);
  let seen: { stt?: SttScope; chat?: ChatScope } = {};
  const r = await meteredCore(deps(sttRes()), meter, ctx(), sttOpts, async () => { seen = { stt: currentAiScope()?.stt, chat: currentAiScope()?.chat }; heard(); return 7; });
  assert.ok(r.ok && r.value === 7, "an empty wallet does not stop a user's own provider");
  assert.equal(seen.stt?.key, "sk-proj-STTKEYSTTKEYSTTKEY"); assert.equal(seen.chat, undefined, "the chat provider is not in scope for a transcription");
  assert.equal(store.usage.length, 1);
  const e = store.usage[0]!;
  assert.equal(e.eventType, "AI_REQUEST_BYOK"); assert.equal(e.customerCharge, 0); assert.equal(e.walletId, null);
  assert.equal(e.provider, "openai-stt"); assert.equal(e.unit, "minute"); assert.equal(e.quantity, 1.5);
  assert.equal(e.metadata.byok, true); assert.equal(e.metadata.operation, "intelligent_voice"); assert.equal(e.metadata.seconds, 90);
  assert.equal(JSON.stringify(e).includes("STTKEY"), false);
  assert.equal(currentAiScope(), undefined);
});

test("STT is not a language model: a project that runs INTERNAL still transcribes; what a project can switch off (the feature list, an unreadable setting) still stops it", async () => {
  const { meter } = mk();
  try {
    setAiSettingsLoader(async () => ({ mode: "internal", disabled: [] }));
    const a = await meteredCore(deps({ kind: "platform", reason: "default" }), meter, ctx(), sttOpts, async () => { heard({ source: undefined }); return 1; });
    assert.ok(a.ok, "transcription is not sent to a language model");
    const chatOff = await meteredCore(deps(userRes()), meter, ctx(), opts, async () => "x");
    assert.equal(chatOff.ok, false, "while chat is refused in the same project");
    setAiSettingsLoader(async () => ({ mode: "cloud", disabled: ["intelligent_voice"] }));
    const b = await meteredCore(deps({ kind: "platform", reason: "default" }), meter, ctx(), sttOpts, async () => 2);
    assert.equal(b.ok, false); assert.equal((b as { why?: string }).why, "feature_off");
    setAiSettingsLoader(async () => null);
    const c = await meteredCore(deps({ kind: "platform", reason: "default" }), meter, ctx(), sttOpts, async () => 3);
    assert.equal(c.ok, false); assert.equal((c as { why?: string }).why, "unreadable");
  } finally { setAiSettingsLoader(async () => OPEN); }
});

test("STT, project that chose the user's provider: the choice reaches the resolver; a refusal stops everything and never uses the platform", async () => {
  const { meter, store } = mk();
  setAiSettingsLoader(async () => ({ ...OPEN, source: "user" as const }));
  try {
    const calls: { source?: string; sourceKnown?: boolean; operation?: string }[] = [];
    let ran = false;
    const r = await meteredCore(deps({ kind: "refused", code: "no_connection", message: "Add your speech key.", source: "project" }, calls), meter, ctx(), sttOpts, async () => { ran = true; return 1; });
    assert.equal(r.ok, false); assert.equal((r as { code: string }).code, "no_connection"); assert.equal(ran, false);
    assert.deepEqual(calls.map((c) => [c.source, c.sourceKnown, c.operation]), [["user", true, "intelligent_voice"]]);
    assert.equal(store.usage.length, 0); assert.equal(store.reservations.size, 0);
  } finally { setAiSettingsLoader(async () => OPEN); }
});

test("STT backstop: the platform answers only after the user's provider failed, is billed as the platform's, and the rest of the hold comes back", async () => {
  const { meter, store } = mk();
  const platformStt = { provider: "platform", base: "https://stt.example/v1", key: "platform-stt", model: "whisper-1", platform: true as const };
  const withBackstop = sttRes({ fallbacks: [platformStt] });
  const a = await meteredCore(deps(withBackstop), meter, ctx(), sttOpts, async () => { heard(); return "mine"; });
  assert.ok(a.ok); assert.equal((await walletOf(meter)).balance, 10); assert.equal([...store.reservations.values()].filter((x) => x.status === "held").length, 0);
  const b = await meteredCore(deps(withBackstop), meter, ctx(), sttOpts, async () => { heard({ source: "platform", providerId: "platform", usedFallback: true, seconds: 60 }); return "platform"; });
  assert.ok(b.ok && b.event); assert.equal(b.event!.eventType, "SPEECH_TO_TEXT_MINUTE"); assert.equal(b.event!.metadata.source, "platform_fallback");
  /* unfunded: the backstop is not offered for that call, the user's own provider still runs */
  const { meter: poor } = mk(0);
  let seen: SttScope | undefined;
  const c = await meteredCore(deps(withBackstop), poor, ctx(), sttOpts, async () => { seen = currentAiScope()?.stt; heard(); return "ok"; });
  assert.ok(c.ok); assert.equal(seen!.fallbacks.some((f) => f.platform), false, "never an unpaid platform call");
});

test("STT: a billing outage runs the platform call unmetered (a recording is not lost to it); chat would not", async () => {
  const { meter } = mk();
  meter.reserve = async () => { throw new Error("db down"); };
  const a = await meteredCore(deps({ kind: "platform", reason: "default" }), meter, ctx(), sttOpts, async () => "recording kept");
  assert.ok(a.ok && a.value === "recording kept" && a.event === null);
  await assert.rejects(() => meteredCore(deps({ kind: "platform", reason: "default" }), meter, ctx(), opts, async () => "x"), /db down/);
});

test("a speech call that resolves a chat connection (or the reverse) is a programming error, never a silent use of the wrong provider", async () => {
  const { meter } = mk();
  await assert.rejects(() => meteredCore(deps(userRes()), meter, ctx(), sttOpts, async () => 1), /resolved a chat connection/);
  await assert.rejects(() => meteredCore(deps(sttRes()), meter, ctx(), opts, async () => 1), /resolved a stt connection/);
});

/* ---------------------------------------------------------------- translation (Phase D) */

const trSpec = () => ({ eventType: "TRANSLATION_CHARACTER", provider: "google", service: "translate", model: "v2", quantity: 500, metadata: { operation: "translate:en->de" } });
const trScope = (over: Partial<TranslateScope> = {}): TranslateScope => ({ source: "user", provider: "deepl", base: "https://api.deepl.com/v2", key: "DEEPL-USERKEY-0123456789", model: "v2", protocol: "deepl", fallbacks: [], ...over });
const trRes = (over: Partial<TranslateScope> = {}): Resolution => ({ kind: "user", source: "user", scopeKind: "translate", scope: trScope(over), credentialId: "c", settingUpdatedAt: "", skippedFallbacks: [] });
const trOpts = { operation: "translate:en->de", kind: "translate" as const, reserve: trSpec };

test("translation on the user's own service: their translate scope, no wallet, characters recorded at zero charge with the provider that served them", async () => {
  const { meter, store } = mk();
  let seen: TranslateScope | undefined;
  const r = await meteredCore(deps(trRes()), meter, ctx(), trOpts, async () => {
    seen = currentAiScope()?.translate;
    reportUsage({ kind: "translate", provider: "deepl", model: "v2", characters: 420, requests: 1, estimated: true, source: "user", providerId: "deepl", usedFallback: false });
    return "done";
  });
  assert.ok(r.ok && r.value === "done");
  assert.equal(seen?.key, "DEEPL-USERKEY-0123456789"); assert.equal(currentAiScope(), undefined);
  assert.equal((await walletOf(meter)).balance, 10);
  const e = store.usage[0]!;
  assert.equal(e.eventType, "AI_REQUEST_BYOK"); assert.equal(e.customerCharge, 0); assert.equal(e.unit, "character"); assert.equal(Number(e.quantity), 420); assert.equal(e.provider, "deepl");
  assert.equal(JSON.stringify(e).includes("USERKEY"), false);
});

test("translation: the user's service failing over to the platform's backstop settles ONLY the platform's characters, as the platform's; the user's own stay free", async () => {
  const { meter, store } = mk();
  const r = await meteredCore(deps(trRes({ fallbacks: [{ provider: "platform", base: "", key: "", model: "platform", platform: true }] })), meter, ctx(), trOpts, async () => {
    reportUsage({ kind: "translate", provider: "deepl", model: "v2", characters: 100, requests: 1, estimated: true, source: "user", providerId: "deepl" });
    reportUsage({ kind: "translate", provider: "google", model: "v2", characters: 300, requests: 1, estimated: false, source: "platform", providerId: "platform", usedFallback: true });
    return 1;
  });
  assert.ok(r.ok);
  const platform = store.usage.filter((e) => e.eventType === "TRANSLATION_CHARACTER"), own = store.usage.filter((e) => e.eventType === "AI_REQUEST_BYOK");
  assert.equal(platform.length, 1); assert.equal(Number(platform[0].quantity), 300); assert.equal(platform[0].metadata.source, "platform_fallback"); assert.ok(platform[0].customerCharge >= 0);
  assert.equal(own.length, 1); assert.equal(Number(own[0].quantity), 100); assert.equal(own[0].customerCharge, 0);
});

test("translation: a project running Internal still translates with a service, but a language model (the platform's or the user's) is held to the switch before anything is reserved", async () => {
  setAiSettingsLoader(async () => ({ mode: "internal", disabled: [] }));
  try {
    const a = mk();
    const svc = await meteredCore(deps(trRes()), a.meter, ctx(), trOpts, async () => { reportUsage({ kind: "translate", provider: "deepl", model: "v2", characters: 5, requests: 1, estimated: true, source: "user" }); return "ok"; });
    assert.ok(svc.ok, "a translation service is not a language model");
    const b = mk();
    const plat = await meteredCore(deps({ kind: "platform", reason: "default" }), b.meter, ctx(), { ...trOpts, platformIsLlm: true }, async () => "never");
    assert.equal(plat.ok, false); assert.equal((plat as { reason: string }).reason, "ai_off"); assert.equal(b.store.reservations.size, 0);
    const c = mk();
    const own = await meteredCore(deps(userRes()), c.meter, ctx(), trOpts, async () => "never");
    assert.equal(own.ok, false, "'My AI model' is a chat connection: the language-model switch applies"); assert.equal((own as { reason: string }).reason, "ai_off");
    const d = mk();
    const plain = await meteredCore(deps({ kind: "platform", reason: "default" }), d.meter, ctx(), trOpts, async () => { reportUsage({ kind: "translate", provider: "google", model: "v2", characters: 50, requests: 1, estimated: false }); return "ok"; });
    assert.ok(plain.ok, "the platform's translation service also still runs in an Internal project");
  } finally { setAiSettingsLoader(async () => OPEN); }
});

test("a speech resolution handed to a translation call is a programming error, never a silent use of the wrong provider", async () => {
  const { meter } = mk();
  const stt: Resolution = { kind: "user", source: "user", scopeKind: "stt", scope: { source: "user", provider: "openai-stt", base: "https://x", key: "k", model: "whisper-1", fallbacks: [] } as SttScope, credentialId: "c", settingUpdatedAt: "", skippedFallbacks: [] };
  await assert.rejects(() => meteredCore(deps(stt), meter, ctx(), trOpts, async () => 1), /resolved a stt connection/);
});
