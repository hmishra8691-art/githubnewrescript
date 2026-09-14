import "server-only";
import { NextResponse } from "next/server";
import { mediaDb } from "@/lib/mediaRoute";
import { readObject, buildZip } from "@rescript/media";
import {
  deliveryForToken,
  linkUsable,
  recordDownload,
  packageFileName,
  hoursRemaining,
  RETENTION_HOURS,
  type DeliveryFile,
} from "@rescript/media/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * THE DOWNLOAD LINK.
 *
 * Outside `/api` on purpose: this is a URL a person pastes into a browser
 * from an email, not an endpoint an application calls, and it should look
 * like one — `/d/<id>?k=<token>`.
 *
 * ## What the token is, and what it is not
 *
 * It is a bearer credential, and the honest description of the security model
 * is: whoever holds the link can download the recordings until it expires.
 * That is inherent to emailing a link, not a shortcut — the alternative is
 * making the researcher hold a Rescript account and sign in, which is a
 * different product decision and not the one the brief asked for.
 *
 * What narrows it:
 *
 *   · 32 random bytes, so it cannot be found by trying;
 *   · stored only as a SHA-256, so a database leak yields no working links;
 *   · dead after 48 hours, checked against the CLOCK rather than against a
 *     status column, so a sweep that has not run yet does not extend it;
 *   · destroyed at expiry rather than merely marked;
 *   · never indexed, never logged with the query string, and refused to
 *     crawlers by `X-Robots-Tag`.
 *
 * ## Why the ZIP is built here and not stored
 *
 * A pre-built archive is a second copy of the most sensitive bytes in the
 * system, with its own lifetime and its own way of being orphaned — and it
 * would have to be deleted by the same sweep that deletes the media, which is
 * one more thing that can half-fail. Building it per request means there is
 * exactly one copy of a recording, and when that copy is deleted, nothing
 * survives it.
 */

const GONE = (reason: string, hint: string) =>
  new NextResponse(page(reason, hint), {
    status: 410,
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow" },
  });

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = new URL(req.url).searchParams.get("k") ?? "";

  if (!token || !id) {
    return GONE("This link is incomplete", "Use the full link from the delivery email, including everything after the question mark.");
  }

  let db;
  try {
    db = mediaDb();
  } catch {
    return NextResponse.json({ error: "this deployment has no database configured" }, { status: 501 });
  }

  const row = await deliveryForToken(db, token);
  /*
   * A wrong token and an expired one give the same answer. Distinguishing
   * them tells someone guessing which of their guesses was closer, and tells
   * a person with an old link nothing they can act on differently.
   */
  if (!row || row.id !== id) {
    return GONE("This link is not valid", `Media links work for ${RETENTION_HOURS} hours and then stop. Ask the project owner to re-send the delivery if you still need the files.`);
  }

  const usable = linkUsable(row, new Date());
  if (!usable.ok) {
    return usable.reason === "not_ready"
      ? GONE("This delivery is not ready yet", "The recordings are still being packaged. Try the link again in a few minutes.")
      : GONE(
        "These files have been deleted",
        `Original recordings are kept for ${RETENTION_HOURS} hours and then deleted automatically. The transcript and the rest of the response are still in Rescript Studio.`,
      );
  }

  const manifest = (row.manifest ?? []) as DeliveryFile[];
  if (!manifest.length) {
    return GONE("There is nothing in this delivery", "No media was recorded against this response.");
  }

  /* Read every object, then build. Each is capped at 25 MB by MEDIA_KINDS and
     a delivery is one respondent's sitting, so this is bounded by the same
     limits that bound the recorder. */
  const entries: { name: string; bytes: Uint8Array }[] = [];
  const missing: string[] = [];
  for (const f of manifest) {
    try {
      entries.push({ name: f.fileName, bytes: await readObject(db, f.bucket, f.path) });
    } catch {
      missing.push(f.fileName);
    }
  }

  if (!entries.length) {
    return GONE("These files are no longer in storage", `Recordings are deleted ${RETENTION_HOURS} hours after delivery.`);
  }

  /*
   * A partial archive is still worth sending — four of five recordings beats
   * none — but the researcher has to be told, and a note inside the ZIP is
   * the one place they cannot miss it.
   */
  if (missing.length) {
    entries.push({
      name: "MISSING_FILES.txt",
      bytes: new TextEncoder().encode(
        ["Some recordings in this delivery could not be read from storage:", "", ...missing.map((m) => `  ${m}`), "",
          "The rest of the package is complete. The transcripts for every response remain in Rescript Studio."].join("\n"),
      ),
    });
  }

  const zip = buildZip(entries);
  void recordDownload(db, row.id);

  /* the archive is named for the project and the respondent, and the project
     name lives on the first manifest entry's own path — built by
     `packagePath`, so the two can never disagree about spelling */
  const projectFolder = (manifest[0]?.fileName ?? "").split("/")[0] || "Project";
  const filename = packageFileName(projectFolder, row.respondent_label ?? "media");
  const left = row.expires_at ? hoursRemaining(new Date(row.expires_at), new Date()) : 0;

  return new NextResponse(zip as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-length": String(zip.length),
      "content-disposition": `attachment; filename="${filename}"`,
      /* a download this short-lived must never sit in a shared cache */
      "cache-control": "private, no-store, max-age=0",
      "x-robots-tag": "noindex, nofollow",
      "x-rescript-expires-in-hours": String(left),
    },
  });
}

/** The page somebody sees when the link has stopped working. No styling framework, no JS. */
function page(title: string, hint: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title></head>
<body style="font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#131a2b;background:#f7f8fb;margin:0;padding:48px 20px">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e6e8ef;border-radius:14px;padding:28px">
<h1 style="margin:0 0 10px;font-size:20px;letter-spacing:-0.01em">${esc(title)}</h1>
<p style="margin:0;color:#5f6b7d">${esc(hint)}</p>
</div></body></html>`;
}
