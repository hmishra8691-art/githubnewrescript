import type { SurveyDefinition } from "@rescript/schema";
import { listPages, questionsInFlowOrder, conditionSummary, formatSetExpression } from "@rescript/engine";

/**
 * THE SURVEY, COMPACTLY, FOR A LANGUAGE MODEL.
 *
 * A model that is to turn "show the income question when they said yes to
 * owning a car" into `Q7 = Yes` needs to know that Q7 is the car question
 * and that its options are Yes/No. It does not need the survey JSON — a
 * 160-question survey is hundreds of kilobytes of it — so this writes one
 * line per question, in flow order, with the code, variable, type, text and
 * (for choice questions) the options, and a page header where the page
 * changes. The selected question and its neighbours are always included;
 * beyond `limit` questions the rest is listed by code only, so the prompt
 * stays bounded on a 1,000-question survey and the model can still name
 * any question.
 *
 * Text is stripped of markup and cut short. Nothing else about the survey
 * — no answers, no respondents, no keys — is in here.
 */
export interface ContextOptions {
  /** the question the programmer has selected, kept in full */
  selectedId?: string | null;
  /** full lines for at most this many questions */
  limit?: number;
  /** characters of question text per line */
  textWidth?: number;
}

const plain = (s: string | undefined, width: number): string => {
  const t = (s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return t.length > width ? `${t.slice(0, width - 1)}…` : t;
};

export function surveyContext(def: SurveyDefinition, opts: ContextOptions = {}): string {
  const limit = opts.limit ?? 120;
  const width = opts.textWidth ?? 90;
  const qs = questionsInFlowOrder(def);
  const pageOf = new Map<string, { id: string; title?: string; n: number }>();
  listPages(def.flow as unknown[]).forEach((p, i) => { for (const id of p.node.questionIds) pageOf.set(id, { id: p.node.id, title: p.node.title, n: i + 1 }); });

  // which questions get a full line: the first `limit`, plus a window round the selection
  const full = new Set<string>();
  qs.slice(0, limit).forEach((q) => full.add(q.id));
  if (opts.selectedId) {
    const k = qs.findIndex((q) => q.id === opts.selectedId);
    if (k >= 0) for (let i = Math.max(0, k - 5); i <= Math.min(qs.length - 1, k + 5); i++) full.add(qs[i].id);
  }

  const lines: string[] = [];
  lines.push(`Survey: ${plain(def.meta.title, 80)} (${qs.length} questions)`);
  let lastPage: string | null = null;
  const brief: string[] = [];
  for (const q of qs) {
    if (!full.has(q.id)) { brief.push(q.code); continue; }
    const p = pageOf.get(q.id);
    if (p && p.id !== lastPage) { lines.push(`## Page ${p.n}${p.title ? `: ${plain(p.title, 60)}` : ""} [${p.id}]`); lastPage = p.id; }
    const parts = [`${q.code} (${q.variableName})`, q.type.replace(/_/g, " "), `"${plain(q.text, width)}"`];
    if (q.required) parts.push("required");
    if (q.options?.length) {
      const opts = q.options.slice(0, 12).map((o) => `${o.code}=${plain(o.label, 24)}`).join(", ");
      parts.push(`options: ${opts}${q.options.length > 12 ? `, … (${q.options.length})` : ""}`);
    }
    if (q.rows?.length) parts.push(`${q.rows.length} rows`);
    if (q.validation?.length) parts.push(`validation: ${q.validation.map((v) => `${String(v.kind).replace(/_/g, " ")}${v.value !== undefined && v.value !== null && typeof v.value !== "object" ? ` ${v.value}` : ""}`).join(", ")}`);
    if (q.mask) parts.push(`mask: ${q.mask.action} ${formatSetExpression(def, q.mask.expr)}`);
    if (q.displayLogic) parts.push(`shown when ${conditionSummary(def, q.displayLogic)}`);
    if (q.skipLogic?.length) parts.push(`${q.skipLogic.length} skip rule${q.skipLogic.length === 1 ? "" : "s"}`);
    if (q.id === opts.selectedId) parts.push("← selected");
    lines.push(parts.join(" · "));
  }
  if (brief.length) lines.push(`Other questions (by code): ${brief.join(", ")}`);
  if (def.calculations?.length) lines.push(`Calculations: ${def.calculations.map((c) => `${c.targetVariable} = ${c.expression}`).slice(0, 30).join("; ")}`);
  return lines.join("\n");
}
