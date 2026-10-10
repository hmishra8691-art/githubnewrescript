import { NextRequest, NextResponse } from "next/server";
import { readDoc } from "@/lib/docs/pages";

/**
 * A documentation page as markdown (Phase 7): what `llms.txt` links to and
 * what an AI tool or a script fetches. Public: the pages are files shipped
 * with the app; nothing is read from the database and no account is
 * involved. The middleware rewrites `/docs/<slug>.md` here.
 */
export const dynamic = "force-dynamic";
export function GET(_req: NextRequest, { params }: { params: { slug: string } }) {
  const slug = params.slug.replace(/\.md$/, "");
  const md = readDoc(slug);
  if (md === null) return new NextResponse("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new NextResponse(md, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
