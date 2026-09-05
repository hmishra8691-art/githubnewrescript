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
export const PIPE_TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Where a pipe reads from. */
export type PipeKind = "question" | "calc" | "embedded" | "loop" | "expr";

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
  | "remaining"; // options shown but not selected

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
  | "title";

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
  for (let i = 1; i < parts.length; i++) {
    const mod = parts[i].trim();
    if (mod.startsWith("join:")) {
      // a joiner runs to the end of the token, so `join:a|b` stays "a|b"
      joiner = parts.slice(i).join("|").trim().slice(5);
      break;
    }
    if (FORMAT_NAMES.has(mod as PipeFormat)) format = mod as PipeFormat;
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
    case "question":
    default:
      body = t.ref + (t.rowCode ? `[${t.rowCode}]` : "") + (t.property ? `.${t.property}` : "");
      break;
  }
  const mods: string[] = [];
  if (t.format && t.format !== "comma") mods.push(t.format);
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
    default:
      return `${name}${t.rowCode ? `[${t.rowCode}]` : ""} → ${prop ?? t.property}`;
  }
}
