import { LOGIC_SYSTEM_PROMPT, coerceIntent } from "../intelligent/ai.ts";
import type { Intent } from "../intelligent/proposal.ts";

/**
 * DEEP CUSTOM LOGIC ANALYSIS (the import brief §9–§12).
 *
 * What an importer cannot translate deterministically — a Qualtrics
 * JavaScript handler, a Decipher Python `exec`, a GeoIP condition — is kept
 * (a disabled script, the source logic in the question's notes) and reported.
 * On request, one item at a time, the model is asked what it does. Its
 * answer is held to the same contract as the Intelligent mode's: it may
 * EXPLAIN, and it may propose ONE intent in the shapes the planner knows,
 * with any condition as expression text. The planner then parses that text
 * against the real survey and shows the proposal for review — the model never
 * writes the survey, never invents a question, and a reading the parser
 * rejects is shown as rejected.
 */

export const CUSTOM_LOGIC_SYSTEM_PROMPT = `You read one piece of custom survey code that was imported from another survey platform (Qualtrics JavaScript, Decipher Python, or a condition the importer could not translate) and explain it to a survey programmer. Reply with ONE JSON object and nothing else:

{"explanation":"<two or three plain sentences: what the code does and when>",
 "effect":"display"|"skip"|"validation"|"set_variable"|"piping"|"styling"|"tracking"|"other",
 "dependencies":["<question codes, variables or embedded fields the code reads or writes>"],
 "equivalent":"exact"|"approximate"|"none",
 "risk":"<one sentence: what could go wrong if this is not rebuilt, or empty>",
 "intent":<ONE intent object in the shapes listed below that rebuilds the same behaviour in Rescript, or null when there is no faithful equivalent>}

Rules: use only question codes and variable names from the survey listing; never invent one. If the behaviour depends on something Rescript cannot see (the browser, the respondent's location, an external service), say so and set "intent" to null and "equivalent" to "none". Presentation-only code (hiding a button, styling, timers for display) is "styling" with intent null. When in doubt, explain and propose nothing.

The intent shapes, and the condition language, are these:
${LOGIC_SYSTEM_PROMPT.split("\n").slice(2).join("\n")}`;

export interface CustomLogicItem {
  language: string;
  code: string;
  location: string;
  role: string;
  refs: string[];
  /** the Rescript question it belongs to, when it belongs to one */
  questionId?: string | null;
  questionCode?: string | null;
}

export function customLogicUserPrompt(context: string, item: CustomLogicItem): string {
  return `Survey listing:\n${context}\n\n${item.questionCode ? `The code belongs to question ${item.questionCode}.` : "The code is survey-level (not tied to one question)."}\nSource: ${item.language}, ${item.role}, at ${item.location}.${item.refs.length ? ` The importer saw it read: ${item.refs.join(", ")}.` : ""}\n\nCode:\n${item.code.slice(0, 6000)}`;
}

export interface CustomLogicAnalysis {
  explanation: string;
  effect: string;
  dependencies: string[];
  equivalent: "exact" | "approximate" | "none";
  risk: string;
  intent: Intent | null;
}

const EFFECTS = new Set(["display", "skip", "validation", "set_variable", "piping", "styling", "tracking", "other"]);

/** The gate on the model's reply: known fields, strings where strings belong, an intent only in a shape we know. */
export function coerceCustomLogic(raw: unknown): CustomLogicAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const explanation = typeof o.explanation === "string" ? o.explanation.trim().slice(0, 1200) : "";
  if (!explanation) return null;
  const effect = typeof o.effect === "string" && EFFECTS.has(o.effect) ? o.effect : "other";
  const dependencies = Array.isArray(o.dependencies) ? o.dependencies.filter((d): d is string => typeof d === "string" && !!d.trim()).map((d) => d.trim().slice(0, 60)).slice(0, 30) : [];
  const equivalent = o.equivalent === "exact" || o.equivalent === "approximate" ? o.equivalent : "none";
  const risk = typeof o.risk === "string" ? o.risk.trim().slice(0, 400) : "";
  let intent = coerceIntent(o.intent);
  // read-only or unknown shapes are not a rebuild
  if (intent && (intent.kind === "unknown" || intent.kind === "find" || intent.kind === "explain" || intent.kind === "diagnose" || intent.kind === "screening")) intent = null;
  return { explanation, effect, dependencies, equivalent: intent ? equivalent : "none", risk, intent };
}
