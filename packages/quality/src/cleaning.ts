import type { QualityAssessment, QualityFlag } from "./types.js";

/**
 * BATCH CLEANING, PROPOSED (Intelligent Mode IM6, 2026-11-06).
 *
 * "Flag speeders and straightliners and exclude duplicates" becomes criteria — rule ids or families, verdicts,
 * a risk floor — and this reads the stored assessments into one proposal: which responses match, each with the
 * flags that put it there in the engine's own words, how many per rule, and what is left alone. Nothing is
 * decided here; the Studio shows the proposal and a person applies it, as one batch that can be undone.
 *
 * Two rules keep it honest:
 *   · a decision a person already made (KEEP / REMOVE / REVIEW_LATER) is never overridden by a batch unless the
 *     criteria say `includeDecided` — the count of what was skipped is reported;
 *   · a response with no assessment is never proposed — it is counted, so "nothing matched" is never read as
 *     "everything is clean" when the assessments are missing.
 *
 * An open-end judgement by a language model (IM6, `openEndJudgement`) arrives as one more flag, `openend.model`,
 * informational, with the model named — evidence a criterion may select on, never a decision of its own.
 */
export type CleaningDecision = "REMOVE" | "REVIEW_LATER" | "KEEP";
export interface CleaningCriteria {
  /** rule ids ("matrix.straightline") or families ("timing.", "duplicate.") — a response matches when it carries any */
  rules?: string[];
  /** the engine's verdicts to select ("FLAGGED", "REVIEW") */
  verdicts?: string[];
  recommendation?: QualityAssessment["recommendation"][];
  minRisk?: number;
  decision: CleaningDecision;
  includeDecided?: boolean;
  /** only classifying flags count (the default); informational flags are shown, never selected on alone */
  includeInformational?: boolean;
}
export interface CleaningRow {
  id: string;
  session_id: string;
  status: string;
  quality: QualityAssessment | null;
  review_status: string | null;
}
export interface CleaningMatch { responseId: string; sessionId: string; risk: number; verdict: string; because: string[]; rules: string[] }
export interface CleaningProposal {
  criteria: CleaningCriteria;
  matches: CleaningMatch[];
  byRule: Record<string, number>;
  skipped: { decided: number; unassessed: number; inProgress: number };
  total: number;
  lines: string[];
}

/** the rule families sentences name */
export const CLEANING_WORDS: [RegExp, string[]][] = [
  [/\bspeed(?:ers?|ing|sters?)\b|\btoo\s+fast\b|\brush(?:ed|ers?)\b/i, ["timing.overall_speeding", "timing.page_speeding"]],
  [/\bstraight[-\s]?lin(?:ers?|ing|ed)\b|\bflat[-\s]?lin(?:ers?|ing)\b|\bsame\s+answer\s+(?:on|in|across)\s+(?:every|all)\b/i, ["matrix.straightline"]],
  [/\bduplicates?\b|\bdupes?\b|\bsame\s+(?:device|person|respondent)\s+twice\b/i, ["duplicate.", "device.duplicate", "network.duplicate_ip"]],
  [/\bbots?\b|\bautomat(?:ed|ion)\b|\bscript(?:ed)?\s+(?:respondents|responses)\b/i, ["bot.", "device.webdriver"]],
  [/\bgibberish\b|\bnonsense\b|\bkeyboard\s+mash\w*\b|\brandom\s+(?:letters|text|characters)\b/i, ["openend.gibberish"]],
  [/\b(?:ai|chatgpt|llm)[-\s](?:written|generated|like)\b|\bwritten\s+by\s+(?:ai|a\s+model|chatgpt)\b/i, ["openend.ai_like"]],
  [/\bcopy[-\s]?past\w*\b|\bpasted\b/i, ["openend.pasted", "interaction.paste"]],
  [/\b(?:short|one[-\s]word|empty|lazy)\s+(?:open[-\s]?ends?|answers?|responses?|comments?)\b/i, ["openend.too_short", "openend.generic"]],
  [/\b(?:off[-\s]topic|irrelevant)\s+(?:open[-\s]?ends?|answers?|responses?|comments?)?\b/i, ["openend.irrelevant"]],
  [/\b(?:failed|missed)\s+(?:the\s+)?attention\s+checks?\b|\battention\s+check\s+failures?\b|\binattentive\b/i, ["attention."]],
  [/\binconsisten\w*\b|\bcontradict\w*\b/i, ["consistency.", "openend.contradiction"]],
];
/** the rules a sentence names, by family */
export function rulesNamed(text: string): string[] {
  const out = new Set<string>();
  for (const [re, rules] of CLEANING_WORDS) if (re.test(text)) for (const r of rules) out.add(r);
  return [...out];
}

