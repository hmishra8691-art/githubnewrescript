/**
 * Structured piping tokens (req §23).
 *
 * On disk a pipe is still the familiar `{{Q1.label|and}}` string — that keeps
 * every existing survey, export and custom script working untouched. This
 * module is the structured view of that string: parse it into a descriptor,
 * edit the descriptor, serialise it back. The visual piping builder and the
 * token chips in the rich-text editor work on descriptors, never on raw text,
 * so a pipe stays editable instead of turning into fragile hand-typed syntax.
 */

/**
 * Unchanged from the original implementation on purpose: surrounding
 * whitespace is trimmed, which means `|join:, ` has always meant `","`.
 * Preserving that keeps every existing survey's piped output byte-identical.
 * Use `|and`, `|or`, `|lines` or `|bullets` for spaced, readable lists.
 */
/*
 * A token body may CONTAIN `{{…}}` references, one level deep, so
 * `{{expr: {{ed.A}} + {{ed.B}} * 2}}` is one token. Without that the lazy
 * match ended at the first `}}`, took `expr: {{ed.A` as the token and left
 * ` + {{ed.B}} * 2}}` behind as literal text — the stray fragments that
 * showed up in preview. A lone `{` that does not open a `{{` is still plain
 * text inside a body, exactly as before.
 */
