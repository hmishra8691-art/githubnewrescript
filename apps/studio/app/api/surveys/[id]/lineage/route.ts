import { NextRequest, NextResponse } from "next/server";
import { buildLineage } from "@rescript/analytics";
import { customerDb } from "@/lib/db";
import { isFailure, requireProject } from "@/lib/guard";
import { loadDefinition } from "@/lib/analytics";

export const dynamic = "force-dynamic";

/**
 * GET /api/surveys/{id}/lineage[?question=<code>] — the questionnaire's provenance (audit P3-02): each imported
 * question's source file and source id, the behaviours read from its instructions, and the variables it produces.
 * The data → analysis → table → claim half of the graph is built where a deck or report is made, from the results
 * it uses (`buildLineage` in @rescript/analytics).
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  const loaded = await loadDefinition(customerDb(gate.survey.customer_id) as never, params.id);
  if ("error" in loaded) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const g = buildLineage({ def: loaded.def as never });
  const code = req.nextUrl.searchParams.get("question");
  if (!code) return NextResponse.json(g, { headers: { "cache-control": "no-store" } });
  const q = g.nodes.find((n) => n.kind === "question" && n.detail?.code === code);
  if (!q) return NextResponse.json({ error: `No question ${code}.` }, { status: 404 });
  const near = new Set([q.id, ...g.edges.filter((e) => e.from === q.id || e.to === q.id).flatMap((e) => [e.from, e.to])]);
  for (const e of g.edges) if (near.has(e.to) && e.rel === "contains") near.add(e.from);
  return NextResponse.json({ nodes: g.nodes.filter((n) => near.has(n.id)), edges: g.edges.filter((e) => near.has(e.from) && near.has(e.to)) }, { headers: { "cache-control": "no-store" } });
}
