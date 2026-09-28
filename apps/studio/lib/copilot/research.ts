import { ResearchIndex, type ResearchChunk } from "@rescript/import/research";

/**
 * RESEARCH DOCUMENTS, AS THE COPILOT USES THEM (the copilot brief §6–§8).
 *
 * Each document is summarised ONCE, at upload, into a structured research
 * card — objectives, hypotheses, constructs, measurement scales, findings,
 * demographics, gaps, methodology, recommended question areas — each item
 * citing the passages it came from. A later request gets:
 *
 *   the cards (short) when it is about the research at all, and
 *   the few passages BM25 (and embeddings, when configured) rank highest
 *   for the request — never whole documents, and nothing at all for
 *   "change Q18 to a matrix".
 *
 * Pure: the store and the model live with the caller.
 */

export const DOC_SUMMARY_SYSTEM_PROMPT = `You read one research document (an academic paper, literature review, industry report, client brief, methodology note or questionnaire) for a survey researcher who will design a survey from it. Reply with ONE JSON object:
{"title":"...","type":"paper|review|report|brief|questionnaire|methodology|other",
 "objectives":[{"text":"...","passages":["d1#3"]}], "hypotheses":[{"text":"...","passages":[]}],
 "constructs":[{"name":"...","definition":"...","passages":[]}],
 "scales":[{"name":"...","items":<n or null>,"points":<n or null>,"note":"...","passages":[]}],
 "findings":[{"text":"...","passages":[]}], "demographics":[{"text":"...","passages":[]}],
 "gaps":[{"text":"...","passages":[]}], "methodology":{"text":"...","passages":[]},
 "questionAreas":[{"text":"what a survey should ask about","passages":[]}],
 "summary":"3–5 sentences"}
Use only what the document says; cite passage ids (they are given as [d1#3]); leave a list empty rather than guess. Keep each text under 300 characters.`;

export interface CitedItem { text: string; passages: string[] }
export interface DocSummary {
  title?: string;
  type: string;
  summary?: string;
  objectives: CitedItem[];
  hypotheses: CitedItem[];
  constructs: { name: string; definition?: string; passages: string[] }[];
  scales: { name: string; items?: number; points?: number; note?: string; passages: string[] }[];
  findings: CitedItem[];
  demographics: CitedItem[];
  gaps: CitedItem[];
  methodology?: CitedItem;
  questionAreas: CitedItem[];
}

const str = (v: unknown, n = 400) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
const pass = (v: unknown, valid: Set<string>) => (Array.isArray(v) ? v.map(String).filter((p) => valid.has(p)).slice(0, 8) : []);
const cited = (v: unknown, valid: Set<string>, max = 12): CitedItem[] => (Array.isArray(v) ? v.map((x) => { const o = (typeof x === "string" ? { text: x } : x ?? {}) as Record<string, unknown>; const text = str(o.text); return text ? { text, passages: pass(o.passages, valid) } : null; }).filter((x): x is CitedItem => !!x).slice(0, max) : []);

/** The gate on a summary: known fields, citations only to passages that exist. */
export function coerceDocSummary(raw: unknown, chunkIds: string[]): DocSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const valid = new Set(chunkIds);
  const s: DocSummary = {
    ...(str(o.title, 200) ? { title: str(o.title, 200) } : {}),
    type: ["paper", "review", "report", "brief", "questionnaire", "methodology", "other"].includes(String(o.type)) ? String(o.type) : "other",
    ...(str(o.summary, 1200) ? { summary: str(o.summary, 1200) } : {}),
    objectives: cited(o.objectives, valid), hypotheses: cited(o.hypotheses, valid),
    constructs: Array.isArray(o.constructs) ? o.constructs.map((x) => { const c = (x ?? {}) as Record<string, unknown>; const name = str(c.name, 120); return name ? { name, ...(str(c.definition) ? { definition: str(c.definition) } : {}), passages: pass(c.passages, valid) } : null; }).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 20) : [],
    scales: Array.isArray(o.scales) ? o.scales.map((x) => { const c = (x ?? {}) as Record<string, unknown>; const name = str(c.name, 160); const items = Number(c.items), points = Number(c.points); return name ? { name, ...(Number.isInteger(items) && items > 0 ? { items } : {}), ...(Number.isInteger(points) && points > 1 ? { points } : {}), ...(str(c.note) ? { note: str(c.note) } : {}), passages: pass(c.passages, valid) } : null; }).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 20) : [],
    findings: cited(o.findings, valid, 15), demographics: cited(o.demographics, valid), gaps: cited(o.gaps, valid), questionAreas: cited(o.questionAreas, valid, 15),
    ...(o.methodology ? { methodology: cited([o.methodology], valid, 1)[0] } : {}),
  };
  const empty = !s.summary && !s.objectives.length && !s.hypotheses.length && !s.constructs.length && !s.findings.length && !s.questionAreas.length;
  return empty ? null : s;
}

