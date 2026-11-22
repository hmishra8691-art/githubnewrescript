import { SurveyDefinition as SurveyDefinitionSchema, type FlowNode, type LibraryLink, type Question, type SurveyDefinition } from "@rescript/schema";
import { remapConditionReferences } from "./conditionCopy.js";
import { conditionRefs } from "./dependencies.js";

/**
 * REUSABLE LIBRARIES (Level 5 roadmap P5 — 2026-11-28).
 *
 * A library is an ordinary survey of the workspace kept for reuse: its blocks, its questions and its option lists
 * are the items. Using one inserts a copy and records a LINK (schema `libraryLinks`): the library, the item, the
 * version, and a fingerprint of the content. Later the link tells three things apart:
 *
 *   up to date        the library's item and the local copy both still match the fingerprint
 *   update available  the library's item changed since it was inserted — with what would change here, and which
 *                     logic elsewhere in this survey would lose a question or an option it reads
 *   changed here      someone edited the local copy; an update would overwrite those edits, and says so
 *
 * The fingerprint ignores identity (ids, codes, variable names are renumbered when they collide on insert) and reads
 * references through the link's key map, so a copy nobody touched always matches. Nothing here stores a library or
 * reads a database; the caller passes the library survey in.
 */
type O = Record<string, unknown>;
export type LibraryItemKind = "block" | "question" | "list";
export interface LibraryItem { id: string; kind: LibraryItemKind; name: string; questionIds: string[]; summary: string }

type K = { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] };
const kids = (n: FlowNode): FlowNode[][] => { const k = n as K; return [k.children ?? [], ...(k.branches ?? []).map((b) => b.children), k.otherwise ?? []]; };
const pagesQuestions = (n: FlowNode): string[] => { const out: string[] = []; const walk = (x: FlowNode) => { if (x.type === "page") out.push(...x.questionIds); for (const c of kids(x)) c.forEach(walk); }; walk(n); return out; };
function findNode(nodes: FlowNode[], id: string): FlowNode | null { for (const n of nodes) { if (n.id === id) return n; for (const c of kids(n)) { const f = findNode(c, id); if (f) return f; } } return null; }

/** what a library survey offers */
export function libraryItems(lib: SurveyDefinition): LibraryItem[] {
  const out: LibraryItem[] = [];
  const byId = new Map(lib.questions.map((q) => [q.id, q]));
  const walk = (nodes: FlowNode[]) => { for (const n of nodes) { if (n.type === "block" || n.type === "section") { const qs = pagesQuestions(n); out.push({ id: n.id, kind: "block", name: (n as { title?: string }).title ?? n.id, questionIds: qs, summary: `${qs.length} question${qs.length === 1 ? "" : "s"}: ${qs.slice(0, 4).map((q) => byId.get(q)?.code ?? q).join(", ")}${qs.length > 4 ? " …" : ""}` }); } for (const c of kids(n)) walk(c); } };
  walk(lib.flow);
  for (const q of lib.questions) {
    if (q.type === "html") continue;
    out.push({ id: `q:${q.id}`, kind: "question", name: `${q.code} ${q.text.replace(/<[^>]+>/g, "").slice(0, 60)}`, questionIds: [q.id], summary: q.type });
    if ((q.options ?? []).length >= 2) out.push({ id: `list:${q.id}`, kind: "list", name: `${q.code} options`, questionIds: [q.id], summary: `${q.options.length} options: ${q.options.slice(0, 4).map((o) => o.label).join(", ")}${q.options.length > 4 ? " …" : ""}` });
  }
  return out;
}

interface Content { node?: FlowNode; questions: Question[]; options?: Question["options"] }
function contentOf(lib: SurveyDefinition, itemId: string): Content | null {
  if (itemId.startsWith("list:")) { const q = lib.questions.find((x) => x.id === itemId.slice(5)); return q ? { questions: [], options: q.options } : null; }
  if (itemId.startsWith("q:")) { const q = lib.questions.find((x) => x.id === itemId.slice(2)); return q ? { questions: [q] } : null; }
  const node = findNode(lib.flow, itemId);
  if (!node) return null;
  const ids = pagesQuestions(node);
  return { node, questions: ids.map((id) => lib.questions.find((q) => q.id === id)).filter((q): q is Question => !!q) };
}

