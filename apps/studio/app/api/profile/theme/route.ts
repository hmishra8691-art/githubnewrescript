import { NextRequest, NextResponse } from "next/server";
import { supabaseService } from "@/lib/authServer";
import { isFailure, requireUser } from "@/lib/guard";
import { isStudioTheme } from "@/lib/theme/themes";

export const dynamic = "force-dynamic";

/**
 * THE SIGNED-IN PERSON'S STUDIO THEME (2026-11-11) — `profiles.ui_theme` (migration 0096).
 *
 * GET   { theme, stored }   `stored: false` when the column is not there yet (the migration has not been applied):
 *                           the browser then keeps its own memory, and nothing is lost when the column arrives.
 * PATCH { theme }           one of the Studio's theme ids; anything else is refused. Only the caller's own row.
 *
 * A personal appearance setting: it changes no survey, no project and nothing anybody else sees.
 */
const NO_STORE = { headers: { "cache-control": "no-store" } };

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  const { data, error } = await supabaseService().from("profiles").select("ui_theme").eq("id", user.userId).maybeSingle();
  if (error) return NextResponse.json({ theme: null, stored: false }, NO_STORE);
  const t = (data as { ui_theme?: unknown } | null)?.ui_theme;
  return NextResponse.json({ theme: isStudioTheme(t) ? t : null, stored: true }, NO_STORE);
}

export async function PATCH(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  let body: { theme?: unknown } | null = null;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!isStudioTheme(body?.theme)) return NextResponse.json({ error: "That is not one of the Studio's themes." }, { status: 400 });
  const { error } = await supabaseService().from("profiles").update({ ui_theme: body!.theme }).eq("id", user.userId);
  return NextResponse.json({ theme: body!.theme, stored: !error }, NO_STORE);
}
