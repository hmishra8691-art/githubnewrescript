import type { SurveyDefinition } from "@rescript/schema";
import { carriedCount, effectiveLocalization, translationCoverage, translationInventory } from "@rescript/engine";

/**
 * I5 — QUOTAS AND TRANSLATIONS, BROUGHT ACROSS AND CHECKED. After an import, what the survey arrives with for
 * fieldwork that was already under way and for its other languages, checked against the imported survey itself:
 *
 *   quotas      each quota's cells, their maximums, the completes carried over from the source (and where from), the
 *               cells that are already full from those completes, and — when the source carried no counts — a plain
 *               sentence saying so and what to send (a quota report: label, target, achieved)
 *   languages   each language version through the same final check the translation tasks use
 *               (`translationCoverage`): how many of the questionnaire's strings it has, which are missing, which
 *               came across broken (a piping token, a placeholder or HTML that does not match the source) or still
 *               in the source language. Survey-level and interface strings are not part of an imported translation
 *               and are not counted; the report says so.
 *
 * Pure: no I/O. The numbers are the imported survey's, not the source's claims about itself.
 */

export interface QuotaCarryCheck {
  quotaId: string;
  quota: string;
  cells: number;
  /** sum of the count maximums (percent cells are left out of the sum) */
  maximum: number;
  /** completes carried over, all cells */
  carried: number;
  /** cells that have a carried-over count */
  cellsWithCounts: number;
  /** cells already full from what was carried over: label, count, maximum */
  full: { label: string; carried: number; maximum: number }[];
  sources: string[];
}

export interface LanguageCheck {
  code: string;
  total: number;
  translated: number;
  percent: number;
  missingCount: number;
  /** the first missing strings, by label ("Q3 · option 4") */
  missing: string[];
  staleCount: number;
  /** strings that came across but fail the check: label and why */
  invalid: { label: string; kind: string; message: string }[];
  complete: boolean;
}

export interface FieldState {
  quotas: QuotaCarryCheck[];
  /** said when quotas exist and none carries a count */
  quotaCountsNote: string | null;
  languages: LanguageCheck[];
  /** what the language check does not cover */
  languagesNote: string | null;
  /** short sentences for the import summary */
  summary: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const MAX_LISTED = 25;

export function fieldStateOf(def: SurveyDefinition, opts: { importedQuotaIds?: string[]; importedLanguages?: string[] } = {}): FieldState {
  const quotas: QuotaCarryCheck[] = [];
  const scopeQuotas = opts.importedQuotaIds ? def.quotas.filter((q) => opts.importedQuotaIds!.includes(q.id)) : def.quotas;
  for (const q of scopeQuotas) {
    const full: QuotaCarryCheck["full"] = [];
    const sources = new Set<string>();
    let carried = 0, withCounts = 0, maximum = 0;
    for (const c of q.cells) {
      const n = carriedCount(c);
      if (c.limitType === "count") maximum += c.limit;
      if (!n) continue;
      carried += n; withCounts++;
      if (c.carried?.source) sources.add(c.carried.source);
      const max = c.limitType === "count" ? c.limit : q.targetTotal ? Math.floor((c.limit / 100) * q.targetTotal) : 0;
      if (max > 0 && n >= max) full.push({ label: c.label, carried: n, maximum: max });
    }
    quotas.push({ quotaId: q.id, quota: q.name, cells: q.cells.length, maximum, carried, cellsWithCounts: withCounts, full, sources: [...sources] });
  }
  const anyCounts = quotas.some((q) => q.carried > 0);
  const quotaCountsNote = quotas.length && !anyCounts
    ? "The source carried no quota counts, so every cell starts at 0 here. If fieldwork already ran there, send its quota report (each cell's label, target and achieved completes) and the counts are carried over."
    : null;

  const loc = effectiveLocalization(def);
  const codes = (opts.importedLanguages ?? loc.languages.map((l) => l.code)).filter((c) => c && c !== loc.sourceLanguage);
  const languages: LanguageCheck[] = [];
  if (codes.length) {
    const units = translationInventory(def, { questionIds: def.questions.map((q) => q.id), surveyLevel: false, excludeUi: true }).units;
    const labelOf = new Map(units.map((u) => [u.key, u.label]));
    for (const code of codes) {
      const cov = translationCoverage(def, code, units);
      languages.push({
        code, total: cov.total, translated: cov.translated, percent: cov.percent,
        missingCount: cov.missing.length, missing: cov.missing.slice(0, MAX_LISTED).map((k) => labelOf.get(k) ?? k),
        staleCount: cov.stale.length,
        invalid: cov.invalid.slice(0, MAX_LISTED).map((i) => ({ label: i.label, kind: i.kind, message: i.message })),
        complete: cov.complete,
      });
    }
  }
  const languagesNote = languages.length ? "Checked over the questionnaire's text, options and rows. The survey's title, end messages and interface strings are not part of an imported translation; translate them in Languages." : null;

  const summary: string[] = [];
  if (anyCounts) {
    const total = quotas.reduce((n, q) => n + q.carried, 0);
    const fullCells = quotas.flatMap((q) => q.full.map((f) => `${q.quota} · ${f.label}`));
    summary.push(`Quota counts: ${plural(total, "complete")} carried over from the source into ${plural(quotas.filter((q) => q.carried).length, "quota")}; they count toward the live maximums, never the test ones${fullCells.length ? `. Already full: ${fullCells.slice(0, 6).join(", ")}${fullCells.length > 6 ? ` and ${fullCells.length - 6} more` : ""}` : ""}.`);
  } else if (quotaCountsNote) summary.push(quotaCountsNote);
  for (const l of languages) {
    summary.push(l.complete
      ? `${l.code}: all ${l.total} questionnaire strings came across and pass the translation check.`
      : `${l.code}: ${l.translated} of ${l.total} questionnaire strings came across and pass the check (${l.percent}%)${l.missingCount ? `; ${l.missingCount} missing` : ""}${l.invalid.length ? `; ${plural(l.invalid.length, "string")} broken (${[...new Set(l.invalid.map((i) => i.kind.replace(/_/g, " ")))].join(", ")})` : ""}${l.staleCount ? `; ${l.staleCount} out of date` : ""}.`);
  }
  return { quotas, quotaCountsNote, languages, languagesNote, summary };
}
