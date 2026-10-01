import { SurveyDefinition, type Condition, type FlowNode, type Question, type ImportMapEntry, type Quota } from "@rescript/schema";
import { runQualityCheck, listBlocks, constantCondition } from "@rescript/engine";
import type {
  CanonicalSurvey, CanonicalQuestion, CanonicalOption, CExpr, CFlow, CSkipTarget, Issue, CanonicalKind, CanonicalEmbeddedField,
} from "./canonical.js";
import { plainText, canonicalStats, exprHasRaw, type CanonicalStats } from "./canonical.js";

/**
 * THE RESCRIPT MAPPING ENGINE (§5–§9, §15, §24–§25, §27, §31).
 *
 * One function turns ANY canonical survey into a Rescript SurveyDefinition —
 * so a fix here is a fix for every source. It keeps identity where it can:
 *
 *   question ids   QID15 stays QID15; a clash becomes QID15_Imported, recorded
 *   variables      the export tag / label stays the variable name; an invalid
 *                  one (spaces, a leading digit) is made valid, recorded
 *   option codes   the recode value / printed code is the Rescript code; the
 *                  source choice id is how logic finds it
 *   block ids      BL_3pT stays BL_3pT
 *
 * and it rebuilds the ARCHITECTURE — blocks, pages, page breaks, branches,
 * randomizers, groups, loops, embedded data, quota checks, ends — not a flat
 * list of questions.
 *
 * Nothing is guessed. A condition with any part the adapter could not read is
 * not converted at all (half a condition means something else); the question
 * keeps its source logic in its notes and the report says so. Every renamed
 * identifier, every approximation and every dropped element is an issue.
 *
 * Pure and dependency-light: it runs in the browser (the preview) and on the
 * server alike, and the result is validated by the engine before it is
 * returned — `SurveyDefinition.parse`, then `runQualityCheck`.
 */

export type ImportScope = "full" | "structure" | "questions";

export interface MapOptions {
  /** the project the definition is for */
  surveyId: string;
  /** merge into this survey instead of making a new one (§27) */
  existing?: SurveyDefinition | null;
  scope?: ImportScope;
  /** ISO time, injectable for tests */
  now?: string;
  /** id minter for new nodes (arms, pages) — the Studio passes its own */
  uid?: (prefix: string) => string;
}

export interface MergeSummary {
  /** imported questions identical to one already in the survey — not imported again; logic points at the existing one */
  unchanged: string[];
  /** same variable, different content — imported as a renamed copy, for review */
  changed: { source: string; existing: string; imported: string; differences: string[] }[];
  added: string[];
}

export interface QuestionConfidence { id: string; code: string; source: string; level: CanonicalQuestion["confidence"]; notes: string[] }

export interface MapResult {
  def: SurveyDefinition | null;
  mapping: ImportMapEntry[];
  issues: Issue[];
  created: CanonicalStats;
  confidence: QuestionConfidence[];
  merge?: MergeSummary;
  quality: { errors: string[]; warnings: string[]; deployable: boolean } | null;
}

/* ------------------------------------------------------------ kind → Rescript type */

const KIND: Record<CanonicalKind, { type: string; variant?: string }> = {
  single: { type: "single_select", variant: "single_select.radio" },
  multi: { type: "multi_select", variant: "multi_select.checkbox" },
  dropdown: { type: "dropdown", variant: "single_select.dropdown" },
  multi_dropdown: { type: "multi_dropdown", variant: "multi_select.dropdown" },
  text: { type: "open_text", variant: "text.single_line" },
  textarea: { type: "long_text", variant: "text.multi_line" },
  email: { type: "open_text", variant: "text.email" },
  numeric: { type: "numeric", variant: "numeric.open" },
  date: { type: "date", variant: "datetime.date" },
  time: { type: "time", variant: "datetime.time" },
  matrix_single: { type: "matrix_single", variant: "matrix.single" },
  matrix_multi: { type: "matrix_multi", variant: "matrix.multi" },
  matrix_text: { type: "matrix_text" },
  matrix_numeric: { type: "numeric_list", variant: "list.numeric_list" },
  matrix_dropdown: { type: "matrix_dropdown" },
  ranking: { type: "ranking", variant: "ranking.drag" },
  slider: { type: "slider", variant: "slider.single" },
  stars: { type: "numeric", variant: "single_select.stars" },
  constant_sum: { type: "allocation", variant: "allocation.constant_sum" },
  nps: { type: "nps", variant: "single_select.nps" },
  descriptive: { type: "html", variant: "content.html" },
  hidden: { type: "hidden", variant: "calculated.hidden" },
  calculated: { type: "calculated", variant: "calculated.value" },
  file_upload: { type: "upload", variant: "upload.file" },
  hotspot: { type: "hotspot", variant: "hotspot.click" },
  conjoint: { type: "conjoint_task", variant: "conjoint.cbc" },
  maxdiff: { type: "maxdiff_task", variant: "maxdiff.best_worst" },
  unknown: { type: "html", variant: "content.html" },
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const safeIdent = (s: string) => { let t = s.trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, ""); if (!t) t = "V"; if (/^\d/.test(t)) t = `Q${t}`; return t; };

