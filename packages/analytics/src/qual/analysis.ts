import type { QualCode, QualExcerpt, QualSegment, QualState, QualTheme } from "./types.js";
import { tokenize, sentimentOf } from "../analyses/business.js";

/**
 * QUALITATIVE ANALYSIS (2026-10-18) — what the coded data show, said as a
 * qualitative researcher would say it:
 *
 *   • theme FREQUENCY and distribution across segments, sources and groups —
 *     always with the note that frequency is not importance, prevalence in the
 *     population or statistical significance;
 *   • NEGATIVE / contradictory cases — excerpts a reviewer marked as evidence
 *     against a theme, and excerpts of codes that `contradicts` a code in it;
 *   • REPRESENTATIVE QUOTES — reviewed excerpts from different sources and
 *     speakers, each an exact span of its source;
 *   • EVIDENCE-BASED SUMMARIES — every claim cites the excerpt ids it rests on;
 *     a claim citing nothing, or an excerpt that does not exist, is dropped;
 *   • SENTIMENT only as a lexicon reading of the excerpts, labelled as one.
 *
 * Rejected codes, themes and excerpts are left out; moderator turns are never
 * counted as evidence of what participants think. Pure.
 */

export const FREQUENCY_NOTE = "Frequency is not importance: a theme mentioned often is not necessarily the most important, and counts from a purposive qualitative sample are not population estimates or tests of significance.";

const liveExcerpts = (state: QualState) => {
  const ok = new Set(state.codebook.codes.filter((c) => c.status !== "rejected").map((c) => c.id));
  return state.excerpts.filter((e) => e.status !== "rejected" && ok.has(e.codeId));
};
const segKey = (x: { sourceId: string; segmentId?: string; id?: string }) => `${x.sourceId}|${x.segmentId ?? x.id}`;

/** the codes of a theme, its subthemes' included */
export function codesOfTheme(state: QualState, themeId: string): QualCode[] {
  const themes = new Set<string>([themeId]);
  let grew = true;
  while (grew) { grew = false; for (const t of state.codebook.themes) if (t.parentId && themes.has(t.parentId) && !themes.has(t.id)) { themes.add(t.id); grew = true; } }
  return state.codebook.codes.filter((c) => c.status !== "rejected" && c.themeId && themes.has(c.themeId));
}

export interface QualFrequencyCell { excerpts: number; segments: number; sources: number; /** segments mentioning ÷ participant segments in the group, 0–100 */ share: number }
export interface QualFrequencyRow { id: string; name: string; level: "theme" | "subtheme" | "code"; parentId?: string | null; total: QualFrequencyCell; byGroup: Record<string, QualFrequencyCell> }
export interface QualFrequencyTable { groups: string[]; groupTotals: Record<string, { segments: number; sources: number }>; rows: QualFrequencyRow[]; base: { segments: number; sources: number }; note: string }

/**
 * Theme (and code) frequency by group. `groupOf` says which group a segment belongs to — the
 * participant segment from the speaker map, a survey answer's banner, a session's segment; segments
 * with no group are "All" only.
 */
