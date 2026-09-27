import type {
  CanonicalSurvey, CanonicalQuestion, CanonicalOption, CanonicalRow, CanonicalValidation, CanonicalCustom,
  CanonicalEmbeddedField, CFlow, CExpr, CRef, COp, CLoop, CanonicalKind, Issue,
} from "../canonical.js";
import { plainText } from "../canonical.js";
import { parseXml, kids, kid, type XmlNode } from "../xml.js";

/**
 * DECIPHER XML → CANONICAL (§2, §4–§9 for Decipher).
 *
 * A Decipher project is one XML document: `<survey>` holding, in respondent
 * order, questions (`<radio>`, `<checkbox>`, `<select>`, `<text>`,
 * `<textarea>`, `<number>`, `<float>`, `<html>`), page breaks
 * (`<suspend/>`), containers (`<block>`, `<loop>`), flow control (`<term>`
 * ends the interview, `<goto>` jumps), Python (`<exec>`, `<validate>`, every
 * `cond="…"`), sample sources (`<var>` URL variables) and quota markers.
 *
 * A question's dimensions decide its kind: rows alone are options; rows and
 * columns make a grid; a `<number>` with rows is a numeric list. Its
 * `label` is its identity AND its variable, so `q7` stays `q7`.
 *
 * Conditions are Python. The common vocabulary — `q1.r2`, `q1.r2.c3`,
 * `q3.ival > 17`, `q2.any`, `q2.count >= 2`, `and / or / not`, `in` — is
 * translated; anything else is kept as `raw` Python with the question labels
 * it mentions, and reported. Required-ness follows Decipher's default: every
 * question is required unless it says `optional="1"`.
 */

const QTAGS = new Set(["radio", "checkbox", "select", "text", "textarea", "number", "float", "html", "autosum", "rank"]);

