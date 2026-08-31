/**
 * Calculation engine (requirement §14) — a safe expression DSL.
 * No eval(): a hand-written recursive-descent parser + interpreter.
 *
 * Examples:
 *   Q1 + Q2 + Q3
 *   pct(SCORE, 200)
 *   sum(ALLOC_*)                     — wildcard over the flat variable map
 *   countif(RATING_*, ">", 3)
 *   if(TOTAL > 100, "high", "low")
 *   avg(Q10_1, Q10_2, Q10_3) * 1.5
 *   weighted(Q1, 0.5, Q2, 0.3, Q3, 0.2)
 */

export type CalcValue = number | string | boolean | null | CalcValue[];
export type VarResolver = (name: string) => unknown;

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "comma" };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
  const isId = (c: string) => /[A-Za-z0-9_.*]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      toks.push({ t: "num", v: parseFloat(src.slice(i, j)) });
      i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") { s += src[j + 1]; j += 2; } else { s += src[j]; j++; }
      }
      toks.push({ t: "str", v: s });
      i = j + 1; continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < src.length && isId(src[j])) j++;
      const word = src.slice(i, j);
      const lower = word.toLowerCase();
      if (lower === "and" || lower === "or" || lower === "not") toks.push({ t: "op", v: lower });
      else if (lower === "true") toks.push({ t: "num", v: 1 });
      else if (lower === "false") toks.push({ t: "num", v: 0 });
      else toks.push({ t: "id", v: word });
      i = j; continue;
    }
    if (c === "(") { toks.push({ t: "lparen" }); i++; continue; }
    if (c === ")") { toks.push({ t: "rparen" }); i++; continue; }
    if (c === ",") { toks.push({ t: "comma" }); i++; continue; }
    const two = src.slice(i, i + 2);
    if (["==", "!=", ">=", "<=", "&&", "||"].includes(two)) {
      toks.push({ t: "op", v: two }); i += 2; continue;
    }
    if ("+-*/%<>!=".includes(c)) { toks.push({ t: "op", v: c }); i++; continue; }
    throw new Error(`Unexpected character '${c}' in expression at ${i}`);
  }
  return toks;
}

type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "var"; name: string }
  | { k: "call"; name: string; args: Node[] }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node };

class Parser {
  private pos = 0;
  constructor(private toks: Tok[]) {}
  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok | undefined { return this.toks[this.pos++]; }
  private expect(t: Tok["t"]): Tok {
    const tok = this.next();
    if (!tok || tok.t !== t) throw new Error(`Expected ${t}`);
    return tok;
  }

