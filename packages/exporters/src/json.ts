import { SurveyDefinition, safeParseSurvey } from "@rescript/schema";

/** Serialize a survey definition to pretty-printed JSON. */
export function exportSurveyJson(def: SurveyDefinition): string {
  return JSON.stringify(def, null, 2);
}

/**
 * Parse and validate survey JSON text. Throws an Error with a readable
 * message when the text is not JSON or does not match the survey schema.
 */
export function importSurveyJson(text: string): SurveyDefinition {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Survey import failed: the file is not valid JSON (${(e as Error).message})`,
    );
  }
  const result = safeParseSurvey(raw);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 10)
      .map((i) => `  - ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("\n");
    const extra =
      result.error.issues.length > 10
        ? `\n  … and ${result.error.issues.length - 10} more issue(s)`
        : "";
    throw new Error(
      `Survey import failed: the JSON does not match the survey schema.\n${issues}${extra}`,
    );
  }
  return result.data;
}
