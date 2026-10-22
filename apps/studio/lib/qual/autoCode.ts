import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextResponse } from "next/server";
import {
  readAutoCodeSettings, autoCodeKey, autoCodeMode, autoCodeBatches, nextAutoCodeStep, sourcesToAutoCode, codingPrompt, readCodingReply, mergeCoding, fakeCodingReply,
  codesOfTheme, QUAL_CODING_SYSTEM, QUAL_CODING_SCHEMA, CODING_MAX_TOKENS,
  type AutoCodeSettings, type AutoCodeProgress, type QualJob,
} from "@rescript/analytics";
import type { AuthedUser } from "@/lib/guard";
import { codingState } from "./qualWorkspace";
import { checkRow, saveCoding } from "./qualStore";
import { claimJob, ensureJob, listJobs, modelRunner, saveJob } from "./synthesisStore";
import { synthesisContext } from "./synthesisContext";
import { storeNext, writeThemes } from "./synthesisRun";

/**
 * THE AUTOMATIC CODING PIPELINE, SERVER SIDE (2026-10-22) — see `@rescript/analytics` qual/autoCode.ts.
 *
 *   enqueueAutoCode(db, surveyId, transcriptId, actor)   when the study has it on: one job per source revision
 *                                                         (idempotent). Called on import, by a closed group session,
 *                                                         and — optionally — by the AI-moderated interviews (F1) when an
 *                                                         interview's transcript is written. No model call here.
 *   enqueuePending(db, surveyId)                          every source still to code (a transcript written by any path
 *                                                         after auto-coding was turned on): what the jobs route does on GET
 *   advanceJob(db, user, surveyId, jobId)                 codes the next batches under the lease, one metered call each,
 *                                                         merging into the coding as AI-suggested after each batch (so a
 *                                                         stop loses nothing), until done or the time budget is spent
 *
 * There is no background worker on Vercel: a job advances while someone with Analytics edit has the Qualitative
 * workspace open (it polls), or when they press Continue. The model calls are metered to the project.
 */

export function autoCodeSettingsOf(settings: unknown): AutoCodeSettings & { since?: string } {
  const o = (settings && typeof settings === "object" ? (settings as Record<string, unknown>).autoCode : null) as Record<string, unknown> | null;
  return { ...readAutoCodeSettings(o), ...(typeof o?.since === "string" ? { since: o.since } : {}) };
}

async function revisionOf(db: SupabaseClient, surveyId: string, transcriptId: string): Promise<number> {
  const r = await db.from("qual_transcripts").select("revision").eq("survey_id", surveyId).eq("id", transcriptId).maybeSingle();
  return r.error ? 0 : Number((r.data as { revision?: number } | null)?.revision ?? 0);
}

export async function enqueueAutoCode(db: SupabaseClient, surveyId: string, transcriptId: string, actor: string | null, opts: { force?: boolean } = {}): Promise<QualJob | null> {
  const cod = checkRow(await db.from("qual_codings").select("settings").eq("survey_id", surveyId).maybeSingle(), "settings") as { settings?: unknown } | null;
  const settings = autoCodeSettingsOf(cod?.settings);
  /* `force`: a researcher queued this source by hand — with the study's settings even when automatic coding is off */
  if (!settings.enabled && !opts.force) return null;
  const rev = await revisionOf(db, surveyId, transcriptId);
  return (await ensureJob(db, surveyId, { kind: "autocode", key: autoCodeKey(transcriptId, rev), sourceIds: [transcriptId], settings: { ...settings }, userId: actor })).job;
}

export async function enqueuePending(db: SupabaseClient, surveyId: string, actor: string | null): Promise<number> {
  const ctx = await synthesisContext(db, surveyId);
  const settings = autoCodeSettingsOf(ctx.settings);
  if (!settings.enabled) return 0;
  const jobs = await listJobs(db, surveyId, 500);
  const keys = new Set(jobs.map((j) => j.key));
  const revs = new Map<string, number>();
  for (const t of ctx.full.transcripts) revs.set(t.id, await revisionOf(db, surveyId, t.id));
  const todo = sourcesToAutoCode(ctx.full.transcripts.map((t) => ({ id: t.id, revision: revs.get(t.id) ?? 0, segments: t.segments, createdAt: t.createdAt })), keys, { since: settings.since });
  for (const id of todo.slice(0, 20)) await ensureJob(db, surveyId, { kind: "autocode", key: autoCodeKey(id, revs.get(id) ?? 0), sourceIds: [id], settings: { ...settings }, userId: actor });
  return todo.length;
}

