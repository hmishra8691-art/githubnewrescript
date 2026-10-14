import test from "node:test";
import assert from "node:assert/strict";
import { Meter, MemoryMeterStore, type MeterContext } from "@rescript/billing";
import { currentAiScope, reportUsage, type ChatScope } from "@rescript/ai";
import { meteredCore, type RunDeps } from "./meterRun.ts";
import { setAiSettingsLoader } from "./aiPolicy.ts";
import type { Resolution } from "./byok/resolve.ts";

const OPEN = { mode: "cloud" as const, disabled: [] as string[] };
const ctx = (over: Partial<MeterContext> = {}): MeterContext => ({ customerId: "c1", surveyId: "s1", userId: "u1", environment: "LIVE", ...over });
const spec = () => ({ eventType: "AI_REQUEST", provider: "openai-compatible", service: "chat", model: "gpt-4o-mini", inputUnits: 2000, outputUnits: 1000, metadata: { operation: "copilot_turn" } });
const scopeOf = (over: Partial<ChatScope> = {}): ChatScope => ({ source: "user", provider: "openai", base: "https://api.openai.com/v1", key: "sk-proj-USERKEYUSERKEYUSERKEY", model: "gpt-4.1", fallbacks: [], ...over });
const PLATFORM_TARGET = { provider: "platform", base: "https://platform.example/v1", key: "platform-key", model: "pm", platform: true as const };
const userRes = (over: Partial<ChatScope> = {}): Resolution => ({ kind: "user", source: "user", scope: scopeOf(over), credentialId: "c", settingUpdatedAt: "", skippedFallbacks: [] });
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
