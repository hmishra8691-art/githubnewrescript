import { NextResponse } from "next/server";
import { llmsFull } from "@/lib/docs/pages";

/** llms-full.txt — every documentation page in one file (Phase 7). Public; no data read. */
export const dynamic = "force-dynamic";
export function GET() {
  return new NextResponse(llmsFull(), { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
