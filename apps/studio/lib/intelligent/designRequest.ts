import { readDesignRequest, recommendDesign, DESIGN_KIND_NAMES } from "@rescript/designs";

/**
 * "CREATE A CBC WITH SIX ATTRIBUTES, 12 TASKS AND 3 ALTERNATIVES" (2026-11-09) — Intelligent Mode's reading of a
 * design request. The same engine as Design Generators → Describe it: the request is understood, completed by the
 * platform's rules and explained; Design Generators opens on it to review, fill in what is missing, generate and
 * export. A request that already names the attributes or items is also something the Copilot can build directly
 * (create_conjoint / create_maxdiff) — this answer never claims a design was made.
 */
const ASKS = /\b(?:create|generate|build|design|make|set up|recommend|need|want)\b.{0,60}\b(?:cbc|acbc|conjoint|max ?diff|best[- ]worst|menu[- ]based|rating[- ]based|discrete choice|factorial|fractional|latin square|williams|incomplete block|experimental design|choice (?:tasks|experiment))\b/i;
const QUESTION = /\bwhich method\b|\bwhat method\b/i;

export function designRequestQuestion(text: string): boolean { return ASKS.test(text) && !QUESTION.test(text); }

export function designRequestAnswer(text: string): { answer: string; sections: { title: string; items: { label: string; detail?: string }[] }[]; kind: string } {
  const read = readDesignRequest(text);
  const rec = recommendDesign(read);
  const name = DESIGN_KIND_NAMES[rec.kind];
  return {
    kind: rec.kind,
    answer: `${name}: ${rec.why[0] ?? ""} ${rec.questions.length ? `To generate it I still need: ${rec.questions.map((q) => q.ask.replace(/\.$/, "")).join("; ")}.` : "Everything needed is there."} Open Research Tools → Design Generators: it starts on this request in ${name} → Describe it, to review, fill in, generate, check and export the design — nothing has been generated yet.`,
    sections: [
      ...(read.understood.length ? [{ title: "Understood", items: read.understood.map((u) => ({ label: u })) }] : []),
      { title: "Why this configuration", items: rec.why.map((w) => ({ label: w })) },
      ...(rec.assumptions.length ? [{ title: "Assumed", items: rec.assumptions.map((w) => ({ label: w })) }] : []),
      ...(rec.warnings.length ? [{ title: "Check", items: rec.warnings.map((w) => ({ label: w })) }] : []),
    ],
  };
}

let pending: string | null = null;
export function setPendingDesignRequest(text: string | null): void { pending = text; }
export function takePendingDesignRequest(): string | null { const p = pending; pending = null; return p; }