/* ------------------------------------------------------------------ the fingerprint */

const canon = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v as O).filter((k) => (v as O)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon((v as O)[k])}`).join(",")}}` : JSON.stringify(v));
function fnv(s: string): string { let h1 = 0x811c9dc5, h2 = 0x1000193; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193); h2 = Math.imul(h2 + c, 0x5bd1e995) ^ (h2 >>> 13); } return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`; }
/** a question as compared: identity removed, references written as LIBRARY ids (`toLib` maps local → library) */
function comparable(q: Question, key: string, toLib: Record<string, string>): O {
  const { id: _i, code: _c, variableName: _v, ...rest } = q as unknown as O;
  return { key, ...JSON.parse(JSON.stringify(rest, (_k, val) => (val && typeof val === "object" && !Array.isArray(val) && (val as O).type === "rule" ? remapConditionReferences(val as never, { questions: toLib }).value : val))) };
}
function shape(node: FlowNode | undefined, toLib: Record<string, string>): unknown {
  if (!node) return null;
  const s = (n: FlowNode): unknown => ({ type: n.type, title: (n as { title?: string }).title ?? null, q: n.type === "page" ? n.questionIds.map((x) => toLib[x] ?? x) : undefined, c: kids(n).filter((c) => c.length).map((c) => c.map(s)) });
  return s(node);
}
function fingerprint(c: Content, keyOf: (q: Question) => string, toLib: Record<string, string>): string {
  if (c.options) return fnv(canon(c.options));
  return fnv(canon({ q: c.questions.map((q) => comparable(q, keyOf(q), toLib)), shape: shape(c.node, toLib) }));
}
const libFingerprint = (c: Content) => fingerprint(c, (q) => q.id, {});
/** each question's own fingerprint, by library id */
const perQuestion = (c: Content): Record<string, string> => Object.fromEntries(c.questions.map((q) => [q.id, fnv(canon(comparable(q, q.id, {})))]));

/* ------------------------------------------------------------------ inserting */

export interface InsertResult { def: SurveyDefinition; link: LibraryLink; notes: string[] }
export interface InsertOptions { library: { surveyId?: string; title?: string }; version: number | string; after?: string; into?: string; now?: string }

const freshId = (taken: Set<string>, base: string): string => { let id = base, n = 2; while (taken.has(id)) id = `${base}_${n++}`; taken.add(id); return id; };

export function insertFromLibrary(input: SurveyDefinition, lib: SurveyDefinition, itemId: string, opts: InsertOptions): InsertResult | { error: string } {
  const def = structuredClone(input) as SurveyDefinition;
  const content = contentOf(lib, itemId);
  if (!content) return { error: `The library has no item ${itemId}.` };
  const notes: string[] = [];
  const kind: LibraryItemKind = itemId.startsWith("list:") ? "list" : itemId.startsWith("q:") ? "question" : "block";
  const linkId = freshId(new Set((def.libraryLinks ?? []).map((l) => l.id)), `lib_${itemId.replace(/[^A-Za-z0-9]+/g, "_")}`);
  const base: Omit<LibraryLink, "keys" | "hash"> = { id: linkId, library: opts.library, itemId, kind, version: opts.version, ...(opts.now ? { insertedAt: opts.now } : {}) };
  if (kind === "list") {
    const target = def.questions.find((q) => q.id === opts.into || q.code === opts.into);
    if (!target) return { error: "Say which question the list goes into." };
    target.options = structuredClone(content.options!);
    const link: LibraryLink = { ...base, optionsOf: target.id, keys: {}, hash: libFingerprint(content) };
    def.libraryLinks = [...(def.libraryLinks ?? []), link];
    notes.push(`${target.code} now has the library's ${content.options!.length} options.`);
    return finish(def, link, notes);
  }
  const takenIds = new Set(def.questions.map((q) => q.id)), takenCodes = new Set(def.questions.map((q) => q.code)), takenVars = new Set(def.questions.map((q) => q.variableName));
  const keys: Record<string, string> = {};
  const fresh = content.questions.map((q) => {
    const id = freshId(takenIds, q.id), code = freshId(takenCodes, q.code), variableName = freshId(takenVars, q.variableName);
    keys[q.id] = id;
    if (code !== q.code) notes.push(`${q.code} is already used here, so the library's ${q.code} came in as ${code}.`);
    return { ...structuredClone(q), id, code, variableName } as Question;
  });
  /* references between the item's own questions follow the copies; references to anything else are reported */
  for (const q of fresh) {
    const rewritten = JSON.parse(JSON.stringify(q, (_k, val) => (val && typeof val === "object" && !Array.isArray(val) && (val as O).type === "rule" ? remapConditionReferences(val as never, { questions: keys }).value : val)));
    Object.assign(q, rewritten);
  }
  const all = new Set([...def.questions.map((q) => q.id), ...fresh.map((q) => q.id)]);
  for (const q of fresh) for (const r of conditionRefs({ ...def, questions: [...def.questions, ...fresh] } as SurveyDefinition, (q as { displayLogic?: never }).displayLogic)) if (!all.has(r)) notes.push(`${q.code}'s display logic reads ${lib.questions.find((x) => x.id === r)?.code ?? r}, which is not in this survey. Fix its logic before publishing.`);
  def.questions.push(...fresh);
  let nodeId: string | undefined;
  const takenNodes = new Set<string>(); const collect = (ns: FlowNode[]) => { for (const n of ns) { takenNodes.add(n.id); for (const c of kids(n)) collect(c); } }; collect(def.flow);
  const node: FlowNode = kind === "block"
    ? (function clone(n: FlowNode): FlowNode {
        const c = structuredClone(n) as FlowNode & K;
        c.id = freshId(takenNodes, n.id);
        if (c.type === "page") c.questionIds = c.questionIds.map((x) => keys[x] ?? x);
        if (c.children) c.children = c.children.map(clone);
        if (c.branches) c.branches = c.branches.map((b) => ({ ...b, children: b.children.map(clone) }));
        if (c.otherwise) c.otherwise = c.otherwise.map(clone);
        return c;
      })(content.node!)
    : ({ type: "page", id: freshId(takenNodes, `p_${fresh[0]!.id}`), questionIds: [fresh[0]!.id] } as FlowNode);
  nodeId = node.id;
  const at = opts.after ? def.flow.findIndex((n) => n.id === opts.after || (n.type === "page" && n.questionIds.some((q) => q === opts.after || def.questions.find((x) => x.id === q)?.code === opts.after))) : -1;
  const endAt = def.flow.findIndex((n) => n.type === "end");
  def.flow.splice(at >= 0 ? at + 1 : endAt >= 0 ? endAt : def.flow.length, 0, node);
  const link: LibraryLink = { ...base, nodeId, keys, hash: libFingerprint(content), hashes: perQuestion(content) };
  def.libraryLinks = [...(def.libraryLinks ?? []), link];
  notes.unshift(`Inserted ${kind === "block" ? `the block “${(content.node as { title?: string }).title ?? itemId}” (${fresh.length} questions)` : fresh[0]!.code} from the library, version ${opts.version}.`);
  return finish(def, link, notes);
}

