/**
 * DOCUMENT UNDERSTANDING (Intelligent Mode upgrade, 2026-11-13) — what the uploaded file IS, before anything is
 * programmed: its sections and what each is for, the kinds of question, every piece of programming it asks for,
 * what depends on what, the methods it uses, and what is missing, conflicting or unclear.
 *
 * Model-free and deterministic: it reads the source-neutral model the adapters build (the same one for a Decipher
 * XML, a Qualtrics QSF, a Word questionnaire or an Excel specification) and the dependency graph (graph.ts). What
 * is INFERRED — a section's purpose, the study's objective — carries the reason it was inferred from, so a person
 * can see why and correct it. Nothing here changes the survey.
 */
import type { CanonicalQuestion, CanonicalSurvey, CExpr, CFlow } from "../canonical.js";
import { buildImportGraph, type ImportGraph } from "../graph.js";
import { detectMethodologies, type MethodologyFinding } from "./methodology.js";

export type SectionPurpose = "introduction" | "consent" | "screener" | "demographics" | "main" | "exercise" | "evaluation" | "closing";

export interface SectionUnderstanding {
  sourceId: string;
  title: string;
  purpose: SectionPurpose;
  /** what the purpose was read from */
  because: string;
  questions: number;
  /** codes of the first few questions */
  sample: string[];
  /** this section is shown only on a condition, repeated in a loop, or rotated */
  conditional: boolean; looped: boolean; rotated: boolean;
  /** sections whose answers this one reads */
  dependsOn: string[];
}

export interface ProblemFound {
  kind: "missing" | "conflict" | "ambiguous" | "error" | "unsupported";
  severity: "high" | "medium" | "low";
  where: string;
  message: string;
}

export interface Understanding {
  title: string;
  platform: string;
  format: string;
  /** the study's purpose in a sentence, and what it was read from — an inference, labelled as one */
  objective: { text: string; basis: string[] };
  sections: SectionUnderstanding[];
  questions: { total: number; byKind: { kind: string; count: number }[]; required: number; hidden: number };
  /** every kind of programming the source asks for, counted */
  programming: {
    displayLogic: number; skipLogic: number; terminations: number; branches: number; loops: number; randomizedBlocks: number;
    randomizedLists: number; piping: number; carryForward: number; quotas: number; validation: number; embeddedData: number;
    customCode: number; translations: number;
  };
  dependencies: { edges: number; mostRead: { code: string; readBy: number }[]; chains: number };
  methodologies: MethodologyFinding[];
  problems: ProblemFound[];
  /** companion files the source needs and did not bring */
  filesNeeded: { name: string; why: string }[];
  /** one paragraph a person can read */
  summary: string;
}

const plain = (s: string | undefined) => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const codeOf = (q: CanonicalQuestion) => q.code ?? q.variable;

const DEMO = /\b(age|gender|sex|income|education|occupation|employ|marital|household|region|state|country|zip|postal|postcode|ethnic|race|children|urban|rural)\b/i;
const CONSENT = /\b(consent|agree to (?:take part|participat)|privacy (?:policy|notice)|voluntary|data protection)\b/i;
const CLOSE = /\b(thank you|thanks for|final comments?|anything else|feedback on (?:this|the) survey|contact details|prize draw|incentive)\b/i;
const EVAL = /\b(concept|advert|ad\b|stimulus|video|image shown|after (?:seeing|watching|reading)|appeal|purchase intent|likel(?:y|ihood) to (?:buy|purchase))\b/i;

const KIND_WORDS: Record<string, string> = {
  single: "single choice", multi: "multiple choice", dropdown: "dropdown", multi_dropdown: "multi-select dropdown", text: "short text", textarea: "long text",
  numeric: "number", email: "email", date: "date", time: "time", nps: "NPS", stars: "star rating", slider: "slider", ranking: "ranking", constant_sum: "constant sum",
  matrix_single: "single-choice grid", matrix_multi: "multiple-choice grid", matrix_text: "text grid", matrix_numeric: "number grid", matrix_dropdown: "dropdown grid", matrix_mixed: "mixed grid",
  descriptive: "text / instruction", hidden: "hidden variable", calculated: "calculated variable", file_upload: "file upload", signature: "signature", hotspot: "hotspot",
  conjoint: "conjoint exercise", maxdiff: "MaxDiff exercise", acbc: "adaptive conjoint exercise", bucket: "card sort", unknown: "not recognised",
};

function refsOf(e: CExpr | undefined, out: Set<string> = new Set()): Set<string> {
  if (!e) return out;
  if (e.t === "group") for (const c of e.children) refsOf(c, out);
  else if (e.t === "cmp" && e.ref.kind === "question") out.add(e.ref.id);
  else if (e.t === "raw") for (const r of e.refs) out.add(r);
  return out;
}

