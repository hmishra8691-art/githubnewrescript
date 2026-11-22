/**
 * MORE ADAPTERS (Level 5 roadmap I3 — 2026-11-29): Triple-S, SPSS syntax, SurveyMonkey, Alchemer and Forsta Plus,
 * each into the same canonical model every other reader produces, so mapping, the report, the review screen and
 * equivalence apply to them unchanged.
 *
 * What each format can carry decides what each reader claims:
 *
 *   Triple-S (.sss / .xml)       a data standard: variables, labels, codes, multiple-response spreads. No routing.
 *   SPSS syntax (.sps)           VARIABLE LABELS, VALUE LABELS, MISSING VALUES, MRSETS. No routing.
 *   SurveyMonkey (API JSON)      pages, questions by family / subtype, choices, rows, "other", required. Its skip
 *                                logic is not in the survey-details payload and is reported as not carried.
 *   Alchemer (API JSON)          pages, questions by type, options with reporting values, sub-questions of tables,
 *                                required. Logic rules are kept as raw text for review, never executed.
 *   Forsta Plus (project XML)    question elements (single, multi, open, numeric, grid, ranking, info), precodes,
 *                                masks and conditions — conditions kept as raw expressions for review.
 *
 * HOW THESE WERE BUILT: from each format's published structure, against synthetic fixtures written to it. None
 * has been run on a real client export yet, so every question from SurveyMonkey, Alchemer and Forsta Plus starts
 * at "review" confidence, and anything the reader does not recognise is listed, never dropped.
 */
import type { CanonicalSurvey, CanonicalQuestion, CanonicalOption, CanonicalRow, CFlow, Issue, SourceFormat, SourcePlatform, CanonicalKind } from "../canonical.js";
import { parseXml, kids, kid, allText, findAll, type XmlNode } from "../xml.js";

interface Meta { fileName: string; fingerprint: string }
const isInt = (s: string) => /^-?\d+$/.test(s);
const code = (s: string | number): string | number => (typeof s === "number" ? s : isInt(s.trim()) ? Number(s.trim()) : s.trim());
const strip = (s: unknown) => String(s ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const safeVar = (s: string, fallback: string) => (s.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "Q$1") || fallback).slice(0, 60);

function survey(platform: SourcePlatform, format: SourceFormat, meta: Meta, title: string | undefined, questions: CanonicalQuestion[], pages: string[][], issues: Issue[], extra: Partial<CanonicalSurvey> = {}): CanonicalSurvey {
  const flow: CFlow[] = [{ t: "block", sourceId: "b1", title: title ?? "Imported", pages: pages.filter((p) => p.length) }];
  return { source: { platform, format, fileName: meta.fileName, ...(title ? { title } : {}), fingerprint: meta.fingerprint }, questions, flow, embedded: [], quotas: [], custom: [], issues, ...extra };
}
function q(sourceId: string, variable: string, text: string, kind: CanonicalKind, sourceType: string, confidence: CanonicalQuestion["confidence"], note: string, extra: Partial<CanonicalQuestion> = {}): CanonicalQuestion {
  return { sourceId, variable, text: text || variable, kind, sourceType, options: [], rows: [], required: false, validation: [], skips: [], custom: [], confidence, notes: [note], ...extra };
}

/* ================================================================ Triple-S */

export function looksTripleS(text: string): boolean { return /<sss[\s>]/i.test(text) && /<variable[\s>]/i.test(text); }

