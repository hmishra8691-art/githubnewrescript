import "server-only";
import type { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  themePack, themeSynthesisPrompt, readThemeSynthesis, fakeThemeSynthesisReply, THEME_SYNTHESIS_SYSTEM, THEME_SYNTHESIS_SCHEMA, SYNTHESIS_MAX_TOKENS,
  insightPack, insightsPrompt, readInsights, fakeInsightsReply, insightsEstimate, INSIGHTS_SYSTEM, INSIGHTS_SCHEMA, INSIGHTS_MAX_TOKENS,
  type QualSegment, type QualState, type SourceMeta, type StudyContext, type ThemeSynthesis,
} from "@rescript/analytics";
import { json } from "./qualStore";
import { insertSynthesis, latestVersion, type ModelRunner } from "./synthesisStore";

/** the theme summaries and insights, written through a runner — shared by the synthesis route and the auto-coding job */
const now = () => new Date().toISOString();

export async function writeThemes(runner: ModelRunner, state: QualState, segments: QualSegment[], themeIds: string[], ctx: { sources: Record<string, SourceMeta>; names: string[]; objectives: string[]; budgetMs?: number }): Promise<{ records: ThemeSynthesis[]; notRun: number } | { error: NextResponse }> {
  const out: ThemeSynthesis[] = [];
  const started = Date.now();
  let notRun = 0;
  for (const [i, id] of themeIds.entries()) {
    if (Date.now() - started > (ctx.budgetMs ?? 220_000)) { notRun = themeIds.length - i; break; }
    const pack = themePack(state, segments, id, { sources: ctx.sources, redact: { names: ctx.names }, objectives: ctx.objectives });
    if (!pack.items.length) continue;
    const r = await runner.run({ system: THEME_SYNTHESIS_SYSTEM, prompt: (nonce) => themeSynthesisPrompt(pack, { nonce, redact: { names: ctx.names } }), maxTokens: SYNTHESIS_MAX_TOKENS, schema: THEME_SYNTHESIS_SCHEMA, schemaName: "qual_theme_summary", fake: () => fakeThemeSynthesisReply(pack), seed: `theme:${id}:${pack.fingerprint}` });
    if (!r.ok) return { error: r.response };
    out.push(readThemeSynthesis(r.value, pack, { now: now(), provider: runner.fake ? "fake" : "configured", sessionOf: (src) => ctx.sources[src]?.sessionId ?? null }));
  }
  return { records: out, notRun };
}

export async function writeInsights(runner: ModelRunner, state: QualState, segments: QualSegment[], study: StudyContext, ctx: { sources: Record<string, SourceMeta>; names: string[]; summaries: ThemeSynthesis[]; compare: [string, string] | null }) {
  const pack = insightPack(state, segments, study, { sources: ctx.sources, redact: { names: ctx.names }, summaries: ctx.summaries, compare: ctx.compare });
  if (!pack.items.length) return { error: json({ error: "There is no coded evidence yet — code the data (and review it) before asking for findings." }, 409) };
  const r = await runner.run({ system: INSIGHTS_SYSTEM, prompt: (nonce) => insightsPrompt(pack, { nonce, redact: { names: ctx.names } }), maxTokens: INSIGHTS_MAX_TOKENS, schema: INSIGHTS_SCHEMA, schemaName: "qual_insights", fake: () => fakeInsightsReply(pack), seed: `insights:${pack.fingerprint}` });
  if (!r.ok) return { error: r.response };
  return { record: readInsights(r.value, pack, { now: now(), provider: runner.fake ? "fake" : "configured", sessionOf: (src) => ctx.sources[src]?.sessionId ?? null }), estimate: insightsEstimate(pack) };
}

/** store a newly generated record as the next version (retried: a concurrent writer may take a version) */
export async function storeNext(db: SupabaseClient, surveyId: string, userId: string, kind: "theme" | "insights", target: string, content: unknown, fingerprint: string, status: "ai" | "edited"): Promise<number | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const v = (await latestVersion(db, surveyId, kind, target)) + 1;
    if ((await insertSynthesis(db, surveyId, { kind, target, version: v, status, content, fingerprint, provider: "model", userId })) !== null) return v;
  }
  return null;
}
