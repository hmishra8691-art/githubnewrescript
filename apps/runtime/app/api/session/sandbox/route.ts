import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { launchSandboxSurvey, sandboxAvailable, sandboxRow } from "@/lib/sessionSandbox";

export const dynamic = "force-dynamic";

/**
 * THE SANDBOX'S TEST SURVEYS (2026-10-30) — only on a runtime with no database (403 elsewhere).
 *
 *   { action: "launch", definition }  → { token, url: "/n/<token>" }   a test link whose sessions live in memory
 *   { action: "row", sessionId }      → the stored row's position, status and `nav` (what `responses.nav` would
 *                                       hold) — the session id is the credential, as for the save route
 */
export async function POST(req: NextRequest) {
  const noStore = { headers: { "cache-control": "no-store" } };
  if (!sandboxAvailable()) return NextResponse.json({ error: "the session sandbox exists only on a runtime with no database" }, { status: 403, ...noStore });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.action === "launch") {
    const parsed = SurveyDefinition.safeParse(body.definition);
    if (!parsed.success) return NextResponse.json({ error: "send the survey definition" }, { status: 400, ...noStore });
    const s = launchSandboxSurvey(parsed.data);
    return NextResponse.json({ ok: true, token: s.token, url: `/n/${s.token}` }, noStore);
  }
  if (body.action === "row") {
    const row = sandboxRow(String(body.sessionId ?? ""));
    if (!row) return NextResponse.json({ error: "unknown session" }, { status: 404, ...noStore });
    return NextResponse.json({ ok: true, status: row.status, stepIndex: row.step_index, nav: row.nav, lastSavedAt: row.last_saved_at, answers: Object.keys(row.answers).length }, noStore);
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400, ...noStore });
}
