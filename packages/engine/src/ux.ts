import type { Condition, Question, SurveyDefinition, UxAnimation, UxBehavior, UxConfig, UxEffect, UxRule, UxStyle, UxTarget } from "@rescript/schema";
import { UX_BUTTONS, UX_EFFECTS, UX_EVENTS, UX_PARTS, UX_PRESETS, UX_STATES, UX_TARGET_KINDS, UX_MEDIA, UX_ANIMATION_TRIGGERS } from "@rescript/schema";
import { listBlocks, listPages } from "./blocks.js";
import { evaluateCondition } from "./evaluate.js";
import { createResponseState, type ResponseState } from "./state.js";

/**
 * THE UX LAYER — the engine half of the survey's styles, animations and
 * behaviours (schema `ux`).
 *
 *   resolveUxTarget        "Q5 options", {kind:"question", block:"Block 3"} →
 *                          a target by stable ids (question id, block id…)
 *   uxSelector             a target → a CSS selector that can only match this
 *                          survey's elements: [data-rs-ux="<survey id>"] …
 *   checkDeclarations      the one gate every CSS value goes through — here,
 *                          at compile time, and in the runtime's set_style
 *   scopeCss               an author's CSS text → the same text, every
 *                          selector under the target, dangerous at-rules and
 *                          values refused
 *   compileUxCss           the whole configuration → one stylesheet
 *   validateUxScript       a behaviour's script: syntax, the `rs` api only,
 *                          no loops, no reach outside the sandbox
 *   validateUx / reviewUx  errors that refuse a change; the warnings and
 *                          suggestions a review shows (conflicts, overrides
 *                          of the theme, responsive traps, dead targets)
 *   diffUx                 what a proposal adds, changes and removes
 *
 * The runtime half is the renderer's UxLayer, which reads the same
 * selectors, presets and gates from here, so what is validated is exactly
 * what runs.
 */

/* ------------------------------------------------------------ presets */

type Frame = Record<string, string | number>;
/** keyframes per preset, in Web Animations form (camelCase); CSS is generated from the same table */
export const UX_PRESET_FRAMES: Record<(typeof UX_PRESETS)[number], Frame[]> = {
  "fade-in": [{ opacity: 0 }, { opacity: 1 }],
  "fade-up": [{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }],
  "fade-down": [{ opacity: 0, transform: "translateY(-14px)" }, { opacity: 1, transform: "none" }],
  "slide-left": [{ opacity: 0, transform: "translateX(28px)" }, { opacity: 1, transform: "none" }],
  "slide-right": [{ opacity: 0, transform: "translateX(-28px)" }, { opacity: 1, transform: "none" }],
  "scale-in": [{ opacity: 0, transform: "scale(0.94)" }, { opacity: 1, transform: "none" }],
  pop: [{ transform: "scale(1)" }, { transform: "scale(1.04)", offset: 0.5 }, { transform: "scale(1)" }],
  pulse: [{ transform: "scale(1)" }, { transform: "scale(1.06)", offset: 0.5 }, { transform: "scale(1)" }],
  shake: [{ transform: "translateX(0)" }, { transform: "translateX(-6px)", offset: 0.25 }, { transform: "translateX(6px)", offset: 0.5 }, { transform: "translateX(-4px)", offset: 0.75 }, { transform: "translateX(0)" }],
  bounce: [{ transform: "translateY(0)" }, { transform: "translateY(-8px)", offset: 0.4 }, { transform: "translateY(0)", offset: 0.7 }, { transform: "translateY(-3px)", offset: 0.85 }, { transform: "translateY(0)" }],
  wiggle: [{ transform: "rotate(0)" }, { transform: "rotate(-3deg)", offset: 0.25 }, { transform: "rotate(3deg)", offset: 0.75 }, { transform: "rotate(0)" }],
  highlight: [{ backgroundColor: "rgba(255, 214, 102, 0.55)" }, { backgroundColor: "rgba(255, 214, 102, 0)" }],
  glow: [{ boxShadow: "0 0 0 0 rgba(59, 130, 246, 0.55)" }, { boxShadow: "0 0 0 10px rgba(59, 130, 246, 0)" }],
  expand: [{ opacity: 0, clipPath: "inset(0 0 100% 0)" }, { opacity: 1, clipPath: "inset(0 0 0 0)" }],
};
const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
/** "borderRadius" → "border-radius": how a model or a script may spell a property, and how it is stored */
export const uxProp = (s: string) => kebab(String(s).trim());
export const uxDeclarations = (d: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(d).map(([k, v]) => [uxProp(k), v]));
export const uxKeyframesName = (preset: string) => `rs-ux-${preset}`;
function keyframesCss(preset: (typeof UX_PRESETS)[number]): string {
  const frames = UX_PRESET_FRAMES[preset];
  const body = frames.map((f, i) => {
    const at = typeof f.offset === "number" ? `${Math.round(f.offset * 100)}%` : i === 0 ? "from" : "to";
    const decls = Object.entries(f).filter(([k]) => k !== "offset").map(([k, v]) => `${kebab(k)}:${v}`).join(";");
    return `${at}{${decls}}`;
  }).join("");
  return `@keyframes ${uxKeyframesName(preset)}{${body}}`;
}

/* ------------------------------------------------------------ targets */

