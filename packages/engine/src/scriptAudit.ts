import type { SurveyDefinition } from "@rescript/schema";
import { diffUx, lexJs, validateUxScript } from "./ux.js";
import { codeGate, gateReason } from "./codeGate.js";
import { sanitizeHtml, sanitizeStylesheet } from "./html.js";

/**
 * S1c item 3 (audit SE-29) — THE SCRIPT AUDIT LOG: who changed which piece of the survey's code, when, and what
 * the check said about it.
 *
 * The draft save writes `survey.modified` once per editing session (it fires every second while someone types);
 * that says nothing about code. `diffScriptItems(before, after)` compares the two definitions' CODE-BEARING items
 * and returns one change per item that changed, which the draft route turns into one `audit_logs` row each
 * (action `script.added | script.changed | script.removed | script.enabled | script.disabled`).
 *
 * The items (each a separate entry, id stable across saves):
 *
 *   ux_script           `def.ux.behaviors[].script` (Styles, animations & scripts) — found with `diffUx`, the
 *                       engine's UX differ, then narrowed to behaviours whose SCRIPT differs (a style-only edit of a
 *                       behaviour is not a code change); check: `validateUxScript`
 *   logic_script        `def.scripts[]` (Survey Settings → Scripts) — code and `enabled`; check: `codeGate(…, "logic")`
 *   component_js        a Custom Component's `customJs`; check: `codeGate(…, "component")`
 *   component_html      a Custom Component's `customHtml`; check: the HTML sanitiser (what it would strip)
 *   question_css        any question's `customCss`; check: the stylesheet sanitiser
 *   question_js         a non-component question's legacy `customJs` (moved into a UX behaviour on load)
 *   branding_header / branding_footer   `branding.headerHtml` / `footerHtml`; check: the HTML sanitiser
 *   branding_css        `branding.customCss`; check: the stylesheet sanitiser
 *   branding_js         legacy `branding.customJs` (moved into a UX behaviour on load)
 *
 * NEVER THE CODE: an entry carries a hash of the before and after code (`hash`, sha-256 from the server; FNV-1a
 * 64-bit by default here, for the sandbox and the tests), its length, and the check's verdict with at most three
 * reasons, each cut to 160 characters. One item that is both re-enabled and edited is ONE entry (enabled /
 * disabled, `codeChanged: true`).
 */

export const SCRIPT_AUDIT_ACTIONS = ["script.added", "script.changed", "script.removed", "script.enabled", "script.disabled"] as const;
export type ScriptAuditAction = (typeof SCRIPT_AUDIT_ACTIONS)[number];
export type ScriptItemKind =
  | "ux_script" | "logic_script" | "component_js" | "component_html" | "question_css" | "question_js"
  | "branding_header" | "branding_footer" | "branding_css" | "branding_js";

export interface ScriptVerdict {
  /** passed: nothing to say; sanitised: kept, parts are removed when shown; refused: will not run as written; legacy: an old field that is moved on load */
  status: "passed" | "sanitised" | "refused" | "legacy";
  reasons: string[];
}

export interface ScriptChange {
  action: ScriptAuditAction;
  kind: ScriptItemKind;
  itemId: string;
  name: string;
  beforeHash: string | null;
  afterHash: string | null;
  /** characters after the change (0 when removed) */
  length: number;
  /** the check on the code as it is now (null when removed) */
  verdict: ScriptVerdict | null;
  /** enabled/disabled entries: the code changed in the same save */
  codeChanged?: boolean;
}

