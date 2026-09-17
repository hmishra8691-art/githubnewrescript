/**
 * CODE QUESTIONS — the settings, the languages, and what counts as an answer.
 *
 * A code question is a typed question whose text happens to be a program. The
 * flow engine sees it as `code_editor`, the answer route stores it as
 * `answer_text`, the analysis reads it as words. What this module adds is the
 * small amount of structure the editor and the reviewer need and the rules
 * that make a code question answerable:
 *
 * - a language, from a closed list, so highlighting is never guessed from
 *   content and a reviewer sees exactly what the candidate chose;
 * - whether the candidate may change the language (a "write it in any
 *   language" question versus "write it in Python");
 * - starter code, which is the interviewer's, and is therefore NOT an answer —
 *   submitting the starter unchanged is refused as "write something first",
 *   the same rule a blank textarea gets;
 * - a size ceiling, because `answer_text` is capped at 20,000 characters for
 *   every typed kind and a candidate should learn that before pressing Save,
 *   not from a truncated answer nobody told them about.
 *
 * There is deliberately no execution here, or anywhere in this product. The
 * brief asks for an editor; running a candidate's code is a sandbox problem
 * with its own security surface, and a hiring decision that depends on
 * whether tests passed is a different product. The reviewer reads the code.
 */

export const CODE_LANGUAGES = [
  "javascript", "typescript", "python", "java", "csharp", "cpp", "go", "rust", "sql", "plain",
] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

export function isCodeLanguage(v: unknown): v is CodeLanguage {
  return typeof v === "string" && (CODE_LANGUAGES as readonly string[]).includes(v);
}

export const CODE_LANGUAGE_SAY: Record<CodeLanguage, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  java: "Java",
  csharp: "C#",
  cpp: "C / C++",
  go: "Go",
  rust: "Rust",
  sql: "SQL",
  plain: "Plain text / pseudocode",
};

/** The fence label a Markdown reader understands — what the analysis prompt sees. */
export const CODE_FENCE: Record<CodeLanguage, string> = {
  javascript: "javascript", typescript: "typescript", python: "python", java: "java",
  csharp: "csharp", cpp: "cpp", go: "go", rust: "rust", sql: "sql", plain: "text",
};

/** The hard ceiling every typed answer has in `answer_text`. */
export const CODE_MAX_CHARS_CEILING = 20_000;
export const CODE_DEFAULT_MAX_CHARS = 10_000;
export const CODE_STARTER_MAX_CHARS = 4_000;

export interface CodeSettings {
  /** the language the editor opens in */
  language: CodeLanguage;
  /** may the candidate pick a different language from the list */
  allowLanguageChoice: boolean;
  /** what the editor contains before the candidate types; the interviewer's words, never an answer */
  starter: string;
  /** characters, 1..CODE_MAX_CHARS_CEILING */
  maxChars: number;
}

export const DEFAULT_CODE_SETTINGS: CodeSettings = {
  language: "python",
  allowLanguageChoice: true,
  starter: "",
  maxChars: CODE_DEFAULT_MAX_CHARS,
};

/**
 * Read `settings.code` (or a bare settings object) into a `CodeSettings`,
 * filling gaps with defaults and clamping what is out of range. Never throws:
 * a question row with a malformed bundle still opens an editor.
 */
export function readCodeSettings(raw: unknown): CodeSettings {
  const bag = unwrap(raw);
  const language = isCodeLanguage(bag.language) ? bag.language : DEFAULT_CODE_SETTINGS.language;
  const allow = typeof bag.allowLanguageChoice === "boolean" ? bag.allowLanguageChoice : DEFAULT_CODE_SETTINGS.allowLanguageChoice;
  const starter = typeof bag.starter === "string" ? bag.starter.slice(0, CODE_STARTER_MAX_CHARS) : "";
  const wanted = Number(bag.maxChars);
  const maxChars = Number.isFinite(wanted) && wanted > 0
    ? Math.min(CODE_MAX_CHARS_CEILING, Math.max(1, Math.floor(wanted)))
    : DEFAULT_CODE_SETTINGS.maxChars;
  return { language, allowLanguageChoice: allow, starter, maxChars };
}

function unwrap(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  if (o.code && typeof o.code === "object" && !Array.isArray(o.code)) return o.code as Record<string, unknown>;
  return o;
}

/** What the builder saves: the settings bundle under its key. */
export function codeSettingsPatch(settings: CodeSettings): { code: CodeSettings } {
  return { code: readCodeSettings(settings) };
}

