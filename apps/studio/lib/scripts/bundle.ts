/**
 * S3b item 4 (audit MM-08) — IMPORT / EXPORT SCRIPTS between surveys as a JSON bundle:
 *
 *   { "format": "rescript-scripts", "version": 1, "source": {…}, "items": [ … ] }
 *
 * An item is a behaviour (a script, or effects) or a Scripts-panel logic script: its name, kind, code, events and
 * WHERE IT RUNS BY QUESTION CODE, never by id — ids differ between surveys, codes are what the programmer named.
 * A block is carried by its title, a page by its position in the survey ("page 3"). Question ids that appear inside
 * the code (`[data-qid="q_ab12"]`) are carried as id → code, and rewritten to the new survey's ids on import.
 *
 * IMPORT into another survey: every code is resolved to that survey's ids; an item whose question, option, block or
 * page is not there is NOT imported and is listed with the reason; every item that maps goes through ITS gate (a
 * behaviour: `validateUxItem`, the editor's save gate; a logic script: `codeGate(…, "logic")`) and a refused one is
 * listed with the reasons, not imported. What is imported arrives SWITCHED OFF with a review note — nothing imported
 * runs until a person switches it on (which passes the gate again). A "when" condition is not carried (it names
 * questions by id inside an expression tree) — the import says so.
 */
import type { CustomScript, SurveyDefinition, UxBehavior, UxEffect, UxTarget } from "@rescript/schema";
import { codeGate, listBlocks, surveyPages, validateUxItem } from "@rescript/engine";

export const BUNDLE_FORMAT = "rescript-scripts";
export const BUNDLE_VERSION = 1;

/** a target, by code: `question` is a question CODE, `block` a block TITLE, `page` a 1-based page number */
export interface BundleTarget {
  kind: UxTarget["kind"];
  question?: string;
  code?: string;
  block?: string;
  page?: number;
  button?: UxTarget["button"];
  part?: UxTarget["part"];
  selector?: string;
}
export interface BundleItem {
  kind: "behavior" | "logic";
  name: string;
  code?: string;
  /* behaviour */
  target?: BundleTarget;
  on?: string;
  options?: string[];
  effects?: (Omit<UxEffect, "target"> & { target?: BundleTarget })[];
  once?: boolean;
  /** the source had a "when" condition (not carried) */
  hadCondition?: boolean;
  /* logic */
  event?: CustomScript["event"];
  scope?: CustomScript["scope"];
  /** question scope: the question CODE; page scope: the page number */
  ref?: string | number;
  /** question ids named inside the code → their codes (rewritten on import) */
  ids?: Record<string, string>;
}
export interface ScriptBundle { format: typeof BUNDLE_FORMAT; version: typeof BUNDLE_VERSION; source?: { survey?: string; title?: string; exportedAt?: string }; items: BundleItem[] }

const pageIds = (def: SurveyDefinition) => surveyPages(def).map((p) => p.pageId);
const blockTitle = (def: SurveyDefinition, id?: string) => (id ? listBlocks(def.flow as unknown[]).find((b) => b.id === id)?.title ?? id : undefined);

function targetOut(def: SurveyDefinition, t: UxTarget): BundleTarget {
  const q = t.questionId ? def.questions.find((x) => x.id === t.questionId) : undefined;
  const pages = pageIds(def);
  return {
    kind: t.kind,
    ...(t.questionId ? { question: q ? String(q.code) : t.questionId } : {}),
    ...(t.code != null ? { code: t.code } : {}),
    ...(t.blockId ? { block: blockTitle(def, t.blockId) } : {}),
    ...(t.pageId ? { page: pages.indexOf(t.pageId) + 1 || undefined } : {}),
    ...(t.button ? { button: t.button } : {}),
    ...(t.part ? { part: t.part } : {}),
    ...(t.selector ? { selector: t.selector } : {}),
  };
}
const idsIn = (def: SurveyDefinition, code: string | undefined): Record<string, string> | undefined => {
  if (!code) return undefined;
  const out: Record<string, string> = {};
  for (const q of def.questions) if (q.id.length >= 3 && code.includes(q.id) && q.id !== String(q.code)) out[q.id] = String(q.code);
  return Object.keys(out).length ? out : undefined;
};

