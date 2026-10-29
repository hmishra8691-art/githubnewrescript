/**
 * The prompts of the generation steps (K2, 2026-10-25). Each step is sent ONLY: the task's persisted summary (never
 * the whole brief again), its own slice of the skeleton, the questions it depends on (as one-line digests), and a
 * machine-readable input block. The system prompt (the copilot's action vocabulary) and the guides are sent by the
 * engine as cached blocks, so the per-step part is the only part that changes between calls.
 */
import { neutralizeUntrusted, type DeliverableError, type GenerationOutline, type SkeletonSlot } from "@rescript/engine";
import type { TaskSummary } from "../types.ts";

export const OUTLINE_SCHEMA = {
  name: "generation_outline",
  schema: {
    type: "object",
    properties: {
      sections: { type: "array", items: { type: "object", properties: { title: { type: "string" }, count: { type: "number" }, complexity: { type: "string", enum: ["simple", "complex"] }, purpose: { type: "string" }, types: { type: "array", items: { type: "string" } }, logic: { type: "string" }, topic: { type: "string" } }, required: ["title", "count"], additionalProperties: true } },
      quotas: { type: "array", items: { type: "string" } },
      randomize: { type: "array", items: { type: "string" } },
      logic: { type: "array", items: { type: "string" } },
    },
    required: ["sections"],
    additionalProperties: true,
  } as Record<string, unknown>,
};

const list = (xs: readonly string[] | undefined, max = 12) => (xs ?? []).slice(0, max).map((x) => `- ${x}`).join("\n");

/** the persisted task summary, as every step's first lines */
export function summaryBlock(s: TaskSummary): string {
  return [
    `TASK GOAL (the researcher's request, as recorded for this task):\n${s.goal}`,
    s.deliverables.length ? `DELIVERABLES:\n${list(s.deliverables)}` : "",
    s.constraints.length ? `CONSTRAINTS:\n${list(s.constraints)}` : "",
    s.decisions.length ? `DECISIONS ALREADY MADE:\n${list(s.decisions, 20)}` : "",
    s.language ? `WRITE ALL RESPONDENT-FACING TEXT IN: ${s.language}` : "",
  ].filter(Boolean).join("\n\n");
}

export function outlinePrompt(message: string, total: number, input: Record<string, unknown>): string {
  return `${message}

THIS CALL: PLAN THE SECTIONS ONLY of a ${total}-question ${input.assessment ? "question paper" : "questionnaire"} for the request above — no questions, no actions. Reply with ONLY this JSON object:
{"sections":[{"title":"<section / block name>","count":<questions>,"complexity":"simple|complex","purpose":"<what it measures, one sentence>","types":["single","multi","matrix",…],"logic":"<the logic this section needs, in words, or empty>","topic":"<exam subject, for a paper>"}],"quotas":["<quota in words>"],"randomize":["<section titles to rotate together>"],"logic":["<logic across sections, in words>"]}
Rules: the counts add up to EXACTLY ${total}. 3–20 sections in questionnaire order (screening first, profile/demographics last; a paper: one section per subject). "complex" = grids/matrices, heavy logic or scripts in most of its questions. Name quotas and randomization only when the request asks for them.
PLAN_INPUT: ${JSON.stringify({ total, ...input })}`;
}

export function designPrompt(summary: TaskSummary, outline: GenerationOutline | null): string {
  return `${summaryBlock(summary)}
${outline ? `\nSECTIONS PLANNED: ${outline.sections.map((s) => `${s.title} (${s.count})`).join(" · ")}\n` : ""}
THIS STEP: THE RESEARCH DESIGN ONLY. Reply {"kind":"proposal","reply":"<one sentence>","actions":[{"op":"set_research","objective":"…","population":"…","methodology":"…","hypotheses":["…"],"researchQuestions":["…"],"assumptions":["…"]}]} — exactly one set_research action, no questions, no constructs that name questions (the questions do not exist yet).
DESIGN_INPUT: ${JSON.stringify({ sections: outline?.sections.length ?? 0 })}`;
}

export interface BatchPromptInput {
  slots: SkeletonSlot[];
  sections: { index: number; title: string; from?: string; to?: string; count?: number; purpose?: string; types?: string[]; logic?: string; topic?: string }[];
  total: number;
  assessment?: { perQuestion: boolean; optionsCount: number } | null;
  sameSection: string[];
  round: number;
  errors?: string[];
}

