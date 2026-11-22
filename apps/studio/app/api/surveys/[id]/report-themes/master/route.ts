import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_THEME } from "@rescript/analytics";
import { masterTheme, readClientMaster } from "@rescript/analytics/export";
import { audit, isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * A CLIENT'S POWERPOINT MASTER AS A DECK THEME (Level 5 roadmap R4).
 *
 *   POST multipart { file: .pptx / .potx (≤ 20 MB), name?, scope?: "survey" | "workspace", save?: "false" }
 *     → { theme, notes, saved?: { id } }
 *
 * Read on our server with no model (packages/analytics/src/export/clientTemplate.ts): the slide size, the theme's
 * colours and fonts and its theme part, the master's background and pictures with their positions, and where its
 * title sits. Saved as an analytics theme (workspace-wide by default) — every deck exported with that theme is built
 * on the client's master with native, editable charts in the client's accent colours. `notes` says what was not
 * carried over. Who may call: Data Analytics & Reports: Edit.
 */
const MAX_FILE = 20 * 1024 * 1024;
const MAX_STORED = 4 * 1024 * 1024;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "analytics.edit");
  if (isFailure(gate)) return gate.response;
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Send the PowerPoint template as a file." }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) return NextResponse.json({ error: "Send the PowerPoint template as a file." }, { status: 400 });
  if (file.size > MAX_FILE) return NextResponse.json({ error: `That file is ${(file.size / 1048576).toFixed(1)} MB — the limit is 20 MB. Save the template without its example slides.` }, { status: 413 });
  const fileName = (file as File).name || "template.pptx";
  const { master, problems } = readClientMaster(new Uint8Array(await file.arrayBuffer()), fileName);
  if (!master) return NextResponse.json({ error: problems.join(" ") }, { status: 422 });
  const name = (typeof form.get("name") === "string" && String(form.get("name")).trim()) || master.name || "Client master";
  const theme = masterTheme({ ...master, name }, DEFAULT_THEME);
  const stored = Buffer.byteLength(JSON.stringify(theme));
  if (stored > MAX_STORED) return NextResponse.json({ error: `The master's pictures come to ${(stored / 1048576).toFixed(1)} MB; a deck theme keeps at most 4 MB. Save smaller pictures in the master (a compressed background, a PNG logo) and upload it again.`, notes: master.notes }, { status: 413 });
  if (form.get("save") === "false") return NextResponse.json({ theme, notes: master.notes });

  const workspace = form.get("scope") !== "survey" && !!gate.user.customerId;
  const { data, error } = await gate.db.from("analytics_themes").insert({
    survey_id: workspace ? null : params.id, customer_id: workspace ? gate.user.customerId : null,
    name, theme, is_default: false, created_by: gate.user.userId, updated_by: gate.user.userId,
  }).select("id").single();
  if (error) return NextResponse.json({ error: error.message, theme, notes: master.notes }, { status: 500 });
  void audit({ action: "analytics.theme_imported", userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId: params.id, customerId: gate.user.customerId, entity: "analytics", entityId: String((data as { id: string }).id), detail: { name, file: fileName.slice(0, 120), pictures: master.pictures.length, scope: workspace ? "workspace" : "survey" } });
  return NextResponse.json({ theme: { ...theme, master: { ...theme.master!, themeXml: undefined, pictures: theme.master!.pictures.map((p) => ({ ...p, dataUri: `${p.dataUri.slice(0, 40)}…` })), background: { ...theme.master!.background, image: theme.master!.background.image ? "(picture)" : undefined } } }, notes: master.notes, saved: { id: (data as { id: string }).id, scope: workspace ? "workspace" : "survey" } }, { status: 201 });
}
