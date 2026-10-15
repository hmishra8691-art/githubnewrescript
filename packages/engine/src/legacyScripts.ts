import type { SurveyDefinition, UxBehavior } from "@rescript/schema";
import { resolveUxTarget, validateUxScript } from "./ux.js";

/**
 * THE OLD "CUSTOM CODE" FIELDS, MOVED INTO THE ONE SCRIPT PIPELINE.
 *
 * A survey could carry JavaScript in two places that did not know about each
 * other: Styles, animations & scripts (`ux.behaviors[].script`, run in the
 * sandboxed frame) and Custom code (`question.customJs`, `branding.customJs`,
 * run with `new Function` against the live page, with no teardown). Two
 * engines, two lifecycles, two sets of errors — and a script written for one
 * did nothing in the other.
 *
 * Styles, animations & scripts is the one supported mechanism. This moves the
 * old fields into it, so a survey that has them keeps its code and keeps
 * running it:
 *
 *   · a question's `customJs` becomes a script behaviour on that question
 *     (`source: "question_custom_js"`). The code is wrapped so `el` and `api`
 *     mean what they did — `el` is the question's card, `api.getValue()` reads
 *     its answer. `api.setValue` cannot be kept (a script never writes an
 *     answer; that is a default value or a punch rule) and says so when called.
 *   · `branding.customJs` becomes a survey-level script behaviour
 *     (`source: "branding_custom_js"`).
 *   · a Custom Component's `customJs` stays where it is: it IS the component
 *     (it receives the component element and the answer api), not a script
 *     attached to something else.
 *
 * Idempotent: a migrated field is removed, so a second pass finds nothing. The
 * code is never rewritten, only wrapped. A script the sandbox will not run (it
 * reaches for the network, say) is still moved — its behaviour is then shown
 * with the reason in the editor and logged at run time — rather than being
 * dropped or run unsandboxed.
 */
export interface LegacyScriptMigration {
  def: SurveyDefinition;
  changes: string[];
  /** moved, but the sandbox will not run it as written */
  blocked: { where: string; errors: string[] }[];
}

const MAX = 20000;
const idFor = (kind: string, id: string) => `uxb_${kind}_${id.replace(/[^\w-]/g, "_")}`;

export function wrapQuestionScript(q: { id: string; code: string | number; type: string }, code: string): string {
  const qs = JSON.stringify(String(q.code)), qid = JSON.stringify(q.id);
  return [
    `// Moved here from ${q.code}'s Custom code. \`el\` is the question card and \`api\` the old helper.`,
    `(function (el, api) {`,
    code,
    `})(document.querySelector('[data-qid=' + JSON.stringify(${qid}) + ']'), {`,
    `  getValue: function () { return rs.getAnswer(${qs}); },`,
    `  setValue: function () { rs.log(${qs} + ": api.setValue is not available in survey scripts — start a question with an answer through its default value"); },`,
    `  question: { id: ${qid}, code: ${qs}, type: ${JSON.stringify(q.type)} }`,
    `});`,
  ].join("\n");
}

export function wrapSurveyScript(code: string): string {
  return ["// Moved here from Branding → custom JavaScript.", "(function () {", code, "})();"].join("\n");
}

export function migrateLegacyCustomCode(input: SurveyDefinition): LegacyScriptMigration {
  const changes: string[] = [], blocked: LegacyScriptMigration["blocked"] = [];
  const questionsWith = input.questions.filter((q) => q.customJs && q.customJs.trim() && q.type !== "custom_component");
  const brandingJs = input.branding?.customJs?.trim() ? input.branding.customJs : null;
  const stray = input.questions.filter((q) => q.type !== "custom_component" && q.customJs !== undefined && !q.customJs.trim());
  if (!questionsWith.length && !brandingJs && !stray.length) return { def: input, changes, blocked };

  const def = structuredClone(input);
  const ux = def.ux ?? { styles: [], animations: [], behaviors: [] };
  const have = new Set(ux.behaviors.map((b) => b.id));
  const now = new Date().toISOString();
  const add = (b: UxBehavior, where: string) => {
    const check = validateUxScript(b.script!, def);
    if (check.errors.length) blocked.push({ where, errors: check.errors });
    if (!have.has(b.id)) { ux.behaviors.push(b); have.add(b.id); }
  };

  for (const q of def.questions) {
    if (q.type === "custom_component") continue;
    if (q.customJs !== undefined && !q.customJs.trim()) { delete q.customJs; continue; }
    if (!q.customJs) continue;
    const script = wrapQuestionScript(q, q.customJs);
    if (script.length > MAX) { blocked.push({ where: String(q.code), errors: [`the custom JavaScript of ${q.code} is longer than the ${MAX.toLocaleString()} characters a script may hold, so it stays where it is`] }); continue; }
    const target = resolveUxTarget(def, String(q.code));
    if (typeof target === "string") { blocked.push({ where: String(q.code), errors: [target] }); continue; }
    add({ id: idFor("q", q.id), label: `${q.code} custom JavaScript`, target, effects: [], script, source: "question_custom_js", createdAt: now }, String(q.code));
    delete q.customJs;
    changes.push(`${q.code}: custom JavaScript moved to Styles, animations & scripts`);
  }
  if (brandingJs) {
    const script = wrapSurveyScript(brandingJs);
    const target = resolveUxTarget(def, "survey");
    if (script.length > MAX || typeof target === "string") blocked.push({ where: "survey", errors: [script.length > MAX ? `the survey's custom JavaScript is longer than ${MAX.toLocaleString()} characters` : String(target)] });
    else {
      add({ id: idFor("survey", "branding"), label: "Survey custom JavaScript", target, effects: [], script, source: "branding_custom_js", createdAt: now }, "survey");
      delete def.branding.customJs;
      changes.push("Survey custom JavaScript moved to Styles, animations & scripts");
    }
  }
  if (changes.length || ux.behaviors.length) def.ux = ux;
  return { def, changes, blocked };
}
