import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { corpusFromHistory, replayCorpus, type LanguageCorpus } from "@rescript/engine";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { operationStoreFor } from "@/lib/copilot/operationsStore";
import { loadDefinition } from "@/lib/analytics";
import { supabaseService } from "@/lib/authServer";

export const dynamic = "force-dynamic";

/**
 * THE LANGUAGE CORPUS OF A PROJECT (Phase 8): every sentence typed in
 * Intelligent mode, with how it was read, against the survey as it is now —
 * as a file to keep in the repository's corpus (`packages/engine/corpus`) and
 * replay after every change to the engine's language, or to read for the
 * backlog: the sentences the engine still hands to the model, most said first.
 *
 * POST { surveyId, scope?, definition? (the sandbox sends its own survey),
 *        replay?: true } → the corpus; with `replay`, also the replay of it
 * against the engine as it runs here (same / better / worse / changed and the
 * backlog). `project.read` on the project; the sandbox needs no session.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  let body: { surveyId?: unknown; scope?: unknown; definition?: unknown; replay?: unknown; download?: unknown };
  try { body = await req.json(); } catch { return isFailure(user) ? user.response : NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const surveyId = typeof body.surveyId === "string" ? body.surveyId : "";
  const sandbox = surveyId === "sandbox";
  if (isFailure(user) && !sandbox) return user.response;
  let def: SurveyDefinition;
  let title = "Sandbox";
  let key = surveyId;
  if (sandbox) {
    const parsed = SurveyDefinition.safeParse(body.definition);
    if (!parsed.success) return NextResponse.json({ error: "send the survey as it is open in the editor (definition)" }, { status: 400 });
    def = parsed.data;
    title = String(def.meta.title || "Sandbox");
    const scope = typeof body.scope === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(body.scope) ? body.scope : "shared";
    key = `sandbox:${scope}`;
  } else {
    const ctx = await requireProjectFor(user as Exclude<typeof user, { response: unknown }>, surveyId, "project.read");
    if (isFailure(ctx)) return ctx.response;
    const loaded = await loadDefinition(supabaseService(), surveyId);
    if ("error" in loaded) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
    def = loaded.def as SurveyDefinition;
    title = String(def.meta.title ?? surveyId);
  }
  let records;
  try { const store = await operationStoreFor(sandbox ? "sandbox" : surveyId); records = await store.list(key, 400); }
  catch (e) { return NextResponse.json({ error: `The operation history could not be read: ${(e as Error).message}` }, { status: 500 }); }
  const corpus: LanguageCorpus = corpusFromHistory(def, records.map((r) => ({ prompt: r.prompt, source: r.source, intent: r.intent, createdAt: r.createdAt })), { id: surveyId, title });
  if (body.download) {
    const name = `${title.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "survey"}-language-corpus.json`;
    return new NextResponse(JSON.stringify(corpus, null, 1), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
  }
  const replay = body.replay ? replayCorpus(corpus) : null;
  return NextResponse.json({ ok: true, corpus, ...(replay ? { replay: { counts: replay.counts, backlog: replay.backlog, results: replay.results.map((r) => ({ text: r.entry.text, was: r.entry.kind, now: r.now.kind, verdict: r.verdict, why: r.why })) } } : {}) }, { headers: { "cache-control": "no-store" } });
}