/** the bundle for these behaviours / logic scripts (by id); everything when `ids` is absent */
export function exportScripts(def: SurveyDefinition, ids?: { behaviors?: string[]; logic?: string[] }, now = new Date().toISOString()): ScriptBundle {
  const items: BundleItem[] = [];
  for (const b of def.ux?.behaviors ?? []) {
    if (ids && !ids.behaviors?.includes(b.id)) continue;
    if (!ids && !b.script) continue; // "all scripts": behaviours with a script
    items.push({
      kind: "behavior", name: b.label, ...(b.script ? { code: b.script } : {}), target: targetOut(def, b.target),
      ...(b.on ? { on: b.on } : {}), ...(b.options?.length ? { options: b.options } : {}),
      ...(b.effects.length ? { effects: b.effects.map((e) => ({ ...e, ...(e.target ? { target: targetOut(def, e.target) } : {}) })) } : {}),
      ...(b.once ? { once: true } : {}), ...(b.when ? { hadCondition: true } : {}),
      ...(idsIn(def, b.script) ? { ids: idsIn(def, b.script) } : {}),
    });
  }
  for (const s of def.scripts ?? []) {
    if (ids && !ids.logic?.includes(s.id)) continue;
    const q = s.scope === "question" ? def.questions.find((x) => x.id === s.ref || String(x.code) === s.ref) : undefined;
    const ref = s.scope === "question" ? (q ? String(q.code) : s.ref) : s.scope === "page" && s.ref ? pageIds(def).indexOf(s.ref) + 1 || s.ref : undefined;
    items.push({ kind: "logic", name: s.name, code: s.code, event: s.event, scope: s.scope, ...(ref !== undefined ? { ref } : {}), ...(s.when ? { hadCondition: true } : {}), ...(idsIn(def, s.code) ? { ids: idsIn(def, s.code) } : {}) });
  }
  return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, source: { survey: String(def.meta.code ?? def.meta.id), title: def.meta.title, exportedAt: now }, items };
}

export interface ImportOutcome {
  def: SurveyDefinition;
  added: { kind: "behavior" | "logic"; name: string; id: string; notes: string[] }[];
  /** could not be mapped to this survey: not imported */
  unmapped: { name: string; reason: string }[];
  /** mapped, but its gate refused it: not imported */
  refused: { name: string; reasons: string[] }[];
}

/** read a bundle from text (a file or a paste); a reason when it is not one */
export function parseBundle(text: string): ScriptBundle | string {
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { return `not JSON: ${(e as Error).message}`; }
  const o = v as Partial<ScriptBundle> | null;
  if (!o || typeof o !== "object" || o.format !== BUNDLE_FORMAT) return `not a script bundle (format must be "${BUNDLE_FORMAT}")`;
  if (o.version !== BUNDLE_VERSION) return `bundle version ${String(o.version)} is not supported (this Studio reads version ${BUNDLE_VERSION})`;
  if (!Array.isArray(o.items)) return "the bundle has no items";
  if (o.items.length > 200) return "a bundle holds at most 200 items";
  return o as ScriptBundle;
}

