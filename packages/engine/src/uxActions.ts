import type { Condition, SurveyDefinition, UxAnimation, UxBehavior, UxEffect, UxRule, UxStyle, UxTarget } from "@rescript/schema";
import { parseLogicExpression } from "./logicExpression.js";
import { UX_ANIMATION_TRIGGERS, UX_EFFECTS, UX_EVENTS, UX_MEDIA, UX_PRESETS, UX_STATES, UX_POPUP_PLACEMENTS, UX_POPUP_DISMISS, effectiveResponseModel } from "@rescript/schema";
import { describeUxTarget, resolveUxTarget, uxToken, uxDeclarations, validateUxItem, uxBehaviorKey, uxBehaviorTrigger, UX_HOLDING_EVENTS, type UxLookups } from "./ux.js";
import { SCRIPT_CHECKED } from "./uxScriptGuard.js";
import { applyThemePatch } from "./theme.js";
import { defaultAnswerFor } from "./defaultValue.js";
import { createResponseState } from "./state.js";
import { describeOptions, type OptionList } from "./optionCodes.js";

/**
 * THE UX ACTIONS — how the copilot changes the survey's look and behaviour,
 * through the same controlled layer as its structural actions:
 *
 *   create_style / update_style / remove_style
 *   create_animation / update_animation / remove_animation
 *   create_behavior / update_behavior / remove_behavior
 *   attach_behavior_to_question | _option | _block | _page   (create_behavior, target kind fixed)
 *   create_responsive_rule                                    (create_style with a breakpoint)
 *
 * Preview, apply and roll back are not actions the model takes — they are the
 * proposal it is part of: previewed in the Changes panel, applied by the
 * researcher as one undoable edit, rolled back with Undo AI change.
 *
 * Every item is resolved against the real survey (targets by stable id) and
 * validated by the engine's UX gate before it is kept; an item that does not
 * validate is refused with its reasons. None of these can touch a question,
 * its options, codes, logic, validation or variables: they write `def.ux` and
 * nothing else.
 */

export const UX_ACTION_OPS = [
  "create_style", "update_style", "remove_style",
  "create_animation", "update_animation", "remove_animation",
  "create_behavior", "update_behavior", "remove_behavior",
  /* the survey's theme (its branding — the Branding panel's own settings) and a question's decorative HTML */
  "set_theme", "set_custom_html",
  /* a question's starting answer (settings.defaultValue — the Properties "Default value" field) */
  "set_default_value",
] as const;
/** accepted from the model and turned into the ops above */
export const UX_ACTION_ALIASES = ["attach_behavior_to_question", "attach_behavior_to_option", "attach_behavior_to_block", "attach_behavior_to_page", "create_responsive_rule", "create_behaviour", "update_behaviour", "remove_behaviour"] as const;

export interface RawRule { state?: string; media?: string; whenClass?: string; selector?: string; declarations: Record<string, string> }
export interface RawEffect { do: string; target?: unknown; className?: string; preset?: string; durationMs?: number; style?: Record<string, string>; text?: string; title?: string; placement?: string; dismiss?: string; autoMs?: number }
/** update_behavior: a small change to a stored script without sending it again — each `find` must occur exactly once */
export interface ScriptEdit { find: string; replace: string }
type AnimFields = { preset?: string; trigger?: string; durationMs?: number; delayMs?: number; easing?: string; staggerMs?: number; iterations?: number | "infinite"; media?: string; when?: string | null };
type BehFields = { on?: string; options?: string[]; effects?: RawEffect[]; script?: string; once?: boolean; when?: string | null; edits?: ScriptEdit[] };
export type UxAction =
  | { op: "create_style"; ref?: string; label: string; target: unknown; rules: RawRule[]; css?: string; when?: string }
  | { op: "update_style"; id: string; label?: string; target?: unknown; rules?: RawRule[]; addRules?: RawRule[]; css?: string | null; when?: string | null }
  | { op: "remove_style"; id: string }
  | ({ op: "create_animation"; ref?: string; label: string; target: unknown; preset: string } & AnimFields)
  | ({ op: "update_animation"; id: string; label?: string; target?: unknown } & AnimFields)
  | { op: "remove_animation"; id: string }
  | ({ op: "create_behavior"; ref?: string; label: string; target: unknown } & BehFields)
  | ({ op: "update_behavior"; id: string; label?: string; target?: unknown } & BehFields)
  | { op: "remove_behavior"; id: string }
  | { op: "set_theme"; patch: Record<string, unknown>; label?: string }
  | { op: "set_custom_html"; target: string; html: string | null }
  | { op: "set_default_value"; target: string; value: string | number | (string | number)[] | null };

export const isUxOp = (op: string) => (UX_ACTION_OPS as readonly string[]).includes(op);