export function readTripleS(text: string, meta: Meta): CanonicalSurvey {
  const doc = parseXml(text);
  const issues: Issue[] = doc.errors.map((e) => ({ location: meta.fileName, type: "parse" as const, severity: "low" as const, message: `XML: ${e}`, autoAttempted: true }));
  const root = doc.root ?? undefined;
  const title = allText(kid(kid(root, "survey"), "title")) || undefined;
  const vars = findAll(root, (n) => n.name === "variable");
  const questions: CanonicalQuestion[] = [];
  const pages: string[][] = [];
  for (const v of vars) {
    const type = (v.attrs.type ?? "").toLowerCase();
    const name = allText(kid(v, "name")) || v.attrs.ident || `V${v.attrs.ident ?? questions.length + 1}`;
    const label = strip(allText(kid(v, "label")));
    const values = kids(kid(v, "values"), "value").map((x) => ({ sourceId: x.attrs.code ?? allText(x), code: code(x.attrs.code ?? allText(x)), label: strip(allText(x)) } as CanonicalOption));
    const id = safeVar(name, `V${questions.length + 1}`);
    if (/^(id|serial)$/i.test(name) || v.attrs.use === "serial") continue;
    if (type === "single") questions.push(q(id, id, label, "single", "Triple-S single", "high", "Triple-S single variable: its codes and labels are explicit.", { options: values }));
    else if (type === "multiple") {
      const spread = kid(v, "spread");
      questions.push(q(id, id, label, "multi", "Triple-S multiple", "high", `Triple-S multiple variable${spread ? ` (spread over ${spread.attrs.subfields ?? "?"} subfields)` : ""}: each code is one choice.`, { options: values }));
    } else if (type === "quantity") {
      const range = kid(kid(v, "values"), "range");
      questions.push(q(id, id, label, "numeric", "Triple-S quantity", "high", `Triple-S quantity${range ? ` from ${range.attrs.from} to ${range.attrs.to}` : ""}.`, range ? { validation: [{ kind: "min_value", value: Number(range.attrs.from) }, { kind: "max_value", value: Number(range.attrs.to) }] } : {}));
    } else if (type === "logical") questions.push(q(id, id, label, "single", "Triple-S logical", "high", "Triple-S logical variable: written as a yes / no single choice.", { options: [{ sourceId: "1", code: 1, label: "Yes" }, { sourceId: "0", code: 0, label: "No" }] }));
    else if (type === "character") questions.push(q(id, id, label, "text", "Triple-S character", "high", "Triple-S character variable."));
    else { issues.push({ location: name, type: "unsupported", severity: "medium", message: `Triple-S variable ${name} has type “${type || "none"}”, which is not single, multiple, quantity, logical or character.`, autoAttempted: false }); continue; }
    pages.push([id]);
  }
  issues.push({ location: meta.fileName, type: "inferred", severity: "info", message: "Triple-S describes the data, not the questionnaire: there is no routing, display logic, randomisation or required-answer setting to bring across, and none was invented.", autoAttempted: true });
  return survey("spreadsheet", "triples", meta, title, questions, pages, issues);
}

/* ================================================================ SPSS syntax */

export function looksSpssSyntax(text: string): boolean { return /^\s*(?:VARIABLE\s+LABELS|VALUE\s+LABELS|ADD\s+VALUE\s+LABELS)\b/im.test(text); }