export function readDecipher(text: string, fileName: string, fp: string): CanonicalSurvey {
  const issues: Issue[] = [];
  const doc = parseXml(text, { keepInner: (n) => n === "title" || n === "comment" || n === "row" || n === "col" || n === "choice" || n === "html" || n === "noanswer" || n === "term" || n === "exec" || n === "validate" });
  for (const e of doc.errors.slice(0, 5)) issues.push({ location: fileName, type: "parse", severity: "low", message: `XML: ${e}`, autoAttempted: true });
  const root = doc.root;
  const base = { platform: "decipher" as const, format: "decipher" as const, fileName, fingerprint: fp };
  if (!root || root.name !== "survey") {
    return { source: base, questions: [], flow: [], embedded: [], quotas: [], custom: [], issues: [...issues, { location: fileName, type: "parse", severity: "high", message: "The XML has no <survey> root.", autoAttempted: false }] };
  }

  const questions = new Map<string, CanonicalQuestion>();
  const dims = new Map<string, { rows: boolean; cols: boolean }>();
  const custom: CanonicalCustom[] = [];
  const embedded: CanonicalEmbeddedField[] = [];
  const defines = new Map<string, XmlNode[]>();
  for (const d of findDeep(root, "define")) if (d.attrs.label) defines.set(d.attrs.label, kids(d, "row"));

  /* sample sources: the URL variables a panel passes in */
  for (const ss of findDeep(root, "samplesources")) {
    for (const v of findDeep(ss, "var")) {
      const name = v.attrs.name;
      if (name && !embedded.some((e) => e.name === name)) embedded.push({ name, source: "url", dataType: "string", sourceType: `sample source variable${v.attrs.unique === "1" ? " (unique)" : ""}` });
    }
  }

  /* first pass: every question, so conditions can resolve labels */
  const collectQ = (n: XmlNode) => { for (const c of n.children) { if (QTAGS.has(c.name) && c.attrs.label) { const q = readQuestion(c, defines, issues); questions.set(q.sourceId, q); dims.set(q.sourceId, { rows: q.rows.length > 0, cols: q.kind.startsWith("matrix") }); } else if (c.name === "block" || c.name === "loop") collectQ(c); } };
  collectQ(root);

  const cond = (src: string | undefined, location: string): CExpr | undefined => {
    if (!src || src.trim() === "1" || src.trim() === "True") return undefined;
    return readPython(src, location, questions, issues);
  };

  /* second pass: the flow */
  let lastQ: CanonicalQuestion | null = null;
  const readChildren = (n: XmlNode, path: string): CFlow[] => {
    const out: CFlow[] = [];
    let pages: string[][] = [[]];
    let blockSeq = 0;
    const flush = () => {
      const ps = pages.filter((p) => p.length);
      if (ps.length) out.push({ t: "block", sourceId: `${path}_part${++blockSeq}`, pages: ps });
      pages = [[]];
    };
    for (const c of n.children) {
      if (QTAGS.has(c.name) && c.attrs.label) {
        const q = questions.get(c.attrs.label)!;
        q.displayLogic = cond(c.attrs.cond, `${q.sourceId} · cond`);
        for (const r of kids(c, "row")) { const o = q.options.find((x) => x.sourceId === r.attrs.label); if (o && r.attrs.cond) o.displayLogic = cond(r.attrs.cond, `${q.sourceId}.${r.attrs.label} · cond`); }
        pages[pages.length - 1].push(q.sourceId);
        lastQ = q;
      } else if (c.name === "suspend") {
        if (pages[pages.length - 1].length) pages.push([]);
      } else if (c.name === "block") {
        flush();
        const inner = readChildren(c, c.attrs.label || `${path}_block`);
        const when = cond(c.attrs.cond, `block ${c.attrs.label ?? "?"} · cond`);
        const randomize = c.attrs.randomize === "1" || c.attrs.randomizeChildren === "1";
        const group: CFlow = { t: "group", sourceId: c.attrs.label || `${path}_b${out.length}`, title: c.attrs.builder_title || c.attrs["builder:title"] || c.attrs.label, children: randomize ? [{ t: "randomizer", sourceId: `${c.attrs.label}_rand`, children: inner }] : inner };
        out.push(when ? { t: "branch", sourceId: `${c.attrs.label}_cond`, when, children: [group], description: `block ${c.attrs.label} cond` } : group);
      } else if (c.name === "loop") {
        flush();
        const loop = readLoop(c, issues);
        const inner = readChildren(c, c.attrs.label || `${path}_loop`);
        // the loop's questions sit in one or more blocks; the first block carries the loop
        // (a <block> inside the loop reads as a group; its pages are the loop's pages)
        const flat = (xs: CFlow[]): CFlow[] => xs.flatMap((x) => (x.t === "group" && !("when" in x) ? flat(x.children) : [x]));
        const body = flat(inner);
        const first = body.find((x) => x.t === "block") as Extract<CFlow, { t: "block" }> | undefined;
        if (first && body.length === 1) { first.loop = loop; first.title ??= c.attrs.label; out.push(first); }
        else { const holder: Extract<CFlow, { t: "block" }> = { t: "block", sourceId: c.attrs.label || "loop", title: c.attrs.label, pages: body.flatMap((x) => (x.t === "block" ? x.pages : [])), loop }; out.push(holder); if (body.some((x) => x.t !== "block")) issues.push({ location: `loop ${c.attrs.label}`, type: "converted", severity: "medium", message: `Loop ${c.attrs.label} contains flow elements besides questions; its questions were kept in the loop, the other elements were not.`, autoAttempted: true }); }
      } else if (c.name === "term") {
        flush();
        const when = cond(c.attrs.cond, `term ${c.attrs.label ?? ""} · cond`) ?? { t: "const", value: true } as CExpr;
        out.push({ t: "branch", sourceId: c.attrs.label || `term_${out.length}`, when, children: [{ t: "end", sourceId: `${c.attrs.label || "term"}_end`, status: "screened", message: plainText(c.inner ?? c.text) || undefined }], description: `terminate: ${plainText(c.inner ?? c.text)}` });
      } else if (c.name === "goto") {
        const target = c.attrs.target;
        if (lastQ && target) {
          const when = cond(c.attrs.cond, `goto ${target}`) ?? { t: "const", value: true } as CExpr;
          (lastQ as CanonicalQuestion).skips.push({ when, to: questions.has(target) ? { kind: "question", id: target } : { kind: "block", id: target } });
        } else issues.push({ location: `goto ${target ?? "?"}`, type: "structure", severity: "medium", message: "A <goto> with no question before it could not be attached.", autoAttempted: false });
      } else if (c.name === "exec") {
        const code = (c.inner ?? c.text).trim();
        if (code) {
          custom.push({ language: "python", code, location: lastQ ? `after ${(lastQ as CanonicalQuestion).sourceId}` : "survey start", role: `exec${c.attrs.when ? ` (${c.attrs.when})` : ""}`, refs: pyRefs(code, questions) });
          issues.push({ location: lastQ ? `exec after ${(lastQ as CanonicalQuestion).sourceId}` : "exec at survey start", type: "custom_logic", severity: "high", message: `Python <exec> code has no direct Rescript equivalent${pyRefs(code, questions).length ? ` (reads ${pyRefs(code, questions).join(", ")})` : ""}.`, suggestion: "It is kept, disabled, in Scripts. Ask “what could not be migrated?” in Intelligent mode and press Analyze; most execs set a hidden variable, which a calculation can do.", autoAttempted: false, refs: pyRefs(code, questions) });
        }
      } else if (c.name === "quota") {
        issues.push({ location: `quota ${c.attrs.label ?? c.attrs.sheet ?? ""}`, type: "unsupported", severity: "medium", message: `Quota marker ${c.attrs.sheet ?? c.attrs.label ?? ""}: Decipher keeps quota definitions in a separate quota sheet, which is not part of the XML.`, suggestion: "Recreate the cells in the Quotas tab (or import the quota sheet separately).", autoAttempted: false });
      } else if (["samplesources", "define", "res", "style", "themevars", "note", "condition", "pipe", "marker", "logic", "languages", "datasource"].includes(c.name)) {
        /* configuration, not flow: read elsewhere, or not needed */
      } else if (c.name === "finish") {
        flush();
        out.push({ t: "end", sourceId: "finish", status: "complete" });
      } else if (c.name && !c.name.startsWith("builder")) {
        issues.push({ location: `<${c.name}>`, type: "unsupported", severity: "low", message: `Decipher element <${c.name}> was not reproduced.`, autoAttempted: false });
      }
    }
    flush();
    return out;
  };
  const flow = readChildren(root, "survey");

  // named conditions: <condition label="adult" cond="q1.ival >= 18"/> are referenced as condition.adult — kept for the report
  for (const cn of findDeep(root, "condition")) if (cn.attrs.label && cn.attrs.cond) issues.push({ location: `condition.${cn.attrs.label}`, type: "converted", severity: "info", message: `Named condition ${cn.attrs.label} (${cn.attrs.cond}) is expanded wherever it is used.`, autoAttempted: true });

  return {
    source: { ...base, title: root.attrs.alt || root.attrs.name || undefined, language: root.attrs.language || undefined },
    questions: [...questions.values()], flow, embedded, quotas: [], custom, issues,
  };

  /* ------------------------------------------------------------ helpers */
}

