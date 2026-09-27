import type { CanonicalSurvey, CanonicalStats, Issue } from "./canonical.js";
import { canonicalStats } from "./canonical.js";
import type { MapResult, ImportScope } from "./map.js";
import type { Detection } from "./detect.js";

/**
 * THE MIGRATION REPORT (§16, §17, §38, §39) — what was imported, what was
 * converted with modifications, what needs review, and every risk, each with
 * where it is, what it is, how serious, why, what to do, and whether an
 * automatic conversion was attempted. Built from the canonical survey (what
 * the source said) and the map result (what Rescript now has), so the two
 * columns of "detected → created" are both facts, not estimates.
 */
export interface MigrationReport {
  source: { platform: string; format: string; fileName: string; title?: string; label: string; reasons: string[] };
  scope: ImportScope;
  detected: CanonicalStats;
  created: CanonicalStats | null;
  /** converted, but not one-to-one */
  converted: Issue[];
  /** a person must look at these before fielding */
  review: Issue[];
  risks: { high: Issue[]; medium: Issue[]; low: Issue[]; info: Issue[] };
  confidence: Record<string, number>;
  validation: { errors: number; warnings: number; deployable: boolean } | null;
  merge?: MapResult["merge"];
  /** the sentences Intelligent mode says when it is done (§39) */
  summary: string[];
  /** the audit lines (§38) */
  audit: string[];
  ok: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function buildReport(detection: Detection, c: CanonicalSurvey, m: MapResult, scope: ImportScope): MigrationReport {
  const detected = canonicalStats(c);
  const risks = { high: [] as Issue[], medium: [] as Issue[], low: [] as Issue[], info: [] as Issue[] };
  for (const i of m.issues) risks[i.severity].push(i);
  const converted = m.issues.filter((i) => i.type === "converted" || i.type === "inferred" && i.severity !== "info");
  const review = m.issues.filter((i) => i.severity === "high" || (i.severity === "medium" && i.type !== "converted"));
  const confidence: Record<string, number> = {};
  for (const q of m.confidence) confidence[q.level] = (confidence[q.level] ?? 0) + 1;
  const cr = m.created;
  const lines = (s: CanonicalStats | null): string[] => !s ? [] : [
    plural(s.questions, "question"), plural(s.blocks, "block"), s.pageBreaks ? plural(s.pageBreaks, "page break") : "",
    s.embeddedFields ? plural(s.embeddedFields, "embedded variable") : "", s.hiddenVariables ? plural(s.hiddenVariables, "hidden variable") : "",
    s.displayLogic ? plural(s.displayLogic, "display logic rule") : "", s.skipLogic ? plural(s.skipLogic, "skip rule") : "",
    s.branches ? plural(s.branches, "branch", "branches") : "", s.randomizers ? plural(s.randomizers, "randomizer") : "", s.loops ? plural(s.loops, "loop") : "",
    s.quotas ? plural(s.quotas, "quota") : "", s.validations ? plural(s.validations, "validation rule") : "",
  ].filter(Boolean);
  const renamed = m.issues.filter((i) => i.type === "renamed").length;
  const customLeft = m.issues.filter((i) => i.type === "custom_logic").length;
  const ambiguous = m.issues.filter((i) => i.type === "ambiguous").length;
  const summary: string[] = [];
  if (m.def) {
    summary.push(`I ${m.merge ? "merged" : "imported"} your ${detection.label} into Rescript${c.source.title ? ` — “${c.source.title}”` : ""}.`);
    summary.push(`Created ${lines(cr).join(", ")}.`);
    if (m.merge) summary.push(`${plural(m.merge.added.length, "imported item")} added; ${m.merge.unchanged.length} already here unchanged (not duplicated); ${plural(m.merge.changed.length, "question")} changed, added as renamed copies for review.`);
    if (customLeft) summary.push(`${plural(customLeft, "custom logic item")} need${customLeft === 1 ? "s" : ""} review — none were guessed.`);
    if (ambiguous) summary.push(`${plural(ambiguous, "instruction")} could not be read with certainty and ${ambiguous === 1 ? "was" : "were"} left for you to decide.`);
    if (renamed) summary.push(`${plural(renamed, "identifier")} had to change; the source → Rescript map keeps the originals.`);
    if (m.quality) summary.push(m.quality.deployable ? "The survey passes the quality check." : `The quality check found ${plural(m.quality.errors.length, "error")} to fix before fielding.`);
  } else summary.push("The import could not produce a valid survey; nothing was created. The issues below say why.");
  const audit = [
    `Detected ${detection.label} (${detection.reasons.join("; ")})`,
    `Read ${lines(detected).join(", ") || "nothing"}`,
    ...(m.def ? [`Created ${lines(cr).join(", ")}`] : []),
    ...(renamed ? [`Renamed ${plural(renamed, "identifier")}`] : []),
    ...(customLeft ? [`Flagged ${plural(customLeft, "custom logic item")}`] : []),
    `Validation ${m.quality ? `completed: ${m.quality.errors.length} errors, ${m.quality.warnings.length} warnings` : "not run"}`,
  ];
  return {
    source: { platform: c.source.platform, format: c.source.format, fileName: c.source.fileName, title: c.source.title, label: detection.label, reasons: detection.reasons },
    scope, detected, created: m.def ? cr : null, converted, review, risks, confidence,
    validation: m.quality ? { errors: m.quality.errors.length, warnings: m.quality.warnings.length, deployable: m.quality.deployable } : null,
    merge: m.merge, summary, audit, ok: !!m.def,
  };
}

/**
 * THE WORKLOAD (§33–§34), before anything costly runs: how big the source
 * is and how much of it would need a model. Structured sources are parsed
 * deterministically — no AI at all; documents too, unless the user asks for
 * deep analysis of what the reader could not decide.
 */
export interface Workload {
  questions: number;
  logicRules: number;
  customLogic: number;
  ambiguous: number;
  pages?: number;
  /** model calls a Deep Custom Logic Analysis would make — one per custom-logic item, capped */
  aiRequests: number;
}
export function workload(c: CanonicalSurvey): Workload {
  const s = canonicalStats(c);
  const ambiguous = c.issues.filter((i) => i.type === "ambiguous").length;
  const customItems = c.questions.reduce((n, q) => n + q.custom.length, 0) + c.custom.length + c.issues.filter((i) => i.type === "custom_logic" && !i.location.includes("JavaScript")).length;
  return { questions: s.questions, logicRules: s.displayLogic + s.skipLogic + s.branches, customLogic: s.customLogic, ambiguous, aiRequests: Math.min(50, customItems + ambiguous) };
}
