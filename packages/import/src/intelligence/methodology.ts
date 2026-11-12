/**
 * RESEARCH METHODOLOGY RECOGNITION (Intelligent Mode upgrade, 2026-11-13).
 *
 * A questionnaire can ask for a MaxDiff, a conjoint or a price-sensitivity study in three ways: structurally (a
 * Qualtrics MaxDiff matrix, a Decipher design file), by name in a programmer note ("MAXDIFF — 12 items, 4 per
 * screen"), or only by its shape (four "at what price…" questions). This module finds all three on the
 * source-neutral model, so every format gets the same treatment, and says for each:
 *
 *   where      the questions it covers
 *   evidence   the words or structure that showed it (never a guess presented as fact — `certainty` says which)
 *   support    "native"        the platform programs it as ordinary questions (Van Westendorp, a monadic test)
 *              "needs_design"  the platform runs it, from an experimental design the source does not carry: a
 *                              PLACEHOLDER question keeps its place, items and logic, marked pending
 *              "pending"       the platform has no engine for it yet: a placeholder keeps its place
 *   needs      what a person has to add before it can field
 *
 * `applyMethodologies` turns a question the source wrote as an ordinary list — but NAMED as an exercise — into the
 * exercise placeholder (its items kept). A question that only LOOKS like one is never converted: it is asked about.
 * Nothing is dropped, nothing ordinary is silently promoted, and nothing pending is reported as built.
 *
 * New engines plug in here: add a row to METHODS and, when the platform gains the runtime, change its `support`.
 */
import type { CanonicalQuestion, CanonicalSurvey, CFlow } from "../canonical.js";

export type MethodKey =
  | "maxdiff" | "cbc" | "acbc" | "menu_conjoint" | "rating_conjoint" | "van_westendorp" | "gabor_granger"
  | "sequential_monadic" | "brand_funnel" | "kano" | "turf" | "implicit_association" | "q_sort" | "simalto" | "bpto";

export type MethodSupport = "native" | "needs_design" | "pending";

interface MethodDef {
  key: MethodKey; label: string; support: MethodSupport;
  /** the method named outright, in an instruction, a type word or the question text */
  named: RegExp;
  /** the canonical kind its placeholder takes (design-driven methods only) */
  kind?: "maxdiff" | "conjoint" | "acbc";
  needs: string[];
}