function findDeep(n: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of n.children) { if (c.name === name) out.push(c); findDeep(c, name, out); }
  return out;
}

const inner = (n: XmlNode | undefined) => plainText(n ? n.inner ?? n.text : "");

function readQuestion(n: XmlNode, defines: Map<string, XmlNode[]>, issues: Issue[]): CanonicalQuestion {
  const label = n.attrs.label;
  const rowsX = [...kids(n, "row"), ...kids(n, "insert").flatMap((i) => defines.get(i.attrs.source) ?? [])];
  const colsX = kids(n, "col");
  const choicesX = kids(n, "choice");
  const noans = kids(n, "noanswer");
  const notes: string[] = [];
  const custom: CanonicalCustom[] = [];
  const hidden = n.attrs.where !== undefined && !/survey/.test(n.attrs.where);
  const optional = n.attrs.optional === "1";
  const toOpt = (x: XmlNode, i: number, exclusive = false): CanonicalOption => {
    const code = x.attrs.value ?? (/^[rc](\d+)$/.test(x.attrs.label ?? "") ? Number(/\d+/.exec(x.attrs.label)![0]) : x.attrs.label ?? String(i + 1));
    return { sourceId: x.attrs.label ?? `r${i + 1}`, code: /^-?\d+$/.test(String(code)) ? Number(code) : String(code), label: inner(x), ...(exclusive || x.attrs.exclusive === "1" ? { exclusive: true } : {}), ...(x.attrs.open === "1" ? { otherSpecify: true } : {}), ...(x.attrs.randomize === "0" ? { anchor: true } : {}) };
  };
  const toRow = (x: XmlNode, i: number): CanonicalRow => ({ sourceId: x.attrs.label ?? `r${i + 1}`, code: x.attrs.label ?? `r${i + 1}`, label: inner(x) });
  const q: CanonicalQuestion = {
    sourceId: label, variable: label, text: decipherPiping(inner(kid(n, "title"))), instruction: inner(kid(n, "comment")) || undefined,
    kind: "unknown", sourceType: n.name, options: [], rows: [], required: !optional && n.name !== "html", validation: [], skips: [], custom, confidence: "confirmed", notes,
  };
  const grid = rowsX.length > 0 && colsX.length > 0;
  const kind = (k: CanonicalKind) => { q.kind = k; };
  switch (n.name) {
    case "radio":
      if (grid) { kind("matrix_single"); q.rows = rowsX.map(toRow); q.options = colsX.map((x, i) => toOpt(x, i)); }
      else { kind("single"); q.options = (rowsX.length ? rowsX : colsX).map((x, i) => toOpt(x, i)); }
      break;
    case "checkbox":
      if (grid) { kind("matrix_multi"); q.rows = rowsX.map(toRow); q.options = colsX.map((x, i) => toOpt(x, i)); }
      else { kind("multi"); q.options = (rowsX.length ? rowsX : colsX).map((x, i) => toOpt(x, i)); }
      if (n.attrs.atleast && Number(n.attrs.atleast) > 1) q.validation.push({ kind: "min_selections", value: Number(n.attrs.atleast) });
      if (n.attrs.atmost) q.validation.push({ kind: "max_selections", value: Number(n.attrs.atmost) });
      if (n.attrs.exactly) { q.validation.push({ kind: "min_selections", value: Number(n.attrs.exactly) }, { kind: "max_selections", value: Number(n.attrs.exactly) }); }
      if (n.attrs.atleast === "0") q.required = false;
      break;
    case "select":
      q.options = choicesX.map((x, i) => toOpt(x, i));
      if (rowsX.length) { kind("matrix_dropdown"); q.rows = rowsX.map(toRow); } else kind("dropdown");
      break;
    case "text": case "textarea":
      if (rowsX.length || colsX.length) { kind(grid ? "matrix_text" : "text"); q.rows = (rowsX.length ? rowsX : colsX).map(toRow); }
      else kind(n.name === "textarea" ? "textarea" : "text");
      break;
    case "number": case "float":
      if (grid) { kind("matrix_numeric"); q.rows = rowsX.map(toRow); q.options = colsX.map((x, i) => toOpt(x, i)); notes.push("the columns of a numeric grid were kept as its column labels"); q.confidence = "review"; }
      else if (rowsX.length || colsX.length) { kind("matrix_numeric"); q.rows = (rowsX.length ? rowsX : colsX).map(toRow); }
      else kind("numeric");
      if (n.name === "number") q.validation.push({ kind: "integer" });
      break;
    case "autosum": kind("constant_sum"); q.options = rowsX.map((x, i) => toOpt(x, i)); if (n.attrs.amount) q.validation.push({ kind: "sum_equals", value: Number(n.attrs.amount) }); break;
    case "rank": kind("ranking"); q.options = rowsX.map((x, i) => toOpt(x, i)); break;
    case "html": kind("descriptive"); q.text = decipherPiping(plainText(n.inner ?? n.text)) || q.text; q.required = false; break;
  }
  for (const [i, x] of noans.entries()) q.options.push(toOpt(x, q.options.length + i, true));
  if (n.attrs.shuffle && /rows/.test(n.attrs.shuffle) || n.attrs.randomize === "1") q.randomizeOptions = true;
  if (hidden) {
    notes.push(`where="${n.attrs.where}" — not shown to respondents`);
    if (q.kind !== "descriptive") { q.settings = { ...(q.settings ?? {}), sourceKind: q.kind }; kind("hidden"); q.required = false; }
  }
  /* verify="…" */
  const verify = n.attrs.verify ?? "";
  for (const m of verify.matchAll(/(range|len)\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g)) {
    if (m[1] === "range") q.validation.push({ kind: "min_value", value: Number(m[2] ) }, { kind: "max_value", value: Number(m[3]) });
    else q.validation.push({ kind: "min_length", value: Number(m[2]) }, { kind: "max_length", value: Number(m[3]) });
  }
  if (/\bemail\b/.test(verify)) q.validation.push({ kind: "email" });
  if (/zipcode|postal/.test(verify)) q.validation.push({ kind: "zip" });
  if (/phone/.test(verify)) q.validation.push({ kind: "phone" });
  if (verify && !/^(?:\s*(?:range|len)\([^)]*\)|\s*email|\s*zipcode|\s*phone\w*|\s*digits|\s*,)+\s*$/.test(verify)) notes.push(`verify="${verify}" partly carried`);
  if (n.attrs.size && q.kind === "text") { /* display width, not validation */ }
  /* inline Python */
  for (const v of kids(n, "validate")) {
    const code = (v.inner ?? v.text).trim();
    if (!code) continue;
    custom.push({ language: "python", code, location: label, role: "validate", refs: [] });
    issues.push({ location: `${label} · <validate>`, type: "custom_logic", severity: "medium", message: `${label} has a Python <validate> block, which was not converted.`, suggestion: "Analyze it in Intelligent mode, or recreate it as a Condition validation rule.", autoAttempted: false, refs: [label] });
    q.confidence = "review";
  }
  for (const v of kids(n, "exec")) {
    const code = (v.inner ?? v.text).trim();
    if (!code) continue;
    custom.push({ language: "python", code, location: label, role: `exec in question${v.attrs.when ? ` (${v.attrs.when})` : ""}`, refs: [] });
    issues.push({ location: `${label} · <exec>`, type: "custom_logic", severity: "high", message: `${label} runs Python code, which has no direct Rescript equivalent.`, suggestion: hidden ? "A hidden question set by exec is usually a calculation — analyze it in Intelligent mode." : "Analyze it in Intelligent mode.", autoAttempted: false, refs: [label] });
    q.confidence = "review";
  }
  if (q.kind === "unknown") { q.confidence = "unsupported"; issues.push({ location: label, type: "unsupported", severity: "high", message: `${label} is a Decipher <${n.name}> with no Rescript equivalent.`, autoAttempted: false, refs: [label] }); }
  return q;
}