export function mapCanonical(c: CanonicalSurvey, opts: MapOptions): MapResult {
  const scope = opts.scope ?? "full";
  const logic = scope === "full";
  const structure = scope !== "questions";
  const now = opts.now ?? new Date().toISOString();
  let seq = 0;
  const uid = opts.uid ?? ((p: string) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`);
  const issues: Issue[] = [];
  const mapping: ImportMapEntry[] = [];
  const existing = opts.existing ?? null;

  /* ------------------------------------------------------------ names already taken */
  const takenIds = new Set<string>(), takenCodes = new Set<string>(), takenVars = new Set<string>(), takenNodes = new Set<string>(), takenFields = new Set<string>();
  if (existing) {
    for (const q of existing.questions) { takenIds.add(q.id); takenCodes.add(q.code.toUpperCase()); takenVars.add(q.variableName.toUpperCase()); }
    const walk = (ns: FlowNode[]) => { for (const n of ns) { takenNodes.add(n.id); const k = n as { children?: FlowNode[]; branches?: { id: string; children: FlowNode[] }[]; otherwise?: FlowNode[] }; if (k.children) walk(k.children); if (k.branches) for (const b of k.branches) { takenNodes.add(b.id); walk(b.children); } if (k.otherwise) walk(k.otherwise); if (n.type === "embedded_data") for (const f of n.fields) takenFields.add(f.name.toUpperCase()); } };
    walk(existing.flow as FlowNode[]);
  }
  const unique = (base: string, taken: Set<string>, upper = false): string => {
    const key = (s: string) => (upper ? s.toUpperCase() : s);
    if (!taken.has(key(base))) { taken.add(key(base)); return base; }
    let n = 1; let cand = `${base}_Imported`;
    while (taken.has(key(cand))) cand = `${base}_Imported${++n}`;
    taken.add(key(cand));
    return cand;
  };
  const nodeId = (src: string) => unique(safeIdent(src), takenNodes);

  /* ------------------------------------------------------------ merge: what already exists */
  let merge: MergeSummary | undefined;
  const reuse = new Map<string, Question>(); // source id → existing question
  if (existing) {
    merge = { unchanged: [], changed: [], added: [] };
    const byVar = new Map(existing.questions.map((q) => [q.variableName.toUpperCase(), q]));
    for (const cq of c.questions) {
      const ex = byVar.get(safeIdent(cq.variable).toUpperCase());
      if (!ex) continue;
      const diffs: string[] = [];
      if (plainText(ex.text) !== plainText(cq.text)) diffs.push("text");
      const exOpts = (ex.options ?? []).map((o) => `${o.code}=${plainText(o.label)}`).join("|");
      const inOpts = cq.options.map((o) => `${o.code}=${plainText(o.label)}`).join("|");
      if (exOpts !== inOpts) diffs.push("options");
      if (ex.type !== KIND[cq.kind].type) diffs.push("type");
      if (!diffs.length) { reuse.set(cq.sourceId, ex); merge.unchanged.push(cq.sourceId); }
      else merge.changed.push({ source: cq.sourceId, existing: ex.code, imported: "", differences: diffs });
    }
  }

  /* ------------------------------------------------------------ questions */
  const idOf = new Map<string, string>(); // source question id → rescript id
  const qBySource = new Map(c.questions.map((q) => [q.sourceId, q]));
  const built: Question[] = [];
  const scripts: Record<string, unknown>[] = [];
  /**
   * Custom code as a Rescript script — ENABLED: FALSE, always. It is kept so
   * nothing the source did is lost and so it can be analysed (§9–§12); it is
   * never run, because code written for another platform's runtime (or in
   * another language entirely) cannot be assumed to mean anything here.
   */
  const scriptFor = (cu: CanonicalSurvey["custom"][number], questionId: string | null) => ({
    id: uid("script"), name: `Imported ${cu.language} · ${cu.role}${questionId ? "" : ` · ${cu.location}`}`.slice(0, 120),
    scope: questionId ? "question" : "survey", ...(questionId ? { ref: questionId } : {}),
    event: /submit/i.test(cu.role + cu.code.slice(0, 200)) ? "on_submit" : "on_load",
    code: cu.code, enabled: false,
    notes: `Imported from ${c.source.platform} (${cu.location}); not executed. ${cu.refs.length ? `Reads ${cu.refs.join(", ")}. ` : ""}Analyse it in Intelligent mode, then rebuild it as Rescript logic.`.slice(0, 1000),
  });
  const optionCode = (qs: string, choice: string): string | number | undefined => qBySource.get(qs)?.options.find((o) => o.sourceId === choice)?.code;
  const rowCode = (qs: string, row: string): string | undefined => qBySource.get(qs)?.rows.find((r) => r.sourceId === row)?.code;
  const confidence: QuestionConfidence[] = [];

  for (const cq of c.questions) {
    const ex = reuse.get(cq.sourceId);
    if (ex) { idOf.set(cq.sourceId, ex.id); mapping.push({ kind: "question", source: cq.sourceId, rescript: ex.id, reason: "already in the survey, identical — not imported again" }); continue; }
    const baseId = safeIdent(cq.sourceId);
    const id = unique(baseId, takenIds);
    const varBase = safeIdent(cq.variable);
    const variableName = unique(varBase, takenVars, true);
    const code = unique(safeIdent(cq.code ?? cq.variable), takenCodes, true);
    idOf.set(cq.sourceId, id);
    mapping.push({ kind: "question", source: cq.sourceId, rescript: id, ...(id !== cq.sourceId ? { reason: id !== baseId ? "id already used in this survey" : "not a valid identifier" } : {}) });
    if (variableName !== cq.variable) {
      mapping.push({ kind: "variable", source: cq.variable, rescript: variableName, reason: variableName !== varBase ? "variable name already used in this survey" : "not a valid variable name" });
      issues.push({ location: cq.sourceId, type: "renamed", severity: variableName !== varBase ? "medium" : "low", message: `Variable ${cq.variable} is ${variableName} here (${variableName !== varBase ? "the name was already used in this survey" : "the original is not a valid variable name"}).`, suggestion: "The source → Rescript map keeps the original name for exports and re-imports.", autoAttempted: true, refs: [cq.sourceId] });
    }
    if (id !== cq.sourceId && id !== baseId) issues.push({ location: cq.sourceId, type: "renamed", severity: "low", message: `Question ${cq.sourceId} is ${id} here: the id was already used in this survey.`, autoAttempted: true, refs: [cq.sourceId] });
    const ch = merge?.changed.find((x) => x.source === cq.sourceId);
    if (ch) { ch.imported = code; issues.push({ location: cq.sourceId, type: "structure", severity: "medium", message: `${cq.variable} already exists here as ${ch.existing}, with different ${ch.differences.join(" and ")}. The imported version was added as ${code} so nothing was overwritten.`, suggestion: "Compare the two and delete the one you do not want.", autoAttempted: true, refs: [cq.sourceId] }); }
    else if (merge) merge.added.push(cq.sourceId);

    const k = KIND[cq.kind];
    const q: Record<string, unknown> = {
      id, code, variableName, type: k.type, ...(k.variant ? { variant: k.variant } : {}),
      text: cq.text, required: cq.required && cq.kind !== "descriptive" && cq.kind !== "hidden" && cq.kind !== "calculated",
      options: [], rows: [], columns: [], validation: [], skipLogic: [], listLogic: [],
      settings: { readOnly: false, hidden: false, ...(cq.settings && typeof cq.settings.minValue === "number" ? { minValue: cq.settings.minValue } : {}), ...(cq.settings && typeof cq.settings.maxValue === "number" ? { maxValue: cq.settings.maxValue } : {}) },
    };
    if (cq.instruction) q.instruction = cq.instruction;
    if (cq.kind === "unknown") q.text = `<p><strong>Not migrated:</strong> ${cq.sourceType} question ${cq.sourceId} (“${plainText(cq.text).slice(0, 120)}”). Rebuild it here.</p>`;
    // options, with exclusive / other-specify / anchor flags; duplicate codes made unique
    const seenCodes = new Set<string>();
    const opts = cq.options.map((o: CanonicalOption, i: number) => {
      let codeV: string | number = o.code;
      if (seenCodes.has(String(codeV))) { const nc = `${codeV}_${i + 1}`; issues.push({ location: `${cq.sourceId} · option ${o.sourceId}`, type: "renamed", severity: "medium", message: `${cq.variable} has two options coded ${codeV}; the second is ${nc} here.`, autoAttempted: true, refs: [cq.sourceId] }); codeV = nc; }
      seenCodes.add(String(codeV));
      if (String(codeV) !== o.sourceId) mapping.push({ kind: "option", source: `${cq.sourceId}/${o.sourceId}`, rescript: `${code}=${codeV}` });
      const flags: string[] = [];
      if (o.exclusive) flags.push("exclusive");
      if (o.otherSpecify) flags.push("other_specify");
      if (o.anchor) flags.push(i >= cq.options.length / 2 ? "anchor_bottom" : "anchor_top");
      return { code: codeV, label: o.label, flags };
    });
    if (cq.kind === "matrix_numeric" && opts.length) {
      // a numeric grid with columns: Rescript's matrix_numeric carries them as numeric columns
      q.type = "matrix_numeric"; delete q.variant;
      q.columns = opts.map((o) => ({ id: safeIdent(`c_${o.code}`), label: o.label, responseType: "numeric", variableStem: safeIdent(`${variableName}_${o.code}`), options: [], validation: [], readOnly: false, flags: [] }));
    } else q.options = opts;
    q.rows = cq.rows.map((r) => ({ code: r.code, label: r.label, flags: [], validation: [], required: false }));
    if (cq.kind === "text" && cq.rows.length) { q.type = "text_list"; q.variant = "list.text_list"; }
    if (cq.kind === "numeric" && cq.rows.length) { q.type = "numeric_list"; q.variant = "list.numeric_list"; }
    // validation
    for (const v of cq.validation) (q.validation as unknown[]).push({ kind: v.kind, ...(v.value !== undefined ? { value: v.value } : {}), ...(v.message ? { message: v.message } : {}) });
    if (cq.randomizeOptions) q.randomization = { enabled: true, scope: cq.rows.length && /matrix/.test(cq.kind) ? "rows" : "options", method: "shuffle" };
    // notes carry what the source said and could not be reproduced
    const notes = [...cq.notes];
    // custom code is preserved, never run: a DISABLED script on the question (see `scripts` below)
    for (const cu of cq.custom) { notes.push(`custom ${cu.language} (${cu.role}) kept, disabled, in Scripts`); scripts.push(scriptFor(cu, id)); }
    if (notes.length) q.notes = `Imported from ${c.source.platform} ${cq.sourceId} (${cq.sourceType}).\n${notes.join("\n")}`;
    if (cq.kind === "hidden" && cq.settings?.sourceKind) q.notes = `${q.notes ?? ""}\nThe source question was a ${String(cq.settings.sourceKind)}; it is hidden from respondents.`.trim();
    if ((cq.kind === "conjoint" || cq.kind === "maxdiff") && cq.options.length === 0 && cq.rows.length) q.options = cq.rows.map((r) => ({ code: r.code, label: r.label, flags: [] }));
    if (cq.kind === "conjoint" || cq.kind === "maxdiff") issues.push({ location: cq.sourceId, type: "converted", severity: "high", message: `${cq.variable} is a ${cq.kind === "maxdiff" ? "MaxDiff" : "conjoint"} exercise. Rescript runs these from an experimental design, which the source file does not carry; the items were kept.`, suggestion: "Attach a design in the Designs tab.", autoAttempted: true, refs: [cq.sourceId] });
    built.push(q as unknown as Question);
    confidence.push({ id, code, source: cq.sourceId, level: cq.confidence, notes: cq.notes });
  }

  /* ------------------------------------------------------------ conditions */
  const describe = (e: CExpr): string => e.t === "raw" ? e.text : e.t === "const" ? String(e.value) : e.t === "cmp" ? `${e.ref.id}${e.ref.choice ? `/${e.ref.choice}` : ""} ${e.op} ${e.value ?? ""}`.trim() : `(${e.children.map(describe).join(` ${e.op.toUpperCase()} `)})`;
  const cond = (e: CExpr | undefined, location: string): Condition | null => {
    if (!e) return null;
    if (exprHasRaw(e)) return null; // the adapter already reported the unreadable part; half a condition is not the condition
    const walk = (x: CExpr): Condition | null => {
      /* A constant is written as a real rule (`1 = 1` / `0 = 1`), not as an
       * empty group: empty groups are VACUOUS (skipped by the evaluator), so
       * NOT(empty) read as true — an "always false" branch (Qualtrics blocks
       * not in the flow) showed to everyone — and an "always" skip or
       * terminate would read as "not configured yet". */
      if (x.t === "const") return constantCondition(x.value);
      if (x.t === "group") { const kids = x.children.map(walk); if (kids.some((k) => !k)) return null; return { type: "group", op: x.op, children: kids as Condition[] } as Condition; }
      if (x.t === "raw") return null;
      const r = x.ref;
      const rule = (source: Record<string, unknown>, operator: string, value?: unknown, value2?: unknown): Condition => ({ type: "rule", source, operator, ...(value !== undefined ? { value } : {}), ...(value2 !== undefined ? { value2 } : {}) } as unknown as Condition);
      if (r.kind === "embedded") return rule({ kind: "embedded", ref: r.id }, opName(x.op), x.value);
      if (r.kind === "loop") return rule({ kind: "loop", ref: r.id === "field1" ? "label" : r.id }, opName(x.op), x.value);
      if (r.kind !== "question") { issues.push({ location, type: "custom_logic", severity: "high", message: `A condition on ${r.kind} ${r.id} has no Rescript equivalent.`, autoAttempted: true, refs: [r.id] }); return null; }
      const qid = idOf.get(r.id);
      if (!qid) { issues.push({ location, type: "reference", severity: "high", message: `A condition refers to ${r.id}, which is not in the imported survey.`, suggestion: "Check whether the question was in the trash or another block.", autoAttempted: true, refs: [r.id] }); return null; }
      const src: Record<string, unknown> = { kind: "question", ref: qid };
      if (r.row) { const rc = rowCode(r.id, r.row); if (rc) src.rowCode = rc; else { issues.push({ location, type: "reference", severity: "medium", message: `A condition names row ${r.row} of ${r.id}, which has no such row.`, autoAttempted: true, refs: [r.id] }); return null; } }
      let op = x.op;
      if (op === "displayed" || op === "notDisplayed") {
        issues.push({ location, type: "converted", severity: "medium", message: `“${describe(x)}”: a was-displayed condition has no direct equivalent; it was converted to ${op === "displayed" ? "answered" : "not answered"}${r.choice ? " / selected" : ""}.`, suggestion: "Check it — an optional question can be displayed and left blank.", autoAttempted: true, refs: [r.id] });
        if (r.choice) { const cc = optionCode(r.id, r.choice); return cc === undefined ? null : rule(src, op === "displayed" ? "selected" : "notSelected", cc); }
        op = op === "displayed" ? "answered" : "unanswered";
      }
      if (r.choice) {
        const cc = optionCode(r.id, r.choice);
        if (cc === undefined) { issues.push({ location, type: "reference", severity: "high", message: `A condition refers to choice ${r.choice} of ${r.id}, which has no such choice.`, autoAttempted: true, refs: [r.id] }); return null; }
        if (op === "selected" || op === "notSelected") return rule(src, op, cc);
        if (op === "eq" || op === "ne") return rule(src, op === "eq" ? "selected" : "notSelected", cc);
        return rule(src, opName(op), x.value ?? cc);
      }
      if (op === "countGte" || op === "countLte" || op === "countEq") {
        const vn = built.find((b) => b.id === qid)?.variableName ?? r.id;
        return rule({ kind: "expr", ref: `COUNT(${vn})` }, op === "countGte" ? "gte" : op === "countLte" ? "lte" : "eq", x.value);
      }
      if (op === "in" || op === "notIn") {
        const vals = (Array.isArray(x.value) ? x.value : [x.value]).map((v) => optionCode(r.id, String(v)) ?? v);
        return rule(src, op, vals);
      }
      let value = x.value;
      // a value spoken as a choice id resolves to its code
      if (typeof value !== "undefined" && !Array.isArray(value)) { const cc = optionCode(r.id, String(value)); if (cc !== undefined && (op === "eq" || op === "ne")) return rule(src, op === "eq" ? "selected" : "notSelected", cc); }
      return rule(src, opName(op), value);
    };
    return walk(e);
  };
  const reportUnconverted = (e: CExpr | undefined, location: string, what: string) => {
    // …unless the reader already reported exactly the part it could not read: one problem, one line in the report
    const raws: string[] = [];
    const collect = (x: CExpr) => { if (x.t === "raw") raws.push(x.text); else if (x.t === "group") x.children.forEach(collect); };
    if (e) collect(e);
    const reported = raws.length > 0 && raws.every((t) => c.issues.some((i) => i.severity === "high" && i.message.includes(t)));
    if (e && exprHasRaw(e) && !reported) issues.push({ location, type: "custom_logic", severity: "high", message: `${what} was not converted, because part of it could not be read: ${describe(e)}.`, suggestion: "Rebuild it in the Logic builder. The source logic is kept in the question's notes.", autoAttempted: true });
  };

  if (logic) {
    for (const cq of c.questions) {
      const q = built.find((b) => b.id === idOf.get(cq.sourceId));
      if (!q) continue;
      const loc = `${cq.sourceId} · display logic`;
      const dl = cond(cq.displayLogic, loc);
      if (dl) q.displayLogic = dl;
      else if (cq.displayLogic) { reportUnconverted(cq.displayLogic, loc, `${cq.variable}'s display logic`); q.notes = `${q.notes ?? ""}\nSource display logic (not converted): ${describe(cq.displayLogic)}`.trim(); }
      cq.options.forEach((o, i) => {
        if (!o.displayLogic) return;
        const oc = cond(o.displayLogic, `${cq.sourceId} · option ${o.sourceId} display logic`);
        if (oc && q.options?.[i]) (q.options[i] as { visibleIf?: Condition }).visibleIf = oc;
      });
    }
  }

  /* ------------------------------------------------------------ flow */
  const flowMap = new Map<string, string>(); // source flow id → rescript node id
  const blockOfQuestion = new Map<string, string>(); // rescript question id → rescript block/page id
  const skipEndOfBlock: { q: Question; idx: number; blockNode: string }[] = [];
  const buildFlow = (fs: CFlow[]): FlowNode[] => {
    const out: FlowNode[] = [];
    for (const f of fs) {
      switch (f.t) {
        case "block": {
          const pages = f.pages.map((p) => p.map((sid) => idOf.get(sid)).filter((x): x is string => !!x && !reuse.has(c.questions.find((q) => idOf.get(q.sourceId) === x)?.sourceId ?? "")));
          const nonEmpty = pages.filter((p) => p.length);
          if (!nonEmpty.length) break;
          const bid = nodeId(f.sourceId);
          flowMap.set(f.sourceId, bid);
          mapping.push({ kind: "block", source: f.sourceId + (f.title ? ` (${f.title})` : ""), rescript: bid });
          let node: FlowNode;
          if (nonEmpty.length === 1) node = { type: "page", id: bid, ...(f.title ? { title: f.title } : {}), questionIds: nonEmpty[0] } as FlowNode;
          else {
            const children = nonEmpty.map((p, i) => ({ type: "page", id: nodeId(`${bid}_p${i + 1}`), questionIds: p }) as FlowNode);
            node = { type: "block", id: bid, ...(f.title ? { title: f.title } : {}), children } as FlowNode;
          }
          for (const p of nonEmpty) for (const qid of p) blockOfQuestion.set(qid, bid);
          if (structure && f.randomizeQuestions) {
            const pagesOf = node.type === "page" ? [node] : (node as { children: FlowNode[] }).children;
            if (pagesOf.every((p) => (p as { questionIds: string[] }).questionIds.length === 1) && pagesOf.length > 1) {
              const rnd = { type: "randomizer", id: nodeId(`${bid}_random`), children: pagesOf } as FlowNode;
              node = node.type === "page" ? rnd : ({ ...(node as object), children: [rnd] } as FlowNode);
            } else {
              issues.push({ location: `Block ${f.title ?? f.sourceId}`, type: "converted", severity: "medium", message: `Block “${f.title ?? f.sourceId}” randomizes the order of its questions. Rescript randomizes pages, not questions on one page, so the order was left fixed.`, suggestion: "Put each question on its own page and wrap the pages in a randomizer, if the order must vary.", autoAttempted: true });
            }
          }
          if (structure && f.loop) {
            const lp = f.loop;
            const lid = nodeId(`${bid}_loop`);
            const loopVar = IDENT.test(lp.loopVar) ? lp.loopVar : "item";
            let source: Record<string, unknown> | null = null;
            let references: Record<string, unknown> | undefined;
            if (lp.kind === "question" && lp.questionId) {
              const qid = idOf.get(lp.questionId);
              if (qid) source = { kind: "question", questionId: qid, ...(lp.filter && lp.filter !== "all" ? { filter: lp.filter } : { filter: "all" }) };
              else issues.push({ location: `Loop on ${f.title ?? f.sourceId}`, type: "reference", severity: "high", message: `The loop repeats over ${lp.questionId}, which is not in the imported survey.`, autoAttempted: true });
            } else if (lp.kind === "static") {
              source = { kind: "static", items: (lp.items ?? []).map((it) => ({ code: String(it.code), label: it.label })) };
              const names = (lp.fieldNames ?? []).map((n) => (IDENT.test(n) ? n : safeIdent(n))).filter((n) => n !== "label");
              if (names.length) {
                references = { columns: names.map((name) => ({ name })), values: Object.fromEntries((lp.items ?? []).map((it) => [String(it.code), Object.fromEntries(names.map((n) => [n, it.fields?.[n] ?? it.fields?.[n.replace(/^field/, "")] ?? ""]))])) };
              }
            }
            if (source) {
              node = { type: "loop", id: lid, title: f.title ? `Loop: ${f.title}` : "Loop", loopVar, source, ...(references ? { references } : {}), ...(lp.randomize ? { order: { kind: "random" } } : {}), children: [node] } as unknown as FlowNode;
              mapping.push({ kind: "loop", source: `${f.sourceId} loop`, rescript: lid });
            }
          }
          out.push(node);
          break;
        }
        case "embedded": {
          if (!structure) break;
          const fields = f.fields.map((x) => embField(x)).filter((x): x is NonNullable<typeof x> => !!x);
          if (!fields.length) break;
          const id = nodeId(f.sourceId);
          flowMap.set(f.sourceId, id);
          mapping.push({ kind: "embedded", source: f.sourceId, rescript: id });
          out.push({ type: "embedded_data", id, fields } as FlowNode);
          break;
        }
        case "branch": {
          const children = buildFlow(f.children);
          if (!structure) { out.push(...children); break; }
          const id = nodeId(f.sourceId);
          flowMap.set(f.sourceId, id);
          mapping.push({ kind: "branch", source: f.sourceId, rescript: id });
          let when = logic ? cond(f.when, `Flow · branch ${f.sourceId}`) : null;
          if (!when) {
            if (logic && f.when) reportUnconverted(f.when, `Flow · branch ${f.sourceId}`, `The condition of branch “${f.description ?? f.sourceId}”`);
            when = { type: "group", op: "and", children: [] } as Condition;
            if (logic && exprHasRaw(f.when)) issues.push({ location: `Flow · branch ${f.sourceId}`, type: "custom_logic", severity: "high", message: `Branch “${f.description ?? f.sourceId}” now applies to everyone, because its condition could not be converted.`, suggestion: "Set its condition in Architect before fielding.", autoAttempted: true });
          }
          out.push({ type: "branch", id, ...(f.description ? { title: f.description.slice(0, 120) } : {}), branches: [{ id: nodeId(`${id}_arm`), label: f.description?.slice(0, 80), when, children }], otherwise: [] } as unknown as FlowNode);
          break;
        }
        case "randomizer": {
          const children = buildFlow(f.children);
          if (!structure) { out.push(...children); break; }
          const id = nodeId(f.sourceId);
          mapping.push({ kind: "randomizer", source: f.sourceId, rescript: id });
          out.push({ type: "randomizer", id, ...(f.show ? { show: f.show } : {}), ...(f.even ? { evenPresentation: true } : {}), children } as FlowNode);
          break;
        }
        case "group": {
          const children = buildFlow(f.children);
          if (!structure) { out.push(...children); break; }
          const id = nodeId(f.sourceId);
          mapping.push({ kind: "group", source: f.sourceId, rescript: id });
          out.push({ type: "section", id, ...(f.title ? { title: f.title } : {}), children } as FlowNode);
          break;
        }
        case "end": {
          if (!structure) break;
          const id = nodeId(f.sourceId);
          mapping.push({ kind: "end", source: f.sourceId, rescript: id });
          out.push({ type: "end", id, status: f.status, ...(f.redirectUrl ? { redirectUrl: f.redirectUrl } : {}) } as FlowNode);
          break;
        }
        case "quota_check": break; // placed after quotas are built
        case "unsupported": break;
      }
    }
    return out;
  };
  const embField = (x: CanonicalEmbeddedField) => {
    const name = IDENT.test(x.name) ? x.name : safeIdent(x.name);
    if (takenFields.has(name.toUpperCase())) { issues.push({ location: `Embedded ${x.name}`, type: "renamed", severity: "low", message: `Embedded variable ${x.name} already exists in this survey; the imported one was merged into it.`, autoAttempted: true }); return null; }
    takenFields.add(name.toUpperCase());
    if (name !== x.name) mapping.push({ kind: "embedded", source: x.name, rescript: name, reason: "not a valid variable name" });
    else mapping.push({ kind: "embedded", source: x.name, rescript: name });
    let value = x.value;
    let source = x.source;
    if (source === "expression" && value) {
      const one = /^\{\{@(\w+)\}\}$/.exec(value.trim());
      if (one && idOf.has(one[1])) value = built.find((b) => b.id === idOf.get(one[1]))?.variableName ?? value;
      else if (/\{\{@/.test(value)) { issues.push({ location: `Embedded ${x.name}`, type: "converted", severity: "medium", message: `Embedded variable ${x.name} is set from “${x.value}”, which is not an expression Rescript can evaluate; it was imported as a fixed value.`, suggestion: "Rewrite its value as an expression in Architect.", autoAttempted: true }); source = "static"; }
    }
    const dataType = x.dataType && x.dataType !== "string" ? x.dataType : undefined;
    return { name, source, ...(value !== undefined ? { value } : {}), ...(dataType ? { dataType } : {}) };
  };

  let flow = buildFlow(c.flow);
  if (structure && c.embedded.length) {
    const fields = c.embedded.map(embField).filter((x): x is NonNullable<typeof x> => !!x);
    if (fields.length) { const id = nodeId("embedded_sample"); flow.unshift({ type: "embedded_data", id, title: "Sample / URL variables", fields } as FlowNode); }
  }
  // questions the flow does not place (a flat document, a quick scope) — one page each, in order
  const placed = new Set<string>([...blockOfQuestion.keys()]);
  const loose = built.filter((q) => !placed.has(q.id));
  if (loose.length) {
    if (!structure || !c.flow.length) for (const q of loose) { const id = nodeId(`p_${q.id}`); flow.push({ type: "page", id, questionIds: [q.id] } as FlowNode); blockOfQuestion.set(q.id, id); }
    else issues.push({ location: "flow", type: "structure", severity: "low", message: `${loose.length} question${loose.length === 1 ? " is" : "s are"} not placed on any page by the source flow: ${loose.slice(0, 8).map((q) => q.code).join(", ")}${loose.length > 8 ? "…" : ""}.`, suggestion: "Place them in Architect, or delete them.", autoAttempted: false });
  }

  /* ------------------------------------------------------------ quotas */
  const quotas: Quota[] = [];
  if (logic) {
    for (const cq of c.quotas) {
      const when = cond(cq.when, `Quota ${cq.name}`);
      if (!when) { reportUnconverted(cq.when, `Quota ${cq.name}`, `Quota “${cq.name}”`); continue; }
      /* a member of a source quota GROUP is a cell of the group's one quota */
      if (cq.group) {
        const gq = quotas.find((q) => (q as { __group?: string }).__group === cq.group!.id);
        if (gq) {
          const cid = unique(`${gq.id}_${safeIdent(cq.sourceId)}`, new Set(gq.cells.map((x) => x.id)));
          gq.cells.push({ id: cid, label: cq.name, when, limit: cq.limit, limitType: "count" } as never);
          mapping.push({ kind: "quota", source: cq.sourceId, rescript: gq.id });
          continue;
        }
      }
      const id = unique(safeIdent(cq.group ? cq.group.id : cq.sourceId), new Set([...(existing?.quotas.map((q) => q.id) ?? []), ...quotas.map((q) => q.id)]));
      mapping.push({ kind: "quota", source: cq.sourceId, rescript: id });
      quotas.push({ id, name: cq.group ? cq.group.name : cq.name, mode: "hard", cells: [{ id: `${id}_cell`, label: cq.name, when, limit: cq.limit, limitType: "count" }], onFull: { kind: cq.onFull === "continue" ? "flag" : cq.onFull }, countStatus: ["complete"], ...(cq.group ? { __group: cq.group.id } : {}) } as unknown as Quota);
    }
    for (const q of quotas) delete (q as { __group?: string }).__group;
    if (quotas.length) {
      // a quota is checked once the answers it reads are known: after the last block that asks them
      const reads = (q: Quota) => { const s = new Set<string>(); const w = (x: Condition) => { const g = x as { type: string; children?: Condition[]; source?: { kind: string; ref: string } }; if (g.children) g.children.forEach(w); else if (g.source?.kind === "question") s.add(g.source.ref); }; for (const cell of q.cells) w(cell.when); return s; };
      const topIndex = (qid: string) => flow.findIndex((n) => JSON.stringify(n).includes(`"${qid}"`));
      const endAt = flow.findIndex((n) => n.type === "end");
      const groups = new Map<number, string[]>();
      for (const q of quotas) { const idx = Math.max(-1, ...[...reads(q)].map(topIndex)); const at = idx >= 0 ? idx + 1 : endAt >= 0 ? endAt : flow.length; (groups.get(at) ?? groups.set(at, []).get(at)!).push(q.id); }
      for (const at of [...groups.keys()].sort((a, b) => b - a)) flow.splice(at, 0, { type: "quota_check", id: nodeId(`quota_check_${at}`), quotaIds: groups.get(at)!, onFull: { kind: "terminate" } } as FlowNode);
    }
  }

  /* ------------------------------------------------------------ skip logic (targets need the flow) */
  if (logic) {
    const blocksInOrder = () => listBlocks(flow as unknown[]);
    for (const cq of c.questions) {
      const q = built.find((b) => b.id === idOf.get(cq.sourceId));
      if (!q) continue;
      for (const sk of cq.skips) {
        const loc = `${cq.sourceId} · skip logic`;
        const when = cond(sk.when, loc);
        if (!when) { reportUnconverted(sk.when, loc, `A skip rule on ${cq.variable}`); q.notes = `${q.notes ?? ""}\nSource skip (not converted): ${sk.label ?? describe(sk.when)}`.trim(); continue; }
        const target = skipTarget(sk.to, q, blocksInOrder, idOf, flowMap, blockOfQuestion);
        if (!target) { issues.push({ location: loc, type: "reference", severity: "high", message: `A skip on ${cq.variable} goes to ${JSON.stringify(sk.to)}, which is not in the imported survey.`, autoAttempted: true, refs: [cq.sourceId] }); continue; }
        (q.skipLogic as unknown[]).push({ id: uid("sk"), ...(sk.label ? { label: sk.label.slice(0, 120) } : {}), when, target });
      }
    }
  }

  /* ------------------------------------------------------------ piping: {{@QID}} → {{CODE}} */
  const codeOf = new Map<string, string>();
  for (const [src, id] of idOf) { const q = built.find((b) => b.id === id) ?? existing?.questions.find((e) => e.id === id); if (q) codeOf.set(src, q.code); }
  const pipe = (s: string | undefined, where: string): string | undefined => s?.replace(/\{\{@(\w+)((?:\[[^\]]*\])?(?:\.\w+)?)\}\}/g, (m, src: string, rest: string) => {
    const code = codeOf.get(src);
    if (code) return `{{${code}${rest}}}`;
    issues.push({ location: where, type: "reference", severity: "low", message: `Piped text refers to ${src}, which is not in the imported survey.`, autoAttempted: true, refs: [src] });
    return `[${src}]`;
  });
  for (const q of built) {
    q.text = pipe(q.text, q.code) ?? "";
    for (const o of q.options ?? []) o.label = pipe(o.label, `${q.code} options`) ?? "";
    for (const r of q.rows ?? []) r.label = pipe(r.label, `${q.code} rows`) ?? "";
  }

  /* ------------------------------------------------------------ an end, always */
  if (!flow.some((n) => n.type === "end") || flow[flow.length - 1]?.type !== "end") {
    if (!existing) flow.push({ type: "end", id: nodeId("end_complete"), status: "complete" } as FlowNode);
  }

  /* ------------------------------------------------------------ assemble */
  // survey-level custom code (a Decipher top-level exec, a Qualtrics header script): kept the same way
  for (const cu of c.custom) scripts.push(scriptFor(cu, null));
  const qidOf = (refs: string[] | undefined, location: string): string | undefined => {
    for (const r of [...(refs ?? []), location.split(/\s|·/)[0]]) { const id = idOf.get(r); if (id) return id; }
    return undefined;
  };
  const review = sortIssues([...c.issues, ...issues]).filter((i) => i.severity === "high" || (i.severity === "medium" && i.type !== "converted")).slice(0, 300)
    .map((i) => ({ location: i.location, type: i.type, severity: i.severity, message: i.message, ...(i.suggestion ? { suggestion: i.suggestion } : {}), ...(i.refs?.length ? { refs: i.refs } : {}), ...(qidOf(i.refs, i.location) ? { questionId: qidOf(i.refs, i.location) } : {}) }));
  const record = { id: uid("import"), platform: c.source.platform, format: c.source.format, fileName: c.source.fileName, fingerprint: c.source.fingerprint, importedAt: now, scope, mode: existing ? "merge" : "new", map: mapping.filter((e) => (e.kind !== "option" && e.kind !== "row") || e.reason), review };
  let raw: unknown;
  if (existing) {
    const ex = structuredClone(existing) as SurveyDefinition;
    const endAt = (ex.flow as FlowNode[]).findIndex((n, i, all) => n.type === "end" && i === all.length - 1);
    const at = endAt >= 0 ? endAt : ex.flow.length;
    (ex.flow as FlowNode[]).splice(at, 0, ...flow.filter((n) => n.type !== "end"));
    ex.questions = [...ex.questions, ...built];
    ex.quotas = [...ex.quotas, ...quotas];
    ex.imports = [...(ex.imports ?? []), record as never];
    ex.scripts = [...(ex.scripts ?? []), ...scripts] as never;
    raw = ex;
  } else {
    raw = {
      meta: { id: opts.surveyId, code: safeIdent(c.source.title ?? c.source.fileName.replace(/\.[^.]+$/, "")).slice(0, 40).toUpperCase(), title: c.source.title || c.source.fileName.replace(/\.[^.]+$/, ""), version: "1.0" },
      questions: built, flow, quotas, imports: [record], scripts,
    };
  }
  const parsed = SurveyDefinition.safeParse(raw);
  const all = [...c.issues, ...issues];
  if (!parsed.success) {
    all.push(...parsed.error.issues.slice(0, 10).map((i): Issue => ({ location: i.path.join("."), type: "validation", severity: "high", message: `The imported survey did not pass the schema: ${i.message}`, autoAttempted: false })));
    return { def: null, mapping, issues: sortIssues(all), created: canonicalStats(c), confidence, merge, quality: null };
  }
  const def = parsed.data;
  /* post-migration validation (§31): the engine's own quality check — references, flow, variables, logic */
  let quality: MapResult["quality"] = null;
  try {
    const qc = runQualityCheck(def);
    const found = qc.areas.flatMap((a) => a.issues.map((i) => ({ ...i, area: a.label })));
    const imported = new Set(built.map((b) => b.id));
    // in a merge, report what the import touched — the survey's own older warnings are not the import's
    const relevant = found.filter((i) => !existing || !i.questionId || imported.has(i.questionId));
    const where = (i: (typeof found)[number]) => `${i.area}${i.questionCode ? ` · ${i.questionCode}` : ""}`;
    quality = { errors: relevant.filter((i) => i.level === "error").map((i) => `${where(i)}: ${i.message}`), warnings: relevant.filter((i) => i.level !== "error").map((i) => `${where(i)}: ${i.message}`), deployable: qc.deployable };
    for (const i of relevant.filter((x) => x.level === "error").slice(0, 60)) all.push({ location: where(i), type: "validation", severity: "high", message: i.message, autoAttempted: false, ...(i.questionId ? { refs: [i.questionId] } : {}) });
    for (const i of relevant.filter((x) => x.level !== "error").slice(0, 60)) all.push({ location: where(i), type: "validation", severity: "low", message: i.message, autoAttempted: false, ...(i.questionId ? { refs: [i.questionId] } : {}) });
  } catch (e) { all.push({ location: "validation", type: "validation", severity: "medium", message: `The quality check could not run: ${(e as Error).message}`, autoAttempted: false }); }
  return { def, mapping, issues: sortIssues(all), created: createdStats(def, built, existing), confidence, merge, quality };
}

