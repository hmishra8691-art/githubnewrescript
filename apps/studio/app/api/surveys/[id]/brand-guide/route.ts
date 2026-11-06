import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { extractPdfText } from "@rescript/import";
import { isFailure, requireProject } from "@/lib/guard";
import { readBrandGuide } from "@/lib/brandGuideCore";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * A THEME FROM BRAND GUIDELINES (Intelligent Mode IM8, 2026-11-06).
 *
 *     POST multipart { file: <the brand book, PDF, ≤ 15 MB> } → { ok, seeds: [{hex, role, context}], fonts, scanned }
 *
 * Gated like brand-scrape (`survey.edit`): an authoring tool. The PDF's text is read in memory and dropped — never
 * stored, never sent anywhere, no model. Only short hex strings, a role word, at most 80 characters of the words
 * around each colour and the typeface names cross back; the palette is generated in the browser by the same
 * generator the website import and the logo use, and nothing is applied until the person applies it.
 */
const MAX = 15 * 1024 * 1024;
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ ok: false, error: "Send the brand guidelines as a PDF file." }, { status: 400 }); }
  const file = form.get("file");
  if (!file || typeof file === "string") return NextResponse.json({ ok: false, error: "Send the brand guidelines as a PDF file." }, { status: 400 });
  if (file.size > MAX) return NextResponse.json({ ok: false, error: "That PDF is over 15 MB — export the colour and typography pages on their own." }, { status: 413 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") return NextResponse.json({ ok: false, error: "That file is not a PDF." }, { status: 415 });
  let pages: string[][];
  try {
    const t = extractPdfText(bytes);
    if (t.encrypted) return NextResponse.json({ ok: false, error: "The PDF is password-protected — export an unprotected copy." }, { status: 422 });
    pages = t.pages;
  } catch (e) {
    return NextResponse.json({ ok: false, error: `The PDF could not be read: ${(e as Error).message.slice(0, 120)}` }, { status: 422 });
  }
  const r = readBrandGuide(pages);
  if (r.scanned) return NextResponse.json({ ok: false, scanned: true, error: "The PDF is scanned images — there is no text to read colours from. Enter the brand colour below, or detect it from the logo." });
  return NextResponse.json({ ok: true, seeds: r.seeds.map((s) => ({ hex: s.hex, role: s.role, context: s.context.slice(-80) })), fonts: r.fonts, scanned: false });
}
