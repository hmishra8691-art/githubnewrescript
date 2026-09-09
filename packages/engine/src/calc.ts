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

/**
 * SAFETY BOUNDS (§44).
 *
 * This engine had none. It is a hand-written recursive-descent parser and a
 * recursive interpreter with no depth limit, no node budget and an unbounded
 * parse cache — and two of its callers (`piping.ts` and `scripts.ts`) invoke
 * it without a try/catch, so a pathological expression took the page down
 * rather than reporting a problem.
 *
 * The limits are generous enough that no honest expression meets them: 64
 * levels of nesting is far past what anybody writes by hand, and 20 000
 * evaluation steps is far past what a survey needs. What they catch is a
 * pathological or generated expression, and they catch it as an ERROR with a
 * message rather than as a stack overflow.
 */
const MAX_DEPTH = 64;
const MAX_STEPS = 20_000;
/** Parsed expressions kept. Bounded, because the cache was a slow leak. */
const MAX_CACHE = 500;

function evalNode(n: Node, o: CalcOptions, depth = 0, budget?: { steps: number }): CalcValue {
  const used = budget ?? { steps: 0 };
  if (depth > MAX_DEPTH) {
    throw new Error(`Expression is nested more than ${MAX_DEPTH} levels deep`);
  }
  if ((used.steps += 1) > MAX_STEPS) {
    throw new Error(`Expression did not finish within ${MAX_STEPS} steps`);
  }
  /** every recursive step carries the depth and shares the one step budget */
  const ev = (m: Node) => evalNode(m, o, depth + 1, used);
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
      const a = ev(n.a);
      if (n.op === "-") return -toNum(a);
      return !truthy(a);
    }
    case "bin": {
      if (n.op === "and") return truthy(ev(n.a)) && truthy(ev(n.b));
      if (n.op === "or") return truthy(ev(n.a)) || truthy(ev(n.b));
      const a = ev(n.a);
      const b = ev(n.b);
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
      const rawArgs = n.args.map((a) => ev(a));
      const flat = () => flattenArgs(rawArgs).filter((v) => v !== null && v !== "");
      const nums = () => flat().map(toNum);
      switch (n.name) {
        case "sum": return nums().reduce((a, b) => a + b, 0);
        case "avg": case "mean": case "average": {
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
        case "ceil": case "ceiling": return Math.ceil(toNum(rawArgs[0]));
        case "sqrt": return Math.sqrt(toNum(rawArgs[0]));
        case "pow": return Math.pow(toNum(rawArgs[0]), toNum(rawArgs[1]));
        case "if": return truthy(rawArgs[0]) ? rawArgs[1] ?? null : rawArgs[2] ?? null;
        case "coalesce": return rawArgs.find((v) => v !== null && v !== "") ?? null;
        case "len": case "length": {
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

        /*
         * String functions (§18). They live here rather than in a new engine
         * because this is where every other function already lives — a
         * calculation and a condition then spell them the same way, which is
         * the whole point of the shared language.
         */
        case "upper": return String(rawArgs[0] ?? "").toUpperCase();
        case "lower": return String(rawArgs[0] ?? "").toLowerCase();
        case "trim": return String(rawArgs[0] ?? "").trim();
        case "substring": case "substr": {
          const str = String(rawArgs[0] ?? "");
          const from = Math.max(0, Math.floor(toNum(rawArgs[1])));
          /* two args means "from here to the end", as every other language does */
          return rawArgs.length >= 3
            ? str.slice(from, from + Math.max(0, Math.floor(toNum(rawArgs[2]))))
            : str.slice(from);
        }
        case "replace": {
          /*
           * Every occurrence, and a LITERAL needle — not a regex. A programmer
           * typing replace(Q1, ".", "") means the full stop, and a silently
           * regex-flavoured argument would quietly delete the whole string.
           */
          const hay = String(rawArgs[0] ?? "");
          const needle = String(rawArgs[1] ?? "");
          const with_ = String(rawArgs[2] ?? "");
          return needle === "" ? hay : hay.split(needle).join(with_);
        }
        case "startswith": return String(rawArgs[0] ?? "").startsWith(String(rawArgs[1] ?? ""));
        case "endswith": return String(rawArgs[0] ?? "").endsWith(String(rawArgs[1] ?? ""));
        case "regex": case "matches": {
          /*
           * `REGEX(Q1, "^[A-Z]{2}\\d{4}$")` — the spelling a programmer
           * reaches for in a custom validation expression. The `matches`
           * condition operator does the same job in the visual builder; this
           * makes the function form work too, rather than throwing "Unknown
           * function" into a catch that turned the whole rule into a no-op.
           * A malformed pattern is false, not an exception.
           */
          try {
            return new RegExp(String(rawArgs[1] ?? "")).test(String(rawArgs[0] ?? ""));
          } catch { return false; }
        }

        /*
         * Date functions. Research questionnaires are full of rules the rest
         * of this language could not say at all — "must be 18 on the day they
         * take the survey", "not in the future", "within the next year", "at
         * least 365 days after the previous answer". Each was previously
         * expressible only by pre-computing a cutoff into a calculated
         * variable, which meant the common case needed setup that the author
         * had no reason to expect.
         *
         * They live in this switch, like every other function, so a
         * calculation, a display condition, a mask and a validation rule all
         * spell them identically — the whole reason there is one language.
         *
         * Dates are compared as whole days in UTC: a survey is answered in
         * every timezone, and an age that flickers by hour of day would be a
         * worse bug than the one being fixed.
         */
        case "today": return utcMidnightToday();
        case "date": {
          const t = parseDateValue(rawArgs[0]);
          return t == null ? null : t;
        }
        case "datediff": {
          // datediff(later, earlier) -> whole days, negative if reversed
          const a = parseDateValue(rawArgs[0]);
          const b = parseDateValue(rawArgs[1]);
          if (a == null || b == null) return null;
          return Math.round((a - b) / 86_400_000);
        }
        case "age": {
          // age(dob) as of today, or age(dob, asOf) — calendar years, not /365
          const dob = parseDateValue(rawArgs[0]);
          if (dob == null) return null;
          const asOf = rawArgs.length > 1 ? parseDateValue(rawArgs[1]) : utcMidnightToday();
          if (asOf == null) return null;
          return calendarYearsBetween(dob, asOf);
        }
        case "dateadd": {
          // dateadd(date, days) -> a date, so it can feed a comparison
          const base = parseDateValue(rawArgs[0]);
          if (base == null) return null;
          return base + Math.round(toNum(rawArgs[1])) * 86_400_000;
        }
        case "year": case "month": case "day": {
          const t = parseDateValue(rawArgs[0]);
          if (t == null) return null;
          const d = new Date(t);
          return n.name.toLowerCase() === "year" ? d.getUTCFullYear()
            : n.name.toLowerCase() === "month" ? d.getUTCMonth() + 1
            : d.getUTCDate();
        }
        default:
          throw new Error(`Unknown function ${n.name}()`);
      }
    }
  }
}

