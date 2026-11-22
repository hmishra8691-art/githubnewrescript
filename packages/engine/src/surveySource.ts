import { FlowNode as FlowNodeSchema, Quota as QuotaSchema, QuotaCell as QuotaCellSchema, Question as QuestionSchema, SurveyDefinition as SurveyDefinitionSchema, type SurveyDefinition } from "@rescript/schema";
import { formatCondition, parseLogicExpression } from "./logicExpression.js";

/**
 * THE SURVEY SOURCE FORMAT (Level 5 roadmap P3 — 2026-11-28).
 *
 * A survey as text a programmer can read, review and diff: questions with their options, display logic and skips;
 * the flow as an indented outline of pages, blocks, loops and branches; quotas with their cells. It converts to and
 * from the definition WITHOUT LOSS:
 *
 *   - what has a readable form is written readably (a condition as the expression the logic editor shows);
 *   - a condition is written as text only if parsing that text gives back exactly the same condition — otherwise it
 *     is written as JSON, so nothing is ever approximated;
 *   - everything else an element has (settings, translations, scripts, branding …) is kept on an `extra` line as
 *     JSON, with the fields that only repeat the schema's defaults left out.
 *
 * The test is the roadmap's: parse(original) and parse(fromSource(toSource(original))) are identical, on every
 * fixture. `sourceDiff` gives the line-by-line difference of two versions, which is what a review reads.
 */
type O = Record<string, unknown>;
const J = (v: unknown) => JSON.stringify(v);
const str = (s: unknown) => J(String(s ?? ""));
const BARE = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;
/** a code or id: bare when it is a plain identifier, a number as a number, anything else quoted */
const tok = (v: unknown): string => (typeof v === "number" ? String(v) : typeof v === "string" && BARE.test(v) && !/^(?:if|extra|json|to|label|limit)$/.test(v) ? v : J(v));

