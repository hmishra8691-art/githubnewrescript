import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availabilityNote, capabilityBrief, capabilityReadiness, capabilityRefusal, capabilityRegistry, normalizeCapability,
  REGISTRY_VERSION, SERVICES, serviceReadiness, unreadyCapabilities, type CapabilityRecord,
} from "./capabilities.js";

/*
 * §11 (2026-10-18) — every registry entry has the full shape, and the
 * capabilities that need configuration report ready / not ready from the
 * server environment: presence only, names only, never a value.
 */

const FIELDS: (keyof CapabilityRecord)[] = ["id", "name", "kind", "category", "status", "services", "configuration", "inputs", "handler", "validation", "outputSchema", "limitations", "tests", "version"];
const STATUSES = new Set(["supported", "partial", "requires_configuration", "not_supported"]);
const FULL_ENV = {
  AI_API_URL: "https://api.openai.com/v1", AI_API_KEY: "sk-secret-value", AI_MODEL: "gpt-4o", AI_EMBEDDINGS_MODEL: "text-embedding-3-small",
  SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-secret", RESEND_API_KEY: "re_secret", MAIL_FROM: "a@b.c", CRON_SECRET: "cron-secret",
  REPORT_NARRATION_ENABLED: "1", GEOCODE_API_URL: "https://nominatim.example/search",
  /* G2 2026-10-22: live sessions */
  WEBRTC_TURN_URLS: "turn:turn.example.org:3478", WEBRTC_TURN_SECRET: "turn-shared-secret", LIVEKIT_URL: "wss://livekit.example.org", LIVEKIT_API_KEY: "lk-api-key", LIVEKIT_API_SECRET: "lk-api-secret",
  /* G1 2026-10-22 (added by G2: the realtime voice service was missing here, so "full" was not full) */
  AI_REALTIME_API_URL: "https://realtime.example.org/v1", AI_REALTIME_API_KEY: "rt-secret-value", AI_REALTIME_MODEL: "gpt-realtime",
  /* G3 2026-10-22: alert channels and panel signing */
  INTEGRATIONS_SECRET_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

test("every entry has the full shape: id, display name, category, status, services, configuration, inputs, handler, validation, output schema, limitations, tests, version", () => {
  const reg = capabilityRegistry();
  assert.ok(reg.length > 60, `${reg.length}`);
  const ids = new Set<string>();
  for (const c of reg) {
    for (const f of FIELDS) assert.ok(c[f] !== undefined, `${c.id}: ${String(f)}`);
    assert.ok(STATUSES.has(c.status), `${c.id}: ${c.status}`);
    assert.equal(c.category, c.kind);
    assert.ok(c.handler.length > 0, `${c.id}: a handler`);
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`); ids.add(c.id);
    for (const s of c.services) assert.ok(SERVICES[s], `${c.id}: service ${s}`);
    if (c.status === "requires_configuration") assert.ok(c.services.length && c.configuration.length, `${c.id}: names what it needs`);
    if (c.status === "not_supported") assert.equal(c.handler, "none");
  }
  // handlers say what runs it
  assert.equal(reg.find((c) => c.id === "analysis:t_test")!.handler, "analysis:t_test");
  assert.equal(reg.find((c) => c.id === "export:spss")!.handler, "export:@rescript/exporters#responsesToSav");
  assert.match(reg.find((c) => c.id === "methodology:maxdiff")!.handler, /^actions:create_maxdiff/);
  assert.equal(reg.find((c) => c.id === "platform:intelligent_mode")!.handler, "route:POST /api/copilot/turn");
  assert.equal(normalizeCapability({ id: "x:y", kind: "analysis", name: "Y", status: "supported" }).version, REGISTRY_VERSION);
});

test("services: every variable is an UPPER_SNAKE name, every service says which apps read it, and readiness names only variables", () => {
  for (const s of Object.values(SERVICES)) {
    for (const v of s.variables) assert.match(v, /^[A-Z][A-Z0-9_]+$/, `${s.id}: ${v}`);
    assert.ok(s.apps.length, s.id);
    const r = s.readiness({});
    for (const m of r.missing) for (const part of m.split(" | ")) assert.match(part, /^[A-Z][A-Z0-9_]+(?: \(or [A-Z0-9_]+\))?$/, `${s.id}: ${m}`);
  }
});

test("readiness from the environment: an empty one has nothing configured; a full one has everything; values never appear", () => {
  const none = capabilityReadiness({});
  const down = unreadyCapabilities(none).map((r) => r.id);
  for (const id of ["platform:intelligent_mode", "platform:machine_translation", "platform:semantic_retrieval", "platform:recorded_transcription", "qualitative:transcription", "methodology:video_response"]) assert.ok(down.includes(id), id);
  assert.ok(none.find((r) => r.id === "analysis:t_test")!.ready, "a capability with no service is always ready");
  assert.equal(none.find((r) => r.id === "analysis:multilevel")?.ready ?? false, false, "not_supported is never ready");
  const all = capabilityReadiness(FULL_ENV);
  assert.deepEqual(unreadyCapabilities(all).map((r) => r.id), [], JSON.stringify(unreadyCapabilities(all)));
  const blob = JSON.stringify([all, none, serviceReadiness(FULL_ENV)]);
  for (const v of Object.values(FULL_ENV).filter((x) => x.length > 3)) assert.ok(!blob.includes(v), `a value leaked: ${v}`);
});

test("the specific rules: Anthropic has no speech API; a pinned translation provider needs its own key; R2 or Supabase storage; a user's own connection overrides", () => {
  const anth = serviceReadiness({ AI_API_URL: "https://api.anthropic.com/v1" });
  assert.equal(anth.ai_chat.ready, true);
  assert.equal(anth.speech_to_text.ready, false);
  assert.deepEqual(anth.speech_to_text.missing, ["AI_STT_API_URL"]);
  assert.match(anth.speech_to_text.reason ?? "", /Anthropic/);
  assert.equal(serviceReadiness({ AI_API_URL: "https://api.anthropic.com/v1", AI_STT_API_URL: "https://api.groq.com/openai/v1" }).speech_to_text.ready, true);
  assert.equal(serviceReadiness({ AI_API_URL: "fake:" }).speech_to_text.ready, true, "the fake provider stands in for every lane");
  assert.equal(serviceReadiness({ TRANSLATION_PROVIDER: "google", AI_API_URL: "https://x" }).translation.ready, false);
  assert.equal(serviceReadiness({ AI_API_URL: "https://x" }).translation.ready, true, "the language model translates when no Google key");
  assert.equal(serviceReadiness({ SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" }).media_storage.ready, true);
  assert.equal(serviceReadiness({ R2_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "c" }).media_storage.ready, false);
  assert.equal(serviceReadiness({}, { ai_chat: true }).ai_chat.ready, true);
});

test("Intelligent Mode consults it: the brief lists only what is ready; an unready capability gets a refusal naming the missing configuration; the default brief is unchanged", () => {
  const none = capabilityReadiness({ AI_API_URL: "https://api.anthropic.com/v1", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
  const brief = capabilityBrief({ readiness: none });
  assert.doesNotMatch(brief.split("Not configured")[0], /Video \/ voice responses/, "an unready methodology is not offered");
  assert.match(brief, /Not configured on this installation \(do not offer\): .*Video \/ voice responses \(AI_STT_API_URL/);
  assert.equal(capabilityBrief(), capabilityBrief({ readiness: capabilityReadiness(FULL_ENV) }), "everything ready = the brief as before (the guide stays cacheable)");
  const r = capabilityRefusal("Transcribe the recorded answers of Q12", none);
  assert.ok(r, "refused");
  assert.equal(r!.capability.id, "platform:recorded_transcription");
  assert.match(r!.message, /not available on this installation: Speech-to-text provider is not configured \(an administrator sets AI_STT_API_URL\)\. Nothing was changed and nothing was charged\./);
  assert.equal(capabilityRefusal("Transcribe the recorded answers of Q12", capabilityReadiness(FULL_ENV)), null, "configured: no refusal");
  assert.equal(capabilityRefusal("Add a question about how often they transcribe interviews ".repeat(12), none), null, "a long text is never refused");
  assert.equal(capabilityRefusal("Add an age question", none), null);
  assert.equal(capabilityRefusal("Add a question asking whether they transcribe their interviews", none), null, "a question ABOUT it is survey content");
  assert.equal(capabilityRefusal("Translate the survey into Hindi", capabilityReadiness({})), null, "the copilot writes translations itself: never refused for a missing translation provider");
  assert.match(capabilityRefusal("Make a narrated video report of the findings", none)?.message ?? "", /^Narrated video reports is not available on this installation: .*REPORT_NARRATION_ENABLED/);
  assert.match(availabilityNote(none), /^NOT AVAILABLE ON THIS INSTALLATION .*Transcription of recorded answers \(AI_STT_API_URL/);
  assert.equal(availabilityNote(capabilityReadiness(FULL_ENV)), "");
});
