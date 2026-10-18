import { NextRequest, NextResponse } from "next/server";
import { can, type Capability } from "@rescript/access";
import { isFailure, requireProject } from "@/lib/guard";
import { artifactLink } from "@/lib/artifacts/service";
import { artifactDeps } from "@/lib/artifacts/server";

export const dynamic = "force-dynamic";

/**
 * ONE KEPT DOCUMENT, DOWNLOADED (2026-10-18).
 *
 *   GET → { url, expiresAt, name, size, version, mime, artifact }
 *   GET ?redirect=1 → 302 to the signed URL
 *
 * The caller must be a member of THIS project (an id from another project is
 * unknown here — 404), see the artifact (a private one is its owner's — 403)
 * and hold the capability for its type (a findings report or deck needs
 * `analytics.export` — 403). The stored file is checked again (size, SHA-256,
 * the Word / PowerPoint package): missing → 410, damaged → 422, each with what
 * to do. Then a signed URL is minted for two minutes and returned — never
 * stored; when it expires the page simply asks again. Nothing is generated.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string; artifactId: string } }) {
  const ctx = await requireProject(req, params.id, "project.read");
  if (isFailure(ctx)) return ctx.response;
  const r = await artifactLink(artifactDeps(), { surveyId: params.id, artifactId: params.artifactId, userId: ctx.user.userId, can: (c) => can(ctx.grant, c as Capability) });
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status, headers: { "cache-control": "no-store" } });
  if (req.nextUrl.searchParams.get("redirect") === "1") return NextResponse.redirect(r.link.url, { status: 302, headers: { "cache-control": "no-store" } });
  return NextResponse.json({ ...r.link, artifact: r.view }, { headers: { "cache-control": "no-store" } });
}