function finish(def: SurveyDefinition, link: LibraryLink, notes: string[]): InsertResult | { error: string } {
  const parsed = SurveyDefinitionSchema.safeParse(def);
  if (!parsed.success) return { error: `The result is not a valid survey: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}` };
  return { def: parsed.data, link: parsed.data.libraryLinks!.find((l) => l.id === link.id)!, notes };
}

/* ------------------------------------------------------------------ status and impact */

export type LinkState = "up_to_date" | "update_available" | "changed_here" | "both" | "item_removed" | "library_missing";
export interface LinkImpact { added: string[]; removed: string[]; changed: { code: string; what: string[] }[]; broken: string[]; overwrites: string[] }
export interface LinkStatus { link: LibraryLink; state: LinkState; libraryVersion?: number | string; impact?: LinkImpact; message: string }

function localContent(def: SurveyDefinition, link: LibraryLink): Content | null {
  if (link.kind === "list") { const q = def.questions.find((x) => x.id === link.optionsOf); return q ? { questions: [], options: q.options } : null; }
  const local = Object.values(link.keys).map((id) => def.questions.find((q) => q.id === id)).filter((q): q is Question => !!q);
  const node = link.nodeId ? findNode(def.flow, link.nodeId) ?? undefined : undefined;
  return { questions: local, ...(link.kind === "block" && node ? { node } : {}) };
}
const reverse = (keys: Record<string, string>) => Object.fromEntries(Object.entries(keys).map(([a, b]) => [b, a]));

