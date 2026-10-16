import type { Question, ValidationRule } from "@rescript/schema";

/**
 * SEMANTIC VALIDATION — what a question MEANS decides how its answer is
 * checked (audit 2026-10-16, QT-02).
 *
 * "What is your age?" is a whole, non-negative number whatever bounds the
 * author sets; an email address has a format; a percentage lives between 0
 * and 100 unless the author says otherwise. Before this the only place such
 * knowledge lived was the variant preset (`text.email` → an `email` rule),
 * which the model had to pick by name and which the action layer could lose.
 * The prompt could not be told "age means integer" without becoming a list of
 * every noun in market research.
 *
 * This is the one registry: a tag (`settings.semantic`) → the rules and input
 * settings it implies. It is applied when a question is created (from the
 * action's `semantic`, the variant, or the question's own wording), from the
 * Studio's "Treat as" control, and it never touches bounds the author gave —
 * an age range of 18–65 is the study's business, and nothing here hard-codes
 * 1–100. Rules it adds are the engine's existing kinds; there is no second
 * validation engine.
 */
export type Semantic = "age" | "year" | "count" | "percent" | "currency" | "email" | "phone" | "postal" | "url";
export const SEMANTICS: Semantic[] = ["age", "year", "count", "percent", "currency", "email", "phone", "postal", "url"];

export interface SemanticSpec {
  label: string;
  /** base question types the tag makes sense on */
  types: Question["type"][];
  /** rule kinds the answer must satisfy (no value unless given) */
  rules: { kind: ValidationRule["kind"]; value?: number | string }[];
  /** input settings the tag implies (only set when the question has none) */
  settings: Partial<Pick<Question["settings"], "decimalPlaces" | "numberSign" | "minValue" | "maxValue">>;
  /** default bounds — applied ONLY when the author gave none at all */
  defaultBounds?: { min?: number; max?: number };
  /** what the respondent is told the field is, for placeholders and the Properties panel */
  hint: string;
}

export const SEMANTIC_SPECS: Record<Semantic, SemanticSpec> = {
  age: { label: "Age (years)", types: ["numeric", "slider"], rules: [{ kind: "integer" }], settings: { decimalPlaces: 0, numberSign: "positive" }, hint: "a whole number of years" },
  year: { label: "Year", types: ["numeric"], rules: [{ kind: "integer" }], settings: { decimalPlaces: 0, numberSign: "positive" }, defaultBounds: { min: 1900, max: 2100 }, hint: "a four-digit year" },
  count: { label: "Count (how many)", types: ["numeric", "slider"], rules: [{ kind: "integer" }], settings: { decimalPlaces: 0, numberSign: "positive" }, hint: "a whole number, zero or more" },
  percent: { label: "Percentage", types: ["numeric", "slider"], rules: [], settings: { numberSign: "positive" }, defaultBounds: { min: 0, max: 100 }, hint: "a number from 0 to 100" },
  currency: { label: "Amount of money", types: ["numeric"], rules: [], settings: { decimalPlaces: 2, numberSign: "positive" }, hint: "an amount, up to two decimals" },
  email: { label: "Email address", types: ["open_text"], rules: [{ kind: "email" }], settings: {}, hint: "name@example.com" },
  phone: { label: "Telephone number", types: ["open_text"], rules: [{ kind: "phone" }], settings: {}, hint: "a phone number (country-aware when the question names a country)" },
  postal: { label: "Postal / ZIP code", types: ["open_text"], rules: [{ kind: "zip" }], settings: {}, hint: "a postal code (format checked for the question's country)" },
  url: { label: "Web address", types: ["open_text"], rules: [{ kind: "url" }], settings: {}, hint: "https://…" },
};

/** the tag a Studio variant stands for, when it stands for one */
const VARIANT_SEMANTIC: Record<string, Semantic> = {
  "text.email": "email", "text.phone": "phone", "text.zip": "postal", "text.url": "url",
  "numeric.percentage": "percent", "numeric.currency": "currency", "numeric.quantity": "count",
};

/**
 * Infer the tag from what the question says, conservatively: only wordings
 * that mean one thing. "How old are you" / "your age" is an age; "how many" /
 * "number of" is a count; "what year" / "year of birth" is a year; "%" /
 * "percent" is a percentage. Anything else is left alone — a wrong tag is
 * worse than none, because it adds a rule the author did not ask for.
 */
