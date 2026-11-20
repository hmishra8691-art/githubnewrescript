import { PdfDoc, pdfCanWrite } from "@rescript/exporters/pdf";
import type { Comparison } from "@rescript/analytics/benchmark";
import type { PortalAnswerLine, ScorecardResult } from "@rescript/engine";
import { NOTE_GROUPS, NOTE_NOT_ADVICE, fmtScore, placeOn, standingText } from "./words.ts";

/**
 * THE PERSONAL REPORT AS A PDF FILE (phase 2, 2026-11-20). It contains exactly what the results page shows the
 * signed-in person — the same scores, range names, comparisons and answers, decided by the same server rules —
 * and nothing else. Built from the view the page is built from, so the two cannot disagree.
 *
 * The file can only carry Western European text (see @rescript/exporters/pdf). For anything else `null` is
 * returned and the portal offers the browser's own "Print → Save as PDF", which handles every script.
 */
export interface ReportInput {
  title: string;
  person: { name: string | null; respondentId: string };
  completedAt: string | null;
  generatedAt: string;
  scoredTest: boolean;
  scores: ScorecardResult | null;
  comparison: Comparison[] | null;
  answers: Pick<PortalAnswerLine, "code" | "text" | "answer">[] | null;
}

const day = (iso: string | null) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : ""; };
const MUTED: [number, number, number] = [0.36, 0.4, 0.46];

/** every piece of text the report would carry — what `pdfCanWrite` is asked about */
export function reportTexts(r: ReportInput): string[] {
  const out = [r.title, r.person.name ?? "", r.person.respondentId];
  if (r.scores) {
    if (r.scores.overall) out.push(r.scores.overall.label);
    for (const d of r.scores.dimensions) out.push(d.label, d.description ?? "", d.band?.label ?? "", d.band?.note ?? "", d.reason ?? "");
  }
  for (const c of r.comparison ?? []) { out.push(c.note ?? ""); for (const g of c.groups) out.push(g.grouping, g.group); }
  for (const a of r.answers ?? []) out.push(a.code, a.text, a.answer);
  return out;
}

export function portalReportPdf(r: ReportInput): Uint8Array | null {
  if (!r.scores && !r.answers?.length) return null;
  if (!reportTexts(r).every(pdfCanWrite)) return null;
  const doc = new PdfDoc({ title: `${r.title} — personal report`, footer: `${r.person.respondentId}   ·   Generated ${day(r.generatedAt)}` });
  doc.text(r.title, { size: 19, bold: true, gapAfter: 2 });
  doc.text(["Personal report", r.person.name ? `for ${r.person.name}` : "", `Respondent ID ${r.person.respondentId}`, r.completedAt ? `Completed ${day(r.completedAt)}` : ""].filter(Boolean).join("   ·   "), { color: MUTED, gapAfter: 4 });
  doc.rule();

  if (r.scores) {
    const of = (id: string) => r.comparison?.find((c) => c.dimension === id);
    doc.space(6);
    doc.text("My results", { size: 14, bold: true, gapAfter: 4 });
    if (r.scores.overall) {
      const c = of("__overall");
      doc.pair(r.scores.overall.label, `${fmtScore(r.scores.overall.percent)} of 100`, { size: 13 });
      doc.bar(r.scores.overall.percent, c?.everyone ? c.everyone.mean : null);
      if (c?.everyone) doc.text(`${standingText(c.everyone, true)}. Average ${fmtScore(c.everyone.mean)}.`, { size: 9.5, color: MUTED });
      doc.rule();
    }
    for (const d of r.scores.dimensions) {
      const c = of(d.id);
      doc.need(70);
      doc.pair(d.label, d.score === null ? "" : `${fmtScore(d.score)}${d.max !== null ? ` of ${fmtScore(d.max)}` : ""}`);
      if (d.description) doc.text(d.description, { size: 9.5, color: MUTED });
      if (d.score === null) doc.text(d.reason ?? "This score could not be worked out.", { size: 9.5, color: MUTED });
      if (d.percent !== null) doc.bar(d.percent, c?.everyone ? placeOn(c.everyone.mean, d.min, d.max) : null);
      if (d.band) doc.text(`${d.band.label}${d.band.note ? `. ${d.band.note}` : ""}`, { size: 10.5, bold: !d.band.note });
      if (c && d.score !== null) {
        if (c.everyone) doc.text(`Everyone: ${standingText(c.everyone, d.higherIsBetter)}. Average ${fmtScore(c.everyone.mean)}.`, { size: 9.5 });
        for (const g of c.groups) doc.text(`${g.grouping}: ${g.group}. ${standingText(g, d.higherIsBetter)}. Average ${fmtScore(g.mean)}.`, { size: 9.5 });
        if (c.note) doc.text(c.note, { size: 9.5, color: MUTED });
      }
      doc.rule();
    }
    if (r.comparison?.some((c) => c.everyone)) doc.text("The line on a bar is the average of everyone compared.", { size: 8.5, color: MUTED });
    if (r.comparison) doc.text(NOTE_GROUPS, { size: 8.5, color: MUTED });
    if (!r.scoredTest) doc.text(NOTE_NOT_ADVICE, { size: 8.5, color: MUTED });
  }

  if (r.answers?.length) {
    doc.space(12);
    doc.need(60);
    doc.text("My answers", { size: 14, bold: true, gapAfter: 4 });
    for (const a of r.answers) {
      doc.need(34);
      doc.text(`${a.code}  ${a.text}`, { size: 10, bold: true });
      doc.text(a.answer, { size: 10, gapAfter: 6 });
    }
  }
  return doc.bytes();
}

/** a file name from the title: letters, digits and dashes only */
export const reportFileName = (title: string): string => `${(title.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)) || "report"}-personal-report.pdf`;
