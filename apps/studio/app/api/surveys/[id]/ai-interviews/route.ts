import { NextRequest } from "next/server";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { loadDefinition } from "@/lib/analytics";
import { runtimeBaseUrl } from "@/lib/runtime-url";
import { qualAbilities, qualGuardCapability } from "@/lib/qual/qualAccess";
import { json, refuse } from "@/lib/qual/qualStore";
import { launchRow, liveView, parsePacks, realtimeReadiness, withPacks } from "@/lib/aiInterviews/view";
import { AiInterviewStoreError, currentStudy, launch, MIGRATION_MESSAGE, sessionsOf, setStudyStatus } from "@/lib/aiInterviews/store";
import { sandboxCall } from "@/lib/aiInterviews/sandboxProxy";

export const dynamic = "force-dynamic";

/**
 * AI-MODERATED INTERVIEWS — THE STUDY (2026-10-22). Research Tools → Qualitative → AI interviews.
 *
 *   GET                          the live view: the study (link, test link, status, AI spend), counts by
 *                                status, quotas, the interviews (status, flags, turns, cost) — Data view
 *   POST { action: "launch", relaunch? }   a SNAPSHOT of the saved guide + its AI settings becomes a live
 *                                study with a public link; refused without a consent statement (and, for
 *                                voice / video, a recording disclosure) — Data edit
 *   POST { action: "pause" | "resume" | "close" }   — Data edit
 *
 * The sandbox (unsaved project, fake provider) forwards to the runtime's in-memory studies
 * (`?key=` / `observerKey` is the sandbox's handle). Respondents' words: the Data module decides.
 */
const failure = (e: unknown) => e instanceof AiInterviewStoreError ? json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status) : json({ error: (e as Error).message ?? "AI interviews could not be read" }, 500);

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  if (params.id === "sandbox") {
    const key = req.nextUrl.searchParams.get("key");
    if (!key) return json({ study: null, counts: null, quotas: [], target: null, interviews: [], available: true, sandbox: true, realtime: realtimeReadiness() });
    const r = await sandboxCall({ action: "list", observerKey: key });
    return json({ ...(r.body as object), sandbox: true, realtime: realtimeReadiness() }, r.status);
  }
  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability("read"));
  if (isFailure(gate)) return gate.response;
  try {
    const db = supabaseService();
    const study = await currentStudy(db, params.id);
    const view = liveView(study, study ? await sessionsOf(db, study.id) : [], runtimeBaseUrl());
    return json({ ...view, can: qualAbilities(gate.grant) });
  } catch (e) {
    if (e instanceof AiInterviewStoreError && e.code === "migration_required") return json({ study: null, counts: null, quotas: [], target: null, interviews: [], available: false, note: MIGRATION_MESSAGE });
    return failure(e);
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "expected a JSON body" }, 400);
  const action = String(body.action ?? "");
  if (params.id === "sandbox") {
    const forward = action === "launch" ? { action: "launch", guide: body.guide, title: body.title, guideLanguage: body.guideLanguage }
      : action === "translations" ? { action: "translations", observerKey: body.observerKey, translations: parsePacks(body.translations) }
      : { action: action === "pause" ? "status" : action === "resume" ? "status" : action === "close" ? "status" : action, status: action === "pause" ? "paused" : action === "resume" ? "live" : action === "close" ? "closed" : undefined, observerKey: body.observerKey, id: body.id, reason: body.reason };
    const r = await sandboxCall(forward);
    return json(r.body, r.status);
  }
  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability("manage"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "manage");
  if (refused) return refused;
  try {
    const db = supabaseService();
    if (action === "launch") {
      const loaded = await loadDefinition(db, params.id);
      if ("error" in loaded) return json({ error: loaded.error }, loaded.status);
      const r = launchRow(loaded.def, gate.user.userId, typeof body.title === "string" ? body.title : undefined);
      if (!r.ok) return json({ error: r.blocking[0], blocking: r.blocking, warnings: r.warnings, code: "not_launchable" }, 400);
      /* G1: the study languages' wording made at launch (the tab translated it a moment ago; the saved guide may not have it yet) */
      const packs = parsePacks(body.translations);
      if (Object.keys(packs).length) r.row.guide = withPacks(r.row.guide as { aiModeration?: unknown }, packs);
      const st = await launch(db, params.id, r.row, r.quotas, { replace: body.relaunch === true });
      await db.from("qual_events").insert({ survey_id: params.id, actor: gate.user.userId, actor_label: gate.user.fullName || gate.user.email, action: "ai_interviews.launched", detail: `Launched AI-moderated interviews “${st.title}” (≈ $${r.estimateUsd} AI per interview)`, ids: [st.id] });
      return json({ ...liveView(st, [], runtimeBaseUrl()), warnings: r.warnings, estimateUsd: r.estimateUsd, can: qualAbilities(gate.grant) });
    }
    /* G1: reviewed / edited wording of the study languages, applied to the RUNNING study's snapshot (its guide logic is untouched) */
    if (action === "translations") {
      const packs = parsePacks(body.translations);
      const study = await currentStudy(db, params.id);
      if (!study || study.status === "closed") return json({ error: "there is no open AI interview study" }, 404);
      if (!Object.keys(packs).length) return json({ error: "send translations: { <language>: { texts, words, ui } }" }, 400);
      const upd = await db.from("ai_interview_studies").update({ guide: withPacks(study.guide as { aiModeration?: unknown }, packs) }).eq("survey_id", params.id).eq("id", study.id).select("id");
      if (upd.error) return json({ error: `the wording could not be saved: ${upd.error.message}` }, 500);
      await db.from("qual_events").insert({ survey_id: params.id, actor: gate.user.userId, actor_label: gate.user.fullName || gate.user.email, action: "ai_interviews.translations", detail: `Updated the AI interview wording for ${Object.keys(packs).join(", ")} in “${study.title}”`, ids: [study.id] });
      const fresh = await currentStudy(db, params.id);
      return json({ ...liveView(fresh, fresh ? await sessionsOf(db, fresh.id) : [], runtimeBaseUrl()), can: qualAbilities(gate.grant) });
    }
    if (action === "pause" || action === "resume" || action === "close") {
      const study = await currentStudy(db, params.id);
      if (!study || study.status === "closed") return json({ error: "there is no open AI interview study" }, 404);
      await setStudyStatus(db, params.id, study.id, action === "pause" ? "paused" : action === "resume" ? "live" : "closed");
      await db.from("qual_events").insert({ survey_id: params.id, actor: gate.user.userId, actor_label: gate.user.fullName || gate.user.email, action: `ai_interviews.${action}`, detail: `${action === "pause" ? "Paused" : action === "resume" ? "Resumed" : "Closed"} AI-moderated interviews “${study.title}”`, ids: [study.id] });
      const fresh = await currentStudy(db, params.id);
      return json({ ...liveView(fresh, fresh ? await sessionsOf(db, fresh.id) : [], runtimeBaseUrl()), can: qualAbilities(gate.grant) });
    }
    return json({ error: "action is launch, translations, pause, resume or close" }, 400);
  } catch (e) { return failure(e); }
}
