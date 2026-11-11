/**
 * DECIPHER <exec> AND HELPER FUNCTIONS, READ AS TEXT (2026-11-11).
 *
 * Imported Python is never run. Two idioms cover most of what a professionally programmed Decipher survey does in
 * <exec>, and both can be read exactly, by shape:
 *
 *   1. HIDDEN-VARIABLE ASSIGNMENT. An if / elif / else tree whose leaves are `H.val = H.r3.index` (or `H.r3.val = 1`)
 *      codes a hidden question from earlier answers. Each leaf is returned with its full guard — the conditions on
 *      the path to it, and the negation of every earlier branch it is the alternative to — so it can become one
 *      native auto-punch rule. Anything else in the block (a loop, a call, arithmetic) makes the whole block
 *      "not this idiom": half a block converted is a different program.
 *
 *   2. THE DISPATCHER FUNCTION. `def processTerms(qid): if qid == "Disp1": if condition.Disp1: retvar = True; …`
 *      called as `processTerms('Disp1')` in a `cond`. For a literal argument its truth value is the OR of the
 *      conditions that set the return variable in that argument's branch — so the call can be replaced by that
 *      expression. Its side effects (markers, a hidden "reason" row) are reporting, not routing, and are listed.
 *
 * Both return Python CONDITION TEXT, which the adapter's own condition reader then parses; nothing here decides what
 * a condition means.
 */

const unescape = (s: string) => s.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

interface Line { indent: number; text: string }

/** where a statement header's own colon is: the first `:` outside brackets and quotes (`if anyCodes(Q, ["ch:2-8"]):`) */
function headerEnd(text: string): number {
  let depth = 0, quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}

/** one row a `for row in Q.rows:` visits */
export interface ExecRow { label: string; value: string }

/**
 * `for V in Q.rows:` written out, one copy of its body per row, with the loop variable replaced by that row:
 * `T.attr(V.label)` → `T.r3`, `Q[V]` → `Q.r3`, `V.c2` → `Q.r3.c2`, `V.index` → 2, `str(V.value)` → '3'.
 * Nothing is run; a body that uses the variable any other way is left as it is (and so is not converted).
 */
function unroll(ls: Line[], rowsOf: (q: string) => ExecRow[] | null): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < ls.length; i++) {
    const m = /^for\s+(\w+)\s+in\s+(\w+)\.rows\s*:$/.exec(ls[i].text);
    const rows = m ? rowsOf(m[2]) : null;
    if (!m || !rows || !rows.length || rows.length > 80) { out.push(ls[i]); continue; }
    const [, v, q] = m;
    const body: Line[] = [];
    let e = i + 1;
    while (e < ls.length && ls[e].indent > ls[i].indent) body.push(ls[e++]);
    if (!body.length) { out.push(ls[i]); continue; }
    const shift = body[0].indent - ls[i].indent;
    const copies: Line[] = [];
    let clean = true;
    rows.forEach((row, idx) => {
      for (const b of body) {
        if (/^break$/.test(b.text)) continue;
        const text = b.text
          .replace(new RegExp(`(\\w+)\\.attr\\(\\s*${v}\\.label\\s*\\)`, "g"), `$1.${row.label}`)
          .replace(new RegExp(`(\\w+)\\[\\s*${v}\\s*\\]`, "g"), `$1.${row.label}`)
          .replace(new RegExp(`str\\(\\s*${v}\\.value\\s*\\)`, "g"), `'${row.value}'`)
          .replace(new RegExp(`\\b${v}\\.label\\b`, "g"), `'${row.label}'`)
          .replace(new RegExp(`\\b${v}\\.index\\b`, "g"), String(idx))
          .replace(new RegExp(`\\b${v}\\.(?=[a-z]+\\d|val\\b|ival\\b|any\\b)`, "g"), `${q}.${row.label}.`);
        if (new RegExp(`\\b${v}\\b`).test(text)) clean = false;
        copies.push({ indent: b.indent - shift, text });
      }
    });
    if (!clean) { out.push(ls[i]); continue; }
    out.push(...copies);
    i = e - 1;
  }
  return out;
}