/* ------------------------------------------------------------ the gate */

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Math.round(Number(v)) : undefined);
const ms = (v: unknown): number | undefined => {
  if (typeof v === "string") { const m = /^(\d+(?:\.\d+)?)\s*(ms|s)?$/i.exec(v.trim()); if (m) return Math.round(Number(m[1]) * (m[2]?.toLowerCase() === "s" ? 1000 : 1)); }
  return num(v);
};
const target = (v: unknown): unknown => (typeof v === "string" ? (v.trim() || undefined) : v && typeof v === "object" ? v : undefined);
const record = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === "string" || typeof x === "number") out[k] = String(x);
  return Object.keys(out).length ? out : undefined;
};
const rule = (v: unknown): RawRule | null => {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const declarations = record(o.declarations) ?? record(o.style) ?? record(o.css);
  if (!declarations) return null;
  return { declarations, ...(str(o.state) ? { state: str(o.state) } : {}), ...(str(o.media) ?? str(o.breakpoint) ? { media: str(o.media) ?? str(o.breakpoint) } : {}), ...(str(o.whenClass) ? { whenClass: str(o.whenClass) } : {}), ...(str(o.selector) ? { selector: str(o.selector) } : {}) };
};
const rules = (o: Record<string, unknown>): RawRule[] | undefined => {
  const list = Array.isArray(o.rules) ? o.rules.map(rule).filter((x): x is RawRule => !!x) : [];
  // shorthand: declarations at the top level are one rule
  const top = record(o.declarations) ?? record(o.style);
  if (top) list.push({ declarations: top, ...(str(o.state) ? { state: str(o.state) } : {}), ...(str(o.media) ?? str(o.breakpoint) ? { media: str(o.media) ?? str(o.breakpoint) } : {}), ...(str(o.selector) ? { selector: str(o.selector) } : {}) });
  return list.length ? list.slice(0, 40) : undefined;
};
const effect = (v: unknown): RawEffect | null => {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const d = str(o.do) ?? str(o.effect) ?? str(o.action);
  if (!d) return null;
  return { do: d, ...(target(o.target) ? { target: target(o.target) } : {}), ...(str(o.className) ?? str(o.class) ? { className: str(o.className) ?? str(o.class) } : {}), ...(str(o.preset) ?? str(o.animation) ? { preset: str(o.preset) ?? str(o.animation) } : {}), ...(ms(o.durationMs ?? o.duration) ? { durationMs: ms(o.durationMs ?? o.duration) } : {}), ...(record(o.style) ? { style: record(o.style) } : {}), ...(str(o.text) ?? str(o.message) ? { text: str(o.text) ?? str(o.message) } : {}), ...(str(o.title) ?? str(o.heading) ? { title: str(o.title) ?? str(o.heading) } : {}), ...(str(o.placement) ?? str(o.position) ? { placement: str(o.placement) ?? str(o.position) } : {}), ...(str(o.dismiss) ? { dismiss: str(o.dismiss) } : {}), ...(ms(o.autoMs ?? o.autoCloseMs ?? o.closeAfter) ? { autoMs: ms(o.autoMs ?? o.autoCloseMs ?? o.closeAfter) } : {}) };
};
/** [{find, replace}] — the model's small change to a stored script (update_behavior "edits") */
const edits = (v: unknown): ScriptEdit[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => { const o = (x ?? {}) as Record<string, unknown>; const find = typeof o.find === "string" ? o.find : typeof o.old === "string" ? o.old : undefined; const replace = typeof o.replace === "string" ? o.replace : typeof o.new === "string" ? o.new : o.replace === null ? "" : undefined; return find !== undefined && replace !== undefined ? { find: find.slice(0, 20000), replace: replace.slice(0, 20000) } : null; });
  return out.filter((x): x is ScriptEdit => !!x).slice(0, 20);
};
const animFields = (o: Record<string, unknown>): AnimFields => ({
  ...(str(o.preset) ?? str(o.animation) ? { preset: str(o.preset) ?? str(o.animation) } : {}),
  ...(str(o.trigger) ? { trigger: str(o.trigger) } : {}),
  ...(ms(o.durationMs ?? o.duration) != null ? { durationMs: ms(o.durationMs ?? o.duration) } : {}),
  ...(ms(o.delayMs ?? o.delay) != null ? { delayMs: ms(o.delayMs ?? o.delay) } : {}),
  ...(str(o.easing) ? { easing: str(o.easing) } : {}),
  ...(ms(o.staggerMs ?? o.stagger) != null ? { staggerMs: ms(o.staggerMs ?? o.stagger) } : {}),
  ...(o.iterations === "infinite" ? { iterations: "infinite" as const } : num(o.iterations) ? { iterations: num(o.iterations) } : {}),
  ...(str(o.media) ?? str(o.breakpoint) ? { media: str(o.media) ?? str(o.breakpoint) } : {}),
  ...guardField(o),
});
/* a guard — "only when Q3 = 2 AND Q1 >= 18" — as expression text; null removes it */
const guardField = (o: Record<string, unknown>): { when?: string | null } =>
  o.when === null || o.condition === null ? { when: null } : str(o.when) ?? str(o.condition) ? { when: str(o.when) ?? str(o.condition) } : {};
const behFields = (o: Record<string, unknown>): BehFields => ({
  ...(str(o.on) ?? str(o.event) ?? str(o.trigger) ? { on: str(o.on) ?? str(o.event) ?? str(o.trigger) } : {}),
  ...(Array.isArray(o.options) ? { options: o.options.map((x) => (typeof x === "number" ? String(x) : str(x))).filter((x): x is string => !!x).slice(0, 50) } : typeof o.option === "string" || typeof o.option === "number" ? { options: [String(o.option)] } : {}),
  ...(Array.isArray(o.effects) ? { effects: o.effects.map(effect).filter((x): x is RawEffect => !!x).slice(0, 20) } : {}),
  ...(str(o.script) ?? str(o.js) ? { script: str(o.script) ?? str(o.js) } : {}),
  ...(typeof o.once === "boolean" ? { once: o.once } : {}),
  /* a guard — "only when Q3 = 2 AND Q1 >= 18" — as expression text; null removes it */
  ...(o.when === null || o.condition === null ? { when: null } : str(o.when) ?? str(o.condition) ? { when: str(o.when) ?? str(o.condition) } : {}),
});
const itemId = (o: Record<string, unknown>) => str(o.id) ?? str(o.target_id) ?? str(o.ref) ?? str(o.label) ?? str(o.name);