/** run a job forward; the job as it stands afterwards, or the refusal (no provider, wallet) */
export async function advanceJob(db: SupabaseClient, user: AuthedUser, surveyId: string, jobId: string, budgetMs = 200_000): Promise<{ job: QualJob | null; response?: NextResponse }> {
  const job = await claimJob(db, surveyId, jobId);
  if (!job) return { job: (await listJobs(db, surveyId, 200)).find((j) => j.id === jobId) ?? null };
  const started = Date.now();
  const sourceId = job.sourceIds[0];
  const release = async (patch: Parameters<typeof saveJob>[3]) => { await saveJob(db, surveyId, job.id, { ...patch, release: true }); };
  try {
    let ctx = await synthesisContext(db, surveyId);
    const t = ctx.full.transcripts.find((x) => x.id === sourceId);
    if (!t) { await release({ status: "cancelled", error: "the source was deleted", finished: true }); return { job: { ...job, status: "cancelled" } }; }
    const rev = await revisionOf(db, surveyId, sourceId);
    if (autoCodeKey(sourceId, rev) !== job.key) {
      await release({ status: "cancelled", error: "the transcript was corrected since; the corrected text is coded by a new job", finished: true });
      await enqueueAutoCode(db, surveyId, sourceId, user.userId);
      return { job: { ...job, status: "cancelled" } };
    }
    const settings = readAutoCodeSettings(job.settings);
    const progress = { batchesTotal: 0, batchesDone: 0, calls: 0, excerpts: 0, codes: 0, rejected: 0, skippedSegments: 0, ...(job.progress as Partial<AutoCodeProgress>) } as AutoCodeProgress;
    const mode = progress.mode ?? autoCodeMode(settings, ctx.state.codebook);
    const { batches, skipped } = autoCodeBatches(t.segments, settings, { names: ctx.names });
    progress.batchesTotal = batches.length; progress.skippedSegments = skipped; progress.mode = mode;
    let cursor = { batch: Number((job.cursor as { batch?: number }).batch ?? 0) };
    const runner = await modelRunner(user, surveyId, "qual_coding");
    if ("response" in runner) { await release({ progress, error: "no AI provider, or the wallet refused — the job waits" }); return { job, response: runner.response }; }
    const touched = new Set<string>();
    while (true) {
      const step = nextAutoCodeStep({ status: "running", cursor }, batches.length);
      if ("done" in step) break;
      if (Date.now() - started > budgetMs) break;
      const b = batches[step.batch];
      const opts = { mode, codebook: ctx.state.codebook, objectives: ctx.study.objectives, redact: { names: ctx.names } };
      const r = await runner.run({ system: QUAL_CODING_SYSTEM, prompt: (nonce) => codingPrompt(b, { ...opts, nonce }), maxTokens: CODING_MAX_TOKENS, schema: QUAL_CODING_SCHEMA, schemaName: "qual_coding", fake: () => fakeCodingReply(b, opts), seed: `${job.key}:${step.batch}` });
      if (!r.ok) { await release({ progress, cursor, error: "the model call was refused — the job waits" }); return { job: { ...job, progress, cursor }, response: r.response }; }
      const read = readCodingReply(r.value, b, opts);
      /* merge into the coding as it is NOW (another coder may have saved); retried on a version conflict */
      let merged = false;
      for (let attempt = 0; attempt < 3 && !merged; attempt++) {
        const cur = codingState(checkRow(await db.from("qual_codings").select("codebook, excerpts, version").eq("survey_id", surveyId).maybeSingle(), "coding") as never);
        const m = mergeCoding(cur.state, [read], { now: new Date().toISOString(), mode, segmentCount: b.items.length });
        if ((await saveCoding(db, surveyId, m.state, cur.version, user.userId)) !== null) {
          merged = true;
          progress.excerpts += m.added.excerpts; progress.codes += m.added.codes; progress.rejected += m.rejected.length;
          for (const e of m.state.excerpts.slice(-m.added.excerpts)) for (const th of m.state.codebook.themes) if (codesOfTheme(m.state, th.id).some((c) => c.id === e.codeId)) touched.add(th.id);
          await db.from("qual_events").insert({ survey_id: surveyId, actor: null, actor_label: "AI (suggested)", action: "ai_coding.auto", detail: `Auto-coding of “${t.title}”, batch ${step.batch + 1} of ${batches.length}: ${m.entry.detail}`, ids: [sourceId, job.id] });
        }
      }
      if (!merged) { await release({ progress, cursor, error: "the coding kept changing — the job will retry" }); return { job: { ...job, progress, cursor } }; }
      progress.batchesDone = step.batch + 1; progress.calls++;
      cursor = { batch: step.batch + 1 };
      await saveJob(db, surveyId, job.id, { progress, cursor });
      ctx = await synthesisContext(db, surveyId);
    }
    const done = cursor.batch >= batches.length;
    if (done && settings.updateSummaries && touched.size) {
      const w = await writeThemes(runner, ctx.state, ctx.segments, [...touched].slice(0, 10), { sources: ctx.sources, names: ctx.names, objectives: ctx.study.objectives, budgetMs: Math.max(10_000, budgetMs - (Date.now() - started)) });
      if (!("error" in w)) for (const rec of w.records) await storeNext(db, surveyId, user.userId, "theme", rec.themeId, rec, rec.fingerprint, "ai");
    }
    await release({ status: done ? "done" : "running", progress, cursor, error: null, ...(done ? { finished: true } : {}) });
    return { job: { ...job, status: done ? "done" : "running", progress, cursor } };
  } catch (e) {
    await release({ error: (e as Error).message.slice(0, 500) }).catch(() => {});
    throw e;
  }
}
