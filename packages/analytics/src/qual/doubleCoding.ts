import type { QualCodebook, QualExcerpt, QualHistoryEntry, QualSegment, QualState } from "./types.js";
import { agreement, cohenKappa, kappaWords, type AgreementReport, type KappaTable } from "./kappa.js";
import { applyQualOp, nextExcerptId, type QualOp } from "./codebook.js";

/**
 * BLIND DOUBLE-CODING (2026-10-22) — a set of segments assigned to two coders
 * (two people, or a person and the AI), each coding into a PRIVATE set the other
 * cannot see; when both have submitted, agreement per code (Cohen's κ, and
 * Krippendorff's α — nominal, which also takes more than two coders and missing
 * codings) and overall (pooled over codes, and the mean of the per-code values),
 * then a disagreement review: each (segment, code) the coders disagree on is
 * resolved — apply or do not apply — with a note, by a named person, kept in the
 * history; the agreed and resolved codings are merged into the main coding as
 * reviewed excerpts.
 *
 *   sampleUnits     a stratified, seeded sample of participant segments (x % of each source, at least one)
 *   coderView       what one coder may see: their own set, never the other's, until both submitted
 *   assignmentAgreement  κ and α per code, pooled, mean
 *   krippendorffAlpha    nominal α from a units × coders table (null = missing)
 *   disagreements / resolve / mergeResolved
 *
 * Pure.
 */

export type Coder = string; // a user id, or "ai"
export type AssignmentStatus = "coding" | "review" | "merged" | "cancelled";
export interface Resolution { unit: string; codeId: string; decision: "apply" | "not_apply"; note?: string; by: string; at: string }
export interface CodingAssignment {
  id: string;
  name: string;
  coderA: Coder;
  coderB: Coder;
  /** segment keys "<sourceId>|<segmentId>" */
  units: string[];
  overlapPct: number;
  seed: number;
  /** the codes in scope (the codebook when the assignment was made) */
  codeIds: string[];
  status: AssignmentStatus;
  submitted: Record<string, string>;
  resolutions: Resolution[];
  createdBy: string;
  createdAt: string;
}
export interface CoderSet { coder: Coder; excerpts: QualExcerpt[] }

const segKey = (x: { sourceId: string; segmentId?: string; id?: string }) => `${x.sourceId}|${x.segmentId ?? x.id}`;

/** a small seeded generator (mulberry32) — the same seed gives the same sample */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** x % of each source's participant segments (at least one per source, at most all), seeded and stratified by source */
export function sampleUnits(segments: readonly QualSegment[], pct: number, seed: number, opts: { sourceIds?: string[] } = {}): string[] {
  const p = Math.max(1, Math.min(100, Math.round(pct)));
  const rnd = seededRandom(seed);
  const bySource = new Map<string, QualSegment[]>();
  for (const s of segments) if (s.role !== "moderator" && s.text.trim() && (!opts.sourceIds?.length || opts.sourceIds.includes(s.sourceId))) { const l = bySource.get(s.sourceId) ?? []; l.push(s); bySource.set(s.sourceId, l); }
  const out: string[] = [];
  for (const src of [...bySource.keys()].sort()) {
    const list = [...bySource.get(src)!].sort((a, b) => a.index - b.index);
    const n = Math.min(list.length, Math.max(1, Math.round((list.length * p) / 100)));
    const shuffled = list.map((s) => ({ s, r: rnd() })).sort((a, b) => a.r - b.r).slice(0, n).map((x) => x.s).sort((a, b) => a.index - b.index);
    out.push(...shuffled.map(segKey));
  }
  return out;
}

