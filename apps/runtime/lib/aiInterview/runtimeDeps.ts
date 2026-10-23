import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { aiConfigured, aiProviderName, completeJson, JsonTextExtractor } from "@rescript/ai";
import { supabaseAdmin } from "@/lib/admin";
import { contextOf, getMeter, meteredSessionAi, meterProvider, type SessionBilling } from "@/lib/metering";
import { memoryStore } from "./memoryStore";
import { realtimeRefusal } from "./realtime";
import { supabaseStore } from "./supabaseStore";
import { AiInterviewError, type Deps, type ModelCaller, type PanelHooks } from "./service";
import { runtimePanels } from "@/lib/panels";
import { emitFromRuntime } from "@/lib/notifyEmit";
import type { SessionRec, StudyRec } from "./types";

/**
 * THE RUNTIME'S WIRING FOR AI INTERVIEWS: which store (the database; memory only on a runtime with no
 * database AND the fake provider), the model call (metered on the study's project as
 * `qual_ai_interview`, TEST usage for a test interview; streamed; the guide prefix cached), the clock
 * and the token hash.
 */

const dbConfigured = () => !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
export const isFakeProvider = () => aiProviderName() === "fake";

export function billingFor(study: StudyRec, session: SessionRec | null): SessionBilling | null {
  if (!study.customerId || !session) return null;
  return { customerId: study.customerId, surveyId: study.surveyId, environment: session.isTest ? "TEST" : "LIVE", sessionId: session.id };
}

/** the stand-in's reply for this turn: the suite's script ("fail", an object), else the rules' well-behaved reply */
function fakeValue(script: unknown, fake: () => Record<string, unknown>): Record<string, unknown> | "fail" {
  if (script === "fail") return "fail";
  if (script && typeof script === "object" && !Array.isArray(script)) return script as Record<string, unknown>;
  return fake();
}

const model: ModelCaller = async (req, o) => {
  const billing = billingFor(o.study, o.session);
  /* G1: the intent streams too (written first), so the speech gate knows it before the words */
  const extractor = o.onSay || o.onIntent ? new JsonTextExtractor(["say", "intent"], (d, field) => { if (field === "intent") o.onIntent?.(d); else o.onSay?.(d); }) : null;
  const fake = isFakeProvider();
  const value = fake ? fakeValue(o.script, o.fake) : null;
  if (value === "fail") return { failed: "the stand-in provider was told to fail" };
  const m = await meteredSessionAi(billing, { estimateText: `${req.system.join("\n")}\n${req.user}`, maxTokens: req.maxTokens, operation: "qual_ai_interview" }, () =>
    completeJson(req.system, req.user, req.maxTokens, {
      schema: req.schema, promptCache: true, operation: "qual_ai_interview", timeoutMs: 25_000, retries: 1, continuations: 0,
      ...(extractor ? { onText: (d: string) => extractor.push(d) } : {}),
      ...(fake ? { fakeStream: { text: JSON.stringify(value), chunkChars: 14, delayMs: 12 } } : {}),
    }));
  if ("refused" in m) return { failed: `the project's wallet refused: ${m.refused}` };
  return { value: m.value, costUsd: m.event ? Number(m.event.customerCharge ?? 0) : 0 };
};

export function aiInterviewDeps(): Deps {
  let store;
  if (dbConfigured()) store = supabaseStore(supabaseAdmin() as never);
  else if (isFakeProvider()) store = memoryStore();
  else throw new AiInterviewError("AI interviews need a database on this runtime.", 501, "no_database");
  return {
    store,
    model: aiConfigured() ? model : null,
    now: () => Date.now(),
    newToken: () => randomBytes(32).toString("hex"),
    hash: async (t) => createHash("sha256").update(t).digest("hex"),
    /* G3 2026-10-22: panel recruitment and alert events */
    panels: panelHooks(),
    notify: emitFromRuntime,
    /* G1: a realtime voice provider that can be gated (AI_REALTIME_*) */
    realtimeAvailable: realtimeRefusal() === null,
  };
}

/** the runtime's panel port as the service's hooks (G3) */
function panelHooks(): PanelHooks | null {
  const port = runtimePanels();
  if (!port) return null;
  return {
    async enter(a) {
      const r = await port.enter(a);
      if (r.kind === "admitted") return { kind: "admitted", entryId: r.entryId, pid: r.pid };
      if (r.kind === "over_quota") return { kind: "over_quota", message: r.message, redirect: r.redirect };
      if (r.kind === "none") return r;
      return { kind: r.kind, message: r.message };
    },
    attach: (id, ref) => port.attach(id, ref),
    exit: (a) => port.exit(a),
  };
}

/** the memory store's sandbox operations — only on a runtime with no database and the fake provider */
export function sandboxStore() {
  if (dbConfigured() || !isFakeProvider()) return null;
  return memoryStore();
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof AiInterviewError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status, headers: { "cache-control": "no-store" } });
  console.warn("[rescript:ai-interview] failed", JSON.stringify({ error: (e as Error).message }));
  return NextResponse.json({ error: "Something went wrong — please try again in a moment." }, { status: 500, headers: { "cache-control": "no-store" } });
}

/**
 * TEXT-TO-SPEECH UNDER THE METER — the runtime had no TTS meter (its only voice was the browser's).
 * Priced per character like the Studio's preview; a refusal or a failure means the browser's own voice.
 */
export async function meteredSpeech<T>(billing: SessionBilling | null, characters: number, language: string, fn: () => Promise<T>): Promise<T | null> {
  if (!billing) return fn();
  const meter = getMeter();
  const providerName = process.env.AI_API_URL === "fake:" ? "fake" : "openai-compatible";
  let hold;
  try {
    hold = await meter.reserve(contextOf(billing), { eventType: "TEXT_TO_SPEECH_CHARACTER", provider: meterProvider(providerName, "tts"), service: "tts", model: (process.env.AI_TTS_MODEL ?? "").trim() || "tts-1", quantity: characters, metadata: { operation: "qual_ai_interview_tts", language, sessionId: billing.sessionId.slice(0, 8) } });
  } catch { return fn(); }
  if (!hold.ok) return null;
  try {
    const value = await fn();
    if (value) await meter.settle(hold, { quantity: characters, metadata: { operation: "qual_ai_interview_tts", language, sessionId: billing.sessionId.slice(0, 8) } });
    else await meter.release(hold);
    return value;
  } catch (e) { await meter.release(hold).catch(() => {}); throw e; }
}

