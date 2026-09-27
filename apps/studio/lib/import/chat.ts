import type { SurveyDefinition } from "@rescript/schema";

/**
 * THE IMPORT, AS THE INTELLIGENT MODE TALKS ABOUT IT (the import brief §29,
 * §39). Pure, so the sentences and the answers are tested without a browser.
 */

/** "import this file", "upload a Qualtrics survey" → open the file picker; "what could not be migrated?" → the review list */
export function importRequest(text: string): "pick" | "report" | null {
  const t = text.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  if (/^(?:please\s+)?(?:import|upload|migrate|bring\s+in|load|convert|reverse[- ]engineer)\b.*\b(?:file|survey|questionnaire|qsf|decipher|qualtrics|xml|word|docx?|excel|xlsx?|pdf|csv|document|spreadsheet|script)\b/i.test(t)
    || /^(?:import|upload)(?:\s+(?:it|this|one|something))?$/i.test(t)) return "pick";
  if (/\bwhat\s+(?:could(?:n['’]?t|\s+not)|was(?:n['’]?t|\s+not)|were(?:n['’]?t|\s+not)|did(?:n['’]?t|\s+not)|can(?:['’]?t|not|\s+not))\s+(?:be\s+|get\s+)?(?:migrat|import|convert|translat|read)/i.test(t)
    || /^(?:show(?:\s+me)?\s+)?(?:the\s+)?(?:migration|import)\s+(?:report|issues|review|risks?)$/i.test(t)
    || /^what\s+(?:needs|do\s+i\s+need|is\s+left)\s+to\s+review(?:\s+(?:from|after)\s+the\s+import)?$/i.test(t)
    || /^what\s+needs\s+(?:my\s+)?review$/i.test(t)) return "report";
  return null;
}

export interface ReviewLine { text: string; questionId?: string; severity: string }

/**
 * "What could not be migrated?" — answered from the survey itself, so it
 * works in any later session: every import the project records, its review
 * list, and the custom code kept as disabled scripts.
 */
export function importReviewAnswer(def: SurveyDefinition): { summary: string; lines: ReviewLine[] } {
  const imports = def.imports ?? [];
  if (!imports.length) return { summary: "This survey was not imported from a file, so there is no migration report. Attach a file (the paperclip) to import one.", lines: [] };
  const last = imports[imports.length - 1];
  const exists = new Set(def.questions.map((q) => q.id));
  const lines: ReviewLine[] = last.review.map((r) => ({
    text: `${r.severity === "high" ? "High" : r.severity === "medium" ? "Medium" : "Low"} · ${r.location}: ${r.message}${r.suggestion ? ` — ${r.suggestion}` : ""}`,
    ...(r.questionId && exists.has(r.questionId) ? { questionId: r.questionId } : {}),
    severity: r.severity,
  }));
  const disabled = (def.scripts ?? []).filter((s) => !s.enabled && /^Imported /.test(s.name)).length;
  if (disabled) lines.push({ text: `${disabled} imported custom script${disabled === 1 ? " is" : "s are"} kept in Scripts, disabled — none of it runs until it is rebuilt.`, severity: "info" });
  const high = last.review.filter((r) => r.severity === "high").length;
  const when = last.importedAt ? new Date(last.importedAt).toISOString().slice(0, 10) : "";
  const summary = last.review.length
    ? `${last.review.length} item${last.review.length === 1 ? "" : "s"} from ${last.fileName}${when ? ` (${when})` : ""} need${last.review.length === 1 ? "s" : ""} review${high ? ` — ${high} high risk` : ""}:`
    : `Everything in ${last.fileName} was migrated; nothing was left for review.`;
  return { summary, lines };
}

/** money as the wallet shows it: small amounts keep their cents' fractions */
export function formatCharge(n: number, currency = "USD"): string {
  const v = Math.max(0, n);
  const digits = v > 0 && v < 0.01 ? 4 : 2;
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v); }
  catch { return `${v.toFixed(digits)} ${currency}`; }
}

/** a project code from a title, as the new-project dialog would make it */
export function codeFromTitle(title: string): string {
  const base = title.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s-]+/g, "_").toUpperCase().slice(0, 40) || "IMPORTED";
  return `${base}_${Date.now().toString(36).toUpperCase().slice(-4)}`;
}
