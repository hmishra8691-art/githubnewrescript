import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireProject } from "@/lib/guard";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { freshUrl, MediaError, PLAYBACK_URL_SECONDS } from "@rescript/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE STABLE URL FOR A STORED OBJECT.
 *
 * `/api/media/<id>` is what a survey definition or an answer keeps for a
 * recording held in Cloudflare R2 — a signed URL there lives fifteen minutes
 * and cannot be baked into a document that lives for years. This route is
 * where the fifteen minutes start: it checks who is asking, mints a signed
 * URL from whichever store holds the object, and REDIRECTS. No bytes pass
 * through here; the browser's `<video>` follows the 302 to storage.
 *
 * ## Who may ask
 *
 * Anybody with `project.read` on the survey the object belongs to — the
 * same gate the survey itself is behind. A respondent's recording is the
 * most sensitive thing a project holds, and reading it is exactly what
 * reading the project's responses means.
 *
 * `?download=1` asks for a `Content-Disposition: attachment` URL, named for
 * the original file.
 */
export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  /* `/api/media/<id>` or `/api/media/<id>/<file name>` — the name is for the browser, the id is what is looked up */
  const id = params.path?.[0] ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || (params.path?.length ?? 0) > 2) {
    return NextResponse.json({ error: "no such recording" }, { status: 404 });
  }
  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;

  /* the row first, for the survey to gate on — but nothing is minted yet */
  const { data: row } = await handle.db.from("media_objects")
    .select("id, survey_id, status").eq("id", id).maybeSingle();
  if (!row) return NextResponse.json({ error: "no such recording" }, { status: 404 });

  const gate = await requireProject(req, row.survey_id as string, "project.read");
  if (isFailure(gate)) return gate.response;

  try {
    const download = req.nextUrl.searchParams.get("download") === "1";
    const { url } = await freshUrl(handle.db, id, { download, seconds: PLAYBACK_URL_SECONDS });
    return NextResponse.redirect(url, {
      status: 302,
      headers: {
        /* the redirect may be reused by this browser for a few minutes; the URL behind it is what expires */
        "cache-control": "private, max-age=300",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  } catch (e) {
    const status = e instanceof MediaError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
