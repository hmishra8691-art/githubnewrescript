import type { SurveyDefinition, UxBehavior } from "@rescript/schema";
import { readScript, similarity } from "./scriptAst.js";
import { uxBehaviorTrigger, uxTargetKey } from "./ux.js";

/**
 * A SECOND BEHAVIOUR FOR THE SAME THING, FOUND BY WHAT IT DOES (engine weakness #14a, 2026-10-22).
 *
 * The exact check (`uxBehaviorKey`) compares target + event + options + guard, and a hand-written script that decides
 * its own event has no key at all — so "show a popup when option 1 is picked" written once as a `show_popup` effect
 * and once as a script, or the same script re-sent with renamed variables and other quotes, both ran: two popups,
 * two messages. Here two behaviours are compared by their TARGET (the question), their TRIGGER (declared, or read
 * from the script's `rs.listen` and the option codes its handler filters on), the EFFECTS they have (popups opened,
 * effects run, `rs` calls) and, for two scripts, their normalised token streams (`similarity`, 0…1). A twin is
 * refused with the id to update — one mechanism per behaviour.
 *
 *   same popup on the same question   both open a popup on overlapping triggers
 *   identical effects                 the same non-empty effect set on overlapping triggers
 *   near-duplicate script             two scripts ≥ NEAR_DUPLICATE alike on overlapping triggers
 *
 * Triggers overlap when the events are the same (select ≡ select_option, page_enter ≡ appear), the guards are the
 * same, and the option codes intersect (or either does not name any). Behaviours on different options, events,
 * questions or guards are different behaviours, however alike their code.
 */

export const NEAR_DUPLICATE = 0.85;

export interface BehaviourFingerprint {
  question: string;
  event: string;
  /** option codes it is limited to; null = any (or not said) */
  options: string[] | null;
  when: string;
  /** the popups it opens (their texts; null when not literal) */
  popups: (string | null)[];
  /** what it does, as comparable words */
  effects: string[];
  script: string | null;
}

const EVENT: Record<string, string> = { select: "select_option", select_option: "select_option", deselect: "deselect_option", deselect_option: "deselect_option", complete: "page_complete", page_complete: "page_complete", page_enter: "page_enter", appear: "page_enter", answer: "answer", change: "change", input: "change", click: "click", hover: "hover", block_complete: "block_complete" };

export function behaviourFingerprint(b: UxBehavior): BehaviourFingerprint {
  const question = b.target.questionId ?? uxTargetKey(b.target);
  const targetOptions = b.target.kind === "option" && b.target.code ? [String(b.target.code)] : null;
  const when = JSON.stringify(b.when ?? null);
  if (!b.script) {
    const opts = b.options?.length ? b.options.map(String).sort() : targetOptions;
    return {
      question, event: EVENT[b.on ?? "page_enter"] ?? b.on ?? "page_enter", options: opts, when,
      popups: b.effects.filter((e) => e.do === "show_popup").map((e) => e.text ?? null),
      effects: b.effects.map((e) => `${e.do}|${e.target ? uxTargetKey(e.target) : "self"}|${e.text ?? e.className ?? e.preset ?? JSON.stringify(e.style ?? {})}`).sort(),
      script: null,
    };
  }
  const r = readScript(b.script);
  const wrapped = uxBehaviorTrigger(b);
  const self = r.listens.filter((l) => l.target === "self" || l.target === null);
  /* the engine's own wrapper names its options; a handler that filters by itself says them in its body */
  const first = wrapped ? { event: wrapped.on, options: wrapped.options.length ? wrapped.options : self[0]?.options ?? null } : self[0] ? { event: EVENT[self[0].event] ?? self[0].event, options: self[0].options } : { event: "page_enter", options: null };
  return {
    question, event: EVENT[first.event] ?? first.event, options: first.options ?? targetOptions, when,
    popups: r.popups,
    effects: r.rsCalls.filter((c) => c.method !== "listen").map((c) => `rs.${c.method}(${c.args.map((a) => (a === null ? "?" : JSON.stringify(a))).join(",")})`).sort(),
    script: b.script,
  };
}

const overlaps = (a: BehaviourFingerprint, b: BehaviourFingerprint): boolean =>
  a.question === b.question && a.event === b.event && a.when === b.when
  && (!a.options || !b.options || a.options.some((o) => b.options!.includes(o)));

export interface SemanticTwin { twin: UxBehavior; why: string; similarity?: number }

/** the behaviour already in `list` that `b` repeats by what it does, or null */
export function semanticTwin(def: SurveyDefinition, list: readonly UxBehavior[], b: UxBehavior): SemanticTwin | null {
  void def;
  const fb = behaviourFingerprint(b);
  let best: SemanticTwin | null = null;
  for (const x of list) {
    if (x.id === b.id) continue;
    const fx = behaviourFingerprint(x);
    if (!overlaps(fb, fx)) continue;
    const sim = fb.script && fx.script ? similarity(fb.script, fx.script) : undefined;
    const optionsBoth = !!fb.options && !!fx.options;
    const sameText = fb.popups.some((t) => t !== null && fx.popups.includes(t));
    if (fb.popups.length && fx.popups.length && (optionsBoth || sameText || (fb.options === null && fx.options === null) || (sim ?? 0) >= 0.6)) {
      return { twin: x, why: `both open a popup on the same question for the same answer${sameText ? " with the same text" : ""}`, ...(sim !== undefined ? { similarity: sim } : {}) };
    }
    if (sim !== undefined && sim >= NEAR_DUPLICATE && (!best || (best.similarity ?? 0) < sim)) best = { twin: x, why: `its script is ${Math.round(sim * 100)} % the same as that one's once names, quotes, spacing and comments are set aside`, similarity: sim };
    else if (fb.effects.length && fb.effects.join("\u0001") === fx.effects.join("\u0001")) best ??= { twin: x, why: "it does exactly what that one does on the same event", ...(sim !== undefined ? { similarity: sim } : {}) };
  }
  return best;
}