export function libraryStatus(def: SurveyDefinition, libraries: Record<string, { def: SurveyDefinition; version: number | string }>): LinkStatus[] {
  return (def.libraryLinks ?? []).map((link): LinkStatus => {
    const lib = link.library.surveyId ? libraries[link.library.surveyId] : undefined;
    if (!lib) return { link, state: "library_missing", message: `The library ${link.library.title ?? link.library.surveyId ?? ""} cannot be found.` };
    const now = contentOf(lib.def, link.itemId);
    if (!now) return { link, state: "item_removed", libraryVersion: lib.version, message: `The library no longer has this ${link.kind}. The copy here is kept as it is.` };
    const toLib = reverse(link.keys);
    const local = localContent(def, link);
    const localHash = local ? fingerprint(local, (q) => toLib[q.id] ?? q.id, toLib) : "";
    const libHash = libFingerprint(now);
    const updated = libHash !== link.hash, edited = localHash !== link.hash;
    const state: LinkState = updated && edited ? "both" : updated ? "update_available" : edited ? "changed_here" : "up_to_date";
    const impact = updated || edited ? impactOf(def, link, now, local, toLib) : undefined;
    const message = state === "up_to_date" ? `Up to date with version ${lib.version}.`
      : state === "update_available" ? `Version ${lib.version} is available (this copy is ${link.version}).`
      : state === "changed_here" ? "Edited here since it was inserted; the library's item has not changed."
      : `Version ${lib.version} is available, and this copy was also edited here: updating would overwrite those edits.`;
    return { link, state, libraryVersion: lib.version, ...(impact ? { impact } : {}), message };
  });
}