export function importScripts(def0: SurveyDefinition, bundle: ScriptBundle, newId: (prefix: string) => string, now = new Date().toISOString()): ImportOutcome {
  const def = structuredClone(def0);
  def.ux = def.ux ?? { styles: [], animations: [], behaviors: [] };
  const out: ImportOutcome = { def, added: [], unmapped: [], refused: [] };
  const pages = surveyPages(def);
  const blocks = listBlocks(def.flow as unknown[]);
  const byCode = (code: string) => def.questions.find((q) => String(q.code) === code) ?? def.questions.find((q) => String(q.code).toLowerCase() === code.toLowerCase());
  const from = bundle.source?.survey ? ` from ${bundle.source.survey}` : "";
  const note = `Imported${from} on ${now.slice(0, 10)} — switched off: review it, then switch it on.`;
  const mapTarget = (t: BundleTarget | undefined): UxTarget | string => {
    if (!t || typeof t !== "object" || !t.kind) return "it has no target";
    const r: UxTarget = { kind: t.kind };
    if (t.question != null) {
      const q = byCode(String(t.question));
      if (!q) return `this survey has no question ${t.question}`;
      r.questionId = q.id;
      if (t.code != null && t.kind === "option" && !q.options?.some((o) => String(o.code) === String(t.code))) return `${q.code} has no option ${t.code}`;
    }
    if (t.code != null) r.code = String(t.code);
    if (t.block != null) { const b = blocks.find((x) => x.title === t.block || x.id === t.block); if (!b) return `this survey has no block “${t.block}”`; r.blockId = b.id; }
    if (t.page != null) { const p = pages[Number(t.page) - 1]; if (!p) return `this survey has no page ${t.page}`; r.pageId = p.pageId; }
    if (t.button) r.button = t.button;
    if (t.part) r.part = t.part;
    if (t.selector) r.selector = t.selector;
    return r;
  };
  /* question ids inside the code: the source's id → code → this survey's id */
  const rewrite = (code: string | undefined, ids: Record<string, string> | undefined): { code?: string; missing: string[] } => {
    if (!code || !ids) return { code, missing: [] };
    let c = code;
    const missing: string[] = [];
    for (const [oldId, qc] of Object.entries(ids)) { const q = byCode(qc); if (!q) { missing.push(qc); continue; } c = c.split(oldId).join(q.id); }
    return { code: c, missing };
  };
  for (const it of bundle.items) {
    const name = String(it?.name ?? "(unnamed)").slice(0, 160);
    if (it?.kind === "behavior") {
      const t = mapTarget(it.target);
      if (typeof t === "string") { out.unmapped.push({ name, reason: t }); continue; }
      const effects: UxEffect[] = [];
      let bad: string | null = null;
      for (const e of it.effects ?? []) {
        if (e.target) { const et = mapTarget(e.target); if (typeof et === "string") { bad = `an effect's target: ${et}`; break; } effects.push({ ...e, target: et } as UxEffect); }
        else effects.push(e as UxEffect);
      }
      if (bad) { out.unmapped.push({ name, reason: bad }); continue; }
      const rw = rewrite(it.code, it.ids);
      if (rw.missing.length) { out.unmapped.push({ name, reason: `its code names question${rw.missing.length === 1 ? "" : "s"} ${rw.missing.join(", ")}, which this survey does not have` }); continue; }
      const notes = [note, ...(it.hadCondition ? ["Its “only when” condition was not imported — set it again if needed."] : [])];
      const b: UxBehavior = {
        id: newId("uxb"), label: name, target: t, effects, ...(rw.code ? { script: rw.code } : {}),
        ...(it.on ? { on: it.on as UxBehavior["on"] } : {}), ...(it.options?.length ? { options: it.options.map(String) } : {}), ...(it.once ? { once: true } : {}),
        enabled: false, notes: notes.join(" ").slice(0, 600), createdAt: now,
      };
      const v = validateUxItem(def, "behavior", b);
      if (v.errors.length) { out.refused.push({ name, reasons: v.errors.slice(0, 3) }); continue; }
      def.ux.behaviors.push(b);
      out.added.push({ kind: "behavior", name, id: b.id, notes });
    } else if (it?.kind === "logic") {
      const scope = it.scope === "question" || it.scope === "page" ? it.scope : "survey";
      let ref: string | undefined;
      if (scope === "question") { const q = it.ref != null ? byCode(String(it.ref)) : undefined; if (!q) { out.unmapped.push({ name, reason: `this survey has no question ${it.ref ?? "(none given)"}` }); continue; } ref = q.id; }
      if (scope === "page") { const p = typeof it.ref === "number" ? pages[it.ref - 1] : pages.find((x) => x.pageId === it.ref); if (!p) { out.unmapped.push({ name, reason: `this survey has no page ${it.ref ?? "(none given)"}` }); continue; } ref = p.pageId; }
      const rw = rewrite(it.code ?? "", it.ids);
      if (rw.missing.length) { out.unmapped.push({ name, reason: `its code names question${rw.missing.length === 1 ? "" : "s"} ${rw.missing.join(", ")}, which this survey does not have` }); continue; }
      const code = rw.code ?? "";
      const g = code.trim() ? codeGate(code, "logic") : { ok: true, errors: [] as string[] };
      if (!g.ok) { out.refused.push({ name, reasons: g.errors.slice(0, 3) }); continue; }
      const notes = [note, ...(it.hadCondition ? ["Its “run only when” condition was not imported — set it again if needed."] : [])];
      const sc: CustomScript = { id: newId("script"), name, scope, ...(ref ? { ref } : {}), event: (["on_load", "on_change", "on_submit", "on_validate", "on_complete"].includes(String(it.event)) ? it.event : "on_load") as CustomScript["event"], code, enabled: false, notes: notes.join(" ") };
      def.scripts.push(sc);
      out.added.push({ kind: "logic", name, id: sc.id, notes });
    } else {
      out.unmapped.push({ name, reason: `unknown kind “${String(it?.kind)}”` });
    }
  }
  return out;
}
