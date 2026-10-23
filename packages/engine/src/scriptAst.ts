/**
 * SURVEY SCRIPTS AS STRUCTURE, NOT TEXT (engine weakness #14, 2026-10-22).
 *
 * The behaviour checks used to read a script with regular expressions over its text. That missed what any
 * spelling change hides — `el["style"]["position"] = "fixed"`, `Object.assign(s, {zIndex: 99999})`,
 * `"posi" + "tion:fixed"`, a style object built first and assigned later — and compared two behaviours only when
 * their text was byte-identical. This module is a small, dependency-free tokenizer and reader for the JavaScript a
 * survey script is written in (the sandbox's `rs` api, the survey document through the DOM bridge):
 *
 *   tokenize            tokens with comments and whitespace gone, strings decoded (quote style no longer matters),
 *                       template literals with their text and the tokens of each `${…}`, regex literals told from `/`
 *   normalizedTokens    the stream with the script's own names renamed in order of declaration ($1, $2, …) —
 *                       never `rs`, a global, a property after `.`, or an object key — so renaming a variable or
 *                       re-quoting a string does not make a different script
 *   readScript          what the script does, read from the tokens: its `rs` calls with their literal arguments,
 *                       the event and options it listens for, the popups it opens, the elements it creates and
 *                       mounts, every style it sets (in any of the spellings the sandbox lets through) and its
 *                       attributes and class names
 *   similarity          how alike two scripts are (Dice coefficient over 4-token shingles of the normalized stream)
 *
 * It is not a full parser: a script that does not parse is the runtime gate's to refuse (`new Function`); here
 * an unbalanced bracket only makes the reading less complete, never throws.
 */

export type TokKind = "id" | "kw" | "num" | "str" | "tpl" | "re" | "punct";
export interface Tok { k: TokKind; v: string; /** a template literal's `${…}` expressions, tokenized */ parts?: Tok[][]; pos: number }

const KEYWORDS = new Set(["var", "let", "const", "function", "return", "if", "else", "for", "while", "do", "break", "continue", "new", "delete", "typeof", "instanceof", "in", "of", "this", "null", "undefined", "true", "false", "switch", "case", "default", "throw", "try", "catch", "finally", "class", "extends", "super", "void", "yield", "async", "await", "import", "export"]);
const PUNCT = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>", "&&=", "||=", "??="].sort((a, b) => b.length - a.length);
const ID_START = /[A-Za-z_$À-￿]/, ID_PART = /[\w$À-￿]/;
/** after these a `/` starts a regex literal, not a division */
const REGEX_AFTER_PUNCT = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "=>", "==", "===", "!=", "!==", "&&", "||", "??", "+=", "-=", "*=", "/=", "%=", "<=", ">=", "return"]);

function readString(src: string, i: number, q: string): { value: string; end: number } {
  let v = "", j = i + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === "\\") {
      const c = src[j + 1] ?? "";
      const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };
      if (c === "u" && src[j + 2] === "{") { const e = src.indexOf("}", j); v += String.fromCodePoint(parseInt(src.slice(j + 3, e), 16) || 0x3f); j = e + 1; continue; }
      if (c === "u") { v += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16) || 0x3f); j += 6; continue; }
      if (c === "x") { v += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16) || 0x3f); j += 4; continue; }
      if (c === "\n") { j += 2; continue; }
      v += map[c] ?? c; j += 2; continue;
    }
    if (src[j] === "\n" && q !== "`") break;
    v += src[j]; j++;
  }
  return { value: v, end: Math.min(src.length, j + 1) };
}

