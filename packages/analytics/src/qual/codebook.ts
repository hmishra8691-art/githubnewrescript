import type { QualCode, QualCodebook, QualExcerpt, QualHistoryEntry, QualRelationKind, QualSegment, QualState, QualTheme, ReviewStatus } from "./types.js";
import { locateQuote, quoteMatchesSegment } from "./quotes.js";

/**
 * HUMAN REVIEW OF A CODEBOOK (2026-10-18) — every change a researcher makes to
 * codes, themes and excerpts, as one operation applied to the state and one
 * history entry (who, when, what). The AI proposes (`ai_suggested`); a person
 * accepts, rejects, edits, merges, splits, renames, reassigns and adds
 * (`human_reviewed`). Nothing is silently dropped: a merge moves the excerpts,
 * a split says which excerpts go where, a deleted code says how many excerpts
 * went with it. An excerpt added by hand is checked like a model's: its quote
 * must be the exact span of its segment.
 *
 * Pure: the state in, a new state and the entry out; the caller persists both.
 */

export type QualOp =
  | { op: "add_code"; name: string; definition?: string; include?: string; exclude?: string; parentId?: string | null; themeId?: string | null }
  | { op: "update_code"; codeId: string; name?: string; definition?: string; include?: string | null; exclude?: string | null; parentId?: string | null; themeId?: string | null }
  | { op: "review_code"; codeId: string; decision: "accept" | "reject" }
  | { op: "merge_codes"; intoId: string; fromIds: string[] }
  | { op: "split_code"; codeId: string; into: { name: string; definition?: string; excerptIds: string[] }[]; removeOriginal?: boolean }
  | { op: "delete_code"; codeId: string }
  | { op: "add_theme"; name: string; description?: string; parentId?: string | null }
  | { op: "update_theme"; themeId: string; name?: string; description?: string | null; parentId?: string | null }
  | { op: "review_theme"; themeId: string; decision: "accept" | "reject" }
  | { op: "delete_theme"; themeId: string }
  | { op: "assign_code"; codeId: string; themeId: string | null }
  | { op: "add_relationship"; from: string; to: string; kind: QualRelationKind; note?: string }
  | { op: "remove_relationship"; relationshipId: string }
  | { op: "review_excerpt"; excerptId: string; decision: "accept" | "reject"; negativeCase?: boolean }
  | { op: "reassign_excerpt"; excerptId: string; codeId: string }
  | { op: "add_excerpt"; codeId: string; sourceId: string; segmentId: string; quote?: string; charStart?: number; charEnd?: number; negativeCase?: boolean }
  | { op: "remove_excerpt"; excerptId: string };

export const QUAL_OPS = ["add_code", "update_code", "review_code", "merge_codes", "split_code", "delete_code", "add_theme", "update_theme", "review_theme", "delete_theme", "assign_code", "add_relationship", "remove_relationship", "review_excerpt", "reassign_excerpt", "add_excerpt", "remove_excerpt"] as const;
const RELATIONS: readonly QualRelationKind[] = ["causes", "co_occurs", "contradicts", "part_of", "associated"];

export interface QualOpEnv {
  /** "ai" or the reviewer's user id */
  actor: string;
  now: string;
  /** a segment by source and id — for a hand-made excerpt */
  segment?: (sourceId: string, segmentId: string) => QualSegment | undefined;
}

export class QualOpError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const fail = (m: string, status = 400): never => { throw new QualOpError(m, status); };
const nextId = (taken: Iterable<string>, prefix: string): string => { const used = new Set(taken); let i = 1; while (used.has(`${prefix}${i}`)) i++; return `${prefix}${i}`; };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const s = (v: unknown, max = 2000): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

export const codeById = (cb: QualCodebook, id: string): QualCode | undefined => cb.codes.find((c) => c.id === id);
export const themeById = (cb: QualCodebook, id: string): QualTheme | undefined => cb.themes.find((t) => t.id === id);

/** the next free excerpt id for a state */
export const nextExcerptId = (excerpts: readonly QualExcerpt[]): string => nextId(excerpts.map((e) => e.id), "x");
export const nextCodeId = (cb: QualCodebook): string => nextId(cb.codes.map((c) => c.id), "c");
export const nextThemeId = (cb: QualCodebook): string => nextId(cb.themes.map((t) => t.id), "th");