export function understandDocument(c: CanonicalSurvey, graph: ImportGraph = buildImportGraph(c), methods: MethodologyFinding[] = detectMethodologies(c)): Understanding {
  const byId = new Map(c.questions.map((q) => [q.sourceId, q]));
  /* ---- sections: every block in flow order, with what surrounds it */
  interface Raw { sourceId: string; title: string; ids: string[]; conditional: boolean; looped: boolean; rotated: boolean; reads: Set<string> }
  const raws: Raw[] = [];
  let branches = 0, loops = 0, randomizedBlocks = 0, terminationsFlow = 0;
  const walk = (nodes: CFlow[], ctx: { conditional: boolean; rotated: boolean; reads: Set<string> }) => {
    for (const n of nodes) {
      if (n.t === "block") {
        const reads = new Set(ctx.reads); refsOf(n.displayLogic, reads);
        if (n.loop) loops++;
        if (n.loop?.questionId) reads.add(n.loop.questionId);
        raws.push({ sourceId: n.sourceId, title: plain(n.title), ids: n.pages.flat(), conditional: ctx.conditional || !!n.displayLogic, looped: !!n.loop, rotated: ctx.rotated, reads });
      } else if (n.t === "branch") { branches++; const reads = new Set(ctx.reads); refsOf(n.when, reads); walk(n.children, { conditional: true, rotated: ctx.rotated, reads }); }
      else if (n.t === "randomizer") { randomizedBlocks++; walk(n.children, { ...ctx, rotated: true }); }
      else if (n.t === "group") walk(n.children, ctx);
      else if (n.t === "end" && n.status !== "complete") terminationsFlow++;
    }
  };
  walk(c.flow, { conditional: false, rotated: false, reads: new Set() });
  const sectionOf = new Map<string, string>();
  for (const r of raws) for (const id of r.ids) sectionOf.set(id, r.sourceId);
  const exerciseIds = new Set(methods.filter((m) => m.support !== "native").flatMap((m) => m.sourceIds));

  const sections: SectionUnderstanding[] = raws.map((r, idx) => {
    const qs = r.ids.map((id) => byId.get(id)).filter((q): q is CanonicalQuestion => !!q);
    const asked = qs.filter((q) => q.kind !== "descriptive" && q.kind !== "hidden" && q.kind !== "calculated");
    const text = qs.map((q) => `${plain(q.text)} ${q.variable}`).join(" ");
    const terminates = qs.filter((q) => q.skips.some((s) => s.to.kind === "end" && s.to.status !== "complete")).length;
    const t = r.title;
    let purpose: SectionPurpose = "main", because = "it holds the study's own questions";
    if (asked.some((q) => exerciseIds.has(q.sourceId) || q.kind === "maxdiff" || q.kind === "conjoint" || q.kind === "acbc")) { purpose = "exercise"; because = "it contains a choice exercise"; }
    else if (/screen|qualif|eligib|recruit/i.test(t)) { purpose = "screener"; because = `it is titled “${t}”`; }
    else if (/demograph|about you|classification|profil/i.test(t)) { purpose = "demographics"; because = `it is titled “${t}”`; }
    else if (/consent|privacy/i.test(t) || (asked.length <= 2 && asked.length > 0 && asked.every((q) => CONSENT.test(plain(q.text))))) { purpose = "consent"; because = /consent|privacy/i.test(t) ? `it is titled “${t}”` : "its questions ask for agreement to take part"; }
    else if (/intro|welcome/i.test(t) || (asked.length === 0 && idx === 0)) { purpose = "introduction"; because = asked.length === 0 ? "it shows text and asks nothing" : `it is titled “${t}”`; }
    else if (/clos|thank|end|wrap|final/i.test(t) || (idx === raws.length - 1 && CLOSE.test(text))) { purpose = "closing"; because = /clos|thank|end|wrap|final/i.test(t) ? `it is titled “${t}”` : "it is the last section and thanks the respondent or asks for final comments"; }
    else if (terminates > 0 && idx <= Math.max(1, Math.floor(raws.length / 3))) { purpose = "screener"; because = `${terminates} of its questions can end the interview, and it comes early`; }
    else if (asked.length > 0 && asked.filter((q) => DEMO.test(`${plain(q.text)} ${q.variable}`)).length >= Math.ceil(asked.length * 0.6)) { purpose = "demographics"; because = "most of its questions ask who the respondent is (age, gender, region, income…)"; }
    else if (r.looped || r.rotated || EVAL.test(text)) { purpose = "evaluation"; because = r.looped ? "it repeats for each item of a list" : r.rotated ? "it is one of several rotated sections" : "its questions rate something shown to the respondent"; }
    const dependsOn = [...new Set([...r.reads, ...qs.flatMap((q) => [...refsOf(q.displayLogic), ...(q.carryForward?.questionId ? [q.carryForward.questionId] : [])])].map((id) => sectionOf.get(id)).filter((s): s is string => !!s && s !== r.sourceId))];
    return { sourceId: r.sourceId, title: t || `Section ${idx + 1}`, purpose, because, questions: asked.length, sample: asked.slice(0, 4).map(codeOf), conditional: r.conditional, looped: r.looped, rotated: r.rotated,
      dependsOn: dependsOn.map((id) => raws.find((x) => x.sourceId === id)?.title || id) };
  });

  /* ---- questions and programming */
  const kinds = new Map<string, number>();
  for (const q of c.questions) kinds.set(q.kind, (kinds.get(q.kind) ?? 0) + 1);
  const byKind = [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, count]) => ({ kind: KIND_WORDS[k] ?? k, count }));
  const PIPE = /\{\{[^}]+\}\}|\$\{[^}]+\}|\[pipe:[^\]]+\]/;
  const programming: Understanding["programming"] = {
    displayLogic: c.questions.filter((q) => q.displayLogic).length + raws.filter((r) => r.conditional).length,
    skipLogic: c.questions.reduce((n, q) => n + q.skips.filter((s) => !(s.to.kind === "end" && s.to.status !== "complete")).length, 0),
    terminations: c.questions.reduce((n, q) => n + q.skips.filter((s) => s.to.kind === "end" && s.to.status !== "complete").length, 0) + terminationsFlow,
    branches, loops, randomizedBlocks,
    randomizedLists: c.questions.filter((q) => q.randomizeOptions || q.randomization).length,
    piping: c.questions.filter((q) => PIPE.test(`${q.text} ${q.options.map((o) => o.label).join(" ")}`)).length,
    carryForward: c.questions.filter((q) => q.carryForward).length,
    quotas: c.quotas.length,
    validation: c.questions.reduce((n, q) => n + q.validation.length, 0),
    embeddedData: graph.embedded.length,
    customCode: c.custom.length + c.questions.reduce((n, q) => n + q.custom.filter((x) => x.language !== "text").length, 0),
    translations: (c.languages ?? []).length,
  };

  /* ---- dependencies */
  const readBy = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (!["display", "skip", "branch", "piping", "carry_forward", "loop", "quota"].includes(e.kind)) continue;
    if (!byId.has(e.to) || e.from === e.to) continue;
    (readBy.get(e.to) ?? readBy.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  const mostRead = [...readBy.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 5).map(([id, s]) => ({ code: codeOf(byId.get(id)!), readBy: s.size }));

  /* ---- problems: what the graph and the readers found, in one vocabulary */
  const problems: ProblemFound[] = [];
  const sev = (s: string): ProblemFound["severity"] => (s === "high" ? "high" : s === "medium" ? "medium" : "low");
  for (const f of graph.findings) {
    if (f.severity === "info") continue;
    const kind: ProblemFound["kind"] = f.kind === "missing_reference" || f.kind === "undefined_embedded" ? "missing" : f.kind === "circular_dependency" || f.kind === "forward_reference" || f.kind === "embedded_used_before_assignment" ? "conflict" : "error";
    problems.push({ kind, severity: sev(f.severity), where: f.location, message: f.message });
  }
  for (const i of c.issues) {
    if (i.severity === "info" || i.severity === "low") continue;
    const kind: ProblemFound["kind"] | null = i.type === "ambiguous" ? "ambiguous" : i.type === "reference" ? "missing" : i.type === "unsupported" ? "unsupported" : i.type === "parse" || i.type === "structure" ? "error" : null;
    if (kind && !problems.some((p) => p.where === i.location && p.message === i.message)) problems.push({ kind, severity: sev(i.severity), where: i.location, message: i.message });
  }
  /* a required question with a list and nothing in it; two questions answering to one name */
  const names = new Map<string, string[]>();
  for (const q of c.questions) {
    (names.get(q.variable.toLowerCase()) ?? names.set(q.variable.toLowerCase(), []).get(q.variable.toLowerCase())!).push(q.sourceId);
    if (/^(single|multi|dropdown|ranking)$/.test(q.kind) && q.options.length === 0 && !q.carryForward) problems.push({ kind: "missing", severity: "high", where: codeOf(q), message: `${codeOf(q)} is a ${KIND_WORDS[q.kind] ?? q.kind} question with no answer options in the source.` });
    if (/^(single|dropdown)$/.test(q.kind) && q.options.length === 1 && !q.carryForward) problems.push({ kind: "ambiguous", severity: "low", where: codeOf(q), message: `${codeOf(q)} offers a single answer — an acknowledgement, or are options missing?` });
    if (!plain(q.text) && q.kind !== "hidden" && q.kind !== "calculated") problems.push({ kind: "missing", severity: "medium", where: codeOf(q), message: `${codeOf(q)} has no question text.` });
  }
  for (const [name, ids] of names) if (ids.length > 1) problems.push({ kind: "conflict", severity: "high", where: ids.join(", "), message: `${ids.length} questions use the variable name ${name.toUpperCase()} — the data would not tell them apart.` });

  /* ---- the objective: an inference, from the title, the methods and where the questions are */
  const main = sections.filter((s) => s.purpose === "main" || s.purpose === "evaluation" || s.purpose === "exercise");
  const basis: string[] = [];
  const title = plain(c.source.title) || c.source.fileName.replace(/\.[a-z0-9]+$/i, "");
  if (plain(c.source.title)) basis.push(`the survey's title, “${title}”`);
  const methodLabels = [...new Set(methods.map((m) => m.label))];
  if (methods.length) basis.push(`the methods it uses (${methodLabels.join(", ")})`);
  if (main.length) basis.push(`its main sections (${main.slice(0, 4).map((s) => s.title).join(", ")})`);
  const screened = sections.some((s) => s.purpose === "screener") || programming.terminations > 0;
  const objective = {
    text: `${methods.length ? `${methodLabels.join(" and ")} study` : "A survey"}${title ? ` — “${title}”` : ""}${screened ? `, among respondents who pass a screener${c.quotas.length ? ` with ${c.quotas.length} quota${c.quotas.length === 1 ? "" : "s"}` : ""}` : ""}${main.length ? `; the body covers ${main.slice(0, 3).map((s) => s.title).join(", ")}${main.length > 3 ? ` and ${main.length - 3} more section${main.length - 3 === 1 ? "" : "s"}` : ""}` : ""}.`,
    basis,
  };

  const P = programming;
  const parts = [
    P.displayLogic && `${P.displayLogic} display condition${P.displayLogic === 1 ? "" : "s"}`, P.skipLogic && `${P.skipLogic} skip${P.skipLogic === 1 ? "" : "s"}`, P.terminations && `${P.terminations} termination${P.terminations === 1 ? "" : "s"}`,
    P.branches && `${P.branches} branch${P.branches === 1 ? "" : "es"}`, P.loops && `${P.loops} loop${P.loops === 1 ? "" : "s"}`, P.quotas && `${P.quotas} quota${P.quotas === 1 ? "" : "s"}`,
    P.piping && `piping in ${P.piping} question${P.piping === 1 ? "" : "s"}`, P.carryForward && `${P.carryForward} carried list${P.carryForward === 1 ? "" : "s"}`, (P.randomizedLists + P.randomizedBlocks) && `${P.randomizedLists + P.randomizedBlocks} randomization${P.randomizedLists + P.randomizedBlocks === 1 ? "" : "s"}`,
    P.validation && `${P.validation} validation rule${P.validation === 1 ? "" : "s"}`, P.customCode && `${P.customCode} piece${P.customCode === 1 ? "" : "s"} of custom code`,
  ].filter(Boolean) as string[];
  const high = problems.filter((p) => p.severity === "high").length;
  const summary = `${c.questions.length} question${c.questions.length === 1 ? "" : "s"} in ${sections.length} section${sections.length === 1 ? "" : "s"}. Programming found: ${parts.length ? parts.join(", ") : "none beyond the questions themselves"}.${methods.length ? ` Methods: ${[...new Set(methods.map((m) => `${m.label}${m.certainty === "inferred" ? " (inferred from the questions' shape)" : m.support === "native" ? "" : m.support === "pending" ? " (not available in the platform yet)" : " (needs an experimental design)"}`))].join("; ")}.` : ""}${problems.length ? ` ${problems.length} thing${problems.length === 1 ? "" : "s"} to look at${high ? `, ${high} important` : ""}.` : " Nothing missing or conflicting was found."}`;

  return {
    title, platform: c.source.platform, format: c.source.format, objective, sections,
    questions: { total: c.questions.length, byKind, required: c.questions.filter((q) => q.required).length, hidden: c.questions.filter((q) => q.kind === "hidden" || q.kind === "calculated").length },
    programming, dependencies: { edges: graph.edges.length, mostRead, chains: graph.findings.filter((f) => f.kind === "circular_dependency").length },
    methodologies: methods, problems, filesNeeded: (c.requiredFiles ?? []).map((f) => ({ name: f.name, why: f.why })), summary,
  };
}