export function inferSemantic(q: Pick<Question, "type" | "variant" | "text" | "variableName" | "code">): Semantic | null {
  if (q.variant && VARIANT_SEMANTIC[q.variant]) return VARIANT_SEMANTIC[q.variant];
  const text = `${q.text ?? ""}`.replace(/<[^>]*>/g, " ").toLowerCase();
  const name = `${q.variableName ?? ""}`.toLowerCase();
  if (q.type === "numeric" || q.type === "slider") {
    if (/\b(how old|your age|respondent'?s age|age in years|age\?)/.test(text) || /^(age|q_?age|resp_?age)$/.test(name)) return "age";
    if (/\b(what year|which year|year (of|you were) born|birth ?year|year did)\b/.test(text) || /^(birth_?year|yob|year)$/.test(name)) return "year";
    if (/(^|[^\w])(%|percent|percentage|per cent)([^\w]|$)/.test(text) && !/\bpercentile\b/.test(text)) return "percent";
    if (/\b(how many|number of|count of)\b/.test(text) && !/\b(hours?|minutes?|years?|months?|weeks?|days?|dollars?|pounds?|euros?|€|\$|£)\b/.test(text)) return "count";
    return null;
  }
  if (q.type === "open_text") {
    if (/\b(e-?mail)\b/.test(text) || /^(email|e_?mail|email_?address)$/.test(name)) return "email";
    if (/\b(phone|telephone|mobile number|cell(phone)? number)\b/.test(text) || /^(phone|tel|telephone|mobile)$/.test(name)) return "phone";
    if (/\b(zip|postal|post ?code|postcode)\b/.test(text) || /^(zip|zipcode|postal|postcode|post_?code)$/.test(name)) return "postal";
    if (/\b(web ?site|url|web address|home ?page)\b/.test(text) || /^(url|website|web)$/.test(name)) return "url";
  }
  return null;
}

export interface ApplyResult { applied: boolean; added: string[]; reason?: string }

/**
 * Put the tag's rules and settings on the question. Adds only what is missing
 * (a rule of the same kind already present is left as it is, bounds the
 * author gave are kept, default bounds are used only when there are none),
 * so it is safe to call again. Returns what it added, for the toast and the
 * proposal card.
 */
export function applySemantic(q: Question, semantic: Semantic | "none" | null | undefined): ApplyResult {
  if (!semantic) return { applied: false, added: [] };
  if (semantic === "none") { q.settings.semantic = "none"; return { applied: false, added: [] }; } // said on purpose: no later inference re-tags it
  const spec = SEMANTIC_SPECS[semantic];
  if (!spec) return { applied: false, added: [], reason: `“${semantic}” is not a semantic the registry knows` };
  if (!spec.types.includes(q.type)) return { applied: false, added: [], reason: `“${spec.label}” applies to ${spec.types.join("/")} questions, not ${q.type}` };
  const added: string[] = [];
  q.settings.semantic = semantic;
  const kinds = new Set(q.validation.map((r) => r.kind));
  for (const r of spec.rules) {
    if (kinds.has(r.kind)) continue;
    q.validation.push({ id: `${q.id}_sem_${r.kind}`, kind: r.kind, ...(r.value !== undefined ? { value: r.value } : {}) } as ValidationRule);
    added.push(r.kind);
  }
  for (const [k, v] of Object.entries(spec.settings) as [keyof SemanticSpec["settings"], unknown][]) {
    if (q.settings[k] === undefined) { (q.settings as Record<string, unknown>)[k] = v; added.push(`${k}=${String(v)}`); }
  }
  if (spec.defaultBounds) {
    const hasMin = kinds.has("min_value") || q.settings.minValue !== undefined;
    const hasMax = kinds.has("max_value") || q.settings.maxValue !== undefined;
    if (!hasMin && !hasMax) {
      if (spec.defaultBounds.min !== undefined) { q.validation.push({ id: `${q.id}_sem_min`, kind: "min_value", value: spec.defaultBounds.min } as ValidationRule); q.settings.minValue = spec.defaultBounds.min; added.push(`min_value=${spec.defaultBounds.min}`); }
      if (spec.defaultBounds.max !== undefined) { q.validation.push({ id: `${q.id}_sem_max`, kind: "max_value", value: spec.defaultBounds.max } as ValidationRule); q.settings.maxValue = spec.defaultBounds.max; added.push(`max_value=${spec.defaultBounds.max}`); }
    }
  }
  return { applied: true, added };
}

/** the registry's view of a question: its tag, inferred or stored */
export function semanticOf(q: Question): Semantic | null {
  const s = q.settings.semantic;
  if (s === "none") return null;
  if (s && SEMANTIC_SPECS[s as Semantic]) return s as Semantic;
  return inferSemantic(q);
}
