import type { SurveyDefinition, Question } from "@rescript/schema";
import {
  type ExportFields, type OutlineEntry, surveyOutline, plainText, scrubNode,
} from "./exportConfig.js";

/**
 * The programmed survey as JSON.
 *
 * Two shapes, and the difference matters:
 *
 *   FULL      `definition` — the canonical survey definition, byte-identical
 *             to what the runtime executes. Re-importable.
 *   FILTERED  the same survey read through `surveyOutline()` and trimmed to
 *             the fields the user ticked. For review and handover, NOT for
 *             re-import, and it says so in its own header.
 *
 * Both come from the one definition; neither describes the survey a second
 * time. When every field is selected the export carries the definition too,
 * so "Full export" really is everything.
 */

export interface SurveyJsonExport {
  exportedAt: string;
  generator: string;
  /** True when this file can be imported back without losing anything. */
  complete: boolean;
  note?: string;
  fields: ExportFields;
  survey: {
    id: string;
    code: string;
    title: string;
    version?: string;
    questionCount: number;
  };
  flow: unknown[];
  /** Present only on a complete export. */
  definition?: SurveyDefinition;
}

const pipingTokens = (q: Question): string[] =>
  Array.from(new Set(`${q.text ?? ""} ${q.instruction ?? ""}`.match(/\{\{[^}]+\}\}/g) ?? []));

function questionJson(q: Question, f: ExportFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.questionId) { out.id = q.id; out.code = q.code; out.variableName = q.variableName; }
  if (f.questionText) { out.text = q.text; out.plainText = plainText(q.text); if (q.instruction) out.instruction = q.instruction; }
  if (f.questionType) { out.type = q.type; if (q.variant) out.variant = q.variant; }
  if (f.required) out.required = (q.validation ?? []).some((v) => v.kind === "required");
  if (f.options && q.options?.length) {
    out.options = q.options.map((o) => {
      const opt: Record<string, unknown> = { code: o.code, label: o.label };
      if (o.flags?.length) opt.flags = o.flags;
      if (f.optionLogic && (o.logic || o.visibleIf)) opt.logic = o.logic ?? { visibleIf: o.visibleIf };
      return opt;
    });
  }
  if (f.options && q.rows?.length) out.rows = q.rows.map((r) => ({ code: r.code, label: r.label }));
  if (f.options && q.columns?.length) {
    // a column carries its own validation and visibility; those belong to
    // their own tick-boxes, not to "Options"
    out.columns = q.columns.map((c: any) => {
      const col: Record<string, unknown> = { ...c };
      if (!f.validation) delete col.validation;
      if (!f.displayLogic) delete col.visibleIf;
      if (!f.required) delete col.required;
      return col;
    });
  }
  if (f.validation && q.validation?.length) out.validation = q.validation;
  if (f.displayLogic && q.displayLogic) out.displayLogic = q.displayLogic;
  if (f.skipLogic && q.skipLogic?.length) out.skipLogic = q.skipLogic;
  if (f.randomization && q.randomization?.enabled) out.randomization = q.randomization;
  if (f.optionLogic) {
    if (q.optionPipeline?.length) out.optionPipeline = q.optionPipeline;
    if (q.carryForward) out.carryForward = q.carryForward;
    if (q.listLogic?.length) out.listLogic = q.listLogic;
  }
  if (f.piping) {
    const tokens = pipingTokens(q);
    if (tokens.length) out.piping = tokens;
  }
  return out;
}

function entryJson(e: OutlineEntry, f: ExportFields): unknown {
  const kids = (list: OutlineEntry[] | undefined) =>
    (list ?? []).map((c) => entryJson(c, f)).filter((x) => x !== null);

  if (e.kind === "block") {
    const block: Record<string, unknown> = { kind: "block", id: e.id };
    if (f.blockOrder) block.number = e.number;
    if (f.blockName && e.title) block.title = e.title;
    block.questionCount = e.questionCount;
    if (f.pageBreaks) {
      // pages are what page breaks ARE — one entry per respondent page
      block.pages = e.pages.map((p) => ({
        page: p.index,
        // a single-page block keeps its name on the page node, so this is the
        // same name the line above just withheld
        ...(f.blockName && p.title ? { title: p.title } : {}),
        questions: p.questions.map((q) => questionJson(q, f)),
        ...(p.missing.length ? { missingQuestionIds: p.missing } : {}),
      }));
    } else {
      block.questions = e.pages.flatMap((p) => p.questions.map((q) => questionJson(q, f)));
    }
    return block;
  }
  if (e.kind === "group") {
    return {
      kind: "group",
      id: e.id,
      ...(f.blockName && e.title ? { title: e.title } : {}),
      children: kids(e.children),
    };
  }
  // flow element
  if (e.type === "embedded_data" && !f.embeddedData) return null;
  if (e.type !== "embedded_data" && !f.flowElements) {
    // the element itself is not wanted, but blocks inside it still are —
    // dropping them would silently delete part of the survey from the export
    const inner = [...kids(e.children), ...(e.branches ?? []).flatMap((b) => kids(b.children)), ...kids(e.otherwise)];
    return inner.length ? { kind: "element", id: e.id, type: e.type, children: inner } : null;
  }
  const out: Record<string, unknown> = {
    kind: "element", id: e.id, type: e.type, summary: e.summary,
    node: scrubNode(e.node, f),
  };
  if (e.children?.length) out.children = kids(e.children);
  if (e.branches?.length) {
    out.branches = e.branches.map((b) => ({
      id: b.id,
      ...(b.label ? { label: b.label } : {}),
      ...(f.branchLogic ? { when: b.when } : {}),
      children: kids(b.children),
    }));
  }
  if (e.otherwise?.length) out.otherwise = kids(e.otherwise);
  return out;
}

export function exportSurveyJsonConfigured(
  def: SurveyDefinition,
  fields: ExportFields,
  meta: { version?: string; generatedAt?: Date; complete?: boolean } = {},
): SurveyJsonExport {
  const flow = surveyOutline(def).map((e) => entryJson(e, fields)).filter((x) => x !== null);
  const complete = meta.complete ?? false;
  return {
    exportedAt: (meta.generatedAt ?? new Date()).toISOString(),
    generator: "Rescript",
    complete,
    ...(complete
      ? {}
      : { note: "Filtered export for review. Some fields were excluded, so this file is not a complete survey definition and cannot be imported back without loss." }),
    fields,
    survey: {
      id: def.meta.id,
      code: def.meta.code,
      title: def.meta.title,
      version: meta.version ?? def.meta.version,
      questionCount: def.questions.length,
    },
    flow,
    ...(complete ? { definition: def } : {}),
  };
}
