import type { SurveyDefinition, Question, FlowNode } from "@rescript/schema";
import { embeddedCatalog, embeddedFieldName, isNamedEmbeddedField } from "./embedded.js";
import { stripHtmlText } from "./html.js";
import { detectValueType } from "./listValue.js";
import { serializePipeToken, type RandomPersistence } from "./pipingTokens.js";
import { DATE_SOURCE_KINDS, PIPE_DATE_FORMATS, formatDatePattern } from "./systemPipes.js";

/**
 * WHAT "INSERT PIPED TEXT" OFFERS (document 15/10/2026, item C).
 *
 * The menu is built from this, and this is built from what the runtime can
 * ACTUALLY resolve — the tokens `piping.ts` / `systemPipes.ts` understand.
 * A source the platform cannot supply here is listed DISABLED with the reason,
 * never offered as a token that would silently resolve to nothing. Pure (a
 * definition in, a tree out), so the Studio menu and the tests read one list.
 *
 *   category → item → (option | format | random parameters)
 *
 * `accept: "number"` keeps only sources that hold a number; `syntax: "calc"`
 * writes references the Calc DSL's own way (`ed.NAME`, a question's
 * variable name, `loop.index`) and disables what the DSL cannot read.
 */

export type PipeAccept = "text" | "number" | "any";
export type PipeValueType = "text" | "number" | "date" | "time" | "datetime" | "boolean" | "list";
export type PipeCategoryId =
  | "question" | "embedded" | "calculation" | "quota" | "survey" | "device" | "loop"
  | "datetime" | "distribution" | "geo" | "random";

export interface RandomParam { name: string; label: string; kind: "number" | "text"; default: string }

export interface PipeSourceItem {
  id: string;
  label: string;
  /** a second line: the type, where it comes from, a caveat */
  detail?: string;
  valueType: PipeValueType;
  /** what is inserted; absent when the item opens `options` or `random` */
  token?: string;
  /** a third level: what to read from a question, which format to use */
  options?: PipeSourceItem[];
  /** a random value: its parameters, asked for before inserting */
  random?: { kind: string; params: RandomParam[] };
  /** why it cannot be inserted here */
  disabled?: string;
  /** a caveat that does not stop insertion ("set later in the flow") */
  warning?: string;
}

export interface PipeSourceCategory {
  id: PipeCategoryId;
  label: string;
  description: string;
  items: PipeSourceItem[];
  disabled?: string;
}

export interface PipeCatalogOptions {
  accept?: PipeAccept;
  /** the field is inside a loop body (also inferred from `flowPosition`) */
  loop?: boolean;
  /** the flow node the field belongs to: enables loop sources and "set later" warnings */
  flowPosition?: string;
  syntax?: "piped" | "calc";
  /** tests only — the clock the format examples are shown with */
  now?: Date;
}

const CALC_ONLY = "The calculation language cannot read this — store it in an Embedded Data field first, then use that field here.";

const isNumericType = (t: PipeValueType) => t === "number";

/* single-answer and multi-answer question types (answers piping can read) */
const SINGLE = new Set(["single_select", "dropdown", "nps", "experiment"]);
const MULTI = new Set(["multi_select", "multi_dropdown", "image_select"]);
const NUMBER_Q = new Set(["numeric", "slider", "nps", "calculated"]);
const TEXT_Q = new Set(["open_text", "long_text", "single_line", "text", "hidden", "embedded_data", "email", "phone"]);
const MATRIX = new Set(["matrix_single", "matrix_multi", "matrix_numeric", "matrix_text", "matrix_dropdown"]);
const RANK = new Set(["ranking", "image_ranking"]);
const NO_PIPE = new Set(["html", "conjoint_task", "maxdiff_task", "acbc_task", "annotation", "media_timeline", "upload", "video_interview", "custom_component", "custom_table", "repeating_group", "hotspot"]);

