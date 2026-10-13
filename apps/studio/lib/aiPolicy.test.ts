import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { aiAllowed, aiSettingsOf, decideAi, setAiSettingsLoader, withAiGate, type AiSettings } from "./aiPolicy.ts";

/**
 * THE PROJECT'S AI SWITCH (audit A-2, Phase 2): "internal mode makes zero
 * provider calls", at every call site, and a new call site cannot be added
 * without passing the gate.
 */
const internal: AiSettings = { mode: "internal", disabled: [] };
const cloud: AiSettings = { mode: "cloud", disabled: [] };

test("settings are read defensively: anything unrecognised is cloud with nothing disabled", () => {
  assert.deepEqual(aiSettingsOf(undefined), cloud);
  assert.deepEqual(aiSettingsOf({}), cloud);
  assert.deepEqual(aiSettingsOf({ ai: "internal" }), cloud);
  assert.deepEqual(aiSettingsOf({ ai: { mode: "INTERNAL" } }), cloud, "only the exact value switches off");
  assert.deepEqual(aiSettingsOf({ ai: { mode: "internal", disabled: ["a", " b ", 3, ""] } }), { mode: "internal", disabled: ["a", "b"] });
});

test("decision matrix: internal blocks everything unless the researcher allowed this one request; a disabled feature is off in either mode", () => {
  assert.equal(decideAi(cloud, "analytics_ask").allowed, true);
  const off = decideAi(internal, "analytics_ask");
  assert.deepEqual([off.allowed, off.reason], [false, "project_internal"]);
  assert.match(off.message!, /Internal mode.*nothing is sent to a language model/);
  assert.equal(decideAi(internal, "copilot_plan", { once: true }).allowed, true, "the copilot's 'send this once'");
  const feature: AiSettings = { mode: "cloud", disabled: ["copilot_narrative", "report_*"] };
  assert.deepEqual([decideAi(feature, "copilot_narrative").allowed, decideAi(feature, "copilot_narrative").reason], [false, "feature_off"]);
  assert.equal(decideAi(feature, "report_narration").allowed, false, "a trailing * is a prefix");
  assert.equal(decideAi(feature, "report_design").allowed, false);
  assert.equal(decideAi(feature, "copilot_plan").allowed, true, "other features stay on");
  assert.equal(decideAi({ mode: "internal", disabled: ["x"] }, "x", { once: true }).allowed, false, "consent does not override a feature switched off");
  assert.equal(decideAi({ mode: "cloud", disabled: ["copilot"] }, "copilot_plan").allowed, false, "a bare name is the operation and everything under it");
  assert.equal(decideAi({ mode: "cloud", disabled: ["copilot"] }, "copilotx").allowed, true);
});

test("a project whose setting cannot be read is treated as off (an unread opt-out is not an absent one); the sandbox has no project row and is allowed", async () => {
  try {
    setAiSettingsLoader(async () => { throw new Error("db down"); });
    const d = await aiAllowed("p1", "analytics_ask");
    assert.deepEqual([d.allowed, d.reason], [false, "unreadable"]);
    setAiSettingsLoader(async () => null);
    assert.equal((await aiAllowed("p1", "analytics_ask")).reason, "unreadable");
    assert.equal((await aiAllowed("sandbox", "analytics_ask")).allowed, true);
    assert.equal((await aiAllowed(null, "analytics_ask")).allowed, true);
  } finally { setAiSettingsLoader(null); }
});

