import type { SurveyDefinition, UxStyle } from "@rescript/schema";
import { codeGate, compileStyle, lexJs, sanitizeHtml, sanitizeStylesheet, validateUxScript } from "@rescript/engine";
import type { CodeDiagnostic, CodeKind, GateVerdict } from "./types.ts";

export type { CodeDiagnostic, GateVerdict } from "./types.ts";

/**
 * THE CODE EDITOR'S LINT MARKERS (S3a item 3) — the REAL gates, not an editor linter:
 *
 *   ux        the field's own `validateUxItem` (the caller passes it: the save refuses on its errors) — or
 *             `validateUxScript` alone (`gateFor("ux", def)`)
 *   logic     `codeGate(code, "logic")`            component  `codeGate(code, "component")`
 *   css       the stylesheet sanitiser: what `sanitizeStylesheet` would remove when the page shows it (a warning —
 *             these fields have never refused a save); a style's scoped CSS: `compileStyle` (errors / warnings)
 *   html      the HTML sanitiser: what `sanitizeHtml` would remove (a warning)
 *
 * THE GATES GIVE NO POSITIONS — they return sentences. `locateMessage` finds where a sentence points: the
 * `rs.method("arg")` it quotes, the name it says is not available (outside comments and strings), the quoted
 * selector or name, a loop keyword, `.click()`, `preventDefault`; a parse error goes where the editor's parser first
 * gave up (`syntaxErrorAt`, from the syntax tree). A sentence with nothing to find is attached to line 1 and says so
 * (`located: false`). For the sanitisers the diff is per line: the line whose text the sanitiser changes is marked.
 */

const LABEL = /^“[^”]*”:\s*/;

