import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { featureOf, needsOf } from "./features.ts";
import { MemoryAiStore } from "./store.ts";
import { resolveConnection, viewOfResolution } from "./resolve.ts";
import { saveSetting } from "./service.ts";
import { aiSettingsOf, decideAi } from "../aiPolicy.ts";
import { describeFailure, failureFromError } from "../copilot/failure.ts";

const env: Record<string, string | undefined> = { AI_CREDENTIAL_KEY: randomBytes(32).toString("hex"), AI_API_URL: "https://platform.example/v1", AI_API_KEY: "platform-secret-key", AI_MODEL: "pm" };
const U = "aaaaaaaa-0000-0000-0000-000000000001";
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("every operation maps to one of the four settings: copilot_* is Intelligent Mode, the rest is Additional AI", () => {
  for (const op of ["copilot_turn", "copilot_plan", "copilot_document_summary", "copilot_ocr", "copilot_narrative"]) assert.equal(featureOf(op), "intelligent", op);
  for (const op of ["analytics_ask", "analytics_interpretation", "report_narration", "story_narration", "rephrase_for_speech", "logic_intent", "survey_import", "import_custom_logic", "tts_preview", "workflow_structure"]) assert.equal(featureOf(op), "additional", op);
  assert.deepEqual(needsOf("tts_preview"), ["tts"]); assert.deepEqual(needsOf("story_narration"), ["tts"]); assert.deepEqual(needsOf("report_narration"), ["tts"]);
  assert.deepEqual(needsOf("copilot_turn"), []);
});

test("speech synthesis on a provider that cannot speak: refused with a sentence — or, only if the user allowed the platform as a backstop, done by the platform", async () => {
  const store = new MemoryAiStore();
  const base = { feature: "additional", mode: "user", config: { provider: "anthropic", model: "claude-sonnet-4-5" }, apiKey: "sk-ant-api03-ANTHROPICKEYKEYKEY" };
  assert.ok((await saveSetting(U, base, { store, env })).ok);
  const refused = await resolveConnection({ userId: U, feature: "additional", store, env, need: needsOf("tts_preview") });
  assert.equal(refused.kind, "refused"); assert.equal((refused as { code: string }).code, "capability_missing"); assert.match((refused as { message: string }).message, /Anthropic cannot be used/);
  const chat = await resolveConnection({ userId: U, feature: "additional", store, env, need: needsOf("rephrase_for_speech") });
  assert.equal(chat.kind, "user", "chat features still use the user's own provider");
  assert.ok((await saveSetting(U, { ...base, apiKey: undefined, allowPlatformFallback: true }, { store, env })).ok);
  const hybrid = await resolveConnection({ userId: U, feature: "additional", store, env, need: needsOf("tts_preview") });
  assert.deepEqual(hybrid, { kind: "platform", reason: "hybrid_capability" });
  const chatH = await resolveConnection({ userId: U, feature: "additional", store, env, need: [] });
  assert.equal(chatH.kind, "user"); assert.equal((chatH as { scope: { fallbacks: { platform?: boolean }[] } }).scope.fallbacks.at(-1)?.platform, true, "the backstop is listed, last, and is the platform's");
});

test("what a screen may be told about a resolution holds no key, header or fallback credential", async () => {
  const store = new MemoryAiStore();
  await saveSetting(U, { feature: "intelligent", mode: "user", config: { provider: "openai", model: "gpt-4.1", extra: { organizationId: "org-ABCDEF123456" } }, apiKey: "sk-proj-SCREENKEYSCREENKEYSCREEN", allowPlatformFallback: true }, { store, env });
  const v = viewOfResolution(await resolveConnection({ userId: U, feature: "intelligent", store, env }));
  assert.deepEqual(v, { kind: "user", source: "user", provider: "openai", model: "gpt-4.1", label: "OpenAI · gpt-4.1", fallbacks: 1, platformBackstop: true });
  const j = JSON.stringify(v);
  for (const secret of ["SCREENKEY", "platform-secret-key", "org-ABCDEF", "platform.example"]) assert.equal(j.includes(secret), false, secret);
});

