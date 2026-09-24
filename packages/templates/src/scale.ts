import { SurveyDefinition } from "@rescript/schema";
import type { FlowNode } from "@rescript/schema";
import { AGREE_5, SAT_5, YES_NO, and, opts, or, page, block, rule } from "./builders.js";

/**
 * A SURVEY THE SIZE OF THE ONES THAT BREAK EDITORS.
 *
 * Every fixture in the repo is small enough that nothing about the Studio's
 * performance can be learned from it: the starters have seven questions, the
 * Master Demo 160. Real tracker programmes run to several hundred, and a
 * programming environment that is smooth at 160 and unusable at 600 is one
 * the brief explicitly rules out (§16).
 *
 * This builds a survey of `n` questions with the logic DENSITY of a real
 * programme rather than a flat list: every fourth question has display
 * logic reading an earlier one, every tenth a skip, blocks of ten are
 * conditional on a screener answer, matrices and multi-selects appear in
 * the proportions a tracker has, a calculation runs per block, and a named
 * display rule gates every other block. Deterministic — no random — so two
 * runs give the same survey and a perf number means something.
 *
 * It is a fixture, not a template: it is not in `SURVEY_TEMPLATES` and never
 * appears in the Studio's gallery.
 */
export function buildScaleSurvey(n = 600, surveyId = `scale-${n}`): SurveyDefinition {
  const questions: Record<string, unknown>[] = [];
  const flow: FlowNode[] = [];
  const displayRules: Record<string, unknown>[] = [];
  const calculations: Record<string, unknown>[] = [];

  // a screener the rest of the survey keys off
  questions.push(
    { id: "q_consent", code: "S1", variableName: "CONSENT", type: "single_select", text: "Do you agree to take part?", options: YES_NO,
      skipLogic: [{ id: "sk_consent", when: rule("q_consent", "eq", 2), target: { kind: "terminate", status: "screened" } }] },
    { id: "q_age", code: "S2", variableName: "AGE", type: "numeric", text: "How old are you?", settings: { minValue: 16, maxValue: 99 },
      validation: [{ kind: "min_value", value: 18, message: "You must be 18 or over." }] },
    { id: "q_region", code: "S3", variableName: "REGION", type: "single_select", text: "Where do you live?",
      options: opts(["North", "South", "East", "West", "Central"]) },
    { id: "q_segment", code: "S4", variableName: "SEGMENT", type: "single_select", text: "Which best describes you?",
      options: opts(["Customer", "Lapsed customer", "Prospect", "Never considered"]) },
  );
  flow.push(page("p_screener", "Screener", ["q_consent", "q_age", "q_region", "q_segment"]));

  const body = n - questions.length;
  const BLOCK = 10;
  const blocks = Math.ceil(body / BLOCK);
  let qn = 0;

  for (let b = 0; b < blocks; b++) {
    const blockIds: string[][] = [[], []]; // two pages per block
    const blockQids: string[] = [];
    for (let i = 0; i < BLOCK && qn < body; i++, qn++) {
      const id = `q${qn + 1}`;
      const code = `Q${qn + 1}`;
      const kind = qn % 10;
      const q: Record<string, unknown> = { id, code, variableName: code, text: `Question ${qn + 1}: how do you feel about item ${qn + 1}?` };

      if (kind === 0) Object.assign(q, { type: "single_select", options: SAT_5 });
      else if (kind === 1) Object.assign(q, { type: "multi_select", options: opts(["Price", "Quality", "Service", "Range", "Location", "Other"]) });
      else if (kind === 2) Object.assign(q, { type: "matrix_single", rows: opts(["Brand A", "Brand B", "Brand C", "Brand D"]), options: AGREE_5 });
      else if (kind === 3) Object.assign(q, { type: "numeric", settings: { minValue: 0, maxValue: 100 } });
      else if (kind === 4) Object.assign(q, { type: "text", text: `Why did you say that about item ${qn}? {{${qn > 0 ? `Q${qn}` : "S2"}}}` });
      else if (kind === 5) Object.assign(q, { type: "single_select", options: YES_NO });
      else if (kind === 6) Object.assign(q, { type: "nps" });
      else if (kind === 7) Object.assign(q, { type: "single_select", options: AGREE_5 });
      else if (kind === 8) Object.assign(q, { type: "multi_select", options: opts(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) });
      else Object.assign(q, { type: "text" });

      // every fourth question reads an earlier one
      if (qn % 4 === 3 && qn >= 4) {
        const src = `q${qn - 3}`;
        q.displayLogic = qn % 8 === 7
          ? and(rule("q_segment", "in", [1, 2]), rule(src, "ne", 5))
          : rule(src, "ne", 5);
      }
      // every tenth has a skip over the next block
      if (qn % 10 === 5 && b + 1 < blocks) {
        q.skipLogic = [{ id: `sk_${id}`, when: rule(id, "eq", 2), target: { kind: "page", ref: `p_b${b + 1}_a` } }];
      }
      questions.push(q);
      blockQids.push(id);
      blockIds[i < BLOCK / 2 ? 0 : 1].push(id);
    }
    if (blockIds[0].length === 0) break;

    const pages: FlowNode[] = [page(`p_b${b}_a`, `Block ${b + 1} · A`, blockIds[0])];
    if (blockIds[1].length) pages.push(page(`p_b${b}_b`, `Block ${b + 1} · B`, blockIds[1]));

    // every third block is conditional on the screener
    const extra = b % 3 === 2 ? { visibleIf: or(rule("q_segment", "eq", 1), rule("q_region", "in", [1, 2])) } : {};
    flow.push(block(`blk_${b}`, `Block ${b + 1}`, pages, extra));

    // every other block is gated by a named display rule
    if (b % 2 === 1) {
      displayRules.push({
        id: `dr_blk_${b}`, label: `Block ${b + 1} for adults`,
        target: { kind: "block", ref: `blk_${b}` }, action: "show", when: rule("q_age", "gte", 18),
      });
    }
    // one calculation per block over its numeric question, chained to the previous block's
    const numeric = blockQids.find((id) => (questions.find((q) => q.id === id) as { type: string }).type === "numeric");
    if (numeric) {
      const code = (questions.find((q) => q.id === numeric) as { code: string }).code;
      calculations.push({
        id: `calc_b${b}`, targetVariable: `SCORE_B${b + 1}`,
        expression: b > 0 && calculations.length ? `${code} + SCORE_B${b}` : `${code} * 1`,
      });
    }
  }

  flow.push(
    { type: "end", id: "end_complete", status: "complete", message: "Thank you." },
    { type: "end", id: "end_screened", status: "screened", message: "You do not qualify." },
  );

  return SurveyDefinition.parse({
    meta: { id: surveyId, code: `SCALE_${n}`, title: `Scale fixture — ${n} questions`, version: "1.0", status: "draft" },
    questions,
    flow,
    displayRules,
    calculations,
    deployment: { clientSlug: "client", studySlug: `scale-${n}` },
  });
}
