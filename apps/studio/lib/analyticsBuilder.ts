import type { SupabaseClient } from "@supabase/supabase-js";
import { aiConfigured, aiModelName, aiProviderName, collectUsage, completeJson, synthesizeSpeech } from "@rescript/ai";
import {
  claimsFromItems, claimsHash, failedResult, gateInterpretation, hash64, interpretationBrief, INTERPRETATION_INSTRUCTIONS, promptVersion, redactItemsForModel, redactPrompt, type Withheld,
  type AnalysisDefinition, type AnalysisResult, type BuilderItem, type GatedInterpretation, type ReportBrief, type StoryDefinition,
} from "@rescript/analytics";
import type { AuthedUser } from "@/lib/guard";
import { billingProjectFor, meteredAi, meterModel, meterProvider, usageToSpec } from "@/lib/metering";
import { aiAllowed } from "@/lib/aiPolicy";
import { keepReply, recordAiRefused, recordAiText, replyFromCache, replyKey } from "@/lib/aiText";
import { compute, type LoadedContext } from "@/lib/analytics";
export { parseBrief } from "@/lib/analyticsBrief";

/**
 * SERVER SIDE OF THE REPORT BUILDER — reads the saved analyses and their
 * computed results, asks the model (when there is one) for an interpretation
 * that must pass the number gate, and, on request, narrates a story.
 * Keys never leave this process; nothing here is reachable from a shared page.
 */
const MAX_ANALYSES = 60;

export async function builderItems(db: SupabaseClient, surveyId: string, loaded: LoadedContext, ids?: readonly string[]): Promise<{ items: BuilderItem[]; truncated: boolean }> {
  let q = db.from("analytics_analyses").select("id, name, definition, position").eq("survey_id", surveyId).is("deleted_at", null).order("position", { ascending: true, nullsFirst: false });
  if (ids?.length) q = q.in("id", [...ids]);
  const { data } = await q;
  const rows = (data ?? []) as { id: string; name: string; definition: AnalysisDefinition }[];
  const items: BuilderItem[] = [];
  for (const a of rows.slice(0, MAX_ANALYSES)) {
    const definition = { ...a.definition, id: a.id, name: a.name } as AnalysisDefinition;
    /* one that cannot be computed is reported as such by the builder; it must not stop the others */
    try { items.push({ id: a.id, name: a.name, definition, result: await compute(db, surveyId, loaded, definition) as AnalysisResult }); }
    catch (e) { console.error(`[analytics] report builder: analysis ${a.id} failed:`, e); items.push({ id: a.id, name: a.name, definition, result: failedResult(a.name, a.definition.kind) }); }
  }
  return { items, truncated: rows.length > MAX_ANALYSES };
}

export type ModelStatus = "not_asked" | "no_model" | "gated" | "nothing" | "ai_off";

/**
 * The model's reading of the results — only when asked for, only when a model is configured, only when the project's
 * AI switch allows it, from results redacted first (no small group, no open-text words), cached under its claims and
 * prompt version, and only what passes the claim check. What stands is recorded (audit A-1, A-2, A-6, A-7).
 */
export async function modelInterpretation(user: AuthedUser | null, surveyId: string, brief: ReportBrief, items: readonly BuilderItem[], opts: { ask: boolean; fake?: unknown; db?: SupabaseClient }): Promise<{ interpretation: GatedInterpretation | null; status: ModelStatus; detail: string; withheld?: Withheld[] }> {
  if (!opts.ask) return { interpretation: null, status: "not_asked", detail: "Interpretation was not requested." };
  if (!aiConfigured()) return { interpretation: null, status: "no_model", detail: "No AI model is configured for this workspace, so no interpretation was written. Findings are unaffected." };
  const red = redactItemsForModel(items.filter((i) => !i.result.error && i.result.base.n > 0).slice(0, 12));
  const usable = red.items;
  if (!usable.length) return { interpretation: null, status: "nothing", detail: red.withheld.length ? "Every result rests on groups too small to send to a model, so no interpretation was written." : "There are no usable results to interpret.", withheld: red.withheld };
  const claims = claimsFromItems(usable, brief);
  const pv = promptVersion(INTERPRETATION_INSTRUCTIONS);
  const model = aiModelName("large");
  const who = { userId: user?.userId ?? null, surveyId };
  let raw: unknown = aiProviderName() === "fake" && opts.fake && typeof opts.fake === "object" ? opts.fake : null;
  let cached = false, charge = 0, failure: string | null = null;
  /* the project's AI switch comes first, whatever supplies the reply — a project that is Internal gets no model text, from a provider or a fixture */
  const allowed = await aiAllowed(surveyId, "analytics_interpretation");
  if (!allowed.allowed) { void recordAiRefused(who, "analytics_interpretation", allowed.reason ?? "project_internal"); return { interpretation: null, status: "ai_off", detail: allowed.message ?? "AI is off for this project." }; }
  if (!raw) {
    const prompt = redactPrompt(`${INTERPRETATION_INSTRUCTIONS}\n\n${interpretationBrief(brief, usable)}`).text;
    const key = replyKey({ op: "interpretation", pv, model, claims: claimsHash(claims), brief: hash64(prompt) });
    const hit = await replyFromCache<unknown>(opts.db, surveyId, key);
    if (hit) { raw = hit; cached = true; }
    else {
      const billing = await billingProjectFor(user, surveyId, "analytics.edit");
      if ("response" in billing) return { interpretation: null, status: "nothing", detail: "The workspace could not be charged for the model call, so no interpretation was written." };
      const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: prompt, maxTokens: 1500, operation: "analytics_interpretation" }, () => completeJson("You interpret survey results for a research team. Answer with JSON only.", prompt, 1500, { timeoutMs: 45_000 })).catch((e: unknown) => { failure = e instanceof Error ? e.message : "the model call failed"; return null; });
      if (m && !m.ok) { if (m.reason === "ai_off") return { interpretation: null, status: "ai_off", detail: m.message }; failure = m.message; }
      if (m && m.ok) { raw = m.value; charge = m.event?.customerCharge ?? 0; await keepReply(opts.db, surveyId, key, raw); }
    }
  }
  if (!raw) return { interpretation: null, status: "nothing", detail: failure ? `The model could not be used (${failure}), so no interpretation was written.` : "The model gave nothing usable, so no interpretation was written.", withheld: red.withheld };
  const g = gateInterpretation(usable, raw, brief);
  const kept = g.implications.length + g.recommendations.length;
  if (aiProviderName() !== "fake" || !opts.fake) void recordAiText(who, { operation: "analytics_interpretation", model, promptVersion: pv, claimsHash: claimsHash(claims), claims: [...new Set((g.sentences ?? []).flatMap((x) => x.claims))], offered: g.offered, kept, replaced: 0, rejected: g.rejected.map((r) => ({ reason: r.reason })), withheld: red.withheld, cached, charge });
  return { interpretation: kept ? g : null, status: kept ? "gated" : "nothing", withheld: red.withheld, detail: `${kept} of ${g.offered} model sentences passed the claim check${g.rejected.length ? `; dropped: ${g.rejected.map((r) => `“${r.text.slice(0, 60)}” (${r.reason})`).join(" | ")}` : ""}${red.withheld.length ? `; ${red.withheld.length} small-group or open-text result${red.withheld.length === 1 ? " was" : "s were"} not sent to the model` : ""}${cached ? "; reused from an identical earlier request" : ""}.` };
}