export const METHODS: MethodDef[] = [
  { key: "maxdiff", label: "MaxDiff (best–worst scaling)", support: "needs_design", kind: "maxdiff",
    named: /\bmax[\s-]?diff\b|\bbest[\s-]?worst\s+scal|\bbws\b|\bmaximum\s+difference\s+scal/i,
    needs: ["the list of items (kept from the source when it lists them)", "how many items each set shows and how many sets each respondent sees", "the design — generate it in Design Generators → MaxDiff and attach it to the question"] },
  { key: "acbc", label: "Adaptive conjoint (ACBC)", support: "needs_design", kind: "acbc",
    named: /\bacbc\b|\badaptive\s+(?:choice[\s-]?based\s+)?conjoint\b|\badaptive\s+cbc\b/i,
    needs: ["the attributes and their levels", "the build-your-own, screening and tournament settings (Design Generators → Conjoint → Adaptive)"] },
  { key: "menu_conjoint", label: "Menu-based conjoint", support: "needs_design", kind: "conjoint",
    named: /\bmenu[\s-]?based\s+(?:conjoint|choice)\b|\bmbc\b/i,
    needs: ["the menu items with their price levels", "the design — Design Generators → Conjoint → Menu"] },
  { key: "rating_conjoint", label: "Rating-based conjoint (CVA)", support: "needs_design", kind: "conjoint",
    named: /\bcva\b|\brating[\s-]?based\s+conjoint\b|\bconjoint\s+value\s+analysis\b|\bfull[\s-]?profile\s+conjoint\b/i,
    needs: ["the attributes and their levels", "the rating scale", "the design — Design Generators → Conjoint → Rating-based"] },
  { key: "cbc", label: "Choice-based conjoint (CBC / discrete choice)", support: "needs_design", kind: "conjoint",
    named: /\bcbc\b|\bchoice[\s-]?based\s+conjoint\b|\bconjoint\b|\bdiscrete[\s-]?choice\b|\bdce\b|\bchoice\s+(?:experiment|modell?ing)\b/i,
    needs: ["the attributes and their levels", "tasks per respondent, alternatives per task, and whether there is a “none” option", "the design — generate it in Design Generators → Conjoint and attach it to the question"] },
  { key: "van_westendorp", label: "Van Westendorp price sensitivity", support: "native",
    named: /\bvan[\s-]?westendorp\b|\bprice\s+sensitivity\s+meter\b|\bpsm\b/i, needs: [] },
  { key: "gabor_granger", label: "Gabor–Granger price ladder", support: "native",
    named: /\bgabor[\s–-]+granger\b|\bprice\s+ladder\b/i, needs: [] },
  { key: "sequential_monadic", label: "Sequential monadic concept test", support: "native",
    named: /\bsequential[\s-]+monadic\b|\bmonadic\s+(?:test|design|evaluation)\b/i, needs: [] },
  { key: "brand_funnel", label: "Brand funnel", support: "native", named: /\bbrand\s+funnel\b|\bpurchase\s+funnel\b/i, needs: [] },
  { key: "kano", label: "Kano analysis", support: "native", named: /\bkano\b/i, needs: [] },
  { key: "implicit_association", label: "Implicit association test (IAT)", support: "native", named: /\bimplicit\s+association\b|\biat\b/i, needs: [] },
  { key: "turf", label: "TURF", support: "native", named: /\bturf\b|\btotal\s+unduplicated\s+reach\b/i, needs: [] },
  { key: "q_sort", label: "Q-sort", support: "pending", named: /\bq[\s-]?sort\b|\bq[\s-]?methodology\b/i,
    needs: ["Q-sort has no engine in the platform yet — the statements are kept as a placeholder; a forced-distribution sort has to be added before fielding"] },
  { key: "simalto", label: "SIMALTO trade-off grid", support: "pending", named: /\bsimalto\b/i,
    needs: ["SIMALTO has no engine in the platform yet — the grid is kept as a placeholder"] },
  { key: "bpto", label: "Brand–price trade-off (BPTO)", support: "pending", named: /\bbpto\b|\bbrand[\s–-]+price\s+trade[\s-]?off\b/i,
    needs: ["BPTO has no engine in the platform yet — the brands and prices are kept as a placeholder"] },
];

export interface MethodologyFinding {
  method: MethodKey;
  label: string;
  support: MethodSupport;
  /** "stated": the source names the method or carries its structure; "inferred": only the shape of the questions suggests it */
  certainty: "stated" | "inferred";
  /** source ids of the questions it covers */
  sourceIds: string[];
  /** their codes, for people */
  questions: string[];
  evidence: string[];
  /** numbers the source states for the design (items per set, sets, tasks, alternatives) — only what it says */
  stated: { items?: number; perSet?: number; sets?: number; alternatives?: number; versions?: number };
  /** what has to be added before it can field (empty for a native method) */
  needs: string[];
  /** a placeholder question holds its place (design-driven and pending methods) */
  placeholder: boolean;
  /** a sentence for the person */
  summary: string;
}

const plain = (s: string | undefined) => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const codeOf = (q: CanonicalQuestion) => q.code ?? q.variable;
/** every word a person wrote ON a question: its text, instruction, type words, notes and the instructions kept as custom text */
const wordsOf = (q: CanonicalQuestion): string => [q.text, q.instruction, q.sourceType, ...(q.sourceNotes ?? []), ...(q.custom ?? []).filter((c) => c.language === "text").map((c) => c.code)].map(plain).join(" · ");
/** a platform export (QSF, Decipher XML) states how the survey IS built; a document or a sheet states what is WANTED */
export const isPlatformExport = (c: CanonicalSurvey): boolean => c.source.platform === "qualtrics" || c.source.platform === "decipher";
const asksSomething = (q: CanonicalQuestion) => q.kind !== "descriptive" && q.kind !== "hidden" && q.kind !== "calculated";
const listSize = (q: CanonicalQuestion) => Math.max(q.options.length, q.rows.length);

