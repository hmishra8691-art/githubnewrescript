/**
 * CONSENT QUESTIONS (2026-11-12).
 *
 * Consent is something a respondent GIVES. A question that records it is therefore never answered for them — not by
 * an auto-punch rule, not by the single-option rule, not by a default value — and never moves the page on by itself
 * (auto-next): the respondent reads, chooses and presses Next. Every engine feature that can select an answer or
 * advance a page asks this one function first.
 *
 *   settings.consent = true    the author says it is a consent question
 *   settings.consent = false   the author says it is not (overrides the recognition below)
 *   absent                     recognised: a short choice question whose code, variable or wording is about consent
 *                              ("Do you agree to take part?", "I consent…", CONSENT, GDPR…) — never a bare "agree", which is an attitude scale
 *
 * Recognition errs toward "yes": the only cost of a false positive is that an ordinary question is left for the
 * respondent to answer and to leave with Next, which is what every question does unless told otherwise.
 */
import type { Question } from "@rescript/schema";
import { effectiveResponseModel } from "@rescript/schema";

const NAME = /(^|_)(consent|gdpr|optin|opt_in)(_|\d|$)/i;
/* "agree" alone is an attitude scale ("do you agree that…"); consent is agreeing TO take part / to the processing */
const WORDING = /\b(i\s+(?:hereby\s+)?consent|do\s+you\s+consent|(?:give|provide|confirm)\s+(?:your|my)\s+consent|consent\s+to\s+(?:take\s+part|participat\w*|the\s+(?:processing|collection|use|recording)|being\s+recorded)|agree\s+to\s+(?:take\s+part|participat\w*|continue|proceed|the\s+(?:terms|privacy|processing|recording|collection))|willing\s+to\s+(?:take\s+part|participate)|informed\s+consent)\b/i;

const plain = (html: string | undefined) => String(html ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ");

export function isConsentQuestion(q: Pick<Question, "type" | "code" | "variableName" | "text" | "options" | "settings">): boolean {
  const own = (q.settings as { consent?: boolean } | undefined)?.consent;
  if (own !== undefined) return own;
  let model: string | null = null;
  try { model = effectiveResponseModel(q as Question); } catch { model = null; }
  if (model !== "single_choice" && model !== "multiple_choice") return false;
  if (q.type.startsWith("matrix")) return false;
  if ((q.options?.length ?? 0) > 4) return false;
  if (NAME.test(String(q.code ?? "")) || NAME.test(String(q.variableName ?? ""))) return true;
  return WORDING.test(plain(q.text));
}