export function newAssignment(input: { id: string; name?: string; coderA: Coder; coderB: Coder; segments: readonly QualSegment[]; overlapPct: number; seed?: number; sourceIds?: string[]; codebook: QualCodebook; actor: string; now: string }): CodingAssignment {
  if (!input.coderA || !input.coderB || input.coderA === input.coderB) throw new Error("double-coding needs two different coders");
  const codeIds = input.codebook.codes.filter((c) => c.status !== "rejected").map((c) => c.id);
  if (!codeIds.length) throw new Error("the codebook has no codes yet — double-coding applies existing codes; propose or add codes first");
  const seed = input.seed ?? (Date.parse(input.now) % 2147483647);
  const units = sampleUnits(input.segments, input.overlapPct, seed, { sourceIds: input.sourceIds });
  if (!units.length) throw new Error("there are no participant segments to assign");
  return { id: input.id, name: input.name?.trim() || `Double-coding ${Math.round(input.overlapPct)}%`, coderA: input.coderA, coderB: input.coderB, units, overlapPct: Math.round(input.overlapPct), seed, codeIds, status: "coding", submitted: {}, resolutions: [], createdBy: input.actor, createdAt: input.now };
}

export const isCoderOf = (a: CodingAssignment, who: string): "A" | "B" | null => (a.coderA === who ? "A" : a.coderB === who ? "B" : null);
export const bothSubmitted = (a: CodingAssignment): boolean => !!a.submitted[a.coderA] && !!a.submitted[a.coderB];

/**
 * What one person may see of an assignment. A coder sees their own set and the units; the other coder's set is
 * hidden until both have submitted (blind). Someone who is not a coder (the study lead) sees the progress — how
 * many units each has coded — and, once both have submitted, everything.
 */
export function coderView(a: CodingAssignment, sets: readonly CoderSet[], viewer: string): { role: "A" | "B" | "lead"; mine: QualExcerpt[]; other: QualExcerpt[] | null; progress: Record<string, number>; blind: boolean } {
  const role = isCoderOf(a, viewer) ?? "lead";
  const units = new Set(a.units);
  const coded = (c: Coder) => new Set((sets.find((s) => s.coder === c)?.excerpts ?? []).filter((e) => units.has(segKey(e))).map(segKey)).size;
  const progress = { [a.coderA]: coded(a.coderA), [a.coderB]: coded(a.coderB) };
  const open = bothSubmitted(a);
  const setOf = (c: Coder) => sets.find((s) => s.coder === c)?.excerpts ?? [];
  if (role === "lead") return { role, mine: [], other: open ? [...setOf(a.coderA), ...setOf(a.coderB)] : null, progress, blind: !open };
  const me = role === "A" ? a.coderA : a.coderB, them = role === "A" ? a.coderB : a.coderA;
  return { role, mine: setOf(me), other: open ? setOf(them) : null, progress, blind: !open };
}

/** a coder's operation on their private set: only coding (add / remove an excerpt) of units in the assignment, codes in scope */
export function applyCoderOp(a: CodingAssignment, set: CoderSet, op: QualOp, codebook: QualCodebook, env: { now: string; segment: (sourceId: string, segmentId: string) => QualSegment | undefined }): CoderSet {
  if (a.status !== "coding") throw new Error("this assignment is no longer open for coding");
  if (a.submitted[set.coder]) throw new Error("you have submitted your coding — it is locked so the comparison is fair");
  if (op.op !== "add_excerpt" && op.op !== "remove_excerpt") throw new Error("in a blind assignment a coder only applies or removes codes; change the codebook in the main coding");
  if (op.op === "add_excerpt") {
    if (!a.units.includes(`${op.sourceId}|${op.segmentId}`)) throw new Error("that segment is not in this assignment");
    if (!a.codeIds.includes(op.codeId)) throw new Error("that code is not in this assignment's codebook");
  } else if (!set.excerpts.some((e) => e.id === op.excerptId)) throw new Error("there is no such excerpt in your coding");
  const r = applyQualOp({ codebook, excerpts: set.excerpts }, op, { actor: set.coder, now: env.now, segment: env.segment });
  /* the excerpt is the coder's, and stays theirs: a blind set is never "reviewed" */
  return { coder: set.coder, excerpts: r.state.excerpts.map((e) => ({ ...e, coder: set.coder })) };
}

