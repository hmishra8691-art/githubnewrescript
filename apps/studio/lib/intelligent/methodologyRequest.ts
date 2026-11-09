import { recommendMethodology, type MethodologyRecommendation } from "@rescript/engine";

/**
 * "WHICH METHOD SHOULD I USE?" (2026-11-09) — Intelligent Mode's reading of a methodology question. Only a sentence that
 * ASKS about method, approach or study design (or whether a named method fits) is taken here; "create a pricing survey"
 * stays with the Copilot. The answer is the methodology engine's (deterministic), and the Study design panel opens with
 * the same objective to configure and build it.
 */
const ASKS = /\b(?:which|what|recommend|best|right|suitable|appropriate|suggest|should i use|should we use|how should (?:i|we))\b.{0,50}\b(?:method(?:ology)?|approach|study design|research design|kind of (?:study|research)|type of (?:study|research)|technique)\b|\bis (?:a |an )?\w+(?: \w+){0,3} (?:the right|appropriate|a good|suitable) (?:method|approach|choice)\b|\b(?:method(?:ology)?|approach|design) (?:for|to)\b.{0,80}\b(?:price|pricing|concept|brand|ad|campaign|employee|segment|feature|nps|satisfaction|track)/i;

export function methodologyQuestion(text: string): MethodologyRecommendation | null {
  if (!ASKS.test(text)) return null;
  return recommendMethodology(text);
}

export function methodologyAnswer(r: MethodologyRecommendation): { answer: string; sections: { title: string; items: { label: string; detail?: string }[] }[] } {
  return {
    answer: `${r.proposed && !r.proposed.fits ? `${r.proposed.method.name} does not answer this objective: ${r.proposed.problem} ` : ""}This is ${r.categoryName.toLowerCase()} research. I recommend ${r.recommended.name} — ${r.recommended.fit}. Open Research tools → Study design to configure and build it — it starts from this objective: the questions, the design file, the analysis plan and a simulation.`,
    sections: [
      { title: "Why", items: r.why.map((w) => ({ label: w })) },
      ...(r.alternatives.length ? [{ title: "Alternatives", items: r.alternatives.map((a) => ({ label: a.method.name, detail: a.when })) }] : []),
      ...(r.missing.length ? [{ title: "Still needed", items: r.missing.map((m) => ({ label: m })) }] : []),
    ],
  };
}

/* the objective (from Intelligent Mode) and/or the method picked in Design Generators → Methods */
let pending: { objective: string; methodId?: string } | null = null;
export function setPendingMethodology(p: { objective: string; methodId?: string } | null): void { pending = p; }
export function takePendingMethodology(): { objective: string; methodId?: string } | null { const p = pending; pending = null; return p; }
