import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle, PageBreak,
  LevelFormat, convertInchesToTwip,
} from "docx";
import type { SurveyDefinition, Question, Option, ValidationRule } from "@rescript/schema";
import { conditionSummary, optionLogicSummary } from "@rescript/engine";
import {
  type ExportFields, type OutlineEntry, type OutlineBlock,
  surveyOutline, plainText, elementSummary,
} from "./exportConfig.js";

/**
 * The programmed survey as a Word document.
 *
 * It is written from `surveyOutline()`, the same reading of `definition.flow`
 * that the Studio's Survey Flow and the JSON export use, so a block that
 * moved in the Studio has moved here too. Nothing is stored for the export
 * and nothing is described twice.
 *
 * Everything below is filtered by `fields`: an unticked box means the section
 * is absent, not empty. A document that says nothing about skip logic must
 * mean "you did not ask for it", never "there is none".
 */

const INK = "16202E";
const SUBTLE = "5F6B7D";
const ACCENT = "1D4ED8";
const RULE = "D5DBE4";

const label = (text: string) =>
  new Paragraph({
    children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 16, color: SUBTLE, characterSpacing: 20 })],
    spacing: { before: 140, after: 40 },
  });

const body = (text: string) =>
  new Paragraph({ children: [new TextRun({ text, color: INK, size: 21 })], spacing: { after: 60 } });

const muted = (text: string) =>
  new Paragraph({ children: [new TextRun({ text, color: SUBTLE, size: 19, italics: true })], spacing: { after: 60 } });

/** A rule across the page. Never a table — a bottom border is the honest way. */
const divider = () =>
  new Paragraph({
    text: "",
    spacing: { after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 6 } },
  });

function optionRows(q: Question, fields: ExportFields, def: SurveyDefinition): Table {
  // A column of "—" is noise. The column appears only when some option in
  // THIS question carries logic, so its presence is itself information.
  const wantsLogic = fields.optionLogic
    && q.options.some((o: Option) => o.logic || o.visibleIf);
  const widths = wantsLogic ? [900, 4600, 3500] : [900, 8100];
  const head = ["Code", "Label", ...(wantsLogic ? ["Option logic"] : [])];
  const cell = (text: string, w: number, opts: { head?: boolean } = {}) =>
    new TableCell({
      width: { size: w, type: WidthType.DXA },
      shading: opts.head ? { type: ShadingType.CLEAR, fill: "EEF1F6", color: "auto" } : undefined,
      margins: { top: 60, bottom: 60, left: 90, right: 90 },
      children: [
        new Paragraph({
          children: [new TextRun({ text, bold: !!opts.head, size: 19, color: opts.head ? SUBTLE : INK })],
        }),
      ],
    });

  const rows = [
    new TableRow({ tableHeader: true, children: head.map((h, i) => cell(h, widths[i], { head: true })) }),
    ...q.options.map((o: Option) => {
      const flags = (o.flags ?? []).length ? ` [${(o.flags ?? []).join(", ")}]` : "";
      const cells = [
        cell(String(o.code), widths[0]),
        cell(plainText(o.label) + flags, widths[1]),
      ];
      if (wantsLogic) cells.push(cell(optionLogicSummary(def, o.logic, o.visibleIf).join(" ") || "—", widths[2]));
      return new TableRow({ children: cells });
    }),
  ];
  return new Table({ columnWidths: widths, width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA }, rows });
}

function validationText(r: ValidationRule): string {
  const v = r.value;
  const base =
    r.kind === "required" ? "Required"
    : r.kind === "min_value" ? `Minimum value ${v}`
    : r.kind === "max_value" ? `Maximum value ${v}`
    : r.kind === "min_length" ? `At least ${v} characters`
    : r.kind === "max_length" ? `At most ${v} characters`
    : r.kind === "min_selections" ? `Select at least ${v}`
    : r.kind === "max_selections" ? `Select at most ${v}`
    : r.kind === "sum_equals" ? `Must total ${v}`
    : r.kind === "sum_max" ? `Total at most ${v}`
    : r.kind === "sum_min" ? `Total at least ${v}`
    : r.kind === "pattern" ? `Must match ${v}`
    : r.kind === "email" ? "Must be an email address"
    : r.kind === "integer" ? "Whole numbers only"
    : r.kind === "custom_expression" ? `Expression: ${v}`
    : r.kind === "custom_script" ? `Script: ${v}`
    : String(r.kind);
  return r.message ? `${base} — “${r.message}”` : base;
}