/* ------------------------------------------------------------ Krippendorff's alpha */

export interface AlphaResult { alpha: number | null; n: number; units: number; observed: number; expected: number }

/**
 * Krippendorff's α for NOMINAL data. `data[u][c]` is coder c's value for unit u, or null (missing). Units with
 * fewer than two values are not pairable and are left out. Coincidences o_ck = Σ_u (pairs of values c,k in u) /
 * (m_u − 1); n_c = Σ_k o_ck; n = Σ n_c; α = 1 − (n − 1) · Σ_{c≠k} o_ck / Σ_{c≠k} n_c·n_k. Null when there is no
 * variation at all (every value the same: expected disagreement 0).
 */
export function krippendorffAlpha(data: readonly (readonly (string | number | boolean | null | undefined)[])[]): AlphaResult {
  const o = new Map<string, number>();
  const values = new Set<string>();
  let units = 0;
  for (const row of data) {
    const vals = row.filter((v): v is string | number | boolean => v !== null && v !== undefined).map(String);
    const m = vals.length;
    if (m < 2) continue;
    units++;
    for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) if (i !== j) { const key = `${vals[i]}\u0000${vals[j]}`; o.set(key, (o.get(key) ?? 0) + 1 / (m - 1)); values.add(vals[i]); }
  }
  const nc = new Map<string, number>();
  for (const [key, v] of o) { const c = key.split("\u0000")[0]; nc.set(c, (nc.get(c) ?? 0) + v); }
  const n = [...nc.values()].reduce((s, x) => s + x, 0);
  let dObs = 0;
  for (const [key, v] of o) { const [c, k] = key.split("\u0000"); if (c !== k) dObs += v; }
  let dExp = 0;
  const vs = [...values];
  for (const c of vs) for (const k of vs) if (c !== k) dExp += (nc.get(c) ?? 0) * (nc.get(k) ?? 0);
  const r = (x: number) => Math.round(x * 10000) / 10000;
  if (n <= 1 || dExp === 0) return { alpha: null, n: r(n), units, observed: r(dObs), expected: r(dExp) };
  return { alpha: r(1 - ((n - 1) * dObs) / dExp), n: r(n), units, observed: r(dObs), expected: r(dExp) };
}

/** Krippendorff's suggested reading (2004): α ≥ .800 reliable, .667–.800 tentative conclusions only, below not reliable — a convention */
export function alphaWords(a: number | null): string {
  if (a === null) return "undefined (no variation)";
  if (a >= 0.8) return "reliable (≥ .80)";
  if (a >= 0.667) return "tentative (.667–.80)";
  return "not reliable (< .667)";
}

/* ------------------------------------------------------------ agreement on an assignment */

export interface CodeAgreementRow { codeId: string; codeName: string; kappa: number | null; kappaWords: string; alpha: number | null; alphaWords: string; table: KappaTable; disagreements: { unit: string; appliedBy: "A" | "B" }[] }
export interface AssignmentAgreement {
  coderA: Coder; coderB: Coder; units: number;
  codes: CodeAgreementRow[];
  /** κ and α over every (segment, code) pair pooled */
  pooled: { kappa: number | null; alpha: number | null; table: KappaTable };
  meanKappa: number | null; meanAlpha: number | null;
  /** the classic κ report (for the Word report's table) */
  report: AgreementReport;
  note: string;
}

const mean = (xs: (number | null)[]) => { const d = xs.filter((x): x is number => x !== null); return d.length ? Math.round((d.reduce((s, x) => s + x, 0) / d.length) * 10000) / 10000 : null; };

