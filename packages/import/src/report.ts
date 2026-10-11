import type { CanonicalSurvey, CanonicalStats, Issue, InventoryFeature, InventoryItem, CanonicalAsset } from "./canonical.js";
import { canonicalStats } from "./canonical.js";
import type { MapResult, ImportScope, UnresolvedReference } from "./map.js";
import type { Detection } from "./detect.js";

/* ------------------------------------------------------------ fidelity: measured, per feature */

/** one feature of the source and what became of its items — the counts are items, each decided by the adapter or the mapper */
export interface FeatureFidelity {
  feature: InventoryFeature;
  label: string;
  detected: number;
  imported: number;
  partial: number;
  unsupported: number;
  /** a few source ids for each outcome, so the detailed view can point at them */
  examples: { partial: string[]; unsupported: string[] };
  /** the distinct reasons given for partial / unsupported items */
  reasons: string[];
}

export interface ImportFidelity {
  features: FeatureFidelity[];
  totals: { detected: number; imported: number; partial: number; unsupported: number };
  /** imported ÷ detected, as a percentage of ITEMS — not a claim about the survey as a whole */
  importedPct: number | null;
  unresolved: UnresolvedReference[];
  assets: (CanonicalAsset & { risk: "ok" | "platform_hosted" | "no_url" })[];
  /** languages found beside the source language, and how many strings each carried */
  languages: { code: string; strings: number }[];
  /** the source's element kinds, read or not */
  elements: NonNullable<CanonicalSurvey["elements"]>;
}

export const FEATURE_LABELS: Record<InventoryFeature, string> = {
  question: "Questions", option: "Choices", row: "Rows", validation: "Validation rules", display_logic: "Display logic", option_logic: "Choice / row display logic",
  skip_logic: "Skip logic", branch: "Flow branches", randomizer: "Randomizers", block_randomizer: "Block randomizers", loop: "Loops (Loop & Merge)", embedded: "Embedded data fields",
  quota: "Quotas", quota_logic: "Quota conditions", carry_forward: "Carry-forward choices", randomization: "Choice randomization", piping: "Piped text", translation: "Translations",
  asset: "Images and files", custom_js: "Custom JavaScript", flow_element: "Other flow elements", survey_option: "Survey options", default_value: "Default answers",
};

