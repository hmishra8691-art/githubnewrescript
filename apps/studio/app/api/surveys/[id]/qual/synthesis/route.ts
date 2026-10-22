import { NextRequest } from "next/server";
import { aiProviderName } from "@rescript/ai";
import {
  themePack, synthesisEstimate, editThemeSynthesis, MAX_THEMES_PER_RUN, insightPack, insightsEstimate, editInsights, themeSynthesisState,
  type QualSegment, type QualState, type SourceMeta, type StudyContext, type ThemeSynthesis, type StudyInsights,
} from "@rescript/analytics";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { hasPii, json, recordEvents, refuse, storeFailure } from "@/lib/qual/qualStore";
import { parseSynthesisRequest, synthesisWorkspace } from "@/lib/qual/synthesisWorkspace";
import { insertSynthesis, latestVersion, modelRunner, synthesisRows } from "@/lib/qual/synthesisStore";
import { storeNext, writeInsights, writeThemes } from "@/lib/qual/synthesisRun";
import { synthesisContext } from "@/lib/qual/synthesisContext";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * AI QUALITATIVE SYNTHESIS (2026-10-22).
 *
 *   GET                                   every theme summary and the study insights (latest version, the version list,
 *                                         current / stale) — Data view; redacted without contact details
 *   POST { action: "themes", themeIds?, estimate? }     one metered call per theme (≤ 20 a run), from the theme's
 *                                         excerpts only (redacted, fenced); every claim checked (citations, groups,
 *                                         numbers); stored as a NEW version — Data view + Analytics edit
 *   POST { action: "insights", compare?: [a, b], estimate? }  key findings per objective / hypothesis, one call
 *   POST { action: "edit_theme", themeId, version, edit }      a researcher's edit → a new version, "edited"
 *   POST { action: "edit_insights", version, edit }
 *
 * `estimate: true` answers the calls and tokens without calling the model. An edit on top of a version the
 * caller has not seen is 409. THE SANDBOX (fake provider only) sends its state, segments, sources and study and
 * gets the records back; nothing is stored, and its edits run in the page (the same pure functions).
 */

const now = () => new Date().toISOString();