/**
 * Check a builder draft's code settings. Errors make the question unsaveable;
 * warnings are said and saved anyway.
 */
export function checkCodeSettings(raw: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const bag = unwrap(raw);
  if (bag.language !== undefined && !isCodeLanguage(bag.language)) {
    errors.push(`"${String(bag.language)}" is not a language the editor knows.`);
  }
  if (bag.starter !== undefined && typeof bag.starter === "string" && bag.starter.length > CODE_STARTER_MAX_CHARS) {
    errors.push(`Starter code can be at most ${CODE_STARTER_MAX_CHARS.toLocaleString()} characters.`);
  }
  if (bag.maxChars !== undefined) {
    const n = Number(bag.maxChars);
    if (!Number.isFinite(n) || n <= 0) errors.push("The size limit has to be a positive number of characters.");
    else if (n > CODE_MAX_CHARS_CEILING) errors.push(`The size limit cannot exceed ${CODE_MAX_CHARS_CEILING.toLocaleString()} characters.`);
    else if (n < 200) warnings.push(`${n} characters is very little room for code — a few lines at most.`);
  }
  if (bag.language === "plain" && bag.allowLanguageChoice === false) {
    warnings.push("Plain text with no language choice is a long typed answer with line numbers — that may be what you want.");
  }
  return { errors, warnings };
}

export type CodeAnswerCheck =
  | { ok: true; text: string; language: CodeLanguage }
  | { ok: false; error: string; code: "empty" | "unchanged" | "too_long" | "language" };

/**
 * Is this a code answer we accept? Called by the answer route with the raw
 * body; the client runs the same check before enabling Save so the two never
 * disagree.
 *
 * - blank, or whitespace only → `empty`
 * - identical to the starter (ignoring surrounding whitespace) → `unchanged`.
 *   The starter is the interviewer's; handing it back is not an answer.
 * - longer than the limit → `too_long`, and the message says the limit
 * - a language outside the list, or a change when choice is off → `language`
 */
export function checkCodeAnswer(
  rawText: unknown, rawLanguage: unknown, settings: CodeSettings,
): CodeAnswerCheck {
  const text = typeof rawText === "string" ? rawText.replace(/\r\n/g, "\n") : "";
  if (!text.trim()) return { ok: false, error: "Write something first.", code: "empty" };
  if (settings.starter.trim() && text.trim() === settings.starter.replace(/\r\n/g, "\n").trim()) {
    return { ok: false, error: "The starter code is the question, not the answer — add your own.", code: "unchanged" };
  }
  if (text.length > settings.maxChars) {
    return {
      ok: false, code: "too_long",
      error: `That is ${text.length.toLocaleString()} characters; this question allows ${settings.maxChars.toLocaleString()}.`,
    };
  }
  let language: CodeLanguage = settings.language;
  if (rawLanguage !== undefined && rawLanguage !== null && rawLanguage !== settings.language) {
    if (!isCodeLanguage(rawLanguage)) return { ok: false, error: "That is not a language the editor knows.", code: "language" };
    if (!settings.allowLanguageChoice) {
      return { ok: false, error: `This question is to be answered in ${CODE_LANGUAGE_SAY[settings.language]}.`, code: "language" };
    }
    language = rawLanguage;
  }
  return { ok: true, text, language };
}

/** The language stored beside a code answer, read back tolerantly. */
export function codeAnswerLanguage(answerValue: unknown, fallback: CodeLanguage = "plain"): CodeLanguage {
  if (answerValue && typeof answerValue === "object" && isCodeLanguage((answerValue as { language?: unknown }).language)) {
    return (answerValue as { language: CodeLanguage }).language;
  }
  if (isCodeLanguage(answerValue)) return answerValue;
  return fallback;
}

/**
 * How a code answer is handed to the analysis: fenced, with its language, so
 * the model reads it as a program and a reviewer's quote of any line still
 * matches the stored text verbatim (fences wrap the text; they do not alter
 * it).
 */
export function codeForAnalysis(text: string, language: CodeLanguage): string {
  return `\`\`\`${CODE_FENCE[language]}\n${text.replace(/\r\n/g, "\n")}\n\`\`\``;
}

/** Lines, for the reviewer's summary line and the report. */
export function codeStats(text: string): { lines: number; chars: number } {
  const t = text.replace(/\r\n/g, "\n");
  return { lines: t ? t.split("\n").length : 0, chars: t.length };
}