/** the UX half of the gate: a UxAction, a reason it is not one, or null when the op is not a UX op */
export function coerceUxAction(op: string, o: Record<string, unknown>): UxAction | string | null {
  const label = str(o.label) ?? str(o.name) ?? str(o.title);
  switch (op) {
    case "create_style": {
      const t = target(o.target), r = rules(o), css = str(o.css) && typeof o.css === "string" ? o.css : undefined;
      if (!t) return "create_style needs a target";
      if (!r && !css) return "create_style needs rules (declarations) or css";
      const g = guardField(o);
      return { op, label: (label ?? "Style").slice(0, 160), target: t, rules: r ?? [], ...(str(o.ref) ? { ref: str(o.ref) } : {}), ...(css ? { css: css.slice(0, 20000) } : {}), ...(g.when ? { when: g.when } : {}) };
    }
    case "create_responsive_rule": {
      const t = target(o.target), r = rules(o);
      const media = str(o.media) ?? str(o.breakpoint) ?? str(o.device);
      if (!t || !r) return "create_responsive_rule needs a target, a breakpoint (media) and declarations";
      return { op: "create_style", label: (label ?? `Responsive (${media ?? "mobile"})`).slice(0, 160), target: t, rules: r.map((x) => ({ ...x, media: x.media ?? media ?? "mobile" })), ...(str(o.ref) ? { ref: str(o.ref) } : {}) };
    }
    case "update_style": {
      const id = itemId(o);
      if (!id) return "update_style needs the style's id";
      const r = Array.isArray(o.rules) ? (o.rules.map(rule).filter((x): x is RawRule => !!x)) : undefined;
      const add = Array.isArray(o.addRules) ? o.addRules.map(rule).filter((x): x is RawRule => !!x) : record(o.declarations) ? [rule({ ...o, rules: undefined })!].filter(Boolean) : undefined;
      return { op, id, ...(str(o.newLabel) ?? (str(o.id) && label && label !== id ? label : undefined) ? { label: str(o.newLabel) ?? label } : {}), ...(target(o.newTarget) ? { target: target(o.newTarget) } : {}), ...(r ? { rules: r } : {}), ...(add?.length ? { addRules: add } : {}), ...(o.css === null ? { css: null } : typeof o.css === "string" ? { css: o.css.slice(0, 20000) } : {}), ...guardField(o) };
    }
    case "remove_style": case "remove_animation": case "remove_behavior": case "remove_behaviour": {
      const id = itemId(o);
      const real = op === "remove_behaviour" ? "remove_behavior" : op;
      return id ? { op: real as "remove_style", id } : `${real} needs the item's id`;
    }
    case "create_animation": {
      const t = target(o.target), f = animFields(o);
      if (!t || !f.preset) return "create_animation needs a target and a preset";
      return { op, label: (label ?? `${f.preset} animation`).slice(0, 160), target: t, preset: f.preset, ...f, ...(str(o.ref) ? { ref: str(o.ref) } : {}) };
    }
    case "update_animation": {
      const id = itemId(o);
      if (!id) return "update_animation needs the animation's id";
      return { op, id, ...animFields(o), ...(target(o.newTarget) ? { target: target(o.newTarget) } : {}), ...(str(o.newLabel) ? { label: str(o.newLabel) } : {}) };
    }
    case "create_behavior": case "create_behaviour":
    case "attach_behavior_to_question": case "attach_behavior_to_option": case "attach_behavior_to_block": case "attach_behavior_to_page": {
      let t = target(o.target);
      if (!t) return `${op} needs a target`;
      const kind = op.startsWith("attach_behavior_to_") ? op.slice("attach_behavior_to_".length) : null;
      if (kind) t = typeof t === "string" ? forceKind(t, kind) : { ...(t as object), kind };
      const f = behFields(o);
      if (!f.script && (!f.on || !f.effects?.length)) return `${op} needs an event (on) and effects, or a script`;
      return { op: "create_behavior", label: (label ?? "Behaviour").slice(0, 160), target: t, ...f, ...(str(o.ref) ? { ref: str(o.ref) } : {}) };
    }
    case "update_behavior": case "update_behaviour": {
      const id = itemId(o);
      if (!id) return "update_behavior needs the behaviour's id";
      const e = edits(o.edits);
      if (Array.isArray(o.edits) && !e?.length) return "update_behavior edits are [{\"find\":\"text in the script\",\"replace\":\"its replacement\"}]";
      return { op: "update_behavior", id, ...behFields(o), ...(e?.length ? { edits: e } : {}), ...(target(o.newTarget) ? { target: target(o.newTarget) } : {}), ...(str(o.newLabel) ? { label: str(o.newLabel) } : {}) };
    }
    case "set_theme": case "update_theme": case "set_branding": {
      const patch: Record<string, unknown> = {};
      for (const k of ["colors", "typography", "layout", "buttons", "background", "appearance", "responsive", "logoUrl", "logoPosition", "headerHtml", "footerHtml"]) if (k in o) patch[k] = o[k];
      if (o.theme && typeof o.theme === "object") Object.assign(patch, o.theme as object);
      if (!Object.keys(patch).length) return "set_theme needs theme settings (colors, typography, layout, buttons, background, appearance, responsive, logoUrl, headerHtml, footerHtml)";
      return { op: "set_theme", patch, ...(label ? { label: label.slice(0, 120) } : {}) };
    }
    case "set_custom_html": case "set_question_html": {
      const target = str(o.target) ?? str(o.question);
      if (!target) return "set_custom_html needs a target question";
      if (o.html === null) return { op: "set_custom_html", target, html: null };
      if (typeof o.html !== "string") return "set_custom_html needs html (or null to remove it)";
      return { op: "set_custom_html", target, html: o.html.slice(0, 20000) };
    }
    case "set_default_value": case "set_default": case "default_value": case "prefill": case "set_prefill": {
      const target = str(o.target) ?? str(o.question);
      if (!target) return "set_default_value needs a target question";
      const v = "value" in o ? o.value : o.default ?? o.defaultValue;
      if (v === null) return { op: "set_default_value", target, value: null };
      if (typeof v === "number" || (typeof v === "string" && v.trim())) return { op: "set_default_value", target, value: typeof v === "string" ? v.trim().slice(0, 500) : v };
      if (Array.isArray(v) && v.length && v.every((x) => typeof x === "number" || typeof x === "string")) return { op: "set_default_value", target, value: v as (string | number)[] };
      return "set_default_value needs a value (a number, text, an option code or a list of codes — or null to remove it)";
    }
    default: return null;
  }
}
/** "Q5" as an option target is "Q5.options"; as a block target, "block:Q5" is wrong — the kind is the op's */
function forceKind(t: string, kind: string): unknown {
  if (kind === "question") return t;
  if (kind === "option") return /\.option(s|:)/i.test(t) ? t : `${t}.options`;
  if (kind === "block") return /^block:/i.test(t) ? t : `block:${t}`;
  if (kind === "page") return /^page:/i.test(t) ? t : `page:${t}`;
  return t;
}