export const PIPE_TOKEN_RE = /\{\{\s*((?:[^{}]|\{(?!\{)|\{\{[^{}]*\}\})+?)\s*\}\}/g;

/** Where a pipe reads from. */
export type PipeKind = "question" | "calc" | "embedded" | "loop" | "expr" | "system";

/**
 * SYSTEM SOURCES (document 15/10/2026, item C) — values the platform itself
 * knows, piped with the same `{{…}}` syntax as everything else:
 *
 *   {{survey.id}} {{survey.code}} {{survey.name}} {{survey.version}}
 *   {{response.id}} {{response.respondent_id}} {{response.language}} {{response.status}}
 *   {{date.today}} {{date.now}} {{date.time}} {{date.start_date}} {{date.start_time}} {{date.start}}
 *   {{date.day}} {{date.month}} {{date.month_name}} {{date.year}} {{date.weekday}}
 *   {{date.timezone}} {{date.unix}} {{date.iso}}           — with |fmt:DD/MM/YYYY, |fmt:hh:mm A …
 *   {{device.type}} {{device.os}} {{device.browser}} {{device.screen}} {{device.viewport}}
 *   {{device.language}} {{device.user_agent}}
 *   {{distribution.channel}} {{distribution.link_type}}
 *   {{quota.<id or name>.count|limit|remaining|percent|status|name|cell}}
 *   {{random.int(1,100)}} {{random.decimal(0,1,2)}} {{random.pick(A,B,C)}}
 *   {{random.id(8)}} {{random.bool}} {{random.uuid}}       — with |per:respondent|session|loop|each
 *
 * Recognised only for these exact names, so `{{date.label}}` on a question
 * coded `date` is still that question — and the runtime checks again: a
 * question whose code is the namespace wins (`piping.ts`). Resolution lives
 * in `systemPipes.ts`.
 */
export const SYSTEM_PIPE_KEYS: Record<string, readonly string[]> = {
  survey: ["id", "code", "name", "version"],
  response: ["id", "respondent_id", "language", "status"],
  date: ["today", "now", "time", "start_date", "start_time", "start", "day", "month", "month_name", "year", "weekday", "timezone", "unix", "iso"],
  device: ["type", "os", "browser", "screen", "viewport", "language", "user_agent"],
  distribution: ["channel", "link_type"],
};
export const QUOTA_PIPE_PROPS = ["count", "limit", "remaining", "percent", "status", "name", "id", "cell"] as const;
export const RANDOM_PIPE_KINDS = ["int", "decimal", "pick", "id", "bool", "uuid"] as const;
export type RandomPersistence = "respondent" | "session" | "loop" | "each";
const RANDOM_RE = /^random\.(int|decimal|pick|id|bool|uuid)(?:\((.*)\))?$/;
const QUOTA_RE = /^quota\.(.+)\.([a-z_]+)$/;

/** Is `body` (the text before any `|`) a system source? */
export function isSystemPipeRef(body: string): boolean {
  const b = body.trim();
  if (RANDOM_RE.test(b)) return true;
  const q = QUOTA_RE.exec(b);
  if (q) return (QUOTA_PIPE_PROPS as readonly string[]).includes(q[2]);
  const dot = b.indexOf(".");
  if (dot < 0) return false;
  return SYSTEM_PIPE_KEYS[b.slice(0, dot)]?.includes(b.slice(dot + 1)) ?? false;
}

/** The parts of a `random.*` source; null when `ref` is not one. */
export function parseRandomRef(ref: string): { kind: (typeof RANDOM_PIPE_KINDS)[number]; args: string[] } | null {
  const m = RANDOM_RE.exec(ref.trim());
  if (!m) return null;
  const args = m[2] === undefined ? [] : m[2].split(",").map((a) => a.trim()).filter((a, i, all) => a !== "" || all.length > 1);
  return { kind: m[1] as (typeof RANDOM_PIPE_KINDS)[number], args };
}

/** The parts of a `quota.*` source; null when `ref` is not one. */
export function parseQuotaRef(ref: string): { quota: string; prop: (typeof QUOTA_PIPE_PROPS)[number] } | null {
  const m = QUOTA_RE.exec(ref.trim());
  if (!m || !(QUOTA_PIPE_PROPS as readonly string[]).includes(m[2])) return null;
  return { quota: m[1], prop: m[2] as (typeof QUOTA_PIPE_PROPS)[number] };
}

/**
 * Why a system token cannot resolve in this survey, or null. Pure: the
 * builder's warning and the linter say the same thing.
 */
export function systemPipeProblem(
  t: Pick<PipeToken, "ref" | "fmt" | "per">,
  def: { quotas?: { id: string; name: string }[] },
): string | null {
  const rnd = parseRandomRef(t.ref);
  if (rnd) {
    const nums = rnd.args.map(Number);
    if ((rnd.kind === "int" || rnd.kind === "decimal") && rnd.args.length >= 2) {
      if (nums.slice(0, 2).some((n) => !Number.isFinite(n))) return `${t.ref}: the minimum and maximum must be numbers`;
      if (nums[0] > nums[1]) return `${t.ref}: the minimum is larger than the maximum`;
    }
    if (rnd.kind === "decimal" && rnd.args.length >= 3 && !(Number.isInteger(nums[2]) && nums[2] >= 0 && nums[2] <= 10)) return `${t.ref}: decimal places must be 0–10`;
    if (rnd.kind === "pick" && rnd.args.length === 0) return `${t.ref}: list the values to pick from, e.g. random.pick(A,B,C)`;
    if (rnd.kind === "id" && rnd.args.length && !(Number.isInteger(nums[0]) && nums[0] >= 1 && nums[0] <= 64)) return `${t.ref}: the id length must be 1–64`;
    if (t.per && !["respondent", "session", "loop", "each"].includes(t.per)) return `${t.ref}: "per:${t.per}" — use per:respondent, per:session, per:loop or per:each`;
    return null;
  }
  const q = parseQuotaRef(t.ref);
  if (q) {
    const wanted = q.quota.toLowerCase();
    if (!(def.quotas ?? []).some((x) => x.id.toLowerCase() === wanted || x.name.toLowerCase() === wanted)) return `No quota named "${q.quota}"`;
  }
  return null;
}

/** What it reads. Only some are valid for a given kind — see PIPE_PROPERTIES. */
export type PipeProperty =
  | "label" // option label(s) of the answer — the default
  | "labels"
  | "value" // stored code(s) / raw value
  | "code"
  | "count" // number of selections
  | "first"
  | "last"
  | "rank" // ordered labels of a ranking answer
  | "displayed" // options the question actually showed
  | "remaining" // options shown but not selected
  /*
   * ONE "other, specify" BOX'S OWN TEXT.
   *
   *   {{Q1.other}}       the first flagged option's box
   *   {{Q1[97].other}}   option 97's box, specifically
   *
   * The option code goes in the `[...]` slot the grammar already has for a
   * matrix row, because it is the same idea — "which part of this question's
   * answer" — and reusing it meant the parser needed no new syntax. A
   * question with three Other boxes has three different answers in it, and
   * before this there was no way to pipe any of them: the flat-map fallback
   * reached one shared column, so all three sentences read "Apple".
   */
  | "other"
  // a `geo` answer's parts (piping.ts); the default for a geo question is the address or "lat,lng"
  | "lat" | "lng" | "address" | "city" | "country" | "radius";

/** How multi-value results are rendered (req §25). */
export type PipeFormat =
  | "comma" // Apple, Orange, Banana   (default)
  | "and" // Apple, Orange and Banana
  | "or" // Apple, Orange or Banana
  | "bullets" // • Apple ⏎ • Orange
  | "numbered" // 1. Apple ⏎ 2. Orange
  | "lines" // one per line
  | "upper"
  | "lower"
  | "title"
  | "image"; // the value is a URL — shown as the picture it points to

export interface PipeToken {
  kind: PipeKind;
  /**
   * question code / variable name / calc name / embedded field / expression —
   * or, for `loop`, `code` / `label` / `index` / `count` / a reference column
   */
  ref: string;
  /**
   * For `loop` inside nested loops: the loopVar of the loop meant. Absent is
   * the innermost. Serialises as `{{<scope>.<ref>}}`, which the parser reads
   * back as a question token — the runtime tells them apart by whether a
   * question of that code exists, and the Studio builder by knowing the loops.
   */
  scope?: string;
  /** matrix or composite row */
  rowCode?: string;
  property: PipeProperty;
  format?: PipeFormat;
  /** custom joiner from `|join:…` */
  joiner?: string;
  /** a date / time pattern from `|fmt:…` (system date sources) */
  fmt?: string;
  /** how long a `random.*` value lasts, from `|per:…` (default: respondent) */
  per?: RandomPersistence;
  /** a name that makes two identical `random.*` tokens draw independently, from `|key:…` */
  key?: string;
  /** the inner text exactly as written */
  raw: string;
  /** the full `{{…}}` source */
  text: string;
}

export const PIPE_PROPERTIES: { value: PipeProperty; label: string; multiOnly?: boolean }[] = [
  { value: "label", label: "Selected option label" },
  { value: "value", label: "Selected option value / code" },
  { value: "labels", label: "All selected labels", multiOnly: true },
  { value: "count", label: "Number of selections", multiOnly: true },
  { value: "first", label: "First selected", multiOnly: true },
  { value: "last", label: "Last selected", multiOnly: true },
  { value: "rank", label: "Ranking order", multiOnly: true },
  { value: "displayed", label: "Options displayed", multiOnly: true },
  { value: "remaining", label: "Options not selected", multiOnly: true },
  /*
   * Offered in the builder, not just documented. A pipe nobody can find in
   * the picker is a pipe nobody uses — and "what did they type into Other"
   * is the single most asked-for follow-up in qualitative work.
   */
  { value: "other", label: "“Other, specify” text" },
];

export const PIPE_FORMATS: { value: PipeFormat; label: string; example: string }[] = [
  { value: "comma", label: "Comma separated", example: "Apple, Orange, Banana" },
  { value: "and", label: "“and” list", example: "Apple, Orange and Banana" },
  { value: "or", label: "“or” list", example: "Apple, Orange or Banana" },
  { value: "bullets", label: "Bulleted list", example: "• Apple • Orange" },
  { value: "numbered", label: "Numbered list", example: "1. Apple 2. Orange" },
  { value: "lines", label: "One per line", example: "Apple ⏎ Orange" },
  { value: "upper", label: "UPPERCASE", example: "APPLE" },
  { value: "lower", label: "lowercase", example: "apple" },
  { value: "title", label: "Title Case", example: "Apple" },
  { value: "image", label: "Show as image", example: "a URL becomes the picture it points to" },
];

const FORMAT_NAMES = new Set(PIPE_FORMATS.map((f) => f.value));

/** Parse one token body (the text between the braces). */
export function parsePipeBody(raw: string, text = `{{${raw}}}`): PipeToken | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("expr:")) {
    return { kind: "expr", ref: trimmed.slice(5).trim(), property: "value", raw, text };
  }

  const parts = trimmed.split("|");
  const body = parts[0].trim();
  let format: PipeFormat | undefined;
  let joiner: string | undefined;
  let fmt: string | undefined;
  let per: RandomPersistence | undefined;
  let key: string | undefined;
  for (let i = 1; i < parts.length; i++) {
    const mod = parts[i].trim();
    if (mod.startsWith("join:")) {
      // a joiner runs to the end of the token, so `join:a|b` stays "a|b"
      joiner = parts.slice(i).join("|").trim().slice(5);
      break;
    }
    if (FORMAT_NAMES.has(mod as PipeFormat)) format = mod as PipeFormat;
    else if (mod.startsWith("fmt:")) fmt = mod.slice(4).trim();
    else if (mod.startsWith("per:")) per = mod.slice(4).trim() as RandomPersistence;
    else if (mod.startsWith("key:")) key = mod.slice(4).trim();
  }

  if (isSystemPipeRef(body)) {
    return { kind: "system", ref: body, property: "value", format, joiner, fmt, per, key, raw, text };
  }

  if (body.startsWith("calc.")) {
    return { kind: "calc", ref: body.slice(5), property: "value", format, joiner, raw, text };
  }
  if (body.startsWith("ed.") || body.startsWith("embedded.")) {
    return {
      kind: "embedded",
      ref: body.split(".").slice(1).join("."),
      property: "value",
      format,
      joiner,
      raw,
      text,
    };
  }
  if (body.startsWith("loop.")) {
    return { kind: "loop", ref: body.slice(5), property: "value", format, joiner, raw, text };
  }
  /*
   * The requirement's spelling of the current item (§19, §21): `{{CURRENT_ITEM}}`,
   * `{{CURRENT_ITEM.Product_ID}}`, `{{CURRENT_ITEM_CODE}}`, `{{CURRENT_ITEM_LABEL}}`,
   * `{{LOOP_INDEX}}`, `{{LOOP_COUNT}}`. Aliases of `loop.*`, not a second
   * mechanism — they parse to the same token the runtime already resolves.
   */
  const alias = body.match(/^CURRENT_ITEM(?:\.([A-Za-z_][A-Za-z0-9_]*))?$/);
  if (alias) {
    return { kind: "loop", ref: alias[1] ?? "label", property: "value", format, joiner, raw, text };
  }
  const fixedAlias: Record<string, string> = {
    CURRENT_ITEM_CODE: "code", CURRENT_ITEM_LABEL: "label", LOOP_INDEX: "index", LOOP_COUNT: "count",
    LOOP_FIRST: "first", LOOP_LAST: "last", LOOP_DEPTH: "depth",
  };
  if (fixedAlias[body]) {
    return { kind: "loop", ref: fixedAlias[body], property: "value", format, joiner, raw, text };
  }

  const m = body.match(/^([A-Za-z0-9_]+)(?:\[([^\]]+)\])?(?:\.([A-Za-z_]+))?$/);
  if (!m) return null;
  return {
    kind: "question",
    ref: m[1],
    rowCode: m[2] || undefined,
    property: (m[3] as PipeProperty) || "label",
    format,
    joiner,
    raw,
    text,
  };
}

