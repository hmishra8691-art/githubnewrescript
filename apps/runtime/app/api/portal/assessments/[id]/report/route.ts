import { NextRequest, NextResponse } from "next/server";
import { portalRoute, signedIn } from "@/lib/portal/http";
import { portalReportPdf, reportFileName } from "@/lib/portal/report";
import { PortalError, personalReport } from "@/lib/portal/service";

export const dynamic = "force-dynamic";

/**
 * THE PERSONAL REPORT AS A PDF FILE (phase 2, 2026-11-20). `id` is the enrolment; one that is not the signed-in
 * person's is "not found". The file holds what the results page shows that person and nothing more
 * (lib/portal/service.ts `personalReport`), is made on request and is never stored.
 *
 *   GET → application/pdf (a download)
 *       → 404 when there is nothing the person may see yet
 *       → 422 `pdf_unavailable` when the report has text the file cannot carry (a non-Western script): the page
 *         then points to "Print → Save as PDF", which handles every script
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return portalRoute(req, {}, async (deps) => {
    const report = await personalReport(deps, await signedIn(req, deps), params.id);
    const pdf = portalReportPdf(report);
    if (!pdf) throw new PortalError(422, "pdf_unavailable", "This report has text that the PDF file cannot show. Use Print and choose “Save as PDF” instead.");
    return new NextResponse(Buffer.from(pdf), { status: 200, headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${reportFileName(report.title)}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  });
}