const matchesRule = (flag: QualityFlag, rule: string) => (rule.endsWith(".") ? flag.ruleId.startsWith(rule) : flag.ruleId === rule);

export function cleaningProposal(rows: readonly CleaningRow[], c: CleaningCriteria): CleaningProposal {
  const matches: CleaningMatch[] = [];
  const byRule: Record<string, number> = {};
  const skipped = { decided: 0, unassessed: 0, inProgress: 0 };
  for (const r of rows) {
    if (r.status === "in_progress") { skipped.inProgress++; continue; }
    if (!r.quality) { skipped.unassessed++; continue; }
    const q = r.quality;
    const flags = q.flags.filter((f) => c.includeInformational || f.role !== "informational" || f.ruleId === "openend.model");
    const ruleHits = c.rules?.length ? flags.filter((f) => c.rules!.some((rule) => matchesRule(f, rule))) : [];
    const byVerdict = c.verdicts?.length ? c.verdicts.includes(q.verdict) : false;
    const byRec = c.recommendation?.length ? c.recommendation.includes(q.recommendation) : false;
    const byRisk = c.minRisk !== undefined ? q.riskScore >= c.minRisk : false;
    const selected = (c.rules?.length ? ruleHits.length > 0 : false) || byVerdict || byRec || byRisk;
    if (!selected) continue;
    if (r.review_status && !c.includeDecided && r.review_status !== c.decision) { skipped.decided++; continue; }
    if (r.review_status === c.decision) continue;
    const shown = (ruleHits.length ? ruleHits : [...flags].sort((a, b) => b.riskPoints - a.riskPoints).slice(0, 3));
    for (const f of ruleHits) byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
    matches.push({ responseId: r.id, sessionId: r.session_id, risk: q.riskScore, verdict: q.verdict, rules: [...new Set(shown.map((f) => f.ruleId))], because: shown.map((f) => `${f.title}: ${f.observed}${f.expected ? ` (expected ${f.expected})` : ""}`) });
  }
  matches.sort((a, b) => b.risk - a.risk);
  const verb = c.decision === "REMOVE" ? "exclude" : c.decision === "REVIEW_LATER" ? "mark for review" : "keep";
  const lines: string[] = [];
  lines.push(matches.length ? `${matches.length} of ${rows.length} responses would be ${c.decision === "REMOVE" ? "excluded" : c.decision === "REVIEW_LATER" ? "marked for review" : "kept"}: ${Object.entries(byRule).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "by verdict or risk"}.` : `No response matches — nothing to ${verb}.`);
  if (skipped.decided) lines.push(`${skipped.decided} matching response${skipped.decided === 1 ? " was" : "s were"} already decided by a person and ${skipped.decided === 1 ? "is" : "are"} left as decided.`);
  if (skipped.unassessed) lines.push(`${skipped.unassessed} finished response${skipped.unassessed === 1 ? " has" : "s have"} no quality assessment yet and ${skipped.unassessed === 1 ? "was" : "were"} not considered (the five-minute sweep assesses them).`);
  if (skipped.inProgress) lines.push(`${skipped.inProgress} in progress — not considered.`);
  lines.push("Nothing changes until the batch is applied; an applied batch is undone as one.");
  return { criteria: c, matches, byRule, skipped, total: rows.length, lines };
}