/* ------------------------------------------------------------ applying */

export interface UxEnv { lookups: UxLookups; ids: (prefix: string) => string; now: string; refs: Map<string, string> }
export interface UxApplied { description: string; destructive?: string; warnings: string[]; touched: string[] }
class UxError extends Error {}
const fail = (m: string): never => { throw new UxError(m); };
const oneOf = <T extends string>(list: readonly T[], v: string | undefined, what: string, fallback?: T): T | undefined => {
  if (v == null) return fallback;
  const n = v.toLowerCase().replace(/\s+/g, "_");
  const hit = list.find((x) => x === n || x === n.replace(/_/g, "-") || x.replace(/-/g, "_") === n);
  return hit ?? fail(`“${v}” is not a ${what} (${list.join(", ")})`);
};

/** a behaviour's `when`, written as text, through the one expression parser (codes, nesting and all) */
function parseGuard(def: SurveyDefinition, text: string): Condition {
  const r = parseLogicExpression(def, text);
  if (r.errors.length || !r.condition) fail(`the behaviour's condition “${text}” does not parse: ${r.errors[0]?.message ?? "empty"}`);
  return r.condition!;
}

function resolveTarget(def: SurveyDefinition, raw: unknown, env: UxEnv): UxTarget {
  const t = resolveUxTarget(def, raw, env.lookups);
  return typeof t === "string" ? fail(t) : t;
}
function buildRules(raw: RawRule[]): UxRule[] {
  return raw.map((r) => ({
    declarations: uxDeclarations(r.declarations),
    ...(r.state ? { state: oneOf(UX_STATES, r.state === "checked" || r.state === "active" ? "selected" : r.state, "state")! } : {}),
    ...(r.media ? { media: oneOf(UX_MEDIA, r.media === "phone" ? "mobile" : r.media, "breakpoint")! } : {}),
    ...(r.whenClass ? { whenClass: uxToken(r.whenClass) } : {}),
    ...(r.selector ? { selector: r.selector } : {}),
  }));
}
function buildEffects(def: SurveyDefinition, raw: RawEffect[], env: UxEnv): UxEffect[] {
  return raw.map((e) => {
    const d = oneOf(UX_EFFECTS, e.do === "message" ? "show_message" : e.do === "expand" ? "animate" : EFFECT_ALIASES[e.do.toLowerCase()] ?? e.do, "effect")!;
    const popup = d === "show_popup";
    return {
      do: d,
      ...(e.target != null && e.target !== "self" ? { target: resolveTarget(def, e.target, env) } : {}),
      ...(e.className ? { className: uxToken(e.className) } : {}),
      ...(e.preset || e.do === "expand" ? { preset: oneOf(UX_PRESETS, e.preset ?? "expand", "preset")! } : {}),
      ...(e.durationMs ? { durationMs: Math.max(50, Math.min(10000, e.durationMs)) } : {}),
      ...(e.style ? { style: uxDeclarations(e.style) } : {}),
      ...(e.text ? { text: e.text.replace(/<[^>]*>/g, "").slice(0, 600) } : {}),
      ...(popup && e.title ? { title: e.title.replace(/<[^>]*>/g, "").slice(0, 120) } : {}),
      ...(popup && e.placement ? { placement: oneOf(UX_POPUP_PLACEMENTS, PLACEMENT_ALIASES[e.placement.toLowerCase()] ?? e.placement, "popup placement")! } : {}),
      ...(popup && e.dismiss ? { dismiss: oneOf(UX_POPUP_DISMISS, DISMISS_ALIASES[e.dismiss.toLowerCase()] ?? e.dismiss, "popup dismiss")! } : {}),
      ...(popup && e.autoMs ? { autoMs: Math.max(1000, Math.min(60000, e.autoMs)) } : {}),
    } as UxEffect;
  });
}
/* the words a model uses for the survey's popup */
const EFFECT_ALIASES: Record<string, string> = { popup: "show_popup", show_modal: "show_popup", modal: "show_popup", dialog: "show_popup", open_popup: "show_popup", alert: "show_popup", close_popup: "hide_popup", hide_modal: "hide_popup", close_modal: "hide_popup" };
const PLACEMENT_ALIASES: Record<string, string> = { centre: "center", centered: "center", centred: "center", middle: "center", modal: "center", anchor: "anchored", tooltip: "anchored", near: "anchored", next_to: "anchored", beside: "anchored", banner: "top", toast: "top", below: "inline", under: "inline", in_card: "inline" };
const DISMISS_ALIASES: Record<string, string> = { close: "button", close_button: "button", x: "button", manual: "button", timeout: "auto", timer: "auto", auto_close: "auto", never: "none", no: "none" };
function ensureUx(def: SurveyDefinition) {
  def.ux = def.ux ?? { styles: [], animations: [], behaviors: [] };
  def.ux.styles ??= []; def.ux.animations ??= []; def.ux.behaviors ??= [];
  return def.ux;
}
function find<T extends { id: string; label: string }>(list: T[], id: string, env: UxEnv, what: string): T {
  const viaRef = env.refs.get(id.toLowerCase());
  const r = id.toLowerCase();
  return list.find((x) => x.id === (viaRef ?? id)) ?? list.find((x) => x.id.toLowerCase() === r) ?? list.find((x) => x.label.trim().toLowerCase() === r) ?? fail(`there is no ${what} “${id}”`);
}
/**
 * A SCRIPT THAT RUNS ON AN EVENT. A behaviour is either effects on an event or a script (the script
 * listens for what it needs). Models naturally write both — {"on":"select_option","options":["1"],
 * "script":"…"} — and that used to be refused ("has both a script and effects"), costing a repair
 * call that failed the same way (2026-10-16 21:25, two paid calls, nothing applied). The intent is
 * unambiguous, so the engine writes it the supported way: the script inside the matching
 * rs.listen, filtered to the named options. What is stored is ordinary script — visible and
 * editable in Styles, animations & scripts — and runs through the same sandbox and gate.
 */
