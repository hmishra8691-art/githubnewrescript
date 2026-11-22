import { NextRequest, NextResponse } from "next/server";
import { fromSource, sourceDiff, toSource } from "@rescript/engine";
import { customerDb } from "@/lib/db";
import { isFailure, requireProject } from "@/lib/guard";
import { loadDefinition } from "@/lib/analytics";

export const dynamic = "force-dynamic";

/**
 * THE SURVEY AS SOURCE (Level 5 roadmap P3; the format: packages/engine/src/surveySource.ts).
 *
 *   GET                       the draft as source text (text/plain), to read, keep beside the project, or diff
 *   POST { source }           an edited source read back: the problems by line, or the line diff against the draft.
 *                             Nothing is written — a change goes in through the editor or the tools route, under the
 *                             same checks and approvals as any other.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  const loaded = await loadDefinition(customerDb(gate.survey.customer_id) as never, params.id);
  if ("error" in loaded) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  return new NextResponse(toSource(loaded.def as never), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  let body: { source?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (typeof body?.source !== "string" || body.source.length > 5_000_000) return NextResponse.json({ error: "Send { source } as text (at most 5 MB)." }, { status: 400 });
  const loaded = await loadDefinition(customerDb(gate.survey.customer_id) as never, params.id);
  if ("error" in loaded) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const read = fromSource(body.source);
  if (!read.def) return NextResponse.json({ ok: false, problems: read.problems }, { status: 422 });
  return NextResponse.json({ ok: true, diff: sourceDiff(toSource(loaded.def as never), toSource(read.def)), changed: JSON.stringify(read.def) !== JSON.stringify(loaded.def) });
}