function questionOptions(q: Question, calc: boolean): PipeSourceItem[] {
  const code = q.code;
  const tok = (body: string) => `{{${body}}}`;
  const numericCodes = (q.options ?? []).length > 0 && (q.options ?? []).every((o) => typeof o.code === "number" || /^-?\d+(\.\d+)?$/.test(String(o.code)));
  const out: PipeSourceItem[] = [];
  const add = (id: string, label: string, valueType: PipeValueType, body: string, detail?: string) =>
    out.push({ id: `${q.id}:${id}`, label, valueType, token: calc ? undefined : tok(body), detail });
  if (calc) {
    // the DSL reads a question by its variable name: its value / code(s)
    const t: PipeValueType = NUMBER_Q.has(q.type) || (SINGLE.has(q.type) && numericCodes) ? "number" : MULTI.has(q.type) ? "list" : "text";
    out.push({ id: `${q.id}:var`, label: "Answer value", detail: q.variableName, valueType: t, token: q.variableName });
    if (MULTI.has(q.type)) out.push({ id: `${q.id}:count`, label: "Number selected", detail: `count(${q.variableName})`, valueType: "number", token: `count(${q.variableName})` });
    return out;
  }
  if (q.type === "geo") return out; // offered under Geolocation
  if (SINGLE.has(q.type) || (q.type === "image_select" && !(q.settings as any)?.multiple)) {
    add("label", "Selected option text", "text", code);
    add("value", "Selected option code", numericCodes ? "number" : "text", `${code}.value`);
    if ((q.options ?? []).some((o) => o.flags?.includes("other_specify"))) add("other", "“Other, specify” text", "text", `${code}.other`);
  } else if (MULTI.has(q.type)) {
    add("labels", "Selected options (text)", "list", `${code}.labels`);
    add("count", "Number of options selected", "number", `${code}.count`);
    add("value", "Selected option codes", "list", `${code}.value`);
    add("first", "First selected option", "text", `${code}.first`);
    if ((q.options ?? []).some((o) => o.flags?.includes("other_specify"))) add("other", "“Other, specify” text", "text", `${code}.other`);
  } else if (NUMBER_Q.has(q.type)) {
    add("value", "Numeric value", "number", `${code}.value`);
  } else if (RANK.has(q.type)) {
    add("rank", "Ranking order", "list", `${code}.rank`);
    add("first", "Ranked first", "text", `${code}.first`);
  } else if (MATRIX.has(q.type)) {
    for (const r of q.rows ?? []) {
      const rowText = stripHtmlText(r.label).slice(0, 40);
      add(`row:${r.code}`, `Row “${rowText}” — answer`, q.type === "matrix_numeric" ? "number" : "text", `${code}[${r.code}].label`);
      if (q.type !== "matrix_text") add(`rowv:${r.code}`, `Row “${rowText}” — code`, q.type === "matrix_numeric" || numericCodes ? "number" : "text", `${code}[${r.code}].value`);
    }
    add("all", "All rows (summary)", "text", code);
  } else if (q.type === "date") {
    add("value", "Date entered", "date", code);
  } else if (q.type === "time") {
    add("value", "Time entered", "time", code);
  } else if (q.type === "numeric_list" || q.type === "text_list" || q.type === "allocation" || q.type === "composite") {
    add("all", "All entries (summary)", "text", code);
  } else {
    add("value", TEXT_Q.has(q.type) ? "Text entered" : "Answer", "text", code);
  }
  return out;
}

/** Enclosing loops of a flow node (outermost first), or null when the node is not found. */
function enclosingLoops(flow: FlowNode[], nodeId: string): Extract<FlowNode, { type: "loop" }>[] | null {
  const walk = (nodes: any[], stack: any[]): any[] | null => {
    for (const n of nodes ?? []) {
      if (n?.id === nodeId) return stack;
      const next = n?.type === "loop" ? [...stack, n] : stack;
      const found = walk(n?.children ?? [], next)
        ?? (n?.branches ?? []).reduce((acc: any[] | null, b: any) => acc ?? walk(b.children, next), null)
        ?? walk(n?.otherwise ?? [], next);
      if (found) return found;
    }
    return null;
  };
  return walk(flow as any[], []);
}

/** Embedded Data fields that exist BEFORE a flow node runs (URL / panel fields count from the start). */
function embeddedSetBefore(def: SurveyDefinition, nodeId: string): Set<string> | null {
  const out = new Set<string>();
  for (const e of def.embeddedData ?? []) { const n = embeddedFieldName(e); if (n) out.add(n); }
  let found = false;
  const urlish: string[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes ?? []) {
      if (n?.type === "embedded_data") {
        for (const f of n.fields ?? []) {
          if (!isNamedEmbeddedField(f)) continue;
          if (f.source === "url" || f.source === "panel") urlish.push(embeddedFieldName(f));
          else if (!found && n.id !== nodeId) out.add(embeddedFieldName(f));
        }
      }
      if (n?.id === nodeId) found = true;
      walk(n?.children ?? []);
      for (const b of n?.branches ?? []) walk(b.children);
      walk(n?.otherwise ?? []);
    }
  };
  walk(def.flow as any[]);
  urlish.forEach((n) => out.add(n));
  return found ? out : null;
}

