import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition as SurveyDefinitionSchema, normalizeAsParsed } from "@rescript/schema";
import { approvalSatisfied, dryRunTool, droppedFieldPaths, ensureElementIds, TOOLS, toolByName, toolCallRecord, type ToolApproval, type ToolApprovalGiven, type ToolCallRecord } from "@rescript/engine";
import { customerDb } from "@/lib/db";
import { audit, isFailure, requireEditRight, requireProject } from "@/lib/guard";
import { loadDefinition } from "@/lib/analytics";

export const dynamic = "force-dynamic";

/**
 * THE TOOL REGISTRY, OVER HTTP (audit 2026-11-17, P3-01; the rules: packages/engine/src/toolRegistry.ts).
 *
 *   GET                                                        the tools: name, engine, risk, approval, route, params
 *   POST { tool, input, mode: "dry_run" }                      what it would do, the diff, the approval it needs — nothing written
 *   POST { tool, input, mode: "execute", approval, baseRevision?, agent? }
 *        → a questionnaire tool is dry-run again, checked against the approval given (approval.by is always the
 *          signed-in person; an agent can propose, only a person approves), then saved to the draft under the
 *          revision guard. A route tool answers with its route: it is executed there, by its own guard.
 *
 * Every call — dry run, refusal, execution — is written to the project's audit trail as `tool.called` with its
 * ToolCallRecord (questionnaire input kept; route tools' input only hashed).
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  return NextResponse.json({ tools: TOOLS.map(({ name, engine, summary, risk, approval, reversible, executor, route, capability, params: p }) => ({ name, engine, summary, risk, approval, reversible, executor, route, capability, params: p })) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const tool = toolByName(String(body?.tool ?? ""));
  if (!tool) return NextResponse.json({ error: `Unknown tool. GET this endpoint for the list.` }, { status: 404 });
  const mode = body?.mode === "execute" ? "execute" : "dry_run";
  const caller: ToolCallRecord["caller"] = typeof body?.agent === "string" && body.agent.trim() ? { kind: "agent", userId: gate.user.userId, agent: body.agent.trim().slice(0, 60) } : { kind: "person", userId: gate.user.userId };
  const record = async (r: ToolCallRecord) => {
    await audit({ action: "tool.called", userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId: params.id, customerId: gate.user.customerId, entity: "tool", entityId: null, detail: r as unknown as Record<string, unknown> });
  };

  /* the capability the tool needs, as its own route would check it */
  const cap = await requireProject(req, params.id, tool.capability as never);
  if (isFailure(cap)) { await record(toolCallRecord(tool, "refused", caller, body?.input, { ok: false, description: [], destructive: [], refused: `needs ${tool.capability}` })); return cap.response; }

  if (tool.executor === "route") {
    await record(toolCallRecord(tool, "refused", caller, body?.input, { ok: false, description: [], destructive: [], refused: `executed through ${tool.route!.method} ${tool.route!.path}` }));
    return NextResponse.json({ ok: false, tool: tool.name, route: { method: tool.route!.method, path: tool.route!.path.replace("{id}", params.id) }, approval: tool.approval, note: "This tool runs through its route, under that route's own guard; this call was recorded." }, { status: 409 });
  }

  const db = customerDb(gate.survey.customer_id);
  const loaded = await loadDefinition(db as never, params.id);
  if ("error" in loaded) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const dry = dryRunTool(loaded.def as never, tool.name, body?.input);
  const outcome = { ok: dry.ok, description: dry.description, destructive: dry.destructive, ...(dry.refused ? { refused: dry.refused } : {}), diff: dry.diff };
  const view = { ok: dry.ok, tool: tool.name, approval: dry.approval, description: dry.description, destructive: dry.destructive, warnings: dry.warnings, diff: dry.diff, valid: dry.valid, ...(dry.refused ? { refused: dry.refused } : {}), revision: loaded.revision };

  if (mode === "dry_run" || !dry.ok) {
    await record(toolCallRecord(tool, dry.ok ? "dry_run" : "refused", caller, body?.input, outcome));
    return NextResponse.json({ ...view, mode: "dry_run" }, { status: dry.ok ? 200 : 422 });
  }

  /* execute: the edit lock, then the approval — given by THIS person, never taken from the body's "by" */
  const edit = await requireEditRight(req, params.id, tool.capability as never);
  if (isFailure(edit)) { await record(toolCallRecord(tool, "refused", caller, body?.input, { ...outcome, ok: false, refused: "no edit right / lock" })); return edit.response; }
  const level = body?.approval?.level as ToolApproval | undefined;
  const given: ToolApprovalGiven | null = level === "confirm" || level === "explicit" ? { by: gate.user.userId, level, at: new Date().toISOString(), ...(typeof body.approval.acknowledged === "string" ? { acknowledged: body.approval.acknowledged.slice(0, 500) } : {}) } : null;
  const ok = approvalSatisfied(dry.approval, given);
  if (!ok.ok) { await record(toolCallRecord(tool, "refused", caller, body?.input, { ...outcome, ok: false, refused: ok.reason }, given)); return NextResponse.json({ ...view, ok: false, refused: ok.reason, needs: dry.approval }, { status: 403 }); }

  const parsed = SurveyDefinitionSchema.safeParse(dry.after);
  if (!parsed.success || droppedFieldPaths(normalizeAsParsed(dry.after), parsed.data).length) {
    await record(toolCallRecord(tool, "failed", caller, body?.input, { ...outcome, ok: false, refused: "the result failed the schema check" }, given));
    return NextResponse.json({ ...view, ok: false, refused: "The result failed the schema check; nothing was saved." }, { status: 422 });
  }
  const definition = ensureElementIds(parsed.data).def;
  const baseRevision = typeof body?.baseRevision === "number" ? body.baseRevision : loaded.revision;
  if (baseRevision == null) return NextResponse.json({ error: "This database has no revision guard (migration 0004); tools cannot save safely." }, { status: 501 });
  const { data, error } = await db.rpc("rescript_save_draft", { p_survey_id: params.id, p_definition: definition, p_base_revision: baseRevision, p_base_version_id: loaded.source === "version" ? loaded.versionId ?? null : null, p_title: definition.meta.title });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) {
    await record(toolCallRecord(tool, "failed", caller, body?.input, { ...outcome, ok: false, refused: error ? error.message : "the survey changed since it was read (revision conflict)" }, given));
    return NextResponse.json({ ...view, ok: false, conflict: !error, refused: error ? error.message : "The survey was changed since it was read; nothing was saved. Read it again and retry." }, { status: error ? 500 : 409 });
  }
  await record(toolCallRecord(tool, "executed", caller, body?.input, outcome, given));
  return NextResponse.json({ ...view, mode: "execute", executed: true, revision: Number(row.revision) });
}
