import { NextRequest, NextResponse } from "next/server";
import { parseTranslationSheet, parseTranslationCsv } from "@rescript/exporters";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Rows from an uploaded translation file (xlsx or csv) — parsed here, applied in the Studio against the live definition by Element ID. */
export async function POST(req: NextRequest) {
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "expected multipart form data" }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file missing" }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "file too large" }, { status: 413 });
  try {
    const rows = /\.csv$/i.test(file.name) || /csv/.test(file.type) ? parseTranslationCsv(await file.text()) : await parseTranslationSheet(await file.arrayBuffer());
    if (!rows.length) return NextResponse.json({ error: "no rows found — the file needs Element ID, Target Language and Translation columns" }, { status: 400 });
    return NextResponse.json({ ok: true, rows });
  } catch (e) {
    return NextResponse.json({ error: `could not read the file: ${(e as Error).message}` }, { status: 400 });
  }
}