/**
 * Every function this engine implements.
 *
 * Exported because two other places need to know the list and both had their
 * own copy: `embedded.ts` kept a hand-written duplicate to tell a function
 * name from a variable name, and the logic expression parser needs to know
 * which identifiers introduce a call. Three lists, nothing keeping them in
 * step — so a function added here was invisible to the other two, which is
 * exactly what happened to `upper`, `trim` and the rest.
 */
export const CALC_FUNCTION_NAMES: readonly string[] = [
  "sum", "avg", "mean", "average", "min", "max", "count", "countif",
  "pct", "percent", "weighted", "round", "abs", "floor", "ceil", "ceiling",
  "sqrt", "pow", "if", "coalesce", "len", "length", "concat", "contains",
  "number", "text", "upper", "lower", "trim", "substring", "substr",
  "replace", "startswith", "endswith",
  "today", "date", "datediff", "age", "dateadd", "year", "month", "day",
  "regex", "matches",
];

/** Midnight today, UTC — the reference point every relative date rule uses. */
function utcMidnightToday(): number {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}

/**
 * A date value as a UTC-midnight timestamp, from whatever a question stored.
 *
 * Accepts an ISO date, anything `Date.parse` understands, and a timestamp
 * that is already a number. Returns null rather than NaN for everything else,
 * so a date function on an unanswered or non-date question yields null and
 * the surrounding comparison is false — the same fail-closed rule the rest of
 * the evaluator follows, instead of `toNum`'s silent coercion of a date
 * string to 0, which made `Q97 - Q98` evaluate to 0 and look like a
 * legitimate answer.
 */
function parseDateValue(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim();
  // a bare YYYY-MM-DD must not drift by timezone, so pin it to UTC explicitly
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Completed calendar years from `from` to `to` — birthday-aware, not /365. */
function calendarYearsBetween(from: number, to: number): number {
  const a = new Date(from);
  const b = new Date(to);
  let years = b.getUTCFullYear() - a.getUTCFullYear();
  const beforeBirthday =
    b.getUTCMonth() < a.getUTCMonth() ||
    (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate());
  if (beforeBirthday) years--;
  return years;
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
