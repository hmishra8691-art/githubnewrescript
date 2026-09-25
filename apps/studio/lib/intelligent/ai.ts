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
{"kind":"validation","target":"<question>","rules":[{"kind":"min_value"|"max_value"|"min_length"|"max_length"|"min_selections"|"max_selections"|"integer"|"email"|"phone"|"url"|"zip"|"pattern","value":<number or pattern, when the kind takes one>}]}
{"kind":"clear_validation","target":"<question>","kinds":["max_length", …] (optional; absent = every rule)}
{"kind":"mask","target":"<question whose options are masked>","expression":"<set expression>","action":"display"|"remove"|"preselect"|"disable"}
{"kind":"clear_mask","target":"<question>"}
{"kind":"find","target":"<question>","relation":"usedBy"|"dependsOn"|"affects"|"reach"}
{"kind":"explain","target":"<question>"}
{"kind":"unknown","reason":"<one short sentence: what is missing or ambiguous>"}

Condition language ("expression"): reference questions by CODE (Q3) or variable name; compare with = != > >= < <= between, contains, selected, answered, unanswered, is empty; combine with AND, OR, NOT and parentheses; option values by code or label, e.g. Q3 = Yes AND (Q1 >= 18 OR Q2 contains Coke); COUNT(Q4) >= 2. Use only questions that appear in the survey listing. Never invent codes.

Set expression language ("mask"): a question's answer as a set — Q4.Selected, Q4.Unselected, Q4.Displayed, Q4.Options — combined with AND (intersection), OR (union), MINUS (difference), NOT (complement), parentheses. "show at Q6 only what was selected in Q4" is {"kind":"mask","target":"Q6","expression":"Q4.Selected","action":"display"}.

"find" relations: usedBy = what depends on / reads the target; dependsOn = what the target reads; affects = everything downstream of the target; reach = everything upstream that can affect it.

If the sentence asks for something outside these shapes, or you cannot tell which question is meant, answer with kind "unknown" and say why.`;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const VALIDATION_KINDS = new Set(["min_value", "max_value", "min_length", "max_length", "min_selections", "max_selections", "integer", "email", "phone", "url", "zip", "pattern", "date_min", "date_max"]);

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
    case "validation": {
      const target = str(o.target);
      if (!target || !Array.isArray(o.rules)) return null;
      const rules = o.rules.flatMap((r) => {
        if (!r || typeof r !== "object") return [];
        const kind = str((r as Record<string, unknown>).kind);
        if (!kind || !VALIDATION_KINDS.has(kind)) return [];
        const v = (r as Record<string, unknown>).value;
        const value = typeof v === "number" ? v : typeof v === "string" && v.trim() ? (/^-?\d+(\.\d+)?$/.test(v.trim()) && kind !== "pattern" ? Number(v) : v.trim()) : undefined;
        return [{ kind: kind as never, ...(value !== undefined ? { value } : {}) }];
      });
      return rules.length ? { kind, target, rules } : null;
    }
    case "clear_validation": {
      const target = str(o.target);
      if (!target) return null;
      const kinds = Array.isArray(o.kinds) ? o.kinds.filter((k): k is string => typeof k === "string" && VALIDATION_KINDS.has(k)) : undefined;
      return { kind, target, ...(kinds?.length ? { kinds: kinds as never } : {}) };
    }
    case "mask": {
      const target = str(o.target), expression = str(o.expression);
      if (!target || !expression) return null;
      const action = ["display", "remove", "preselect", "disable", "display_and_preselect"].includes(o.action as string) ? (o.action as never) : "display";
      return { kind, target, expression, action };
    }
    case "clear_mask": {
      const target = str(o.target);
      return target ? { kind, target } : null;
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