export function themeFrequency(state: QualState, segments: readonly QualSegment[], opts: { groupOf?: (s: QualSegment) => string | undefined; level?: "theme" | "code" | "both" } = {}): QualFrequencyTable {
  const groupOf = opts.groupOf ?? ((s: QualSegment) => s.group);
  const participant = segments.filter((s) => s.role !== "moderator");
  const segByKey = new Map(participant.map((s) => [segKey(s), s]));
  const ex = liveExcerpts(state).filter((e) => segByKey.has(segKey(e)));
  const groups = [...new Set(participant.map(groupOf).filter((g): g is string => !!g))].sort();
  const groupTotals: QualFrequencyTable["groupTotals"] = {};
  for (const g of groups) { const ss = participant.filter((s) => groupOf(s) === g); groupTotals[g] = { segments: ss.length, sources: new Set(ss.map((s) => s.sourceId)).size }; }
  const base = { segments: participant.length, sources: new Set(participant.map((s) => s.sourceId)).size };
  const cell = (list: QualExcerpt[], denom: number): QualFrequencyCell => { const segs = new Set(list.map(segKey)); return { excerpts: list.length, segments: segs.size, sources: new Set(list.map((e) => e.sourceId)).size, share: denom ? Math.round((segs.size / denom) * 1000) / 10 : 0 }; };
  const row = (id: string, name: string, level: QualFrequencyRow["level"], codeIds: Set<string>, parentId?: string | null): QualFrequencyRow => {
    const mine = ex.filter((e) => codeIds.has(e.codeId));
    const byGroup: Record<string, QualFrequencyCell> = {};
    for (const g of groups) byGroup[g] = cell(mine.filter((e) => groupOf(segByKey.get(segKey(e))!) === g), groupTotals[g].segments);
    return { id, name, level, ...(parentId ? { parentId } : {}), total: cell(mine, base.segments), byGroup };
  };
  const rows: QualFrequencyRow[] = [];
  const level = opts.level ?? "both";
  if (level !== "code") {
    const ordered: QualTheme[] = [];
    const live = state.codebook.themes.filter((t) => t.status !== "rejected");
    for (const t of live.filter((x) => !x.parentId || !live.some((p) => p.id === x.parentId))) { ordered.push(t); ordered.push(...live.filter((x) => x.parentId === t.id)); }
    for (const t of ordered) rows.push(row(t.id, t.name, t.parentId ? "subtheme" : "theme", new Set(codesOfTheme(state, t.id).map((c) => c.id)), t.parentId));
  }
  if (level !== "theme") for (const c of state.codebook.codes.filter((x) => x.status !== "rejected")) rows.push(row(c.id, c.name, "code", new Set([c.id]), c.themeId));
  return { groups, groupTotals, rows, base, note: FREQUENCY_NOTE };
}

/** excerpts that argue against a theme: marked as negative cases, or coded to a code that contradicts one of the theme's codes */
export function negativeCases(state: QualState, themeId: string): QualExcerpt[] {
  const mine = new Set(codesOfTheme(state, themeId).map((c) => c.id));
  const against = new Set<string>();
  for (const r of state.codebook.relationships) if (r.kind === "contradicts") { if (mine.has(r.from)) against.add(r.to); if (mine.has(r.to)) against.add(r.from); }
  return liveExcerpts(state).filter((e) => (mine.has(e.codeId) && e.negativeCase) || (against.has(e.codeId) && !mine.has(e.codeId)));
}

/**
 * Up to `n` quotes that show a theme or code: reviewed before suggested, one per source (then per
 * speaker) before a second from the same, a readable length first, negative cases left out. Each is
 * an exact span of its source.
 */
export function representativeQuotes(state: QualState, segments: readonly QualSegment[], target: { themeId?: string; codeId?: string }, n = 3): QualExcerpt[] {
  const codes = target.codeId ? new Set([target.codeId]) : new Set(codesOfTheme(state, target.themeId ?? "").map((c) => c.id));
  const moderator = new Set(segments.filter((s) => s.role === "moderator").map(segKey));
  const pool = liveExcerpts(state).filter((e) => codes.has(e.codeId) && !e.negativeCase && !moderator.has(segKey(e)));
  const fit = (e: QualExcerpt) => { const L = e.quote.length; return L >= 40 && L <= 300 ? 0 : L < 40 ? 1 : 2; };
  pool.sort((a, b) => (a.status === "human_reviewed" ? 0 : 1) - (b.status === "human_reviewed" ? 0 : 1) || fit(a) - fit(b) || a.sourceId.localeCompare(b.sourceId) || a.segmentId.localeCompare(b.segmentId, undefined, { numeric: true }) || a.charStart - b.charStart);
  const out: QualExcerpt[] = [];
  const sources = new Set<string>(), speakers = new Set<string>();
  for (const pass of [0, 1, 2]) for (const e of pool) {
    if (out.length >= n) break;
    if (out.includes(e) || out.some((o) => segKey(o) === segKey(e))) continue;
    if (pass === 0 && sources.has(e.sourceId)) continue;
    if (pass === 1 && speakers.has(`${e.sourceId}|${e.speaker ?? ""}`)) continue;
    out.push(e); sources.add(e.sourceId); speakers.add(`${e.sourceId}|${e.speaker ?? ""}`);
  }
  return out;
}

export interface QualClaim { text: string; excerptIds: string[] }
export interface ThemeSummary { themeId: string; name: string; claims: QualClaim[]; quotes: QualExcerpt[]; negative: QualExcerpt[]; status: string }