/**
 * What a document's summary is written from: the opening passages (title,
 * abstract, introduction), then the passages that best match the questions a
 * researcher asks of a paper — objectives, hypotheses, method, measures,
 * results, limitations — up to a character budget. A 60-page report is not
 * sent whole; its most informative ~20,000 characters are.
 */
export function summaryInput(chunks: ResearchChunk[], budget = 20_000): { text: string; used: string[] } {
  const picked = new Map<string, ResearchChunk>();
  let chars = 0;
  const take = (c: ResearchChunk) => { if (picked.has(c.id) || chars + c.text.length > budget) return; picked.set(c.id, c); chars += c.text.length; };
  for (const c of chunks.slice(0, 4)) take(c);
  const ix = new ResearchIndex(chunks);
  for (const q of ["objective aim purpose research question", "hypothesis hypotheses predict expect", "method sample survey participants respondents design", "scale measure items likert reliability alpha", "results findings effect significant", "limitation gap future research", "age gender income demographic", "recommend implication"]) {
    for (const r of ix.retrieve(q, 3)) take(r.chunk);
  }
  for (const c of chunks) { if (chars > budget * 0.9) break; take(c); }
  const ordered = [...picked.values()].sort((a, b) => a.seq - b.seq);
  return { text: ordered.map((c) => `[${c.id}] (p.${c.page}${c.heading ? `, ${c.heading}` : ""}${c.kind === "table" ? ", table" : ""})\n${c.text}`).join("\n\n"), used: ordered.map((c) => c.id) };
}

export interface ResearchDocMeta { id: string; name: string; summary: DocSummary | null }

/** The research cards, compactly — what a research request always gets */
export function researchCards(docs: ResearchDocMeta[], maxChars = 6000): string {
  const out: string[] = [];
  docs.forEach((d, i) => {
    const s = d.summary;
    const lines = [`Document ${i + 1} [${d.id}] “${d.name}”${s?.type ? ` (${s.type})` : ""}${s?.title ? ` — ${s.title}` : ""}`];
    if (s?.summary) lines.push(`  Summary: ${s.summary}`);
    const put = (label: string, xs: { text?: string; name?: string; passages: string[] }[]) => { if (xs.length) lines.push(`  ${label}: ${xs.slice(0, 6).map((x) => `${x.text ?? x.name}${x.passages.length ? ` [${x.passages.join(",")}]` : ""}`).join("; ")}`); };
    if (s) {
      put("Objectives", s.objectives); put("Hypotheses", s.hypotheses); put("Constructs", s.constructs);
      put("Scales", s.scales.map((x) => ({ name: `${x.name}${x.items ? ` (${x.items} items` : ""}${x.points ? `${x.items ? ", " : " ("}${x.points}-point` : ""}${x.items || x.points ? ")" : ""}`, passages: x.passages })));
      put("Findings", s.findings); put("Demographics", s.demographics); put("Gaps", s.gaps); put("Question areas", s.questionAreas);
      if (s.methodology) put("Methodology", [s.methodology]);
    } else lines.push("  (no summary — only its passages are available)");
    out.push(lines.join("\n"));
  });
  const text = out.join("\n\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** The passages for this request, labelled for citation */
export function researchPassages(index: ResearchIndex, docs: { id: string; name: string }[], message: string, opts: { k?: number; maxChars?: number; queryEmbedding?: number[] } = {}): { text: string; ids: string[] } {
  // a request that names a document ("the client brief", "paper 2") prefers it
  const boost = new Map<string, number>();
  const t = message.toLowerCase();
  docs.forEach((d, i) => {
    const words = d.name.toLowerCase().replace(/\.[a-z0-9]+$/, "").split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    if (words.some((w) => t.includes(w)) || new RegExp(`\\b(?:document|doc|paper|report|file)\\s*${i + 1}\\b`).test(t)) boost.set(d.id, 3);
  });
  const hits = index.retrieve(message, opts.k ?? 6, { maxChars: opts.maxChars ?? 7000, docBoost: boost, ...(opts.queryEmbedding ? { queryEmbedding: opts.queryEmbedding } : {}) });
  const name = new Map(docs.map((d) => [d.id, d.name]));
  return { text: hits.map((h) => `[${h.chunk.id}] ${name.get(h.chunk.docId) ?? h.chunk.docId}, p.${h.chunk.page}${h.chunk.heading ? ` — ${h.chunk.heading}` : ""}${h.chunk.kind === "table" ? " (table)" : ""}\n${h.chunk.text}`).join("\n\n"), ids: hits.map((h) => h.chunk.id) };
}