/** Serialise a descriptor back into `{{…}}` source. */
export function serializePipeToken(t: Omit<PipeToken, "raw" | "text">): string {
  let body: string;
  switch (t.kind) {
    case "calc":
      body = `calc.${t.ref}`;
      break;
    case "embedded":
      body = `ed.${t.ref}`;
      break;
    case "loop":
      // a scoped token names the outer loop by its loopVar: {{brand.Category}}
      body = t.scope ? `${t.scope}.${t.ref}` : `loop.${t.ref}`;
      break;
    case "expr":
      body = `expr: ${t.ref}`;
      break;
    case "system":
      body = t.ref;
      break;
    case "question":
    default:
      body = t.ref + (t.rowCode ? `[${t.rowCode}]` : "") + (t.property ? `.${t.property}` : "");
      break;
  }
  const mods: string[] = [];
  if (t.format && t.format !== "comma") mods.push(t.format);
  if (t.fmt) mods.push(`fmt:${t.fmt}`);
  if (t.per && t.per !== "respondent") mods.push(`per:${t.per}`);
  if (t.key) mods.push(`key:${t.key}`);
  // last: a joiner runs to the end of the token
  if (t.joiner) mods.push(`join:${t.joiner}`);
  return `{{${body}${mods.length ? `|${mods.join("|")}` : ""}}}`;
}

