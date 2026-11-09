import { NextRequest, NextResponse } from "next/server";
import { parseDelimited } from "@rescript/engine";
import { parseSpreadsheet } from "@rescript/exporters";
import { WAVE_LIMITS } from "@rescript/analytics";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/tracker/parse { surveyId, fileName, text? | xlsxBase64?, sheet? } → { headers, rows, sheetName?, sheetNames? }
 * (2026-11-09, wave tracker). Reads an uploaded wave — CSV / TSV text or a workbook — into rows with the same readers
 * the response importer uses. Nothing is stored; the Wave tracker panel maps the rows and, on a saved project, keeps
 * them through /api/surveys/[id]/tracker. `analytics.read` on a saved project; the sandbox may parse without a session.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  let body: { surveyId?: unknown; text?: unknown; xlsxBase64?: unknown; sheet?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const surveyId = typeof body.surveyId === "string" ? body.surveyId : "";
  if (surveyId !== "sandbox") {
    if (isFailure(user)) return user.response;
    const ctx = await requireProjectFor(user, surveyId, "analytics.read");
    if (isFailure(ctx)) return ctx.response;
  }
  const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
  try {
    if (typeof body.xlsxBase64 === "string" && body.xlsxBase64) {
      if (body.xlsxBase64.length > 40_000_000) return json({ error: "That workbook is larger than 30 MB — split the wave or save it as CSV." }, 413);
      const p = await parseSpreadsheet(Buffer.from(body.xlsxBase64, "base64"), typeof body.sheet === "string" ? { sheet: body.sheet } : {});
      return json({ headers: p.headers, rows: p.rows.slice(0, WAVE_LIMITS.rows + 2), total: p.rows.length, sheetName: p.sheetName, sheetNames: p.sheetNames });
    }
    if (typeof body.text === "string" && body.text.trim()) {
      const p = parseDelimited(body.text);
      return json({ headers: p.headers, rows: p.rows.slice(0, WAVE_LIMITS.rows + 2), total: p.rows.length });
    }
  } catch (e) {
    return json({ error: `The file could not be read: ${(e as Error).message}` }, 400);
  }
  return json({ error: "send the file as text (CSV, TSV) or xlsxBase64" }, 400);
}