/** the keys of `o` that differ from the schema's default for the same element, skipping the ones written readably */
function extraOf(o: O, defaults: O | null, skip: Set<string>): O | null {
  const out: O = {};
  for (const [k, v] of Object.entries(o)) {
    if (skip.has(k) || v === undefined) continue;
    if (defaults && k in defaults && J(defaults[k]) === J(v)) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}
const safeParse = <T,>(f: () => T): T | null => { try { return f(); } catch { return null; } };

function condText(def: SurveyDefinition, c: unknown): string {
  if (c == null) return "json null";
  try {
    const s = formatCondition(def, c as never);
    const back = parseLogicExpression(def, s) as { condition?: unknown };
    if (s && back.condition !== undefined && J(back.condition) === J(c)) return s;
  } catch { /* written as JSON below */ }
  return `json ${J(c)}`;
}

export function toSource(input: SurveyDefinition): string {
  const def = SurveyDefinitionSchema.parse(input);
  const L: string[] = ["# survey source v1 — converts to and from the definition without loss"];
  const { title, ...meta } = def.meta as O;
  L.push(`survey ${str(title)}`);
  if (Object.keys(meta).length) L.push(`  meta ${J(meta)}`);
  /* codes that name exactly one question are used in the flow; others are written @id */
  const codeCount = new Map<string, number>();
  for (const q of def.questions) codeCount.set(String(q.code ?? ""), (codeCount.get(String(q.code ?? "")) ?? 0) + 1);
  const ref = (id: string) => { const q = def.questions.find((x) => x.id === id); return q && q.code && codeCount.get(q.code) === 1 && BARE.test(q.code) && q.code !== id ? q.code : `@${id}`; };

  L.push("");
  for (const q of def.questions as unknown as O[]) {
    const qd = safeParse(() => QuestionSchema.parse({ id: q.id, code: q.code, variableName: q.variableName, type: q.type, text: "" }) as unknown as O);
    L.push(`question ${tok(q.code)} ${tok(q.type)} ${str(q.text)}`);
    L.push(`  id ${tok(q.id)}`);
    if (q.variableName !== q.code) L.push(`  variable ${tok(q.variableName)}`);
    if (q.required === true) L.push("  required");
    const options = Array.isArray(q.options) ? (q.options as O[]) : [];
    const od = safeParse(() => ((QuestionSchema.parse({ id: "x", code: "X", variableName: "X", type: q.type, text: "", options: [{ code: "x", label: "x" }] }) as unknown as O).options as O[])[0] ?? null);
    for (const o of options) { const ex = extraOf(o, od, new Set(["code", "label"])); L.push(`  option ${tok(o.code)} ${str(o.label)}${ex ? ` ${J(ex)}` : ""}`); }
    const rows = Array.isArray(q.rows) ? (q.rows as O[]) : [];
    const rd = safeParse(() => ((QuestionSchema.parse({ id: "x", code: "X", variableName: "X", type: q.type, text: "", rows: [{ code: "x", label: "x" }] }) as unknown as O).rows as O[])[0] ?? null);
    for (const r of rows) { const ex = extraOf(r, rd, new Set(["code", "label"])); L.push(`  row ${tok(r.code)} ${str(r.label)}${ex ? ` ${J(ex)}` : ""}`); }
    if (q.displayLogic != null) L.push(`  show if ${condText(def, q.displayLogic)}`);
    for (const s of (Array.isArray(q.skipLogic) ? q.skipLogic : []) as O[]) L.push(`  skip ${tok(s.id)} to ${J(s.target)}${s.label !== undefined ? ` label ${str(s.label)}` : ""} if ${condText(def, s.when)}`);
    const handled = new Set(["id", "code", "variableName", "type", "text", "required", "options", "rows", "displayLogic", "skipLogic"]);
    const ex = extraOf({ ...q, ...(options.length ? {} : { options: q.options }), ...(rows.length ? {} : { rows: q.rows }) }, qd, new Set([...handled].filter((k) => !(k === "options" && !options.length) && !(k === "rows" && !rows.length))));
    if (q.required === false && qd && qd.required !== false) L.push("  optional");
    if (ex) L.push(`  extra ${J(ex)}`);
    L.push("");
  }

  L.push("flow");
  const node = (n: O, depth: number) => {
    const pad = "  ".repeat(depth);
    const type = String(n.type);
    const nd = safeParse(() => FlowNodeSchema.parse(minimalNode(n)) as unknown as O);
    const title = typeof n.title === "string" ? ` ${str(n.title)}` : "";
    const skip = new Set(["type", "id", "title", "children", "questionIds", "branches", "otherwise", "status"]);
    if (type === "page") L.push(`${pad}page ${tok(n.id)}${title}: ${((n.questionIds as string[]) ?? []).map(ref).join(", ")}`);
    else if (type === "end") L.push(`${pad}end ${tok(n.id)} ${tok(n.status ?? "complete")}${title}`);
    else if (["block", "section", "loop", "randomizer", "branch"].includes(type)) L.push(`${pad}${type} ${tok(n.id)}${title}`);
    else { L.push(`${pad}node ${J(n)}`); return; }
    const ex = extraOf(n, nd, skip);
    if (ex) L.push(`${pad}  extra ${J(ex)}`);
    if (type === "branch") {
      for (const b of (n.branches as O[]) ?? []) {
        const bex = extraOf(b, null, new Set(["id", "label", "when", "children"]));
        L.push(`${pad}  path ${tok(b.id)}${typeof b.label === "string" ? ` label ${str(b.label)}` : ""} if ${condText(def, b.when)}`);
        if (bex) L.push(`${pad}    extra ${J(bex)}`);
        for (const c of (b.children as O[]) ?? []) node(c, depth + 2);
      }
      if (Array.isArray(n.otherwise)) { L.push(`${pad}  otherwise`); for (const c of n.otherwise as O[]) node(c, depth + 2); }
    }
    for (const c of (Array.isArray(n.children) ? n.children : []) as O[]) node(c, depth + 1);
  };
  for (const n of def.flow as unknown as O[]) node(n, 1);

  if ((def.quotas ?? []).length) L.push("");
  for (const q of (def.quotas ?? []) as unknown as O[]) {
    const qd = safeParse(() => QuotaSchema.parse({ id: "x", name: "x", cells: [] }) as unknown as O);
    L.push(`quota ${tok(q.id)} ${str(q.name)}`);
    const ex = extraOf(q, qd, new Set(["id", "name", "cells"]));
    if (ex) L.push(`  extra ${J(ex)}`);
    const cd = safeParse(() => QuotaCellSchema.parse({ id: "x", label: "x", when: { type: "group", op: "and", children: [] }, limit: 1 }) as unknown as O);
    for (const c of q.cells as O[]) {
      const cex = extraOf(c, cd, new Set(["id", "label", "limit", "when"]));
      L.push(`  cell ${tok(c.id)} ${str(c.label)} limit ${J(c.limit)}${cex ? ` ${J(cex)}` : ""} if ${condText(def, c.when)}`);
    }
  }
  const top = safeParse(() => SurveyDefinitionSchema.parse({ meta: def.meta, questions: [], flow: [] }) as unknown as O);
  const rest = extraOf(def as unknown as O, top, new Set(["meta", "questions", "flow", "quotas"]));
  if (rest) { L.push(""); L.push(`extra ${J(rest)}`); }
  return L.join("\n") + "\n";
}

/** the fewest fields a flow node of this type needs to parse, for reading its defaults */
function minimalNode(n: O): O {
  const base: O = { type: n.type, id: "x" };
  if (n.type === "page") base.questionIds = [];
  if (n.type === "block" || n.type === "section" || n.type === "randomizer") base.children = [];
  /* placeholders, never the node's own values: a field equal to the default is left out of the source, so the default must not BE the value */
  if (n.type === "loop") Object.assign(base, { loopVar: "__default__", source: { kind: "static", items: [] }, children: [] });
  if (n.type === "branch") Object.assign(base, { branches: [], otherwise: [] });
  if (n.type === "end") base.status = n.status ?? "complete";
  return base;
}

/* ------------------------------------------------------------------ reading it back */

export interface SourceProblem { line: number; message: string }
export interface SourceReading { def: SurveyDefinition | null; problems: SourceProblem[] }

/** read tokens from a line: bare words, JSON strings, JSON objects/arrays; `if …` takes the rest of the line */
function readTokens(s: string): { toks: unknown[]; cond: string | null } {
  const toks: unknown[] = [];
  let i = 0, cond: string | null = null;
  while (i < s.length) {
    while (s[i] === " " || s[i] === "," || s[i] === ":") i++;
    if (i >= s.length) break;
    if (s.startsWith("if ", i) && (i === 0 || s[i - 1] === " ")) { cond = s.slice(i + 3); break; }
    const ch = s[i]!;
    if (ch === '"' || ch === "{" || ch === "[") {
      let j = i, depth = 0, inStr = false;
      for (; j < s.length; j++) {
        const c = s[j]!;
        if (inStr) { if (c === "\\") j++; else if (c === '"') { inStr = false; if (depth === 0) { j++; break; } } continue; }
        if (c === '"') { inStr = true; continue; }
        if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") { depth--; if (depth === 0) { j++; break; } }
      }
      toks.push(JSON.parse(s.slice(i, j)));
      i = j;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== " " && s[j] !== "," && !(s[j] === ":" && (s[j + 1] === " " || j + 1 === s.length))) j++;
    const w = s.slice(i, j);
    toks.push(/^-?\d+(?:\.\d+)?(?:e-?\d+)?$/i.test(w) ? Number(w) : w);
    i = j;
  }
  return { toks, cond };
}

export function fromSource(text: string): SourceReading {
  const problems: SourceProblem[] = [];
  const lines = String(text ?? "").split(/\r?\n/).map((raw, i) => ({ n: i + 1, indent: raw.length - raw.trimStart().length, body: raw.trim() })).filter((l) => l.body && !l.body.startsWith("#"));
  let meta: O = {}, rest: O = {};
  const questions: O[] = [];
  const quotas: O[] = [];
  const flow: O[] = [];
  const pendingConds: { at: O; key: string; text: string; line: number }[] = [];
  const cond = (at: O, key: string, t: string | null, line: number) => {
    if (t == null) { problems.push({ line, message: "a condition is missing after “if”" }); return; }
    if (t.startsWith("json ")) { try { at[key] = JSON.parse(t.slice(5)); } catch { problems.push({ line, message: "the condition's JSON does not parse" }); } return; }
    pendingConds.push({ at, key, text: t, line });
  };
  let i = 0;
  const err = (line: number, m: string) => problems.push({ line, message: m });
  try {
    while (i < lines.length) {
      const l = lines[i]!;
      const { toks, cond: c } = readTokens(l.body);
      const head = toks[0];
      if (l.indent !== 0) { err(l.n, `unexpected indented line: ${l.body.slice(0, 60)}`); i++; continue; }
      if (head === "survey") {
        meta = { title: toks[1] };
        i++;
        while (i < lines.length && lines[i]!.indent > 0) { const t = readTokens(lines[i]!.body).toks; if (t[0] === "meta") meta = { ...(t[1] as O), title: meta.title }; else err(lines[i]!.n, "only “meta” belongs under survey"); i++; }
        continue;
      }
      if (head === "question") {
        const q: O = { code: toks[1], type: toks[2], text: toks[3] };
        let required: boolean | undefined;
        const options: O[] = [], rows: O[] = [], skips: O[] = [];
        let extra: O = {};
        i++;
        while (i < lines.length && lines[i]!.indent > 0) {
          const ln = lines[i]!; const r = readTokens(ln.body); const t = r.toks;
          switch (t[0]) {
            case "id": q.id = t[1]; break;
            case "variable": q.variableName = t[1]; break;
            case "required": required = true; break;
            case "optional": required = false; break;
            case "option": options.push({ ...((t[3] as O) ?? {}), code: t[1], label: t[2] }); break;
            case "row": rows.push({ ...((t[3] as O) ?? {}), code: t[1], label: t[2] }); break;
            case "show": if (t[1] !== undefined) err(ln.n, "write “show if <condition>”"); cond(q, "displayLogic", r.cond, ln.n); break;
            case "skip": { const s: O = { id: t[1], target: t[3] }; if (t[4] === "label") s.label = t[5]; skips.push(s); cond(s, "when", r.cond, ln.n); break; }
            case "extra": extra = t[1] as O; break;
            default: err(ln.n, `“${String(t[0])}” is not a question line`);
          }
          i++;
        }
        if (q.variableName === undefined) q.variableName = q.code;
        /* the same object throughout: a condition read later is written into it */
        for (const [k, v] of Object.entries(extra)) if (!(k in q)) q[k] = v;
        if (options.length) q.options = options;
        if (rows.length) q.rows = rows;
        if (skips.length) q.skipLogic = skips;
        if (required !== undefined) q.required = required;
        questions.push(q);
        continue;
      }
      if (head === "flow") {
        i++;
        const block = (depth: number, into: O[]) => {
          while (i < lines.length && lines[i]!.indent === depth * 2) {
            const ln = lines[i]!; const r = readTokens(ln.body); const t = r.toks;
            const type = String(t[0]);
            if (type === "node") { into.push(t[1] as O); i++; continue; }
            if (type === "extra" || type === "path" || type === "otherwise") return;
            const n: O = { type, id: t[1] };
            if (type === "page") { const titled = typeof t[2] === "string" && ln.body.includes(`${JSON.stringify(t[2])}:`); if (titled) n.title = t[2]; n.questionIds = t.slice(titled ? 3 : 2).map(String); }
            else if (type === "end") { n.status = t[2]; if (typeof t[3] === "string") n.title = t[3]; }
            else if (typeof t[2] === "string") n.title = t[2];
            i++;
            if (i < lines.length && lines[i]!.indent === depth * 2 + 2 && lines[i]!.body.startsWith("extra ")) { Object.assign(n, { ...(readTokens(lines[i]!.body).toks[1] as O), ...n }); i++; }
            if (type === "branch") {
              const branches: O[] = [];
              while (i < lines.length && lines[i]!.indent === depth * 2 + 2 && lines[i]!.body.startsWith("path ")) {
                const pl = lines[i]!; const pr = readTokens(pl.body);
                const b: O = { id: pr.toks[1] };
                if (pr.toks[2] === "label") b.label = pr.toks[3];
                cond(b, "when", pr.cond, pl.n);
                i++;
                if (i < lines.length && lines[i]!.indent === depth * 2 + 4 && lines[i]!.body.startsWith("extra ")) { Object.assign(b, { ...(readTokens(lines[i]!.body).toks[1] as O), ...b }); i++; }
                b.children = []; block(depth + 2, b.children as O[]);
                branches.push(b);
              }
              n.branches = branches;
              if (i < lines.length && lines[i]!.indent === depth * 2 + 2 && lines[i]!.body === "otherwise") { i++; n.otherwise = []; block(depth + 2, n.otherwise as O[]); }
            } else if (["block", "section", "loop", "randomizer"].includes(type)) { n.children = []; block(depth + 1, n.children as O[]); }
            into.push(n);
          }
        };
        block(1, flow);
        while (i < lines.length && lines[i]!.indent > 0) { err(lines[i]!.n, `this line is not in the outline: ${lines[i]!.body.slice(0, 60)}`); i++; }
        continue;
      }
      if (head === "quota") {
        const q: O = { id: toks[1], name: toks[2], cells: [] };
        i++;
        while (i < lines.length && lines[i]!.indent > 0) {
          const ln = lines[i]!; const r = readTokens(ln.body); const t = r.toks;
          if (t[0] === "extra") Object.assign(q, { ...(t[1] as O), id: q.id, name: q.name, cells: q.cells });
          else if (t[0] === "cell") { const cell: O = { ...((typeof t[5] === "object" ? t[5] : {}) as O), id: t[1], label: t[2], limit: t[4] }; cond(cell, "when", r.cond, ln.n); (q.cells as O[]).push(cell); }
          else err(ln.n, `“${String(t[0])}” is not a quota line`);
          i++;
        }
        quotas.push(q);
        continue;
      }
      if (head === "extra") { rest = toks[1] as O; i++; continue; }
      err(l.n, `“${String(head)}” does not start anything`);
      i++;
    }
  } catch (e) {
    problems.push({ line: lines[i]?.n ?? 0, message: `could not read: ${(e as Error).message}` });
    return { def: null, problems };
  }
  /* question references in the flow: a code, or @id */
  const byCode = new Map(questions.map((q) => [String(q.code), String(q.id)]));
  const resolve = (nodes: O[]) => { for (const n of nodes) { if (Array.isArray(n.questionIds)) n.questionIds = (n.questionIds as string[]).map((r) => (r.startsWith("@") ? r.slice(1) : byCode.get(r) ?? r)); for (const k of ["children", "otherwise"]) if (Array.isArray(n[k])) resolve(n[k] as O[]); for (const b of (n.branches as O[] | undefined) ?? []) resolve(b.children as O[]); } };
  resolve(flow);
  /* conditions written as text need the survey to read them: parse with the questions known, then fill them in */
  /* the expression reader needs the questions (and named expressions, calculations, variables), not a valid survey: the survey cannot be validated until its conditions exist */
  const defaults = safeParse(() => SurveyDefinitionSchema.parse({ meta, questions: [], flow: [] }) as unknown as O) ?? {};
  const draft = { ...defaults, ...rest, meta, questions: questions.map((q) => { const { displayLogic: _d, skipLogic: _s, ...bare } = q; const r = QuestionSchema.safeParse(bare); return r.success ? r.data : q; }), flow: [], quotas: [] } as unknown as SurveyDefinition;
  for (const pc of pendingConds) {
    let res: { condition?: unknown; errors?: { message: string }[] };
    try { res = parseLogicExpression(draft, pc.text) as typeof res; } catch (e) { res = { errors: [{ message: (e as Error).message }] }; }
    if (res.condition === undefined || (res.errors?.length ?? 0) > 0) { problems.push({ line: pc.line, message: `the condition does not read: ${res.errors?.[0]?.message ?? pc.text}` }); continue; }
    pc.at[pc.key] = res.condition;
  }
  if (problems.length) return { def: null, problems };
  const parsed = SurveyDefinitionSchema.safeParse({ ...rest, meta, questions, flow, quotas });
  if (!parsed.success) return { def: null, problems: parsed.error.issues.slice(0, 10).map((x) => ({ line: 0, message: `${x.path.join(".")}: ${x.message}` })) };
  return { def: parsed.data, problems: [] };
}

/* ------------------------------------------------------------------ the review */

/** a unified line diff of two sources: "  " same, "- " removed, "+ " added, with up to `context` unchanged lines around each change */
export function sourceDiff(a: string, b: string, context = 2): string {
  const x = a.split("\n"), y = b.split("\n");
  if (x.length * y.length > 25_000_000) return "The surveys are too large to diff line by line here.";
  const m = x.length, n = y.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ops: [string, string][] = [];
  let i = 0, j = 0;
  while (i < m && j < n) { if (x[i] === y[j]) { ops.push([" ", x[i]!]); i++; j++; } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push(["-", x[i++]!]); else ops.push(["+", y[j++]!]); }
  while (i < m) ops.push(["-", x[i++]!]);
  while (j < n) ops.push(["+", y[j++]!]);
  const keep = ops.map((o, k) => o[0] !== " " || ops.slice(Math.max(0, k - context), k + context + 1).some((p) => p[0] !== " "));
  const out: string[] = [];
  let skipped = false;
  ops.forEach((o, k) => { if (keep[k]) { out.push(`${o[0]} ${o[1]}`); skipped = false; } else if (!skipped) { out.push("  …"); skipped = true; } });
  return ops.some((o) => o[0] !== " ") ? out.join("\n") : "";
}
