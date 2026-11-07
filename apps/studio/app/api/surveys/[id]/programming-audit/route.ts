import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { programmingAuditRows } from "@rescript/engine";
import { programmingAuditXlsx } from "@rescript/exporters";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { dbConfigured } from "@/lib/copilot/durable";

export const dynamic = "force-dynamic";

/**
 * THE PROGRAMMING AUDIT LOG, AS EXCEL (roadmap 3.6, tracker 3.1).
 *
 *   POST { definition } → programming-audit.xlsx
 *
 * The definition is the one in the caller's editor (unsaved edits included), checked by the engine's own checks
 * (`programmingAuditRows`) and written as a QA sheet. Reading a project is enough: nothing is stored or changed.
 * The sandbox (no database) is allowed without a session, like its other read-only tools.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  if (params.id === "sandbox") {
    if (dbConfigured()) return NextResponse.json({ error: "the sandbox exists only without a database" }, { status: 403 });
  } else {
    if (isFailure(authed)) return authed.response;
    const gate = await requireProjectFor(authed, params.id, "project.read");
    if (isFailure(gate)) return gate.response;
  }
  const body = (await req.json().catch(() => null)) as { definition?: unknown } | null;
  const parsed = SurveyDefinition.safeParse(body?.definition);
  if (!parsed.success) return NextResponse.json({ error: "That is not a survey definition." }, { status: 400 });
  const def = parsed.data;
  const rows = programmingAuditRows(def);
  const buf = await programmingAuditXlsx(rows, { surveyTitle: def.meta.title, surveyCode: def.meta.code, version: def.meta.version });
  const name = `${(def.meta.code || "survey").replace(/[^\w.-]+/g, "_")}-programming-audit.xlsx`;
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
      "x-audit-findings": String(rows.length),
    },
  });
}