test("the project's AI source is read from its settings; anything else is ignored; an off project returns no source", () => {
  assert.equal(aiSettingsOf({ ai: { source: "user" } }).source, "user");
  assert.equal(aiSettingsOf({ ai: { source: "platform", mode: "internal" } }).source, "platform");
  assert.equal(aiSettingsOf({ ai: { source: "root" } }).source, undefined);
  assert.equal(aiSettingsOf({}).source, undefined);
  assert.deepEqual(decideAi({ mode: "cloud", disabled: [], source: "user" }, "copilot_turn"), { allowed: true, source: "user" });
  assert.deepEqual(decideAi({ mode: "cloud", disabled: [] }, "copilot_turn"), { allowed: true });
  assert.equal(decideAi({ mode: "internal", disabled: [], source: "user" }, "copilot_turn").allowed, false);
});

test("a failure on the user's own provider is theirs to fix in Settings — never 'ask your administrator', never the platform's variables", () => {
  for (const kind of ["auth", "forbidden", "quota_exhausted", "not_found", "bad_request"]) {
    const f = failureFromError({ kind, message: "x" }, { own: "OpenAI" });
    const text = JSON.stringify(f);
    assert.match(text, /OpenAI/, kind); assert.match(text, /Settings/, kind);
    assert.equal(f.admin, undefined, `${kind}: no administrator advice on the user's own key`);
    assert.equal(/AI_API_KEY|AI_MODEL|AI_WORKSPACE_ID|administrator/i.test(text), false, kind);
  }
  assert.equal(failureFromError({ kind: "auth", message: "x" }, { own: "OpenAI" }).title, "YOUR AI PROVIDER REJECTED YOUR KEY");
  assert.match(failureFromError({ kind: "auth", message: "x" }).admin ?? "", /AI_API_KEY/, "the platform's own failures still point to the operator");
  const c = describeFailure("connection", "You have not set one up.");
  assert.equal(c.title, "YOUR AI PROVIDER IS NOT READY"); assert.match(c.next.join(" "), /Settings/);
  assert.equal(describeFailure("capacity", undefined, { own: "OpenAI" }).code, "capacity");
});

test("structural: the copilot's cache and single-flight keys carry the connection, and a refusal has its own card", () => {
  const src = read("app/api/copilot/turn/route.ts");
  assert.match(src, /const key = createHash\("sha256"\)\.update\(`[^`]*\$\{connTag\}/, "the reply cache key carries the connection");
  assert.match(src, /flights\(`[^`]*\$\{aiIdentity\(\)\}/, "the in-flight share key carries the connection");
  assert.match(src, /ai_connection[\s\S]{0,120}describeFailure\("connection"/, "a connection refusal is shown as its own card, not as a wallet failure");
  assert.match(src, /own: ownProvider/, "failures on the user's provider are told as theirs");
  for (const f of ["app/api/copilot/output/route.ts", "lib/analyticsBuilder.ts"]) assert.match(read(f), /\.\.\.\(conn \? \{ conn \} : \{\}\)/, `${f}: stored AI replies are keyed by connection`);
});

test("structural: nothing in the Studio reserves a wallet for a model call by hand any more — every path walks one door", () => {
  for (const f of ["app/api/ai/tts/route.ts", "lib/analyticsBuilder.ts"]) {
    const src = read(f);
    assert.equal(/meter\.reserve\(/.test(src), false, `${f} reserves by hand`);
    assert.match(src, /meteredTts\(/, f);
  }
  const m = read("lib/metering.ts");
  assert.match(m, /meteredCore\(runDeps/, "meteredAi and meteredTts delegate to the core");
  const core = read("lib/meterRun.ts");
  const ask = core.indexOf("aiAllowed("), conn = core.indexOf("deps.connectionFor("), reserve = core.indexOf("meter.reserve(");
  assert.ok(ask > 0 && ask < conn && conn < reserve, "the switch, then whose AI, then money — in that order");
});

test("the routes that asked 'is a model configured?' now ask 'is there an AI for this person?'", () => {
  for (const f of ["app/api/copilot/turn/route.ts", "app/api/copilot/output/route.ts", "app/api/copilot/documents/route.ts", "app/api/copilot/workflow/route.ts", "app/api/import/analyze/route.ts", "lib/analyticsAsk.ts", "lib/analyticsBuilder.ts", "lib/aiGate.ts"]) {
    const src = read(f);
    assert.equal(/\baiConfigured\(\)/.test(src.replace(/aiReadyFor[\s\S]*?\n/g, "")) && !/aiReadyFor\(/.test(src), false, f);
    assert.match(src, /aiReadyFor\(/, f);
  }
});