/** one SPSS command: from its keyword to the terminating period at end of line */
function commands(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (/^\s*\*/.test(line) && !cur) continue;
    cur += (cur ? "\n" : "") + line;
    if (/\.\s*$/.test(line.replace(/'[^']*'|"[^"]*"/g, ""))) { out.push(cur.trim().replace(/\.\s*$/, "")); cur = ""; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const quoted = (s: string) => [...s.matchAll(/'((?:[^']|'')*)'|"((?:[^"]|"")*)"/g)].map((m) => (m[1] ?? m[2] ?? "").replace(/''/g, "'").replace(/""/g, '"'));

export function readSpssSyntax(text: string, meta: Meta): CanonicalSurvey {
  const labels = new Map<string, string>(), values = new Map<string, [string, string][]>(), missing = new Map<string, string[]>(), order: string[] = [];
  const mr: { name: string; kind: "md" | "mc"; label: string; vars: string[] }[] = [];
  const touch = (v: string) => { if (!order.includes(v)) order.push(v); };
  const issues: Issue[] = [];
  for (const cmd of commands(text)) {
    const head = cmd.split(/\s+/).slice(0, 3).join(" ").toUpperCase();
    if (/^VARIABLE LABELS?/.test(head)) {
      const body = cmd.replace(/^\s*VARIABLE\s+LABELS?/i, "");
      for (const part of body.split(/\s*\/\s*/)) { const m = /^\s*([A-Za-z@#$][\w.@#$]*)\s+(['"][\s\S]*)$/.exec(part); if (m) { labels.set(m[1]!, quoted(m[2]!)[0] ?? ""); touch(m[1]!); } }
    } else if (/^(?:ADD )?VALUE LABELS/.test(head)) {
      const body = cmd.replace(/^\s*(?:ADD\s+)?VALUE\s+LABELS/i, "");
      for (const part of body.split(/\s*\/\s*/)) {
        const m = /^\s*([A-Za-z@#$][\w.@#$\s]*?(?:\s+TO\s+[A-Za-z@#$][\w.@#$]*)?)\s+((?:-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")[\s\S]*)$/i.exec(part);
        if (!m) continue;
        const names = m[1]!.trim().split(/\s+/).filter((x) => x.toUpperCase() !== "TO");
        const pairs: [string, string][] = [];
        for (const pm of m[2]!.matchAll(/(-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")\s+('(?:[^']|'')*'|"(?:[^"]|"")*")/g)) pairs.push([pm[1]!.replace(/^['"]|['"]$/g, ""), quoted(pm[2]!)[0] ?? ""]);
        for (const n of names) { values.set(n, [...(values.get(n) ?? []), ...pairs]); touch(n); }
      }
    } else if (/^MISSING VALUES/.test(head)) {
      for (const m of cmd.matchAll(/([A-Za-z@#$][\w.@#$]*(?:\s+[A-Za-z@#$][\w.@#$]*)*)\s*\(([^)]*)\)/g)) for (const n of m[1]!.split(/\s+/)) missing.set(n, m[2]!.split(/[\s,]+/).filter(Boolean));
    } else if (/^MRSETS/.test(head)) {
      for (const m of cmd.matchAll(/\/(MDGROUP|MCGROUP)\s+NAME\s*=\s*\$?(\w+)[^/]*?LABEL\s*=\s*('(?:[^']|'')*'|"(?:[^"]|"")*")[^/]*?VARIABLES\s*=\s*([\w\s]+?)(?=\s+[A-Za-z]+\s*=|\s*\/|\s*$)/gi)) mr.push({ kind: m[1]!.toUpperCase() === "MDGROUP" ? "md" : "mc", name: m[2]!, label: quoted(m[3]!)[0] ?? m[2]!, vars: m[4]!.trim().split(/\s+/) });
    } else if (/^(?:DATA LIST|GET|SAVE|EXECUTE|FREQUENCIES|COMPUTE|RECODE|IF |DO IF|FORMATS|DISPLAY|DATASET|WEIGHT)/.test(head)) {
      issues.push({ location: head.split(" ")[0]!, type: "inferred", severity: "info", message: `SPSS ${head.split(" ").slice(0, 2).join(" ")} is a data or analysis command, not part of the questionnaire; it was not read.`, autoAttempted: true });
    }
  }
  const inSet = new Set(mr.flatMap((s) => s.vars));
  const questions: CanonicalQuestion[] = [], pages: string[][] = [];
  for (const s of mr) {
    const id = safeVar(s.name, `MR${questions.length + 1}`);
    const opts = s.vars.map((v, i) => ({ sourceId: v, code: i + 1, label: labels.get(v) ?? v }));
    questions.push(q(id, id, s.label, "multi", `SPSS ${s.kind === "md" ? "MDGROUP" : "MCGROUP"}`, "high", `SPSS multiple-response set over ${s.vars.join(", ")}: each variable is one choice.`, { options: opts }));
    pages.push([id]);
  }
  for (const v of order) {
    if (inSet.has(v)) continue;
    const id = safeVar(v, `V${questions.length + 1}`);
    const miss = new Set(missing.get(v) ?? []);
    const vals = (values.get(v) ?? []).filter(([c]) => !miss.has(c));
    if (vals.length) questions.push(q(id, id, labels.get(v) ?? v, "single", "SPSS value labels", "high", `SPSS value labels give ${vals.length} codes${miss.size ? `; missing codes ${[...miss].join(", ")} left out of the options` : ""}.`, { options: vals.map(([c, l]) => ({ sourceId: c, code: code(c), label: l })) }));
    else questions.push(q(id, id, labels.get(v) ?? v, "text", "SPSS variable (no value labels)", "review", "No value labels: written as an open answer — check whether it is a number or a coded question whose labels are elsewhere."));
    pages.push([id]);
  }
  issues.push({ location: meta.fileName, type: "inferred", severity: "info", message: "SPSS syntax describes the data, not the questionnaire: there is no routing or display logic to bring across, and none was invented.", autoAttempted: true });
  return survey("spreadsheet", "sps", meta, undefined, questions, pages, issues);
}

/* ================================================================ SurveyMonkey (survey details JSON) */

export function looksSurveyMonkey(o: unknown): boolean {
  const x = o as { pages?: { questions?: { family?: unknown }[] }[] };
  return Array.isArray(x?.pages) && x.pages.some((p) => Array.isArray(p?.questions) && p.questions.some((qq) => typeof qq?.family === "string"));
}

export function readSurveyMonkey(o: Record<string, unknown>, meta: Meta): CanonicalSurvey {
  const issues: Issue[] = [];
  const questions: CanonicalQuestion[] = [], pages: string[][] = [];
  let n = 0;
  for (const p of (o.pages as Record<string, unknown>[]) ?? []) {
    const page: string[] = [];
    for (const raw of (p.questions as Record<string, unknown>[]) ?? []) {
      n++;
      const fam = String(raw.family ?? ""), sub = String(raw.subtype ?? "");
      const heading = strip(((raw.headings as { heading?: string }[] | undefined) ?? [])[0]?.heading);
      const id = String(raw.id ?? `sm${n}`);
      const variable = safeVar(`Q${n}`, `Q${n}`);
      const ans = (raw.answers ?? {}) as { choices?: { id?: unknown; text?: string; position?: number }[]; rows?: { id?: unknown; text?: string }[]; other?: { id?: unknown; text?: string; is_answer_choice?: boolean } };
      const choices: CanonicalOption[] = (ans.choices ?? []).map((c, i) => ({ sourceId: String(c.id ?? i + 1), code: i + 1, label: strip(c.text) }));
      if (ans.other && ans.other.is_answer_choice !== false) choices.push({ sourceId: String(ans.other.id ?? "other"), code: choices.length + 1, label: strip(ans.other.text) || "Other", otherSpecify: true });
      const rows: CanonicalRow[] = (ans.rows ?? []).map((r, i) => ({ sourceId: String(r.id ?? i + 1), code: String(i + 1), label: strip(r.text) }));
      const required = !!(raw.required && typeof raw.required === "object");
      const mk = (kind: CanonicalKind, extra: Partial<CanonicalQuestion> = {}) => { const qq = q(id, variable, heading, kind, `${fam}/${sub}`, "review", `SurveyMonkey ${fam}${sub ? ` (${sub})` : ""}.`, { required, ...extra }); questions.push(qq); page.push(id); };
      if (fam === "single_choice") mk(sub === "menu" ? "dropdown" : "single", { options: choices });
      else if (fam === "multiple_choice") mk("multi", { options: choices });
      else if (fam === "matrix") mk(sub === "rating" || sub === "single" ? "matrix_single" : sub === "ranking" ? "ranking" : sub === "multi" ? "matrix_multi" : "matrix_single", sub === "ranking" ? { options: choices.length ? choices : rows.map((r, i) => ({ sourceId: r.sourceId, code: i + 1, label: r.label })) } : { options: choices, rows });
      else if (fam === "open_ended") mk(sub === "essay" ? "textarea" : sub === "numerical" ? "numeric" : sub === "multi" ? "matrix_text" : "text", sub === "multi" ? { rows } : {});
      else if (fam === "datetime") mk("date");
      else if (fam === "presentation") mk("descriptive");
      else if (fam === "demographic") mk("matrix_text", { rows });
      else { issues.push({ location: variable, type: "unsupported", severity: "medium", message: `SurveyMonkey question family “${fam}” is not recognised; a placeholder keeps its place.`, autoAttempted: false }); mk("unknown"); }
    }
    pages.push(page);
  }
  issues.push({ location: meta.fileName, type: "unsupported", severity: "medium", message: "SurveyMonkey's survey details do not include skip logic or piping; any the survey had must be added again and is not carried.", autoAttempted: false });
  return survey("surveymonkey", "surveymonkey", meta, typeof o.title === "string" ? o.title : undefined, questions, pages, issues);
}

/* ================================================================ Alchemer (SurveyGizmo) API JSON */

const tx = (t: unknown) => (typeof t === "string" ? strip(t) : t && typeof t === "object" ? strip((t as Record<string, string>).English ?? Object.values(t as Record<string, string>)[0]) : "");
export function looksAlchemer(o: unknown): boolean {
  const s = JSON.stringify(o ?? {}).slice(0, 200_000);
  return /"_type"\s*:\s*"Survey(?:Question|Page)"/.test(s);
}

export function readAlchemer(o: Record<string, unknown>, meta: Meta): CanonicalSurvey {
  const data = (o.data && typeof o.data === "object" ? o.data : o) as Record<string, unknown>;
  const issues: Issue[] = [];
  const questions: CanonicalQuestion[] = [], pages: string[][] = [];
  const kindOf: Record<string, CanonicalKind> = { RADIO: "single", MENU: "dropdown", CHECKBOX: "multi", TEXTBOX: "text", ESSAY: "textarea", NPS: "nps", RANK: "ranking", RANKLIST: "ranking", SLIDER: "slider", HIDDEN: "hidden", INSTRUCTIONS: "descriptive", EMAIL: "email", DATE: "date", CONT_SUM: "constant_sum", TABLE: "matrix_single", MULTI_TEXTBOX: "matrix_text", FILE: "file_upload" };
  let n = 0;
  for (const p of (data.pages as Record<string, unknown>[]) ?? []) {
    const page: string[] = [];
    for (const raw of (p.questions as Record<string, unknown>[]) ?? []) {
      n++;
      const type = String(raw.type ?? raw._subtype ?? "").toUpperCase();
      const id = String(raw.id ?? `al${n}`);
      const shortname = typeof raw.shortname === "string" && raw.shortname.trim() ? raw.shortname : `Q${n}`;
      const variable = safeVar(shortname, `Q${n}`);
      const options: CanonicalOption[] = ((raw.options as Record<string, unknown>[]) ?? []).map((op, i) => ({ sourceId: String(op.id ?? i + 1), code: code(String(op.value ?? i + 1)), label: tx(op.title) || String(op.value ?? ""), ...(op.properties && (op.properties as Record<string, unknown>).other ? { otherSpecify: true } : {}) }));
      const subs = (raw.sub_questions as Record<string, unknown>[] | undefined) ?? [];
      const rows: CanonicalRow[] = subs.map((s, i) => ({ sourceId: String(s.id ?? i + 1), code: String(i + 1), label: tx(s.title) }));
      const props = (raw.properties ?? {}) as Record<string, unknown>;
      const kind = kindOf[type];
      const required = props.required === true || props.required === "true";
      if (!kind) { issues.push({ location: variable, type: "unsupported", severity: "medium", message: `Alchemer question type “${type || "none"}” is not recognised; a placeholder keeps its place.`, autoAttempted: false }); }
      const qq = q(id, variable, tx(raw.title), kind ?? "unknown", `Alchemer ${type}`, "review", `Alchemer ${type}.`, { required, options, ...(rows.length ? { rows } : {}) });
      const logic = props.logic ?? raw.logic;
      if (logic) { qq.displayLogic = { t: "raw", text: JSON.stringify(logic).slice(0, 2000), language: "text", refs: [], reason: "Alchemer logic rules are kept as written for review; they are not translated automatically yet." }; qq.notes.push("Has Alchemer logic: kept as raw text for review."); }
      questions.push(qq); page.push(id);
    }
    pages.push(page);
  }
  return survey("alchemer", "alchemer", meta, tx(data.title) || undefined, questions, pages, issues);
}

/* ================================================================ Forsta Plus (Confirmit) project XML */

const FORSTA_QUESTION = new Set(["single", "multi", "open", "numeric", "grid", "grid3d", "ranking", "info", "date", "multigrid"]);
export function looksForsta(text: string): boolean {
  const root = /<(?!\?|!)([A-Za-z_][\w:.-]*)/.exec(text.trimStart())?.[1] ?? "";
  return /^project$/i.test(root) && /<(?:Single|Multi|Open|Numeric|Grid)[\s>]/.test(text);
}

export function readForsta(text: string, meta: Meta): CanonicalSurvey {
  const doc = parseXml(text);
  const issues: Issue[] = doc.errors.map((e) => ({ location: meta.fileName, type: "parse" as const, severity: "low" as const, message: `XML: ${e}`, autoAttempted: true }));
  const textOf = (n: XmlNode | undefined) => strip(allText(kid(n, "Title") ? kid(kid(n, "Title"), "Text") ?? kid(n, "Title") : kid(n, "Text") ?? n));
  const answersOf = (n: XmlNode | undefined) => kids(kid(n, "Answers"), "Answer").map((a, i) => ({ sourceId: a.attrs.Precode ?? a.attrs.precode ?? String(i + 1), code: code(a.attrs.Precode ?? a.attrs.precode ?? String(i + 1)), label: strip(allText(kid(a, "Texts") ? kid(kid(a, "Texts"), "Text") : kid(a, "Text") ?? a)), ...(/true/i.test(a.attrs.Exclusive ?? "") ? { exclusive: true } : {}), ...(/true/i.test(a.attrs.Other ?? a.attrs.OpenText ?? "") ? { otherSpecify: true } : {}) } as CanonicalOption));
  const all = findAll(doc.root ?? undefined, (n) => FORSTA_QUESTION.has(n.name.toLowerCase()));
  const questions: CanonicalQuestion[] = [], pages: string[][] = [];
  const kinds: Record<string, CanonicalKind> = { single: "single", multi: "multi", open: "textarea", numeric: "numeric", grid: "matrix_single", grid3d: "matrix_mixed", multigrid: "matrix_multi", ranking: "ranking", info: "descriptive", date: "date" };
  for (const n of all) {
    const name = n.attrs.Name ?? n.attrs.QuestionId ?? n.attrs.Id ?? `Q${questions.length + 1}`;
    const id = safeVar(name, `Q${questions.length + 1}`);
    const kind = kinds[n.name.toLowerCase()]!;
    const options = n.name.toLowerCase() === "grid" ? kids(kid(n, "Scale"), "ScaleItem").map((s, i) => ({ sourceId: s.attrs.Precode ?? String(i + 1), code: code(s.attrs.Precode ?? String(i + 1)), label: strip(allText(s)) } as CanonicalOption)) : answersOf(n);
    const rows: CanonicalRow[] = n.name.toLowerCase().startsWith("grid") || n.name.toLowerCase() === "multigrid" ? answersOf(n).map((a) => ({ sourceId: String(a.sourceId), code: String(a.code), label: a.label })) : [];
    const qq = q(id, id, textOf(n), kind, `Forsta ${n.name}`, "review", `Forsta Plus ${n.name}.`, { options: rows.length ? options : options, rows, required: !/false/i.test(n.attrs.Required ?? "true") && n.name.toLowerCase() !== "info" });
    const cond = kid(n, "Condition") ?? kid(n, "Mask");
    const expr = cond ? (cond.attrs.Expression ?? allText(cond)).trim() : "";
    if (expr) { qq.displayLogic = { t: "raw", text: expr, language: "javascript", refs: [...new Set(expr.match(/\b[A-Za-z]\w*\b/g) ?? [])].filter((r) => all.some((x) => (x.attrs.Name ?? "") === r)), reason: "Forsta Plus conditions are JScript-like expressions; kept for review, not translated automatically yet." }; qq.notes.push(`Condition kept as written: ${expr.slice(0, 120)}`); }
    questions.push(qq); pages.push([id]);
  }
  const unknown = findAll(doc.root ?? undefined, (n) => /^(Script|ScriptNode|Loop|Call|Goto|Stop)$/i.test(n.name));
  for (const u of unknown.slice(0, 20)) issues.push({ location: u.attrs.Name ?? u.name, type: "unsupported", severity: "medium", message: `Forsta Plus ${u.name} node is not translated; review it by hand.`, autoAttempted: false });
  return survey("forsta", "forsta", meta, allText(kid(kid(doc.root ?? undefined, "ProjectInfo"), "Name")) || doc.root?.attrs.Name || undefined, questions, pages, issues);
}