const RANDOM_SPECS: { kind: string; label: string; detail: string; valueType: PipeValueType; params: RandomParam[] }[] = [
  { kind: "int", label: "Random whole number", detail: "between a minimum and a maximum, inclusive", valueType: "number",
    params: [{ name: "min", label: "Minimum", kind: "number", default: "1" }, { name: "max", label: "Maximum", kind: "number", default: "100" }] },
  { kind: "decimal", label: "Random decimal", detail: "between a minimum and a maximum, rounded", valueType: "number",
    params: [{ name: "min", label: "Minimum", kind: "number", default: "0" }, { name: "max", label: "Maximum", kind: "number", default: "1" }, { name: "places", label: "Decimal places", kind: "number", default: "2" }] },
  { kind: "pick", label: "Random value from a list", detail: "one of the values you list", valueType: "text",
    params: [{ name: "values", label: "Values (comma-separated)", kind: "text", default: "A, B, C" }] },
  { kind: "id", label: "Random alphanumeric ID", detail: "letters and digits", valueType: "text",
    params: [{ name: "length", label: "Length", kind: "number", default: "8" }] },
  { kind: "bool", label: "Random true / false", detail: "50 / 50", valueType: "boolean", params: [] },
  { kind: "uuid", label: "Random UUID", detail: "a version-4 UUID", valueType: "text", params: [] },
];

/** How long a random value lasts — the choices, default first. */
export const RANDOM_PERSISTENCE: { value: RandomPersistence; label: string }[] = [
  { value: "respondent", label: "Generate once per respondent" },
  { value: "session", label: "Generate once per session" },
  { value: "loop", label: "Generate once per loop iteration" },
  { value: "each", label: "Generate every time it is evaluated" },
];

/** The token for a random value with its parameters (as the menu's form fills them). */
export function buildRandomToken(kind: string, values: Record<string, string>, per: RandomPersistence = "respondent"): string {
  const spec = RANDOM_SPECS.find((s) => s.kind === kind);
  if (!spec) return "";
  let args: string[] = spec.params.map((p) => (values[p.name] ?? p.default).trim());
  if (kind === "pick") args = (values.values ?? spec.params[0].default).split(",").map((v) => v.trim()).filter(Boolean);
  const call = args.length ? `random.${kind}(${args.join(",")})` : `random.${kind}`;
  return serializePipeToken({ kind: "system", ref: call, property: "value", per });
}

/** A date / time token with a format. */
export function withPipeFormat(token: string, fmt: string): string {
  return token.replace(/\}\}$/, `|fmt:${fmt}}}`);
}