export interface Narration { audio: Record<string, string>; narrated: number; failed: string[]; status: "ok" | "not_configured" | "partial" | "refused"; message: string }

/**
 * One audio clip per scene, through the existing TTS provider and meter. Not
 * configured → no audio and an honest message (the story still exports, silent).
 * A wallet that runs dry mid-way keeps the clips made so far and says so.
 */
export async function narrateStory(user: AuthedUser | null, surveyId: string, story: Pick<StoryDefinition, "scenes">, opts: { language?: string } = {}): Promise<Narration> {
  const audio: Record<string, string> = {}; const failed: string[] = [];
  const scenes = story.scenes.filter((s) => !s.hidden && s.narration.trim());
  if (!aiConfigured()) return { audio, narrated: 0, failed, status: "not_configured", message: "No speech provider is configured (AI_API_URL / AI_API_KEY, optionally AI_TTS_MODEL), so the story was exported without narration." };
  const billing = await billingProjectFor(user, surveyId, "analytics.export");
  if ("response" in billing) return { audio, narrated: 0, failed, status: "refused", message: "The workspace could not be charged for narration, so the story was exported without it." };
  /* this reserves by hand, so it asks the project's AI switch itself (audit A-2) */
  const allowed = await aiAllowed(billing.ctx.surveyId, "story_narration");
  if (!allowed.allowed) return { audio, narrated: 0, failed, status: "refused", message: `${allowed.message} The story was exported without narration.` };
  const providerName = process.env.AI_API_URL === "fake:" ? "fake" : "openai-compatible";
  let chars = 0;
  for (const s of scenes) {
    const text = s.narration.slice(0, 1200);
    if (chars + text.length > 8000) { failed.push(s.id); continue; }
    chars += text.length;
    const hold = await billing.meter.reserve(billing.ctx, { eventType: "TEXT_TO_SPEECH_CHARACTER", provider: meterProvider(providerName, "tts"), service: "tts", model: meterModel(providerName, (process.env.AI_TTS_MODEL ?? "").trim() || "tts-1", "tts"), quantity: text.length, metadata: { operation: "story_narration" } });
    if (!hold.ok) { failed.push(...scenes.slice(scenes.indexOf(s)).map((x) => x.id).filter((id) => !failed.includes(id))); return { audio, narrated: Object.keys(audio).length, failed, status: Object.keys(audio).length ? "partial" : "refused", message: `Narration stopped: ${hold.message}` }; }
    try {
      const { value: out, usage } = await collectUsage(() => synthesizeSpeech(text, { language: opts.language ?? "en", format: "mp3" }));
      if (!out || !usage.length) { await billing.meter.release(hold).catch(() => {}); failed.push(s.id); continue; }
      await billing.meter.settle(hold, { ...usageToSpec(usage, { kind: "tts" }), metadata: { operation: "story_narration" } }).catch((e: unknown) => console.warn("[rescript:billing] story narration settle failed", (e as Error)?.message));
      audio[s.id] = `data:${out.mimeType};base64,${Buffer.from(out.bytes).toString("base64")}`;
    } catch (e) { await billing.meter.release(hold).catch(() => {}); console.warn("[analytics] narration failed for a scene:", (e as Error)?.message); failed.push(s.id); }
  }
  const narrated = Object.keys(audio).length;
  return { audio, narrated, failed, status: !narrated ? "not_configured" : failed.length ? "partial" : "ok", message: !narrated ? "The speech provider returned no audio, so the story was exported without narration." : failed.length ? `${narrated} of ${scenes.length} scenes were narrated; the others are silent.` : `All ${narrated} scenes narrated.` };
}
