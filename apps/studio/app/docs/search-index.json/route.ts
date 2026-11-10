import { NextResponse } from "next/server";
import { searchIndex } from "@/lib/docs/pages";

export const dynamic = "force-dynamic";

/** the Developer Docs search index (2026-11-09): titles, summaries, headings and text of the public pages. Public; no data read. */
export function GET() {
  return NextResponse.json({ pages: searchIndex() }, { headers: { "cache-control": "public, max-age=600" } });
}
