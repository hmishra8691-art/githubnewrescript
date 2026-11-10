import type { QualCode, QualExcerpt, QualSegment, QualState } from "./types.js";

/**
 * CODEBOOK AND CODING VALIDATION (2026-11-10) — the checks a second analyst would run before trusting the themes.
 *
 * Deterministic, read-only, computed from the codebook and the coded excerpts. Nothing is changed and nothing is
 * decided for the researcher: each finding names what was found, where, and the codebook action that would resolve it
 * (merge, split, define, code, review). Rejected codes and excerpts are not part of the analysis and are ignored.
 *
 *   duplicate codes     two codes with the same name once case, punctuation and plural are set aside
 *   overlapping codes   two codes whose excerpts are largely the same passages (they may be one idea)
 *   undefined codes     a code with no definition — two coders cannot apply it the same way
 *   unused codes        a code with no excerpt
 *   unthemed codes      a code in no theme, once themes exist
 *   empty themes        a theme with no code under it
 *   uncoded segments    participant turns with enough words to carry meaning that no code touches
 *   contradictions      one passage coded to two codes the codebook says contradict each other; and a passage coded
 *                       to a theme both as support and as a negative case
 *   inconsistent coding the same sentence, said more than once, coded differently
 *   unreviewed          AI suggestions nobody has accepted or rejected yet
 */
export type QualCheckKind = "duplicate_codes" | "overlapping_codes" | "undefined_code" | "unused_code" | "unthemed_code" | "empty_theme" | "uncoded_segments" | "contradiction" | "inconsistent_coding" | "unreviewed";
export interface QualCheck {
  kind: QualCheckKind;
  severity: "high" | "medium" | "low";
  message: string;
  /** the codebook action that resolves it */
  action: string;
  codeIds?: string[];
  themeIds?: string[];
  /** "<sourceId>#<segmentId>" */
  segmentKeys?: string[];
  excerptIds?: string[];
}
export interface QualValidation {
  checks: QualCheck[];
  coverage: { participantSegments: number; coded: number; uncoded: number; share: number };
  counts: Record<QualCheckKind, number>;
  ok: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(\w{3,})s\b/g, "$1").replace(/\s+/g, " ").trim();
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const key = (sourceId: string, segmentId: string) => `${sourceId}#${segmentId}`;
const overlaps = (a: QualExcerpt, b: QualExcerpt) => a.sourceId === b.sourceId && a.segmentId === b.segmentId && Math.min(a.charEnd, b.charEnd) - Math.max(a.charStart, b.charStart) > 0;
const list = (xs: string[], n = 3) => `${xs.slice(0, n).map((x) => `“${x}”`).join(", ")}${xs.length > n ? ` and ${xs.length - n} more` : ""}`;

