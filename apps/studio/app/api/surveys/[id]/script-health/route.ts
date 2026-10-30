import { NextRequest, NextResponse } from "next/server";
import { can } from "@rescript/access";
import { aggregateScriptHealth, type ScriptHealthRow } from "@rescript/engine";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { runtimeBaseUrl } from "@/lib/runtime-url";
import { dbConfigured } from "@/lib/copilot/durable";

export const dynamic = "force-dynamic";

/**
 * S1c (audit D11 / SE-30) — SCRIPT HEALTH: what the survey's code did wrong in the field.
 *
 *   GET ?env=live|test    per script over the environment's responses: failures, sessions affected, last seen,
 *                         top messages, pages, browser classes (engine `aggregateScriptHealth`), plus the number
 *                         of sessions read — the Studio's chips say "no errors in N sessions" / "failed in K of N".
 *
 * The data is `responses.telemetry.scriptHealth`, written by the runtime's save route whatever the survey's
 * telemetry switches say (it describes the survey's code: script, kind, page, first message with answer text
 * removed, count, browser class). Gate: `requireUser` → `requireProjectFor(…, "project.read")`, then
 * `responses.read` (it is read out of the responses), like the assessment results. Not-deleted responses of the
 * environment that saved at least once, any status (a screened-out session ran the code too), the latest 5,000.
 *
 * SANDBOX (no database only; 403 elsewhere): `GET /api/surveys/sandbox/script-health?token=<test survey token>` —
 * the runtime's in-memory test survey (`/api/session/sandbox`, action "health"); the 96-bit token is the credential.
 */
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const MAX_ROWS = 5000;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  if (params.id === "sandbox") {
    if (dbConfigured()) return json({ error: "the sandbox exists only without a database" }, 403);
    const token = req.nextUrl.searchParams.get("token") ?? "";
    if (!/^[0-9a-f]{24}$/.test(token)) return json({ ok: true, sandbox: true, env: "test", sessions: 0, affected: 0, scripts: [] });
    try {
      const r = await fetch(`${runtimeBaseUrl()}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "health", token }), cache: "no-store" });
      const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
      if (!r.ok || !body) return json(body ?? { error: "unavailable" }, r.ok ? 502 : r.status);
      return json({ ok: true, sandbox: true, env: "test", sessions: body.sessions ?? 0, affected: body.affected ?? 0, scripts: body.scripts ?? [] });
    } catch (e) {
      return json({ error: `the respondent runtime could not be reached (${(e as Error).message})` }, 502);
    }
  }
  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  if (!can(gate.grant, "responses.read")) return json({ error: "Your role on this project does not include reading responses, and script health is read out of them." }, 403);
  const isTest = req.nextUrl.searchParams.get("env") === "test";
  const db = supabaseService();
  // only the scriptHealth key of the telemetry jsonb (PostgREST json path), never the behavioural telemetry
  const { data, error } = await db.from("responses").select("last_saved_at, started_at, script_health:telemetry->scriptHealth")
    .eq("survey_id", params.id).eq("is_test", isTest).is("deleted_at", null).not("last_saved_at", "is", null)
    .order("started_at", { ascending: false }).limit(MAX_ROWS);
  if (error) return json({ error: "the responses could not be read" }, 500);
  const rows: ScriptHealthRow[] = ((data ?? []) as { last_saved_at: string | null; started_at: string | null; script_health: unknown }[])
    .map((r) => ({ telemetry: { scriptHealth: r.script_health }, last_saved_at: r.last_saved_at, started_at: r.started_at }));
  const summary = aggregateScriptHealth(rows);
  return json({ ok: true, env: isTest ? "test" : "live", truncated: rows.length >= MAX_ROWS, ...summary });
}