export function assignmentAgreement(a: CodingAssignment, sets: readonly CoderSet[], codebook: QualCodebook): AssignmentAgreement {
  const A = sets.find((s) => s.coder === a.coderA)?.excerpts ?? [], B = sets.find((s) => s.coder === a.coderB)?.excerpts ?? [];
  const units = new Set(a.units);
  const appliedA = (code: string) => new Set(A.filter((e) => e.codeId === code && units.has(segKey(e))).map(segKey));
  const appliedB = (code: string) => new Set(B.filter((e) => e.codeId === code && units.has(segKey(e))).map(segKey));
  const names = new Map(codebook.codes.map((c) => [c.id, c.name]));
  const pooled: KappaTable = { both: 0, onlyA: 0, onlyB: 0, neither: 0 };
  const pooledRows: [number, number][] = [];
  const codes: CodeAgreementRow[] = a.codeIds.map((codeId) => {
    const ia = appliedA(codeId), ib = appliedB(codeId);
    const t: KappaTable = { both: 0, onlyA: 0, onlyB: 0, neither: 0 };
    const rows: [number, number][] = [];
    const disagreements: CodeAgreementRow["disagreements"] = [];
    for (const u of a.units) {
      const x = ia.has(u), y = ib.has(u);
      if (x && y) t.both++; else if (x) { t.onlyA++; disagreements.push({ unit: u, appliedBy: "A" }); } else if (y) { t.onlyB++; disagreements.push({ unit: u, appliedBy: "B" }); } else t.neither++;
      rows.push([x ? 1 : 0, y ? 1 : 0]);
    }
    pooled.both += t.both; pooled.onlyA += t.onlyA; pooled.onlyB += t.onlyB; pooled.neither += t.neither;
    pooledRows.push(...rows);
    const k = cohenKappa(t).kappa, al = krippendorffAlpha(rows).alpha;
    return { codeId, codeName: names.get(codeId) ?? codeId, kappa: k, kappaWords: kappaWords(k), alpha: al, alphaWords: alphaWords(al), table: t, disagreements };
  }).sort((x, y) => (x.kappa ?? 2) - (y.kappa ?? 2) || x.codeName.localeCompare(y.codeName));
  const state: QualState = { codebook, excerpts: [...A.map((e) => ({ ...e, coder: a.coderA })), ...B.map((e) => ({ ...e, coder: a.coderB }))] };
  const report = agreement(state, a.coderA, a.coderB, { units: a.units });
  return {
    coderA: a.coderA, coderB: a.coderB, units: a.units.length, codes,
    pooled: { kappa: cohenKappa(pooled).kappa, alpha: krippendorffAlpha(pooledRows).alpha, table: pooled },
    meanKappa: mean(codes.map((c) => c.kappa)), meanAlpha: mean(codes.map((c) => c.alpha)), report,
    note: `Blind double-coding of ${a.units.length} segment${a.units.length === 1 ? "" : "s"} (${a.overlapPct}% of each source's participant segments, seeded). Per code: Cohen's κ and Krippendorff's α (nominal; applied / not applied). Pooled: every (segment, code) decision together. Bands are conventions (Landis & Koch for κ; Krippendorff for α), not tests.`,
  };
}

/* ------------------------------------------------------------ disagreements and their resolution */

export interface Disagreement { unit: string; codeId: string; codeName: string; appliedBy: "A" | "B"; quoteA?: string; quoteB?: string; resolution?: Resolution }

export function disagreements(a: CodingAssignment, sets: readonly CoderSet[], codebook: QualCodebook): Disagreement[] {
  const agr = assignmentAgreement(a, sets, codebook);
  const A = sets.find((s) => s.coder === a.coderA)?.excerpts ?? [], B = sets.find((s) => s.coder === a.coderB)?.excerpts ?? [];
  const quote = (list: QualExcerpt[], u: string, code: string) => list.find((e) => segKey(e) === u && e.codeId === code)?.quote;
  return agr.codes.flatMap((c) => c.disagreements.map((d) => {
    const res = [...a.resolutions].reverse().find((r) => r.unit === d.unit && r.codeId === c.codeId);
    const qa = quote(A, d.unit, c.codeId), qb = quote(B, d.unit, c.codeId);
    return { unit: d.unit, codeId: c.codeId, codeName: c.codeName, appliedBy: d.appliedBy, ...(qa ? { quoteA: qa } : {}), ...(qb ? { quoteB: qb } : {}), ...(res ? { resolution: res } : {}) };
  }));
}