function readLoop(n: XmlNode, issues: Issue[]): CLoop {
  const vars = (n.attrs.vars ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const items = kids(n, "looprow").map((lr, i) => {
    const fields: Record<string, string> = {};
    for (const lv of kids(lr, "loopvar")) if (lv.attrs.name) fields[lv.attrs.name] = plainText(lv.inner ?? lv.text);
    return { code: lr.attrs.label ?? String(i + 1), label: fields[vars[0]] ?? lr.attrs.label ?? String(i + 1), fields };
  });
  if (!items.length) issues.push({ location: `loop ${n.attrs.label ?? ""}`, type: "structure", severity: "medium", message: `Loop ${n.attrs.label ?? ""} has no <looprow> items.`, autoAttempted: false });
  return { kind: "static", items, fieldNames: vars, loopVar: vars[0] || "item", randomize: n.attrs.randomizeChildren === "1" };
}

/** Decipher piping: [loopvar: brand], [pipe: name], ${q1.selected.text} */
export function decipherPiping(s: string): string {
  return s
    .replace(/\[loopvar:\s*(\w+)\s*\]/g, "{{loop.$1}}")
    .replace(/\$\{\s*(\w+)\.(?:selected\.text|text|val|ival|value)\s*\}/g, "{{@$1}}")
    .replace(/\$\{\s*(\w+)\s*\}/g, "{{@$1}}")
    .replace(/\[pipe:\s*(\w+)\s*\]/g, "{{@$1}}");
}

/* ------------------------------------------------------------ Python conditions */

type Tok = { k: "id" | "num" | "str" | "op" | "punct" | "kw"; v: string };

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|('[^']*'|"[^"]*")|(==|!=|<=|>=|<|>)|([()[\],])|(and|or|not|in|is)\b|([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) return null;
    i = re.lastIndex;
    if (m[1]) out.push({ k: "num", v: m[1] });
    else if (m[2]) out.push({ k: "str", v: m[2].slice(1, -1) });
    else if (m[3]) out.push({ k: "op", v: m[3] });
    else if (m[4]) out.push({ k: "punct", v: m[4] });
    else if (m[5]) out.push({ k: "kw", v: m[5] });
    else if (m[6]) out.push({ k: "id", v: m[6] });
  }
  return out;
}