/** FNV-1a 64-bit as two 32-bit lanes — a stable fingerprint, not a secret; the server passes sha-256 */
export function fnv64(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x050c5d1f;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h1 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

interface Item { kind: ScriptItemKind; id: string; name: string; code: string; enabled: boolean }

const REASON_MAX = 160;
const cut = (s: string) => (s.length > REASON_MAX ? `${s.slice(0, REASON_MAX - 1)}…` : s);

/** every code-bearing item of a definition (empty code = absent) */
export function scriptItems(def: SurveyDefinition | null | undefined): Item[] {
  if (!def) return [];
  const out: Item[] = [];
  for (const b of def.ux?.behaviors ?? []) if (b.script?.trim()) out.push({ kind: "ux_script", id: b.id, name: b.label || b.id, code: b.script, enabled: true });
  for (const s of def.scripts ?? []) out.push({ kind: "logic_script", id: s.id, name: s.name || s.id, code: s.code ?? "", enabled: s.enabled !== false });
  for (const q of def.questions ?? []) {
    const label = String(q.code ?? q.id);
    if (q.type === "custom_component") {
      if (q.customJs?.trim()) out.push({ kind: "component_js", id: `${q.id}:js`, name: `${label} component script`, code: q.customJs, enabled: true });
      if (q.customHtml?.trim()) out.push({ kind: "component_html", id: `${q.id}:html`, name: `${label} component HTML`, code: q.customHtml, enabled: true });
    } else if (q.customJs?.trim()) out.push({ kind: "question_js", id: `${q.id}:js`, name: `${label} custom JavaScript`, code: q.customJs, enabled: true });
    if (q.customCss?.trim()) out.push({ kind: "question_css", id: `${q.id}:css`, name: `${label} custom CSS`, code: q.customCss, enabled: true });
  }
  const br = def.branding;
  if (br?.headerHtml?.trim()) out.push({ kind: "branding_header", id: "branding:header", name: "Survey header HTML", code: br.headerHtml, enabled: true });
  if (br?.footerHtml?.trim()) out.push({ kind: "branding_footer", id: "branding:footer", name: "Survey footer HTML", code: br.footerHtml, enabled: true });
  if (br?.customCss?.trim()) out.push({ kind: "branding_css", id: "branding:css", name: "Survey custom CSS", code: br.customCss, enabled: true });
  if (br?.customJs?.trim()) out.push({ kind: "branding_js", id: "branding:js", name: "Survey custom JavaScript", code: br.customJs, enabled: true });
  return out;
}

/* what the HTML sanitiser removes for a reason (it also tidies style attributes, which is not worth a word) */
const RISKY_HTML = /<\s*(script|iframe|object|embed|form|base|meta|link)\b|\son[a-z]+\s*=|(javascript|vbscript)\s*:|expression\s*\(/i;

/** the check each kind of code meets, on the definition it lives in */
export function scriptVerdict(kind: ScriptItemKind, code: string, def: SurveyDefinition): ScriptVerdict {
  const refused = (errors: string[]): ScriptVerdict => ({ status: errors.length ? "refused" : "passed", reasons: errors.slice(0, 3).map(cut) });
  switch (kind) {
    case "ux_script": return refused(validateUxScript(code, def).errors);
    case "logic_script": { const v = codeGate(code, "logic"); return v.ok ? refused([]) : { status: "refused", reasons: [cut(gateReason(v))] }; }
    case "component_js": { const v = codeGate(code, "component"); return v.ok ? refused([]) : { status: "refused", reasons: [cut(gateReason(v))] }; }
    case "component_html": case "branding_header": case "branding_footer":
      return !RISKY_HTML.test(code) || sanitizeHtml(code) === code ? refused([]) : { status: "sanitised", reasons: ["parts the page does not allow (scripts, event handlers, unsafe links) are removed when it is shown"] };
    case "question_css": case "branding_css":
      return sanitizeStylesheet(code) === code ? refused([]) : { status: "sanitised", reasons: ["rules the page does not allow (imports, scripts in url(), expressions) are removed when it is shown"] };
    case "question_js": case "branding_js":
      return { status: "legacy", reasons: ["old Custom code field — moved into Styles, animations & scripts when the survey loads, and checked there"] };
  }
}

/**
 * One change per code-bearing item that changed between two definitions, in a stable order (UX scripts, logic
 * scripts, question items, branding). `hash` fingerprints code (the server passes sha-256).
 */
export function diffScriptItems(
  before: SurveyDefinition | null | undefined,
  after: SurveyDefinition,
  hash: (code: string) => string = fnv64,
): ScriptChange[] {
  const out: ScriptChange[] = [];
  const bItems = scriptItems(before), aItems = scriptItems(after);
  const key = (x: Item) => `${x.kind}\u0000${x.id}`;
  const bMap = new Map(bItems.map((x) => [key(x), x]));
  const aMap = new Map(aItems.map((x) => [key(x), x]));
  /*
   * UX behaviours: diffUx says which behaviours were added, changed or removed; only those are compared for code.
   * A behaviour that exists on both sides but gained or lost its script is added / removed here (the code is the item).
   */
  let uxTouched: Set<string> | null = null;
  if (before) {
    const d = diffUx(before, after);
    uxTouched = new Set([...d.added, ...d.changed, ...d.removed].filter((r) => r.kind === "behaviour").map((r) => r.id));
  }
  const change = (action: ScriptAuditAction, x: Item, b: Item | undefined, a: Item | undefined, extra: Partial<ScriptChange> = {}): ScriptChange => ({
    action, kind: x.kind, itemId: x.id, name: x.name,
    beforeHash: b ? hash(b.code) : null, afterHash: a ? hash(a.code) : null,
    length: a ? a.code.length : 0,
    verdict: a ? scriptVerdict(a.kind, a.code, after) : null,
    ...extra,
  });
  for (const a of aItems) {
    if (a.kind === "ux_script" && uxTouched && !uxTouched.has(a.id)) continue;
    const b = bMap.get(key(a));
    if (!b) { out.push(change("script.added", a, undefined, a)); continue; }
    const codeChanged = b.code !== a.code;
    if (b.enabled !== a.enabled) out.push(change(a.enabled ? "script.enabled" : "script.disabled", a, b, a, { codeChanged }));
    else if (codeChanged) out.push(change("script.changed", a, b, a));
  }
  for (const b of bItems) {
    if (aMap.has(key(b))) continue;
    out.push(change("script.removed", b, b, undefined));
  }
  return out;
}

/** the audit row's `detail` for one change (no code — hashes, length, verdict) */
export function scriptAuditDetail(c: ScriptChange): Record<string, unknown> {
  return {
    kind: c.kind, itemId: c.itemId, name: c.name,
    beforeHash: c.beforeHash, afterHash: c.afterHash, length: c.length,
    verdict: c.verdict?.status ?? null, reasons: c.verdict?.reasons ?? [],
    ...(c.codeChanged ? { codeChanged: true } : {}),
  };
}

const KIND_WORDS: Record<ScriptItemKind, string> = {
  ux_script: "Script", logic_script: "Logic script", component_js: "Component script", component_html: "Component HTML",
  question_css: "Custom CSS", question_js: "Custom JavaScript", branding_header: "Header HTML", branding_footer: "Footer HTML",
  branding_css: "Survey CSS", branding_js: "Survey JavaScript",
};
const VERB: Record<ScriptAuditAction, string> = {
  "script.added": "added", "script.changed": "changed", "script.removed": "removed", "script.enabled": "switched on", "script.disabled": "switched off",
};

/** "Script ‘Spend band’ changed by Ana — passed the check" (the Versions panel's line; `when` is rendered by the caller) */
export function scriptAuditSentence(action: string, detail: Record<string, unknown> | null | undefined, who: string): string {
  const d = detail ?? {};
  const kind = (KIND_WORDS as Record<string, string>)[String(d.kind)] ?? "Script";
  const verb = (VERB as Record<string, string>)[action] ?? action.replace(/^script\./, "");
  const name = String(d.name ?? d.itemId ?? "").slice(0, 120);
  const v = d.verdict;
  const reasons = Array.isArray(d.reasons) ? (d.reasons as unknown[]).map(String) : [];
  const check = v === "passed" ? " — passed the check"
    : v === "refused" ? ` — refused by the check${reasons[0] ? `: ${reasons[0]}` : ""}`
    : v === "sanitised" ? " — kept; the check removes parts when it is shown"
    : v === "legacy" ? " — old Custom code field, moved on load"
    : "";
  return `${kind} ‘${name}’ ${verb}${d.codeChanged ? " and edited" : ""} by ${who}${check}`;
}

/* ------------------------------------------------------------ legacy code that will not run (S1c item 4, D17) */

export interface LegacyRefusal {
  kind: "ux_script" | "logic_script" | "component_js";
  id: string;
  name: string;
  /** where it came from: "question Q3's Custom code", "Branding custom JavaScript", "an import", "a Custom Component" */
  origin: string;
  /** the check's reasons (at most 3, each ≤160 chars) */
  reasons: string[];
  /** the gate's short reason words, for a chip: window, $, setInterval … */
  names: string[];
  /** the code as stored — for "Show the code" in the editor and the model's rewrite; not logged anywhere */
  code: string;
}

const NAME_IN_REASON = /^"?([\w$.]+)"? is not available|^computed access on ([\w$]+)\[/;

/**
 * jQuery: the sandbox has none, so `$(…)` / `jQuery(…)` in moved legacy code throws on its first line. The UX check
 * does not refuse it (a script may declare its own `$`), so the legacy list says it — unless the code declares `$`.
 */
export function jqueryProblems(code: string): string[] {
  const { bare } = lexJs(code);
  const declares = /\b(var|let|const|function)\s+\$(?![\w$])|\(\s*\$\s*[,)]/.test(bare);
  const out: string[] = [];
  if (!declares && /(^|[^\w$.])\$\s*[(.]/.test(bare)) out.push("$ is not available — jQuery is not loaded in the sandbox, so the first $(…) call throws; use document / rs");
  if (/(^|[^\w$.])jQuery\s*[(.]/.test(bare)) out.push("jQuery is not available — it is not loaded in the sandbox; use document / rs");
  return out;
}

/**
 * D17 — CODE THE SURVEY CARRIES THAT WILL NOT RUN, with the reason, so it is never silently dead:
 *
 *   · Styles, animations & scripts behaviours MOVED from the old Custom code fields (`source` question_custom_js /
 *     branding_custom_js) whose script the UX check refuses (`window`, `$`, `setInterval`, `fetch`, …);
 *   · Scripts-panel logic scripts the code gate refuses (imports and pasted legacy code; the gate switches them off);
 *   · Custom Component code the component gate refuses (the respondent sees "This component could not run").
 *
 * A UX script the author wrote in the editor and that the check refuses is not listed here — the editor already
 * refuses to store it with the reason; this list is for code that arrived by migration or import.
 */
export function legacyScriptRefusals(def: SurveyDefinition): LegacyRefusal[] {
  const out: LegacyRefusal[] = [];
  const names = (errors: string[]) => [...new Set(errors.map((e) => { const m = NAME_IN_REASON.exec(e); return m ? (m[1] ?? m[2] ?? "") : ""; }).filter(Boolean))].slice(0, 6);
  for (const b of def.ux?.behaviors ?? []) {
    if (!b.script || (b.source !== "question_custom_js" && b.source !== "branding_custom_js")) continue;
    const errors = [...jqueryProblems(b.script), ...validateUxScript(b.script, def).errors];
    if (!errors.length) continue;
    const qid = b.target?.questionId;
    const q = qid ? def.questions.find((x) => x.id === qid) : undefined;
    out.push({ kind: "ux_script", id: b.id, name: b.label || b.id, origin: b.source === "branding_custom_js" ? "Branding custom JavaScript" : `question ${q?.code ?? qid ?? "?"}'s Custom code`, reasons: errors.slice(0, 3).map(cut), names: names(errors), code: b.script });
  }
  for (const s of def.scripts ?? []) {
    const v = codeGate(s.code ?? "", "logic");
    if (v.ok) continue;
    out.push({ kind: "logic_script", id: s.id, name: s.name || s.id, origin: "the Scripts panel (an import or pasted code)", reasons: v.errors.slice(0, 3).map(cut), names: names(v.errors), code: s.code ?? "" });
  }
  for (const q of def.questions ?? []) {
    if (q.type !== "custom_component" || !q.customJs?.trim()) continue;
    const v = codeGate(q.customJs, "component");
    if (v.ok) continue;
    out.push({ kind: "component_js", id: q.id, name: `${q.code} component script`, origin: "a Custom Component", reasons: v.errors.slice(0, 3).map(cut), names: names(v.errors), code: q.customJs });
  }
  return out;
}

/** the outline's lines for the model: what will not run and why, so a rewrite can be proposed when asked */
export function legacyRefusalOutline(def: SurveyDefinition, max = 12): string[] {
  const list = legacyScriptRefusals(def);
  if (!list.length) return [];
  const lines = [`Code that will NOT run (${list.length}; migrated or imported, refused by the script check — propose a rewrite with the rs api only when the researcher asks):`];
  for (const r of list.slice(0, max)) lines.push(`  ${r.kind === "ux_script" ? `behaviour ${r.id}` : r.kind === "logic_script" ? `logic script` : `component ${r.id}`} “${r.name.replace(/\s+/g, " ").slice(0, 80)}” from ${r.origin}: ${r.reasons.join("; ")}`);
  return lines;
}