/** a parent chain that loops back is refused (a code cannot be its own ancestor) */
function cyclic<T extends { id: string; parentId?: string | null }>(items: T[], id: string, parentId: string | null | undefined): boolean {
  let p = parentId;
  const seen = new Set<string>();
  while (p) { if (p === id || seen.has(p)) return true; seen.add(p); p = items.find((x) => x.id === p)?.parentId ?? null; }
  return false;
}

/** Apply one review operation. Throws `QualOpError` with the reason when it cannot be applied. */
export function applyQualOp(state: QualState, op: QualOp, env: QualOpEnv): { state: QualState; entry: QualHistoryEntry } {
  const next = clone(state);
  const cb = next.codebook;
  const code = (id: string) => codeById(cb, id) ?? fail(`there is no code ${id}`, 404);
  const theme = (id: string) => themeById(cb, id) ?? fail(`there is no theme ${id}`, 404);
  const excerpt = (id: string) => next.excerpts.find((e) => e.id === id) ?? fail(`there is no excerpt ${id}`, 404);
  const uniqueName = (name: string, except?: string) => { if (cb.codes.some((c) => c.id !== except && c.name.toLowerCase() === name.toLowerCase())) fail(`a code called “${name}” already exists — merge into it instead`, 409); };
  let detail = "";
  let ids: string[] = [];

  switch (op.op) {
    case "add_code": {
      const name = s(op.name, 120) || fail("a code needs a name");
      uniqueName(name);
      if (op.themeId) theme(op.themeId);
      if (op.parentId) code(op.parentId);
      const c: QualCode = { id: nextCodeId(cb), name, definition: s(op.definition), status: "human_reviewed", origin: "manual", ...(s(op.include) ? { include: s(op.include) } : {}), ...(s(op.exclude) ? { exclude: s(op.exclude) } : {}), ...(op.parentId ? { parentId: op.parentId } : {}), ...(op.themeId ? { themeId: op.themeId } : {}) };
      cb.codes.push(c);
      detail = `Added code “${name}”`; ids = [c.id];
      break;
    }
    case "update_code": {
      const c = code(op.codeId);
      const what: string[] = [];
      if (op.name !== undefined) { const name = s(op.name, 120) || fail("a code needs a name"); uniqueName(name, c.id); if (name !== c.name) what.push(`renamed “${c.name}” → “${name}”`); c.name = name; }
      if (op.definition !== undefined) { c.definition = s(op.definition); what.push("definition"); }
      for (const k of ["include", "exclude"] as const) { const v = op[k]; if (v === null) { delete c[k]; what.push(`${k} cleared`); } else if (v !== undefined) { c[k] = s(v); what.push(`${k === "include" ? "inclusion" : "exclusion"} criteria`); } }
      if (op.parentId !== undefined) { if (op.parentId) { code(op.parentId); if (cyclic(cb.codes, c.id, op.parentId)) fail("a code cannot sit under its own child"); c.parentId = op.parentId; } else delete c.parentId; what.push("parent"); }
      if (op.themeId !== undefined) { if (op.themeId) { theme(op.themeId); c.themeId = op.themeId; } else delete c.themeId; what.push("theme"); }
      c.status = "human_reviewed";
      detail = `Edited code “${c.name}”: ${what.join(", ") || "reviewed"}`; ids = [c.id];
      break;
    }
    case "review_code": {
      const c = code(op.codeId);
      c.status = op.decision === "accept" ? "human_reviewed" : "rejected";
      let n = 0;
      if (op.decision === "reject") for (const e of next.excerpts) if (e.codeId === c.id && e.status === "ai_suggested") { e.status = "rejected"; n++; }
      detail = `${op.decision === "accept" ? "Accepted" : "Rejected"} code “${c.name}”${n ? ` and its ${n} suggested excerpt${n === 1 ? "" : "s"}` : ""}`; ids = [c.id];
      break;
    }
    case "merge_codes": {
      const into = code(op.intoId);
      const from = [...new Set(op.fromIds)].filter((id) => id !== into.id).map(code);
      if (!from.length) fail("name at least one other code to merge");
      const gone = new Set(from.map((c) => c.id));
      let moved = 0, dupes = 0;
      const seen = new Set(next.excerpts.filter((e) => e.codeId === into.id).map((e) => `${e.sourceId}|${e.segmentId}|${e.charStart}|${e.charEnd}|${e.coder}`));
      next.excerpts = next.excerpts.filter((e) => {
        if (!gone.has(e.codeId)) return true;
        const k = `${e.sourceId}|${e.segmentId}|${e.charStart}|${e.charEnd}|${e.coder}`;
        if (seen.has(k)) { dupes++; return false; }
        seen.add(k); e.codeId = into.id; moved++; return true;
      });
      for (const c of cb.codes) if (c.parentId && gone.has(c.parentId)) c.parentId = into.id;
      for (const r of cb.relationships) { if (gone.has(r.from)) r.from = into.id; if (gone.has(r.to)) r.to = into.id; }
      cb.relationships = cb.relationships.filter((r) => r.from !== r.to);
      cb.codes = cb.codes.filter((c) => !gone.has(c.id));
      into.status = "human_reviewed";
      detail = `Merged ${from.map((c) => `“${c.name}”`).join(", ")} into “${into.name}” (${moved} excerpt${moved === 1 ? "" : "s"} moved${dupes ? `, ${dupes} duplicate${dupes === 1 ? "" : "s"} dropped` : ""})`;
      ids = [into.id, ...gone];
      break;
    }
    case "split_code": {
      const c = code(op.codeId);
      if (!op.into?.length) fail("a split names the new codes and the excerpts each takes");
      const mine = new Set(next.excerpts.filter((e) => e.codeId === c.id).map((e) => e.id));
      const claimed = new Set<string>();
      const made: QualCode[] = [];
      for (const part of op.into) {
        const name = s(part.name, 120) || fail("each new code needs a name");
        uniqueName(name);
        if (made.some((m) => m.name.toLowerCase() === name.toLowerCase())) fail(`“${name}” is named twice`);
        for (const id of part.excerptIds ?? []) { if (!mine.has(id)) fail(`excerpt ${id} is not coded to “${c.name}”`); if (claimed.has(id)) fail(`excerpt ${id} is given to two codes`); claimed.add(id); }
        const nc: QualCode = { id: nextId([...cb.codes, ...made].map((x) => x.id), "c"), name, definition: s(part.definition) || c.definition, status: "human_reviewed", origin: c.origin, ...(c.themeId ? { themeId: c.themeId } : {}), ...(c.parentId ? { parentId: c.parentId } : {}) };
        made.push(nc);
        for (const e of next.excerpts) if ((part.excerptIds ?? []).includes(e.id)) e.codeId = nc.id;
      }
      cb.codes.push(...made);
      const left = [...mine].filter((id) => !claimed.has(id)).length;
      if (op.removeOriginal) { if (left) fail(`“${c.name}” still has ${left} excerpt${left === 1 ? "" : "s"} — give every excerpt a new code to remove it`); cb.codes = cb.codes.filter((x) => x.id !== c.id); }
      detail = `Split “${c.name}” into ${made.map((m) => `“${m.name}”`).join(", ")} (${claimed.size} excerpt${claimed.size === 1 ? "" : "s"} moved${op.removeOriginal ? "; original removed" : left ? `; ${left} left on “${c.name}”` : ""})`;
      ids = [c.id, ...made.map((m) => m.id)];
      break;
    }
    case "delete_code": {
      const c = code(op.codeId);
      const n = next.excerpts.filter((e) => e.codeId === c.id).length;
      next.excerpts = next.excerpts.filter((e) => e.codeId !== c.id);
      for (const x of cb.codes) if (x.parentId === c.id) { if (c.parentId) x.parentId = c.parentId; else delete x.parentId; }
      cb.relationships = cb.relationships.filter((r) => r.from !== c.id && r.to !== c.id);
      cb.codes = cb.codes.filter((x) => x.id !== c.id);
      detail = `Deleted code “${c.name}” and its ${n} excerpt${n === 1 ? "" : "s"}`; ids = [c.id];
      break;
    }
    case "add_theme": {
      const name = s(op.name, 120) || fail("a theme needs a name");
      if (cb.themes.some((t) => t.name.toLowerCase() === name.toLowerCase())) fail(`a theme called “${name}” already exists`, 409);
      if (op.parentId) theme(op.parentId);
      const t: QualTheme = { id: nextThemeId(cb), name, status: "human_reviewed", ...(s(op.description) ? { description: s(op.description) } : {}), ...(op.parentId ? { parentId: op.parentId } : {}) };
      cb.themes.push(t);
      detail = `Added ${op.parentId ? "subtheme" : "theme"} “${name}”`; ids = [t.id];
      break;
    }
    case "update_theme": {
      const t = theme(op.themeId);
      const what: string[] = [];
      if (op.name !== undefined) { const name = s(op.name, 120) || fail("a theme needs a name"); if (cb.themes.some((x) => x.id !== t.id && x.name.toLowerCase() === name.toLowerCase())) fail(`a theme called “${name}” already exists`, 409); if (name !== t.name) what.push(`renamed “${t.name}” → “${name}”`); t.name = name; }
      if (op.description === null) { delete t.description; what.push("description cleared"); } else if (op.description !== undefined) { t.description = s(op.description); what.push("description"); }
      if (op.parentId !== undefined) { if (op.parentId) { theme(op.parentId); if (cyclic(cb.themes, t.id, op.parentId)) fail("a theme cannot sit under its own subtheme"); t.parentId = op.parentId; } else delete t.parentId; what.push("parent"); }
      t.status = "human_reviewed";
      detail = `Edited theme “${t.name}”: ${what.join(", ") || "reviewed"}`; ids = [t.id];
      break;
    }
    case "review_theme": {
      const t = theme(op.themeId);
      t.status = op.decision === "accept" ? "human_reviewed" : "rejected";
      detail = `${op.decision === "accept" ? "Accepted" : "Rejected"} theme “${t.name}”`; ids = [t.id];
      break;
    }
    case "delete_theme": {
      const t = theme(op.themeId);
      let n = 0;
      for (const c of cb.codes) if (c.themeId === t.id) { delete c.themeId; n++; }
      for (const x of cb.themes) if (x.parentId === t.id) delete x.parentId;
      cb.themes = cb.themes.filter((x) => x.id !== t.id);
      detail = `Deleted theme “${t.name}” (${n} code${n === 1 ? "" : "s"} now unthemed)`; ids = [t.id];
      break;
    }
    case "assign_code": {
      const c = code(op.codeId);
      if (op.themeId) { const t = theme(op.themeId); c.themeId = t.id; detail = `Put “${c.name}” under theme “${t.name}”`; }
      else { delete c.themeId; detail = `Took “${c.name}” out of its theme`; }
      ids = [c.id, ...(op.themeId ? [op.themeId] : [])];
      break;
    }
    case "add_relationship": {
      const a = code(op.from), b = code(op.to);
      if (a.id === b.id) fail("a relationship joins two different codes");
      if (!RELATIONS.includes(op.kind)) fail(`a relationship is one of ${RELATIONS.join(", ")}`);
      const r = { id: nextId(cb.relationships.map((x) => x.id), "r"), from: a.id, to: b.id, kind: op.kind, ...(s(op.note) ? { note: s(op.note) } : {}) };
      cb.relationships.push(r);
      detail = `Linked “${a.name}” ${op.kind.replace("_", " ")} “${b.name}”`; ids = [r.id, a.id, b.id];
      break;
    }
    case "remove_relationship": {
      const r = cb.relationships.find((x) => x.id === op.relationshipId) ?? fail(`there is no relationship ${op.relationshipId}`, 404);
      cb.relationships = cb.relationships.filter((x) => x !== r);
      detail = `Removed a ${r.kind.replace("_", " ")} link`; ids = [r.id];
      break;
    }
    case "review_excerpt": {
      const e = excerpt(op.excerptId);
      e.status = op.decision === "accept" ? "human_reviewed" : "rejected";
      if (op.negativeCase !== undefined) { if (op.negativeCase) e.negativeCase = true; else delete e.negativeCase; }
      detail = `${op.decision === "accept" ? "Accepted" : "Rejected"} excerpt ${e.id} (“${e.quote.slice(0, 50)}${e.quote.length > 50 ? "…" : ""}”) for “${codeById(cb, e.codeId)?.name ?? e.codeId}”${e.negativeCase ? " as a negative case" : ""}`; ids = [e.id];
      break;
    }
    case "reassign_excerpt": {
      const e = excerpt(op.excerptId);
      const to = code(op.codeId);
      const was = codeById(cb, e.codeId)?.name ?? e.codeId;
      e.codeId = to.id; e.status = "human_reviewed";
      detail = `Moved excerpt ${e.id} from “${was}” to “${to.name}”`; ids = [e.id, to.id];
      break;
    }
    case "add_excerpt": {
      const c = code(op.codeId);
      const seg = env.segment?.(op.sourceId, op.segmentId) ?? fail(`there is no segment ${op.segmentId} in that source`, 404);
      let start = op.charStart, end = op.charEnd;
      if (typeof start !== "number" || typeof end !== "number") {
        const at = locateQuote(seg.text, op.quote ?? "") ?? fail("that text is not in the segment — select the words exactly as they appear");
        start = at.start; end = at.end;
      }
      const quote = seg.text.slice(start, end);
      if (!quoteMatchesSegment({ charStart: start, charEnd: end, quote }, seg.text) || (op.quote !== undefined && typeof op.charStart === "number" && op.quote !== quote)) fail("the span does not match the segment's text");
      const e: QualExcerpt = { id: nextExcerptId(next.excerpts), codeId: c.id, sourceKind: seg.sourceKind, sourceId: seg.sourceId, segmentId: seg.id, charStart: start, charEnd: end, quote, coder: env.actor, status: "human_reviewed", createdAt: env.now, ...(seg.speaker ? { speaker: seg.speaker } : {}), ...(seg.start !== undefined ? { start: seg.start } : {}), ...(seg.responseId ? { responseId: seg.responseId } : {}), ...(op.negativeCase ? { negativeCase: true } : {}) };
      next.excerpts.push(e);
      detail = `Coded “${quote.slice(0, 50)}${quote.length > 50 ? "…" : ""}” as “${c.name}”`; ids = [e.id, c.id];
      break;
    }
    case "remove_excerpt": {
      const e = excerpt(op.excerptId);
      next.excerpts = next.excerpts.filter((x) => x !== e);
      detail = `Removed excerpt ${e.id} from “${codeById(cb, e.codeId)?.name ?? e.codeId}”`; ids = [e.id];
      break;
    }
    default: fail(`unknown operation ${(op as { op?: string }).op}`);
  }
  cb.version = (cb.version ?? 0) + 1;
  return { state: next, entry: { at: env.now, actor: env.actor, action: op.op, detail, ids } };
}

