import type { SurveyDefinition } from "@rescript/schema";
import { buildVariableDictionary } from "@rescript/engine";
import type { AnalysisResult } from "./types.js";
import type { DeckDefinition, DeckSlide } from "./deck.js";

/**
 * THE PROVENANCE GRAPH (audit 2026-11-17, P3-02): where every output came from, from the source document to the
 * claim on a slide, as one graph that can be walked.
 *
 *   source_file ──contains──▶ source_item ──imported_as──▶ question ──measured_by──▶ variable
 *   source_item ──configured──▶ setting (a behaviour the importer read from an instruction: prefill, read-only …)
 *   dataset ──feeds──▶ analysis ◀──uses── variable          analysis ──produces──▶ table ──cited_by──▶ claim
 *
 * Built from what the platform already records, not from new bookkeeping: the survey's import records (source id →
 * what it became), the questions' notes (the instruction a behaviour came from), the variable dictionary, each
 * result's provenance (definition, dataset spec, data and survey versions, engine version, input hash) and the
 * deck's sources (P2-11). `explainClaim` answers "where does this sentence come from?" with the path, down to the
 * data and the questionnaire line.
 */

export type LineageKind = "source_file" | "source_item" | "question" | "setting" | "variable" | "dataset" | "analysis" | "table" | "claim";
export interface LineageNode { id: string; kind: LineageKind; label: string; detail?: Record<string, string | number | boolean | null> }
export interface LineageEdge { from: string; to: string; rel: "contains" | "imported_as" | "configured" | "measured_by" | "feeds" | "uses" | "produces" | "cited_by" }
export interface LineageGraph { nodes: LineageNode[]; edges: LineageEdge[] }

export interface LineageInput {
  def: SurveyDefinition;
  /** analysis id → its result (with provenance) */
  results?: Record<string, AnalysisResult | undefined>;
  deck?: DeckDefinition | null;
  /** what the results were computed on, when known */
  dataset?: { n: number; environment: string; dataVersion?: string | null; surveyVersion?: string | null } | null;
}

const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const strip = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

export function buildLineage(input: LineageInput): LineageGraph {
  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];
  const seen = new Set<string>();
  const node = (n: LineageNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return n.id; };
  const edge = (from: string, to: string, rel: LineageEdge["rel"]) => { const k = `${from}>${to}>${rel}`; if (!seen.has(k) && nodes.has(from) && nodes.has(to)) { seen.add(k); edges.push({ from, to, rel }); } };
  const { def } = input;

  /* questions */
  for (const q of def.questions) node({ id: `q:${q.id}`, kind: "question", label: `${q.code} — ${short(strip(q.text ?? ""))}`, detail: { code: q.code, type: q.type } });

  /* imports: the file, its items, what each became; behaviours read from instructions become settings */
  for (const imp of def.imports ?? []) {
    const f = node({ id: `file:${imp.id}`, kind: "source_file", label: `${imp.fileName} (${imp.platform}, ${imp.importedAt.slice(0, 10)})`, detail: { format: imp.format, fingerprint: imp.fingerprint, mode: imp.mode } });
    for (const m of imp.map ?? []) {
      if (m.kind !== "question" && m.kind !== "variable") continue;
      const item = node({ id: `src:${imp.id}:${m.source}`, kind: "source_item", label: `${m.source} in ${imp.fileName}`, detail: { source: m.source, ...(m.reason ? { renamed: m.reason } : {}) } });
      edge(f, item, "contains");
      const q = def.questions.find((x) => x.id === m.rescript || x.code === m.rescript);
      if (q) edge(item, `q:${q.id}`, "imported_as");
    }
  }
  for (const q of def.questions) {
    const notes = (q as { notes?: string | string[] }).notes;
    const lines = Array.isArray(notes) ? notes : typeof notes === "string" ? notes.split(/\n+/) : [];
    lines.filter((l) => /^behaviour: /.test(l)).forEach((l, i) => {
      const s = node({ id: `set:${q.id}:${i}`, kind: "setting", label: `${q.code}: ${short(l.replace(/^behaviour: /, ""), 120)}`, detail: { question: q.code } });
      edge(`q:${q.id}`, s, "configured");
      for (const e of edges.filter((x) => x.to === `q:${q.id}` && x.rel === "imported_as")) edge(e.from, s, "configured");
    });
  }

  /* variables */
  const varOf = new Map<string, string>();
  for (const v of buildVariableDictionary(def)) {
    const id = node({ id: `v:${v.name}`, kind: "variable", label: `${v.name} — ${short(v.label ?? "")}` });
    varOf.set(v.name, id);
    if (v.questionId && nodes.has(`q:${v.questionId}`)) edge(`q:${v.questionId}`, id, "measured_by");
  }

  /* the data, the analyses, their tables */
  const ds = input.dataset;
  const dsId = ds ? node({ id: "dataset", kind: "dataset", label: `${ds.n} ${ds.environment.toLowerCase()} responses`, detail: { n: ds.n, environment: ds.environment, dataVersion: ds.dataVersion ?? null, surveyVersion: ds.surveyVersion ?? null } }) : null;
  for (const [aid, r] of Object.entries(input.results ?? {})) {
    if (!r) continue;
    const p = r.provenance;
    const vars = [...new Set([...(r.variablesUsed ?? []), ...((p?.definition as { variables?: string[] } | undefined)?.variables ?? [])])];
    const a = node({ id: `a:${aid}`, kind: "analysis", label: `${r.name ?? aid} (${r.kind ?? "analysis"})`, detail: { kind: r.kind ?? null, n: r.base?.n ?? null, engine: p?.engineVersion ?? null, inputHash: p?.inputHash ?? null, dataVersion: p?.dataVersion ?? null, surveyVersion: p?.surveyVersion ?? null, computedAt: r.computedAt ?? null } });
    if (dsId) edge(dsId, a, "feeds");
    for (const v of vars) {
      const vid = varOf.get(v) ?? node({ id: `v:${v}`, kind: "variable", label: v });
      edge(vid, a, "uses");
    }
    for (const t of r.tables ?? []) { const tid = node({ id: `t:${aid}:${t.id}`, kind: "table", label: t.title, detail: { rows: t.rows.length, base: t.base?.n ?? null } }); edge(a, tid, "produces"); }
  }

  /* the deck's claims and the tables they cite */
  const deck = input.deck;
  if (deck) {
    const tableOfRef = new Map<string, string>();
    for (const s of deck.sources ?? []) {
      if (s.analysisId) {
        const r = input.results?.[s.analysisId];
        const t = r?.tables.find((x) => x.id === "groups") ?? r?.tables[0];
        if (t) tableOfRef.set(s.ref, `t:${s.analysisId}:${t.id}`);
      } else if (s.table) {
        const tid = node({ id: `t:evidence:${s.ref}`, kind: "table", label: `${s.ref} · ${s.title}`, detail: { rows: s.table.rows.length, base: s.table.base?.n ?? null, evidence: true } });
        if (dsId) edge(dsId, tid, "feeds");
        tableOfRef.set(s.ref, tid);
      }
    }
    deck.slides.forEach((sl, i) => {
      for (const c of claimsOf(sl)) {
        const cid = node({ id: `c:${i}:${c.index}`, kind: "claim", label: short(c.text, 140), detail: { slide: i + 1, slideType: sl.type } });
        for (const ref of c.refs) { const tid = tableOfRef.get(ref); if (tid) edge(tid, cid, "cited_by"); }
      }
    });
  }
  return { nodes: [...nodes.values()], edges };
}

