import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/guard";
import { surveyQrSvg, surveyQrPng } from "@rescript/exporters";
import { surveyBaseUrl } from "@/lib/runtime-url";

export const dynamic = "force-dynamic";

/**
 * THE SURVEY LINK AS A QR CODE (§24).
 *
 *   GET ?environment=LIVE&format=svg|png&download=1
 *
 * For every distribution route where the link cannot be clicked: a poster in
 * a waiting room, a card at a till, a slide at the end of a session, a
 * receipt. It encodes the DEPLOYMENT's link — an open one, with no token,
 * because a QR code shown to a room is by definition not personal.
 *
 * The code is generated from the deployment row rather than the draft
 * definition, for the same reason the links export is: a printed QR code
 * built from an unpublished slug is unfixable once it is on paper.
 *
 * SVG is the default and is what the panel shows. The failure mode of a
 * printed QR code is almost always resolution — a raster image sized for a
 * screen is unscannable at poster size, and nobody finds out until the
 * posters exist — and vector has no size to get wrong.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;

  const sp = req.nextUrl.searchParams;
  const isTest = (sp.get("environment") ?? "LIVE").toUpperCase() === "TEST";
  const format = sp.get("format") === "png" ? "png" : "svg";

  const db = supabaseAdmin();
  const { data: dep } = await db
    .from("deployments")
    .select("client_slug, study_slug")
    .eq("survey_id", params.id)
    .eq("mode", isTest ? "test" : "live")
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!dep) {
    return NextResponse.json({
      error: `This survey has no active ${isTest ? "test" : "live"} deployment yet, so there is no link to encode.`,
    }, { status: 409 });
  }

  let customDomain: string | undefined;
  const { data: cur } = await db.from("surveys").select("current_version_id, code").eq("id", params.id).maybeSingle();
  if (cur?.current_version_id) {
    const { data: ver } = await db.from("survey_versions").select("definition").eq("id", cur.current_version_id).maybeSingle();
    const d = (ver?.definition as { deployment?: { customDomain?: string } } | null)?.deployment?.customDomain;
    if (typeof d === "string" && d.trim()) customDomain = d;
  }

  const url = `${surveyBaseUrl(customDomain)}/${isTest ? "t" : "s"}/${dep.client_slug}/${dep.study_slug}`;
  const download = sp.get("download") === "1";
  const stem = `${cur?.code ?? "survey"}_${isTest ? "test" : "live"}_qr`;

  if (format === "png") {
    const buf = await surveyQrPng(url, { width: Math.min(2048, Math.max(128, Number(sp.get("width") ?? 512))) });
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "content-type": "image/png",
        ...(download ? { "content-disposition": `attachment; filename="${stem}.png"` } : {}),
        "cache-control": "no-store",
      },
    });
  }

  const svg = await surveyQrSvg(url);
  return new NextResponse(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      ...(download ? { "content-disposition": `attachment; filename="${stem}.svg"` } : {}),
      "cache-control": "no-store",
      /* the encoded link, so a caller can show what the code actually goes to */
      "x-rescript-url": url,
    },
  });
}