const SCRIPT_EVENT: Record<string, string | null> = {
  appear: null, page_enter: null, page: null, load: null,
  select_option: "select", select: "select", deselect_option: "deselect", deselect: "deselect",
  answer: "answer", change: "change", click: "click", hover: "hover",
  page_complete: "complete", block_complete: "complete", complete: "complete",
};
export function scriptOnEvent(script: string, on: string | undefined, options: string[] | undefined): { script: string } {
  const key = String(on ?? (options?.length ? "select_option" : "")).toLowerCase();
  if (!(key in SCRIPT_EVENT)) fail(`a script cannot run on “${on}” — events: ${Object.keys(SCRIPT_EVENT).join(", ")}`);
  const ev = SCRIPT_EVENT[key];
  if (!ev) return { script };
  const codes = (options ?? []).map((o) => String(o));
  if (codes.length && ev !== "select" && ev !== "deselect") fail(`options apply to select_option / deselect_option, not ${on}`);
  const filter = codes.length ? `  if (${JSON.stringify(codes)}.indexOf(String(e.option)) < 0) return;\n` : "";
  const body = script.split("\n").map((l) => `  ${l}`).join("\n");
  return { script: `rs.listen("${ev}", "self", function (e) {\n${filter}${body}\n});` };
}

function gate(def: SurveyDefinition, kind: "style" | "animation" | "behavior", item: UxStyle | UxAnimation | UxBehavior): string[] {
  // an action WRITES the item (Intelligent Mode, the theme assistant): the authoring checks apply
  const v = validateUxItem(def, kind, item, { authoring: true });
  // the action is already named by its label; the item's own "“label”: " prefix would say it twice
  const own = `“${item.label}”: `;
  if (v.errors.length) fail(v.errors.map((e) => (e.startsWith(own) ? e.slice(own.length) : e)).join("; "));
  return v.warnings;
}
const clampAnim = (a: UxAnimation): UxAnimation => ({
  ...a,
  durationMs: Math.max(50, Math.min(10000, a.durationMs ?? 400)),
  delayMs: Math.max(0, Math.min(10000, a.delayMs ?? 0)),
  staggerMs: Math.max(0, Math.min(3000, a.staggerMs ?? 0)),
  iterations: a.iterations === "infinite" ? "infinite" : Math.max(1, Math.min(20, a.iterations ?? 1)),
});

