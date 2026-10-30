import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { aggregateScriptHealth } from "@rescript/engine";
import { launchSandboxSurvey, sandboxAvailable, sandboxRow, sandboxRowsOf } from "@/lib/sessionSandbox";

export const dynamic = "force-dynamic";

/**
 * THE SANDBOX'S TEST SURVEYS (2026-10-30) — only on a runtime with no database (403 elsewhere).
 *
 *   { action: "launch", definition }  → { token, url: "/n/<token>" }   a test link whose sessions live in memory
 *   { action: "row", sessionId }      → the stored row's position, status and `nav` (what `responses.nav` would
 *                                       hold) — the session id is the credential, as for the save route
 *   { action: "health", token }       → S1c: the script-health summary of that test survey's sessions (engine
 *                                       aggregateScriptHealth) — the 96-bit survey token is the credential
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
    // S1a: the script-write paradata, and what the row holds for those targets (sandbox only: the browser suite checks a script-made value was saved)
    const sw = row.script_writes ?? [];
    const scriptValues = Object.fromEntries(sw.map((w) => [w.target, w.kind === "answer" ? row.answers[w.target] ?? null : w.kind === "embedded" ? row.embedded[w.target] ?? null : w.kind === "calculated" ? row.calculated[w.target] ?? null : row.flags.includes(w.target)]));
    return NextResponse.json({ ok: true, status: row.status, stepIndex: row.step_index, nav: row.nav, lastSavedAt: row.last_saved_at, answers: Object.keys(row.answers).length, saveSeq: row.save_seq, scriptWrites: sw, scriptValues, scriptHealth: row.script_health ?? [] }, noStore);
  }
  if (body.action === "health") {
    const token = String(body.token ?? "");
    if (!/^[0-9a-f]{24}$/.test(token)) return NextResponse.json({ error: "send the test survey's token" }, { status: 400, ...noStore });
    // sessions that saved at least once (a session started and never saved ran no page — and React's dev double mount starts one)
    const rows = sandboxRowsOf(token).filter((r) => r.last_saved_at);
    const summary = aggregateScriptHealth(rows.map((r) => ({ telemetry: { scriptHealth: r.script_health ?? [] }, last_saved_at: r.last_saved_at, started_at: r.started_at })));
    return NextResponse.json({ ok: true, sandbox: true, ...summary }, noStore);
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400, ...noStore });
}
