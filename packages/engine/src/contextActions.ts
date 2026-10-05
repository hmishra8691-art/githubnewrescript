import type { Option, Question, SurveyDefinition } from "@rescript/schema";
import { stripHtmlText } from "./html.js";
import { listBlocks } from "./blocks.js";
import { questionOrder } from "./dependencies.js";
import { answerKind } from "./optionCodes.js";
import { formatCondition } from "./logicExpression.js";
import { interpretRequest } from "./nlIntent.js";

/*
 * WHAT CAN BE DONE TO WHAT IS SELECTED (Intelligent Mode upgrade, Phase 4).
 *
 * Selecting Q7, one of its options or a block exposes the operations that
 * are valid FOR THAT OBJECT — the options group only for a question that has
 * options, selection counts only for a multi-select, a range only for a
 * number, "make required" only when it is not, "add Other" only when there is
 * none, a mask only when an earlier question offers choices to carry.
 *
 * Each operation is a SENTENCE the engine's own interpreter reads, so a click
 * goes through exactly the path a typed request does — interpretation,
 * validation, the Changes panel, Apply — and nothing here writes the survey.
 * A sentence that is complete ("Make Q7 required") is checked now by running
 * the interpreter on it: an operation the engine would refuse is not
 * offered. A sentence that needs the researcher's words ("Show Q7 only if …")
 * is a template for the input box, marked as such.
 */

export type ContextGroup = "Logic" | "Options" | "Validation" | "Data" | "Structure" | "Research" | "Inspect";
export interface ContextAction {
  group: ContextGroup;
  label: string;
  /** the request, in words the interpreter reads */
  sentence: string;
  /** true: complete, checked — send it as is; false: a template to finish in the input box */
  ready: boolean;
  /** removes or rewrites content: the Studio says so on the button */
  destructive?: boolean;
}
export type ContextTarget = { questionId: string; option?: string | number } | { blockId: string };

