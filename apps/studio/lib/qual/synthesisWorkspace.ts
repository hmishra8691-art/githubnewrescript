import {
  redactText, themeSynthesisState, insightsState, readAutoCodeSettings, SYNTHESIS_SECTIONS, coerceQualOp,
  type ThemeSynthesis, type StudyInsights, type SynthClaim, type SynthesisEdit, type QualSegment, type QualState, type StudyContext, type AutoCodeSettings, type ReelOp, type ModeratorOp, type QualOp,
} from "@rescript/analytics";
import type { Fields } from "./qualWorkspace";

/**
 * QUALITATIVE SYNTHESIS, SHAPED (2026-10-22) — the pure half of the synthesis,
 * double-coding, highlight, correction, job and group routes: request bodies in,
 * validated values out; stored rows in, the view a member may see out (redacted
 * for a member without contact details). No database, no Next — unit-tested.
 */

export interface SynthesisRow { id?: string; kind: "theme" | "insights"; target: string; version: number; status: "ai" | "edited"; content: unknown; fingerprint: string; provider?: string | null; created_by?: string | null; created_at?: string }
export interface SynthesisView<T> { record: T & { state: "current" | "stale" }; version: number; versions: { version: number; status: string; at?: string }[] }
export interface SynthesisWorkspace { themes: Record<string, SynthesisView<ThemeSynthesis>>; insights: SynthesisView<StudyInsights> | null }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown, max = 2000): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const ids = (v: unknown, max = 200): string[] => arr(v).map((x) => str(x, 120)).filter((x): x is string => !!x).slice(0, max);

/** a claim's words as a member without contact details reads them */
const redClaim = (c: SynthClaim, names: string[]): SynthClaim => ({ ...c, text: redactText(c.text, { names }).text, ...(c.aiText ? { aiText: redactText(c.aiText, { names }).text } : {}) });

export function redactTheme(t: ThemeSynthesis, names: string[]): ThemeSynthesis {
  const out = { ...t, dropped: t.dropped.map((d) => ({ ...d, text: redactText(d.text, { names }).text })) };
  for (const s of SYNTHESIS_SECTIONS) out[s] = t[s].map((c) => redClaim(c, names));
  return out;
}
export function redactInsights(r: StudyInsights, names: string[]): StudyInsights {
  const rc = (cs: SynthClaim[]) => cs.map((c) => redClaim(c, names));
  return {
    ...r, executiveSummary: rc(r.executiveSummary), surprises: rc(r.surprises), recommendations: rc(r.recommendations),
    segments: r.segments.map((c) => ({ ...redClaim(c, names), groups: c.groups })),
    objectives: r.objectives.map((o) => ({ ...o, findings: rc(o.findings) })), hypotheses: r.hypotheses.map((h) => ({ ...h, claims: rc(h.claims) })),
    framing: { ...r.framing, stages: r.framing.stages.map((s) => ({ ...s, claims: rc(s.claims) })) },
    dropped: r.dropped.map((d) => ({ ...d, text: redactText(d.text, { names }).text })),
  };
}

/** the latest version of every synthesis, with its history and whether it is still about the coding as it is */
export function synthesisWorkspace(rows: readonly SynthesisRow[], state: QualState, segments: readonly QualSegment[], study: StudyContext, opts: { pii: boolean; names: string[] }): SynthesisWorkspace {
  const groups = new Map<string, SynthesisRow[]>();
  for (const r of rows) { const k = `${r.kind}|${r.target}`; const l = groups.get(k) ?? []; l.push(r); groups.set(k, l); }
  const out: SynthesisWorkspace = { themes: {}, insights: null };
  for (const [k, list] of groups) {
    list.sort((a, b) => b.version - a.version);
    const top = list[0];
    const versions = list.map((r) => ({ version: r.version, status: r.status, ...(r.created_at ? { at: r.created_at } : {}) }));
    if (k.startsWith("theme|")) {
      let rec = obj(top.content) as unknown as ThemeSynthesis;
      if (!rec.summary) continue;
      if (!opts.pii) rec = redactTheme(rec, opts.names);
      out.themes[top.target] = { record: { ...rec, status: top.status, state: themeSynthesisState(rec, state, segments) === "current" ? "current" : "stale" }, version: top.version, versions };
    } else if (k === "insights|study") {
      let rec = obj(top.content) as unknown as StudyInsights;
      if (!rec.objectives) continue;
      if (!opts.pii) rec = redactInsights(rec, opts.names);
      out.insights = { record: { ...rec, status: top.status, state: insightsState(rec, state, segments, study) === "current" ? "current" : "stale" }, version: top.version, versions };
    }
  }
  return out;
}