export function batchPrompt(summary: TaskSummary, input: BatchPromptInput): string {
  const first = input.slots[0]?.code, last = input.slots[input.slots.length - 1]?.code;
  const secs = input.sections.map((s) => `SECTION “${s.title}”${s.count ? ` (${s.count} questions, ${s.from}–${s.to}; other steps write the rest of it — cover the part of its purpose that fits ${first}–${last}'s place in it)` : ""}${s.topic ? ` — subject: ${s.topic}` : ""}${s.purpose ? ` — ${s.purpose}` : ""}${s.types?.length ? ` — types: ${s.types.join(", ")}` : ""}${s.logic ? ` — logic: ${s.logic}` : ""}`).join("\n");
  const exam = input.assessment?.perQuestion
    ? `\nTHIS IS AN EXAM PAPER. Every question: type "single" (or "multi" for a multi-answer question) with EXACTLY ${input.assessment.optionsCount} options coded 1..${input.assessment.optionsCount} ({"label":"…","code":1}); right after each create_question add ONE {"op":"set_answer_key","target":"<the code>","correct":[<option code>],"topic":"<subject>","subtopic":"<subtopic>","explanation":"<why the correct answer is correct>","optionExplanations":{"<code>":"<why this option is wrong>"},"difficulty":"easy|medium|hard"}. Questions must be factually correct and unambiguous; no "all of the above" tricks. No marks (the paper's default applies).`
    : "";
  return `${summaryBlock(summary)}

${secs}
${input.sameSection.length ? `\nALREADY WRITTEN in these sections (do NOT repeat or rephrase them; you may reference them in logic):\n${input.sameSection.join("\n")}\n` : ""}
THIS STEP: WRITE QUESTIONS ${first}–${last} (${input.slots.length} of the ${input.total} questions). Reply {"kind":"proposal","reply":"<one sentence>","actions":[…]} with EXACTLY ONE create_question PER SLOT below, in slot order, each with that slot's "code" and "block". Complete questions: type, text, options with codes (1..n) or rows + scale, "required" where it matters, an instruction only when it helps.
Logic in this step may reference ONLY questions of this batch or the ones listed above (display logic, skips to screen_out); logic that needs other questions is written in a later step. Do NOT write create_block, delete/move, quotas, randomizers, branches or the research design — later steps do that.${exam}
BATCH_INPUT: ${JSON.stringify({ slots: input.slots.map((s) => ({ code: s.code, block: s.block, complexity: s.complexity, section: s.section })), assessment: input.assessment ?? null, round: input.round })}${input.errors?.length ? `\n\nTHE PREVIOUS ATTEMPT FOR THESE SLOTS WAS REFUSED. Fix exactly these problems:\n${list(input.errors, 30)}` : ""}`;
}

export function logicPrompt(summary: TaskSummary, input: { codes: string[]; digest: string[]; notes: string[]; round: number; errors?: string[] }): string {
  return `${summaryBlock(summary)}

THE QUESTIONS (code [type] text {option codes} · the display logic it already has) — the ones this step may NAME:
${input.digest.join("\n")}
${input.notes.length ? `\nLOGIC THE PLAN ASKS FOR:\n${list(input.notes, 30)}\n` : ""}
THIS STEP: THE LOGIC for ${input.codes[0]}–${input.codes[input.codes.length - 1]}. Reply {"kind":"proposal","reply":"<one sentence>","actions":[…]} using ONLY set_display_logic, add_skip (to a later question, "end" or "screen_out"), create_calculation, create_embedded and page_break. A rule's TARGET (set_display_logic.target, add_skip.from) must be one of: ${input.codes.join(", ")}. Conditions may read any question listed above that comes BEFORE the target; compare options by their codes; nest AND/OR/NOT with parentheses. Only logic that serves the research (screen-outs, follow-ups asked of the right people, consistency) — not every question needs logic; a question that already has display logic keeps it unless the plan asks for a change (a new rule replaces the old one).
LOGIC_INPUT: ${JSON.stringify({ targets: input.codes, round: input.round })}${input.errors?.length ? `\n\nTHE PREVIOUS ATTEMPT WAS REFUSED. Fix exactly these problems:\n${list(input.errors, 30)}` : ""}`;
}

export function quotaPrompt(summary: TaskSummary, input: { digest: string[]; notes: string[]; round: number; errors?: string[] }): string {
  return `${summaryBlock(summary)}

QUESTIONS QUOTAS MAY READ:
${input.digest.join("\n")}

QUOTAS THE PLAN ASKS FOR:
${list(input.notes.length ? input.notes : ["the request's quotas"], 10)}

THIS STEP: THE QUOTAS ONLY. Reply {"kind":"proposal","reply":"<one sentence>","actions":[…]} with create_quota actions (cells with "when" conditions on the questions above, by option code, and limits), and set_quota_check only if a check must sit somewhere specific.
QUOTA_INPUT: ${JSON.stringify({ questions: input.digest.map((d) => d.split(" ")[0]), round: input.round })}${input.errors?.length ? `\n\nTHE PREVIOUS ATTEMPT WAS REFUSED. Fix exactly these problems:\n${list(input.errors, 20)}` : ""}`;
}

export function editPrompt(summary: TaskSummary, input: { codes: string[]; digest: string[]; instruction: string; editKind: string; every: boolean; round: number; errors?: string[]; assessment?: boolean }): string {
  return `${summaryBlock(summary)}

THE QUESTIONS IN THIS STEP (code [type] text {option codes} · logic):
${input.digest.join("\n")}

THIS STEP: APPLY THE REQUEST to ${input.codes.length} question${input.codes.length === 1 ? "" : "s"} (${input.codes[0]}–${input.codes[input.codes.length - 1]})${input.every ? " — EVERY one of them must be changed" : ""}. Reply {"kind":"proposal","reply":"<one sentence>","actions":[…]} with update_question / set_display_logic / add_skip / clear_skips / set_validation${input.assessment ? " / set_answer_key" : ""} actions whose target is one of the codes above. Do not create, delete or move questions; do not touch other questions; keep codes and variables.
REQUEST: ${neutralizeUntrusted(input.instruction, { maxChars: 1500 })}
EDIT_INPUT: ${JSON.stringify({ codes: input.codes, editKind: input.editKind, every: input.every, round: input.round })}${input.errors?.length ? `\n\nTHE PREVIOUS ATTEMPT WAS REFUSED OR INCOMPLETE. Fix exactly these problems:\n${list(input.errors, 30)}` : ""}`;
}

export function methodsPrompt(summary: TaskSummary, input: { method: string; code: string; block: string; round: number; errors?: string[]; items?: string[] }): string {
  const op = input.method === "maxdiff" ? "create_maxdiff" : "create_conjoint";
  return `${summaryBlock(summary)}

THIS STEP: THE ${input.method === "maxdiff" ? "MAXDIFF" : `${input.method.toUpperCase()} CONJOINT`} DESIGN. Reply {"kind":"proposal","reply":"<one sentence>","actions":[{"op":"${op}","code":"${input.code}","block":"${input.block}",…}],"assumptions":["…"]} — exactly ONE ${op} action. ${input.method === "maxdiff" ? "items: the list from the request (8–30 distinct items); perTask (3–5), tasks and versions so every item is shown about 3 times per respondent." : `method: "${input.method}"; attributes with 2–6 levels each, taken from the request; where the request leaves the attributes or levels open, propose realistic ones for the category and list them in "assumptions"; alternatives 2–4, tasks 8–15, versions 2–10, design "efficient"; prohibitions only for impossible combinations.`} The Studio generates the design and checks it (balance, efficiency, feasibility).
METHOD_INPUT: ${JSON.stringify({ method: input.method, code: input.code, block: input.block, items: input.items ?? [], round: input.round })}${input.errors?.length ? `\n\nTHE PREVIOUS DESIGN WAS REFUSED. Fix exactly these problems:\n${list(input.errors, 20)}` : ""}`;
}

export function repairPrompt(summary: TaskSummary, input: { problems: DeliverableError[]; digest: string[]; missing: { code: string; block: string }[]; round: number }): string {
  return `${summaryBlock(summary)}

THE QUESTIONS CONCERNED:
${input.digest.join("\n") || "(none exist yet)"}

THE FINAL CHECK FOUND THESE PROBLEMS — fix EXACTLY these, nothing else:
${input.problems.slice(0, 40).map((p) => `- [${p.kind}]${p.code ? ` ${p.code}:` : ""} ${p.message}`).join("\n")}
${input.missing.length ? `\nQUESTIONS THAT WERE PLANNED BUT DO NOT EXIST — create each with create_question and exactly this code and block: ${input.missing.map((m) => `${m.code} in “${m.block}”`).join(", ")}\n` : ""}
Reply {"kind":"proposal","reply":"<one sentence>","actions":[…]} — update_question (complete options / rows / text), set_display_logic (a corrected condition, or null to drop a rule that cannot be right), clear_skips + add_skip, create_question for missing ones. Do not delete questions.
REPAIR_INPUT: ${JSON.stringify({ problems: input.problems.slice(0, 40).map((p) => ({ kind: p.kind, code: p.code ?? null })), missing: input.missing, round: input.round })}`;
}