const liveThemeIds = (state: QualState, wanted: string[] | null) => state.codebook.themes.filter((t) => t.status !== "rejected" && (!wanted || wanted.includes(t.id))).map((t) => t.id).slice(0, MAX_THEMES_PER_RUN);

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability("read"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "read");
  if (refused) return refused;
  try {
    const db = supabaseService();
    const [ctx, rows] = await Promise.all([synthesisContext(db, params.id), synthesisRows(db, params.id)]);
    return json({ ok: true, ...synthesisWorkspace(rows, ctx.state, ctx.segments, ctx.study, { pii: hasPii(gate), names: ctx.names }), study: { objectives: ctx.study.objectives, hypotheses: ctx.study.hypotheses } });
  } catch (e) { return storeFailure(e); }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return isFailure(authed) ? authed.response : json({ error: "expected a JSON body" }, 400);
  const parsed = parseSynthesisRequest(body);

  /* ---------------------------------------------------- the sandbox: compute only, fake provider only */
  if (params.id === "sandbox") {
    if (aiProviderName() !== "fake") return isFailure(authed) ? authed.response : json({ error: "the sandbox writes synthesis only against the fake provider" }, 403);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const state = body.state as QualState | undefined;
    const segments = (Array.isArray(body.segments) ? body.segments : []).filter((s: QualSegment) => s && typeof s.text === "string" && typeof s.id === "string").slice(0, 5000) as QualSegment[];
    if (!state?.codebook || !Array.isArray(state.excerpts)) return json({ error: "send the sandbox's state and segments" }, 400);
    const sources = (body.sources && typeof body.sources === "object" ? body.sources : {}) as Record<string, SourceMeta>;
    const names = Array.isArray(body.redactNames) ? body.redactNames.map(String).slice(0, 500) : [];
    const study = (body.study && typeof body.study === "object" ? body.study : { objectives: [], hypotheses: [] }) as StudyContext;
    const v = parsed.value;
    if (v.action !== "themes" && v.action !== "insights") return json({ error: "the sandbox edits in the page" }, 400);
    const runner = await modelRunner(isFailure(authed) ? null : authed, "sandbox", "qual_synthesis", "analytics.edit", Array.isArray(body.fake) ? body.fake : null);
    if ("response" in runner) return runner.response;
    if (v.action === "themes") {
      const ids = liveThemeIds(state, v.themeIds);
      if (v.estimateOnly) return json({ ok: true, estimate: synthesisEstimate(ids.map((id) => themePack(state, segments, id, { sources, redact: { names } }))) });
      const r = await writeThemes(runner, state, segments, ids, { sources, names, objectives: study.objectives ?? [] });
      if ("error" in r) return r.error!;
      return json({ ok: true, records: r.records, notRun: r.notRun, calls: runner.calls, provider: "fake" });
    }
    const summaries = (Array.isArray(body.summaries) ? body.summaries : []) as ThemeSynthesis[];
    if (v.estimateOnly) return json({ ok: true, estimate: insightsEstimate(insightPack(state, segments, study, { sources, redact: { names } })) });
    const r = await writeInsights(runner, state, segments, study, { sources, names, summaries, compare: v.compare });
    if ("error" in r) return r.error!;
    return json({ ok: true, record: r.record, calls: runner.calls, provider: "fake" });
  }

  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability("code"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "code");
  if (refused) return refused;
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const v = parsed.value;
  const db = supabaseService();
  try {
    const ctx = await synthesisContext(db, params.id);
    const existing = await synthesisRows(db, params.id);
    const view = () => synthesisWorkspace(existing, ctx.state, ctx.segments, ctx.study, { pii: hasPii(gate), names: ctx.names });
    if (v.action === "themes") {
      const ids = liveThemeIds(ctx.state, v.themeIds);
      if (!ids.length) return json({ error: "There are no themes yet — group codes under themes first." }, 409);
      if (v.estimateOnly) return json({ ok: true, estimate: synthesisEstimate(ids.map((id) => themePack(ctx.state, ctx.segments, id, { sources: ctx.sources, redact: { names: ctx.names } }))) });
      const runner = await modelRunner(gate.user, params.id, "qual_synthesis");
      if ("response" in runner) return runner.response;
      const r = await writeThemes(runner, ctx.state, ctx.segments, ids, { sources: ctx.sources, names: ctx.names, objectives: ctx.study.objectives });
      if ("error" in r) return r.error!;
      for (const rec of r.records) await storeNext(db, params.id, gate.user.userId, "theme", rec.themeId, rec, rec.fingerprint, "ai");
      await recordEvents(db, gate, [{ actor: "ai", action: "synthesis.themes", detail: `AI theme summaries written for ${r.records.length} theme${r.records.length === 1 ? "" : "s"} (${runner.calls} model call${runner.calls === 1 ? "" : "s"}; ${r.records.reduce((n, x) => n + x.dropped.length, 0)} sentence(s) dropped as uncited, misattributed or stating numbers)`, ids: r.records.map((x) => x.themeId) }]);
      return json({ ok: true, calls: runner.calls, notRun: r.notRun, dropped: r.records.flatMap((x) => x.dropped.map((d) => ({ ...d, themeId: x.themeId }))).slice(0, 100), ...synthesisWorkspace(await synthesisRows(db, params.id), ctx.state, ctx.segments, ctx.study, { pii: hasPii(gate), names: ctx.names }) });
    }
    if (v.action === "insights") {
      if (v.estimateOnly) return json({ ok: true, estimate: insightsEstimate(insightPack(ctx.state, ctx.segments, ctx.study, { sources: ctx.sources, redact: { names: ctx.names } })) });
      const runner = await modelRunner(gate.user, params.id, "qual_synthesis");
      if ("response" in runner) return runner.response;
      const summaries = Object.values(view().themes).map((t) => t.record).filter((t) => themeSynthesisState(t, ctx.state, ctx.segments) === "current");
      const r = await writeInsights(runner, ctx.state, ctx.segments, ctx.study, { sources: ctx.sources, names: ctx.names, summaries, compare: v.compare });
      if ("error" in r) return r.error!;
      await storeNext(db, params.id, gate.user.userId, "insights", "study", r.record, r.record.fingerprint, "ai");
      await recordEvents(db, gate, [{ actor: "ai", action: "synthesis.insights", detail: `AI key findings written: ${r.record.objectives.filter((o) => o.status === "answered").length} objective(s) answered, ${r.record.objectives.filter((o) => o.status === "not_enough_evidence").length} with not enough evidence; ${r.record.dropped.length} sentence(s) dropped`, ids: [] }]);
      return json({ ok: true, calls: runner.calls, dropped: r.record.dropped.slice(0, 100), ...synthesisWorkspace(await synthesisRows(db, params.id), ctx.state, ctx.segments, ctx.study, { pii: hasPii(gate), names: ctx.names }) });
    }
    if (!hasPii(gate)) return json({ error: "Editing the write-up needs the text as recorded, and your access shows it redacted (no contact details).", code: "insufficient_role" }, 403);
    const kind = v.action === "edit_theme" ? "theme" : "insights";
    const target = v.action === "edit_theme" ? v.themeId : "study";
    const latest = await latestVersion(db, params.id, kind, target);
    if (latest !== v.version) return json({ error: "The write-up has changed since you loaded it — reload, then edit again.", code: "version_conflict", version: latest }, 409);
    const top = existing.find((r) => r.kind === kind && r.target === target && r.version === latest);
    if (!top) return json({ error: "nothing to edit — generate it first" }, 404);
    let next: ThemeSynthesis | StudyInsights;
    try {
      next = v.action === "edit_theme"
        ? editThemeSynthesis(top.content as ThemeSynthesis, v.edit, ctx.state, ctx.segments, { actor: gate.user.userId, now: now() })
        : editInsights(top.content as StudyInsights, v.edit, ctx.state, ctx.segments, { actor: gate.user.userId, now: now() });
    } catch (e) { return json({ error: (e as Error).message }, 400); }
    const saved = await insertSynthesis(db, params.id, { kind, target, version: latest + 1, status: "edited", content: next, fingerprint: top.fingerprint, userId: gate.user.userId });
    if (saved === null) return json({ error: "Someone saved an edit at the same moment — reload, then try again.", code: "version_conflict" }, 409);
    await recordEvents(db, gate, [{ actor: gate.user.userId, action: "synthesis.edited", detail: `Edited the ${kind === "theme" ? `summary of theme ${target}` : "key findings"} (version ${latest + 1})`, ids: [target] }]);
    return json({ ok: true, version: saved, ...synthesisWorkspace(await synthesisRows(db, params.id), ctx.state, ctx.segments, ctx.study, { pii: true, names: ctx.names }) });
  } catch (e) { return storeFailure(e); }
}
