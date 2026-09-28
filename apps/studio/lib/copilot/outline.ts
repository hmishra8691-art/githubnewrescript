import type { SurveyDefinition } from "@rescript/schema";
import { listBlocks, formatCondition } from "@rescript/engine";
import { surveyContext } from "../intelligent/context.ts";

/**
 * THE SURVEY-STATE SNAPSHOT a copilot turn is given (the copilot brief §8).
 *
 * The Intelligent mode's `surveyContext` — one line per question, pages,
 * blocks, embedded data, loops, quotas — plus what an EDITING model needs
 * and a one-line-per-question listing does not carry: which questions each
 * block holds, and, for the questions this request names, their display
 * logic and skip rules in full. A 400-question survey gets its first 60
 * questions in full and the rest by code, plus the named ones in full, so
 * the prompt stays bounded however large the survey is.
 */
export function copilotOutline(def: SurveyDefinition, opts: { selectedId?: string | null; focusIds?: string[] } = {}): string {
  const n = def.questions.length;
  const base = surveyContext(def, { selectedId: opts.selectedId ?? null, focusIds: opts.focusIds ?? [], limit: n > 150 ? 60 : 150, textWidth: n > 150 ? 70 : 110 });
  const lines = [base];
  const code = (id: string) => def.questions.find((q) => q.id === id)?.code ?? id;
  const blocks = listBlocks(def.flow as unknown[]);
  if (blocks.length) {
    lines.push("Block contents: " + blocks.slice(0, 60).map((b) => `“${b.title ?? b.id}”: ${b.pages.map((p) => p.node.questionIds.map(code).join(" ")).join(" | ") || "(empty)"}`).join("; "));
  }
  const focus = new Set([...(opts.focusIds ?? []), ...(opts.selectedId ? [opts.selectedId] : [])]);
  for (const id of focus) {
    const q = def.questions.find((x) => x.id === id);
    if (!q) continue;
    const bits: string[] = [];
    if (q.displayLogic) bits.push(`display logic: ${formatCondition(def, q.displayLogic, { width: 400 }).replace(/\s+/g, " ")}`);
    for (const s of q.skipLogic ?? []) {
      const t = s.target;
      const to = t.kind === "question" ? code(t.ref ?? "") : t.kind === "end" ? "end" : t.kind === "terminate" ? `screen out (${t.status ?? "terminated"})` : `${t.kind} ${t.ref ?? ""}`;
      bits.push(`skip when ${formatCondition(def, s.when, { width: 400 }).replace(/\s+/g, " ")} → ${to}`);
    }
    if (q.rows?.length) bits.push(`rows: ${q.rows.slice(0, 20).map((r) => `${r.code}=${r.label}`).join(", ")}`);
    if (q.randomization?.enabled) bits.push("options randomized");
    if (bits.length) lines.push(`${q.code} details: ${bits.join(" · ")}`);
  }
  const r = def.research;
  if (r) {
    const role = (id: string) => code(id);
    lines.push(`Research design: ${[r.objective ? `objective: ${r.objective}` : "", r.hypotheses.length ? `hypotheses: ${r.hypotheses.join(" | ")}` : "", r.population ? `population: ${r.population}` : "", r.constructs.length ? `constructs: ${r.constructs.map((c) => `${c.name} (${c.role}${c.questionIds.length ? `: ${c.questionIds.map(role).join(" ")}` : ", not measured"})`).join("; ")}` : ""].filter(Boolean).join(" · ")}`);
  }
  return lines.join("\n");
}