/** the attribute every scoped selector starts from: the survey's own shell */
export const uxScope = (def: Pick<SurveyDefinition, "meta">) => `[data-rs-ux="${attr(def.meta.id)}"]`;
const attr = (s: string) => String(s).replace(/["\\\n\r]/g, (c) => `\\${c === "\n" ? "a " : c === "\r" ? "d " : c}`);

const PART_SELECTOR: Record<(typeof UX_PARTS)[number], string> = {
  card: "",
  title: " .rs-qtext",
  instruction: " .rs-qinstruction",
  options: " .rs-options",
  input: " :is(input:not([type=radio]):not([type=checkbox]),textarea,select)",
  other_text: " .rs-other-input",
  media: ' [data-rs-el="media"]',
  error: " .rs-errors",
  fill: " .rs-progress-fill",
  label: " .rs-progress-label",
};
const STATE_SELECTOR: Record<(typeof UX_STATES)[number], string> = {
  hover: ":hover",
  focus: ":focus-within",
  selected: ':is(.selected,[aria-checked="true"],[aria-selected="true"],:has(input:checked))',
  answered: "[data-rs-ux-answered]",
  disabled: ':is(.disabled,[aria-disabled="true"],:disabled)',
};
/** targets that persist across pages (the shell and its chrome): "appear" on them plays on every page */
export const UX_PERSISTENT_KINDS = new Set(["survey", "block", "page", "button", "progress", "navigation"]);

/**
 * A target as two parts: conditions on the survey shell itself (which block,
 * which page it is showing) and the element(s) inside it. Both the stylesheet
 * and the runtime use this, so they cannot disagree about what "Q5 options"
 * means.
 */
export function uxSelector(t: UxTarget, opts: { state?: (typeof UX_STATES)[number]; whenClass?: string; content?: boolean } = {}): { root: string; inner: string } {
  let root = "";
  if (t.blockId) root += `[data-rs-block="${attr(t.blockId)}"]`;
  if (t.pageId) root += `[data-rs-page="${attr(t.pageId)}"]`;
  const q = `[data-rs-el="question"]${t.questionId ? `[data-rs-id="${attr(t.questionId)}"]` : ""}`;
  const code = t.code != null && t.code !== "" ? `[data-rs-id="${attr(t.code)}"]` : "";
  let inner: string;
  switch (t.kind) {
    case "survey": case "block": case "page": inner = opts.content ? "#rs-questions" : ""; break;
    case "question": inner = q; break;
    case "option": inner = `${q} [data-rs-el="option"]${code}`; break;
    case "row": inner = `${q} [data-rs-el="row"]${code}`; break;
    case "column": inner = `${q} [data-rs-el="column"]${code}`; break;
    case "component": inner = q + (t.selector ? ` ${t.selector}` : ""); break;
    case "button": inner = t.button === "back" ? '[data-rs-button="back"]' : t.button === "submit" ? '[data-rs-button="submit"]' : t.button === "any" || !t.button ? ".rs-nav .rs-btn" : ':is([data-rs-button="next"],[data-rs-button="submit"])'; break;
    case "progress": inner = t.part === "fill" ? ".rs-progress-fill" : t.part === "label" ? ".rs-progress-label" : ".rs-progress-track"; break;
    case "navigation": inner = ".rs-nav"; break;
  }
  const state = (opts.state ? STATE_SELECTOR[opts.state] : "") + (opts.whenClass ? `[data-rs-ux-on~="${uxToken(opts.whenClass)}"]` : "");
  if (!inner) root += state; else inner += state;
  if (t.part && t.kind !== "progress" && PART_SELECTOR[t.part]) {
    if (inner) inner += PART_SELECTOR[t.part]; else inner = PART_SELECTOR[t.part].trim();
  }
  return { root, inner };
}
export function uxFullSelector(def: Pick<SurveyDefinition, "meta">, t: UxTarget, opts: Parameters<typeof uxSelector>[1] = {}): string {
  const s = uxSelector(t, opts);
  return `${uxScope(def)}${s.root}${s.inner ? ` ${s.inner}` : ""}`;
}
/**
 * Behaviour "classes" are tokens in their own attribute, `data-rs-ux-on`, not
 * entries in `class`: React owns `className` and rewrites it whenever an
 * option is selected, which would silently drop a class the runtime added. A
 * model's "active" cannot collide with the renderer's own classes either.
 */
export const uxToken = (name: string) => String(name).toLowerCase().replace(/^rs-ux-/, "").replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "on";
export const uxClassName = (name: string) => `rs-ux-${uxToken(name)}`;
export const uxTargetKey = (t: UxTarget) => [t.kind, t.questionId ?? "", t.blockId ?? "", t.pageId ?? "", t.code ?? "", t.button ?? "", t.part ?? "", t.selector ?? ""].join("|");

/** what a target is, in words: "Q5 options", "every question in “Brand”", "the Next button" */
export function describeUxTarget(def: SurveyDefinition, t: UxTarget): string {
  const q = t.questionId ? def.questions.find((x) => x.id === t.questionId) : undefined;
  const qn = q ? q.code : t.questionId ? "a removed question" : "";
  const blockTitle = t.blockId ? (listBlocks(def.flow as unknown[]).find((b) => b.id === t.blockId)?.title ?? t.blockId) : "";
  const pageN = t.pageId ? listPages(def.flow as unknown[]).findIndex((p) => p.node.id === t.pageId) + 1 : 0;
  const where = [blockTitle ? `in “${blockTitle}”` : "", t.pageId ? (pageN ? `on page ${pageN}` : "on a removed page") : ""].filter(Boolean).join(" ");
  const part = t.part && t.part !== "card" ? ` ${t.part.replace("_", " ")}` : "";
  let what: string;
  switch (t.kind) {
    case "survey": what = "the whole survey"; break;
    case "block": what = blockTitle ? `block “${blockTitle}”` : "the block"; return part ? `${what}${part}` : what;
    case "page": what = pageN ? `page ${pageN}` : "the page"; return what;
    case "question": what = qn ? `${qn}${part}` : `every question${part}`; break;
    case "option": what = qn ? (t.code ? `${qn} option ${optionLabel(q, t.code)}` : `${qn} options`) : "every option"; what += part; break;
    case "row": what = qn ? (t.code ? `${qn} row ${t.code}` : `${qn} rows`) : "every row"; break;
    case "column": what = qn ? (t.code ? `${qn} column ${t.code}` : `${qn} columns`) : "every column"; break;
    case "component": what = `${qn || "the"} component${t.selector ? ` ${t.selector}` : ""}`; break;
    case "button": what = t.button === "back" ? "the Back button" : t.button === "submit" ? "the Submit button" : t.button === "any" || !t.button ? "the navigation buttons" : "the Next button"; break;
    case "progress": what = t.part === "fill" ? "the progress bar fill" : "the progress indicator"; break;
    case "navigation": what = "the navigation bar"; break;
    default: what = "the survey";
  }
  return where && t.kind !== "survey" ? `${what} ${where}` : where ? `the survey ${where}` : what;
}
function optionLabel(q: Question | undefined, code: string): string {
  const o = q?.options?.find((x) => String(x.code) === code);
  return o ? `“${o.label.replace(/<[^>]+>/g, "").trim()}”` : code;
}

/** the model's (and the script api's) way of naming a target */
export interface UxTargetSpec {
  kind?: string;
  question?: string;
  block?: string;
  page?: string | number;
  option?: string | number;
  code?: string | number;
  row?: string | number;
  column?: string;
  button?: string;
  part?: string;
  selector?: string;
}
export interface UxLookups {
  question(ref: string): Question | undefined;
  block(ref: string): string | undefined;
}
export function defaultUxLookups(def: SurveyDefinition): UxLookups {
  return {
    question: (ref) => {
      const r = ref.trim().replace(/^\{\{|\}\}$/g, "").toLowerCase();
      return def.questions.find((q) => String(q.code).toLowerCase() === r) ?? def.questions.find((q) => q.variableName.toLowerCase() === r) ?? def.questions.find((q) => q.id.toLowerCase() === r);
    },
    block: (ref) => {
      const r = ref.trim().toLowerCase();
      const blocks = listBlocks(def.flow as unknown[]);
      const hit = blocks.find((b) => b.id.toLowerCase() === r) ?? blocks.find((b) => (b.title ?? "").trim().toLowerCase() === r);
      if (hit) return hit.id;
      const n = /^(?:block|section)?\s*(\d+)$/.exec(r);
      return n && blocks[Number(n[1]) - 1] ? blocks[Number(n[1]) - 1].id : undefined;
    },
  };
}

const PART_ALIASES: Record<string, (typeof UX_PARTS)[number]> = {
  card: "card", container: "card", title: "title", text: "title", question_text: "title", heading: "title", instruction: "instruction", instructions: "instruction", help: "instruction",
  options: "options", choices: "options", input: "input", field: "input", textbox: "input", other: "other_text", other_text: "other_text", other_input: "other_text",
  media: "media", image: "media", error: "error", errors: "error", fill: "fill", bar: "fill", label: "label",
};

/**
 * "Q5", "Q5.options", "Q5.option:3", "Q5.title", "block:Brand", "block:2.questions",
 * "page:3", "next", "back", "submit", "buttons", "progress", "progress.fill", "nav",
 * "survey", "questions", "options" — the one grammar the model's actions and the
 * script api share.
 */
export function parseUxTargetString(raw: string): UxTargetSpec | null {
  const s = raw.trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (["survey", "all", "shell", "page_all"].includes(low)) return { kind: "survey" };
  if (["next", "back", "submit"].includes(low)) return { kind: "button", button: low };
  if (["buttons", "button", "button:any"].includes(low)) return { kind: "button", button: "any" };
  if (/^button:(next|back|submit|any)$/.test(low)) return { kind: "button", button: low.slice(7) };
  if (["progress", "progress_bar", "progressbar"].includes(low)) return { kind: "progress" };
  if (/^progress\.(fill|bar|label)$/.test(low)) return { kind: "progress", part: low.endsWith("label") ? "label" : "fill" };
  if (["nav", "navigation"].includes(low)) return { kind: "navigation" };
  if (low === "questions") return { kind: "question" };
  if (low === "options") return { kind: "option" };
  const scoped = /^(block|page):(.+?)(?:\.(questions|options))?$/i.exec(s);
  if (scoped) {
    const which = scoped[1].toLowerCase(), ref = scoped[2].trim(), coll = scoped[3]?.toLowerCase();
    const kind = coll === "questions" ? "question" : coll === "options" ? "option" : which;
    return which === "block" ? { kind, block: ref } : { kind, page: ref };
  }
  const m = /^([^.\s:]+)(?:\.(.+))?$/.exec(s);
  if (!m) return null;
  const question = m[1];
  const rest = (m[2] ?? "").trim();
  if (!rest) return { kind: "question", question };
  const sub = /^(option|row|column):(.+)$/i.exec(rest);
  if (sub) return { kind: sub[1].toLowerCase(), question, code: sub[2].trim() };
  const lr = rest.toLowerCase();
  if (lr === "options") return { kind: "option", question };
  if (lr === "rows") return { kind: "row", question };
  if (lr === "columns") return { kind: "column", question };
  if (PART_ALIASES[lr]) return { kind: "question", question, part: PART_ALIASES[lr] };
  return null;
}

/** a spec (string or object) → a target by stable ids; a string reason when it does not resolve */
export function resolveUxTarget(def: SurveyDefinition, raw: unknown, look: UxLookups = defaultUxLookups(def)): UxTarget | string {
  const spec: UxTargetSpec | null = typeof raw === "string" ? parseUxTargetString(raw) : raw && typeof raw === "object" ? (raw as UxTargetSpec) : null;
  if (!spec) return `“${String(raw)}” is not a target (use e.g. "Q5", "Q5.options", "block:Brand", "page:3", "next", "progress")`;
  const kindRaw = String(spec.kind ?? (spec.option != null || spec.code != null ? "option" : spec.question ? "question" : spec.button ? "button" : spec.block ? "block" : spec.page != null ? "page" : "")).toLowerCase().replace(/s$/, "");
  const kindMap: Record<string, (typeof UX_TARGET_KINDS)[number]> = { survey: "survey", block: "block", page: "page", question: "question", option: "option", choice: "option", row: "row", column: "column", button: "button", progres: "progress", progress: "progress", navigation: "navigation", nav: "navigation", component: "component", custom_component: "component", statement: "row" };
  const kind = kindMap[kindRaw];
  if (!kind) return `“${String(spec.kind)}” is not a target kind (${UX_TARGET_KINDS.join(", ")})`;
  const t: UxTarget = { kind };
  if (spec.question != null && String(spec.question).trim()) {
    const q = look.question(String(spec.question));
    if (!q) return `there is no question “${spec.question}”`;
    t.questionId = q.id;
  }
  if (["option", "row", "column", "component"].includes(kind) && !t.questionId && kind === "component") return "a component target needs its question";
  if (spec.block != null && String(spec.block).trim()) {
    const b = look.block(String(spec.block));
    if (!b) return `there is no block “${spec.block}”`;
    t.blockId = b;
  }
  if (spec.page != null && String(spec.page).trim()) {
    const pages = listPages(def.flow as unknown[]);
    const p = String(spec.page).trim().toLowerCase();
    const hit = p === "last" ? pages.at(-1) : p === "first" ? pages[0] : /^\d+$/.test(p) ? pages[Number(p) - 1] : pages.find((x) => x.node.id.toLowerCase() === p || (x.node.title ?? "").trim().toLowerCase() === p);
    if (!hit) return `there is no page “${spec.page}” (the survey has ${pages.length})`;
    t.pageId = hit.node.id;
  }
  const code = spec.code ?? spec.option ?? spec.row ?? spec.column;
  if (code != null && String(code).trim() !== "") {
    const q = t.questionId ? def.questions.find((x) => x.id === t.questionId) : undefined;
    const c = String(code).trim();
    if (q && kind === "option") {
      const o = q.options?.find((x) => String(x.code) === c) ?? q.options?.find((x) => x.label.replace(/<[^>]+>/g, "").trim().toLowerCase() === c.toLowerCase()) ?? (c.toLowerCase() === "other" ? q.options?.find((x) => x.flags?.includes("other_specify")) : undefined);
      if (!o) return `${q.code} has no option “${c}”`;
      t.code = String(o.code);
    } else if (q && kind === "row") {
      const r = q.rows?.find((x) => String(x.code) === c) ?? q.rows?.find((x) => x.label.replace(/<[^>]+>/g, "").trim().toLowerCase() === c.toLowerCase());
      if (!r) return `${q.code} has no row “${c}”`;
      t.code = String(r.code);
    } else if (q && kind === "column") {
      const col = q.columns?.find((x) => x.id === c) ?? q.columns?.find((x) => x.label.toLowerCase() === c.toLowerCase());
      if (!col) return `${q.code} has no column “${c}”`;
      t.code = col.id;
    } else t.code = c;
  }
  if (spec.button != null) {
    const b = String(spec.button).toLowerCase();
    if (!(UX_BUTTONS as readonly string[]).includes(b)) return `“${spec.button}” is not a button (next, back, submit, any)`;
    t.button = b as UxTarget["button"];
  }
  if (spec.part != null && String(spec.part).trim()) {
    const p = PART_ALIASES[String(spec.part).toLowerCase()] ?? (UX_PARTS as readonly string[]).find((x) => x === String(spec.part).toLowerCase());
    if (!p) return `“${spec.part}” is not a part (${UX_PARTS.join(", ")})`;
    t.part = p as UxTarget["part"];
  }
  if (spec.selector != null && String(spec.selector).trim()) {
    const e = checkRelativeSelector(String(spec.selector));
    if (e) return e;
    t.selector = String(spec.selector).trim();
  }
  return t;
}

/* ------------------------------------------------------------ the CSS gate */

const BANNED_PROPS = new Set(["behavior", "-moz-binding", "binding", "-ms-behavior"]);
const PROP_RE = /^(--rs-ux-[a-z0-9-]{1,40}|-?[a-z]+(?:-[a-z0-9]+)*)$/;
export interface DeclCheck { ok: Record<string, string>; errors: string[]; warnings: string[] }

/**
 * THE ONE GATE for a CSS value, wherever it comes from — a structured rule,
 * a scoped stylesheet, or a runtime `set_style`. Nothing that can escape the
 * declaration ({ } ; <), run code (expression(), javascript:, bindings), or
 * load from anywhere but https / an inline image passes.
 */
export function checkDeclarations(decls: Record<string, unknown>, ctx: { target?: UxTarget; where?: string } = {}): DeclCheck {
  const ok: Record<string, string> = {}, errors: string[] = [], warnings: string[] = [];
  const at = ctx.where ? `${ctx.where}: ` : "";
  for (const [rawProp, rawVal] of Object.entries(decls ?? {})) {
    const prop = kebab(String(rawProp).trim()).replace(/^-(?=webkit|moz|ms|o-)/, "-");
    const value = String(rawVal ?? "").trim();
    if (!PROP_RE.test(prop)) { errors.push(`${at}“${rawProp}” is not a CSS property`); continue; }
    if (BANNED_PROPS.has(prop)) { errors.push(`${at}${prop} is not allowed`); continue; }
    const v = checkValue(value);
    if (v) { errors.push(`${at}${prop}: ${v}`); continue; }
    ok[prop] = value;
    const low = value.toLowerCase();
    if (/!important/.test(low)) warnings.push(`${at}${prop} uses !important, which overrides the theme and every later rule`);
    if (prop === "position" && /\bfixed\b/.test(low)) warnings.push(`${at}position: fixed can cover the survey's buttons on small screens`);
    if (prop === "z-index" && Number.parseInt(low, 10) > 1000) warnings.push(`${at}z-index ${value} can place this above the survey's own dialogs`);
    const t = ctx.target;
    const answerable = t && ["question", "option", "row", "column"].includes(t.kind) && (!t.part || t.part === "card" || t.part === "options");
    if (answerable && ((prop === "display" && /\bnone\b/.test(low)) || (prop === "visibility" && /hidden/.test(low)))) warnings.push(`${at}hiding ${t!.kind === "question" ? "a question" : `a ${t!.kind}`} with a style does not change the survey — it is still asked and validated; use display logic to remove it`);
    if (t && ["option", "button", "question"].includes(t.kind) && prop === "pointer-events" && /none/.test(low)) warnings.push(`${at}pointer-events: none stops respondents ${t.kind === "button" ? "moving on" : "answering"}`);
    const px = /^(?:width|min-width)$/.test(prop) ? /^(\d+)px$/.exec(low) : null;
    if (px && Number(px[1]) > 600) warnings.push(`${at}${prop}: ${value} is wider than a phone screen — use max-width or add a mobile rule`);
  }
  return { ok, errors, warnings };
}
function checkValue(v: string): string | null {
  if (!v) return "empty value";
  if (v.length > 400) return "value too long";
  // url() first: only https (no quotes, spaces, brackets or ; in it) or an inline raster image — then the rest of the value
  for (const m of v.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const u = m[2].trim();
    if (!/^https:\/\/[^\s"'(){}<>\\;]+$/i.test(u) && !/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(u)) return "url() may only load https: or an inline png/jpeg/gif/webp image";
  }
  const rest = v.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, "url()");
  if (/url\s*\((?!\))/i.test(rest)) return "malformed url()";
  if (/[{};<>]/.test(rest)) return "the value cannot contain { } ; < >";
  if (/\\/.test(rest)) return "escapes are not allowed in values";
  if (/expression\s*\(|javascript:|vbscript:|@import|-moz-binding/i.test(v)) return "not allowed";
  const opens = (rest.match(/\(/g) ?? []).length, closes = (rest.match(/\)/g) ?? []).length;
  if (opens !== closes) return "unbalanced parentheses";
  return null;
}

const GLOBAL_RE = /(^|[\s>+~,(])(html|body|:root|:host|head)(?=$|[\s>+~,.:#[)])/i;
/** a selector relative to a target: simple selectors and combinators only */
export function checkRelativeSelector(sel: string): string | null {
  const s = sel.trim();
  if (!s) return "empty selector";
  if (s.length > 200) return "selector too long";
  if (/[{};<\\@]/.test(s)) return `selector “${s}” contains a character that is not allowed`;
  if (GLOBAL_RE.test(s)) return `selector “${s}” reaches outside the survey (html, body, :root)`;
  if (!balanced(s)) return `selector “${s}” is not balanced`;
  return null;
}
function balanced(s: string): boolean {
  let p = 0, b = 0, q: string | null = null;
  for (const c of s) {
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "(") p++; else if (c === ")") { if (--p < 0) return false; }
    else if (c === "[") b++; else if (c === "]") { if (--b < 0) return false; }
  }
  return !q && p === 0 && b === 0;
}

/* ------------------------------------------------------------ scoped CSS text */

interface CssRule { type: "rule"; selector: string; decls: [string, string][] }
interface CssAt { type: "at"; name: string; prelude: string; children: CssNode[]; decls?: [string, string][] }
type CssNode = CssRule | CssAt;

function stripCssComments(css: string): string {
  let out = "", q: string | null = null;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (q) { out += c; if (c === q && css[i - 1] !== "\\") q = null; continue; }
    if (c === '"' || c === "'") { q = c; out += c; continue; }
    if (c === "/" && css[i + 1] === "*") { const end = css.indexOf("*/", i + 2); i = end < 0 ? css.length : end + 1; out += " "; continue; }
    out += c;
  }
  return out;
}
function parseCss(css: string): CssNode[] {
  const text = stripCssComments(css);
  let i = 0;
  const readUntil = (stops: string): string => {
    let out = "", q: string | null = null, depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (q) { out += c; if (c === q) q = null; i++; continue; }
      if (c === '"' || c === "'") { q = c; out += c; i++; continue; }
      if (c === "(") depth++; else if (c === ")") depth--;
      if (depth <= 0 && stops.includes(c)) break;
      out += c; i++;
    }
    return out;
  };
  const decls = (body: string): [string, string][] => {
    const out: [string, string][] = [];
    let cur = "", q: string | null = null, depth = 0;
    const flush = () => { const k = cur.indexOf(":"); if (k > 0) out.push([cur.slice(0, k).trim(), cur.slice(k + 1).trim()]); else if (cur.trim()) out.push([cur.trim(), ""]); cur = ""; };
    for (const c of body) {
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === "(") depth++; else if (c === ")") depth--;
      if (c === ";" && depth <= 0) { flush(); continue; }
      cur += c;
    }
    flush();
    return out;
  };
  const list = (): CssNode[] => {
    const nodes: CssNode[] = [];
    while (i < text.length) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (i >= text.length) break;
      if (text[i] === "}") { i++; break; }
      const head = readUntil("{;}").trim();
      if (text[i] === ";") { i++; if (head.startsWith("@")) nodes.push({ type: "at", name: head.slice(1).split(/\s/)[0].toLowerCase(), prelude: head, children: [] }); continue; }
      if (text[i] === "}") { i++; if (head) throw new Error(`“${head}” has no { … }`); break; }
      if (i >= text.length) { if (head) throw new Error(`“${head.slice(0, 40)}” is not closed`); break; }
      i++; // {
      if (head.startsWith("@")) {
        const name = head.slice(1).split(/[\s(]/)[0].toLowerCase();
        const prelude = head.slice(1 + name.length).trim();
        if (name === "keyframes" || name === "-webkit-keyframes") {
          const kids: CssNode[] = [];
          while (i < text.length) {
            while (i < text.length && /\s/.test(text[i])) i++;
            if (text[i] === "}") { i++; break; }
            const sel = readUntil("{}").trim();
            if (text[i] !== "{") throw new Error(`keyframe “${sel}” has no { … }`);
            i++;
            const body = readUntil("}");
            i++;
            kids.push({ type: "rule", selector: sel, decls: decls(body) });
          }
          nodes.push({ type: "at", name: "keyframes", prelude, children: kids });
        } else if (name === "media" || name === "supports") nodes.push({ type: "at", name, prelude, children: list() });
        else {
          // any other at-rule is refused whole: skip its block, balanced, without reading it as rules
          let depth = 1, q: string | null = null;
          while (i < text.length && depth > 0) { const c = text[i]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === "{") depth++; else if (c === "}") depth--; i++; }
          nodes.push({ type: "at", name, prelude, children: [] });
        }
      } else {
        const body = readUntil("}");
        if (text[i] !== "}") throw new Error(`the rule for “${head.slice(0, 40)}” is not closed`);
        i++;
        if (/{/.test(body)) throw new Error("nested rules are not supported — write each selector as its own rule");
        nodes.push({ type: "rule", selector: head, decls: decls(body) });
      }
    }
    return nodes;
  };
  return list();
}
function splitSelectors(sel: string): string[] {
  const out: string[] = [];
  let cur = "", depth = 0, q: string | null = null;
  for (const c of sel) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    if (c === "(" || c === "[") depth++; else if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export interface ScopedCss { css: string; errors: string[]; warnings: string[] }
/**
 * An author's CSS text, scoped to one target of one survey. Selectors are
 * relative to the target (`&` is the target itself); every one comes out
 * under the survey's own attribute. @media and @supports are kept, keyframes
 * are renamed into the style's own namespace (and references to them
 * rewritten), anything else — @import, @font-face, @page — is refused, as is
 * any selector that names html, body or :root.
 */
export function scopeCss(def: Pick<SurveyDefinition, "meta">, target: UxTarget, css: string, styleId: string): ScopedCss {
  const errors: string[] = [], warnings: string[] = [];
  let nodes: CssNode[];
  try { nodes = parseCss(css); } catch (e) { return { css: "", errors: [`the CSS does not parse: ${(e as Error).message}`], warnings }; }
  const base = uxFullSelector(def, target);
  const renamed = new Map<string, string>();
  const collect = (ns: CssNode[]) => { for (const n of ns) if (n.type === "at") { if (n.name === "keyframes") { const name = n.prelude.trim(); if (!/^[a-zA-Z_][\w-]*$/.test(name)) errors.push(`keyframes name “${name}” is not allowed`); else renamed.set(name, `rs-ux-k-${styleId.replace(/[^a-z0-9_-]/gi, "")}-${name}`); } else collect(n.children); } };
  collect(nodes);
  const rename = (v: string) => { let out = v; for (const [from, to] of renamed) out = out.replace(new RegExp(`(^|[\\s,])${from}(?=$|[\\s,])`, "g"), `$1${to}`); return out; };
  const decl = (pairs: [string, string][], where: string): string => {
    const obj: Record<string, string> = {};
    for (const [p, v] of pairs) {
      if (!v) { errors.push(`${where}: “${p}” has no value`); continue; }
      obj[p] = /^animation(-name)?$/i.test(p.trim()) ? rename(v) : v;
    }
    const c = checkDeclarations(obj, { target, where });
    errors.push(...c.errors); warnings.push(...c.warnings);
    return Object.entries(c.ok).map(([k, v]) => `${k}:${v}`).join(";");
  };
  const scopeSel = (sel: string): string | null => {
    const parts = splitSelectors(sel).map((s) => {
      if (/&\s*[+~]/.test(s)) { errors.push(`“${s}” styles elements beside the target, outside it`); return null; }
      const e = checkRelativeSelector(s.replace(/&/g, ".x"));
      if (e) { errors.push(e); return null; }
      const compound = (s.match(/[#.[:]/g) ?? []).length;
      if (compound > 6) warnings.push(`“${s}” is very specific — it will be hard to override`);
      if (/#[a-z]/i.test(s.replace(/\[[^\]]*\]/g, ""))) warnings.push(`“${s}” uses an id selector, which ties the style to generated markup`);
      return s.includes("&") ? s.replace(/&/g, base) : `${base} ${s}`;
    });
    return parts.some((p) => p === null) ? null : parts.join(",");
  };
  const mobileOnly = (prelude: string) => { const m = /^\(\s*max-width\s*:\s*(\d+)px\s*\)$/i.exec(prelude.trim()); return !!m && Number(m[1]) <= 700; };
  /* `hoisted`: rules that must live OUTSIDE the @media they were written in */
  const emit = (ns: CssNode[], inMedia: string | null): { inside: string; hoisted: string } => {
    let inside = "", hoisted = "";
    for (const n of ns) {
      if (n.type === "rule") {
        const sel = scopeSel(n.selector);
        if (!sel) continue;
        const body = decl(n.decls, n.selector);
        inside += `${sel}{${body}}`;
        // a phone-width @media also answers the runtime's device preview, which narrows a box, not the window
        if (inMedia && mobileOnly(inMedia)) hoisted += `${splitSelectors(sel).map((x) => `.rs-viewport.mobile > ${x}`).join(",")}{${body}}`;
        continue;
      }
      if (n.name === "media" || n.name === "supports") {
        if (!/^[a-z0-9\s():,.\-%/]+$/i.test(n.prelude) || !n.prelude.trim()) { errors.push(`@${n.name} “${n.prelude}” is not allowed`); continue; }
        const r = emit(n.children, n.name === "media" ? n.prelude : inMedia);
        inside += `@${n.name} ${n.prelude.trim()}{${r.inside}}`;
        hoisted += r.hoisted;
        continue;
      }
      if (n.name === "keyframes") {
        const name = renamed.get(n.prelude.trim());
        if (!name) continue;
        const frames = n.children.map((k) => {
          const ks = (k as CssRule).selector.trim();
          if (!/^(from|to|\d{1,3}(\.\d+)?%)(\s*,\s*(from|to|\d{1,3}(\.\d+)?%))*$/i.test(ks)) { errors.push(`keyframe “${ks}” is not from / to / a percentage`); return ""; }
          return `${ks}{${decl((k as CssRule).decls, `@keyframes ${n.prelude.trim()} ${ks}`)}}`;
        }).join("");
        inside += `@keyframes ${name}{${frames}}`;
        continue;
      }
      errors.push(`@${n.name} is not allowed in survey CSS (only @media, @supports and @keyframes)`);
    }
    return { inside, hoisted };
  };
  const r = emit(nodes, null);
  const out = r.inside + r.hoisted;
  return { css: errors.length ? "" : out, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

/* ------------------------------------------------------------ compile */

const MEDIA_QUERY: Record<(typeof UX_MEDIA)[number], string> = {
  mobile: "(max-width: 640px)",
  tablet: "(min-width: 641px) and (max-width: 1024px)",
  desktop: "(min-width: 1025px)",
  reduced_motion: "(prefers-reduced-motion: reduce)",
};
function withMedia(media: (typeof UX_MEDIA)[number] | undefined, selector: string, body: string): string {
  if (!media) return `${selector}{${body}}`;
  const list = selector.split(/,(?![^(]*\))/).map((s) => s.trim());
  if (media === "mobile" || media === "tablet") {
    // the runtime's device preview narrows a box, not the window: answer it as well as the real breakpoint
    return `@media ${MEDIA_QUERY[media]}{${selector}{${body}}}${list.map((s) => `.rs-viewport.${media} > ${s}`).join(",")}{${body}}`;
  }
  if (media === "desktop") return `@media ${MEDIA_QUERY.desktop}{${list.map((s) => `:not(.rs-viewport.mobile, .rs-viewport.tablet) > ${s}`).join(",")}{${body}}}`;
  return `@media ${MEDIA_QUERY[media]}{${selector}{${body}}}`;
}

export function compileStyle(def: Pick<SurveyDefinition, "meta">, style: UxStyle): ScopedCss {
  const errors: string[] = [], warnings: string[] = [];
  let css = "";
  for (const [i, r] of style.rules.entries()) {
    const where = `“${style.label}” rule ${i + 1}`;
    if (r.selector) { const e = checkRelativeSelector(r.selector); if (e) { errors.push(`${where}: ${e}`); continue; } }
    const c = checkDeclarations(r.declarations, { target: style.target, where });
    errors.push(...c.errors); warnings.push(...c.warnings);
    const body = Object.entries(c.ok).map(([k, v]) => `${k}:${v}`).join(";");
    if (!body) continue;
    const base = uxFullSelector(def, style.target, { state: r.state, whenClass: r.whenClass });
    const sel = r.selector ? splitSelectors(r.selector).map((x) => `${base} ${x}`).join(",") : base;
    css += withMedia(r.media, sel, body);
  }
  if (style.css) {
    const s = scopeCss(def, style.target, style.css, style.id);
    errors.push(...s.errors); warnings.push(...s.warnings);
    css += s.css;
  }
  return { css: errors.length ? "" : css, errors, warnings };
}

const TRIGGER_STATE: Partial<Record<(typeof UX_ANIMATION_TRIGGERS)[number], (typeof UX_STATES)[number]>> = { hover: "hover", focus: "focus", select: "selected", answer: "answered" };
/** the token the runtime puts on a persistent element (`data-rs-ux-play`) to (re)play an animation */
export const uxPlayToken = (animationId: string) => animationId.replace(/[^a-z0-9_-]/gi, "");
/** does the runtime have to play this animation (the element outlives the page), or does CSS play it on mount? */
export function uxAnimationNeedsRuntime(a: Pick<UxAnimation, "target" | "trigger">): boolean {
  return a.trigger === "page_enter" || (a.trigger === "appear" && UX_PERSISTENT_KINDS.has(a.target.kind));
}
export function compileAnimation(def: Pick<SurveyDefinition, "meta">, a: UxAnimation): string {
  const byRuntime = uxAnimationNeedsRuntime(a);
  const content = (a.trigger === "page_enter" || a.trigger === "appear") && ["survey", "block", "page"].includes(a.target.kind);
  let sel = uxFullSelector(def, a.target, { state: TRIGGER_STATE[a.trigger], content });
  if (byRuntime) sel = `${sel}[data-rs-ux-play~="${uxPlayToken(a.id)}"]`;
  const iter = a.iterations === "infinite" ? "infinite" : String(a.iterations ?? 1);
  const easing = /^[a-z-]+$|^cubic-bezier\([\d.,\s-]+\)$|^steps\(\d+(,\s*(start|end|jump-[a-z]+))?\)$/i.test(a.easing ?? "") ? a.easing : "ease-out";
  const delay = a.staggerMs ? `calc(var(--rs-ux-i, 0) * ${a.staggerMs}ms + ${a.delayMs ?? 0}ms)` : `${a.delayMs ?? 0}ms`;
  const body = `animation:${uxKeyframesName(a.preset)} ${a.durationMs ?? 400}ms ${easing} ${delay} ${iter} both`;
  // motion is for respondents who have not asked the system to reduce it
  return `@media (prefers-reduced-motion: no-preference){${withMedia(a.media, sel, body)}}`;
}

/**
 * the whole configuration as one stylesheet; items that do not validate are left out, never half-applied.
 *
 * `live`: the respondent's answers so far. A style or animation with a `when`
 * is included only while it holds; without `live` (the Studio's authoring
 * view) every item is included, so a conditional style can be seen and edited.
 */
export function compileUxCss(def: SurveyDefinition, live?: { state?: ResponseState | null; now?: Record<string, unknown> }): string {
  const ux = def.ux;
  if (!ux || (!ux.styles.length && !ux.animations.length && !ux.behaviors.length)) return "";
  const presets = new Set<(typeof UX_PRESETS)[number]>();
  for (const a of ux.animations) presets.add(a.preset);
  for (const b of ux.behaviors) for (const e of b.effects) if (e.preset) presets.add(e.preset);
  let css = [...presets].map(keyframesCss).join("");
  // what behaviours insert, styled once
  css += `${uxScope(def)} [data-rs-ux-hidden]{display:none!important}${uxScope(def)} .rs-ux-message{margin-top:10px;padding:10px 12px;border-radius:8px;background:rgba(59,130,246,.08);border-left:3px solid rgba(59,130,246,.6);font-size:.95em}`;
  const on = (x: { when?: Condition | null }) => !live || uxGuardHolds(def, x, live.state, live.now);
  for (const s of ux.styles) if (on(s)) css += compileStyle(def, s).css;
  for (const a of ux.animations) if (on(a)) css += compileAnimation(def, a);
  return css;
}

/* ------------------------------------------------------------ scripts */

/** what a sandboxed script can call — and nothing else */
export const UX_SCRIPT_API = ["listen", "getAnswer", "getQuestion", "getBlock", "getPage", "addClass", "removeClass", "toggleClass", "animate", "setStyle", "clearStyle", "show", "hide", "showMessage", "hideMessage", "scrollTo", "focus", "after", "log"] as const;
const TARGET_FIRST = new Set(["addClass", "removeClass", "toggleClass", "animate", "setStyle", "clearStyle", "show", "hide", "showMessage", "hideMessage", "scrollTo", "focus"]);
const FORBIDDEN_IDENTIFIERS = ["eval", "Function", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "import", "require", "localStorage", "sessionStorage", "indexedDB", "caches", "document", "window", "parent", "top", "opener", "frames", "globalThis", "self", "navigator", "location", "cookie", "postMessage", "Worker", "SharedWorker", "ServiceWorker", "constructor", "__proto__", "prototype", "Reflect", "Proxy", "setInterval"];
const LOOP_KEYWORDS = ["while", "for", "do"];
export const UX_SCRIPT_EVENTS = ["answer", "change", "select", "deselect", "click", "hover", "page", "complete"] as const;
/** the behaviour-event spellings a script may use for the same thing (the effects form says page_enter, select_option…) */
export const UX_SCRIPT_EVENT_ALIASES: Record<string, (typeof UX_SCRIPT_EVENTS)[number]> = { page_enter: "page", page_load: "page", load: "page", appear: "page", enter: "page", page_complete: "complete", select_option: "select", deselect_option: "deselect" };

/** code with every string, template and comment blanked (positions kept), and the string literals it had */
export function lexJs(code: string): { bare: string; strings: { value: string; start: number; end: number }[] } {
  let bare = "";
  const strings: { value: string; start: number; end: number }[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === "/" && code[i + 1] === "/") { const e = code.indexOf("\n", i); const end = e < 0 ? code.length : e; bare += " ".repeat(end - i); i = end; continue; }
    if (c === "/" && code[i + 1] === "*") { const e = code.indexOf("*/", i + 2); const end = e < 0 ? code.length : e + 2; bare += code.slice(i, end).replace(/[^\n]/g, " "); i = end; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1, v = "";
      while (j < code.length && code[j] !== c) { if (code[j] === "\\") { v += code[j + 1] ?? ""; j += 2; continue; } v += code[j]; j++; }
      strings.push({ value: v, start: i, end: Math.min(code.length, j + 1) });
      bare += `${c}${" ".repeat(Math.max(0, j - i - 1))}${j < code.length ? c : ""}`;
      i = j + 1;
      continue;
    }
    bare += c; i++;
  }
  return { bare, strings };
}

export interface ScriptCheck { errors: string[]; warnings: string[] }
/**
 * A behaviour's script, before it is stored: it must parse, call only the
 * `rs` api, name targets that exist, and do nothing that could hang or
 * escape the sandbox — no loops (the api's helpers cover lists), no network,
 * no storage, no reaching for the page. The sandbox would stop most of it
 * anyway; refusing it here says why, before anyone previews it.
 */
export function validateUxScript(code: string, def: SurveyDefinition): ScriptCheck {
  const errors: string[] = [], warnings: string[] = [];
  if (!code.trim()) return { errors: ["the script is empty"], warnings };
  if (code.length > 8000) errors.push("the script is longer than 8,000 characters");
  const { bare, strings } = lexJs(code);
  if (/`[^`]*\$\{/.test(code)) warnings.push("template literals with ${…} are allowed, but a target must be a plain string");
  for (const w of LOOP_KEYWORDS) if (new RegExp(`(^|[^\\w$.])${w}(?![\\w$])`).test(bare)) errors.push(`“${w}” loops are not allowed in survey scripts — use the api (targets like "Q5.options" address every option at once)`);
  for (const id of FORBIDDEN_IDENTIFIERS) if (new RegExp(`(^|[^\\w$])${id}(?![\\w$])`).test(bare)) errors.push(`${id} is not available to survey scripts — they can only use the rs api`);
  const usedApi = [...bare.matchAll(/\brs\s*\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => ({ name: m[1], at: m.index! + m[0].length }));
  // the commonest wrong turn: a script filling in an answer. Scripts change the look; a starting answer is a question setting
  const FILLS = new Set(["setAnswer", "setValue", "setDefault", "fill", "prefill", "answer"]);
  if (usedApi.some((u) => FILLS.has(u.name)) || /\.\s*value\s*=(?!=)|\bdispatchEvent\b/.test(bare)) errors.unshift("scripts cannot fill in or change answers — to start a question with an answer, set its default value (the set_default_value action, or Properties → Default value)");
  for (const u of usedApi) if (!(UX_SCRIPT_API as readonly string[]).includes(u.name) && !FILLS.has(u.name)) errors.push(`rs.${u.name} is not part of the survey api (${UX_SCRIPT_API.join(", ")})`);
  if (!usedApi.length) warnings.push("the script never calls the rs api, so it cannot change anything");
  const firstString = (at: number) => { const s = strings.find((x) => x.start >= at && /^\s*\(\s*$/.test(bare.slice(at, x.start))); return s?.value; };
  const seenListen = new Set<string>();
  for (const u of usedApi) {
    if (u.name === "listen") {
      const ev = firstString(u.at);
      if (ev != null && !(UX_SCRIPT_EVENTS as readonly string[]).includes(ev) && !UX_SCRIPT_EVENT_ALIASES[ev]) errors.push(`rs.listen("${ev}") — the events are ${UX_SCRIPT_EVENTS.join(", ")}${/page|load|enter|show|open/i.test(ev) ? " (“page” fires when the page opens)" : ""}`);
      const evLit = strings.find((x) => x.start >= u.at && /^\s*\(\s*$/.test(bare.slice(u.at, x.start)));
      const next = evLit ? strings[strings.indexOf(evLit) + 1] : undefined;
      const tgt = evLit && next && /^\s*,\s*$/.test(bare.slice(evLit.end, next.start)) ? next : undefined;
      const key = `${ev}|${tgt?.value ?? ""}`;
      if (seenListen.has(key)) warnings.push(`rs.listen("${ev}"${tgt ? `, "${tgt.value}"` : ""}) is registered twice — the handler would run twice`);
      seenListen.add(key);
      if (tgt && tgt.value !== "self") { const r = resolveUxTarget(def, tgt.value); if (typeof r === "string") errors.push(`rs.listen: ${r}`); }
    }
    if (TARGET_FIRST.has(u.name)) {
      const t = firstString(u.at);
      if (t != null && t !== "self") { const r = resolveUxTarget(def, t); if (typeof r === "string") errors.push(`rs.${u.name}("${t}"): ${r}`); }
    }
    if (u.name === "getAnswer" || u.name === "getQuestion") {
      const t = firstString(u.at);
      if (t != null && !defaultUxLookups(def).question(t)) errors.push(`rs.${u.name}("${t}"): there is no question “${t}”`);
    }
  }
  if (!errors.length) {
    try {
      // compiled, never called: a syntax error is reported here, not in a respondent's browser
      // eslint-disable-next-line no-new-func
      new Function("rs", code);
    } catch (e) { errors.push(`the script does not parse: ${(e as Error).message}`); }
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

/* ------------------------------------------------------------ validation + review */

export interface UxFinding { level: "critical" | "warning" | "suggestion"; message: string; itemId?: string; fix?: { op: "remove_style" | "remove_animation" | "remove_behavior"; id: string } }

function targetProblem(def: SurveyDefinition, t: UxTarget): string | null {
  if (t.questionId && !def.questions.some((q) => q.id === t.questionId)) return "its question no longer exists";
  if (t.blockId && !listBlocks(def.flow as unknown[]).some((b) => b.id === t.blockId)) return "its block no longer exists";
  if (t.pageId && !listPages(def.flow as unknown[]).some((p) => p.node.id === t.pageId)) return "its page no longer exists";
  if (t.code && t.questionId) {
    const q = def.questions.find((x) => x.id === t.questionId)!;
    if (t.kind === "option" && !q.options?.some((o) => String(o.code) === t.code)) return `${q.code} no longer has option ${t.code}`;
    if (t.kind === "row" && !q.rows?.some((o) => String(o.code) === t.code)) return `${q.code} no longer has row ${t.code}`;
  }
  return null;
}

/** errors refuse the item; warnings are shown with the proposal */
export function validateUxItem(def: SurveyDefinition, kind: "style" | "animation" | "behavior", item: UxStyle | UxAnimation | UxBehavior): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  const p = targetProblem(def, item.target);
  if (p) errors.push(`“${item.label}”: ${p}`);
  if (kind === "style") {
    const s = item as UxStyle;
    if (!s.rules.length && !s.css) errors.push(`“${s.label}” has no rules and no CSS`);
    const c = compileStyle(def, s);
    errors.push(...c.errors); warnings.push(...c.warnings);
  } else if (kind === "animation") {
    const a = item as UxAnimation;
    if (a.trigger === "select" && !["option", "row", "column"].includes(a.target.kind)) warnings.push(`“${a.label}” plays on select, which only options, rows and columns have`);
    if (a.iterations === "infinite") warnings.push(`“${a.label}” loops forever — respondents who find motion distracting will see it on every page (it is off for anyone whose system asks for reduced motion)`);
  } else {
    const b = item as UxBehavior;
    if (b.script) {
      if (b.on || b.effects.length) errors.push(`“${b.label}” has both a script and effects — use one`);
      const c = validateUxScript(b.script, def);
      errors.push(...c.errors.map((e) => `“${b.label}”: ${e}`)); warnings.push(...c.warnings.map((e) => `“${b.label}”: ${e}`));
    } else {
      if (!b.on) errors.push(`“${b.label}” needs an event (on) or a script`);
      if (!b.effects.length) errors.push(`“${b.label}” has no effects`);
      const needsQuestion = ["answer", "change", "select_option", "deselect_option"].includes(b.on ?? "");
      if (needsQuestion && !b.target.questionId) errors.push(`“${b.label}”: ${b.on} needs a question to listen to`);
      if (b.on === "block_complete" && !b.target.blockId && b.target.kind !== "block") errors.push(`“${b.label}”: block_complete needs a block`);
      if (b.options?.length) {
        if (!["select_option", "deselect_option"].includes(b.on ?? "")) warnings.push(`“${b.label}”: options only matter for select_option / deselect_option`);
        const q = def.questions.find((x) => x.id === b.target.questionId);
        for (const o of b.options) if (q && !q.options?.some((x) => String(x.code) === o)) errors.push(`“${b.label}”: ${q.code} has no option ${o}`);
      }
      for (const [i, e] of b.effects.entries()) {
        const at = `“${b.label}” effect ${i + 1} (${e.do})`;
        const t = e.target ?? b.target;
        const tp = e.target ? targetProblem(def, e.target) : null;
        if (tp) errors.push(`${at}: ${tp}`);
        if (["add_class", "remove_class", "toggle_class"].includes(e.do) && !e.className) errors.push(`${at} needs a className`);
        if (e.do === "animate" && !e.preset) errors.push(`${at} needs a preset (${UX_PRESETS.join(", ")})`);
        if (e.do === "show_message" && !e.text) errors.push(`${at} needs text`);
        if (e.do === "set_style") {
          if (!e.style || !Object.keys(e.style).length) errors.push(`${at} needs a style`);
          else { const c = checkDeclarations(e.style, { target: t, where: at }); errors.push(...c.errors); warnings.push(...c.warnings); }
        }
        if (e.do === "hide" && ["question", "option", "row"].includes(t.kind) && (!t.part || t.part === "card")) warnings.push(`${at}: hiding a ${t.kind} is a visual change only — it is still asked and validated; use display logic to remove it`);
      }
    }
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

/**
 * THE UX REVIEW: what is wrong or fragile in the survey's styling and
 * behaviour — items whose target is gone, two styles fighting over one
 * property, two animations on one element, the theme overridden, a
 * horizontal layout with no phone rule, the branding stylesheet reaching
 * outside the survey. Mechanical fixes are offered as actions.
 */
export function reviewUx(def: SurveyDefinition): UxFinding[] {
  const out: UxFinding[] = [];
  const ux = def.ux ?? { styles: [], animations: [], behaviors: [] };
  const all: [("style" | "animation" | "behavior"), UxStyle | UxAnimation | UxBehavior][] = [...ux.styles.map((s) => ["style", s] as ["style", UxStyle]), ...ux.animations.map((a) => ["animation", a] as ["animation", UxAnimation]), ...ux.behaviors.map((b) => ["behavior", b] as ["behavior", UxBehavior])];
  for (const [kind, item] of all) {
    const tp = targetProblem(def, item.target);
    if (tp) { out.push({ level: "warning", message: `${kind === "behavior" ? "Behaviour" : kind === "style" ? "Style" : "Animation"} “${item.label}” does nothing: ${tp}.`, itemId: item.id, fix: { op: `remove_${kind}` as "remove_style", id: item.id } }); continue; }
    const v = validateUxItem(def, kind, item);
    for (const e of v.errors) out.push({ level: "critical", message: e, itemId: item.id });
  }
  // conflicts: the same property on the same element in the same state, from two styles
  const seen = new Map<string, { style: UxStyle; value: string }>();
  for (const s of ux.styles) for (const r of s.rules) for (const [prop, value] of Object.entries(r.declarations)) {
    const key = `${uxTargetKey(s.target)}|${r.state ?? ""}|${r.media ?? ""}|${r.whenClass ?? ""}|${r.selector ?? ""}|${kebab(prop)}`;
    const prev = seen.get(key);
    if (prev && prev.style.id !== s.id && prev.value !== value) out.push({ level: "warning", message: `“${prev.style.label}” and “${s.label}” both set ${kebab(prop)} on ${describeUxTarget(def, s.target)} (${prev.value} vs ${value}) — the later one wins.`, itemId: s.id });
    seen.set(key, { style: s, value });
  }
  const anim = new Map<string, UxAnimation>();
  for (const a of ux.animations) {
    const key = `${uxTargetKey(a.target)}|${a.trigger}|${a.media ?? ""}`;
    const prev = anim.get(key);
    if (prev) out.push({ level: "warning", message: `“${prev.label}” and “${a.label}” both animate ${describeUxTarget(def, a.target)} on ${a.trigger} — only the later one plays. Change the first instead of adding a second.`, itemId: a.id, fix: { op: "remove_animation", id: prev.id } });
    anim.set(key, a);
  }
  // the theme, overridden
  for (const s of ux.styles) {
    const props = new Set(s.rules.flatMap((r) => Object.keys(r.declarations).map(kebab)));
    if (s.target.kind === "button" && ["background", "background-color", "color", "border-radius"].some((p) => props.has(p))) out.push({ level: "suggestion", message: `“${s.label}” overrides the theme's button style (Branding → buttons, primary colour) for ${describeUxTarget(def, s.target)}.`, itemId: s.id });
    if (s.target.kind === "survey" && props.has("font-family")) out.push({ level: "suggestion", message: `“${s.label}” replaces the theme's font (Branding → typography).`, itemId: s.id });
  }
  // responsive traps
  for (const q of def.questions) {
    const horiz = q.settings.optionOrientation === "horizontal" || (q.settings.columnsLayout ?? 0) > 2;
    const cardish = ux.styles.some((s) => s.target.questionId === q.id && s.target.kind === "option" && s.rules.some((r) => !r.media && Object.entries(r.declarations).some(([k, v]) => /^(width|min-width|flex-basis)$/.test(kebab(k)) || (kebab(k) === "display" && /inline|grid/.test(v)))));
    const hasMobile = ux.styles.some((s) => s.target.questionId === q.id && (s.rules.some((r) => r.media === "mobile") || /max-width/.test(s.css ?? "")));
    if (((horiz && (q.options?.length ?? 0) > 5) || cardish) && !hasMobile && ux.styles.some((s) => s.target.questionId === q.id)) out.push({ level: "suggestion", message: `${q.code} is styled with options side by side and has no phone rule — on a narrow screen they may overlap. Add a mobile rule that stacks them.` });
  }
  if (def.branding.customCss && GLOBAL_RE.test(def.branding.customCss.replace(/\/\*[\s\S]*?\*\//g, ""))) out.push({ level: "warning", message: "The survey's custom CSS (Branding) styles html, body or :root — it reaches outside the survey card and can change the page around it." });
  for (const q of def.questions) if (q.customCss && GLOBAL_RE.test(q.customCss)) out.push({ level: "warning", message: `${q.code}'s own custom CSS styles html, body or :root — it affects every question on the page, not just ${q.code}.` });
  return out;
}

/** what the copilot is shown for a question it is asked to style or diagnose */
export function uxContextFor(def: SurveyDefinition, questionId: string): string[] {
  const q = def.questions.find((x) => x.id === questionId);
  if (!q) return [];
  const ux = def.ux ?? { styles: [], animations: [], behaviors: [] };
  const lines: string[] = [];
  const s = q.settings;
  lines.push(`layout: ${s.optionOrientation === "horizontal" ? "horizontal" : s.columnsLayout ? `${s.columnsLayout} columns` : "auto"}${q.options?.length ? `, ${q.options.length} options` : ""}${q.options?.some((o) => o.flags?.includes("other_specify")) ? ", has Other" : ""}`);
  const mine = (t: UxTarget) => t.questionId === q.id || (!t.questionId && ["question", "option"].includes(t.kind));
  for (const st of ux.styles.filter((x) => mine(x.target))) lines.push(`style ${st.id} “${st.label}” on ${describeUxTarget(def, st.target)}: ${st.rules.map((r) => `${[r.state, r.media, r.selector].filter(Boolean).join(" ") || "base"} {${Object.entries(r.declarations).map(([k, v]) => `${k}:${v}`).join("; ")}}`).join(" · ")}${st.css ? ` + css ${st.css.length} chars` : ""}`);
  for (const a of ux.animations.filter((x) => mine(x.target))) lines.push(`animation ${a.id} “${a.label}” ${a.preset} on ${a.trigger}, ${a.durationMs}ms${a.staggerMs ? `, stagger ${a.staggerMs}ms` : ""}`);
  for (const b of ux.behaviors.filter((x) => mine(x.target) || x.effects.some((e) => e.target && mine(e.target)))) lines.push(`behaviour ${b.id} “${b.label}” ${b.script ? `script (${b.script.length} chars)` : `on ${b.on}${b.options?.length ? ` ${b.options.join(",")}` : ""} → ${b.effects.map((e) => e.do).join(", ")}`}`);
  if (q.customCss) lines.push(`its own custom CSS: ${q.customCss.slice(0, 300)}`);
  if (q.customJs) lines.push(`its own custom JS (${q.customJs.length} chars, unsandboxed — edited by hand only)`);
  return lines;
}

/* ------------------------------------------------------------ the diff */

export interface UxDiff { added: { kind: string; id: string; label: string; target: string }[]; changed: { kind: string; id: string; label: string; target: string }[]; removed: { kind: string; id: string; label: string; target: string }[]; empty: boolean }
export function diffUx(before: SurveyDefinition, after: SurveyDefinition): UxDiff {
  const b = before.ux ?? { styles: [], animations: [], behaviors: [] }, a = after.ux ?? { styles: [], animations: [], behaviors: [] };
  const added: UxDiff["added"] = [], changed: UxDiff["changed"] = [], removed: UxDiff["removed"] = [];
  const cmp = <T extends { id: string; label: string; target: UxTarget }>(kind: string, xs: T[], ys: T[]) => {
    const bx = new Map(xs.map((x) => [x.id, x]));
    const ay = new Map(ys.map((y) => [y.id, y]));
    for (const y of ys) { const x = bx.get(y.id); const row = { kind, id: y.id, label: y.label, target: describeUxTarget(after, y.target) }; if (!x) added.push(row); else if (JSON.stringify(x) !== JSON.stringify(y)) changed.push(row); }
    for (const x of xs) if (!ay.has(x.id)) removed.push({ kind, id: x.id, label: x.label, target: describeUxTarget(before, x.target) });
  };
  cmp("style", b.styles, a.styles); cmp("animation", b.animations, a.animations); cmp("behaviour", b.behaviors, a.behaviors);
  return { added, changed, removed, empty: !added.length && !changed.length && !removed.length };
}
/** the survey with its UX taken out — what "the structure did not change" is checked against */
export function withoutUx(def: SurveyDefinition): SurveyDefinition { const { ux: _ux, ...rest } = def; return rest as SurveyDefinition; }

export const UX_VOCABULARY = { kinds: UX_TARGET_KINDS, parts: UX_PARTS, states: UX_STATES, media: UX_MEDIA, presets: UX_PRESETS, triggers: UX_ANIMATION_TRIGGERS, events: UX_EVENTS, effects: UX_EFFECTS, buttons: UX_BUTTONS, api: UX_SCRIPT_API, scriptEvents: UX_SCRIPT_EVENTS };
export type { UxConfig, UxRule, UxEffect };

/* ------------------------------------------------------------ runtime triggers */

const isEmptyAnswer = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
/** the option codes an answer holds: a code, a list of codes, or a grid's row → code(s) */
export function uxSelectedCodes(v: unknown): Set<string> {
  const out = new Set<string>();
  const add = (x: unknown) => { if (x == null || x === "") return; if (Array.isArray(x)) x.forEach(add); else if (typeof x === "object") Object.values(x as object).forEach(add); else out.add(String(x)); };
  add(v);
  return out;
}
export const uxAnswered = (v: unknown) => !isEmptyAnswer(v);
const NOT_ANSWERABLE = new Set(["html", "calculated", "content"]);

export interface UxTriggerInput {
  def: SurveyDefinition;
  /** the answers on the page before this render (null: the page just opened) */
  prev: Record<string, unknown> | null;
  now: Record<string, unknown>;
  /** the questions on the page, in order */
  shown: string[];
  /** the block the page belongs to */
  blockId?: string;
  /** behaviours whose condition currently holds */
  active: ReadonlySet<string>;
  /** `once` behaviours that have already run */
  fired: ReadonlySet<string>;
  /** the response so far, for a behaviour's `when` (absent: only the page's answers are known) */
  state?: ResponseState | null;
}
export interface UxTriggerOutcome { fire: UxBehavior[]; hold: UxBehavior[]; release: UxBehavior[] }

/**
 * WHICH BEHAVIOURS RUN NOW — the pure half of the runtime, so it is tested
 * without a browser. Momentary events (answer, change, deselect, appear,
 * page_enter) FIRE; conditions (an option is selected, the page — or the
 * block's part of it — is complete) HOLD while true and are RELEASED — their effects reverted — when
 * they stop being true. click and hover are the DOM's, not this function's.
 */
/**
 * A behaviour's `when`: the ordinary survey condition, any nesting, read
 * against the answers as they are at the moment the event fires — the page's
 * live values over everything answered before. A behaviour with no `when`
 * always may fire, which is every behaviour that existed before the field did.
 */
export function uxGuardHolds(def: SurveyDefinition, b: { when?: Condition | null }, state?: ResponseState | null, now?: Record<string, unknown>): boolean {
  if (!b.when) return true;
  const base = state ?? createResponseState(def, { seed: 1, sessionId: "ux" });
  const merged: ResponseState = now ? { ...base, answers: { ...base.answers, ...(now as ResponseState["answers"]) } } : base;
  try { return evaluateCondition(b.when, { def, state: merged }); } catch { return false; }
}

export function evaluateUxTriggers(i: UxTriggerInput): UxTriggerOutcome {
  const out: UxTriggerOutcome = { fire: [], hold: [], release: [] };
  const opened = i.prev === null;
  const answerable = i.shown.filter((id) => { const q = i.def.questions.find((x) => x.id === id); return q && !NOT_ANSWERABLE.has(q.type) && !q.settings?.hidden; });
  const complete = answerable.length > 0 && answerable.every((id) => uxAnswered(i.now[id]));
  for (const b of i.def.ux?.behaviors ?? []) {
    if (b.script || !b.on) continue;
    if (b.once && i.fired.has(b.id)) continue;
    const qid = b.target.questionId;
    const onPage = !qid || i.shown.includes(qid);
    const changed = !!qid && !opened && JSON.stringify(i.prev?.[qid] ?? null) !== JSON.stringify(i.now[qid] ?? null);
    const codes = b.options?.length ? b.options : b.target.kind === "option" && b.target.code ? [b.target.code] : null;
    const hits = (v: unknown) => { const s = uxSelectedCodes(v); return codes ? codes.some((c) => s.has(c)) : s.size > 0; };
    // the guard: a held effect is held only while it ALSO holds; a one-shot fires only if it holds then
    const guard = uxGuardHolds(i.def, b, i.state, i.now);
    const hold = (cond: boolean) => { const on = cond && guard; if (on && !i.active.has(b.id)) out.hold.push(b); else if (!on && i.active.has(b.id)) out.release.push(b); };
    const fire = () => { if (guard) out.fire.push(b); };
    switch (b.on) {
      case "answer": if (changed && uxAnswered(i.now[qid!])) fire(); break;
      case "change": if (changed) fire(); break;
      case "select_option": hold(onPage && !!qid && hits(i.now[qid])); break;
      case "deselect_option": if (changed && hits(i.prev?.[qid!]) && !hits(i.now[qid!])) fire(); break;
      case "page_complete": hold(complete); break;
      case "block_complete": hold(complete && !!i.blockId && (b.target.blockId ?? "") === i.blockId); break;
      case "appear": case "page_enter": if (opened && onPage) fire(); break;
      default: break;
    }
  }
  return out;
}