/** record a decision on one disagreement (a later decision on the same pair supersedes, both stay in the history) */
export function resolve(a: CodingAssignment, r: { unit: string; codeId: string; decision: "apply" | "not_apply"; note?: string }, env: { actor: string; now: string }): { assignment: CodingAssignment; entry: QualHistoryEntry } {
  if (!bothSubmitted(a)) throw new Error("both coders must submit before disagreements are resolved (the coding is blind until then)");
  if (!a.units.includes(r.unit) || !a.codeIds.includes(r.codeId)) throw new Error("that segment or code is not in this assignment");
  if (r.decision !== "apply" && r.decision !== "not_apply") throw new Error("decision is apply or not_apply");
  const res: Resolution = { unit: r.unit, codeId: r.codeId, decision: r.decision, ...(r.note?.trim() ? { note: r.note.trim().slice(0, 1000) } : {}), by: env.actor, at: env.now };
  const next = { ...a, status: "review" as AssignmentStatus, resolutions: [...a.resolutions, res] };
  return { assignment: next, entry: { at: env.now, actor: env.actor, action: "double_coding.resolved", detail: `Resolved a disagreement on ${r.unit.split("|")[1]} (${r.codeId}): ${r.decision === "apply" ? "apply the code" : "do not apply it"}${res.note ? ` — ${res.note}` : ""}`, ids: [a.id] } };
}

/**
 * Merge an assignment into the main coding: every (segment, code) both coders applied, and every disagreement
 * resolved "apply", becomes a REVIEWED excerpt in the main state (coder A's span when A applied it, else B's) —
 * unless the main coding already has that code on that segment. Unresolved disagreements block the merge.
 */
export function mergeResolved(main: QualState, a: CodingAssignment, sets: readonly CoderSet[], env: { actor: string; now: string }): { state: QualState; added: number; entry: QualHistoryEntry } {
  const open = disagreements(a, sets, main.codebook).filter((d) => !d.resolution);
  if (open.length) throw new Error(`${open.length} disagreement${open.length === 1 ? " is" : "s are"} not resolved yet`);
  const A = sets.find((s) => s.coder === a.coderA)?.excerpts ?? [], B = sets.find((s) => s.coder === a.coderB)?.excerpts ?? [];
  const next: QualState = JSON.parse(JSON.stringify(main));
  const have = new Set(next.excerpts.filter((e) => e.status !== "rejected").map((e) => `${e.codeId}|${segKey(e)}`));
  let added = 0;
  const units = new Set(a.units);
  const decided = new Map<string, "apply" | "not_apply">();
  for (const r of a.resolutions) decided.set(`${r.codeId}|${r.unit}`, r.decision);
  for (const codeId of a.codeIds) {
    if (!next.codebook.codes.some((c) => c.id === codeId && c.status !== "rejected")) continue;
    for (const u of units) {
      const ea = A.find((e) => e.codeId === codeId && segKey(e) === u), eb = B.find((e) => e.codeId === codeId && segKey(e) === u);
      const apply = ea && eb ? true : ea || eb ? decided.get(`${codeId}|${u}`) === "apply" : false;
      const src = ea ?? eb;
      if (!apply || !src || have.has(`${codeId}|${u}`)) continue;
      next.excerpts.push({ ...src, id: nextExcerptId(next.excerpts), coder: env.actor, status: "human_reviewed", createdAt: env.now, rationale: `double-coded (${a.name})` });
      have.add(`${codeId}|${u}`); added++;
    }
  }
  return { state: next, added, entry: { at: env.now, actor: env.actor, action: "double_coding.merged", detail: `Merged “${a.name}” into the coding: ${added} reviewed excerpt${added === 1 ? "" : "s"} from agreed and resolved codings`, ids: [a.id] } };
}