export function applyUxAction(def: SurveyDefinition, a: UxAction, env: UxEnv): UxApplied {
  if (a.op === "set_theme") {
    const r = applyThemePatch(def.branding, a.patch);
    if (!r.changes.length) fail(r.errors.length ? r.errors.join("; ") : "the theme is already like that");
    def.branding = r.branding;
    return { description: `Theme${a.label ? ` “${a.label}”` : ""}: ${r.changes.slice(0, 8).join("; ")}${r.changes.length > 8 ? ` and ${r.changes.length - 8} more` : ""}`, warnings: r.errors.map((e) => `Theme: ${e} — left as it was`), touched: [] };
  }
  if (a.op === "set_default_value") {
    const q = env.lookups.question(a.target) ?? fail(`there is no question “${a.target}”`);
    const settings = (q.settings ??= {} as typeof q.settings) as { defaultValue?: unknown };
    if (a.value === null) {
      if (settings.defaultValue === undefined) fail(`${q.code} has no default value`);
      const was = settings.defaultValue;
      delete settings.defaultValue;
      return { description: `Remove ${q.code}'s default value (${Array.isArray(was) ? was.join(", ") : String(was)})`, destructive: `Removes ${q.code}'s default value`, warnings: [], touched: [q.id] };
    }
    const probe = { ...q, settings: { ...q.settings, defaultValue: a.value } } as typeof q;
    const read = defaultAnswerFor(probe, { def, state: createResponseState(def) });
    if (read === null) {
      const model = effectiveResponseModel(q);
      fail(model === "single_choice" || model === "multiple_choice"
        ? `${q.code} has no option “${Array.isArray(a.value) ? a.value.join(", ") : a.value}” to start with — its options are ${describeOptions(q.options as OptionList)}`
        : model === "numeric" ? `${q.code} is numeric: its default must be a number, not “${a.value}”` : `${q.code} (${q.type.replace(/_/g, " ")}) cannot have a default value`);
    }
    const had = settings.defaultValue !== undefined;
    settings.defaultValue = read;
    const shown = Array.isArray(read) ? read.join(", ") : String(read);
    const warnings: string[] = [];
    const bound = (kind: string) => { const r = (q.validation ?? []).find((x) => x.kind === kind) as { value?: unknown } | undefined; const n = Number(r?.value); return r && Number.isFinite(n) ? n : null; };
    const lo = bound("min_value"), hi = bound("max_value");
    if (typeof read === "number" && ((lo !== null && read < lo) || (hi !== null && read > hi))) warnings.push(`${q.code}'s default ${read} is outside its validation range — the respondent will be asked to change it`);
    return { description: `${had ? "Change" : "Set"} ${q.code}'s default value to ${shown} — filled in when the question is first shown, only if it has no answer yet`, ...(had ? { destructive: `Replaces ${q.code}'s default value` } : {}), warnings, touched: [q.id] };
  }
  if (a.op === "set_custom_html") {
    const q = env.lookups.question(a.target) ?? fail(`there is no question “${a.target}”`);
    /*
     * ONE PLACE FOR A QUESTION'S CONTENT (October 2026 review). Only a
     * Custom Component still has a separate HTML template; on every other
     * question, HTML shown above the answers is part of its instruction —
     * the same rich content the Text Editor writes — so that is where this
     * goes, appended, and it is a change to what the respondent reads.
     */
    if (q.type !== "custom_component") {
      const html = a.html;
      if (html === null) return fail(`${q.code} has no separate custom HTML any more — its content is the question text and instruction; ask for a change to those`);
      if (/<\s*(script|iframe|object|embed|style|link|meta)\b|\bon[a-z]+\s*=|javascript:/i.test(html)) fail("custom HTML may not contain scripts, frames, styles, event handlers or javascript: links — behaviour goes in a behaviour, styling in a style");
      const had = !!q.instruction?.trim();
      q.instruction = `${q.instruction ?? ""}${html}`;
      return { description: `Add to ${q.code}'s instruction (${html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "markup"}) — HTML above the answers is part of the instruction`, warnings: had ? [`${q.code}'s existing instruction is kept; the HTML follows it`] : [], touched: [q.id] };
    }
    if (a.html === null) {
      if (!q.customHtml) fail(`${q.code} has no custom HTML`);
      delete (q as { customHtml?: string }).customHtml;
      return { description: `Remove ${q.code}'s custom HTML`, destructive: `Removes ${q.code}'s custom HTML`, warnings: [], touched: [q.id] };
    }
    if (/<\s*(script|iframe|object|embed|style|link|meta)\b|\bon[a-z]+\s*=|javascript:/i.test(a.html)) fail("custom HTML may not contain scripts, frames, styles, event handlers or javascript: links — behaviour goes in a behaviour, styling in a style");
    const had = !!q.customHtml;
    q.customHtml = a.html;
    return { description: `${had ? "Change" : "Add"} ${q.code}'s custom HTML (${a.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "markup"})`, ...(had ? { destructive: `Replaces ${q.code}'s custom HTML` } : {}), warnings: [], touched: [q.id] };
  }
  const ux = ensureUx(def);
  switch (a.op) {
    case "create_style": {
      const t = resolveTarget(def, a.target, env);
      const s: UxStyle = { id: env.ids("uxs"), label: a.label, target: t, rules: buildRules(a.rules), ...(a.css ? { css: a.css } : {}), ...(a.when ? { when: parseGuard(def, a.when) } : {}), createdAt: env.now };
      const warnings = gate(def, "style", s);
      ux.styles.push(s);
      if (a.ref) env.refs.set(a.ref.toLowerCase(), s.id);
      return { description: `Style “${s.label}” on ${describeUxTarget(def, t)}${s.rules.length ? ` (${s.rules.length} rule${s.rules.length === 1 ? "" : "s"}${s.rules.some((r) => r.media) ? `, ${[...new Set(s.rules.map((r) => r.media).filter(Boolean))].join("/")}` : ""})` : ""}${s.css ? " with scoped CSS" : ""}`, warnings, touched: t.questionId ? [t.questionId] : [] };
    }
    case "update_style": {
      const s = find(ux.styles, a.id, env, "style");
      const next: UxStyle = structuredClone(s);
      if (a.label) next.label = a.label;
      if (a.target) next.target = resolveTarget(def, a.target, env);
      if (a.rules) next.rules = buildRules(a.rules);
      for (const add of a.addRules ? buildRules(a.addRules) : []) {
        // "make it bigger": the rule for the same state and breakpoint is changed, not joined by a second one
        const same = next.rules.find((r) => (r.state ?? "") === (add.state ?? "") && (r.media ?? "") === (add.media ?? "") && (r.selector ?? "") === (add.selector ?? "") && (r.whenClass ?? "") === (add.whenClass ?? ""));
        if (same) Object.assign(same.declarations, add.declarations); else next.rules.push(add);
      }
      if (a.css === null) delete next.css; else if (typeof a.css === "string") next.css = a.css;
      if (a.when === null) delete next.when; else if (a.when) next.when = parseGuard(def, a.when);
      const warnings = gate(def, "style", next);
      ux.styles[ux.styles.indexOf(s)] = next;
      return { description: `Change style “${next.label}” on ${describeUxTarget(def, next.target)}`, warnings, touched: [] };
    }
    case "remove_style": {
      const s = find(ux.styles, a.id, env, "style");
      ux.styles.splice(ux.styles.indexOf(s), 1);
      const what = `style “${s.label}” (${describeUxTarget(def, s.target)})`;
      return { description: `Remove ${what}`, destructive: `Removes the ${what}`, warnings: [], touched: [] };
    }
    case "create_animation": {
      const t = resolveTarget(def, a.target, env);
      const an = clampAnim({ id: env.ids("uxa"), label: a.label, target: t, preset: oneOf(UX_PRESETS, a.preset, "preset")!, trigger: oneOf(UX_ANIMATION_TRIGGERS, a.trigger === "load" || a.trigger === "enter" ? "appear" : a.trigger === "selected" ? "select" : a.trigger, "trigger", "appear")!, durationMs: a.durationMs ?? 400, delayMs: a.delayMs ?? 0, easing: a.easing ?? "ease-out", staggerMs: a.staggerMs ?? 0, iterations: a.iterations ?? 1, ...(a.media ? { media: oneOf(UX_MEDIA, a.media, "breakpoint")! } : {}), ...(a.when ? { when: parseGuard(def, a.when) } : {}), createdAt: env.now } as UxAnimation);
      const warnings = gate(def, "animation", an);
      ux.animations.push(an);
      if (a.ref) env.refs.set(a.ref.toLowerCase(), an.id);
      return { description: `Animate ${describeUxTarget(def, t)}: ${an.preset} on ${an.trigger.replace("_", " ")}, ${an.durationMs}ms${an.staggerMs ? `, one at a time (${an.staggerMs}ms apart)` : ""}`, warnings, touched: t.questionId ? [t.questionId] : [] };
    }
    case "update_animation": {
      const an = find(ux.animations, a.id, env, "animation");
      const next = clampAnim({ ...structuredClone(an), ...(a.label ? { label: a.label } : {}), ...(a.target ? { target: resolveTarget(def, a.target, env) } : {}), ...(a.preset ? { preset: oneOf(UX_PRESETS, a.preset, "preset")! } : {}), ...(a.trigger ? { trigger: oneOf(UX_ANIMATION_TRIGGERS, a.trigger, "trigger")! } : {}), ...(a.durationMs != null ? { durationMs: a.durationMs } : {}), ...(a.delayMs != null ? { delayMs: a.delayMs } : {}), ...(a.easing ? { easing: a.easing } : {}), ...(a.staggerMs != null ? { staggerMs: a.staggerMs } : {}), ...(a.iterations != null ? { iterations: a.iterations } : {}), ...(a.media ? { media: oneOf(UX_MEDIA, a.media, "breakpoint")! } : {}) } as UxAnimation);
      if (a.when === null) delete next.when; else if (a.when) next.when = parseGuard(def, a.when);
      const warnings = gate(def, "animation", next);
      ux.animations[ux.animations.indexOf(an)] = next;
      const changes = [an.preset !== next.preset ? `${an.preset} → ${next.preset}` : "", an.durationMs !== next.durationMs ? `${an.durationMs}ms → ${next.durationMs}ms` : "", an.trigger !== next.trigger ? `on ${next.trigger}` : "", an.staggerMs !== next.staggerMs ? `stagger ${next.staggerMs}ms` : ""].filter(Boolean);
      return { description: `Change animation “${next.label}”${changes.length ? `: ${changes.join(", ")}` : ""}`, warnings, touched: [] };
    }
    case "remove_animation": {
      const an = find(ux.animations, a.id, env, "animation");
      ux.animations.splice(ux.animations.indexOf(an), 1);
      const what = `animation “${an.label}” (${describeUxTarget(def, an.target)})`;
      return { description: `Remove ${what}`, destructive: `Removes the ${what}`, warnings: [], touched: [] };
    }
    case "create_behavior": {
      /*
       * EFFECTS AND A SCRIPT IN ONE BEHAVIOUR (production intents, 2026-10-18): two things to do on one event —
       * the effects as one behaviour, the script (wrapped in the same event) as a second, instead of refusing
       * both ("has both a script and effects — use one"). The action is applied on a snapshot, so either both
       * are written or neither.
       */
      if (a.script && a.effects?.length && a.on) {
        const first = applyUxAction(def, { ...a, script: undefined }, env);
        /* the script's half: its own item on the same event, asked for together with the effects — so not refused as a second behaviour for that event (refuseDuplicate guards against an UNasked twin) */
        const t2 = resolveTarget(def, a.target, env);
        const b2: UxBehavior = { id: env.ids("uxb"), label: `${a.label} (script)`.slice(0, 160), target: t2, effects: [], script: scriptOnEvent(a.script, a.on, a.options).script, ...(a.once ? { once: true } : {}), ...(a.when ? { when: parseGuard(def, a.when) } : {}), createdAt: env.now };
        const w2 = gate(def, "behavior", b2);
        ux.behaviors.push(b2);
        return { description: `${first.description}; and its script as “${b2.label}” on the same event — ${SCRIPT_CHECKED}`, warnings: [...first.warnings, ...w2], touched: [...new Set([...first.touched, ...(t2.questionId ? [t2.questionId] : [])])] };
      }
      if (a.script && (a.on || a.options?.length) && !a.effects?.length) a = { ...a, ...scriptOnEvent(a.script, a.on, a.options), on: undefined, options: undefined };
      const t = resolveTarget(def, a.target, env);
      const b: UxBehavior = { id: env.ids("uxb"), label: a.label, target: t, ...(a.on ? { on: oneOf(UX_EVENTS, a.on === "select" ? "select_option" : a.on === "deselect" ? "deselect_option" : a.on === "complete" ? "page_complete" : a.on, "event")! } : {}), ...(a.options?.length ? { options: optionCodes(def, t, a.options) } : {}), effects: a.effects ? buildEffects(def, a.effects, env) : [], ...(a.script ? { script: a.script } : {}), ...(a.once ? { once: true } : {}), ...(a.when ? { when: parseGuard(def, a.when) } : {}), createdAt: env.now };
      const warnings = gate(def, "behavior", b);
      refuseDuplicate(def, ux.behaviors, b);
      ux.behaviors.push(b);
      if (a.ref) env.refs.set(a.ref.toLowerCase(), b.id);
      return { description: b.script ? `Behaviour “${b.label}” on ${describeUxTarget(def, t)}: a sandboxed script (${b.script.split("\n").length} line${b.script.split("\n").length === 1 ? "" : "s"}) — ${SCRIPT_CHECKED}` : `Behaviour “${b.label}”: when ${eventWords(b)} on ${describeUxTarget(def, t)} → ${b.effects.map((e) => effectWords(def, e)).join(", ")}${b.effects.some((e) => e.do === "show_popup") && UX_HOLDING_EVENTS.has(b.on ?? "") ? " — shown only while that holds, closed when it stops" : ""}`, warnings, touched: t.questionId ? [t.questionId] : [] };
    }
    case "update_behavior": {
      const b = find(ux.behaviors, a.id, env, "behaviour");
      const next: UxBehavior = structuredClone(b);
      if (a.label) next.label = a.label;
      if (a.target) next.target = resolveTarget(def, a.target, env);
      if (a.on) next.on = oneOf(UX_EVENTS, a.on, "event")!;
      if (a.options) next.options = optionCodes(def, next.target, a.options);
      if (a.effects) next.effects = buildEffects(def, a.effects, env);
      if (a.edits?.length) {
        if (a.script !== undefined) fail("give the whole script or edits to it, not both");
        next.script = applyScriptEdits(b, a.edits);
      }
      if (a.script !== undefined) {
        // "run this when option 1 is selected": the event and options wrap the script, as on create
        const ev = a.script && (a.on || a.options?.length) && !a.effects?.length ? scriptOnEvent(a.script, a.on, a.options) : null;
        next.script = ev ? ev.script : a.script;
        if (a.script) { delete next.on; delete next.options; next.effects = []; }
      }
      if (a.once !== undefined) next.once = a.once;
      if (a.when === null) delete next.when;
      else if (a.when) next.when = parseGuard(def, a.when);
      const warnings = gate(def, "behavior", next);
      refuseDuplicate(def, ux.behaviors, next);
      ux.behaviors[ux.behaviors.indexOf(b)] = next;
      const edited = a.edits?.length ? `: ${a.edits.length} edit${a.edits.length === 1 ? "" : "s"} to its script (${a.edits.map((x) => `“${oneLine(x.find, 30)}” → “${oneLine(x.replace, 30)}”`).join("; ")})` : "";
      return { description: `Change behaviour “${next.label}”${edited}${a.script || a.edits?.length ? ` — ${SCRIPT_CHECKED}` : ""}`, warnings, touched: [] };
    }
    case "remove_behavior": {
      const b = find(ux.behaviors, a.id, env, "behaviour");
      ux.behaviors.splice(ux.behaviors.indexOf(b), 1);
      const what = `behaviour “${b.label}” (${describeUxTarget(def, b.target)})`;
      return { description: `Remove ${what}`, destructive: `Removes the ${what}`, warnings: [], touched: [] };
    }
  }
}
const oneLine = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
/**
 * A SMALL CHANGE TO A STORED SCRIPT, without sending the script again: each edit's `find` must occur
 * exactly once in the script as it is (after the edits before it), so the change lands where it was
 * meant to or not at all. The result is validated like any script (the action's gate).
 */