/** the script's tokens — comments and whitespace dropped, strings decoded */
export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const prevSignificant = () => out[out.length - 1];
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); i = e < 0 ? src.length : e; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'") { const r = readString(src, i, c); out.push({ k: "str", v: r.value, pos: i }); i = r.end; continue; }
    if (c === "`") {
      /* a template literal: its text (with each ${…} as "${}") and the tokens of each expression */
      let j = i + 1, text = "";
      const parts: Tok[][] = [];
      while (j < src.length && src[j] !== "`") {
        if (src[j] === "\\") { text += src[j + 1] ?? ""; j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") {
          let depth = 1, k = j + 2;
          while (k < src.length && depth) { if (src[k] === "{") depth++; else if (src[k] === "}") depth--; if (depth) k++; }
          parts.push(tokenize(src.slice(j + 2, k)));
          text += "${}"; j = k + 1; continue;
        }
        text += src[j]; j++;
      }
      out.push({ k: "tpl", v: text, parts, pos: i }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)n?/.exec(src.slice(i));
      const raw = m ? m[0] : c;
      out.push({ k: "num", v: String(Number(raw.replace(/_/g, "").replace(/n$/, "")) || raw), pos: i }); i += raw.length; continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1; while (j < src.length && ID_PART.test(src[j]!)) j++;
      const w = src.slice(i, j);
      out.push({ k: KEYWORDS.has(w) ? "kw" : "id", v: w, pos: i }); i = j; continue;
    }
    if (c === "/") {
      const p = prevSignificant();
      const regex = !p || (p.k === "punct" && REGEX_AFTER_PUNCT.has(p.v)) || (p.k === "kw" && ["return", "typeof", "case", "in", "of", "new", "delete", "void", "throw"].includes(p.v));
      if (regex) {
        let j = i + 1, cls = false;
        while (j < src.length && (src[j] !== "/" || cls) && src[j] !== "\n") { if (src[j] === "\\") j++; else if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; j++; }
        j++; while (j < src.length && /[a-z]/i.test(src[j]!)) j++;
        out.push({ k: "re", v: src.slice(i, j), pos: i }); i = j; continue;
      }
    }
    const p = PUNCT.find((x) => src.startsWith(x, i));
    if (p) { out.push({ k: "punct", v: p, pos: i }); i += p.length; continue; }
    out.push({ k: "punct", v: c, pos: i }); i++;
  }
  return out;
}

/* ------------------------------------------------------------ normalised stream */

/** names a script may use that are not its own (never renamed) */
const GLOBALS = new Set(["rs", "document", "window", "globalThis", "self", "console", "Math", "JSON", "Object", "Array", "String", "Number", "Boolean", "Date", "RegExp", "Error", "Map", "Set", "WeakMap", "Promise", "parseInt", "parseFloat", "isNaN", "isFinite", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "MutationObserver", "Event", "CustomEvent", "navigator", "location", "arguments"]);

/** the names this script declares (var / let / const / function / parameters / catch), in order of first declaration */
function declaredNames(t: Tok[]): string[] {
  const out: string[] = [];
  const add = (v: string) => { if (!GLOBALS.has(v) && !out.includes(v)) out.push(v); };
  for (let i = 0; i < t.length; i++) {
    const x = t[i]!;
    if (x.k === "kw" && (x.v === "var" || x.v === "let" || x.v === "const")) {
      /* `const a = …, b = …` and simple destructuring `const { a, b } = …` */
      let j = i + 1, depth = 0;
      for (; j < t.length; j++) {
        const y = t[j]!;
        if (y.k === "punct" && (y.v === "{" || y.v === "[" || y.v === "(")) depth++;
        else if (y.k === "punct" && (y.v === "}" || y.v === "]" || y.v === ")")) { if (!depth) break; depth--; }
        else if (y.k === "punct" && y.v === ";" && !depth) break;
        if (y.k === "id" && (t[j - 1]?.v === "," || t[j - 1] === x || t[j - 1]?.v === "{" || t[j - 1]?.v === "[") && t[j + 1]?.v !== ":") add(y.v);
        if (y.k === "punct" && y.v === "=" && !depth) {
          /* skip the initialiser to the next top-level comma */
          let d = 0; j++;
          for (; j < t.length; j++) { const z = t[j]!; if (z.k === "punct" && "([{".includes(z.v)) d++; else if (z.k === "punct" && ")]}".includes(z.v)) { if (!d) break; d--; } else if (z.k === "punct" && (z.v === "," || z.v === ";") && !d) break; }
          if (t[j]?.v !== ",") break;
        }
      }
    }
    if (x.k === "kw" && x.v === "function") {
      let j = i + 1;
      if (t[j]?.k === "id") { add(t[j]!.v); j++; }
      if (t[j]?.v === "(") for (j++; j < t.length && t[j]!.v !== ")"; j++) if (t[j]!.k === "id" && t[j + 1]?.v !== ":" ) add(t[j]!.v);
    }
    if (x.k === "kw" && x.v === "catch" && t[i + 1]?.v === "(" && t[i + 2]?.k === "id") add(t[i + 2]!.v);
    if (x.k === "punct" && x.v === "=>") {
      if (t[i - 1]?.k === "id") add(t[i - 1]!.v);
      else if (t[i - 1]?.v === ")") { let j = i - 2, d = 0; for (; j >= 0; j--) { const y = t[j]!; if (y.v === ")") d++; else if (y.v === "(") { if (!d) break; d--; } } for (let k = j + 1; k < i - 1; k++) if (t[k]!.k === "id") add(t[k]!.v); }
    }
  }
  return out;
}