function impactOf(def: SurveyDefinition, link: LibraryLink, lib: Content, local: Content | null, toLib: Record<string, string>): LinkImpact {
  const impact: LinkImpact = { added: [], removed: [], changed: [], broken: [], overwrites: [] };
  const localById = new Map((local?.questions ?? []).map((q) => [toLib[q.id] ?? q.id, q]));
  const libById = new Map(lib.questions.map((q) => [q.id, q]));
  const codeOf = (libId: string) => localById.get(libId)?.code ?? libById.get(libId)?.code ?? libId;
  const removedCodes: { qid: string; codes: unknown[] }[] = [];
  if (link.kind === "list") {
    const before = (local?.options ?? []).map((o) => o.code), after = new Set((lib.options ?? []).map((o) => o.code));
    const gone = before.filter((c) => !after.has(c));
    if (gone.length) removedCodes.push({ qid: link.optionsOf!, codes: gone });
    const added = (lib.options ?? []).filter((o) => !before.includes(o.code));
    if (gone.length || added.length) impact.changed.push({ code: def.questions.find((q) => q.id === link.optionsOf)?.code ?? "", what: [...(added.length ? [`options added: ${added.map((o) => o.label).join(", ")}`] : []), ...(gone.length ? [`options removed: ${gone.join(", ")}`] : [])] });
  } else {
    for (const id of libById.keys()) if (!link.keys[id]) impact.added.push(libById.get(id)!.code);
    for (const [libId, localId] of Object.entries(link.keys)) {
      const l = def.questions.find((q) => q.id === localId);
      if (!libById.has(libId)) { if (l) impact.removed.push(l.code); continue; }
      if (!l) continue;
      const n = libById.get(libId)!;
      const what: string[] = [];
      if (l.text !== n.text) what.push("wording");
      if (l.type !== n.type) what.push(`type ${l.type} → ${n.type}`);
      const lc = (l.options ?? []).map((o) => o.code), nc = new Set((n.options ?? []).map((o) => o.code));
      const gone = lc.filter((c) => !nc.has(c)), added = (n.options ?? []).filter((o) => !lc.includes(o.code));
      if (added.length) what.push(`options added: ${added.map((o) => o.label).join(", ")}`);
      if (gone.length) { what.push(`options removed: ${gone.join(", ")}`); removedCodes.push({ qid: localId, codes: gone }); }
      if (JSON.stringify(comparable(l, libId, toLib).displayLogic ?? null) !== JSON.stringify(comparable(n, libId, {}).displayLogic ?? null)) what.push("display logic");
      if (what.length) impact.changed.push({ code: l.code, what });
    }
  }
  /* what in the REST of this survey reads a question or an option the update removes */
  const linked = new Set(link.kind === "list" ? [] : Object.values(link.keys));
  const removedQ = new Set(Object.entries(link.keys).filter(([libId]) => !libById.has(libId)).map(([, id]) => id));
  const readers: { where: string; c: unknown }[] = [];
  for (const q of def.questions) {
    if (linked.has(q.id)) continue;
    if ((q as { displayLogic?: unknown }).displayLogic) readers.push({ where: `${q.code}'s display logic`, c: (q as { displayLogic?: unknown }).displayLogic });
    for (const r of q.skipLogic ?? []) readers.push({ where: `${q.code}'s skip ${r.id}`, c: r.when });
  }
  for (const qu of def.quotas ?? []) for (const cell of qu.cells) readers.push({ where: `quota ${qu.name}, cell ${cell.label}`, c: cell.when });
  for (const r of readers) {
    const refs = conditionRefs(def, r.c as never);
    for (const id of refs) if (removedQ.has(id)) impact.broken.push(`${r.where} reads ${def.questions.find((q) => q.id === id)?.code ?? id}, which the update removes`);
    for (const rc of removedCodes) {
      if (!refs.has(rc.qid)) continue;
      const text = JSON.stringify(r.c);
      for (const code of rc.codes) if (text.includes(`"value":${JSON.stringify(code)}`) || text.includes(`,${JSON.stringify(code)}`) || text.includes(`[${JSON.stringify(code)}`)) impact.broken.push(`${r.where} reads option ${String(code)} of ${def.questions.find((q) => q.id === rc.qid)?.code}, which the update removes`);
    }
  }
  /* local edits the update would overwrite: questions that no longer match their fingerprint as inserted */
  if (local && link.kind !== "list" && link.hashes) for (const [libId, localId] of Object.entries(link.keys)) {
    const l = def.questions.find((q) => q.id === localId);
    if (l && link.hashes[libId] && fnv(canon(comparable(l, libId, toLib))) !== link.hashes[libId]) impact.overwrites.push(codeOf(libId));
  }
  impact.broken = [...new Set(impact.broken)];
  return impact;
}

/* ------------------------------------------------------------------ updating */