function lineRange(code: string, at: number): { from: number; to: number } {
  const s = code.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  const e = code.indexOf("\n", at);
  return { from: s, to: e < 0 ? code.length : e };
}
const firstLine = (code: string) => ({ from: 0, to: code.indexOf("\n") < 0 ? code.length : code.indexOf("\n") });
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** the first match of `re` in `text` (comments / strings already blanked when `text` is the lexer's `bare`) */
function find(text: string, re: RegExp, group = 0): { from: number; to: number } | null {
  const m = re.exec(text);
  if (!m) return null;
  const sub = m[group] ?? m[0];
  const from = m.index + (group ? m[0].indexOf(sub) : 0);
  return { from, to: from + sub.length };
}

/** where a gate's sentence points in the code, or null */
export function locateMessage(code: string, message: string): { from: number; to: number } | null {
  const msg = message.replace(LABEL, "");
  const { bare } = lexJs(code);
  /* rs.method("arg") … — the call, at its argument */
  const call = /^rs\.(\w+)\("([^"]*)"\)/.exec(msg) ?? /\brs\.(\w+)\("([^"]+)"/.exec(msg);
  if (call) {
    const hit = find(code, new RegExp(`\\brs\\s*\\.\\s*${esc(call[1]!)}\\s*\\(\\s*["'\`](${esc(call[2]!)})["'\`]`), 1)
      ?? find(code, new RegExp(`\\brs\\s*\\.\\s*${esc(call[1]!)}\\s*\\([^)]*["'\`](${esc(call[2]!)})["'\`]`), 1);
    if (hit) return hit;
  }
  /* rs.method is not part of the survey api / rs.method: … */
  const method = /^rs\.(\w+)\b/.exec(msg);
  if (method) { const hit = find(bare, new RegExp(`\\brs\\s*\\.\\s*${esc(method[1]!)}\\b`)); if (hit) return hit; }
  /* "x" is not available, not even as a string */
  const str = /^"([^"]+)" is not available/.exec(msg);
  if (str) { const hit = find(code, new RegExp(`["'\`]\\s*${esc(str[1]!)}\\s*["'\`]`)); if (hit) return hit; }
  /* name is not available … — as code, not in a comment or a string */
  const name = /^([A-Za-z_$][\w$]*) is not available/.exec(msg);
  if (name) { const hit = find(bare, new RegExp(`(?<![\\w$])${esc(name[1]!)}(?![\\w$])`)); if (hit) return hit; }
  /* computed access on x[…] / a computed property name built from strings */
  const comp = /^computed access on ([\w$]+)\[/.exec(msg);
  if (comp) { const hit = find(bare, new RegExp(`(?<![\\w$.])${esc(comp[1]!)}\\s*\\[`)); if (hit) return hit; }
  if (/computed property name built from strings/.test(msg)) { const hit = find(code, /\[\s*["'`][^\]]*\+/); if (hit) return hit; }
  /* loops, clicks, preventDefault, document.head, popups */
  const kw: [RegExp, RegExp][] = [
    [/do…while loop/, /\bdo\b/], [/while \(…\);/, /\bwhile\s*\([^)]*\)\s*;/],
    [/a (for|while) loop/, /\b(for|while)\s*\(/],
    [/preventDefault/, /\.\s*preventDefault\b/], [/\.click\(\)/, /\.\s*click\s*\(/],
    [/document\.head|cannot add a </, /document\s*\.\s*(head|createElement)\b/],
    [/rs\.popup/, /\brs\s*\.\s*popup\b/], [/builds its own popup/, /\bposition\s*[:=]/],
    [/calling itself on a timer/, /\b(setTimeout|rs\s*\.\s*after)\b/],
    [/fill in or change answers|to write an answer/, /\.\s*(value|checked|selectedIndex|selected)\s*=(?!=)|\bdispatchEvent\b|\brs\s*\.\s*(setValue|setDefault|fill|prefill|answer)\b/],
    [/neither the rs api nor the document/, /\S/],
  ];
  for (const [when, where] of kw) {
    if (!when.test(msg)) continue;
    const m = /\ba (for|while) loop/.exec(msg);
    const hit = find(bare, m ? new RegExp(`\\b${m[1]}\\s*\\(`) : where);
    if (hit) return hit;
  }
  /* a quoted name or selector in the sentence (“…” or "…") that is in the code */
  for (const q of msg.matchAll(/[“"]([^”"]{1,120})[”"]/g)) {
    const t = q[1]!.trim();
    if (!t) continue;
    const i = code.indexOf(t);
    if (i >= 0) return { from: i, to: i + t.length };
  }
  return null;
}

/** the gate's verdict as positioned diagnostics */
export function codeDiagnostics(code: string, verdict: GateVerdict, opts: { syntaxErrorAt?: number | null; kind?: CodeKind } = {}): CodeDiagnostic[] {
  const out: CodeDiagnostic[] = [];
  const add = (severity: "error" | "warning", message: string) => {
    let at = locateMessage(code, message);
    if (!at && /does not parse/.test(message) && opts.syntaxErrorAt != null) at = lineRange(code, Math.min(opts.syntaxErrorAt, code.length));
    if (!at && /line (\d+)/.test(message)) { const n = Number(/line (\d+)/.exec(message)![1]); const lines = code.split("\n"); if (n >= 1 && n <= lines.length) { const from = lines.slice(0, n - 1).join("\n").length + (n > 1 ? 1 : 0); at = { from, to: from + lines[n - 1]!.length }; } }
    const located = !!at;
    const r = at ?? firstLine(code);
    out.push({ from: r.from, to: Math.max(r.to, r.from), severity, message: located ? message : `${message} (the check gives no position — shown on line 1)`, located });
  };
  for (const e of verdict.errors) add("error", e);
  for (const w of verdict.warnings) add("warning", w);
  return out;
}

/** sanitiser diff, per line: which lines the sanitiser would change */
export function sanitizerDiagnostics(code: string, kind: "css" | "html"): CodeDiagnostic[] {
  const clean = (t: string) => (kind === "css" ? sanitizeStylesheet(t) : sanitizeHtml(t));
  if (!code.trim() || clean(code) === code) return [];
  const what = kind === "css"
    ? "removed when the page shows it — imports, scripts in url(), expression(), behavior / -moz-binding are not allowed"
    : "removed when the page shows it — scripts, event handlers (on…=) and javascript: links are not allowed";
  const out: CodeDiagnostic[] = [];
  let at = 0;
  for (const line of code.split("\n")) {
    if (line.trim() && clean(line) !== line) out.push({ from: at, to: at + line.length, severity: "warning", message: `This line: ${what}`, located: true });
    at += line.length + 1;
  }
  if (!out.length) {
    // the difference spans lines (a <script> … </script> block): the first character that differs
    const c = clean(code);
    let i = 0;
    while (i < code.length && code[i] === c[i]) i++;
    const r = lineRange(code, i);
    out.push({ ...r, severity: "warning", message: `From here: ${what}`, located: true });
  }
  return out;
}

/** the default gate for an editor kind (a field with a stricter gate of its own passes that instead) */
export function gateFor(kind: CodeKind, def?: SurveyDefinition): ((code: string) => GateVerdict) | undefined {
  switch (kind) {
    case "ux": return def ? (code) => (code.trim() ? validateUxScript(code, def) : { errors: [], warnings: [] }) : undefined;
    case "logic": return (code) => (code.trim() ? { errors: codeGate(code, "logic").errors, warnings: [] } : { errors: [], warnings: [] });
    case "component": return (code) => (code.trim() ? { errors: codeGate(code, "component").errors, warnings: [] } : { errors: [], warnings: [] });
    default: return undefined;
  }
}

/** a style's scoped CSS through the style compiler (the save refuses on its errors) */
export function scopedCssGate(def: Pick<SurveyDefinition, "meta">, style: UxStyle): (code: string) => GateVerdict {
  return (code) => { const c = compileStyle(def, { ...style, css: code || undefined }); return { errors: c.errors, warnings: c.warnings }; };
}

/** every marker for a field: its gate's, positioned, plus (CSS / HTML) the sanitiser's */
export function fieldDiagnostics(code: string, kind: CodeKind, gate: ((code: string) => GateVerdict) | undefined, syntaxErrorAt: number | null = null): CodeDiagnostic[] {
  const out = gate ? codeDiagnostics(code, gate(code), { syntaxErrorAt, kind }) : [];
  if (kind === "css" || kind === "html") out.push(...sanitizerDiagnostics(code, kind));
  return out;
}