const CMP: Record<string, COp> = { "==": "eq", "!=": "ne", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" };

export function readPython(src: string, location: string, questions: Map<string, CanonicalQuestion>, issues: Issue[]): CExpr {
  const raw = (reason: string): CExpr => {
    const refs = pyRefs(src, questions);
    issues.push({ location, type: "custom_logic", severity: "high", message: `The Python condition “${src.trim()}” could not be converted (${reason}).`, suggestion: "Rebuild it in the Logic builder, or analyze it in Intelligent mode.", autoAttempted: true, refs });
    return { t: "raw", text: src.trim(), language: "python", refs, reason };
  };
  const toks = tokenize(src);
  if (!toks) return raw("unrecognised syntax");
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => { const t = toks[p]; if (v && t?.v !== v) throw new Error(`expected ${v}`); p++; return t; };
  const orE = (): CExpr => { const parts = [andE()]; while (peek()?.v === "or") { eat(); parts.push(andE()); } return parts.length === 1 ? parts[0] : { t: "group", op: "or", children: parts }; };
  const andE = (): CExpr => { const parts = [notE()]; while (peek()?.v === "and") { eat(); parts.push(notE()); } return parts.length === 1 ? parts[0] : { t: "group", op: "and", children: parts }; };
  const notE = (): CExpr => {
    if (peek()?.v === "not") { eat(); const inner = notE(); if (inner.t === "cmp" && inner.op === "selected") return { ...inner, op: "notSelected" }; if (inner.t === "cmp" && inner.op === "answered") return { ...inner, op: "unanswered" }; return { t: "group", op: "not", children: [inner] }; }
    return cmpE();
  };
  const value = (): string | number | (string | number)[] => {
    const t = eat();
    if (t.k === "num") return Number(t.v);
    if (t.k === "str") return t.v;
    if (t.v === "[" || t.v === "(") { const close = t.v === "[" ? "]" : ")"; const items: (string | number)[] = []; while (peek() && peek().v !== close) { const v = value(); if (Array.isArray(v)) throw new Error("nested list"); items.push(v); if (peek()?.v === ",") eat(); } eat(close); return items; }
    if (t.k === "id") { const r = refOf(t.v); if (r.kind === "option") return r.code; }
    throw new Error(`unexpected ${t.v}`);
  };
  /** q1.r2 → selected; q1.r2.c3 → cell; q1.any; q1.count; q1.val / ival */
  const refOf = (id: string): { kind: "sel"; ref: CRef } | { kind: "val"; ref: CRef } | { kind: "any"; ref: CRef } | { kind: "count"; ref: CRef } | { kind: "option"; code: string | number } | { kind: "none" } => {
    const parts = id.split(".");
    const q = questions.get(parts[0]);
    if (!q) { const opt = /^r(\d+)$/.exec(id); return opt ? { kind: "option", code: Number(opt[1]) } : { kind: "none" }; }
    const ref: CRef = { kind: "question", id: q.sourceId };
    const rest = parts.slice(1);
    const grid = q.kind.startsWith("matrix");
    if (!rest.length) return { kind: "val", ref };
    const [a, b, c] = rest;
    if (a === "any") return { kind: "any", ref };
    if (a === "count") return { kind: "count", ref };
    if (a === "val" || a === "ival" || a === "unsafe_val" || a === "text") return { kind: "val", ref };
    const isRow = q.rows.some((r) => r.sourceId === a) || (!grid && q.options.some((o) => o.sourceId === a));
    if (!isRow) return { kind: "none" };
    if (grid) {
      ref.row = a;
      if (b && q.options.some((o) => o.sourceId === b)) { ref.choice = b; return c === undefined ? { kind: "sel", ref } : { kind: "none" }; }
      if (!b) return { kind: "any", ref };
      if (b === "val" || b === "ival") return { kind: "val", ref };
      return { kind: "none" };
    }
    ref.choice = a;
    if (!b) return q.kind === "single" || q.kind === "multi" || q.kind === "dropdown" || q.kind === "hidden" ? { kind: "sel", ref } : { kind: "val", ref: { ...ref, choice: undefined, row: a } };
    if (b === "val" || b === "ival") return { kind: "val", ref: { ...ref, choice: undefined, row: a } };
    return { kind: "none" };
  };
  const cmpE = (): CExpr => {
    const t = peek();
    if (!t) throw new Error("unexpected end");
    if (t.v === "(") { eat(); const e = orE(); eat(")"); return e; }
    if (t.k === "kw" && (t.v === "True" || t.v === "False")) { eat(); return { t: "const", value: t.v === "True" }; }
    if (t.k !== "id") throw new Error(`unexpected ${t.v}`);
    eat();
    if (t.v === "True" || t.v === "False") return { t: "const", value: t.v === "True" };
    const r = refOf(t.v);
    const next = peek();
    if (next && (next.k === "op" || next.v === "in" || (next.v === "not" && toks[p + 1]?.v === "in"))) {
      let op: COp;
      if (next.v === "not") { eat(); eat("in"); op = "notIn"; }
      else if (next.v === "in") { eat(); op = "in"; }
      else { eat(); op = CMP[next.v]; }
      const v = value();
      if (r.kind === "count") return { t: "cmp", ref: r.ref, op: op === "gte" ? "countGte" : op === "lte" ? "countLte" : op === "eq" ? "countEq" : op === "gt" ? "countGte" : "countLte", value: op === "gt" ? Number(v) + 1 : op === "lt" ? Number(v) - 1 : (v as number) };
      if (r.kind === "val" || r.kind === "sel" || r.kind === "any") return { t: "cmp", ref: r.ref, op, value: v };
      throw new Error(`cannot compare ${t.v}`);
    }
    if (next?.v === "(") throw new Error(`function call ${t.v}()`);
    if (r.kind === "sel") return { t: "cmp", ref: r.ref, op: "selected" };
    if (r.kind === "any") return { t: "cmp", ref: r.ref, op: "answered" };
    if (r.kind === "val") return { t: "cmp", ref: r.ref, op: "answered" };
    throw new Error(`${t.v} is not a question reference`);
  };
  try {
    const e = orE();
    if (p < toks.length) return raw(`unexpected “${toks[p].v}”`);
    return e;
  } catch (err) {
    return raw((err as Error).message);
  }
}

function pyRefs(code: string, questions: Map<string, CanonicalQuestion>): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/\b([A-Za-z_]\w*)(?=\.|\b)/g)) if (questions.has(m[1])) out.add(m[1]);
  return [...out];
}

export type { CanonicalValidation };