export function applyScriptEdits(b: Pick<UxBehavior, "label" | "script">, list: ScriptEdit[]): string {
  if (!b.script) fail(`“${b.label}” has no script to edit — give its effects, or a "script"`);
  let out = b.script!;
  for (const [i, e] of list.entries()) {
    const at = `edit ${i + 1}`;
    if (!e.find) fail(`${at}: "find" is empty — give text that is in the script`);
    let n = out.split(e.find).length - 1;
    let span: [number, number] | null = n === 1 ? [out.indexOf(e.find), out.indexOf(e.find) + e.find.length] : null;
    if (n === 0 && e.find.trim()) {
      // the outline shows a short script on one line: the same text with its line breaks and indentation is the same text
      const re = new RegExp(e.find.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "g");
      const hits = [...out.matchAll(re)];
      n = hits.length;
      if (n === 1) span = [hits[0]!.index!, hits[0]!.index! + hits[0]![0].length];
    }
    if (n === 0) fail(`${at}: “${oneLine(e.find, 60)}” is not in the script of “${b.label}” — copy the text exactly as it is in the outline`);
    if (n > 1) fail(`${at}: “${oneLine(e.find, 60)}” occurs ${n} times in the script of “${b.label}” — include more of the text around it so it occurs once`);
    out = out.slice(0, span![0]) + e.replace + out.slice(span![1]);
  }
  if (out.length > 20000) fail("the edited script is longer than 20,000 characters");
  return out;
}
/**
 * ONE BEHAVIOUR PER THING. A second behaviour on the same target, event, options and condition would
 * run alongside the first — two popups, two messages, a script and an effect fighting over one element.
 * The model is told to change the one there is (the outline lists it with its id).
 */
