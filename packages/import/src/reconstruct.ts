import type { FlowNode, Question, SurveyDefinition } from "@rescript/schema";
import { questionOrder, innermostLoopOf, stripHtmlText } from "@rescript/engine";
import type { CanonicalDynamic, CanonicalSurvey } from "./canonical.js";
import { nativeCapability } from "./nativeRegistry.js";

/**
 * RECONSTRUCTION, CHECKED AND SELF-CORRECTED (2026-11-02).
 *
 * After the mapper has built the survey, every DYNAMIC relationship in it — a carried or masked list, a loop, a
 * pipe — is checked against what the engine will do with it at runtime, corrected where the first mapping cannot
 * work as the source intended, re-checked after any correction, and explained. Nothing is invented: a correction
 * only ever uses a native capability from the registry (nativeRegistry.ts), and what cannot be corrected is
 * reported, never dropped.
 *
 * ## Corrections (each the smallest change that keeps the source's behaviour)
 *
 *   duplicate list     the document listed the brands AND said "carry forward from Q1": the carried list and the
 *                      written copy would both show. The written copy goes (the carried options keep Q1's codes,
 *                      so the codes and the respondent's own choices line up); what Q1 does not have
 *                      ("None of these") stays as the question's own.
 *   loop over one      a loop over the answers of a SINGLE-choice question runs once: it becomes the plain
 *                      questions with the chosen answer piped where the loop's item was ({{loop.label}} →
 *                      {{CODE}}) — the same wording, no loop.
 *   carried into text  a carried list on a question typed as text (no list can show) is reported, not forced.
 *
 * ## Categories (the review screen groups them)
 *
 *   reconstructed   mapped to its native equivalent as the source states it — counted, not listed
 *   alternative     rebuilt with another native feature, with the reason
 *   confirm         read from informal words or inferred ("the previous question") — works, but a person should confirm
 *   partial         built, with a known difference (a pipe that reads a question asked later)
 *   unsupported     cannot be built here; kept as the source wrote it and said
 */
export type ReconCategory = "reconstructed" | "alternative" | "confirm" | "partial" | "unsupported";
export interface ReconItem {
  category: ReconCategory;
  feature: string;
  /** the question's Rescript code, or a flow node */
  location: string;
  questionId?: string;
  /** what the source said or contained */
  original: string;
  /** what it was understood to mean */
  interpretation: string;
  /** what Rescript has now, natively */
  implementation: string;
  /** why that implementation */
  why: string;
  /** what, if anything, the researcher must do */
  action?: string;
}
export interface Reconstruction {
  items: ReconItem[];
  counts: Record<ReconCategory, number>;
  /** per feature: how many were reconstructed directly, and how many any other way */
  byFeature: Record<string, Record<ReconCategory, number>>;
  /** passes of check → correct → re-check run */
  passes: number;
}