  parse(): Node {
    const n = this.parseOr();
    if (this.pos < this.toks.length) throw new Error("Unexpected trailing tokens");
    return n;
  }
  private parseOr(): Node {
    let a = this.parseAnd();
    while (this.peek()?.t === "op" && ["or", "||"].includes((this.peek() as any).v)) {
      this.next();
      a = { k: "bin", op: "or", a, b: this.parseAnd() };
    }
    return a;
  }
  private parseAnd(): Node {
    let a = this.parseCmp();
    while (this.peek()?.t === "op" && ["and", "&&"].includes((this.peek() as any).v)) {
      this.next();
      a = { k: "bin", op: "and", a, b: this.parseCmp() };
    }
    return a;
  }
  private parseCmp(): Node {
    let a = this.parseAdd();
    const p = this.peek();
    if (p?.t === "op" && ["==", "!=", ">", "<", ">=", "<=", "="].includes(p.v)) {
      this.next();
      const op = p.v === "=" ? "==" : p.v;
      a = { k: "bin", op, a, b: this.parseAdd() };
    }
    return a;
  }
  private parseAdd(): Node {
    let a = this.parseMul();
    while (this.peek()?.t === "op" && ["+", "-"].includes((this.peek() as any).v)) {
      const op = (this.next() as any).v;
      a = { k: "bin", op, a, b: this.parseMul() };
    }
    return a;
  }
  private parseMul(): Node {
    let a = this.parseUnary();
    while (this.peek()?.t === "op" && ["*", "/", "%"].includes((this.peek() as any).v)) {
      const op = (this.next() as any).v;
      a = { k: "bin", op, a, b: this.parseUnary() };
    }
    return a;
  }
  private parseUnary(): Node {
    const p = this.peek();
    if (p?.t === "op" && ["-", "!", "not"].includes(p.v)) {
      this.next();
      return { k: "un", op: p.v === "not" ? "!" : p.v, a: this.parseUnary() };
    }
    return this.parsePrimary();
  }
  private parsePrimary(): Node {
    const tok = this.next();
    if (!tok) throw new Error("Unexpected end of expression");
    if (tok.t === "num") return { k: "num", v: tok.v };
    if (tok.t === "str") return { k: "str", v: tok.v };
    if (tok.t === "lparen") {
      const inner = this.parseOr();
      this.expect("rparen");
      return inner;
    }
    if (tok.t === "id") {
      if (this.peek()?.t === "lparen") {
        this.next();
        const args: Node[] = [];
        if (this.peek()?.t !== "rparen") {
          args.push(this.parseOr());
          while (this.peek()?.t === "comma") {
            this.next();
            args.push(this.parseOr());
          }
        }
        this.expect("rparen");
        return { k: "call", name: tok.v.toLowerCase(), args };
      }
      return { k: "var", name: tok.v };
    }
    throw new Error(`Unexpected token in expression`);
  }
}

function toNum(v: CalcValue): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (Array.isArray(v)) return v.length;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function truthy(v: CalcValue): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return !!v && v !== "0";
}

function resolveWildcard(pattern: string, vars: VarResolver, allNames: () => string[]): CalcValue[] {
  const re = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
  );
  const out: CalcValue[] = [];
  for (const name of allNames()) {
    if (re.test(name)) {
      const v = vars(name);
      if (v !== undefined && v !== null && v !== "") out.push(v as CalcValue);
    }
  }
  return out;
}

function flattenArgs(vals: CalcValue[]): CalcValue[] {
  const out: CalcValue[] = [];
  for (const v of vals) {
    if (Array.isArray(v)) out.push(...flattenArgs(v as CalcValue[]));
    else out.push(v);
  }
  return out;
}

function cmp(op: string, l: number, r: number): boolean {
  switch (op) {
    case ">": return l > r;
    case "<": return l < r;
    case ">=": return l >= r;
    case "<=": return l <= r;
    case "==": case "=": return l === r;
    case "!=": return l !== r;
    default: return false;
  }
}

export interface CalcOptions {
  resolver: VarResolver;
  /** enumerate names for wildcard patterns */
  names?: () => string[];
}