function skipText(def: SurveyDefinition, rule: any): string {
  const t = rule.target ?? {};
  const dest =
    t.kind === "question" ? (def.questions.find((q) => q.id === t.ref)?.code ?? t.ref)
    : t.kind === "url" ? t.ref
    : t.kind === "end" || t.kind === "terminate" ? `${t.kind}${t.status ? ` (${t.status})` : ""}`
    : `${t.kind} ${t.ref ?? ""}`.trim();
  return `If ${conditionSummary(def, rule.when)} → go to ${dest}`;
}

function questionBlock(q: Question, def: SurveyDefinition, fields: ExportFields): Paragraph[] | (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];

  const heading: TextRun[] = [];
  if (fields.questionId) heading.push(new TextRun({ text: q.code, bold: true, size: 24, color: ACCENT }));
  if (fields.questionId && fields.questionText) heading.push(new TextRun({ text: "  ", size: 24 }));
  if (fields.questionText) {
    heading.push(new TextRun({ text: plainText(q.text) || "(untitled question)", bold: true, size: 24, color: INK }));
  }
  if (heading.length === 0) heading.push(new TextRun({ text: q.code, bold: true, size: 24, color: ACCENT }));
  out.push(new Paragraph({ children: heading, spacing: { before: 220, after: 60 }, keepNext: true }));

  const meta: string[] = [];
  if (fields.questionId) meta.push(`ID ${q.id}  ·  variable ${q.variableName}`);
  if (fields.questionType) meta.push(`Type: ${q.variant ?? q.type}`);
  if (fields.required) meta.push(q.validation?.some((v) => v.kind === "required") ? "Required" : "Optional");
  if (meta.length) out.push(muted(meta.join("   ·   ")));

  if (fields.questionText && q.instruction) out.push(body(plainText(q.instruction)));

  if (fields.options && q.options?.length) {
    out.push(label("Options"));
    out.push(optionRows(q, fields, def));
  }

  if (fields.options && q.rows?.length) {
    out.push(label("Rows / statements"));
    for (const r of q.rows) out.push(body(`${r.code}. ${plainText(r.label)}`));
  }

  if (fields.options && (q as any).columns?.length) {
    // the JSON export has always carried these; the Word document did not,
    // which meant the two disagreed about the same grid question
    out.push(label("Columns"));
    for (const c of (q as any).columns) {
      const bits = [plainText(c.label ?? c.code ?? "")];
      if (c.responseType) bits.push(`(${c.responseType})`);
      if (fields.required && c.required) bits.push("· required");
      if (fields.validation && c.validation?.length) {
        bits.push(`· ${c.validation.map((v: ValidationRule) => validationText(v)).join("; ")}`);
      }
      out.push(body(bits.join(" ")));
    }
  }

  if (fields.validation && q.validation?.length) {
    out.push(label("Validation"));
    for (const r of q.validation) out.push(body(validationText(r)));
  }

  if (fields.displayLogic && q.displayLogic) {
    out.push(label("Display logic"));
    out.push(body(`Show ${q.code} when ${conditionSummary(def, q.displayLogic)}`));
  }

  if (fields.skipLogic && q.skipLogic?.length) {
    out.push(label("Skip logic"));
    for (const r of q.skipLogic) out.push(body(skipText(def, r)));
  }

  if (fields.piping) {
    const tokens = Array.from(new Set(plainText(q.text).match(/\{\{[^}]+\}\}/g) ?? []));
    if (tokens.length) {
      out.push(label("Piping"));
      out.push(body(tokens.join("   ")));
    }
  }

  if (fields.randomization && q.randomization?.enabled) {
    const r = q.randomization;
    out.push(label("Randomization"));
    out.push(body(
      `${r.method} of ${r.scope}${r.pick != null ? `, showing ${r.pick}` : ""}` +
      `${r.groups?.length ? `, within ${r.groups.length} group(s)` : ""}` +
      `${r.rules?.length ? `, ${r.rules.length} conditional rule(s)` : ""}`,
    ));
  }

  if (fields.optionLogic && q.optionPipeline?.length) {
    out.push(label("Option list operations"));
    for (const op of q.optionPipeline) out.push(body(`${op.kind} across ${op.sources?.length ?? 0} source(s)`));
  }

  return out as (Paragraph | Table)[];
}