/** the model's or the browser's JSON as a typed op, or the reason it is not one */
export function coerceQualOp(x: unknown): QualOp | string {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const op = typeof o.op === "string" ? o.op : "";
  if (!(QUAL_OPS as readonly string[]).includes(op)) return `unknown operation “${op}”`;
  const id = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim().slice(0, 80) : undefined);
  const need = (k: string) => id(k) ?? null;
  for (const k of ({ update_code: ["codeId"], review_code: ["codeId"], delete_code: ["codeId"], split_code: ["codeId"], merge_codes: ["intoId"], update_theme: ["themeId"], review_theme: ["themeId"], delete_theme: ["themeId"], assign_code: ["codeId"], add_relationship: ["from", "to"], remove_relationship: ["relationshipId"], review_excerpt: ["excerptId"], reassign_excerpt: ["excerptId", "codeId"], add_excerpt: ["codeId", "sourceId", "segmentId"], remove_excerpt: ["excerptId"] } as Record<string, string[]>)[op] ?? []) if (!need(k)) return `${op} needs ${k}`;
  if ((op === "review_code" || op === "review_theme" || op === "review_excerpt") && o.decision !== "accept" && o.decision !== "reject") return `${op} needs a decision: accept or reject`;
  if (op === "merge_codes" && !(Array.isArray(o.fromIds) && o.fromIds.length)) return "merge_codes needs fromIds";
  if (op === "split_code" && !(Array.isArray(o.into) && o.into.length)) return "split_code needs into: [{name, excerptIds}]";
  return JSON.parse(JSON.stringify(o)) as QualOp;
}

/** how much is still the model's and how much a person has reviewed */
export function reviewStatus(state: QualState): { codes: Record<ReviewStatus, number>; themes: Record<ReviewStatus, number>; excerpts: Record<ReviewStatus, number> } {
  const count = <T extends { status: ReviewStatus }>(xs: T[]) => xs.reduce((acc, x) => { acc[x.status]++; return acc; }, { ai_suggested: 0, human_reviewed: 0, rejected: 0 } as Record<ReviewStatus, number>);
  return { codes: count(state.codebook.codes), themes: count(state.codebook.themes), excerpts: count(state.excerpts) };
}
