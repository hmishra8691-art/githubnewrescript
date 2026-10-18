import { NextRequest, NextResponse } from "next/server";
import { aiProviderName } from "@rescript/ai";
import { SurveyDefinition } from "@rescript/schema";
import { agreement, redactText, type QualHistoryEntry, type QualSegment, type QualState } from "@rescript/analytics";
import { buildQualGuideDocx, buildQualReportDocx, checkDocx, type QualSourceInfo } from "@rescript/analytics/export";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { loadDefinition } from "@/lib/analytics";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { allSegments, readSettings, toWorkspace, type QualWorkspace } from "@/lib/qual/qualWorkspace";
import { hasPii, json, loadRows, recordEvents, refuse, storeFailure } from "@/lib/qual/qualStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE QUALITATIVE WORD DOCUMENTS (2026-10-18) — through the existing exporter's
 * qualitative editions (`buildQualGuideDocx`, `buildQualReportDocx`, the same
 * kit and the same package check as the proposal and the SAP).
 *
 *   POST { type: "guide" }                       the interview / discussion guide — project read
 *   POST { type: "report", interpretation?, compare?: { a, b } }
 *                                                the qualitative report — Data view + report downloads;
 *                                                redacted for a member without contact details
 *
 * The sandbox, against the FAKE provider only, sends its definition (and, for the report, its
 * state, segments and sources) and gets the same document — nothing is read or stored.
 */
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "study";

function file(buf: Buffer, name: string, what: string): NextResponse {
  const c = checkDocx(buf);
  if (!c.ok) return json({ error: `The document was produced but failed its check, so it is not offered: ${c.problems.slice(0, 3).join("; ")}.`, code: "invalid_document" }, 500);
  return new NextResponse(new Uint8Array(buf), { status: 200, headers: { "content-type": DOCX, "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store", "x-rescript-output": what.replace(/[^\x20-\x7e]/g, "?").slice(0, 300), "x-rescript-checked": `docx ok; ${c.paragraphs} paragraphs, ${c.tables} tables` } });
}

const sourcesOf = (ws: Pick<QualWorkspace, "transcripts" | "sessions">): QualSourceInfo[] => ws.transcripts.map((t) => ({ id: t.id, title: t.title, kind: t.source === "open_ends" ? "open_ends" : "transcript", segments: t.segments.length, ...(ws.sessions.find((s) => s.id === t.sessionId)?.scheduledAt ? { date: ws.sessions.find((s) => s.id === t.sessionId)!.scheduledAt!.slice(0, 10) } : {}) }));

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return isFailure(authed) ? authed.response : json({ error: "expected a JSON body" }, 400);
  const type = body.type === "report" ? "report" : body.type === "guide" ? "guide" : null;
  if (!type) return json({ error: "type is guide or report" }, 400);
  const date = new Date().toISOString().slice(0, 10);
  const interpretation = typeof body.interpretation === "string" ? body.interpretation.slice(0, 20_000) : undefined;
  const pair = body.compare && typeof body.compare === "object" ? body.compare as { a?: unknown; b?: unknown } : null;

  if (params.id === "sandbox") {
    if (aiProviderName() !== "fake") return isFailure(authed) ? authed.response : json({ error: "the sandbox exports only against the fake provider" }, 403);
    const parsed = SurveyDefinition.safeParse(body.definition);
    if (!parsed.success) return json({ error: "send the survey as it is open in the editor (definition)" }, 400);
    const def = parsed.data;
    try {
      if (type === "guide") return file(await buildQualGuideDocx(def, { date }), `${safe(String(def.meta.code ?? def.meta.title))}_${def.qualStudy?.kind === "focus_group" ? "Discussion" : "Interview"}_Guide_${date}.docx`, "Qualitative guide");
      const state = body.state as QualState;
      const segments = (Array.isArray(body.segments) ? body.segments : []) as QualSegment[];
      if (!state?.codebook) return json({ error: "send the sandbox's coding state" }, 400);
      const sources = (Array.isArray(body.sources) ? body.sources : []) as QualSourceInfo[];
      const history = (Array.isArray(body.history) ? body.history : []) as QualHistoryEntry[];
      const agr = pair && typeof pair.a === "string" && typeof pair.b === "string" ? agreement(state, pair.a, pair.b) : null;
      return file(await buildQualReportDocx(def, { state, segments, sources, history, agreement: agr, interpretation, date, coderName: (id) => (id === "ai" ? "AI (suggested)" : id) }), `${safe(String(def.meta.code ?? def.meta.title))}_Qualitative_Report_${date}.docx`, "Qualitative report");
    } catch (e) { return json({ error: (e as Error).message }, 400); }
  }

  if (isFailure(authed)) return authed.response;
  const op = type === "guide" ? "guide" : "report";
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability(op));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, op);
  if (refused) return refused;
  const db = supabaseService();
  try {
    const loaded = await loadDefinition(db, params.id);
    if ("error" in loaded) return json({ error: loaded.error }, loaded.status);
    const def = loaded.def as SurveyDefinition;
    const code = safe(String(def.meta.code ?? def.meta.title));
    if (type === "guide") {
      if (!def.qualStudy) return json({ error: "This survey has no interview or focus-group guide yet — ask Intelligent Mode to create one." }, 409);
      return file(await buildQualGuideDocx(def, { date, author: gate.user.email }), `${code}_${def.qualStudy.kind === "focus_group" ? "Discussion" : "Interview"}_Guide_${date}.docx`, `Qualitative guide: ${def.qualStudy.sections.length} sections`);
    }
    const rows = await loadRows(db, params.id);
    const full = toWorkspace(rows, { pii: true });
    const pii = hasPii(gate);
    const names = readSettings(rows.coding?.settings).redactNames;
    const agr = pair && typeof pair.a === "string" && typeof pair.b === "string" ? agreement(full.state, pair.a, pair.b) : null;
    /* coders are user ids; the history knows their names */
    const who = new Map(rows.events.filter((e) => e.actor && e.actor_label).map((e) => [e.actor!, e.actor_label!]));
    const buf = await buildQualReportDocx(def, {
      state: full.state, segments: allSegments(full), sources: sourcesOf(full), history: full.history, agreement: agr, interpretation, date, author: gate.user.email,
      coderName: (id) => (id === "ai" ? "AI (suggested)" : who.get(id) ?? (full.history.some((h) => h.actor === id) ? id : "a reviewer")),
      ...(pii ? {} : { redact: (t: string) => redactText(t, { names }).text }),
    });
    await recordEvents(db, gate, [{ actor: gate.user.userId, action: "report.exported", detail: `Downloaded the qualitative report${pii ? "" : " (redacted)"}`, ids: [] }]);
    return file(buf, `${code}_Qualitative_Report_${date}.docx`, `Qualitative report: ${full.state.codebook.codes.length} codes, ${full.state.excerpts.length} excerpts`);
  } catch (e) { return storeFailure(e); }
}
