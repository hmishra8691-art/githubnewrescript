import { NextRequest, NextResponse } from "next/server";
import { aiConfigured, aiProviderName, completeJson, ocrImage, embedTexts, aiEmbeddingsModelName } from "@rescript/ai";
import { extractResearchDocument, chunkResearchDocument } from "@rescript/import/research";
import { isFailure, requireUser, type AuthedUser } from "@/lib/guard";
import { billingProjectFor, meteredAi, refusalResponse } from "@/lib/metering";
import { outputBudget } from "@/lib/copilot/budget";
import { DOC_SUMMARY_SYSTEM_PROMPT, coerceDocSummary, summaryInput } from "@/lib/copilot/research";
import { researchStoreFor, type StoredChunk } from "@/lib/copilot/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * RESEARCH DOCUMENTS FOR THE COPILOT (the copilot brief §6–§8).
 *
 *   POST  multipart: files (1–5), surveyId — extract each (PDF text by page,
 *         Word with headings and tables, Excel/CSV tables, text), OCR the
 *         pages of a scanned PDF through the configured vision model, cut
 *         into passages, embed them when an embeddings model is configured,
 *         and summarise each document ONCE into a structured research card.
 *         Every model call is metered (AI_REQUEST); a refused wallet stops
 *         the work and says why.
 *   GET   ?surveyId= — the documents (cards, not text)
 *   DELETE ?surveyId=&id= — remove one, with its passages
 *
 * Who may call: a signed-in Studio user who may edit the project; the
 * sandbox fixture on a FAKE-provider installation needs no session (the
 * carve-out every Studio AI route has). TEST SEAM, fake provider only:
 * `fakeSummary` (JSON) and `fakeOcr` (text) stand in for what the fake
 * cannot produce — ignored, never read, with a real provider.
 */
const MAX_FILES = 5;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_OCR_PAGES = 40;

export async function GET(req: NextRequest) {
  const authed = await requireUser(req);
  const surveyId = req.nextUrl.searchParams.get("surveyId") ?? "";
  if (isFailure(authed) && !(surveyId === "sandbox" && aiProviderName() === "fake")) return authed.response;
  const billing = await billingProjectFor(isFailure(authed) ? null : authed, surveyId, "project.read");
  if ("response" in billing) return billing.response;
  const store = await researchStoreFor(surveyId);
  return NextResponse.json({ ok: true, durable: store.durable, documents: await store.list(surveyId) });
}