/** a model's (or anyone's) claims kept only when every one cites at least one excerpt that exists and is not rejected */
export function validateClaims(claims: readonly QualClaim[], state: QualState): { kept: QualClaim[]; dropped: { claim: QualClaim; reason: string }[] } {
  const ids = new Set(liveExcerpts(state).map((e) => e.id));
  const kept: QualClaim[] = [], dropped: { claim: QualClaim; reason: string }[] = [];
  for (const c of claims) {
    const cited = (c.excerptIds ?? []).filter((id) => ids.has(id));
    if (!c.text?.trim()) dropped.push({ claim: c, reason: "empty" });
    else if (!c.excerptIds?.length) dropped.push({ claim: c, reason: "cites no excerpt" });
    else if (cited.length !== c.excerptIds.length) dropped.push({ claim: c, reason: `cites excerpts that do not exist or were rejected: ${c.excerptIds.filter((id) => !ids.has(id)).join(", ")}` });
    else kept.push({ text: c.text.trim(), excerptIds: cited });
  }
  return { kept, dropped };
}

/**
 * The engine's own evidence-based summary of each theme: how widely it was coded (sources,
 * participant segments, groups), where it was most present, the counter-evidence — each claim with
 * the excerpt ids it rests on. Descriptive words only; frequency is not importance.
 */
export function themeSummaries(state: QualState, segments: readonly QualSegment[], opts: { groupOf?: (s: QualSegment) => string | undefined } = {}): ThemeSummary[] {
  const table = themeFrequency(state, segments, { groupOf: opts.groupOf, level: "theme" });
  const ex = liveExcerpts(state);
  const participant = new Set(segments.filter((s) => s.role !== "moderator").map(segKey));
  return table.rows.map((r) => {
    const codes = new Set(codesOfTheme(state, r.id).map((c) => c.id));
    const mine = ex.filter((e) => codes.has(e.codeId) && participant.has(segKey(e)));
    const quotes = representativeQuotes(state, segments, { themeId: r.id });
    const negative = negativeCases(state, r.id);
    const claims: QualClaim[] = [];
    if (mine.length) {
      claims.push({ text: `“${r.name}” was coded in ${r.total.sources} of ${table.base.sources} source${table.base.sources === 1 ? "" : "s"} (${r.total.segments} participant segment${r.total.segments === 1 ? "" : "s"}, ${r.total.excerpts} excerpt${r.total.excerpts === 1 ? "" : "s"}).`, excerptIds: mine.slice(0, 12).map((e) => e.id) });
      const present = table.groups.filter((g) => r.byGroup[g].segments > 0);
      if (table.groups.length > 1) {
        const top = [...present].sort((a, b) => r.byGroup[b].share - r.byGroup[a].share)[0];
        if (top) {
          const inTop = mine.filter((e) => { const s = segments.find((x) => segKey(x) === segKey(e)); return s && (opts.groupOf ?? ((y: QualSegment) => y.group))(s) === top; });
          claims.push({ text: `It came up in ${present.length} of ${table.groups.length} groups; most often, relative to how much each group said, in “${top}” (${r.byGroup[top].share}% of its participant segments).`, excerptIds: inTop.slice(0, 8).map((e) => e.id) });
        }
      }
      if (negative.length) claims.push({ text: `${negative.length} excerpt${negative.length === 1 ? " argues" : "s argue"} against it (negative or contradictory cases).`, excerptIds: negative.slice(0, 8).map((e) => e.id) });
    }
    const status = mine.every((e) => e.status === "human_reviewed") && mine.length ? "reviewed" : mine.some((e) => e.status === "ai_suggested") ? "contains AI suggestions not yet reviewed" : "no evidence";
    return { themeId: r.id, name: r.name, claims: validateClaims(claims, state).kept, quotes, negative, status };
  });
}

/** a lexicon reading of a theme's excerpts — indicative, labelled, never a measure of how people feel */
export function themeSentiment(state: QualState, themeId: string): { positive: number; negative: number; neutral: number; n: number; label: string } {
  const codes = new Set(codesOfTheme(state, themeId).map((c) => c.id));
  let positive = 0, negative = 0, neutral = 0;
  for (const e of liveExcerpts(state).filter((x) => codes.has(x.codeId))) { const v = sentimentOf(tokenize(e.quote)); if (v > 0) positive++; else if (v < 0) negative++; else neutral++; }
  return { positive, negative, neutral, n: positive + negative + neutral, label: "Lexicon-based sentiment of the excerpts (word lists, no context): indicative only, and not meaningful for a theme defined by its topic rather than its tone." };
}