const norm = (s: string) => stripHtmlText(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const FEATURE_WORD: Record<string, string> = { carry_forward: "Carry forward", mask: "Masking", same_list: "Same list", loop: "Loop", pipe: "Piping", loop_pipe: "Loop item piping", embedded_pipe: "Embedded data piping" };

export function reconstruct(c: CanonicalSurvey, def: SurveyDefinition, idOf: Map<string, string>): Reconstruction {
  const items: ReconItem[] = [];
  const byId = () => new Map(def.questions.map((q) => [q.id, q]));
  const srcOfId = new Map([...idOf].map(([src, id]) => [id, src]));
  const dynFor = (q: Question, features: string[]): CanonicalDynamic | undefined => (c.dynamics ?? []).find((d) => idOf.get(d.questionId) === q.id && features.includes(d.feature));
  const impl = (id: string, detail: string) => `${nativeCapability(id)?.feature ?? id}: ${detail}`;
  let passes = 0;

  /* ------------------------------------------------------------ check → correct → re-check */
  for (let changed = true; changed && passes < 3;) {
    changed = false;
    passes++;
    const qs = byId();
    for (const q of def.questions) {
      const cf = q.carryForward;
      if (!cf || cf.keepOwn === false || !(q.options?.length)) continue;
      const src = qs.get(cf.sourceQuestionId);
      if (!src) continue;
      /* the written copy of a carried list */
      const srcLabels = new Set((src.options ?? []).map((o) => norm(o.label)));
      const dup = q.options.filter((o) => srcLabels.has(norm(o.label)));
      if (!dup.length) continue;
      /*
       * A QSF states its behaviour structurally: a carried question that ALSO has the same choices of its own shows
       * both in Qualtrics. That is kept as the source has it, and flagged — only a document's written copy of the
       * list it says to carry is the same list twice by construction.
       */
      if (c.source.platform !== "document") {
        if (!items.some((i) => i.questionId === q.id && i.feature === "carry_forward")) items.push({ category: "confirm", feature: "carry_forward", location: q.code, questionId: q.id, original: `${srcOfId.get(q.id) ?? q.code} carries ${srcOfId.get(src.id) ?? src.code}'s choices and also lists ${dup.length} of the same choices as its own`, interpretation: `respondents are shown the carried answers and, again, the question's own copy of them`, implementation: impl("carry_forward", `${src.code} → ${q.code} (${cf.filter.replace("_", " ")}) plus its own ${q.options.length} answers, as in the source`), why: "Kept exactly as the source has it — the source platform shows both lists too.", action: `If the copy was not meant to show, remove ${q.code}'s own ${dup.map((o) => `“${stripHtmlText(o.label)}”`).join(", ")}.` });
        continue;
      }
      const rest = q.options.filter((o) => !srcLabels.has(norm(o.label)));
      q.options = rest;
      q.carryForward = { ...cf, keepOwn: rest.length > 0 };
      changed = true;
      const d = dynFor(q, ["carry_forward", "mask", "same_list"]);
      items.push({ category: "alternative", feature: "carry_forward", location: q.code, questionId: q.id, original: d?.original ?? `${q.code} listed ${dup.length} answers and carried ${src.code}'s list`, interpretation: `${q.code} shows the answers taken from ${src.code}; the ${dup.length} answer${dup.length === 1 ? "" : "s"} written under it ${dup.length === 1 ? "is" : "are"} the same list.`, implementation: impl("carry_forward", `${src.code} → ${q.code} (${cf.filter.replace("_", " ")})${rest.length ? `, plus its own ${rest.map((o) => `“${stripHtmlText(o.label)}”`).join(", ")}` : ""}`), why: `Kept once, from ${src.code}: the carried answers keep ${src.code}'s codes, so what a respondent chose there and what they are shown here line up — the written copy would have shown every brand twice.`, });
    }
    /* a loop over one answer: no loop, the answer piped */
    const unloop = (ns: FlowNode[]): FlowNode[] => ns.flatMap((n): FlowNode[] => {
      const x = n as FlowNode & { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] };
      if (x.type === "loop") {
        const lp = x as unknown as { id: string; loopVar: string; source: { kind: string; questionId?: string }; children: FlowNode[]; title?: string };
        const src = lp.source.kind === "question" && lp.source.questionId ? qs.get(lp.source.questionId) : undefined;
        if (src && (src.type === "single_select" || src.type === "dropdown") && !src.carryForward) {
          changed = true;
          const members: string[] = [];
          const walk = (cs: FlowNode[]) => { for (const m of cs as (FlowNode & { questionIds?: string[]; children?: FlowNode[] })[]) { if (m.type === "page") members.push(...(m.questionIds ?? [])); if (m.children) walk(m.children); } };
          walk(lp.children);
          for (const id of members) {
            const mq = qs.get(id);
            if (!mq) continue;
            const swap = (t?: string) => t?.replace(/\{\{\s*loop\.label\s*\}\}/g, `{{${src.code}}}`);
            mq.text = swap(mq.text) ?? mq.text;
            if (mq.instruction) mq.instruction = swap(mq.instruction);
            for (const o of mq.options ?? []) o.label = swap(o.label) ?? o.label;
          }
          items.push({ category: "alternative", feature: "loop", location: lp.title ?? lp.id, original: (c.dynamics ?? []).find((d) => d.feature === "loop" && idOf.get(d.sourceId ?? "") === src.id)?.original ?? `a loop over ${src.code}`, interpretation: `${members.map((m) => qs.get(m)?.code).join(", ")} ${members.length === 1 ? "is" : "are"} to be asked for each answer chosen at ${src.code} — but ${src.code} takes one answer, so the loop would run once.`, implementation: impl("piping", `${src.code}'s answer piped where the loop's item was`), why: "The same questions, asked once, with the chosen answer written in: no loop to run, no per-item variables for an analyst to unpick." });
          return unloop(lp.children);
        }
      }
      if (x.children) x.children = unloop(x.children);
      if (x.branches) for (const b of x.branches) b.children = unloop(b.children);
      if (x.otherwise) x.otherwise = unloop(x.otherwise);
      return [n];
    });
    def.flow = unloop(def.flow);
  }

  /* ------------------------------------------------------------ the final state, explained */
  const qs = byId();
  const order = questionOrder(def);
  const pos = (id: string) => order.indexOf(id);
  const explained = new Set(items.map((i) => `${i.feature}|${i.questionId ?? i.location}`));
  for (const q of def.questions) {
    const cf = q.carryForward;
    if (!cf) continue;
    if (explained.has(`carry_forward|${q.id}`)) continue;
    const src = qs.get(cf.sourceQuestionId);
    const d = dynFor(q, ["carry_forward", "mask", "same_list"]);
    const feature = cf.filter === "not_selected" ? "mask" : cf.filter === "all" ? "same_list" : "carry_forward";
    const original = d?.original ?? `${srcOfId.get(q.id) ?? q.code} carries choices from ${src ? srcOfId.get(src.id) ?? src.code : cf.sourceQuestionId} (${cf.filter.replace("_", " ")})`;
    const interpretation = d?.interpretation ?? `${q.code}'s list is the answers of ${src?.code ?? cf.sourceQuestionId} that were ${cf.filter.replace("_", " ")}.`;
    const implementation = impl("carry_forward", `${src?.code ?? cf.sourceQuestionId} → ${q.code}, filter ${cf.filter.replace("_", " ")}${cf.keepOwn ? " plus its own answers" : ""}`);
    if (!src) { items.push({ category: "unsupported", feature, location: q.code, questionId: q.id, original, interpretation, implementation: "—", why: `${cf.sourceQuestionId} is not in the survey.`, action: "Choose the question the list comes from in Studio." }); continue; }
    if (pos(src.id) > pos(q.id)) { items.push({ category: "partial", feature, location: q.code, questionId: q.id, original, interpretation, implementation, why: `${src.code} is asked after ${q.code}, so its answers are not known yet when ${q.code} is shown.`, action: `Move ${q.code} after ${src.code}, or carry from a question asked before it.` }); continue; }
    if (!/select|dropdown|ranking|matrix/.test(q.type)) { items.push({ category: "partial", feature, location: q.code, questionId: q.id, original, interpretation, implementation, why: `${q.code} is a ${q.type.replace(/_/g, " ")} question, which shows no list.`, action: `Change ${q.code} to a choice question.` }); continue; }
    items.push({ category: d?.confidence === "inferred" ? "confirm" : "reconstructed", feature, location: q.code, questionId: q.id, original, interpretation, implementation, why: d?.confidence === "inferred" ? "The source was read as “the previous question” — confirm it is the right one." : "The native carry-forward: the list follows the respondent's answer at runtime and keeps the source's codes.", ...(d?.confidence === "inferred" ? { action: `Confirm ${q.code} takes its list from ${src.code}.` } : {}) });
  }
  const loops: { id: string; title?: string; loopVar: string; source: { kind: string; questionId?: string; filter?: string }; members: string[] }[] = [];
  const findLoops = (ns: FlowNode[]) => { for (const n of ns as (FlowNode & { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] })[]) {
    if (n.type === "loop") { const members: string[] = []; const w = (cs: FlowNode[]) => { for (const m of cs as (FlowNode & { questionIds?: string[]; children?: FlowNode[] })[]) { if (m.type === "page") members.push(...(m.questionIds ?? [])); if (m.children) w(m.children); } }; w(n.children); loops.push({ ...(n as unknown as { id: string; title?: string; loopVar: string; source: { kind: string; questionId?: string; filter?: string } }), members }); }
    if (n.children) findLoops(n.children); for (const b of n.branches ?? []) findLoops(b.children); if (n.otherwise) findLoops(n.otherwise);
  } };
  findLoops(def.flow);
  for (const lp of loops) {
    const src = lp.source.kind === "question" && lp.source.questionId ? qs.get(lp.source.questionId) : undefined;
    const mem = lp.members.map((m) => qs.get(m)?.code ?? m);
    const d = (c.dynamics ?? []).find((x) => x.feature === "loop" && lp.members.includes(idOf.get(x.questionId) ?? ""));
    const original = d?.original ?? (lp.source.kind === "question" ? `a loop over ${src ? srcOfId.get(src.id) ?? src.code : lp.source.questionId}` : "a loop over a fixed list");
    const interpretation = `${mem.join(", ")} ${mem.length === 1 ? "is" : "are"} asked once for each ${lp.source.kind === "question" ? `answer ${lp.source.filter === "not_selected" ? "NOT " : ""}selected at ${src?.code ?? lp.source.questionId}` : "item of the list"}, each answer stored separately.`;
    const implementation = impl("loop", `loop ${lp.loopVar} over ${src?.code ?? (lp.source.kind === "question" ? lp.source.questionId : "a list")}${lp.source.filter ? ` (${lp.source.filter.replace("_", " ")})` : ""} around ${mem.join(", ")}; answers stored as <question>@<item code>, the item piped as {{loop.label}}`);
    if (lp.source.kind === "question" && !src) { items.push({ category: "unsupported", feature: "loop", location: lp.title ?? lp.id, original, interpretation, implementation: "—", why: `${lp.source.questionId} is not in the survey.`, action: "Choose the question to loop over in Studio." }); continue; }
    if (src && lp.members.some((m) => pos(m) >= 0 && pos(m) < pos(src.id))) { items.push({ category: "partial", feature: "loop", location: lp.title ?? lp.id, original, interpretation, implementation, why: `${src.code} is asked after the loop, so there is nothing to loop over yet.`, action: `Move the loop after ${src.code}.` }); continue; }
    items.push({ category: d?.confidence === "inferred" ? "confirm" : "reconstructed", feature: "loop", location: lp.title ?? lp.id, original, interpretation, implementation, why: d?.confidence === "inferred" ? `The question to loop over was taken as ${src?.code} (the nearest earlier question with several answers) — confirm it.` : "The native loop: one pass per item, answers stored per item, the item's label piped.", ...(d?.confidence === "inferred" ? { action: `Confirm the loop runs over ${src?.code}.` } : {}) });
  }
  /* pipes: every {{CODE…}} token in the words, checked against the survey's order */
  const codes = new Map(def.questions.map((q) => [q.code.toUpperCase(), q]));
  for (const q of def.questions) {
    const fields: [string, string | undefined][] = [["the question", q.text], ["the instruction", q.instruction], ...(q.options ?? []).map((o): [string, string] => [`option ${o.code}`, o.label])];
    for (const [where, text] of fields) for (const m of (text ?? "").matchAll(/\{\{\s*([A-Za-z_][\w]*)((?:\[[^\]]*\])?(?:\.[\w.]+)?)\s*\}\}/g)) {
      const name = m[1];
      if (/^(?:ed|loop|embedded|calc|panel|quota|survey|respondent|meta)$/i.test(name)) {
        if (name === "loop" && !innermostLoopOf(def, q.id)) items.push({ category: "partial", feature: "loop_pipe", location: q.code, questionId: q.id, original: m[0], interpretation: `the current loop item, in ${where}`, implementation: impl("piping", m[0]), why: `${q.code} is not inside a loop, so the item is empty.`, action: `Put ${q.code} inside the loop, or replace the placeholder.` });
        continue;
      }
      const src = codes.get(name.toUpperCase());
      const d = (c.dynamics ?? []).find((x) => x.feature === "pipe" && idOf.get(x.questionId) === q.id && idOf.get(x.sourceId ?? "") === src?.id);
      const original = d?.original ?? m[0];
      if (!src) continue; // an unknown token is the mapper's unresolved reference, reported there
      const later = pos(src.id) > pos(q.id) || src.id === q.id;
      if (later) items.push({ category: "partial", feature: "pipe", location: q.code, questionId: q.id, original, interpretation: `${src.code}'s answer written into ${where} of ${q.code}`, implementation: impl("piping", m[0]), why: `${src.code} is asked ${src.id === q.id ? "on this question itself" : "after"} ${q.code}, so the piped text is empty when ${q.code} is shown.`, action: `Pipe from a question asked before ${q.code}.` });
      else items.push({ category: "reconstructed", feature: d ? "pipe" : "pipe", location: q.code, questionId: q.id, original, interpretation: `${src.code}'s answer written into ${where} of ${q.code}`, implementation: impl("piping", m[0]), why: "Native piping, resolved at runtime from the respondent's answer." });
    }
  }
  /* what the words asked for that no rule could read: the clarification engine asks; listed here so nothing is silent */
  for (const i of c.issues) if (i.type === "ambiguous" && i.instruction?.kind === "dynamic") {
    const id = idOf.get(i.instruction.questionId);
    items.push({ category: "confirm", feature: "dynamic", location: def.questions.find((q) => q.id === id)?.code ?? i.instruction.questionId, ...(id ? { questionId: id } : {}), original: i.instruction.text, interpretation: "a list or a repetition taken from an earlier answer — but which one is not said", implementation: "— (not built until you choose)", why: i.message, action: "Answer the question about it in the import's open questions (or with AI suggestions)." });
  }

  const counts = { reconstructed: 0, alternative: 0, confirm: 0, partial: 0, unsupported: 0 } as Record<ReconCategory, number>;
  const byFeature: Reconstruction["byFeature"] = {};
  for (const i of items) {
    counts[i.category]++;
    const f = (byFeature[FEATURE_WORD[i.feature] ?? i.feature] ??= { reconstructed: 0, alternative: 0, confirm: 0, partial: 0, unsupported: 0 });
    f[i.category]++;
  }
  return { items, counts, byFeature, passes };
}
