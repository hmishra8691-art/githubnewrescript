import { NextRequest, NextResponse } from "next/server";
import { llmsIndex } from "@/lib/docs/pages";

/** llms.txt — the index of the public documentation for AI tools (Phase 7). Public; no data read. */
export const dynamic = "force-dynamic";
export function GET(req: NextRequest) {
  const base = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
  return new NextResponse(llmsIndex(base), { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
