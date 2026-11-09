import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireUser } from "@/lib/guard";
import { dbConfigured } from "@/lib/copilot/durable";
import { helpKnowledge } from "@/lib/help/kb";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/help/article?id=… — one Help guide (or generated article) in full, for reading beside the conversation
 * (2026-11-09). The documentation pages are public at /docs; guides are the same kind of material, served to signed-in
 * users (anyone in the local sandbox).
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user) && dbConfigured()) return user.response;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^[a-z0-9-]{1,80}$/.test(id)) return NextResponse.json({ error: "id" }, { status: 400 });
  const a = helpKnowledge().articles.get(id);
  if (!a) return NextResponse.json({ error: "No such guide." }, { status: 404 });
  const md = [`# ${a.title}`, ...a.sections.map((s) => (s.heading === "Overview" ? s.body : `## ${s.heading}\n\n${s.body}`))].join("\n\n");
  return NextResponse.json({ ok: true, id: a.id, title: a.title, category: a.category, kind: a.kind, related: a.related, markdown: md }, { headers: { "cache-control": "no-store" } });
}
