import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle, PageBreak,
  LevelFormat, convertInchesToTwip,
} from "docx";
import type { SurveyDefinition, Question, Option, ValidationRule } from "@rescript/schema";
import {
  conditionSummary, optionLogicSummary, listOperationSummary,
  formatSetExpression, setExpressionSummary,
} from "@rescript/engine";
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

/* ------------------------------------------------------- masking words */

const MASK_ACTION_TEXT: Record<string, string> = {
  display: "Show only",
  display_and_preselect: "Show only, and pre-tick",
  preselect: "Pre-tick",
  disable: "Show everything, but only these are answerable",
  remove: "Remove",
};

const EMPTY_SOURCE_TEXT: Record<string, string> = {
  show_all: "show the full list",
  show_none: "show nothing",
  always_show_only: "show only the always-show items",
};

const PUNCH_VERB: Record<string, string> = {
  select: "SELECT", deselect: "DESELECT", clear: "CLEAR", set_value: "SET",
  show: "SHOW", hide: "HIDE", enable: "ENABLE", disable: "DISABLE",
};

/**
 * One auto-punch rule, in the IF/THEN form the punch editor parses.
 *
 * `formatPunchExpression` in the engine prints only `codes` sources and drops
 * the mapping, which on a rule that translates one question's codes into
 * another's would print the rule as if it wrote nothing. A specification has
 * to carry the mapping, the cell address and the if/else-if/else position, or
 * a reader cannot tell two rules on the same question apart.
 */
function punchText(def: SurveyDefinition, target: Question, rule: any): string {
  const mode = rule.mode === "else_if" ? "ELSE IF" : rule.mode === "else" ? "ELSE" : "IF";
  const cond = rule.mode === "else" ? "" :
    ` ${rule.when ? conditionSummary(def, rule.when) : "always"} THEN`;
  const verb = PUNCH_VERB[rule.action] ?? rule.action.toUpperCase();
  const cell = rule.targetRow
    ? ` in row “${rule.targetRow}”${rule.targetColumn ? `, column “${rule.targetColumn}”` : ""}`
    : "";
  const from = rule.action === "clear" ? target.code : formatSetExpression(def, rule.source) || target.code;
  const map = rule.mapping?.length
    ? `  ·  mapping ${rule.mapping.map((m: any) => `${m.from}→${m.to}`).join(", ")}`
    : "";
  /*
   * Only what departs from the defaults. `ignoreUnmatched` defaults to true
   * and `recompute` to "once", so printing both on every rule buries the one
   * that matters — a rule that REPORTS unmatched codes, or recomputes, is the
   * exception a reviewer needs to see.
   */
  const extra = [
    rule.recompute === "always" ? "recomputed on every change" : null,
    rule.ignoreUnmatched === false ? "unmatched codes are reported, not ignored" : null,
    rule.priority != null ? `priority ${rule.priority}` : null,
  ].filter(Boolean).join(", ");
  return `${mode}${rule.mode === "else" ? "" : cond} ${verb} ${from}${cell} into ${target.code}${map}${extra ? `  (${extra})` : ""}`;
}

/**
 * A plain header-and-rows table. `optionRows` builds the option table with
 * its own widths; everything else that is genuinely tabular — a loop's
 * reference data, the List Fill allocation, quota cells — shares this one so
 * the document has a single table style rather than four.
 */
