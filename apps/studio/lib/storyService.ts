import "server-only";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Environment } from "@rescript/billing";
import { aiConfigured, completeJson, synthesizeSpeech } from "@rescript/ai";
import { DESIGN_PATCH_INSTRUCTIONS, sanitizeDesignPatch, describeDesign, type DesignConfig } from "@rescript/analytics/story";
import { loadReportFonts, speechNarration } from "@rescript/reportvideo";
import { compute, reportFacts, runPlanFor } from "./analytics";
import { mediaDb } from "./mediaRoute";
import { getMeter, meteredAi, recordUsage, SANDBOX_CUSTOMER } from "./metering";
import type { StoryDeps } from "./storyEngine";

/**
 * THE STORY REPORT SERVICE — `storyEngine` bound to the Studio: the real
 * analysis run and compute, the media store (Cloudflare R2 when configured,
 * else Supabase Storage), the bundled report fonts, the platform's speech
 * service for narration and its chat model for design wording, and the
 * meter. Credentials stay in this process's environment; nothing here puts
 * one in a response, a log line, a render record or a file.
 */

type MeterCtx = { customerId: string; surveyId: string; userId: string | null; environment: Environment };

async function meterCtx(db: SupabaseClient, surveyId: string, environment: string, userId: string | null): Promise<MeterCtx> {
  const { data } = await db.from("surveys").select("customer_id").eq("id", surveyId).maybeSingle();
  return { customerId: (data?.customer_id as string | null) ?? SANDBOX_CUSTOMER, surveyId, userId, environment: environment === "LIVE" ? "LIVE" : "TEST" };
}

export function storyDeps(db: SupabaseClient, opts: { userId?: string | null; surveyId?: string } = {}): StoryDeps {
  return {
    runPlanFor: (d, surveyId, ctx, o) => runPlanFor(d as SupabaseClient, surveyId, ctx as never, o) as never,
    compute: (d, surveyId, ctx, def) => compute(d as SupabaseClient, surveyId, ctx as never, def),
    reportFacts: (d, surveyId, def) => reportFacts(d as SupabaseClient, surveyId, def),
    store: () => mediaDb().stores.primary,
    fonts: () => loadReportFonts(join(process.cwd(), "public", "report-fonts")),
    narration: (surveyId, environment) => speechNarration("platform-speech", async (text, o) => {
      const ctx = await meterCtx(db, surveyId, environment, opts.userId ?? null);
      const m = await meteredAi(getMeter(), ctx, "AI_REQUEST", { estimateText: text, maxTokens: 0, operation: "report_narration" }, () => synthesizeSpeech(text, { language: o.language, ...(o.voiceId ? { voiceId: o.voiceId } : {}), format: o.format ?? "mp3" }));
      return m.ok ? m.value : null;
    }, aiConfigured),
    ...(aiConfigured() && opts.surveyId ? {
      designModel: async (text: string, current: DesignConfig) => {
        /* the request's words and the current look — no report content, no data */
        const user = `Current design: ${describeDesign(current)}\nRequest: ${text.slice(0, 600)}`;
        const ctx = await meterCtx(db, opts.surveyId!, "TEST", opts.userId ?? null);
        const m = await meteredAi(getMeter(), ctx, "AI_REQUEST", { estimateText: DESIGN_PATCH_INSTRUCTIONS + user, maxTokens: 300, operation: "report_design" }, () => completeJson(DESIGN_PATCH_INSTRUCTIONS, user, 300, { timeoutMs: 15_000 }));
        return m.ok && m.value ? sanitizeDesignPatch(m.value) : null;
      },
    } : {}),
    usage: (e) => {
      void (async () => {
        const { data } = await db.from("analytics_story_renders").select("survey_id, created_by").eq("id", e.renderId).maybeSingle();
        if (!data) return;
        const ctx = await meterCtx(db, String(data.survey_id), e.environment, (data.created_by as string | null) ?? null);
        await recordUsage(getMeter(), ctx, { eventType: "REPORT_GENERATION", quantity: 1, metadata: { format: e.kind === "video" ? "mp4" : "pptx", bytes: e.bytes, storyId: e.storyId, renderId: e.renderId, scenes: e.scenes, ...(e.seconds ? { seconds: e.seconds } : {}), environment: e.environment } });
      })().catch(() => { /* a billing outage must not lose a finished export */ });
    },
  };
}