/**
 * The script as a stream of comparable words: comments, whitespace and quote style gone, its own names renamed
 * ($1, $2 … in order of declaration), property names and object keys kept (they are the api), numbers canonical.
 */
export function normalizedTokens(code: string): string[] {
  const t = tokenize(code);
  const names = declaredNames(t);
  const rename = new Map(names.map((n, i) => [n, `$${i + 1}`]));
  const out: string[] = [];
  const push = (toks: Tok[]) => {
    for (let i = 0; i < toks.length; i++) {
      const x = toks[i]!;
      const prev = toks[i - 1];
      const isProp = prev?.k === "punct" && (prev.v === "." || prev.v === "?.");
      const isKey = toks[i + 1]?.v === ":" && (prev?.v === "{" || prev?.v === ",");
      if (x.k === "id") out.push(!isProp && !isKey && rename.has(x.v) ? rename.get(x.v)! : x.v);
      else if (x.k === "str") out.push(JSON.stringify(x.v));
      else if (x.k === "tpl") { out.push(`\`${x.v}\``); for (const p of x.parts ?? []) push(p); }
      /* statement separators and block braces are layout (ASI, `if (c) x()` ≡ `if (c) { x(); }`): not compared */
      else if (x.k === "punct" && (x.v === ";" || x.v === "{" || x.v === "}")) continue;
      else out.push(x.v);
    }
  };
  push(t);
  return out;
}

