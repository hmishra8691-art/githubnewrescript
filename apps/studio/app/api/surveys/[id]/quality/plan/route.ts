import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadQualityDefinition } from "@/lib/qualityDef";
import { buildCleaningPlanDocx } from "@rescript/exporters";
import { isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * The Data-Cleaning Plan as a Word document (DOC-04).
 *
 * Written from the settings the quality tools work from — the autosaved
 * draft when there is one, otherwise the current version (`?source=version`
 * forces the version) — so it states the thresholds the engine will apply.
 * Nothing is stored; the same settings always give the same plan, and the
 * stamp carries the time, the survey row's revision and a hash of the
 * definition it was written from.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const source = req.nextUrl.searchParams.get("source") === "version" ? "version" : "draft";
  const loaded = await loadQualityDefinition(db, params.id, source);
  if (!("def" in loaded)) return NextResponse.json({ error: loaded.error }, { status: loaded.status });

  const buf = await buildCleaningPlanDocx(loaded.def, { revision: loaded.revision });
  const stem = `${loaded.def.meta.code}`.replace(/[^A-Za-z0-9._-]+/g, "_");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-disposition": `attachment; filename="${stem}-cleaning-plan.docx"`,
      "cache-control": "no-store",
    },
  });
}
