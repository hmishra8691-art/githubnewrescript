import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { SCRIPT_AUDIT_ACTIONS } from "@rescript/engine";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { dbConfigured } from "@/lib/copilot/durable";
import { recordSandboxDefinition, sandboxScriptAudit, scriptAuditEntry } from "@/lib/scriptAuditLog";

export const dynamic = "force-dynamic";

/**
 * S1c item 3 (audit SE-29) — THE SCRIPT AUDIT LOG, read back for the Versions panel.
 *
 *   GET            the latest 200 `script.*` rows of `audit_logs` for this survey, each with a readable line
 *                  ("Logic script ‘Spend band’ changed by Ana — passed the check"). The rows are written by the draft
 *                  route (`draft/route.ts`, one per changed piece of code). Gate: `requireUser` →
 *                  `requireProjectFor(…, "project.read_activity")` — the same capability as the activity log, which
 *                  lists these rows too.
 *
 * SANDBOX (no database only; 403 elsewhere): `/api/surveys/sandbox/script-audit` — GET reads the in-memory log, POST
 * `{ definition }` records the sandbox editor's definition after an autosave tick (the sandbox writes no draft);
 * `{ definition, baseline: true }` (the editor opening the fixture) sets what later saves are compared with.
 */
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  if (params.id === "sandbox") {
    if (dbConfigured()) return json({ error: "the sandbox exists only without a database" }, 403);
    return json({ ok: true, sandbox: true, entries: sandboxScriptAudit() });
  }
  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, "project.read_activity");
  if (isFailure(gate)) return gate.response;
  const db = supabaseService();
  const { data, error } = await db.from("audit_logs").select("id, action, user_id, detail, created_at")
    .eq("survey_id", params.id).in("action", [...SCRIPT_AUDIT_ACTIONS])
    .order("created_at", { ascending: false }).limit(200);
  if (error) return json({ error: "the audit log could not be read" }, 500);
  const ids = [...new Set((data ?? []).map((r) => r.user_id).filter(Boolean))] as string[];
  const people = new Map<string, string>();
  if (ids.length) {
    const { data: profiles } = await db.from("profiles").select("id, full_name, user_code").in("id", ids);
    for (const p of profiles ?? []) people.set(p.id, p.full_name || p.user_code || "A user");
  }
  const entries = (data ?? []).map((r) => scriptAuditEntry({
    id: r.id, action: r.action, created_at: r.created_at,
    who: r.user_id ? people.get(r.user_id) ?? "A user" : "The system",
    detail: (r.detail as Record<string, unknown> | null) ?? {},
  }));
  return json({ ok: true, entries });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  if (params.id !== "sandbox" || dbConfigured()) return isFailure(authed) ? authed.response : json({ error: "only the database-less sandbox records its script log through this route; a survey's log is written by its draft saves" }, 403);
  const body = await req.json().catch(() => null);
  const parsed = SurveyDefinition.safeParse(body?.definition);
  if (!parsed.success) return json({ error: "definition required" }, 400);
  const added = recordSandboxDefinition(parsed.data, undefined, undefined, body?.baseline === true);
  return json({ ok: true, added: added.length });
}