/**
 * "ONLY THESE": `n = 0; m = 0; for r in Q.rows: if r.val: n += 1; for r in [Q.r1, Q.r7]: if r.val: m += 1;
 * if n == m and m > 0:` — every selected answer is one of the listed ones, and at least one is. Rewritten as that
 * condition, with the two counters gone.
 */
function onlyThese(code: string, rowsOf: (q: string) => ExecRow[] | null): string {
  const m = /^([ \t]*)(\w+)\s*=\s*0\s*\n\s*(\w+)\s*=\s*0\s*\n\s*for\s+(\w+)\s+in\s+(\w+)\.rows\s*:\s*\n\s*if\s+\4\.val\s*:\s*\n\s*\2\s*\+=\s*1\s*\n\s*for\s+(\w+)\s+in\s+\[([^\]]+)\]\s*:\s*\n\s*if\s+\6\.val\s*:\s*\n\s*\3\s*\+=\s*1\s*\n\s*if\s+\2\s*==\s*\3\s+and\s+\3\s*(?:>|gt)\s*0\s*:/m.exec(code);
  if (!m) return code;
  const all = rowsOf(m[5]);
  const listed = m[7].split(",").map((x) => x.trim());
  if (!all || !listed.every((x) => x.startsWith(`${m[5]}.`) && all.some((r) => r.label === x.slice(m[5].length + 1)))) return code;
  const others = all.filter((r) => !listed.includes(`${m[5]}.${r.label}`)).map((r) => `${m[5]}.${r.label}`);
  return code.replace(m[0], `${m[1]}if (${listed.join(" or ")})${others.length ? ` and not(${others.join(" or ")})` : ""}:`);
}
function lines(code: string): Line[] {
  const out: Line[] = [];
  for (const raw of unescape(code).replace(/\t/g, "    ").split(/\r?\n/)) {
    const text = raw.replace(/(^|\s)#.*$/, "").trimEnd();
    if (!text.trim()) continue;
    /* `if a: x = 1; y = 2` on one line → the header, then its statements one level in */
    const indent = /^\s*/.exec(text)![0].length;
    const body = text.trim();
    const colon = /^(?:if|elif|else|for)\b/.test(body) ? headerEnd(body) : -1;
    if (colon >= 0 && body.slice(colon + 1).trim()) {
      out.push({ indent, text: body.slice(0, colon + 1).trim() });
      for (const s of body.slice(colon + 1).split(";").map((x) => x.trim()).filter(Boolean)) out.push({ indent: indent + 1, text: s });
    } else for (const [i, s] of text.trim().split(";").map((x) => x.trim()).filter(Boolean).entries()) out.push({ indent, text: s + (i < 0 ? "" : "") });
  }
  return out;
}

export interface ExecLeaf {
  /** the hidden question being coded */
  target: string;
  /** the row / choice label selected (`r3`, `ch2`); "" when the option is named by `index` or `byValue` */
  option: string;
  /** `H.val = 2`: the option at this position (Decipher's .val of a single choice is the 0-based position) */
  index?: number;
  /** a `.val =` assignment: one answer, so a later assignment in the block replaces an earlier one */
  single: boolean;
  /** where the leaf sits: statement number, branch number, statement number, … — see `exclusive` */
  at: number[];
  /** Python condition text; "" = always */
  guard: string;
}

/** two leaves that sit in different branches of the same if / elif / else can never both run */
export function exclusive(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return i % 2 === 1;
  return false;
}

const and = (parts: string[]) => parts.filter(Boolean).map((p) => `(${p})`).join(" and ");

/** idiom 1 — null when the block is anything other than a tree of conditions over hidden-variable assignments */
export function readExecAssignments(code: string, rowsOf: (q: string) => ExecRow[] | null = () => null): ExecLeaf[] | null {
  const ls = unroll(lines(onlyThese(unescape(code).replace(/\r/g, ""), rowsOf)), rowsOf).filter((l) => !/^print\b/.test(l.text));
  if (!ls.length) return null;
  const leaves: ExecLeaf[] = [];
  let i = 0;
  /* local names: `ASK = [1, 2, 4]` (a list) and `reg = S3.ival + 1` (another name for an answer) — written back into the conditions */
  const names = new Map<string, string>();
  const subst = (c: string) => { let out = c; for (const [k, v] of names) out = out.replace(new RegExp(`(?<![\\w.])${k}(?![\\w(])`, "g"), v); return out; };
  const block = (indent: number, path: string[], at: number[]): boolean => {
    let earlier: string[] = []; // conditions of the if / elif branches of the chain being read
    let stmt = -1, branch = 0;
    while (i < ls.length && ls[i].indent >= indent) {
      const l = ls[i];
      if (l.indent > indent) return false;
      let m: RegExpExecArray | null;
      if ((m = /^(if|elif)\b\s*(.+):$/.exec(l.text))) {
        if (m[1] === "if" || !earlier.length) { earlier = []; stmt++; branch = 0; } else branch++;
        const c = subst(m[2].trim());
        i++;
        if (i >= ls.length || ls[i].indent <= indent) return false;
        if (!block(ls[i].indent, [...path, ...earlier.map((e) => `not(${e})`), c], [...at, stmt, branch])) return false;
        earlier.push(c);
      } else if (/^else\s*:$/.test(l.text)) {
        if (!earlier.length) return false;
        i++;
        if (i >= ls.length || ls[i].indent <= indent) return false;
        if (!block(ls[i].indent, [...path, ...earlier.map((e) => `not(${e})`)], [...at, stmt, branch + 1])) return false;
        earlier = [];
      } else if ((m = /^(\w+)\.val\s*=\s*(\w+)\.(\w+)\.index$/.exec(l.text)) && m[1] === m[2]) {
        leaves.push({ target: m[1], option: m[3], guard: and(path), single: true, at: [...at, ++stmt] }); earlier = []; i++;
      } else if ((m = /^(\w+)\.val\s*=\s*(\d+)$/.exec(l.text))) {
        leaves.push({ target: m[1], option: "", index: Number(m[2]), guard: and(path), single: true, at: [...at, ++stmt] }); earlier = []; i++;
      } else if ((m = /^(\w+)\.(r\w+|ch\w+|c\w+)\.val\s*=\s*(?:1|True)$/.exec(l.text))) {
        leaves.push({ target: m[1], option: m[2], guard: and(path), single: false, at: [...at, ++stmt] }); earlier = []; i++;
      } else if ((m = /^(\w+)\s*=\s*(\[[\d\s,'"\w-]*\])$/.exec(l.text)) && indent === ls[0].indent) {
        names.set(m[1], m[2]); earlier = []; i++;
      } else if ((m = /^(\w+)\s*=\s*(\w+\.i?val(?:\s*[+-]\s*\d+)?)$/.exec(l.text)) && indent === ls[0].indent) {
        names.set(m[1], `(${m[2]})`); earlier = []; i++;
      } else if (/^(?:pass|setMarker\(\s*["'][\w ./-]+["']\s*\))$/.test(l.text)) {
        i++; // a marker is a report tag, not routing
      } else return false;
    }
    return true;
  };
  if (!block(ls[0].indent, [], []) || i < ls.length || !leaves.length) return null;
  return leaves;
}

export interface Dispatcher {
  name: string;
  /** literal argument → Python condition text that makes the call true */
  cases: Map<string, string>;
  /** what else each case does, in words, for the report */
  sideEffects: string[];
}

/** idiom 2 — every `def f(arg): … if arg == "lit": if COND: ret = True …` in a block of definitions */
export function readDispatchers(code: string): Dispatcher[] {
  const ls = lines(code);
  const out: Dispatcher[] = [];
  for (let s = 0; s < ls.length; s++) {
    const def = /^def\s+(\w+)\(\s*(\w+)\s*\)\s*:$/.exec(ls[s].text);
    if (!def) continue;
    const base = ls[s].indent;
    const body: Line[] = [];
    let e = s + 1;
    while (e < ls.length && ls[e].indent > base) body.push(ls[e++]);
    const ret = body.map((l) => /^return\s+(\w+)$/.exec(l.text)?.[1]).filter(Boolean).pop();
    const init = body.find((l) => new RegExp(`^${ret}\\s*=\\s*False$`).test(l.text));
    if (!ret || !init) continue;
    const cases = new Map<string, string[]>();
    const effects = new Set<string>();
    let ok = true, lit: string | null = null, litIndent = -1, guard: string | null = null, guardIndent = -1;
    for (const l of body) {
      if (l === init) continue;
      let m: RegExpExecArray | null;
      if (lit !== null && l.indent <= litIndent) { lit = null; guard = null; }
      if (guard !== null && l.indent <= guardIndent) guard = null;
      if ((m = new RegExp(`^if\\s+${def[2]}\\s*==\\s*["']([^"']+)["']\\s*:$`).exec(l.text))) { lit = m[1]; litIndent = l.indent; if (!cases.has(lit)) cases.set(lit, []); continue; }
      if (lit !== null && (m = /^if\s+(.+):$/.exec(l.text))) { guard = m[1].trim(); guardIndent = l.indent; continue; }
      if (lit !== null && guard !== null) {
        if (new RegExp(`^${ret}\\s*=\\s*True$`).test(l.text)) { cases.get(lit)!.push(guard); continue; }
        if ((m = /^setMarker\(\s*["']([^"']+)["']\s*\)$/.exec(l.text))) { effects.add("sets a marker"); continue; }
        if (/^\w+\.\w+\.val\s*=\s*1$/.test(l.text)) { effects.add("records the reason in a hidden question"); continue; }
        ok = false; break;
      }
      /* the tail: "in a simulated test, never terminate" — a test-harness switch, not survey logic */
      if (/^(?:if\s+gv\.isSST\(\)\s*:|else\s*:|return\s+(?:False|\w+))$/.test(l.text)) continue;
      ok = false; break;
    }
    if (ok && cases.size) out.push({ name: def[1], cases: new Map([...cases].map(([k, v]) => [k, v.length ? v.map((c) => `(${c})`).join(" or ") : "False"])), sideEffects: [...effects] });
  }
  return out;
}

/** replace `f('lit')` by its condition wherever a known dispatcher is called with a literal */
export function inlineDispatchers(cond: string, ds: Dispatcher[]): { text: string; used: string[] } {
  const used: string[] = [];
  let text = cond;
  for (const d of ds) {
    text = text.replace(new RegExp(`\\b${d.name}\\(\\s*["']([^"']+)["']\\s*\\)`, "g"), (m, lit: string) => { const c = d.cases.get(lit); if (c === undefined) return m; used.push(`${d.name}('${lit}')`); return `(${c})`; });
  }
  return { text, used };
}

/** `sum([1 for x in [a, b, c] if x]) ge 2` → the combinations that make it true (a list of at most six) */
export function expandCounts(cond: string): string {
  return cond.replace(/sum\(\s*\[\s*1\s+for\s+(\w+)\s+in\s+\[([^\]]+)\]\s+if\s+\1\s*\]\s*\)\s*(ge|gt|eq|>=|>|==)\s*(\d+)/g, (m, _v, list: string, op: string, nRaw: string) => {
    const items = list.split(",").map((x) => x.trim()).filter(Boolean);
    if (items.length > 6) return m;
    const n = Number(nRaw) + (op === "gt" || op === ">" ? 1 : 0);
    const exact = op === "eq" || op === "==";
    const combos: string[] = [];
    for (let mask = 0; mask < 1 << items.length; mask++) {
      const bits = items.map((_, i) => !!(mask & (1 << i)));
      const k = bits.filter(Boolean).length;
      if (exact ? k !== n : k !== n) continue;
      combos.push(`(${items.map((it, i) => (bits[i] ? it : exact ? `not(${it})` : "")).filter(Boolean).join(" and ") || "True"})`);
    }
    if (n === 0 && !exact) return "True";
    return combos.length ? `(${combos.join(" or ")})` : "False";
  });
}