/** Every token in a piece of text, in order. */
export function pipeTokensIn(text: string): PipeToken[] {
  if (!text || !text.includes("{{")) return [];
  const out: PipeToken[] = [];
  for (const m of text.matchAll(PIPE_TOKEN_RE)) {
    const t = parsePipeBody(m[1], m[0]);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Case transforms run on visible text only: parts arrive already escaped and
 * may carry programmer formatting, so uppercasing the raw string would turn
 * `&amp;` into `&AMP;` and `<b>` into `<B>`.
 */
function mapVisibleText(s: string, fn: (t: string) => string): string {
  return s
    .split(/(<[^>]*>|&[A-Za-z#0-9]+;)/g)
    .map((p) => (p.startsWith("<") || (p.startsWith("&") && p.endsWith(";")) ? p : fn(p)))
    .join("");
}

/** Apply a display format to already-rendered parts (req §25). */
export function formatPipeValues(
  parts: string[],
  format: PipeFormat | undefined,
  joiner = ", ",
): string {
  if (parts.length === 0) return "";
  switch (format) {
    case "and":
    case "or": {
      const word = format === "and" ? "and" : "or";
      if (parts.length === 1) return parts[0];
      return `${parts.slice(0, -1).join(", ")} ${word} ${parts[parts.length - 1]}`;
    }
    case "bullets":
      return `<ul>${parts.map((p) => `<li>${p}</li>`).join("")}</ul>`;
    case "numbered":
      return `<ol>${parts.map((p) => `<li>${p}</li>`).join("")}</ol>`;
    case "lines":
      return parts.join("<br>");
    case "upper":
      return mapVisibleText(parts.join(joiner), (t) => t.toUpperCase());
    case "lower":
      return mapVisibleText(parts.join(joiner), (t) => t.toLowerCase());
    case "title":
      return mapVisibleText(parts.join(joiner), (t) =>
        t.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
      );
    case "comma":
    default:
      return parts.join(joiner);
  }
}

/** Short human label for a token, used by the editor chips. */
export function describePipeToken(t: PipeToken, codeFor?: (ref: string) => string): string {
  const name = t.kind === "question" ? (codeFor?.(t.ref) ?? t.ref) : t.ref;
  const prop = PIPE_PROPERTIES.find((p) => p.value === t.property)?.label;
  switch (t.kind) {
    case "calc":
      return `calc: ${name}`;
    case "embedded":
      return `data: ${name}`;
    case "loop":
      return `loop: ${name}`;
    case "expr":
      return `= ${name}`;
    case "system":
      return `${name}${t.fmt ? ` (${t.fmt})` : ""}`;
    default:
      return `${name}${t.rowCode ? `[${t.rowCode}]` : ""} → ${prop ?? t.property}`;
  }
}