/** the claims a slide makes, with the refs each cites */
function claimsOf(sl: DeckSlide): { index: number; text: string; refs: string[] }[] {
  if (sl.type === "key_finding" || sl.type === "segment_comparison" || sl.type === "statistical_highlight") return sl.source ? [{ index: 0, text: sl.title, refs: [sl.source] }] : [];
  if (sl.type === "summary" || sl.type === "implications" || sl.type === "recommendations") {
    const items = sl.type === "recommendations" ? sl.items : sl.bullets;
    if (sl.refs) return items.map((t, i) => ({ index: i, text: t, refs: sl.refs![i] ?? [] })).filter((c) => c.refs.length);
    return sl.sources?.length ? items.map((t, i) => ({ index: i, text: t, refs: sl.sources! })) : [];
  }
  return [];
}

export interface ClaimExplanation { claim: LineageNode; tables: LineageNode[]; analyses: LineageNode[]; variables: LineageNode[]; questions: LineageNode[]; settings: LineageNode[]; sources: LineageNode[]; files: LineageNode[]; dataset: LineageNode | null }

/** walk back from a claim to its tables, analyses, variables, questions, the source lines and the data */
export function explainClaim(g: LineageGraph, claimId: string): ClaimExplanation | null {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const claim = byId.get(claimId);
  if (!claim || claim.kind !== "claim") return null;
  const into = (id: string, rel?: LineageEdge["rel"][]) => g.edges.filter((e) => e.to === id && (!rel || rel.includes(e.rel))).map((e) => e.from);
  const uniq = (ids: string[]) => [...new Set(ids)].map((id) => byId.get(id)!).filter(Boolean);
  const tables = uniq(into(claimId, ["cited_by"]));
  const analyses = uniq(tables.flatMap((t) => into(t.id, ["produces"])));
  const variables = uniq(analyses.flatMap((a) => into(a.id, ["uses"])));
  const questions = uniq(variables.flatMap((v) => into(v.id, ["measured_by"])));
  const settings = uniq(questions.flatMap((q) => g.edges.filter((e) => e.from === q.id && e.rel === "configured").map((e) => e.to)));
  const sources = uniq(questions.flatMap((q) => into(q.id, ["imported_as"])));
  const files = uniq(sources.flatMap((s) => into(s.id, ["contains"])));
  const datasetIds = [...analyses, ...tables].flatMap((x) => into(x.id, ["feeds"]));
  return { claim, tables, analyses, variables, questions, settings, sources, files, dataset: datasetIds.length ? byId.get(datasetIds[0]) ?? null : null };
}

/** every claim in the graph, with whether it reaches a table and the data */
export function lineageCoverage(g: LineageGraph): { claims: number; reachTable: number; reachData: number; orphaned: string[] } {
  const claims = g.nodes.filter((n) => n.kind === "claim");
  let reachTable = 0, reachData = 0; const orphaned: string[] = [];
  for (const c of claims) {
    const e = explainClaim(g, c.id)!;
    if (e.tables.length) reachTable++; else orphaned.push(c.label);
    if (e.dataset) reachData++;
  }
  return { claims: claims.length, reachTable, reachData, orphaned };
}
