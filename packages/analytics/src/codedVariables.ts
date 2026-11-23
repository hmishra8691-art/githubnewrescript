import type { SurveyDefinition, VariableDef } from "@rescript/schema";
import type { Case, Dataset, VariableMeta } from "./dataset.js";
import type { QualCodebook, QualExcerpt } from "./qual/types.js";

/**
 * CODED ANSWERS AS VARIABLES (Q7, 2026-11-22) — what people said in an open-ended answer (typed, a voice answer's
 * transcript, or a recorded video answer's transcript), coded in the qualitative workspace, becomes columns any table,
 * crosstab or model can use:
 *
 *   <VAR>_CODED          1 when the answer was coded with at least one code, 0 when it was coded with none
 *   <VAR>_<CODE>         one per code used on that question: 1 = the answer was coded with it, 0 = it was not
 *
 * The BASE is the answers that were actually in a coded source (the open-ended answers a researcher added to the
 * workspace): an answer that has not been through coding (a later response, an empty answer) is missing, never a 0,
 * so "12% mention price" is 12% of the answers that were read. Rejected codes and rejected excerpts are left out;
 * AI-suggested codes a person has not reviewed are counted and the variable says how many of its excerpts were
 * reviewed. Pure: the caller loads the coding and the sources.
 */

export interface CodedSegment { responseId: string; questionId: string; segmentId: string }

export interface CodedVariables {
  variables: VariableMeta[];
  /** responseId → column → 0 / 1 */
  values: Map<string, Record<string, number>>;
  /** per question: answers in coded sources, and the codes used */
  questions: { questionId: string; code: string; answers: number; codes: number; reviewedShare: number }[];
}

const NAME_SAFE = (s: string) => s.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").toUpperCase().slice(0, 24) || "CODE";

export function codedVariables(def: SurveyDefinition, coding: { codebook: QualCodebook; excerpts: QualExcerpt[] } | null, segments: CodedSegment[]): CodedVariables {
  const out: CodedVariables = { variables: [], values: new Map(), questions: [] };
  if (!coding || !segments.length) return out;
  const codes = new Map(coding.codebook.codes.filter((c) => c.status !== "rejected").map((c) => [c.id, c]));
  const themes = new Map(coding.codebook.themes.map((t) => [t.id, t.name]));
  const bySegment = new Map(segments.map((s) => [s.segmentId, s]));
  /* question → response → codes; question → covered responses */
  const coded = new Map<string, Map<string, Set<string>>>();
  const covered = new Map<string, Set<string>>();
  for (const s of segments) { if (!covered.has(s.questionId)) covered.set(s.questionId, new Set()); covered.get(s.questionId)!.add(s.responseId); }
  const reviewed = new Map<string, { all: number; reviewed: number }>();
  for (const e of coding.excerpts) {
    if (e.status === "rejected" || !codes.has(e.codeId)) continue;
    const seg = bySegment.get(e.segmentId);
    if (!seg) continue;
    const byResp = coded.get(seg.questionId) ?? new Map<string, Set<string>>();
    coded.set(seg.questionId, byResp);
    (byResp.get(seg.responseId) ?? byResp.set(seg.responseId, new Set()).get(seg.responseId)!).add(e.codeId);
    const k = `${seg.questionId}:${e.codeId}`;
    const r = reviewed.get(k) ?? { all: 0, reviewed: 0 };
    r.all++; if (e.status === "human_reviewed") r.reviewed++;
    reviewed.set(k, r);
  }
  const taken = new Set(def.questions.map((q) => q.variableName.toUpperCase()));
  for (const q of def.questions) {
    const responses = covered.get(q.id);
    if (!responses?.size) continue;
    const byResp = coded.get(q.id) ?? new Map<string, Set<string>>();
    const used = coding.codebook.codes.filter((c) => codes.has(c.id) && [...byResp.values()].some((set) => set.has(c.id)));
    const base = q.variableName;
    const columns: { name: string; codeId: string | null }[] = [{ name: `${base}_CODED`, codeId: null }];
    const names = new Set<string>([`${base}_CODED`.toUpperCase()]);
    for (const c of used) {
      let name = `${base}_${NAME_SAFE(c.name)}`;
      for (let i = 2; names.has(name.toUpperCase()) || taken.has(name.toUpperCase()); i++) name = `${base}_${NAME_SAFE(c.name)}_${i}`;
      names.add(name.toUpperCase());
      columns.push({ name, codeId: c.id });
    }
    const yesNo = [{ code: "0", label: "Not mentioned" }, { code: "1", label: "Mentioned" }];
    for (const col of columns) {
      const c = col.codeId ? codes.get(col.codeId)! : null;
      const rv = col.codeId ? reviewed.get(`${q.id}:${col.codeId}`) : undefined;
      const theme = c?.themeId ? themes.get(c.themeId) : undefined;
      out.variables.push({
        name: col.name,
        label: c ? `${q.code} — coded: ${c.name}${theme ? ` (theme: ${theme})` : ""}` : `${q.code} — coded at all`,
        itemLabel: c ? c.name : "Coded",
        role: "categorical", questionId: q.id, questionCode: String(q.code), questionType: "coded",
        categories: c ? yesNo : [{ code: "0", label: "No code" }, { code: "1", label: "At least one code" }],
        derived: true, hidden: false,
        ...(rv ? { note: `${rv.reviewed} of ${rv.all} excerpts reviewed by a person; the rest are AI suggestions.` } : { note: `Base: ${responses.size} answers in coded sources.` }),
      });
    }
    for (const rid of responses) {
      const set = byResp.get(rid) ?? new Set<string>();
      const row = out.values.get(rid) ?? {};
      for (const col of columns) row[col.name] = col.codeId ? (set.has(col.codeId) ? 1 : 0) : (set.size ? 1 : 0);
      out.values.set(rid, row);
    }
    const all = used.reduce((n, c) => n + (reviewed.get(`${q.id}:${c.id}`)?.all ?? 0), 0);
    const rev = used.reduce((n, c) => n + (reviewed.get(`${q.id}:${c.id}`)?.reviewed ?? 0), 0);
    out.questions.push({ questionId: q.id, code: String(q.code), answers: responses.size, codes: used.length, reviewedShare: all ? Math.round((rev / all) * 1000) / 10 : 0 });
  }
  return out;
}