/** The Insert Piped Text tree for one field. */
export function pipeSourceCatalog(def: SurveyDefinition, opts: PipeCatalogOptions = {}): PipeSourceCategory[] {
  const accept = opts.accept ?? "any";
  const calc = opts.syntax === "calc";
  const now = opts.now ?? new Date();
  const loops = opts.flowPosition ? enclosingLoops(def.flow as FlowNode[], opts.flowPosition) : null;
  const inLoop = !!opts.loop || (loops?.length ?? 0) > 0;
  const setBefore = opts.flowPosition ? embeddedSetBefore(def, opts.flowPosition) : null;
  const cats: PipeSourceCategory[] = [];

  /* --- survey questions */
  const qItems: PipeSourceItem[] = [];
  for (const q of def.questions ?? []) {
    if (NO_PIPE.has(q.type) || q.type === "geo") continue;
    const options = questionOptions(q, calc);
    if (!options.length) continue;
    qItems.push({
      id: q.id, label: `${q.code} — ${stripHtmlText(q.text).slice(0, 60) || "(untitled)"}`,
      detail: q.type.replace(/_/g, " "), valueType: options[0].valueType, options,
    });
  }
  cats.push({ id: "question", label: "Survey Question", description: "An answer the respondent gave — option text or code, count, number, text, matrix row", items: qItems,
    disabled: qItems.length ? undefined : "This survey has no questions that can be piped yet." });

  /* --- embedded data */
  const typeWord: Record<string, string> = { auto: "Auto", string: "Text", integer: "Integer", decimal: "Decimal", boolean: "Boolean", date: "Date", datetime: "Date & time", url: "URL", list: "List" };
  const edItems: PipeSourceItem[] = embeddedCatalog(def).map((e) => {
    const vt: PipeValueType = e.dataType === "integer" || e.dataType === "decimal" ? "number"
      : e.dataType === "auto" ? (autoFixedType(def, e.name) ?? "number")
      : e.dataType === "boolean" ? "boolean" : e.dataType === "date" ? "date" : e.dataType === "datetime" ? "datetime" : e.dataType === "list" ? "list" : "text";
    const later = setBefore && !setBefore.has(e.name) ? "Set later in the flow — empty at this point." : undefined;
    return {
      id: `ed:${e.name}`, label: e.name,
      detail: `${typeWord[e.dataType] ?? e.dataType}${e.dataType === "auto" ? " (detected from the value)" : ""}${e.source ? ` · ${e.source === "static" ? "fixed value" : e.source === "expression" ? "calculation" : e.source}` : ""}`,
      valueType: vt, token: calc ? `ed.${e.name}` : `{{ed.${e.name}}}`, warning: later,
    };
  });
  cats.push({ id: "embedded", label: "Embedded Data Field", description: "Any Embedded Data field defined in this survey, with its data type", items: edItems,
    disabled: edItems.length ? undefined : "No Embedded Data fields are defined yet." });

  /* --- calculations */
  const calcItems: PipeSourceItem[] = (def.calculations ?? []).map((c) => ({
    id: `calc:${c.targetVariable}`, label: c.targetVariable, detail: `${c.dataType ?? "numeric"} · = ${c.expression}`.slice(0, 80),
    valueType: (c.dataType === "text" ? "text" : c.dataType === "boolean" ? "boolean" : "number") as PipeValueType,
    token: calc ? c.targetVariable : `{{calc.${c.targetVariable}}}`,
  }));
  if (calcItems.length) cats.push({ id: "calculation", label: "Calculated Variable", description: "A value from the Calculations list", items: calcItems });

  /* --- quota */
  const quotaItems: PipeSourceItem[] = (def.quotas ?? []).map((qt) => ({
    id: `quota:${qt.id}`, label: qt.name, detail: `${qt.cells?.length ?? 0} cell${qt.cells?.length === 1 ? "" : "s"} · ${qt.mode ?? "hard"}`, valueType: "number",
    options: [
      ["count", "Current count", "number"], ["limit", "Limit", "number"], ["remaining", "Remaining", "number"],
      ["percent", "% filled", "number"], ["status", "Status (open / full)", "text"], ["name", "Quota name", "text"],
      ["id", "Quota ID", "text"], ["cell", "This respondent's cell", "text"],
    ].map(([prop, label, vt]) => ({ id: `quota:${qt.id}:${prop}`, label, valueType: vt as PipeValueType, token: `{{quota.${qt.id}.${prop}}}`,
      detail: prop === "count" || prop === "remaining" || prop === "percent" ? "as of when the respondent started (live counts; 0 in preview)" : undefined })),
  }));
  cats.push({ id: "quota", label: "Quota", description: "A quota's name, id, current count, limit, remaining, % filled, status", items: quotaItems,
    disabled: calc ? CALC_ONLY : quotaItems.length ? undefined : "This survey has no quotas." });

  /* --- survey metadata */
  const sys = (id: string, label: string, ref: string, valueType: PipeValueType, detail?: string): PipeSourceItem =>
    ({ id, label, valueType, token: `{{${ref}}}`, detail });
  cats.push({ id: "survey", label: "Survey Metadata", description: "The survey and this response: ids, name, version, language, status", disabled: calc ? CALC_ONLY : undefined, items: [
    sys("survey.id", "Survey ID", "survey.id", "text", def.meta?.id),
    sys("survey.code", "Survey code", "survey.code", "text", def.meta?.code),
    sys("survey.name", "Survey name", "survey.name", "text", def.meta?.title),
    sys("survey.version", "Survey version", "survey.version", "text", def.meta?.version),
    sys("response.id", "Response ID", "response.id", "text", "this response's session id"),
    sys("response.respondent_id", "Respondent ID", "response.respondent_id", "text", "empty when the link carries no respondent id"),
    sys("response.language", "Language", "response.language", "text", "the language the respondent is answering in"),
    sys("response.status", "Response status", "response.status", "text", "in_progress until the survey ends"),
  ] });

  /* --- device */
  cats.push({ id: "device", label: "Device", description: "What the respondent's browser reports: device type, OS, browser, screen, language", disabled: calc ? CALC_ONLY : undefined, items: [
    sys("device.type", "Device type", "device.type", "text", "desktop / tablet / mobile"),
    sys("device.os", "Operating system", "device.os", "text"),
    sys("device.browser", "Browser", "device.browser", "text"),
    sys("device.screen", "Screen size", "device.screen", "text", "e.g. 1920x1080"),
    sys("device.viewport", "Window (viewport) size", "device.viewport", "text", "when the survey started"),
    sys("device.language", "Browser language", "device.language", "text"),
    sys("device.user_agent", "User agent", "device.user_agent", "text"),
  ] });

  /* --- loop & merge */
  const innermost = loops?.[loops.length - 1];
  const loopTok = (prop: string) => (calc ? `loop.${prop}` : `{{loop.${prop}}}`);
  const loopItems: PipeSourceItem[] = inLoop ? [
    { id: "loop.index", label: "Current loop number", detail: "1, 2, 3 …", valueType: "number", token: loopTok("index") },
    { id: "loop.count", label: "Total loop iterations", valueType: "number", token: loopTok("count") },
    { id: "loop.label", label: "Current item (label)", valueType: "text", token: loopTok("label") },
    { id: "loop.code", label: "Current item (code)", valueType: "text", token: loopTok("code") },
    ...((innermost?.references?.columns ?? []).map((c) => ({
      id: `loop.ref:${c.name}`, label: `Field “${c.name}”`, detail: `reference column${c.dataType ? ` · ${c.dataType}` : ""}`,
      valueType: (c.dataType === "number" ? "number" : c.dataType === "boolean" ? "boolean" : "text") as PipeValueType, token: loopTok(c.name),
    }))),
  ] : [];
  cats.push({ id: "loop", label: "Loop & Merge", description: "The current loop iteration: number, total, item, item fields", items: loopItems,
    disabled: inLoop ? undefined : "Unavailable here — this field is not inside a loop." });

  /* --- date / time */
  const fmtOptions = (key: string): PipeSourceItem[] | undefined => {
    const holds = DATE_SOURCE_KINDS[key]?.holds;
    if (holds !== "date" && holds !== "time" && holds !== "datetime") return undefined;
    return PIPE_DATE_FORMATS[holds].map((f) => ({
      id: `date.${key}|${f}`, label: f, detail: `e.g. ${formatDatePattern(now, f)}`, valueType: holds, token: withPipeFormat(`{{date.${key}}}`, f),
    }));
  };
  const dateItem = (key: string, label: string, detail?: string): PipeSourceItem => {
    const holds = DATE_SOURCE_KINDS[key]?.holds ?? "text";
    const options = fmtOptions(key);
    return { id: `date.${key}`, label, detail, valueType: holds as PipeValueType, ...(options ? { options } : { token: `{{date.${key}}}` }) };
  };
  cats.push({ id: "datetime", label: "Date / Time", description: "Current or start date and time, parts of a date, time zone — with a format", disabled: calc ? CALC_ONLY : undefined, items: [
    dateItem("today", "Current date", "when this point is reached"),
    dateItem("time", "Current time"),
    dateItem("now", "Current date and time"),
    dateItem("start_date", "Start date", "when the respondent started"),
    dateItem("start_time", "Start time"),
    dateItem("start", "Start date and time"),
    dateItem("day", "Day of the month", "1–31"),
    dateItem("month", "Month number", "1–12"),
    dateItem("month_name", "Month name"),
    dateItem("year", "Year"),
    dateItem("weekday", "Day of the week"),
    dateItem("timezone", "Time zone", "the respondent's, e.g. Europe/London"),
    dateItem("unix", "Unix timestamp", "seconds since 1970"),
    dateItem("iso", "ISO 8601 timestamp (UTC)"),
  ] });

  /* --- distribution */
  const mode = def.deployment?.access?.mode ?? "open";
  cats.push({ id: "distribution", label: "Distribution", description: "How the respondent arrived: channel, link type, contact fields", disabled: calc ? CALC_ONLY : undefined, items: [
    sys("distribution.channel", "Channel", "distribution.channel", "text", "live / test / preview"),
    sys("distribution.link_type", "Link type", "distribution.link_type", "text", `this survey: ${mode}`),
    { id: "distribution.contact", label: "Contact fields", valueType: "text",
      disabled: mode === "open" || mode === "password"
        ? "Anonymous link — there is no contact record to read."
        : "The platform keeps no contact record to pipe from. An invitation list's columns arrive as Embedded Data: declare the column as an Embedded Data field (Value from: Panel) and pick it under Embedded Data Field." },
  ] });

  /* --- geolocation */
  const geoQs = (def.questions ?? []).filter((q) => q.type === "geo");
  cats.push({ id: "geo", label: "Geolocation", description: "Where the respondent is — never guessed", disabled: calc ? CALC_ONLY : undefined, items: [
    { id: "geo.approx", label: "Approximate location (country, region, city)", valueType: "text",
      disabled: "The platform does not look up locations from IP addresses, so there is no approximate location to pipe." },
    ...(geoQs.length ? geoQs.map((q) => ({
      id: `geo:${q.id}`, label: `Precise location — ${q.code}`, detail: "only when the respondent allowed location access in this question", valueType: "text" as PipeValueType,
      options: [["country", "Country"], ["city", "City"], ["address", "Address"], ["lat", "Latitude"], ["lng", "Longitude"], ["radius", "Accuracy (radius)"]].map(([p, l]) => ({
        id: `geo:${q.id}:${p}`, label: l, valueType: (p === "lat" || p === "lng" ? "number" : "text") as PipeValueType, token: `{{${q.code}.${p}}}`,
      })),
    })) : [{ id: "geo.precise", label: "Precise location", valueType: "text" as PipeValueType,
      disabled: "Precise location is collected only with the respondent's permission, by a Location (geo) question — add one, then pipe it from here." }]),
  ] });

  /* --- random */
  cats.push({ id: "random", label: "Random Value", description: "A random number, list value, ID, true/false or UUID — once per respondent, session, loop or every time", disabled: calc ? CALC_ONLY : undefined,
    items: RANDOM_SPECS.map((r) => ({ id: `random.${r.kind}`, label: r.label, detail: r.detail, valueType: r.valueType, random: { kind: r.kind, params: r.params } })) });

  /* --- the field's type: a number field offers only numeric sources */
  if (accept === "number") {
    for (const c of cats) {
      if (c.disabled) continue;
      c.items = c.items
        .map((it) => it.options ? { ...it, options: it.options.filter((o) => isNumericType(o.valueType)) } : it)
        .filter((it) => it.disabled || (it.options ? it.options.length > 0 : isNumericType(it.valueType)))
        .filter((it) => !it.disabled);
      if (!c.items.length) c.disabled = "Nothing here holds a number, and this field takes a number.";
    }
  }
  return cats;
}

