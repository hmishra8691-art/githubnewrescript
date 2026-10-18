import { NextRequest } from "next/server";
import { isFailure, requireProject } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { parseSessionInput } from "@/lib/qual/qualWorkspace";
import { checkRow, json, loadWorkspace, recordEvents, refuse, storeFailure, UUID } from "@/lib/qual/qualStore";

export const dynamic = "force-dynamic";

/**
 * SESSION RECORDS (2026-10-18) — one per interview or focus group: date,
 * moderator, participants and their segments, consent captured (and to
 * recording), notes, observations, status. Data edit (`responses.manage`).
 * Nothing here runs a live session: the record is what happened.
 *
 *   POST   { title, kind, scheduledAt, moderator, participants, consent, notes, observations, status }
 *   PATCH  { id, …any of the above }
 *   DELETE ?id=…   (its transcripts stay, unlinked; its recording row goes with the media sweep)
 *
 * Every answer is the refreshed workspace.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("manage"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "manage");
  if (refused) return refused;
  const body = await req.json().catch(() => null);
  const f = parseSessionInput(body, true);
  if (!f.ok) return json({ error: f.error }, 400);
  try {
    const db = supabaseService();
    const row = checkRow(await db.from("qual_sessions").insert({ survey_id: params.id, ...f.value, created_by: gate.user.userId, updated_by: gate.user.userId }).select("id").single(), "session") as { id: string };
    await recordEvents(db, gate, [{ actor: gate.user.userId, action: "session.created", detail: `Recorded the ${f.value.kind === "focus_group" ? "focus group" : "interview"} “${f.value.title}”${f.value.consent?.captured ? " (consent captured)" : ""}`, ids: [row.id] }]);
    return json({ ok: true, id: row.id, workspace: await loadWorkspace(db, gate) });
  } catch (e) { return storeFailure(e); }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("manage"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "manage");
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const id = String(body?.id ?? "");
  if (!UUID.test(id)) return json({ error: "which session (id)" }, 400);
  const f = parseSessionInput(body, false);
  if (!f.ok) return json({ error: f.error }, 400);
  try {
    const db = supabaseService();
    const rows = checkRow(await db.from("qual_sessions").update({ ...f.value, updated_by: gate.user.userId }).eq("survey_id", params.id).eq("id", id).select("id, title"), "session") as { id: string; title: string }[];
    if (!rows?.length) return json({ error: "no such session" }, 404);
    await recordEvents(db, gate, [{ actor: gate.user.userId, action: "session.updated", detail: `Updated the session “${rows[0].title}” (${Object.keys(f.value).join(", ")})`, ids: [id] }]);
    return json({ ok: true, workspace: await loadWorkspace(db, gate) });
  } catch (e) { return storeFailure(e); }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("manage"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "manage");
  if (refused) return refused;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!UUID.test(id)) return json({ error: "which session (id)" }, 400);
  try {
    const db = supabaseService();
    const rows = checkRow(await db.from("qual_sessions").delete().eq("survey_id", params.id).eq("id", id).select("id, title"), "session") as { id: string; title: string }[];
    if (!rows?.length) return json({ error: "no such session" }, 404);
    await recordEvents(db, gate, [{ actor: gate.user.userId, action: "session.deleted", detail: `Deleted the session record “${rows[0].title}” (its transcripts are kept)`, ids: [id] }]);
    return json({ ok: true, workspace: await loadWorkspace(db, gate) });
  } catch (e) { return storeFailure(e); }
}