function refuseDuplicate(def: SurveyDefinition, list: UxBehavior[], b: UxBehavior) {
  const key = uxBehaviorKey(b);
  if (!key) return;
  const twin = list.find((x) => x.id !== b.id && uxBehaviorKey(x) === key);
  if (twin) fail(`there is already a behaviour for this — ${twin.id} “${twin.label}” (when ${eventWords(twin.script ? { ...twin, ...uxTriggerOf(twin) } : twin)} on ${describeUxTarget(def, twin.target)}${twin.script ? ", a script" : ` → ${twin.effects.map((e) => effectWords(def, e)).join(", ")}`}). Update ${twin.id} instead of adding a second one (update_behavior {"id":"${twin.id}", …}${twin.script ? ' with "edits" or a new "script"' : ' with its "effects" plus the new one'}) — two behaviours on one event both run`);
}
const uxTriggerOf = (b: UxBehavior): Partial<UxBehavior> => { const t = uxBehaviorTrigger(b); return t ? { on: t.on as UxBehavior["on"], options: t.options } : {}; };
function optionCodes(def: SurveyDefinition, t: UxTarget, raw: string[]): string[] {
  const q = t.questionId ? def.questions.find((x) => x.id === t.questionId) : undefined;
  if (!q) return raw;
  return raw.map((r) => {
    const o = q.options?.find((x) => String(x.code) === r) ?? q.options?.find((x) => x.label.replace(/<[^>]+>/g, "").trim().toLowerCase() === r.toLowerCase()) ?? (r.toLowerCase() === "other" ? q.options?.find((x) => x.flags?.includes("other_specify")) : undefined);
    return o ? String(o.code) : fail(`${q.code} has no option “${r}”`);
  });
}
const eventWords = (b: UxBehavior) => ({ answer: "answered", change: "changed", select_option: `${b.options?.length ? `option ${b.options.join(" or ")} is` : "an option is"} selected`, deselect_option: "an option is unselected", page_complete: "every question on the page is answered", block_complete: "every question of the block on the page is answered", appear: "it appears", page_enter: "the page opens", click: "clicked", hover: "hovered" } as Record<string, string>)[b.on ?? ""] ?? String(b.on);
function effectWords(def: SurveyDefinition, e: UxEffect): string {
  const on = e.target ? ` ${describeUxTarget(def, e.target)}` : "";
  switch (e.do) {
    case "animate": return `animate${on} (${e.preset})`;
    case "add_class": return `mark${on} “${e.className}”`;
    case "remove_class": return `unmark${on} “${e.className}”`;
    case "toggle_class": return `toggle${on} “${e.className}”`;
    case "set_style": return `restyle${on}`;
    case "show_message": return `show “${(e.text ?? "").slice(0, 60)}”${on ? ` under${on}` : ""}`;
    case "hide_message": return "hide the message";
    case "scroll_into_view": return `scroll to${on}`;
    case "show_popup": {
      const where = e.placement === "anchored" ? `a popup next to${on || " it"}` : e.placement === "top" ? "a popup at the top of the screen" : e.placement === "inline" ? `a popup in${on || " the question's card"}` : "a centred popup";
      const close = e.dismiss === "auto" ? `, closes after ${Math.round((e.autoMs ?? 5000) / 1000)} s` : e.dismiss === "none" ? ", no close button" : ", with a close button";
      return `open ${where}${e.title ? ` “${e.title.slice(0, 40)}”:` : ""} “${(e.text ?? "").slice(0, 60)}”${close}`;
    }
    case "hide_popup": return "close the popup";
    default: return `${e.do.replace("_", " ")}${on}`;
  }
}
export { UxError };