function opName(op: string): string {
  return ({ selected: "selected", notSelected: "notSelected", eq: "eq", ne: "ne", gt: "gt", gte: "gte", lt: "lt", lte: "lte", answered: "answered", unanswered: "unanswered", contains: "contains", notContains: "notContains", matches: "matches", in: "in", notIn: "notIn" } as Record<string, string>)[op] ?? "eq";
}

function skipTarget(to: CSkipTarget, q: Question, blocks: () => ReturnType<typeof listBlocks>, idOf: Map<string, string>, flowMap: Map<string, string>, blockOf: Map<string, string>): Record<string, unknown> | null {
  switch (to.kind) {
    case "question": { const id = idOf.get(to.id); return id ? { kind: "question", ref: id } : null; }
    case "block": { const id = flowMap.get(to.id) ?? idOf.get(to.id); if (!id) return null; return idOf.has(to.id) ? { kind: "question", ref: id } : { kind: "block", ref: id }; }
    case "end": return to.status === "complete" ? { kind: "end" } : { kind: "terminate", status: to.status };
    case "url": return { kind: "url", ref: to.url };
    case "end_of_block": {
      const mine = blockOf.get(q.id);
      const list = blocks();
      const i = list.findIndex((b) => b.id === mine || b.pages.some((p) => p.node.id === mine));
      const next = i >= 0 ? list[i + 1] : undefined;
      if (!next) return { kind: "end" };
      return { kind: next.wrapped ? "block" : "page", ref: next.id };
    }
  }
}