/** An Auto field with a plain fixed value: what that value is (so a number field can offer it). */
function autoFixedType(def: SurveyDefinition, name: string): PipeValueType | undefined {
  let found: PipeValueType | undefined;
  const walk = (nodes: any[]) => {
    for (const n of nodes ?? []) {
      if (n?.type === "embedded_data") for (const f of n.fields ?? []) {
        if (embeddedFieldName(f) === name && f.source === "static" && f.value && !String(f.value).includes("{{")) {
          const d = detectValueType(f.value);
          found = d === "integer" || d === "decimal" ? "number" : d === "list" ? "list" : d === "boolean" ? "boolean" : "text";
        }
      }
      walk(n?.children ?? []); for (const b of n?.branches ?? []) walk(b.children); walk(n?.otherwise ?? []);
    }
  };
  walk(def.flow as any[]);
  return found;
}

export interface PipeSearchHit { category: PipeSourceCategory; item: PipeSourceItem; parent?: PipeSourceItem }

/** Every enabled leaf (and every item that opens a third level) matching the query, across categories. */
export function searchPipeSources(cats: PipeSourceCategory[], query: string): PipeSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: PipeSearchHit[] = [];
  const match = (...parts: (string | undefined)[]) => parts.some((p) => p?.toLowerCase().includes(q));
  for (const c of cats) {
    if (c.disabled) continue;
    for (const it of c.items) {
      if (it.disabled) continue;
      if (match(it.label, it.detail, it.token, c.label)) hits.push({ category: c, item: it });
      for (const o of it.options ?? []) if (match(o.label, o.token, `${it.label} ${o.label}`)) hits.push({ category: c, item: o, parent: it });
    }
  }
  return hits.slice(0, 60);
}