/* ------------------------------------------------------------ request bodies */

export function parseSynthesisRequest(body: unknown): Fields<
  | { action: "themes"; themeIds: string[] | null; estimateOnly: boolean }
  | { action: "insights"; compare: [string, string] | null; estimateOnly: boolean }
  | { action: "edit_theme"; themeId: string; version: number; edit: SynthesisEdit }
  | { action: "edit_insights"; version: number; edit: { section: "executiveSummary" | "surprises" | "recommendations" | "objective"; objective?: string; index?: number; text?: string; excerptIds?: string[]; remove?: boolean; add?: { text: string; excerptIds: string[] } } }
> {
  const o = obj(body);
  const action = String(o.action ?? "");
  const estimateOnly = o.estimate === true;
  if (action === "themes") return { ok: true, value: { action, themeIds: Array.isArray(o.themeIds) ? ids(o.themeIds, 40) : null, estimateOnly } };
  if (action === "insights") {
    const c = ids(o.compare, 2);
    return { ok: true, value: { action, compare: c.length === 2 ? [c[0], c[1]] : null, estimateOnly } };
  }
  const version = Number(o.version);
  if (action === "edit_theme" || action === "edit_insights") {
    if (!Number.isInteger(version) || version < 1) return { ok: false, error: "send the version you are editing (version)" };
    const e = obj(o.edit);
    const section = String(e.section ?? "");
    const index = e.index === undefined ? undefined : Number(e.index);
    if (index !== undefined && (!Number.isInteger(index) || index < 0)) return { ok: false, error: "index is a claim's position" };
    const add = e.add ? { text: str(obj(e.add).text, 1200) ?? "", excerptIds: ids(obj(e.add).excerptIds, 40), ...(str(obj(e.add).group, 120) ? { group: str(obj(e.add).group, 120) } : {}) } : undefined;
    const common = { ...(index !== undefined ? { index } : {}), ...(typeof e.text === "string" ? { text: e.text.slice(0, 1200) } : {}), ...(Array.isArray(e.excerptIds) ? { excerptIds: ids(e.excerptIds, 40) } : {}), ...(e.remove === true ? { remove: true as const } : {}), ...(add ? { add } : {}) };
    if (!add && index === undefined) return { ok: false, error: "say which claim (index) or add one (add)" };
    if (action === "edit_theme") {
      const themeId = str(o.themeId, 80);
      if (!themeId) return { ok: false, error: "which theme (themeId)" };
      if (!(SYNTHESIS_SECTIONS as readonly string[]).includes(section)) return { ok: false, error: `section is one of ${SYNTHESIS_SECTIONS.join(", ")}` };
      const edit = (add ? { section, add } : common.remove ? { section, index: index!, remove: true } : { section, index: index!, ...(common.text !== undefined ? { text: common.text } : {}), ...(common.excerptIds ? { excerptIds: common.excerptIds } : {}) }) as SynthesisEdit;
      return { ok: true, value: { action, themeId, version, edit } };
    }
    if (!["executiveSummary", "surprises", "recommendations", "objective"].includes(section)) return { ok: false, error: "section is executiveSummary, surprises, recommendations or objective" };
    return { ok: true, value: { action, version, edit: { section: section as "objective", ...(str(e.objective, 8) ? { objective: str(e.objective, 8) } : {}), ...common } } };
  }
  return { ok: false, error: "action is themes, insights, edit_theme or edit_insights" };
}

export function parseAutoCodeSettings(body: unknown): AutoCodeSettings { return readAutoCodeSettings(obj(body).autoCode ?? body); }

export function parseAskRequest(body: unknown): Fields<{ question: string }> {
  const q = str(obj(body).question, 500);
  return q && q.length >= 3 ? { ok: true, value: { question: q } } : { ok: false, error: "ask a question about the qualitative data" };
}