export function validateCoding(state: QualState, segments: readonly QualSegment[], opts: { minWords?: number; overlapShare?: number } = {}): QualValidation {
  const minWords = opts.minWords ?? 12, overlapShare = opts.overlapShare ?? 0.6;
  const checks: QualCheck[] = [];
  const codes = state.codebook.codes.filter((c) => c.status !== "rejected");
  const themes = state.codebook.themes.filter((t) => t.status !== "rejected");
  const live = state.excerpts.filter((e) => e.status !== "rejected" && codes.some((c) => c.id === e.codeId));
  const byCode = new Map<string, QualExcerpt[]>();
  for (const e of live) byCode.set(e.codeId, [...(byCode.get(e.codeId) ?? []), e]);
  const name = (id: string) => codes.find((c) => c.id === id)?.name ?? id;

  /* duplicate names */
  const byName = new Map<string, QualCode[]>();
  for (const c of codes) byName.set(norm(c.name), [...(byName.get(norm(c.name)) ?? []), c]);
  const dupPairs = new Set<string>();
  for (const group of byName.values()) if (group.length > 1) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) dupPairs.add([group[i].id, group[j].id].sort().join("|"));
    checks.push({ kind: "duplicate_codes", severity: "high", message: `${group.length} codes have the same name: ${list(group.map((c) => c.name))}.`, action: "Merge them, or rename one so the difference is clear.", codeIds: group.map((c) => c.id) });
  }

  /* overlapping codes: most of the smaller code's excerpts sit on passages the other code also covers */
  for (let i = 0; i < codes.length; i++) for (let j = i + 1; j < codes.length; j++) {
    const a = byCode.get(codes[i].id) ?? [], b = byCode.get(codes[j].id) ?? [];
    if (a.length < 3 || b.length < 3 || dupPairs.has([codes[i].id, codes[j].id].sort().join("|"))) continue;
    const [small, big] = a.length <= b.length ? [a, b] : [b, a];
    const shared = small.filter((x) => big.some((y) => overlaps(x, y)));
    if (shared.length / small.length >= overlapShare) {
      checks.push({ kind: "overlapping_codes", severity: "medium", message: `“${codes[i].name}” and “${codes[j].name}” are applied to the same passages: ${shared.length} of ${small.length} excerpts of the smaller code overlap the other.`, action: "Merge them if they are one idea; otherwise tighten each code's include / exclude rule.", codeIds: [codes[i].id, codes[j].id], excerptIds: shared.map((x) => x.id) });
    }
  }

  for (const c of codes) {
    if (!c.definition?.trim()) checks.push({ kind: "undefined_code", severity: "medium", message: `“${c.name}” has no definition.`, action: "Write what the code means and when it applies, so it is applied the same way every time.", codeIds: [c.id] });
    if (!(byCode.get(c.id) ?? []).length) checks.push({ kind: "unused_code", severity: "low", message: `“${c.name}” is not applied to any passage.`, action: "Apply it, or delete it from the codebook.", codeIds: [c.id] });
    if (themes.length && !c.themeId) checks.push({ kind: "unthemed_code", severity: "low", message: `“${c.name}” is not in a theme.`, action: "Assign it to a theme, or leave it out of the themes deliberately.", codeIds: [c.id] });
  }
  for (const t of themes) {
    const has = codes.some((c) => c.themeId === t.id) || themes.some((s) => s.parentId === t.id && codes.some((c) => c.themeId === s.id));
    if (!has) checks.push({ kind: "empty_theme", severity: "medium", message: `The theme “${t.name}” has no code under it, so nothing in the data supports it.`, action: "Assign codes to it, or delete the theme.", themeIds: [t.id] });
  }

  /* uncoded participant segments */
  const codedKeys = new Set(live.map((e) => key(e.sourceId, e.segmentId)));
  const participant = segments.filter((s) => s.role !== "moderator" && words(s.text) >= minWords);
  const uncoded = participant.filter((s) => !codedKeys.has(key(s.sourceId, s.id)));
  if (uncoded.length) {
    const share = uncoded.length / participant.length;
    checks.push({ kind: "uncoded_segments", severity: share >= 0.4 ? "high" : share >= 0.15 ? "medium" : "low", message: `${uncoded.length} of ${participant.length} participant passages of ${minWords} words or more have no code (${Math.round(share * 100)}%).`, action: "Read them: code what is relevant, and leave the rest uncoded deliberately.", segmentKeys: uncoded.map((s) => key(s.sourceId, s.id)) });
  }

  /* contradictions */
  for (const r of state.codebook.relationships.filter((x) => x.kind === "contradicts")) {
    const a = byCode.get(r.from) ?? [], b = byCode.get(r.to) ?? [];
    const hits = a.filter((x) => b.some((y) => overlaps(x, y)));
    if (hits.length) checks.push({ kind: "contradiction", severity: "high", message: `${hits.length} passage${hits.length === 1 ? " is" : "s are"} coded to both “${name(r.from)}” and “${name(r.to)}”, which the codebook says contradict each other.`, action: "Re-read each passage and keep the code it supports — or, if both hold, change the relationship between the codes.", codeIds: [r.from, r.to], excerptIds: hits.map((x) => x.id) });
  }
  const themeOf = (codeId: string) => codes.find((c) => c.id === codeId)?.themeId ?? null;
  const mixed: QualExcerpt[] = [];
  for (const e of live.filter((x) => x.negativeCase && themeOf(x.codeId))) {
    if (live.some((y) => y.id !== e.id && !y.negativeCase && themeOf(y.codeId) === themeOf(e.codeId) && overlaps(e, y))) mixed.push(e);
  }
  if (mixed.length) checks.push({ kind: "contradiction", severity: "high", message: `${mixed.length} passage${mixed.length === 1 ? " is" : "s are"} coded to the same theme both as support and as a negative case.`, action: "Decide which it is: a passage cannot be evidence for and against the same theme.", excerptIds: mixed.map((x) => x.id) });

  /* the same sentence, coded differently in different places */
  const byQuote = new Map<string, QualExcerpt[]>();
  for (const e of live) { const k = norm(e.quote); if (words(k) >= 5) byQuote.set(k, [...(byQuote.get(k) ?? []), e]); }
  for (const group of byQuote.values()) {
    const places = new Map<string, Set<string>>();
    for (const e of group) { const p = key(e.sourceId, e.segmentId); places.set(p, new Set([...(places.get(p) ?? []), e.codeId])); }
    if (places.size < 2) continue;
    const sets = [...places.values()].map((s) => [...s].sort().join(","));
    if (new Set(sets).size > 1) checks.push({ kind: "inconsistent_coding", severity: "medium", message: `The same words — “${group[0].quote.slice(0, 80)}${group[0].quote.length > 80 ? "…" : ""}” — are coded differently in ${places.size} places (${list([...new Set(group.map((e) => name(e.codeId)))])}).`, action: "Apply the same codes wherever the same thing is said, or note in the definitions why they differ.", excerptIds: group.map((e) => e.id), codeIds: [...new Set(group.map((e) => e.codeId))] });
  }

  const pendingCodes = codes.filter((c) => c.status === "ai_suggested"), pendingExcerpts = live.filter((e) => e.status === "ai_suggested");
  if (pendingCodes.length || pendingExcerpts.length) checks.push({ kind: "unreviewed", severity: "low", message: `${pendingCodes.length} code${pendingCodes.length === 1 ? "" : "s"} and ${pendingExcerpts.length} coded passage${pendingExcerpts.length === 1 ? "" : "s"} are AI suggestions that nobody has reviewed.`, action: "Accept or reject them: unreviewed suggestions are shown as such in every output.", codeIds: pendingCodes.map((c) => c.id), excerptIds: pendingExcerpts.map((e) => e.id) });

  const order = { high: 0, medium: 1, low: 2 } as const;
  checks.sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = Object.fromEntries((["duplicate_codes", "overlapping_codes", "undefined_code", "unused_code", "unthemed_code", "empty_theme", "uncoded_segments", "contradiction", "inconsistent_coding", "unreviewed"] as QualCheckKind[]).map((k) => [k, checks.filter((c) => c.kind === k).length])) as Record<QualCheckKind, number>;
  return { checks, coverage: { participantSegments: participant.length, coded: participant.length - uncoded.length, uncoded: uncoded.length, share: participant.length ? (participant.length - uncoded.length) / participant.length : 0 }, counts, ok: !checks.some((c) => c.severity === "high") };
}
