import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { translationsToXlsx } from "@rescript/exporters";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The translation table of the definition in the body as an Excel workbook — a pure transform, nothing read or stored. */
export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const parsed = SurveyDefinition.safeParse(body?.definition);
  if (!parsed.success) return NextResponse.json({ error: "definition failed validation" }, { status: 400 });
  const languages = Array.isArray(body?.languages) ? body.languages.filter((l: unknown) => typeof l === "string") : undefined;
  const buf = await translationsToXlsx(parsed.data, languages);
  return new NextResponse(new Uint8Array(buf), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${(parsed.data.meta.code || "Survey").replace(/[^A-Za-z0-9_-]+/g, "_")}_Translations.xlsx"` } });
}
