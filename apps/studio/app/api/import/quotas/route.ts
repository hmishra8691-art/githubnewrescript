import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { aiProviderName } from "@rescript/ai";
import { detectFormat, readSheets, readQuotaSheet, quotaSheetActions } from "@rescript/import";
import { coerceSurveyActions } from "@rescript/engine";
import { isFailure, requireUser } from "@/lib/guard";

/**
 * A QUOTA SHEET (research-intelligence Phase 4): the Excel or CSV a client
 * sends with the sample targets, read against the survey as it is open in
 * the editor into create_quota actions — one proposal the researcher
 * reviews in Changes, never written here. No model call: the reader and the
 * mapper are deterministic, and what they cannot match is reported by row.
 *
 *   POST multipart: file, surveyId, definition (JSON), mode?, onFull?
 *   → { ok, sheet: { quotas: [{ name, layout, cells, total }], confidence },
 *       actions, rejected, issues, matched }
 */
const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  let form: FormData;
  try { form = await req.formData(); } catch { return isFailure(authed) ? authed.response : NextResponse.json({ error: "expected a multipart form with a file" }, { status: 400 }); }
  const surveyId = typeof form.get("surveyId") === "string" ? String(form.get("surveyId")) : "";
  if (isFailure(authed) && !(surveyId === "sandbox" && aiProviderName() === "fake")) return authed.response;

  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) return NextResponse.json({ error: "the file is empty" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: `the file is ${(file.size / 1048576).toFixed(1)} MB — the limit is ${MAX_BYTES / 1048576} MB` }, { status: 413 });
  const fileName = (file as File).name || "quotas";
  let def: SurveyDefinition;
  try {
    const parsed = SurveyDefinition.safeParse(JSON.parse(String(form.get("definition") ?? "")));
    if (!parsed.success) return NextResponse.json({ error: "send the survey as it is open in the editor (definition)" }, { status: 400 });
    def = parsed.data;
  } catch { return NextResponse.json({ error: "send the survey as it is open in the editor (definition)" }, { status: 400 }); }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detection = detectFormat(bytes, fileName);
  if (detection.format !== "xlsx" && detection.format !== "csv") return NextResponse.json({ error: `A quota sheet is an Excel workbook or a CSV — this is ${detection.label}.` }, { status: 415 });
  let sheets: { name: string; rows: string[][] }[];
  try { sheets = await readSheets(bytes, fileName); } catch (e) { return NextResponse.json({ error: `The file could not be read: ${(e as Error).message}` }, { status: 422 }); }
  const sheet = readQuotaSheet(sheets);
  const mode = form.get("mode") === "soft" ? "soft" as const : undefined;
  const onFull = form.get("onFull") === "flag" ? "flag" as const : undefined;
  const mapped = quotaSheetActions(def, sheet, { ...(mode ? { mode } : {}), ...(onFull ? { onFull } : {}) });
  const gate = coerceSurveyActions(mapped.actions);
  return NextResponse.json({
    ok: true, fileName,
    sheet: { confidence: sheet.confidence, quotas: sheet.quotas.map((q) => ({ name: q.name, sheet: q.sheet, layout: q.layout, dimensions: q.dimensions, cells: q.cells.length, total: q.total ?? null })) },
    actions: gate.actions, rejected: gate.rejected, issues: mapped.issues, matched: mapped.matched,
  });
}