function blockSection(
  b: OutlineBlock, def: SurveyDefinition, fields: ExportFields, opts: { first: boolean },
): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  // one block per page keeps the document navigable for review
  if (!opts.first) out.push(new Paragraph({ children: [new PageBreak()] }));

  const title = fields.blockName && b.title ? b.title : undefined;
  const headText = fields.blockOrder
    ? `BLOCK ${b.number}${title ? ` — ${title}` : ""}`
    : (title ?? "BLOCK");
  out.push(new Paragraph({
    children: [new TextRun({ text: headText, bold: true, size: 26, color: INK })],
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 120, after: 40 },
  }));
  out.push(muted(
    `${b.questionCount} question${b.questionCount === 1 ? "" : "s"}` +
    (b.pages.length > 1 && fields.pageBreaks ? ` · ${b.pages.length} respondent pages` : ""),
  ));
  out.push(divider());

  b.pages.forEach((p, i) => {
    if (fields.pageBreaks && b.pages.length > 1) {
      out.push(new Paragraph({
        children: [new TextRun({
          text: i === 0 ? `PAGE ${p.index}` : `──────── PAGE BREAK ────────    PAGE ${p.index}`,
          bold: true, size: 16, color: SUBTLE, characterSpacing: 20,
        })],
        spacing: { before: 200, after: 60 },
      }));
      if (fields.blockName && p.title) out.push(muted(p.title));
    }
    for (const q of p.questions) out.push(...questionBlock(q, def, fields));
    for (const id of p.missing) out.push(muted(`⚠ missing question ${id}`));
    if (p.questions.length === 0 && p.missing.length === 0) out.push(muted("(no questions)"));
  });

  return out;
}

/** What survey programmers call these, rather than the node type. */
const ELEMENT_NAMES: Record<string, string> = {
  branch: "Branch", randomizer: "Randomizer", loop: "Loop",
  embedded_data: "Embedded data", quota_check: "Quota check",
  redirect: "Redirect", end: "End of survey",
};

function elementSection(e: any, def: SurveyDefinition, fields: ExportFields): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [
    new Paragraph({
      children: [new TextRun({
        text: `▸ ${(ELEMENT_NAMES[e.type] ?? e.type).toUpperCase()}`,
        bold: true, size: 20, color: ACCENT,
      })],
      spacing: { before: 200, after: 40 },
    }),
    body(e.summary || elementSummary(e.node, def)),
  ];
  // the branch CONDITIONS are branch logic; the branch itself is a flow
  // element. Two tick-boxes, two decisions.
  if (e.type === "branch" && fields.branchLogic) {
    for (const br of e.node.branches ?? []) {
      out.push(body(`  IF ${conditionSummary(def, br.when)}${br.label ? `  (${br.label})` : ""}`));
    }
  }
  if (e.type === "embedded_data") {
    for (const f of e.node.fields ?? []) {
      out.push(body(`  ${f.name} ← ${f.source}${f.value ? ` (${f.value})` : ""}`));
    }
  }
  return out;
}

/**
 * Build the .docx. Returns a Buffer ready to stream.
 */
