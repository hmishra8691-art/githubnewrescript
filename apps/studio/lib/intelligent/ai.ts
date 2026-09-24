import type { Intent } from "./proposal.ts";

/**
 * THE LANGUAGE MODEL'S SIDE OF THE CONTRACT.
 *
 * The model is not asked to change the survey, write JSON logic, or invent
 * question ids. It is asked for an INTENT — the same small structure the
 * deterministic grammar produces — with the condition as EXPRESSION TEXT in
 * the language the expression editor already speaks. The planner then
 * parses that text against the real survey, so whatever the model writes is
 * checked by the same parser a programmer's typing is checked by, and shown
 * on the review card before anything is applied.
 *
 * `coerceIntent` is the gate: an object from the wire becomes an Intent only
 * if its shape is one we know, with strings where strings are expected.
 * Anything else is null, and the mode says it did not understand.
 */

export const LOGIC_SYSTEM_PROMPT = `You translate a survey programmer's sentence into ONE structured intent about their survey. Reply with a single JSON object and nothing else.

Intent shapes (pick exactly one):
{"kind":"display","target":"<question code, variable or 'page N'/'block NAME'>","action":"show"|"hide","expression":"<condition>"}
{"kind":"skip","from":"<question the rule follows, optional>","to":"<question code | 'the end' | 'screened' | 'terminated' | 'quota full'>","expression":"<condition>"}
{"kind":"required","target":"<question>","required":true|false}
{"kind":"add_question","type":"<single choice|multiple choice|numeric|text|dropdown|nps|rating|email|...>","text":"<question text>","options":["A","B"],"after":"<question, optional>","required":false}
{"kind":"rename","target":"<question or variable>","newName":"<NEW_NAME>"}
{"kind":"find","target":"<question>","relation":"usedBy"|"dependsOn"|"affects"|"reach"}
{"kind":"explain","target":"<question>"}
{"kind":"unknown","reason":"<one short sentence: what is missing or ambiguous>"}

Condition language ("expression"): reference questions by CODE (Q3) or variable name; compare with = != > >= < <= between, contains, selected, answered, unanswered, is empty; combine with AND, OR, NOT and parentheses; option values by code or label, e.g. Q3 = Yes AND (Q1 >= 18 OR Q2 contains Coke); COUNT(Q4) >= 2. Use only questions that appear in the survey listing. Never invent codes.

"find" relations: usedBy = what depends on / reads the target; dependsOn = what the target reads; affects = everything downstream of the target; reach = everything upstream that can affect it.

If the sentence asks for something outside these shapes, or you cannot tell which question is meant, answer with kind "unknown" and say why.`;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function coerceIntent(raw: unknown): Intent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = str(o.kind);
  switch (kind) {
    case "display": {
      const target = str(o.target), expression = str(o.expression);
      if (!target || !expression) return null;
      return { kind, target, action: o.action === "hide" ? "hide" : "show", expression };
    }
    case "skip": {
      const to = str(o.to), expression = str(o.expression);
      if (!to || !expression) return null;
      return { kind, from: str(o.from), to, expression };
    }
    case "required": {
      const target = str(o.target);
      if (!target || typeof o.required !== "boolean") return null;
      return { kind, target, required: o.required };
    }
    case "add_question": {
      const text = typeof o.text === "string" ? o.text.trim() : "";
      const options = Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : undefined;
      return { kind, type: str(o.type), text, options: options?.length ? options : undefined, after: str(o.after), required: typeof o.required === "boolean" ? o.required : undefined };
    }
    case "rename": {
      const target = str(o.target), newName = str(o.newName);
      if (!target || !newName || !/^[A-Za-z_]\w*$/.test(newName)) return null;
      return { kind, target, newName };
    }
    case "find": {
      const target = str(o.target);
      const relation = o.relation;
      if (!target || (relation !== "usedBy" && relation !== "dependsOn" && relation !== "affects" && relation !== "reach")) return null;
      return { kind, target, relation };
    }
    case "explain": {
      const target = str(o.target);
      return target ? { kind, target } : null;
    }
    case "unknown":
      return { kind, reason: str(o.reason) ?? "I did not understand that." };
    default:
      return null;
  }
}

/** the user turn: the survey listing, what is selected, then the sentence */
export function logicUserPrompt(context: string, sentence: string, selected?: string | null): string {
  return `${context}\n\n${selected ? `Selected: ${selected}\n` : ""}Sentence: ${sentence.trim()}`;
}