function evalNode(n: Node, o: CalcOptions): CalcValue {
  switch (n.k) {
    case "num": return n.v;
    case "str": return n.v;
    case "var": {
      if (n.name.includes("*")) {
        return resolveWildcard(n.name, o.resolver, o.names ?? (() => []));
      }
      const v = o.resolver(n.name);
      return (v === undefined ? null : (v as CalcValue));
    }
    case "un": {
      const a = evalNode(n.a, o);
      if (n.op === "-") return -toNum(a);
      return !truthy(a);
    }
    case "bin": {
      if (n.op === "and") return truthy(evalNode(n.a, o)) && truthy(evalNode(n.b, o));
      if (n.op === "or") return truthy(evalNode(n.a, o)) || truthy(evalNode(n.b, o));
      const a = evalNode(n.a, o);
      const b = evalNode(n.b, o);
      switch (n.op) {
        case "+":
          if (typeof a === "string" || typeof b === "string") return String(a ?? "") + String(b ?? "");
          return toNum(a) + toNum(b);
        case "-": return toNum(a) - toNum(b);
        case "*": return toNum(a) * toNum(b);
        case "/": {
          const d = toNum(b);
          return d === 0 ? null : toNum(a) / d;
        }
        case "%": {
          const d = toNum(b);
          return d === 0 ? null : toNum(a) % d;
        }
        case "==": return typeof a === "string" || typeof b === "string"
          ? String(a) === String(b)
          : toNum(a) === toNum(b);
        case "!=": return typeof a === "string" || typeof b === "string"
          ? String(a) !== String(b)
          : toNum(a) !== toNum(b);
        case ">": case "<": case ">=": case "<=":
          return cmp(n.op, toNum(a), toNum(b));
        default: throw new Error(`Unknown operator ${n.op}`);
      }
    }
    case "call": {
      const rawArgs = n.args.map((a) => evalNode(a, o));
      const flat = () => flattenArgs(rawArgs).filter((v) => v !== null && v !== "");
      const nums = () => flat().map(toNum);
      switch (n.name) {
        case "sum": return nums().reduce((a, b) => a + b, 0);
        case "avg": case "mean": {
          const ns = nums();
          return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
        }
        case "min": { const ns = nums(); return ns.length ? Math.min(...ns) : null; }
        case "max": { const ns = nums(); return ns.length ? Math.max(...ns) : null; }
        case "count": return flat().length;
        case "countif": {
          // countif(values..., op, value) — last two args are op + comparison value
          const all = rawArgs;
          const opArg = String(all[all.length - 2] ?? "==");
          const cmpVal = toNum(all[all.length - 1] as CalcValue);
          const values = flattenArgs(all.slice(0, -2)).filter((v) => v !== null && v !== "");
          return values.filter((v) => cmp(opArg, toNum(v), cmpVal)).length;
        }
        case "pct": case "percent": {
          const part = toNum(rawArgs[0]);
          const whole = toNum(rawArgs[1]);
          return whole === 0 ? null : (part / whole) * 100;
        }
        case "weighted": {
          // weighted(v1, w1, v2, w2, ...)
          let total = 0;
          for (let i = 0; i + 1 < rawArgs.length; i += 2) {
            total += toNum(rawArgs[i]) * toNum(rawArgs[i + 1]);
          }
          return total;
        }
        case "round": {
          const d = rawArgs.length > 1 ? toNum(rawArgs[1]) : 0;
          const f = 10 ** d;
          return Math.round(toNum(rawArgs[0]) * f) / f;
        }
        case "abs": return Math.abs(toNum(rawArgs[0]));
        case "floor": return Math.floor(toNum(rawArgs[0]));
        case "ceil": return Math.ceil(toNum(rawArgs[0]));
        case "sqrt": return Math.sqrt(toNum(rawArgs[0]));
        case "pow": return Math.pow(toNum(rawArgs[0]), toNum(rawArgs[1]));
        case "if": return truthy(rawArgs[0]) ? rawArgs[1] ?? null : rawArgs[2] ?? null;
        case "coalesce": return rawArgs.find((v) => v !== null && v !== "") ?? null;
        case "len": {
          const v = rawArgs[0];
          return Array.isArray(v) ? v.length : String(v ?? "").length;
        }
        case "concat": return rawArgs.map((v) => String(v ?? "")).join("");
        case "contains": {
          const hay = rawArgs[0];
          const needle = rawArgs[1];
          return Array.isArray(hay)
            ? hay.some((h) => String(h) === String(needle))
            : String(hay ?? "").includes(String(needle ?? ""));
        }
        case "number": return toNum(rawArgs[0]);
        case "text": return String(rawArgs[0] ?? "");
        default:
          throw new Error(`Unknown function ${n.name}()`);
      }
    }
  }
}

const parseCache = new Map<string, Node>();

export function evaluateExpression(expression: string, opts: CalcOptions): CalcValue {
  let ast = parseCache.get(expression);
  if (!ast) {
    ast = new Parser(tokenize(expression)).parse();
    parseCache.set(expression, ast);
  }
  return evalNode(ast, opts);
}

/** Validate an expression parses; returns error message or null. */
export function validateExpression(expression: string): string | null {
  try {
    new Parser(tokenize(expression)).parse();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
