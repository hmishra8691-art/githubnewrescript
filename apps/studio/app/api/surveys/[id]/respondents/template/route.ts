import { NextRequest, NextResponse } from "next/server";
import { respondentTemplateCsv, respondentTemplateXlsx } from "@rescript/exporters";
import { isFailure, requireProject } from "@/lib/guard";
import { peopleSandboxAllowed } from "@/lib/respondentIntake";

export const dynamic = "force-dynamic";

/**
 * THE IMPORT TEMPLATE FOR A RESPONDENT LIST (2026-11-21).
 *
 *   GET ?format=xlsx | csv   a file with the three headings (name, email, id), one example row, and — in the
 *                            workbook — a second sheet that explains each column. Filled in and uploaded, it goes
 *                            through the same check as any other file; the example row is recognised and left out.
 *
 * It contains nothing about the survey or anybody on its list, so reading the project is enough to download it.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!peopleSandboxAllowed(params.id)) {
    const gate = await requireProject(req, params.id, "project.read");
    if (isFailure(gate)) return gate.response;
  }
  const csv = req.nextUrl.searchParams.get("format") === "csv";
  const extra = ["department"];
  const body = csv ? Buffer.from(respondentTemplateCsv(extra), "utf8") : Buffer.from(await respondentTemplateXlsx(extra));
  return new NextResponse(body, { status: 200, headers: {
    "content-type": csv ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "content-disposition": `attachment; filename="respondent-list-template.${csv ? "csv" : "xlsx"}"`,
    "cache-control": "no-store",
  } });
}