const plain = (s: string | undefined, n = 40): string => { const t = stripHtmlText(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const NONE_RE = /^(?:none|none of (?:the above|these)|neither|nothing)\b/i;
const OTHER_RE = /^other\b/i;

/** the operations valid for the selected object, grouped, each a sentence the interpreter accepts (or a template) */
export function contextActions(def: SurveyDefinition, target: ContextTarget): ContextAction[] {
  const out: ContextAction[] = [];
  /* a ready sentence is offered only if the interpreter would carry it out (or answer it) — never one it would refuse */
  const ready = (group: ContextGroup, label: string, sentence: string, destructive = false) => {
    const it = interpretRequest(def, sentence);
    if (it.kind === "actions" || it.kind === "answer") out.push({ group, label, sentence, ready: true, ...(destructive ? { destructive } : {}) });
  };
  const template = (group: ContextGroup, label: string, sentence: string) => out.push({ group, label, sentence, ready: false });

  if ("blockId" in target) {
    const b = listBlocks(def.flow as unknown[]).find((x) => x.id === target.blockId);
    if (!b) return [];
    const t = b.title ?? b.id;
    template("Structure", "Rename block", `Rename block ${t} to `);
    ready("Structure", "Delete block and its questions", `Delete the ${t} block`, true);
    template("Logic", "Show block only if…", `Show block ${t} only if `);
    const qs = b.pages.flatMap((p) => p.node.questionIds);
    if (qs.length) ready("Inspect", "What depends on its first question", `What depends on ${def.questions.find((q) => q.id === qs[0])?.code}?`);
    return out;
  }

  const q = def.questions.find((x) => x.id === target.questionId);
  if (!q) return [];
  const code = String(q.code);
  const kind = answerKind(q);
  const options = (q.options ?? []) as Option[];
  const order = questionOrder(def);
  const at = order.indexOf(q.id);

  /* ---------------------------------------------------- one option */
  if (target.option !== undefined) {
    const o = options.find((x) => String(x.code) === String(target.option));
    if (!o) return [];
    const label = plain(o.label);
    const name = `“${label}”`;
    template("Options", "Rename option", `Rename option ${name} in ${code} to `);
    template("Options", "Recode option", `Recode option ${name} in ${code} as `);
    if (kind === "list") ready("Options", o.flags?.includes("exclusive") ? "Make not exclusive" : "Make exclusive", `Make ${name} in ${code} ${o.flags?.includes("exclusive") ? "not exclusive" : "exclusive"}`);
    if (!o.flags?.includes("other_specify")) ready("Options", "Ask to specify", `Make ${name} in ${code} other-specify`);
    ready("Options", "Move to the top", `Move ${name} to the top of ${code}`);
    ready("Options", "Move to the bottom", `Move ${name} to the bottom of ${code}`);
    template("Logic", "Show this option only if…", `Show option ${name} in ${code} only when `);
    ready("Inspect", "What breaks if it is removed", `What breaks if I remove option ${o.code} from ${code}?`);
    ready("Options", "Remove option", `Remove option ${name} from ${code}`, true);
    return out;
  }

  /* ---------------------------------------------------- logic */
  if (q.displayLogic) {
    const now = formatCondition(def, q.displayLogic);
    template("Logic", "Add an AND condition", `Show ${code} only if (${now}) and `);
    template("Logic", "Add an OR condition", `Also show ${code} when `);
    ready("Logic", "Remove display logic", `Remove the display logic from ${code}`, true);
  } else {
    template("Logic", "Add display logic", `Show ${code} only if `);
    template("Logic", "Add a NOR condition", `Show ${code} only if neither `);
  }
  const later = order.slice(at + 1).map((id) => def.questions.find((x) => x.id === id)).filter((x): x is Question => !!x);
  if (later.length) {
    const first = options[0] ? ` is ${plain(options[0].label, 24)}` : "";
    template("Logic", "Add skip logic", `If ${code}${first}, skip to `);
    if (later.length >= 2) template("Logic", "Skip a range of questions", `If ${code}${first}, skip ${later[0].code} through ${later[Math.min(later.length, 4) - 1].code}`);
  }
  template("Logic", "Screen out on an answer", `Screen out if ${code}${options[0] ? ` is ${plain(options[0].label, 24)}` : " "}`);

  /* ---------------------------------------------------- options */
  if (options.length && (kind === "choice" || kind === "list" || kind === "ranking")) {
    template("Options", "Add options", `Add options  to ${code}`);
    if (!options.some((o) => o.flags?.includes("other_specify") || OTHER_RE.test(plain(o.label)))) ready("Options", "Add “Other (please specify)”", `Add an Other option to ${code}`);
    if (kind === "list" && !options.some((o) => NONE_RE.test(plain(o.label)))) ready("Options", "Add “None of these”", `Add a None of these option to ${code}`);
    ready("Options", "Sort A → Z", `Sort the options of ${code} alphabetically`);
    const keep = options.find((o) => NONE_RE.test(plain(o.label)) || OTHER_RE.test(plain(o.label)));
    if (!q.randomization?.enabled) ready("Options", keep ? `Randomize, keeping “${plain(keep.label, 24)}” last` : "Randomize options", keep ? `Randomize ${code} options but keep ${plain(keep.label)} last` : `Randomize ${code} options`);
    else ready("Options", "Stop randomizing", `Stop randomizing ${code}`);
    const source = order.slice(0, at).map((id) => def.questions.find((x) => x.id === id)).reverse().find((x) => x && answerKind(x) === "list" && (x.options ?? []).some((o) => options.some((p) => plain(p.label).toLowerCase() === plain(o.label).toLowerCase())));
    if (source && !q.mask) ready("Options", `Show only what was chosen at ${source.code}`, `Mask all options selected in ${source.code} from ${code}`);
    if (q.mask) ready("Options", "Remove the mask", `Remove the mask from ${code}`, true);
    if (kind === "list") {
      const none = options.find((o) => NONE_RE.test(plain(o.label)) && !o.flags?.includes("exclusive"));
      if (none) ready("Options", `Make “${plain(none.label, 24)}” exclusive`, `Make “${plain(none.label)}” in ${code} exclusive`);
    }
  }

  /* ---------------------------------------------------- validation */
  ready("Validation", q.required ? "Make optional" : "Make required", `Make ${code} ${q.required ? "optional" : "required"}`);
  if (kind === "list") {
    template("Validation", "Minimum selections", `${code} needs at least  selections`);
    template("Validation", "Maximum selections", `At most  selections on ${code}`);
    template("Validation", "Exact selections", `Exactly  selections on ${code}`);
  }
  if (kind === "numeric") {
    template("Validation", "Allowed range", `${code} must be between  and `);
    ready("Validation", "Whole numbers only", `${code} must be a whole number`);
  }
  if (q.type === "open_text") {
    template("Validation", "Character limit", `Limit ${code} to  characters`);
    ready("Validation", "Must be an email address", `${code} must be an email address`);
  }

  /* ---------------------------------------------------- data */
  template("Data", "Rename variable", `Rename ${q.variableName} to `);
  template("Data", "Create a calculated variable", `Add a calculated variable NAME = ${q.variableName}`);
  template("Data", "Create an embedded variable", "Create an embedded variable called ");

  /* ---------------------------------------------------- structure */
  ready("Structure", "Duplicate", `Duplicate ${code}`);
  template("Structure", "Move after…", `Move ${code} after `);
  template("Structure", "Change type", `Change ${code} to a `);
  if (later.length) ready("Structure", "Page break after", `Page break after ${code}`);
  ready("Structure", "Delete", `Delete ${code}`, true);

  /* ---------------------------------------------------- inspect and research */
  ready("Inspect", "What depends on it", `What depends on ${code}?`);
  ready("Inspect", "What it reads", `What does ${code} depend on?`);
  ready("Inspect", "What breaks if it is deleted", `What will break if I delete ${code}?`);
  template("Research", "Add a hypothesis", "Add hypothesis: ");
  ready("Research", "Create an analysis framework", "Create an analysis framework");
  return out;
}