export async function exportSurveyDocx(
  def: SurveyDefinition,
  fields: ExportFields,
  meta: { version?: string; generatedAt?: Date } = {},
): Promise<Buffer> {
  const entries = surveyOutline(def);
  const children: (Paragraph | Table)[] = [];

  /* ------------------------------------------------------------ cover */
  children.push(new Paragraph({
    children: [new TextRun({ text: plainText(def.meta.title) || def.meta.code, bold: true, size: 44, color: INK })],
    spacing: { after: 80 },
  }));
  const stamp = (meta.generatedAt ?? new Date()).toISOString().slice(0, 10);
  children.push(muted(
    `${def.meta.code}${meta.version ? `  ·  version ${meta.version}` : ""}  ·  ${def.questions.length} questions  ·  exported ${stamp}`,
  ));
  children.push(divider());

  /* ------------------------------------------- contents, in survey order */
  if (fields.blockOrder) {
    children.push(label("Contents"));
    const walk = (list: OutlineEntry[], indent: number) => {
      for (const e of list) {
        if (e.kind === "block") {
          children.push(new Paragraph({
            children: [new TextRun({
              text: `Block ${e.number}${fields.blockName && e.title ? ` — ${e.title}` : ""}  (${e.questionCount})`,
              size: 20, color: INK,
            })],
            indent: { left: convertInchesToTwip(0.25 * indent) },
            spacing: { after: 40 },
          }));
        } else if (e.kind === "group") {
          children.push(new Paragraph({
            children: [new TextRun({
              text: fields.blockName ? `GROUP — ${e.title ?? "untitled"}` : "GROUP",
              bold: true, size: 20, color: SUBTLE,
            })],
            indent: { left: convertInchesToTwip(0.25 * indent) },
            spacing: { before: 60, after: 40 },
          }));
          walk(e.children, indent + 1);
        } else if (fields.flowElements) {
          children.push(new Paragraph({
            children: [new TextRun({
              text: `▸ ${ELEMENT_NAMES[e.type] ?? e.type} — ${e.summary}`,
              size: 19, color: SUBTLE, italics: true,
            })],
            indent: { left: convertInchesToTwip(0.25 * indent) },
            spacing: { after: 40 },
          }));
        }
        // blocks nested in a branch arm or a loop are part of the survey
        if (e.kind === "element") {
          walk(e.children ?? [], indent + 1);
          for (const br of e.branches ?? []) walk(br.children, indent + 1);
          walk(e.otherwise ?? [], indent + 1);
        }
      }
    };
    walk(entries, 0);
  }

  /* ---------------------------------------------------------- the survey */
  let first = true;
  const emit = (list: OutlineEntry[]) => {
    for (const e of list) {
      if (e.kind === "block") {
        children.push(...blockSection(e, def, fields, { first }));
        first = false;
      } else if (e.kind === "group") {
        if (fields.blockName) {
          children.push(new Paragraph({ children: [new PageBreak()] }));
          children.push(new Paragraph({
            children: [new TextRun({ text: `GROUP: ${e.title ?? "untitled"}`, bold: true, size: 30, color: ACCENT })],
            heading: HeadingLevel.HEADING_1,
            spacing: { after: 60 },
          }));
          children.push(muted(`${e.children.length} block${e.children.length === 1 ? "" : "s"}`));
          first = true; // the group heading already broke the page
        }
        emit(e.children);
      } else {
        if (fields.flowElements || (e.type === "embedded_data" && fields.embeddedData)) {
          children.push(...elementSection(e, def, fields));
        }
        // whatever the element contains is still part of the questionnaire —
        // a block inside a branch arm must appear, or the document silently
        // omits questions the survey asks
        emit(e.children ?? []);
        for (const br of e.branches ?? []) {
          if (fields.flowElements && fields.branchLogic) {
            children.push(muted(`  ── arm: ${br.label || conditionSummary(def, br.when)}`));
          }
          emit(br.children);
        }
        emit(e.otherwise ?? []);
      }
    }
  };
  emit(entries);

  const doc = new Document({
    creator: "Rescript",
    title: plainText(def.meta.title) || def.meta.code,
    description: "Programmed survey specification",
    numbering: {
      config: [{
        reference: "rs-bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT }],
      }],
    },
    sections: [{
      properties: {
        page: {
          // US Letter — docx-js defaults to A4, which is wrong for most clients here
          size: { width: 12240, height: 15840 },
          margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 },
        },
      },
      children,
    }],
  });

  return Packer.toBuffer(doc);
}