/** the dataset with the coded columns added; cases outside the coded base get null (missing), never 0 */
export function withCodedVariables(ds: Dataset, coded: CodedVariables): Dataset {
  if (!coded.variables.length) return ds;
  const fresh = coded.variables.filter((v) => !ds.byName.has(v.name));
  if (!fresh.length) return ds;
  const cases: Case[] = ds.cases.map((c) => {
    const row = coded.values.get(c.id);
    const vars = { ...c.vars };
    for (const v of fresh) vars[v.name] = row && v.name in row ? row[v.name] : null;
    return { ...c, vars };
  });
  const byName = new Map(ds.byName);
  for (const v of fresh) byName.set(v.name, v);
  return { ...ds, cases, variables: [...ds.variables, ...fresh], byName };
}

/**
 * The coded columns for a DATA EXPORT (CSV, Excel, SPSS, SAS, Stata — @rescript/exporters' DerivedColumns): the same
 * variables as numeric 0 / 1 dictionary entries with value labels. A response outside the coded base gets no
 * value (missing), never 0. `idAt(i)` is the response id of the i-th delivered row.
 */
export function codedExportColumns(coded: CodedVariables | null, idAt: (index: number) => string | undefined): { defs: VariableDef[]; value: (index: number) => Record<string, number> | undefined } | undefined {
  if (!coded || !coded.variables.length) return undefined;
  const defs = coded.variables.map((v): VariableDef => ({
    name: v.name, label: v.label, ...(v.questionId ? { questionId: v.questionId } : {}), ...(v.questionCode ? { questionCode: v.questionCode } : {}),
    dataType: "numeric", responseType: "coded",
    valueCodes: (v.categories ?? []).map((c) => Number(c.code)),
    valueLabels: Object.fromEntries((v.categories ?? []).map((c) => [String(c.code), c.label])),
    derived: true, hidden: false, measure: "nominal",
    ...(v.note ? { notes: v.note } : {}),
  }) as VariableDef);
  return { defs, value: (i) => { const id = idAt(i); return id ? coded.values.get(id) : undefined; } };
}