export async function DELETE(req: NextRequest) {
  const authed = await requireUser(req);
  const surveyId = req.nextUrl.searchParams.get("surveyId") ?? "";
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (isFailure(authed) && !(surveyId === "sandbox" && aiProviderName() === "fake")) return authed.response;
  const billing = await billingProjectFor(isFailure(authed) ? null : authed, surveyId);
  if ("response" in billing) return billing.response;
  const store = await researchStoreFor(surveyId);
  const ok = await store.remove(surveyId, id);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  let form: FormData;
  try { form = await req.formData(); } catch { return isFailure(authed) ? authed.response : NextResponse.json({ error: "expected a multipart form with files" }, { status: 400 }); }
  const surveyId = typeof form.get("surveyId") === "string" ? String(form.get("surveyId")) : "";
  let user: AuthedUser | null = null;
  if (isFailure(authed)) {
    if (!(surveyId === "sandbox" && aiProviderName() === "fake")) return authed.response;
  } else user = authed;
  const files = form.getAll("files").filter((f): f is File => f instanceof Blob && f.size > 0);
  if (!files.length) return NextResponse.json({ error: "attach at least one document" }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: `attach at most ${MAX_FILES} documents at a time` }, { status: 400 });
  const big = files.find((f) => f.size > MAX_BYTES);
  if (big) return NextResponse.json({ error: `${big.name} is ${(big.size / 1048576).toFixed(1)} MB — the limit is ${MAX_BYTES / 1048576} MB` }, { status: 413 });

  const billing = await billingProjectFor(user, surveyId);
  if ("response" in billing) return billing.response;
  const { meter, ctx } = billing;
  const fake = aiProviderName() === "fake";
  const fakeSummary = fake && typeof form.get("fakeSummary") === "string" ? safeJson(String(form.get("fakeSummary"))) : null;
  const fakeOcr = fake && typeof form.get("fakeOcr") === "string" ? String(form.get("fakeOcr")).slice(0, 20_000) : "";

  const store = await researchStoreFor(surveyId);
  const added = [];
  let charge = 0;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await extractResearchDocument(bytes, file.name || "document");
    const warnings = [...doc.warnings];
    /* OCR: the pages of a scan, through the vision model, one metered call per page */
    let ocrPages = 0;
    if (doc.images.length) {
      if (!aiConfigured()) warnings.push(`${doc.images.length} scanned page${doc.images.length === 1 ? "" : "s"} could not be read: no AI provider is configured for OCR.`);
      else {
        for (const img of doc.images.slice(0, MAX_OCR_PAGES)) {
          const m = await meteredAi(meter, ctx, "AI_REQUEST", { estimateText: "x".repeat(4000), maxTokens: 2500, operation: "copilot_ocr" }, () => ocrImage(img.bytes, img.mime, { timeoutMs: 90_000 }).catch((e) => { warnings.push(`OCR failed on page ${img.page}: ${(e as Error).message}`); return ""; }));
          if (!m.ok) return refusalResponse(m);
          charge += m.event?.customerCharge ?? 0;
          const text = (m.value || (fake ? fakeOcr : "")).trim();
          if (text) { const p = doc.pages.find((x) => x.n === img.page); if (p) p.text = text; else doc.pages.push({ n: img.page, text }); ocrPages++; }
        }
        doc.pages.sort((a, b) => a.n - b.n);
        if (doc.images.length > MAX_OCR_PAGES) warnings.push(`Only the first ${MAX_OCR_PAGES} scanned pages were read.`);
        if (!ocrPages) warnings.push(fake ? "The FAKE provider cannot read images; the scanned pages have no text." : "OCR found no legible text on the scanned pages.");
      }
    }
    const ref = await store.nextRef(surveyId);
    const chunks: StoredChunk[] = chunkResearchDocument(ref, doc);
    if (!chunks.length) { added.push({ name: file.name, error: warnings[0] ?? "No text could be read from this document." }); continue; }
    /* embeddings, when an embeddings model is configured (optional: BM25 alone otherwise) */
    if (aiEmbeddingsModelName()) {
      for (let i = 0; i < chunks.length; i += 64) {
        const batch = chunks.slice(i, i + 64);
        const m = await meteredAi(meter, ctx, "AI_REQUEST", { estimateText: batch.map((c) => c.text).join(" "), maxTokens: 1, operation: "copilot_embeddings" }, () => embedTexts(batch.map((c) => `${c.heading ?? ""}\n${c.text}`)));
        if (!m.ok) return refusalResponse(m);
        charge += m.event?.customerCharge ?? 0;
        m.value?.forEach((e, k) => { batch[k].embedding = e; });
      }
    }
    /* the research card: once, from the document's most informative passages */
    let summary = null;
    if (aiConfigured()) {
      const input = summaryInput(chunks);
      const prompt = `Document: ${file.name}\n\n${input.text}`;
      try {
        const sb = outputBudget("summary");
        const m = await meteredAi(meter, ctx, "AI_REQUEST", { estimateText: DOC_SUMMARY_SYSTEM_PROMPT + prompt, maxTokens: sb.expectedTokens, operation: "copilot_document_summary" }, () => completeJson(DOC_SUMMARY_SYSTEM_PROMPT, prompt, sb.maxTokens, { timeoutMs: sb.timeoutMs, continuations: sb.continuations }));
        if (!m.ok) return refusalResponse(m);
        charge += m.event?.customerCharge ?? 0;
        summary = coerceDocSummary(fakeSummary ?? m.value, chunks.map((c) => c.id));
        if (!summary) warnings.push(fake ? "The FAKE provider writes no summaries; the document's passages are still searchable." : "The model returned no usable summary; the document's passages are still searchable.");
      } catch (e) {
        warnings.push(`The summary could not be written: ${(e as Error).message}. The passages are still searchable.`);
      }
    } else warnings.push("No AI provider is configured: the document is searchable but has no summary.");
    const stored = await store.add({ surveyId, ref, name: file.name, format: doc.format, kind: summary?.type, pages: doc.pages.length, chars: doc.chars, ocrPages, summary, warnings }, chunks, { customerId: ctx.customerId === "sandbox" ? null : ctx.customerId, userId: user?.userId ?? null });
    added.push({ ...stored, chunks: chunks.length, tables: doc.tables.length });
  }
  return NextResponse.json({ ok: true, durable: store.durable, added, documents: await store.list(surveyId), usage: { charge } });
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }
