import type { Finding } from "./findings.js";
import type { BuilderItem } from "./reportBuilder.js";

/**
 * WHAT MAY LEAVE FOR A MODEL (Data Analytics audit A-7, Phase 2).
 *
 * The strategy is "send aggregates and claims, not respondent rows or
 * verbatims". An aggregate is only that when its cell is large enough not to
 * be one person: a group of one reported with its mean IS that person's
 * answer, and the "most mentioned words" of an open-text question are their
 * words. Both were in the prompts, unchecked.
 *
 * Applied BEFORE the prompt is built — and the same redacted view is what the
 * checker reads, so a withheld claim cannot be cited and a number from it is
 * refused like any other number the model was not shown:
 *
 *   - a finding or segment that rests on a group smaller than `MODEL_MIN_CELL`
 *     is withheld (the engine still reports it, in the deck and the tables);
 *   - an open-text analysis is shown to the model as a count only: no top
 *     words, no quotation;
 *   - an analysis whose base is below the minimum is withheld, and a sentence
 *     that states a small group's base ("n = 3") is dropped from the insights;
 *   - the finished prompt is scrubbed of anything shaped like an email address,
 *     a telephone number or a web address, which has no business in a prompt
 *     built from aggregates and is how an identifier would travel if a label or
 *     a caveat ever carried one.
 *
 * What was withheld is returned, so the audit record and the person can see it.
 */

export const MODEL_MIN_CELL = 5;
export type WithheldReason = "small_group" | "small_base" | "open_text" | "small_n_sentence";
export interface Withheld { what: string; reason: WithheldReason }

const nValues = (t: string): number[] => [...t.matchAll(/\bn\s*=\s*(\d[\d,]*)/gi)].map((m) => Number(m[1].replace(/,/g, "")));
const smallGroup = (f: Finding, min: number): boolean => (f.evidence.groups ?? []).some((g) => g.n < min) || nValues(f.headline).some((n) => n < min);

interface RunLike { findings: Finding[]; discoveries?: { segments: Finding[]; trends: Finding[]; anomalies: Finding[]; summary: string } }

/** the run as a model may see it: no finding or discovery that rests on a group below the minimum */
export function redactRunForModel<R extends RunLike>(run: R, min = MODEL_MIN_CELL): { run: R; withheld: Withheld[] } {
  const withheld: Withheld[] = [];
  const keep = (list: Finding[]) => list.filter((f) => { if (smallGroup(f, min)) { withheld.push({ what: f.headline.slice(0, 80), reason: "small_group" }); return false; } return true; });
  const out: R = { ...run, findings: keep(run.findings) };
  if (run.discoveries) out.discoveries = { ...run.discoveries, segments: keep(run.discoveries.segments), trends: keep(run.discoveries.trends), anomalies: keep(run.discoveries.anomalies) };
  return { run: out, withheld };
}

/** the analyses as a model may see them: open text as a count, small bases withheld, small groups' bases dropped */
export function redactItemsForModel(items: readonly BuilderItem[], min = MODEL_MIN_CELL): { items: BuilderItem[]; withheld: Withheld[] } {
  const withheld: Withheld[] = [];
  const out: BuilderItem[] = [];
  for (const it of items) {
    const r = it.result;
    if (r.base.n < min) { withheld.push({ what: it.name, reason: "small_base" }); continue; }
    if (r.kind === "text") {
      withheld.push({ what: it.name, reason: "open_text" });
      out.push({ ...it, result: { ...r, insights: [`Open-text responses were read (${r.base.n} answered); the words people used are not sent to the model.`], warnings: [], tables: [], chart: { ...r.chart, words: undefined } } });
      continue;
    }
    const insights = r.insights.filter((s) => { if (nValues(s).some((n) => n < min)) { withheld.push({ what: s.slice(0, 80), reason: "small_n_sentence" }); return false; } return true; });
    out.push(insights.length === r.insights.length ? it : { ...it, result: { ...r, insights } });
  }
  return { items: out, withheld };
}

/** the last defence on a finished prompt: anything shaped like an email address, a telephone number or a web address becomes a token */
export function redactPrompt(text: string): { text: string; masked: number } {
  let masked = 0;
  const sub = (re: RegExp, token: string) => { text = text.replace(re, () => { masked++; return token; }); };
  sub(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
  sub(/\bhttps?:\/\/[^\s)]*[^\s).,;:!?]/gi, "[link]");
  sub(/\+\d[\d\s().-]{7,}\d/g, "[phone]");
  sub(/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "[phone]");
  return { text, masked };
}