export function applyLibraryUpdate(input: SurveyDefinition, linkId: string, lib: SurveyDefinition, version: number | string): InsertResult | { error: string } {
  const def = structuredClone(input) as SurveyDefinition;
  const link = (def.libraryLinks ?? []).find((l) => l.id === linkId);
  if (!link) return { error: `There is no library link ${linkId}.` };
  const content = contentOf(lib, link.itemId);
  if (!content) return { error: "The library no longer has this item; there is nothing to update to." };
  const notes: string[] = [];
  if (link.kind === "list") {
    const q = def.questions.find((x) => x.id === link.optionsOf);
    if (!q) return { error: "The question the list went into is gone." };
    q.options = structuredClone(content.options!);
    Object.assign(link, { version, hash: libFingerprint(content) });
    notes.push(`${q.code}'s options updated to version ${version}.`);
    return finish(def, link, notes);
  }
  const takenIds = new Set(def.questions.map((q) => q.id)), takenCodes = new Set(def.questions.map((q) => q.code)), takenVars = new Set(def.questions.map((q) => q.variableName));
  const keys: Record<string, string> = {};
  const next: Question[] = content.questions.map((q) => {
    const localId = link.keys[q.id];
    const existing = localId ? def.questions.find((x) => x.id === localId) : undefined;
    if (existing) { keys[q.id] = existing.id; return { ...structuredClone(q), id: existing.id, code: existing.code, variableName: existing.variableName } as Question; }
    const id = freshId(takenIds, q.id), code = freshId(takenCodes, q.code), variableName = freshId(takenVars, q.variableName);
    keys[q.id] = id; notes.push(`New in the library: ${code}.`);
    return { ...structuredClone(q), id, code, variableName } as Question;
  });
  for (const q of next) Object.assign(q, JSON.parse(JSON.stringify(q, (_k, val) => (val && typeof val === "object" && !Array.isArray(val) && (val as O).type === "rule" ? remapConditionReferences(val as never, { questions: keys }).value : val))));
  const removed = Object.entries(link.keys).filter(([libId]) => !keys[libId]).map(([, id]) => id);
  for (const id of removed) notes.push(`Removed (no longer in the library): ${def.questions.find((q) => q.id === id)?.code ?? id}.`);
  const keep = new Set(Object.values(keys));
  def.questions = [...def.questions.filter((q) => !removed.includes(q.id) && !keep.has(q.id)), ...next];
  /* the flow: a block takes the library's layout again; a question stays where it is */
  const dropRemoved = (ns: FlowNode[]): FlowNode[] => ns.map((n) => { const c = { ...n } as FlowNode & K; if (c.type === "page") c.questionIds = c.questionIds.filter((x) => !removed.includes(x)); if (c.children) c.children = dropRemoved(c.children); if (c.branches) c.branches = c.branches.map((b) => ({ ...b, children: dropRemoved(b.children) })); if (c.otherwise) c.otherwise = dropRemoved(c.otherwise); return c; }).filter((n) => !(n.type === "page" && n.questionIds.length === 0));
  if (link.kind === "block" && link.nodeId) {
    const takenNodes = new Set<string>(); const collect = (ns: FlowNode[]) => { for (const n of ns) { takenNodes.add(n.id); for (const c of kids(n)) collect(c); } }; collect(def.flow);
    const clone = (n: FlowNode, top: boolean): FlowNode => { const c = structuredClone(n) as FlowNode & K; c.id = top ? link.nodeId! : freshId(takenNodes, n.id); if (c.type === "page") c.questionIds = c.questionIds.map((x) => keys[x] ?? x); if (c.children) c.children = c.children.map((x) => clone(x, false)); if (c.branches) c.branches = c.branches.map((b) => ({ ...b, children: b.children.map((x) => clone(x, false)) })); if (c.otherwise) c.otherwise = c.otherwise.map((x) => clone(x, false)); return c; };
    const replace = (ns: FlowNode[]): FlowNode[] => ns.map((n) => { if (n.id === link.nodeId) return clone(content.node!, true); const c = { ...n } as FlowNode & K; if (c.children) c.children = replace(c.children); if (c.branches) c.branches = c.branches.map((b) => ({ ...b, children: replace(b.children) })); if (c.otherwise) c.otherwise = replace(c.otherwise); return c; });
    def.flow = replace(def.flow);
  }
  def.flow = dropRemoved(def.flow);
  Object.assign(link, { version, keys, hash: libFingerprint(content), hashes: perQuestion(content) });
  notes.unshift(`Updated to version ${version}.`);
  return finish(def, link, notes);
}