export function parseCorrection(body: unknown): Fields<{ transcriptId: string; segmentId: string; text: string; revision: number }> {
  const o = obj(body);
  const transcriptId = str(o.transcriptId, 40), segmentId = str(o.segmentId, 120), revision = Number(o.revision);
  if (!transcriptId || !segmentId) return { ok: false, error: "which segment (transcriptId, segmentId)" };
  if (typeof o.text !== "string") return { ok: false, error: "send the corrected text" };
  if (!Number.isInteger(revision) || revision < 0) return { ok: false, error: "send the transcript's revision you corrected (revision)" };
  return { ok: true, value: { transcriptId, segmentId, text: o.text.replace(/\r\n?/g, "\n"), revision } };
}

export function parseReelOp(v: unknown): ReelOp | string {
  const o = obj(v);
  switch (o.op) {
    case "add": { const x = ids(o.excerptIds, 100); return x.length ? { op: "add", excerptIds: x, ...(str(o.note, 500) ? { note: str(o.note, 500) } : {}) } : "choose excerpts to add"; }
    case "remove": return str(o.excerptId, 40) ? { op: "remove", excerptId: str(o.excerptId, 40)! } : "which excerpt";
    case "move": return str(o.excerptId, 40) && Number.isInteger(Number(o.to)) ? { op: "move", excerptId: str(o.excerptId, 40)!, to: Number(o.to) } : "which excerpt, and where to";
    case "note": return str(o.excerptId, 40) ? { op: "note", excerptId: str(o.excerptId, 40)!, note: typeof o.note === "string" ? o.note : "" } : "which excerpt";
    case "rename": return str(o.name, 120) ? { op: "rename", name: str(o.name, 120)!, ...(typeof o.description === "string" ? { description: o.description } : {}) } : "a reel needs a name";
    default: return "op is add, remove, move, note or rename";
  }
}

export function parseModeratorOp(v: unknown): ModeratorOp | string {
  const o = obj(v);
  switch (o.op) {
    case "start": case "voting": case "next": case "end": return { op: o.op };
    case "ask": return str(o.text, 600) ? { op: "ask", text: str(o.text, 600)! } : "type the question to ask";
    case "approve_followup": return str(o.id, 40) ? { op: "approve_followup", id: str(o.id, 40)!, ...(typeof o.text === "string" ? { text: o.text } : {}), ...(o.askNow === true ? { askNow: true } : {}) } : "which follow-up";
    case "reject_followup": return str(o.id, 40) ? { op: "reject_followup", id: str(o.id, 40)! } : "which follow-up";
    case "set_mode": return o.mode === "autonomous" || o.mode === "moderated" ? { op: "set_mode", mode: o.mode } : "mode is moderated or autonomous";
    case "settings": return { op: "settings", settings: obj(o.settings) };
    default: return "op is start, voting, next, ask, approve_followup, reject_followup, set_mode, settings or end";
  }
}

export function parseAssignmentCreate(body: unknown, me: string): Fields<{ name?: string; coderA: string; coderB: string; overlapPct: number; sourceIds?: string[] }> {
  const o = obj(body);
  const coderA = str(o.coderA, 80) ?? me, coderB = str(o.coderB, 80);
  const pct = Number(o.overlapPct ?? 20);
  if (!coderB) return { ok: false, error: "choose the second coder (coderB: a colleague's id, or \"ai\")" };
  if (coderA === coderB) return { ok: false, error: "the two coders must be different" };
  if (!Number.isFinite(pct) || pct < 1 || pct > 100) return { ok: false, error: "overlap is a percentage between 1 and 100" };
  return { ok: true, value: { ...(str(o.name, 200) ? { name: str(o.name, 200) } : {}), coderA, coderB, overlapPct: Math.round(pct), ...(ids(o.sourceIds).length ? { sourceIds: ids(o.sourceIds) } : {}) } };
}

/** a coder's op on their blind set: only add / remove an excerpt */
export function parseCoderOp(v: unknown): QualOp | string {
  const op = coerceQualOp(v);
  if (typeof op === "string") return op;
  return op.op === "add_excerpt" || op.op === "remove_excerpt" ? op : "in a blind assignment a coder only applies or removes codes";
}

/** a random join code for a group session's link: 24 URL-safe characters */
export function joinCode(bytes: Uint8Array): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return [...bytes].slice(0, 24).map((b) => abc[b % abc.length]).join("");
}