function createdStats(def: SurveyDefinition, built: Question[], existing: SurveyDefinition | null): CanonicalStats {
  const ids = new Set(built.map((q) => q.id));
  const mine = (n: FlowNode) => !existing || !JSON.stringify(existing.flow).includes(`"id":"${n.id}"`);
  let blocks = 0, pages = 0, breaks = 0, emb = 0, branches = 0, rand = 0, loops = 0;
  const walk = (ns: FlowNode[]) => { for (const n of ns) { if (!mine(n)) continue; const k = n as { children?: FlowNode[]; branches?: { children: FlowNode[] }[] }; if (n.type === "embedded_data") emb += n.fields.length; if (n.type === "branch") branches++; if (n.type === "randomizer") rand++; if (n.type === "loop") loops++; if (k.children) walk(k.children); if (k.branches) for (const b of k.branches) walk(b.children); } };
  walk(def.flow as FlowNode[]);
  for (const b of listBlocks(def.flow as unknown[])) { if (!b.pages.some((p) => p.node.questionIds.some((q) => ids.has(q)))) continue; blocks++; pages += b.pages.length; breaks += b.pages.length - 1; }
  const qs = def.questions.filter((q) => ids.has(q.id));
  return {
    questions: qs.filter((q) => q.type !== "html").length, blocks, pages, pageBreaks: breaks, embeddedFields: emb,
    hiddenVariables: qs.filter((q) => q.type === "hidden" || q.type === "calculated").length,
    displayLogic: qs.filter((q) => q.displayLogic).length + qs.reduce((n, q) => n + (q.options ?? []).filter((o) => o.visibleIf).length, 0),
    skipLogic: qs.reduce((n, q) => n + (q.skipLogic?.length ?? 0), 0), branches, randomizers: rand, loops,
    quotas: def.quotas.length - (existing?.quotas.length ?? 0), customLogic: 0, validations: qs.reduce((n, q) => n + (q.validation?.length ?? 0), 0),
  };
}

const SEV = { high: 0, medium: 1, low: 2, info: 3 } as const;
export function sortIssues(xs: Issue[]): Issue[] { return [...xs].sort((a, b) => SEV[a.severity] - SEV[b.severity]); }

export type { CanonicalStats };
