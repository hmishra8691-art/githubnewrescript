import type { Question, SurveyDefinition } from "@rescript/schema";
import { createResponseState, evaluateCondition, pipeTokensIn, getQuestionByCodeOrVar, type ResponseState } from "@rescript/engine";
import type { FlagDraft, RuleContext } from "../types.js";
import { normalizeText } from "../metrics.js";
import { isOpen, isSingle, screenerQuestionIds } from "../survey.js";

/* ============================================================ attention */

const codesOf = (v: unknown): string[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : typeof v === "object" ? Object.values(v as object).map(String) : [String(v)];

/** Did this attention check pass? null when unanswered (not judged). */
export function attentionResult(q: Question, answers: Record<string, unknown>): { passed: boolean; observed: string; expected: string } | null {
  const ac = q.attentionCheck;
  if (!ac) return null;
  const v = answers[q.id];
  if (v === undefined || v === null || v === "") return null;
  const got = codesOf(v);
  const want = ac.expected.map(String);
  const label = (c: string) => q.options.find((o) => String(o.code) === c)?.label.replace(/<[^>]*>/g, "") ?? c;

  if (ac.kind === "repeat" && ac.pairedQuestionId) {
    const other = codesOf(answers[ac.pairedQuestionId]);
    const same = got.length === other.length && got.every((c) => other.includes(c));
    return { passed: same, observed: got.map(label).join(", ") || "—", expected: `same as earlier answer (${other.join(", ") || "unanswered"})` };
  }
  if (ac.kind === "trap") {
    const hit = got.filter((c) => want.includes(c));
    return { passed: hit.length === 0, observed: got.map(label).join(", "), expected: `none of: ${want.map(label).join(", ")}` };
  }
  if (isOpen(q) || q.options.length === 0) {
    const norm = normalizeText(String(Array.isArray(v) ? v.join(" ") : v));
    const ok = want.some((w) => norm === normalizeText(w) || norm.includes(normalizeText(w)));
    return { passed: ok, observed: String(v).slice(0, 60), expected: want.join(" / ") };
  }
  // choice: every expected code selected and nothing else (single) / all expected present (multi)
  const passed = want.length > 0 && want.every((w) => got.includes(w)) && (got.length === want.length || !isSingle(q));
  return { passed, observed: got.map(label).join(", "), expected: want.map(label).join(", ") };
}

export function attentionRules(ctx: RuleContext): FlagDraft[] {
  const out: FlagDraft[] = [];
  const checks = ctx.def.questions.filter((q) => q.attentionCheck);
  if (!checks.length) return out;
  const failed: { q: Question; r: NonNullable<ReturnType<typeof attentionResult>> }[] = [];
  for (const q of checks) {
    const r = attentionResult(q, ctx.response.answers);
    if (r && !r.passed) failed.push({ q, r });
  }
  if (ctx.enabled("attention.failed")) {
    for (const { q, r } of failed) {
      const ac = q.attentionCheck!;
      out.push({
        ruleId: "attention.failed",
        title: `Attention check failed (${q.code})`,
        observed: r.observed, expected: r.expected,
        explanation: ac.kind === "instruction" ? `The instruction in ${q.code} was not followed.`
          : ac.kind === "trap" ? `An impossible option was chosen in ${q.code}.`
          : ac.kind === "repeat" ? `${q.code} does not agree with the question it repeats.`
          : ac.kind === "knowledge" ? `The knowledge check ${q.code} was answered incorrectly.`
          : `The attention check ${q.code} was answered incorrectly.`,
        questionIds: [q.id],
        severity: ac.severity,
        intensity: 1,
      });
    }
  }
  if (ctx.enabled("attention.multiple_failed")) {
    const n = ctx.param<number>("attention.multiple_failed", "count");
    if (failed.length >= n) {
      out.push({
        ruleId: "attention.multiple_failed",
        observed: `${failed.length} of ${checks.length} attention checks failed`,
        expected: `< ${n} failures`,
        explanation: "More than one attention check was failed — beyond a single slip.",
        questionIds: failed.map((f) => f.q.id),
        intensity: Math.min(1, 0.7 + failed.length * 0.15),
      });
    }
  }
  if (ctx.enabled("attention.knowledge_gap")) {
    for (const { q } of failed) {
      const ac = q.attentionCheck!;
      if (ac.kind !== "knowledge" || !ac.pairedQuestionId) continue;
      const claim = ctx.def.questions.find((x) => x.id === ac.pairedQuestionId);
      const v = ctx.response.answers[ac.pairedQuestionId];
      if (!claim || v === undefined) continue;
      // claimed expertise = chose the top third of an ordered scale, or any answer on a yes/no where option 1 says yes
      const idx = claim.options.findIndex((o) => String(o.code) === String(v));
      const top = idx >= 0 && claim.options.length >= 3 && idx >= claim.options.length * 0.66;
      const yes = idx >= 0 && /\b(yes|expert|very familiar|advanced)\b/i.test(claim.options[idx].label);
      if (top || yes) {
        out.push({
          ruleId: "attention.knowledge_gap",
          observed: `${claim.code} = "${claim.options[idx].label.replace(/<[^>]*>/g, "")}" but ${q.code} failed`,
          explanation: "Claimed expertise on the pairing question, then failed the knowledge test it is paired with.",
          questionIds: [claim.id, q.id],
        });
      }
    }
  }
  return out;
}

/* ============================================================ consistency */

/** A ResponseState the engine's evaluator accepts, from a stored response. */
export function stateFor(def: SurveyDefinition, answers: Record<string, unknown>, embedded?: Record<string, unknown>, calculated?: Record<string, unknown>): ResponseState {
  const st = createResponseState(def);
  st.answers = { ...(answers as ResponseState["answers"]) };
  st.embedded = { ...(embedded ?? {}) } as ResponseState["embedded"];
  st.calculated = { ...(calculated ?? {}) } as ResponseState["calculated"];
  return st;
}

export function consistencyRules(ctx: RuleContext): FlagDraft[] {
  const out: FlagDraft[] = [];
  const { def } = ctx;
  const a = ctx.response.answers;
  const state = stateFor(def, a, ctx.response.embedded, ctx.response.calculated);
  const ectx = { def, state, loop: null, quotaCounts: {} };
  const has = (id: string) => { const v = a[id]; return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0); };
  const code = (id: string) => def.questions.find((q) => q.id === id)?.code ?? id;

  /* answered while hidden: the display logic is false for the final answers */
  if (ctx.enabled("consistency.impossible_path")) {
    const hits: { q: Question; gate: string[] }[] = [];
    for (const q of def.questions) {
      if (!q.displayLogic || !has(q.id) || !ctx.applies("consistency.impossible_path", q.id)) continue;
      if (!evaluateCondition(q.displayLogic, ectx)) {
        const refs = new Set<string>();
        walkRefs(q.displayLogic, refs);
        hits.push({ q, gate: [...refs] });
      }
    }
    // also: options hidden by their own visibleIf yet selected
    for (const q of def.questions) {
      if (!has(q.id) || !q.options.some((o) => o.visibleIf)) continue;
      const chosen = codesOf(a[q.id]);
      const hidden = q.options.filter((o) => o.visibleIf && chosen.includes(String(o.code)) && !evaluateCondition(o.visibleIf, ectx));
      if (hidden.length) hits.push({ q, gate: hidden.map((o) => `option ${o.code}`) });
    }
    for (const h of hits) {
      out.push({
        ruleId: "consistency.impossible_path",
        title: `Answer contradicts an earlier gate (${h.q.code})`,
        observed: `${h.q.code} answered "${codesOf(a[h.q.id]).join(", ")}" while its display condition on ${h.gate.map(code).join(", ")} is false`,
        explanation: `The final answers hide ${h.q.code}, yet it has an answer — an earlier answer was changed and the later one no longer fits (e.g. "owns a car: No" with a car brand given).`,
        questionIds: [h.q.id, ...h.gate.filter((g) => def.questions.some((q) => q.id === g))],
        intensity: Math.min(1, 0.7 + hits.length * 0.15),
      });
    }
  }

  /* frequency vs quantity: "never"/0 alongside a positive quantity in the same block */
  if (ctx.enabled("consistency.frequency_quantity")) {
    for (const q of def.questions) {
      if (!isSingle(q) || !has(q.id)) continue;
      const o = q.options.find((x) => String(x.code) === String(a[q.id]));
      if (!o || !/\b(never|none|not at all|0 times|do not|don t)\b/i.test(normalizeText(o.label))) continue;
      // a numeric question that pipes or is gated by q, or the next numeric question
      const idx = def.questions.indexOf(q);
      const next = def.questions.slice(idx + 1, idx + 4).find((n) => (n.type === "numeric" || n.type === "slider") && has(n.id) && (dependsOn(def, n, q.id) || true));
      if (next && typeof a[next.id] === "number" && (a[next.id] as number) > 0 && dependsOn(def, next, q.id)) {
        out.push({
          ruleId: "consistency.frequency_quantity",
          observed: `${q.code} = "${o.label.replace(/<[^>]*>/g, "")}" but ${next.code} = ${a[next.id]}`,
          explanation: "A 'never' answer sits beside a positive quantity on the linked follow-up.",
          questionIds: [q.id, next.id],
        });
      }
    }
  }

  /* piping: a later question pipes an earlier answer that is now empty, or changed after it was answered */
  if (ctx.enabled("consistency.piping")) {
    const t = ctx.telemetry;
    for (const q of def.questions) {
      if (!has(q.id)) continue;
      const refs = pipeTokensIn(`${q.text} ${q.instruction ?? ""} ${q.options.map((o) => o.label).join(" ")}`).filter((tk) => tk.kind === "question");
      for (const tk of refs) {
        const src = getQuestionByCodeOrVar(def, tk.ref);
        if (!src) continue;
        if (!has(src.id)) {
          out.push({ ruleId: "consistency.piping", observed: `${q.code} pipes ${src.code}, which is unanswered`, explanation: "A question that shows an earlier answer in its text was answered while that earlier answer is empty.", questionIds: [q.id, src.id] });
          break;
        }
        const later = t?.questions[q.id]?.lastChangeAt, srcChanged = t?.questions[src.id]?.lastChangeAt;
        if (later !== undefined && srcChanged !== undefined && srcChanged > later + 1000 && (t?.questions[src.id]?.changes ?? 0) > 1) {
          out.push({ ruleId: "consistency.piping", observed: `${src.code} was changed after ${q.code} (which pipes it) had been answered`, explanation: "The piped-in answer changed after the dependent question was answered, so the later answer may no longer apply.", questionIds: [q.id, src.id] });
          break;
        }
      }
    }
  }

  /* screener edits (navigation category) */
  if (ctx.enabled("navigation.screener_edits") && ctx.telemetry) {
    const scr = screenerQuestionIds(def);
    const edited = [...scr].filter((id) => (ctx.telemetry!.questions[id]?.changes ?? 0) > 1 && isSingle(def.questions.find((q) => q.id === id)!));
    if (edited.length) {
      out.push({
        ruleId: "navigation.screener_edits",
        observed: `${edited.map(code).join(", ")} changed ${edited.map((id) => ctx.telemetry!.questions[id].changes).join(", ")} times`,
        explanation: "Screening answers were changed after first being given — consistent with hunting for the qualifying answer.",
        questionIds: edited,
      });
    }
  }

  return out;
}

function walkRefs(c: any, into: Set<string>) {
  if (!c) return;
  if (c.type === "rule") { if (c.source?.kind === "question" || c.source?.kind === "variable") into.add(c.source.ref); return; }
  for (const ch of c.children ?? []) walkRefs(ch, into);
}

function dependsOn(def: SurveyDefinition, q: Question, sourceId: string): boolean {
  const refs = new Set<string>();
  walkRefs(q.displayLogic, refs);
  if (refs.has(sourceId)) return true;
  const src = def.questions.find((x) => x.id === sourceId);
  if (!src) return false;
  return pipeTokensIn(q.text).some((tk) => tk.kind === "question" && (tk.ref === src.code || tk.ref === src.variableName || tk.ref === src.id));
}