const shingles = (xs: string[], n = 4): Map<string, number> => {
  const m = new Map<string, number>();
  if (xs.length < n) { if (xs.length) m.set(xs.join("\u0001"), 1); return m; }
  for (let i = 0; i + n <= xs.length; i++) { const k = xs.slice(i, i + n).join("\u0001"); m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
};
/** 0…1: how alike two scripts are, after normalisation (Dice over 4-token shingles, with multiplicity) */
export function similarity(a: string, b: string): number {
  const x = shingles(normalizedTokens(a)), y = shingles(normalizedTokens(b));
  let both = 0, nx = 0, ny = 0;
  for (const v of x.values()) nx += v;
  for (const v of y.values()) ny += v;
  for (const [k, v] of x) both += Math.min(v, y.get(k) ?? 0);
  return nx + ny ? (2 * both) / (nx + ny) : 1;
}

/* ------------------------------------------------------------ what a script does */

export interface StyleSet { prop: string; value: string }
export interface ScriptReading {
  /** rs.<method>(…) calls: the method and its literal arguments */
  rsCalls: { method: string; args: (string | number | null)[] }[];
  /** what it listens for: rs.listen(event, target) — and the option codes a handler filters on, when it says them */
  listens: { event: string; target: string | null; options: string[] | null }[];
  /** the text of each popup it opens (rs.popup), null when not a literal */
  popups: (string | null)[];
  closesPopup: boolean;
  /** elements it makes: createElement tags, HTML it writes (insertAdjacentHTML / innerHTML / outerHTML), clones */
  creates: string[];
  /** where it puts elements: appendChild / append / prepend / insertBefore / after / before / replaceWith / insertAdjacent* */
  mounts: { method: string; onBody: boolean }[];
  /** every style it sets, normalised to kebab-case property and lower-case value */
  styles: StyleSet[];
  /** attributes it sets (setAttribute) and class / id names it uses */
  attributes: { name: string; value: string }[];
  names: string[];
}

const kebab = (p: string) => p.replace(/^(?:webkit|moz|ms)(?=[A-Z])/, (m) => `-${m.toLowerCase()}`).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`).toLowerCase().trim();
const CSS_PROPS = /^(?:-?[a-z]+(?:-[a-z]+)*)$/;
/** "prop: value; prop2: value2" → declarations (CSS text in any string) */
export function cssDeclarations(text: string): StyleSet[] {
  const out: StyleSet[] = [];
  for (const part of text.split(/[;\n]/)) {
    const m = /^\s*([a-zA-Z-]+)\s*:\s*(.+?)\s*(?:!important)?\s*$/.exec(part);
    if (m && CSS_PROPS.test(kebab(m[1]!))) out.push({ prop: kebab(m[1]!), value: m[2]!.toLowerCase() });
  }
  return out;
}

/** the value of an expression that starts at `i`, when it is a literal or a concatenation of literals ("posi" + "tion"), with where it ends */
function literalValue(t: Tok[], i: number): { value: string | number | null; end: number } {
  let j = i, acc = "", any = false, isNum = false;
  for (;;) {
    const x = t[j];
    if (!x) break;
    if (x.k === "str" || x.k === "tpl") { acc += x.v; any = true; }
    else if (x.k === "num") { acc += x.v; any = true; isNum = !acc.replace(x.v, "").length; }
    else if (x.k === "punct" && x.v === "-" && t[j + 1]?.k === "num") { acc += `-${t[j + 1]!.v}`; any = true; isNum = true; j += 2; if (t[j]?.v === "+") { j++; continue; } break; }
    else break;
    j++;
    if (t[j]?.v === "+" && (t[j + 1]?.k === "str" || t[j + 1]?.k === "tpl" || t[j + 1]?.k === "num")) { j++; isNum = false; continue; }
    break;
  }
  return { value: any ? (isNum && /^-?\d+(?:\.\d+)?$/.test(acc) ? Number(acc) : acc) : null, end: j };
}

/** the index of the matching closing bracket of the opener at `i` */
function closeOf(t: Tok[], i: number): number {
  const open = t[i]!.v, close = open === "(" ? ")" : open === "[" ? "]" : "}";
  let d = 0;
  for (let j = i; j < t.length; j++) { if (t[j]!.v === open) d++; else if (t[j]!.v === close && --d === 0) return j; }
  return t.length - 1;
}
/** the top-level comma-separated argument ranges of a call whose "(" is at `i` */
function argRanges(t: Tok[], i: number): [number, number][] {
  const end = closeOf(t, i);
  const out: [number, number][] = [];
  let start = i + 1, d = 0;
  for (let j = i + 1; j < end; j++) {
    const v = t[j]!.v;
    if (t[j]!.k === "punct" && "([{".includes(v)) d++;
    else if (t[j]!.k === "punct" && ")]}".includes(v)) d--;
    else if (t[j]!.k === "punct" && v === "," && !d) { out.push([start, j]); start = j + 1; }
  }
  if (start < end) out.push([start, end]);
  return out;
}
/** the member name at `i` when the token there is `.name` or `["name"]` — and the index after it */
function memberAt(t: Tok[], i: number): { name: string; next: number } | null {
  if ((t[i]?.v === "." || t[i]?.v === "?.") && (t[i + 1]?.k === "id" || t[i + 1]?.k === "kw")) return { name: t[i + 1]!.v, next: i + 2 };
  if (t[i]?.v === "[") { const e = closeOf(t, i); const lit = literalValue(t, i + 1); if (typeof lit.value === "string" && lit.end === e) return { name: lit.value, next: e + 1 }; }
  return null;
}
/** an object literal's literal entries {prop: "value", …} starting at the "{" at `i` */
function objectEntries(t: Tok[], i: number): StyleSet[] {
  const out: StyleSet[] = [];
  const end = closeOf(t, i);
  let d = 0;
  for (let j = i + 1; j < end; j++) {
    const x = t[j]!;
    if (x.k === "punct" && "([{".includes(x.v)) { d++; continue; }
    if (x.k === "punct" && ")]}".includes(x.v)) { d--; continue; }
    if (d) continue;
    if ((x.k === "id" || x.k === "str" || x.k === "kw") && t[j + 1]?.v === ":") {
      const lit = literalValue(t, j + 2);
      if (lit.value !== null) out.push({ prop: kebab(x.v), value: String(lit.value).toLowerCase() });
    }
  }
  return out;
}

const STYLE_SETTERS = new Set(["setProperty"]);
const MOUNTS = new Set(["appendChild", "append", "prepend", "insertBefore", "insertAdjacentElement", "insertAdjacentHTML", "after", "before", "replaceWith", "replaceChildren"]);
const HTML_TAG = /<\s*([a-z][a-z0-9-]*)\b/gi;

/** what a script does, read from its tokens (see the module comment) */
export function readScript(code: string): ScriptReading {
  const all = tokenize(code);
  /* template expressions are scanned too (a style built inside `${…}`) */
  const t: Tok[] = [];
  const flat = (xs: Tok[]) => { for (const x of xs) { t.push(x); if (x.k === "tpl") for (const p of x.parts ?? []) flat(p); } };
  flat(all);
  const r: ScriptReading = { rsCalls: [], listens: [], popups: [], closesPopup: false, creates: [], mounts: [], styles: [], attributes: [], names: [] };
  /* names that stand for a style object: `const s = el.style`, `var st = x["style"]`, and objects later Object.assign-ed to a style */
  const styleAliases = new Set<string>();
  const styleObjects = new Map<string, StyleSet[]>();
  for (let i = 0; i < t.length; i++) {
    const x = t[i]!;
    /* aliases and object literals bound to a name */
    if (x.k === "id" && t[i + 1]?.v === "=" && t[i + 2]) {
      const rhsMember = (() => { for (let j = i + 2; j < Math.min(t.length, i + 12); j++) { const m = memberAt(t, j); if (m?.name === "style" && !memberAt(t, m.next) && (t[m.next]?.v === ";" || t[m.next]?.v === "," || !t[m.next] || t[m.next]?.k === "kw" || t[m.next]?.k === "id")) return true; if (t[j]!.v === ";") break; } return false; })();
      if (rhsMember) styleAliases.add(x.v);
      if (t[i + 2]!.v === "{") styleObjects.set(x.v, objectEntries(t, i + 2));
    }
    /* rs.<method>(…) */
    if (x.k === "id" && x.v === "rs") {
      const m = memberAt(t, i + 1);
      if (m && t[m.next]?.v === "(") {
        const args = argRanges(t, m.next).map(([a, b]) => { const lit = literalValue(t, a); return lit.end === b ? lit.value : null; });
        r.rsCalls.push({ method: m.name, args });
        if (m.name === "popup") r.popups.push(typeof args[0] === "string" ? args[0] : null);
        if (m.name === "closePopup") r.closesPopup = true;
        if (m.name === "listen") {
          const range = argRanges(t, m.next);
          const handler = range[2] ? t.slice(range[2][0], range[2][1]) : [];
          r.listens.push({ event: typeof args[0] === "string" ? args[0] : "?", target: typeof args[1] === "string" ? args[1] : null, options: optionsFiltered(handler) });
        }
      }
    }
    /* element creation */
    if (x.k === "id" && x.v === "createElement" && t[i + 1]?.v === "(") { const lit = literalValue(t, i + 2); r.creates.push(typeof lit.value === "string" ? lit.value.toLowerCase() : "?"); }
    if (x.k === "id" && (x.v === "cloneNode" || x.v === "importNode") && t[i + 1]?.v === "(") r.creates.push("(clone)");
    if (x.k === "id" && (x.v === "innerHTML" || x.v === "outerHTML") && (t[i + 1]?.v === "=" || t[i + 1]?.v === "+=")) { const lit = literalValue(t, i + 2); for (const m of String(lit.value ?? "").matchAll(HTML_TAG)) r.creates.push(m[1]!.toLowerCase()); for (const d of htmlStyles(String(lit.value ?? ""))) r.styles.push(d); }
    /* mounting */
    if (x.k === "id" && MOUNTS.has(x.v) && t[i + 1]?.v === "(" && (t[i - 1]?.v === "." || t[i - 1]?.v === "?.")) {
      const recv = t.slice(Math.max(0, i - 4), i).map((y) => y.v).join("");
      r.mounts.push({ method: x.v, onBody: /body|documentElement/.test(recv) });
      if (x.v === "insertAdjacentHTML") { const [, second] = argRanges(t, i + 1); if (second) { const lit = literalValue(t, second[0]); for (const m of String(lit.value ?? "").matchAll(HTML_TAG)) r.creates.push(m[1]!.toLowerCase()); for (const d of htmlStyles(String(lit.value ?? ""))) r.styles.push(d); } }
    }
    /* styles: <x>.style.<prop> = v · <x>.style["prop"] = v · alias.<prop> = v */
    const styleTarget = (x.k === "id" && x.v === "style" && (t[i - 1]?.v === "." || t[i - 1]?.v === "?.")) ? i + 1
      : (x.k === "str" && x.v === "style" && t[i - 1]?.v === "[" && t[i + 1]?.v === "]") ? i + 2
      : (x.k === "id" && styleAliases.has(x.v) && t[i - 1]?.v !== "." ) ? i + 1 : -1;
    if (styleTarget >= 0) {
      const m = memberAt(t, styleTarget);
      if (m && m.name !== "cssText" && (t[m.next]?.v === "=")) { const lit = literalValue(t, m.next + 1); if (lit.value !== null) r.styles.push({ prop: kebab(m.name), value: String(lit.value).toLowerCase() }); }
      if (m && m.name === "cssText" && (t[m.next]?.v === "=" || t[m.next]?.v === "+=")) { const lit = literalValue(t, m.next + 1); r.styles.push(...cssDeclarations(String(lit.value ?? ""))); }
      if (m && STYLE_SETTERS.has(m.name) && t[m.next]?.v === "(") { const [a, b] = argRanges(t, m.next); const p = a ? literalValue(t, a[0]).value : null, v = b ? literalValue(t, b[0]).value : null; if (typeof p === "string" && v !== null) r.styles.push({ prop: kebab(p), value: String(v).toLowerCase() }); }
      /* el.style = "position: fixed; …" */
      if (!m && t[styleTarget]?.v === "=" && x.v === "style") { const lit = literalValue(t, styleTarget + 1); r.styles.push(...cssDeclarations(String(lit.value ?? ""))); }
    }
    /* Object.assign(<style or alias>, {…} | name) */
    if (x.k === "id" && x.v === "assign" && t[i - 2]?.v === "Object" && t[i + 1]?.v === "(") {
      const ranges = argRanges(t, i + 1);
      const target = ranges[0] ? t.slice(ranges[0][0], ranges[0][1]) : [];
      const isStyle = target.some((y, k) => (y.v === "style" && (target[k - 1]?.v === "." || target[k - 1]?.v === "[")) || (y.k === "id" && styleAliases.has(y.v)));
      if (isStyle) for (const [a] of ranges.slice(1)) { if (t[a]?.v === "{") r.styles.push(...objectEntries(t, a)); else if (t[a]?.k === "id" && styleObjects.has(t[a]!.v)) r.styles.push(...styleObjects.get(t[a]!.v)!); }
    }
    /* setAttribute("style" | "class" | "role" | …, value) */
    if (x.k === "id" && x.v === "setAttribute" && t[i + 1]?.v === "(") {
      const [a, b] = argRanges(t, i + 1);
      const name = a ? literalValue(t, a[0]).value : null, value = b ? literalValue(t, b[0]).value : null;
      if (typeof name === "string") { r.attributes.push({ name: name.toLowerCase(), value: String(value ?? "") }); if (name.toLowerCase() === "style") r.styles.push(...cssDeclarations(String(value ?? ""))); }
    }
    /* class names and ids it gives elements */
    if (x.k === "id" && (x.v === "className" || x.v === "id") && t[i + 1]?.v === "=" && (t[i - 1]?.v === ".")) { const lit = literalValue(t, i + 2); if (typeof lit.value === "string") r.names.push(lit.value); }
    if (x.k === "id" && (x.v === "add" || x.v === "toggle") && t[i - 2]?.v === "classList" && t[i + 1]?.v === "(") for (const [a, b] of argRanges(t, i + 1)) { const lit = literalValue(t, a); if (typeof lit.value === "string" && lit.end === b) r.names.push(lit.value); }
    /* CSS text sitting in any string (a style string built first and set later) */
    if ((x.k === "str" || x.k === "tpl") && /:\s*[^;]+;|\bposition\s*:/i.test(x.v) && !/^\s*[.#\[]/.test(x.v)) for (const d of cssDeclarations(x.v)) if (!r.styles.some((s) => s.prop === d.prop && s.value === d.value)) r.styles.push(d);
  }
  /* style objects bound to a name and assigned elsewhere (`el.style = obj` is not valid, but Object.assign is handled above); literal objects with position count as styles when the script also creates elements */
  if (r.creates.length) for (const entries of styleObjects.values()) if (entries.some((e) => e.prop === "position")) for (const e of entries) if (!r.styles.some((s) => s.prop === e.prop && s.value === e.value)) r.styles.push(e);
  return r;
}

/** style="…" attributes inside HTML text */
function htmlStyles(html: string): StyleSet[] {
  const out: StyleSet[] = [];
  for (const m of html.matchAll(/style\s*=\s*(["'])(.*?)\1/gis)) out.push(...cssDeclarations(m[2]!));
  return out;
}

/** the option codes a handler filters on — `["1","2"].indexOf(String(e.option))`, `e.option === "1"`, `e.option == 1 || e.option == 2`, `[…].includes(e.option)`; null when it does not say */
function optionsFiltered(h: Tok[]): string[] | null {
  const out = new Set<string>();
  for (let i = 0; i < h.length; i++) {
    const x = h[i]!;
    /* e.option === "1" / "1" == e.option / String(e.option) === "1" */
    if (x.k === "id" && x.v === "option" && h[i - 1]?.v === ".") {
      let j = i + 1;
      if (h[j]?.v === ")") j++;
      if (["===", "=="].includes(h[j]?.v ?? "")) { const lit = literalValue(h, j + 1); if (lit.value !== null) out.add(String(lit.value)); }
      let k = i - 2;
      while (k >= 0 && (h[k]?.v === "(" || h[k]?.k === "id" && h[k]?.v === "String")) k--;
      if (["===", "=="].includes(h[k]?.v ?? "")) { const v = h[k - 1]; if (v && (v.k === "str" || v.k === "num")) out.add(v.v); }
    }
    /* [ "1", "2" ].indexOf(…e.option…) / .includes(…) */
    if (x.v === "[" ) {
      const e = closeOf(h, i);
      const after = h[e + 1]?.v === "." ? h[e + 2]?.v : null;
      if ((after === "indexOf" || after === "includes") && h.slice(e + 3, closeOf(h, e + 3) + 1).some((y, k, arr) => y.v === "option" && arr[k - 1]?.v === ".")) {
        for (let j = i + 1; j < e; j++) if (h[j]!.k === "str" || h[j]!.k === "num") out.add(h[j]!.v);
      }
    }
  }
  return out.size ? [...out].sort() : null;
}