test("INTERNAL MODE MAKES ZERO PROVIDER CALLS — for every operation the Studio names", async () => {
  const ops = ["analytics_interpretation", "analytics_ask", "copilot_narrative", "copilot_plan", "copilot_review", "copilot_generate_item", "copilot_query_embedding", "copilot_ocr", "copilot_embeddings", "copilot_document_summary", "report_narration", "report_design", "story_narration", "tts_preview", "rephrase_for_speech", "logic_intent", "import_custom_logic", "intelligent_voice_normalise"];
  let providerCalls = 0;
  const provider = async () => { providerCalls++; return "text"; };
  try {
    setAiSettingsLoader(async () => internal);
    for (const op of ops) {
      const r = await withAiGate("p1", op, {}, provider);
      assert.equal(r.ok, false, op);
      if (!r.ok) { assert.equal(r.reason, "ai_off"); assert.equal(r.why, "project_internal"); assert.match(r.message, /AI is off for this project/); }
    }
    assert.equal(providerCalls, 0, "not one provider call");
    setAiSettingsLoader(async () => cloud);
    for (const op of ops) assert.equal((await withAiGate("p1", op, {}, provider)).ok, true, op);
    assert.equal(providerCalls, ops.length, "and with cloud on, each is one call");
  } finally { setAiSettingsLoader(null); }
});

/* ------------------------------------------------------------ the structural guarantee */

const ROOT = join(import.meta.dirname, "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  if (n === "node_modules" || n === ".next") return [];
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
});
const PROVIDER = /\b(completeJson|synthesizeSpeech|embedTexts|ocrImage|rephraseForSpeech|translateBatch|classify|sentiment|writeProbe)\(/;
/** files that reach a provider without a project's language-model switch, with the reason — each is a decision, not an oversight */
const EXEMPT: Record<string, string> = {
  "app/api/surveys/[id]/media/transcript/route.ts": "speech-to-text of respondent audio: the data-collection media pipeline, billed as speech and not a language model; the project's AI switch governs Intelligent mode",
};

test("every file that reaches a model provider passes the project's AI switch, or says why not", () => {
  const files = ["app", "lib", "components"].flatMap((d) => walk(join(ROOT, d)));
  const callers = files.filter((f) => PROVIDER.test(readFileSync(f, "utf8").replace(/^\s*import .*$/gm, "")));
  assert.ok(callers.length >= 10, `found ${callers.length} provider call sites`);
  const bare: string[] = [];
  for (const f of callers) {
    const rel = relative(ROOT, f).split("\\").join("/");
    if (EXEMPT[rel]) continue;
    const src = readFileSync(f, "utf8");
    if (!/\b(meteredAi|meteredTranslation|aiAllowed|withAiGate)\(/.test(src)) bare.push(rel);
  }
  assert.deepEqual(bare, [], "these reach a provider without the project's AI switch");
});

test("meteredAi asks the switch BEFORE it reserves anything, so an off project holds no balance and reaches no provider", () => {
  const src = readFileSync(join(ROOT, "lib/metering.ts"), "utf8");
  const body = src.slice(src.indexOf("export async function meteredAi"), src.indexOf("export async function meteredStt") > 0 ? src.indexOf("export async function meteredStt") : undefined);
  const gate = body.indexOf("aiAllowed(");
  assert.ok(gate > 0, "meteredAi asks aiAllowed");
  assert.ok(gate < body.indexOf("meter.reserve("), "before it reserves");
  assert.ok(gate < body.indexOf("await collectUsage(fn)") || body.indexOf("collectUsage(fn)") > gate, "and before the call");
  const tr = src.slice(src.indexOf("export async function meteredTranslation"));
  assert.ok(tr.indexOf("aiAllowed(") > 0 && tr.indexOf("aiAllowed(") < tr.indexOf("meter.reserve("), "a translation by the language model asks too");
});

test("the hand-reserving sites ask the switch before they reserve", () => {
  for (const [file, marker] of [["lib/analyticsBuilder.ts", "billing.meter.reserve("], ["app/api/ai/tts/route.ts", "billing.meter.reserve("]] as const) {
    const src = readFileSync(join(ROOT, file), "utf8");
    assert.ok(src.indexOf("aiAllowed(") > 0 && src.indexOf("aiAllowed(") < src.indexOf(marker), file);
  }
});