function statedNumbers(text: string): MethodologyFinding["stated"] {
  const n = (re: RegExp) => { const m = re.exec(text); return m ? Number(m[1]) : undefined; };
  const out: MethodologyFinding["stated"] = {
    items: n(/\b(\d{1,3})\s+(?:items|attributes|statements|features|messages)\b/i),
    perSet: n(/\b(\d{1,2})\s+(?:items?\s+)?(?:per|in each|on each|at a time|shown per)\s*(?:screen|set|task|page)?/i) ?? n(/\bsets?\s+of\s+(\d{1,2})\b/i),
    sets: n(/\b(\d{1,3})\s+(?:screens|sets|tasks|choice\s+(?:tasks|sets)|questions)\b/i),
    alternatives: n(/\b(\d{1,2})\s+(?:alternatives|concepts|profiles|options)\s+(?:per|in each|on each)\b/i),
    versions: n(/\b(\d{1,4})\s+(?:versions|blocks)\b/i),
  };
  for (const k of Object.keys(out) as (keyof typeof out)[]) if (out[k] === undefined || !(out[k]! > 0)) delete out[k];
  return out;
}

const PRICE_Q = [
  /\b(?:so|too)\s+(?:cheap|inexpensive|low)\b.*\b(?:quality|doubt|question)\b|\bdoubt\s+(?:its|the)\s+quality\b/i,
  /\bbargain\b|\bgood\s+value\b|\bgreat\s+buy\b/i,
  /\b(?:getting|starting to get|somewhat)\s+expensive\b|\bexpensive\b.*\b(?:still|consider|think about)\b/i,
  /\b(?:so|too)\s+expensive\b.*\b(?:not|never|wouldn'?t)\s+(?:consider|buy)\b|\btoo\s+expensive\s+to\s+consider\b/i,
];

/** every methodology the survey asks for, with where and how it was recognised */
export function detectMethodologies(c: CanonicalSurvey): MethodologyFinding[] {
  const out: MethodologyFinding[] = [];
  const add = (def: MethodDef, qs: CanonicalQuestion[], certainty: "stated" | "inferred", evidence: string[], stated: MethodologyFinding["stated"] = {}) => {
    const existing = out.find((f) => f.method === def.key && f.certainty === certainty);
    if (existing) {
      for (const q of qs) if (!existing.sourceIds.includes(q.sourceId)) { existing.sourceIds.push(q.sourceId); existing.questions.push(codeOf(q)); }
      for (const e of evidence) if (!existing.evidence.includes(e)) existing.evidence.push(e);
      Object.assign(existing.stated, { ...stated, ...existing.stated });
      return;
    }
    const placeholder = def.support !== "native";
    const where = qs.length ? qs.map(codeOf).join(", ") : "the survey";
    out.push({
      method: def.key, label: def.label, support: def.support, certainty, sourceIds: qs.map((q) => q.sourceId), questions: qs.map(codeOf), evidence, stated, needs: [...def.needs], placeholder,
      summary: def.support === "native" ? `${def.label} at ${where} — programmed with ordinary questions.`
        : def.support === "needs_design" ? `${def.label} at ${where} — a placeholder keeps its place and items; the experimental design is still to be added.`
          : `${def.label} at ${where} — not available in the platform yet; a placeholder keeps its place.`,
    });
  };

  /* 1. structure: the source's own exercise questions (a Qualtrics MaxDiff matrix, a kind the adapter set) */
  for (const q of c.questions) {
    if (q.kind === "maxdiff") add(METHODS.find((m) => m.key === "maxdiff")!, [q], "stated", [`${codeOf(q)} is a ${q.sourceType || "MaxDiff"} question in the source`], statedNumbers(wordsOf(q)));
    else if (q.kind === "acbc") add(METHODS.find((m) => m.key === "acbc")!, [q], "stated", [`${codeOf(q)} is an adaptive conjoint question in the source`]);
    else if (q.kind === "conjoint") {
      const w = wordsOf(q);
      const def = METHODS.find((m) => (m.key === "menu_conjoint" || m.key === "rating_conjoint") && m.named.test(w)) ?? METHODS.find((m) => m.key === "cbc")!;
      add(def, [q], "stated", [`${codeOf(q)} is a ${q.sourceType || "conjoint"} question in the source`], statedNumbers(w));
    }
  }
  /*
   * 2. named: the method's name in what a person wrote on a question. A hidden or calculated variable is never the
   * exercise (it may only mention it); a note or an introduction that names it points at the list question after it.
   */
  const order = c.questions;
  for (let i = 0; i < order.length; i++) {
    const q = order[i];
    if (q.kind === "maxdiff" || q.kind === "conjoint" || q.kind === "acbc" || q.kind === "hidden" || q.kind === "calculated") continue;
    const w = wordsOf(q);
    const def = METHODS.find((m) => m.named.test(w));
    if (!def) continue;
    const hit = def.named.exec(w)!;
    const quote = `“${w.slice(Math.max(0, hit.index - 40), hit.index + hit[0].length + 60).trim()}”`;
    if (asksSomething(q)) { add(def, [q], "stated", [`${codeOf(q)}: ${quote}`], statedNumbers(w)); continue; }
    /* a text-only item: the exercise is the next question that has a list (within the next three questions) */
    const target = order.slice(i + 1, i + 4).find((x) => asksSomething(x) && (def.support === "native" || listSize(x) >= 3));
    add(def, target ? [target] : [], "stated", [`${codeOf(q)} (a note before ${target ? codeOf(target) : "the exercise"}): ${quote}`], statedNumbers(w));
  }
  /* 3. named in a block title, a design file the source needs, or an instruction the reader could not place */
  const blocks: { title: string; ids: string[] }[] = [];
  const walk = (nodes: CFlow[]) => { for (const n of nodes) { if (n.t === "block") blocks.push({ title: n.title ?? "", ids: n.pages.flat() }); else if ("children" in n) walk(n.children); } };
  walk(c.flow);
  const byId = new Map(c.questions.map((q) => [q.sourceId, q]));
  for (const b of blocks) {
    const def = METHODS.find((m) => m.named.test(b.title));
    if (!def) continue;
    const qs = b.ids.map((id) => byId.get(id)).filter((q): q is CanonicalQuestion => !!q && q.kind !== "descriptive" && q.kind !== "hidden" && q.kind !== "calculated");
    if (!out.some((f) => f.method === def.key && f.sourceIds.some((id) => b.ids.includes(id)))) add(def, def.support === "native" ? qs : qs.slice(0, 1), "stated", [`the block is titled “${b.title}”`], statedNumbers(b.title));
  }
  for (const f of c.requiredFiles ?? []) {
    if (/maxdiff/i.test(`${f.name} ${f.why ?? ""}`) && !out.some((x) => x.method === "maxdiff")) add(METHODS.find((m) => m.key === "maxdiff")!, [], "stated", [`the source reads a MaxDiff design file (${f.name})`]);
  }
  for (const i of c.issues) {
    const w = plain(`${i.message} ${i.instruction ?? ""}`);
    const def = METHODS.find((m) => m.support !== "native" && m.named.test(w));
    if (def && !out.some((x) => x.method === def.key)) add(def, (i.refs ?? []).map((id) => byId.get(id)).filter((q): q is CanonicalQuestion => !!q), "stated", [`${i.location}: “${w.slice(0, 140)}”`], statedNumbers(w));
  }
  /* 4. shape only — said as inferred, never converted */
  const vw = PRICE_Q.map((re) => c.questions.find((q) => /numeric|slider|text/.test(q.kind) && re.test(plain(q.text))));
  if (vw.filter(Boolean).length >= 3 && !out.some((f) => f.method === "van_westendorp")) add(METHODS.find((m) => m.key === "van_westendorp")!, vw.filter((q): q is CanonicalQuestion => !!q), "inferred", ["three or more of the four price-threshold questions (too cheap, bargain, getting expensive, too expensive)"]);
  for (const q of c.questions) {
    if (out.some((f) => f.sourceIds.includes(q.sourceId))) continue;
    const t = plain(`${q.text} ${q.instruction ?? ""}`);
    if (/\bmost\b[^.?]{0,60}\b(?:and|\/|&)\b[^.?]{0,40}\bleast\b/i.test(t) && listSize(q) >= 4 && /single|multi|matrix/.test(q.kind)) {
      add(METHODS.find((m) => m.key === "maxdiff")!, [q], "inferred", [`${codeOf(q)} asks for the most and the least from a list of ${Math.max(q.options.length, q.rows.length)} — the shape of a MaxDiff task, but the source does not call it one`]);
    }
  }
  return out;
}

export interface MethodologyApplication { canonical: CanonicalSurvey; converted: { sourceId: string; code: string; method: MethodKey; from: string }[] }

/**
 * Give every STATED design-driven or pending method its placeholder: a question written as an ordinary list but
 * named as the exercise becomes the exercise's question (its items kept as the item list), marked for review with
 * what is still needed. Structural exercises already are; inferred ones are left for the clarification.
 * `decisions` carries the person's answers: sourceId → the method to use, or "none" to keep the question as written.
 */
export function applyMethodologies(input: CanonicalSurvey, findings: MethodologyFinding[] = detectMethodologies(input), decisions: Record<string, MethodKey | "none"> = {}): MethodologyApplication {
  const c: CanonicalSurvey = { ...input, questions: input.questions.map((q) => ({ ...q })), issues: [...input.issues] };
  /* an export already says how each question is built: it is reported and its needs listed, never re-built — unless the person says so */
  const exported = isPlatformExport(input);
  const converted: MethodologyApplication["converted"] = [];
  const byId = new Map(c.questions.map((q) => [q.sourceId, q]));
  const convert = (q: CanonicalQuestion, f: MethodologyFinding | undefined, method: MethodKey) => {
    const def = METHODS.find((m) => m.key === method)!;
    if (def.support === "native") return;
    const from = q.kind;
    const kind = def.kind;
    /* the list stays exactly where the source wrote it (options or rows): it is the exercise's item list. With no engine yet (`kind` absent) the question stays as written, flagged — never dressed up as the method. */
    if (kind && q.kind !== kind) q.kind = kind;
    q.confidence = "review";
    q.notes = [...(q.notes ?? []), `${def.label}: ${def.support === "pending" ? "not available in the platform yet — this is a placeholder" : "placeholder — the experimental design is still to be added"}${f && Object.keys(f.stated).length ? ` (the source states ${Object.entries(f.stated).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}`];
    q.settings = { ...(q.settings ?? {}), methodPlaceholder: { method, label: def.label, support: def.support, stated: f?.stated ?? {}, needs: def.needs } };
    c.issues.push({ location: q.sourceId, type: def.support === "pending" ? "unsupported" : "converted", severity: "high", autoAttempted: true, refs: [q.sourceId],
      message: `${codeOf(q)} is a ${def.label} exercise. ${def.support === "pending" ? "The platform has no engine for it yet; the question is kept in place as a placeholder." : "A placeholder keeps its place, items and logic; it cannot field until its design is added."}`,
      suggestion: def.needs.join("; ") });
    if (from !== q.kind) converted.push({ sourceId: q.sourceId, code: codeOf(q), method, from });
  };
  for (const f of findings) {
    for (const id of f.sourceIds) {
      const q = byId.get(id);
      if (!q) continue;
      const decided = decisions[id];
      if (decided === "none") continue;
      if (decided) { convert(q, f, decided); continue; }
      if (f.certainty !== "stated" || f.support === "native" || exported) continue;
      if (q.settings?.methodPlaceholder || !asksSomething(q)) continue;
      convert(q, f, f.method);
    }
  }
  return { canonical: c, converted };
}

/** what is still to be added for the exercises, for the final report */
export function pendingMethodology(c: CanonicalSurvey): { code: string; sourceId: string; label: string; support: MethodSupport; needs: string[] }[] {
  return c.questions.filter((q) => q.settings?.methodPlaceholder || q.kind === "maxdiff" || q.kind === "conjoint" || q.kind === "acbc").map((q) => {
    const p = q.settings?.methodPlaceholder as { label?: string; support?: MethodSupport; needs?: string[] } | undefined;
    const def = METHODS.find((m) => m.kind === q.kind) ?? METHODS[0];
    return { code: codeOf(q), sourceId: q.sourceId, label: p?.label ?? def.label, support: p?.support ?? "needs_design", needs: p?.needs ?? def.needs };
  });
}