function gridTable(head: string[], rows: string[][]): Table {
  const total = 9000;
  const w = Math.floor(total / head.length);
  const cell = (text: string, isHead: boolean) =>
    new TableCell({
      width: { size: w, type: WidthType.DXA },
      shading: isHead ? { type: ShadingType.CLEAR, fill: "EEF1F6", color: "auto" } : undefined,
      margins: { top: 60, bottom: 60, left: 90, right: 90 },
      children: [new Paragraph({
        children: [new TextRun({ text, bold: isHead, size: 18, color: isHead ? SUBTLE : INK })],
      })],
    });
  return new Table({
    width: { size: total, type: WidthType.DXA },
    rows: [
      new TableRow({ tableHeader: true, children: head.map((h) => cell(h, true)) }),
      ...rows.map((r) => new TableRow({ children: r.map((v) => cell(v, false)) })),
    ],
  });
}

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
  /*
   * `q.required` is the Studio's own tick-box; a `required` VALIDATION rule is
   * the same statement with a custom message. Reading only the second printed
   * "Optional" over every question marked required without one — and a tester
   * signing off that line would be signing off the opposite of what fields.
   */
  if (fields.required) {
    const req = !!q.required || !!q.validation?.some((v) => v.kind === "required");
    meta.push(req ? "Required" : "Optional");
  }
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

  /*
   * MASKING. The reason a respondent sees three brands out of ten, and the
   * single most consequential thing a reviewer has to check. Printed in both
   * forms on purpose: the expression is what another programmer retypes, the
   * sentence is what a client reads, and they are generated from the same
   * tree so they cannot drift apart.
   */
  if (fields.masking) {
    for (const [axis, mask] of [
      ["Masking", q.mask], ["Row masking", q.rowMask], ["Column masking", q.columnMask],
    ] as const) {
      if (!mask) continue;
      out.push(label(axis));
      if (mask.label) out.push(muted(mask.label));
      out.push(body(`${MASK_ACTION_TEXT[mask.action] ?? mask.action}: ${formatSetExpression(def, mask.expr)}`));
      out.push(muted(`— ${setExpressionSummary(def, mask.expr)}`));
      const notes: string[] = [];
      if (mask.when) notes.push(`applies only when ${conditionSummary(def, mask.when)}`);
      /*
       * The EFFECTIVE fallback, not the stored field. `onEmptySource` is
       * optional and derived from `keepAlwaysShow` when absent (carryforward's
       * own `mask.onEmptySource ?? (mask.keepAlwaysShow ? … : …)`), so printing
       * only what is stored says nothing at all about the commonest case —
       * a mask whose source has not been answered yet.
       */
      const fallback = mask.onEmptySource ?? (mask.keepAlwaysShow ? "always_show_only" : "show_none");
      notes.push(`when the set is empty: ${EMPTY_SOURCE_TEXT[fallback] ?? fallback}`);
      const protects = mask.protectAlwaysShow ?? (fallback === "always_show_only");
      notes.push(protects
        ? "“Other”, “None of these” and always-show items survive the mask"
        : "no option is protected from the mask");
      out.push(muted(notes.join("  ·  ")));
    }
  }

  /* AUTO-PUNCH. What gets written into the data without the respondent
     touching it — invisible on screen, and therefore only ever checkable
     from a document like this one. */
  if (fields.autoPunch && q.punches?.length) {
    out.push(label("Auto-punch"));
    for (const rule of q.punches) out.push(body(punchText(def, q, rule)));
  }

  if (fields.optionLogic && q.carryForward) {
    out.push(label("Carry-forward"));
    const cf: any = q.carryForward;
    const src = def.questions.find((x) => x.id === cf.sourceQuestionId);
    out.push(body(
      `Build the ${cf.into ?? "options"} from ${src?.code ?? cf.sourceQuestionId}` +
      `${cf.filter ? ` (${cf.filter})` : ""}${cf.keepOwn ? ", keeping this question's own list too" : ""}`,
    ));
    if (cf.where) out.push(muted(`Keep an item only when ${conditionSummary(def, cf.where)}`));
  }

  if (fields.optionLogic && q.optionPipeline?.length) {
    out.push(label("Option list operations"));
    // `${op.kind} across ${op.sources?.length} source(s)` printed "filter
    // across 0 source(s)" for every filter and randomize op, which is every
    // op that has no sources — a line that says nothing at all.
    for (const op of q.optionPipeline) {
      out.push(body(`${op.label ? `${op.label} — ` : ""}${listOperationSummary(def, op)}`));
    }
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
  /*
   * THE REDIRECT URL. "End of survey — screened" says a respondent leaves;
   * it does not say where they are sent, which is the one thing about a
   * screen-out that a tester actually has to click through and verify, and
   * the one thing a panel partner has to be given. It was in the JSON export
   * and in the Studio, and missing from the only document anyone reviews.
   */
  if ((e.type === "end" || e.type === "redirect")) {
    const url = e.node.redirectUrl ?? e.node.url;
    if (url) out.push(body(`  Redirect to ${url}`));
  }
  if (e.type === "quota_check" && e.node.onFull?.url) {
    out.push(body(`  When full, redirect to ${e.node.onFull.url}`));
  }
  /*
   * A loop's reference columns are named in the summary line; their VALUES
   * are what the piped text and any loop-scoped mask actually resolve to, so
   * a reviewer checking "does Aquaviva show the right attributes" needs the
   * table, not the column names.
   */
  if (e.type === "loop" && e.node.references?.columns?.length) {
    const cols = e.node.references.columns.map((c: any) => c.name);
    const values = e.node.references.values ?? {};
    const keys = Object.keys(values);
    if (keys.length) {
      out.push(label("Loop reference data"));
      out.push(gridTable(
        ["Item", ...cols],
        keys.map((k) => [k, ...cols.map((c: string) => String(values[k]?.[c] ?? ""))]),
      ));
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

  /* ------------------------------------------------------------ appendix
   *
   * Survey-level configuration. None of it is attached to a question, so
   * none of it appeared anywhere in this document before — a reviewer had no
   * way to check a quota target, a calculated variable's formula or the List
   * Fill's priority order except by reading the JSON.
   */
  const appendix: (Paragraph | Table)[] = [];

  if (fields.calculations && def.calculations?.length) {
    appendix.push(new Paragraph({
      children: [new TextRun({ text: "CALCULATED VARIABLES", bold: true, size: 26, color: INK })],
      heading: HeadingLevel.HEADING_1, spacing: { before: 120, after: 40 },
    }));
    appendix.push(muted("Derived values. They hold no respondent answer of their own; every one is computed from the answers above and can be piped, tested in logic, and exported."));
    appendix.push(divider());
    appendix.push(gridTable(
      ["Variable", "Expression", "Recomputed"],
      def.calculations.map((c: any) => [
        c.targetVariable + (c.label ? `\n${c.label}` : ""),
        c.expression,
        c.trigger ?? "on_change",
      ]),
    ));
  }

  if (fields.quotas && def.quotas?.length) {
    appendix.push(new Paragraph({ children: [new PageBreak()] }));
    appendix.push(new Paragraph({
      children: [new TextRun({ text: "QUOTAS", bold: true, size: 26, color: INK })],
      heading: HeadingLevel.HEADING_1, spacing: { before: 120, after: 40 },
    }));
    appendix.push(divider());
    for (const quota of def.quotas as any[]) {
      appendix.push(label(quota.name ?? quota.id));
      const bits = [
        `${quota.mode ?? "hard"} quota`,
        quota.targetTotal != null ? `total sample ${quota.targetTotal}` : null,
        `counts ${(quota.countStatus ?? ["complete"]).join(" + ")}`,
        quota.onFull?.kind ? `when full: ${quota.onFull.kind}` : null,
      ].filter(Boolean);
      appendix.push(muted(bits.join("  ·  ")));
      appendix.push(gridTable(
        ["Cell", "Limit", "Who falls in it"],
        (quota.cells ?? []).map((c: any) => [
          c.label ?? c.id,
          `${c.limit}${c.limitType === "percent" ? "%" : ""}${c.target != null ? ` (target ${c.target})` : ""}`,
          c.when ? conditionSummary(def, c.when) : "everyone",
        ]),
      ));
    }
  }

  if (fields.listFill && def.listFills?.length) {
    appendix.push(new Paragraph({ children: [new PageBreak()] }));
    appendix.push(new Paragraph({
      children: [new TextRun({ text: "LIST FILL ALLOCATION", bold: true, size: 26, color: INK })],
      heading: HeadingLevel.HEADING_1, spacing: { before: 120, after: 40 },
    }));
    appendix.push(divider());
    for (const lf of def.listFills as any[]) {
      appendix.push(label(lf.name ?? lf.id));
      if (lf.label) appendix.push(muted(lf.label));
      const src = lf.source?.questionId
        ? def.questions.find((x) => x.id === lf.source.questionId)?.code ?? lf.source.questionId
        : lf.source?.kind;
      appendix.push(body(
        `Source: ${src}${lf.source?.take ? ` (${lf.source.take})` : ""}  ·  ` +
        `method ${lf.selection?.method ?? "random"}  ·  ` +
        `count ${lf.selection?.count?.kind === "fixed" ? lf.selection.count.value : `from ${lf.selection?.count?.ref ?? "?"}`}`,
      ));
      if (lf.tracking?.respectQuotas) {
        appendix.push(muted(`Respects quotas: ${(lf.tracking.quotaIds ?? []).join(", ") || "all"}  ·  sample size ${lf.tracking.sampleSize ?? "—"}`));
      }
      appendix.push(gridTable(
        ["Code", "Label", "Priority", "Target", "Maximum", "Eligible when"],
        (lf.options ?? []).map((o: any) => [
          String(o.code), plainText(o.label ?? ""),
          o.priority != null ? String(o.priority) : "—",
          o.target != null ? String(o.target) : "—",
          o.maximum != null ? String(o.maximum) : "—",
          o.eligibleWhen ? conditionSummary(def, o.eligibleWhen) : (o.eligible === false ? "never" : "always"),
        ]),
      ));
      if (lf.destinations?.length) {
        appendix.push(muted(`Written into: ${lf.destinations.map((d: any) => {
          const q = def.questions.find((x) => x.id === d.questionId);
          return `${q?.code ?? d.questionId}${d.position != null ? ` (slot ${d.position})` : ""}`;
        }).join(", ")}`));
      }
    }
  }

  if (appendix.length) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(...appendix);
  }

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