export function fidelity(c: CanonicalSurvey, m: MapResult): ImportFidelity {
  const items: InventoryItem[] = [...m.inventory];
  /* assets and validation rules are items too: an asset is carried by reference (partial when it is hosted by the platform, unsupported when it is only a library id) */
  for (const a of c.assets ?? []) items.push({ feature: "asset", sourceId: a.location, status: a.hosting === "library_id" ? "unsupported" : a.hosting === "platform" ? "partial" : "imported", note: a.hosting === "library_id" ? "a library id with no URL in the file" : a.hosting === "platform" ? "hosted by Qualtrics — breaks when that account closes" : undefined });
  for (const q of c.questions) for (const v of q.validation) items.push({ feature: "validation", sourceId: `${q.sourceId} ${v.kind}`, status: "imported" });
  for (const i of c.issues) if (i.type === "validation" && /content validation|has no direct equivalent/.test(i.message) && i.location.endsWith("· validation")) items.push({ feature: "validation", sourceId: i.location, status: "unsupported", note: i.message });
  const by = new Map<InventoryFeature, InventoryItem[]>();
  for (const it of items) (by.get(it.feature) ?? by.set(it.feature, []).get(it.feature)!).push(it);
  const features: FeatureFidelity[] = [...by].map(([feature, xs]) => ({
    feature, label: FEATURE_LABELS[feature],
    detected: xs.length, imported: xs.filter((x) => x.status === "imported").length, partial: xs.filter((x) => x.status === "partial").length, unsupported: xs.filter((x) => x.status === "unsupported").length,
    examples: { partial: xs.filter((x) => x.status === "partial").slice(0, 5).map((x) => x.sourceId), unsupported: xs.filter((x) => x.status === "unsupported").slice(0, 5).map((x) => x.sourceId) },
    reasons: [...new Set(xs.filter((x) => x.status !== "imported" && x.note).map((x) => x.note as string))].slice(0, 6),
  })).sort((a, b) => Object.keys(FEATURE_LABELS).indexOf(a.feature) - Object.keys(FEATURE_LABELS).indexOf(b.feature));
  const totals = features.reduce((t, f) => ({ detected: t.detected + f.detected, imported: t.imported + f.imported, partial: t.partial + f.partial, unsupported: t.unsupported + f.unsupported }), { detected: 0, imported: 0, partial: 0, unsupported: 0 });
  const langCounts = new Map<string, number>();
  for (const q of c.questions) for (const [l, t] of Object.entries(q.translations ?? {})) langCounts.set(l, (langCounts.get(l) ?? 0) + Object.keys(t).length);
  return {
    features, totals, importedPct: totals.detected ? Math.round((totals.imported / totals.detected) * 1000) / 10 : null,
    unresolved: m.unresolved,
    assets: (c.assets ?? []).map((a) => ({ ...a, risk: a.hosting === "library_id" ? "no_url" : a.hosting === "platform" ? "platform_hosted" : "ok" })),
    languages: [...langCounts].map(([code, strings]) => ({ code, strings })).sort((a, b) => a.code.localeCompare(b.code)),
    elements: c.elements ?? [],
  };
}

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
  /** measured per-feature fidelity — see ImportFidelity */
  fidelity: ImportFidelity;
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
  const fid = fidelity(c, m);
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
    /* the measured line: items, not a feeling */
    const f = fid.totals;
    if (f.detected) summary.push(`Of ${plural(f.detected, "source element")} checked, ${f.imported} came across as they were${f.partial ? `, ${f.partial} with a change` : ""}${f.unsupported ? `, ${f.unsupported} could not be reproduced` : ""} (${fid.importedPct}% as-is).`);
    if (fid.unresolved.length) summary.push(`${plural(fid.unresolved.length, "reference")} point${fid.unresolved.length === 1 ? "s" : ""} at something that is not in the imported survey.`);
    if (fid.assets.some((a) => a.risk !== "ok")) summary.push(`${plural(fid.assets.filter((a) => a.risk !== "ok").length, "image")} ${fid.assets.filter((a) => a.risk !== "ok").length === 1 ? "is" : "are"} still hosted by Qualtrics or named only by a library id — re-upload them here.`);
    if (fid.languages.length) summary.push(`Translations in ${fid.languages.map((l) => l.code).join(", ")} were imported for review.`);
  } else summary.push("The import could not produce a valid survey; nothing was created. The issues below say why.");
  const audit = [
    `Detected ${detection.label} (${detection.reasons.join("; ")})`,
    `Read ${lines(detected).join(", ") || "nothing"}`,
    ...(m.def ? [`Created ${lines(cr).join(", ")}`] : []),
    ...(renamed ? [`Renamed ${plural(renamed, "identifier")}`] : []),
    ...(customLeft ? [`Flagged ${plural(customLeft, "custom logic item")}`] : []),
    `Validation ${m.quality ? `completed: ${m.quality.errors.length} errors, ${m.quality.warnings.length} warnings` : "not run"}`,
    `Fidelity ${fid.totals.detected ? `${fid.totals.imported}/${fid.totals.detected} elements as-is, ${fid.totals.partial} partial, ${fid.totals.unsupported} unsupported` : "no elements counted"}`,
  ];
  return {
    source: { platform: c.source.platform, format: c.source.format, fileName: c.source.fileName, title: c.source.title, label: detection.label, reasons: detection.reasons },
    scope, detected, created: m.def ? cr : null, converted, review, risks, confidence,
    validation: m.quality ? { errors: m.quality.errors.length, warnings: m.quality.warnings.length, deployable: m.quality.deployable } : null,
    merge: m.merge, summary, audit, ok: !!m.def, fidelity: fid,
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
