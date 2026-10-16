import {
  Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, LevelFormat, convertInchesToTwip, HeadingLevel,
} from "docx";
import type { SurveyDefinition } from "@rescript/schema";
import { RULES, enabledRuleIds, resolveConfig, strictnessLabel } from "@rescript/quality";
import { plainText } from "./exportConfig.js";
import { definitionHash, stampLine } from "./stamp.js";

/**
 * THE DATA-CLEANING PLAN (DOC-04).
 *
 * A client who commissions fieldwork asks, before it starts, how bad
 * responses will be found and what happens to them. This is that document,
 * and it is WRITTEN FROM THE SURVEY'S OWN SETTINGS — `resolveConfig(def)`
 * read against the rule catalogue — so it cannot say a threshold the engine
 * does not use. Change a threshold, regenerate, and the plan changes with it.
 * Nothing in it is typed by hand per survey; the same definition always
 * produces the same text (the stamp's time is the only thing that moves).
 */

const INK = "16202E";
const SUBTLE = "5F6B7D";
const RULE_COLOUR = "D5DBE4";
const HEAD_FILL = "EEF1F6";

type Level = "relaxed" | "standard" | "strict" | "very_strict";

const para = (text: string, o: { bold?: boolean; italics?: boolean; colour?: string; size?: number; after?: number } = {}) =>
  new Paragraph({
    children: [new TextRun({ text, bold: o.bold, italics: o.italics, color: o.colour ?? INK, size: o.size ?? 21 })],
    spacing: { after: o.after ?? 80 },
  });

const heading = (text: string) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text, bold: true, size: 26, color: INK })],
    spacing: { before: 240, after: 100 },
  });

const bullet = (text: string) =>
  new Paragraph({
    numbering: { reference: "cp-bullets", level: 0 },
    children: [new TextRun({ text, color: INK, size: 21 })],
    spacing: { after: 40 },
  });

const BORDER = { style: BorderStyle.SINGLE, size: 4, color: RULE_COLOUR };
const cellOf = (text: string, width: number, head = false) =>
  new TableCell({
    width: { size: width, type: WidthType.PERCENTAGE },
    shading: head ? { type: ShadingType.CLEAR, fill: HEAD_FILL, color: "auto" } : undefined,
    borders: { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER },
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [new Paragraph({ children: [new TextRun({ text, bold: head, size: 18, color: INK })] })],
  });

function table(header: string[], rows: string[][], widths: number[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: header.map((h, i) => cellOf(h, widths[i], true)) }),
      ...rows.map((r) => new TableRow({ children: r.map((c, i) => cellOf(c, widths[i])) })),
    ],
  });
}

/** One rule as the plan states it. Exported so a test (and the Studio) can read the same rows. */
export interface CleaningPlanRule {
  id: string;
  title: string;
  category: string;
  running: boolean;
  role: "classifying" | "informational";
  severity: string;
  riskPoints: number;
  /** "Reaction faster than 800 ms; share of questions 40%" — the thresholds actually in force */
  thresholds: string;
  /** what happens when it fires */
  action: string;
  restrictedTo: number | null;
  overridden: boolean;
}

const levelOf = (s: string): Level => (s === "custom" ? "standard" : (s as Level));

const fmtParam = (v: unknown, unit?: string): string => {
  if (typeof v === "boolean") return v ? "yes" : "no";
  const n = typeof v === "number" ? (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)) : String(v);
  return unit ? `${n} ${unit}` : n;
};

/** Every catalogue rule, resolved against this survey's settings. Deterministic. */
export function cleaningPlanRules(def: SurveyDefinition): CleaningPlanRule[] {
  const config = resolveConfig(def);
  const level = levelOf(config.strictness);
  const running = new Set(config.enabled ? enabledRuleIds(config) : []);
  return RULES.map((r) => {
    const setting = config.rules[r.id] ?? {};
    const role = setting.role ?? r.role ?? "classifying";
    const severity = setting.severity ?? r.defaultSeverity;
    const points = Math.round(r.riskPoints * (setting.weight ?? 1));
    const thresholds = r.params.length
      ? r.params.map((p) => `${p.label}: ${fmtParam(setting.params?.[p.key] ?? p.defaults[level], p.unit)}`).join("; ")
      : "no threshold — fires on the condition itself";
    const action = role === "informational"
      ? "Recorded as evidence on the response; costs quality points only. Never excludes a response on its own."
      : `Adds up to ${points} fraud-risk points. Counts toward the REVIEW / FLAGGED verdict.`;
    return {
      id: r.id, title: r.title, category: r.category, running: running.has(r.id), role, severity,
      riskPoints: points, thresholds, action,
      restrictedTo: setting.questionIds?.length ? setting.questionIds.length : null,
      overridden: Object.keys(setting).length > 0,
    };
  });
}

export async function buildCleaningPlanDocx(
  def: SurveyDefinition,
  meta: { generatedAt?: Date; revision?: number | string | null } = {},
): Promise<Buffer> {
  const config = resolveConfig(def);
  const rules = cleaningPlanRules(def);
  const on = rules.filter((r) => r.running);
  const off = rules.filter((r) => !r.running);
  const attention = def.questions.filter((q: any) => q.attentionCheck);
  const customRules = config.customRules.filter((r) => r.enabled);
  const title = plainText(def.meta.title) || def.meta.code;
  const stamp = stampLine({ verb: "generated", at: meta.generatedAt ?? new Date(), revision: meta.revision, hash: definitionHash(def) });
  const b = config.bands;
  const ev = config.evidence;
  const children: (Paragraph | Table)[] = [];

  children.push(new Paragraph({
    children: [new TextRun({ text: `Data-Cleaning Plan — ${title}`, bold: true, size: 40, color: INK })],
    spacing: { after: 60 },
  }));
  children.push(para(`${def.meta.code}${def.meta.version ? `  ·  version ${def.meta.version}` : ""}  ·  ${stamp}`, { colour: SUBTLE, italics: true, size: 19 }));

  children.push(heading("1. Purpose"));
  children.push(para("This plan states, before and during fieldwork, how responses to this survey are checked for quality, which checks run and at what thresholds, what the platform does when a check fires, and who decides what happens to a flagged response. It is generated from the survey's own quality settings, so the thresholds below are the ones the engine applies."));
  children.push(para("Every flag is a risk indicator that requires researcher judgement. None is proof, and no response is deleted by an automatic check."));

  children.push(heading("2. Dataset scope"));
  [
    "Assessed: every finished response — complete, screened, terminated or over quota. Responses still in progress are not assessed.",
    "Live and test responses are assessed separately and never compared with each other; a test interview is never a peer of a live one.",
    `Peers: each response is compared with up to ${config.maxPeers.toLocaleString("en")} other finished responses of the same survey and mode (the newest first) for benchmarks, duplicate and cluster checks.`,
    "Responses the researcher has deleted (moved to the recycle bin) are not assessed and are not used as peers.",
    "When: each response is assessed as it completes, and the whole survey can be re-assessed on demand after a settings change; a re-assessment covers every response, not a sample.",
    "The analysis dataset: the CLEAN dataset is every response the researcher kept plus every unreviewed response classified CLEAN (or not yet scored). Responses decided REMOVE are never in it. Custom datasets exclude the classifications the researcher names.",
  ].forEach((t) => children.push(bullet(t)));

  children.push(heading("3. Settings in force"));
  if (!config.enabled) {
    children.push(para("Quality checks are switched OFF for this survey. No rule below runs, every response is recorded as UNSCORED and every response is in the clean dataset until a researcher decides otherwise. The rules are listed so the plan states what would run if the checks were switched on.", { bold: true }));
  }
  children.push(table(["Setting", "Value"], [
    ["Quality checks", config.enabled ? "On" : "Off"],
    ["Strictness", `${strictnessLabel(config.strictness)}${config.profile ? ` (profile “${config.profile}”)` : ""}`],
    ["Rules running", `${on.length} of ${rules.length}${rules.some((r) => r.overridden) ? `; ${rules.filter((r) => r.overridden).length} with survey-specific overrides` : ""}`],
    ["Classification bands (fraud risk 0–100)", `REVIEW from ${b.review}; SUSPICIOUS from ${b.suspicious}; HIGHLY SUSPICIOUS from ${b.highlySuspicious}; CRITICAL from ${b.critical}`],
    ["How signals combine", ev.combination === "correlated" ? "Signals within one category count as one fact (strongest in full, the rest in part); categories combine as independent evidence" : "Every signal counted in full"],
    ["What it takes to be FLAGGED", ev.flagged === "bands_only" ? "The risk band alone" : `The risk band AND one strong, confident signal, or moderate signals in at least ${ev.flaggedMinCategories} different categories`],
    ["Timing benchmark", `Median of finished responses once ${ev.minPeers} exist; before that a reading-time estimate, with flags against it carried at ${Math.round(ev.estimateConfidence * 100)}% confidence`],
    ["Telemetry recorded", (["timing", "focus", "clipboard", "navigation", "interaction", "device", "network"] as const).filter((k) => config.telemetry[k]).join(", ") || "none"],
    ["Telemetry switched off", (["timing", "focus", "clipboard", "navigation", "interaction", "device", "network"] as const).filter((k) => !config.telemetry[k]).join(", ") || "none"],
    ["Raw telemetry retention", config.privacy.telemetryRetentionDays ? `${config.privacy.telemetryRetentionDays} days after completion (scores kept)` : "kept with the response"],
    ["IP addresses", "Stored only as a salted hash, never raw"],
    ["Cross-study history", config.privacy.longitudinal ? "On — a respondent's quality history in other studies is considered" : "Off"],
  ], [32, 68]));

  children.push(heading("4. Rules, thresholds and actions"));
  children.push(para("The table lists every rule that runs, with the threshold currently in force and what happens when it fires. “Classifying” rules can move a response toward REVIEW or FLAGGED; “informational” rules are recorded as evidence only.", { after: 100 }));
  children.push(table(
    ["Rule", "Category", "Threshold in force", "Severity", "Action when it fires"],
    on.map((r) => [
      `${r.title}${r.restrictedTo ? ` (limited to ${r.restrictedTo} question${r.restrictedTo === 1 ? "" : "s"})` : ""}\n${r.id}`,
      r.category.replace("_", " "), r.thresholds, r.severity, r.action,
    ]),
    [24, 11, 30, 9, 26],
  ));
  if (!on.length) children.push(para("No rule runs under the current settings.", { italics: true, colour: SUBTLE }));
  if (off.length && config.enabled) {
    children.push(para(`Not running under these settings (${off.length}): ${off.map((r) => r.title).join("; ")}.`, { colour: SUBTLE, size: 19 }));
  }
  if (attention.length) {
    children.push(para("Attention checks in this questionnaire", { bold: true, after: 40 }));
    attention.forEach((q: any) => children.push(bullet(`${q.code}: ${plainText(q.text).slice(0, 120)} — passes with ${(q.attentionCheck.expected ?? []).join(", ") || "the configured answer"} (${q.attentionCheck.kind})`)));
  }
  if (customRules.length) {
    children.push(para("Researcher-defined rules", { bold: true, after: 40 }));
    customRules.forEach((r) => children.push(bullet(`${r.name} — ${r.severity}, ${r.riskPoints} risk points${r.minClass ? `, forces at least ${r.minClass}` : ""}`)));
  }

  children.push(heading("5. Duplicates and arrival order"));
  children.push(para("When two responses match each other — near-identical answers, an identical open end, an identical grid, the same timing profile — the LATER arrival is treated as the copy and carries the classifying flag. The EARLIER response keeps the match on its record as information but is not excluded by it, so one response of a duplicate pair stays in the clean dataset. If a group of responses forms a coordinated cluster, the whole group is flagged. A researcher can review any pair and change either decision."));

  children.push(heading("6. Verdicts and what follows"));
  children.push(table(["Verdict", "Meaning", "Default handling"], [
    ["PASS (CLEAN)", "No signal that calls the response into question.", "In the clean dataset."],
    ["REVIEW", `Risk of ${b.review} or more, or one strong signal that is not conclusive on its own.`, "Held out of the clean dataset until a researcher decides; listed in the review queue with the evidence."],
    ["FLAGGED (SUSPICIOUS and above)", "Strong evidence, or independent signals in several categories.", "Held out of the clean dataset; the researcher confirms with REMOVE or overrides with KEEP."],
  ], [22, 40, 38]));

  children.push(heading("7. Review workflow"));
  [
    "Responses classified REVIEW or above appear in the Quality review queue with every flag, the measured value, the expected value and a plain-language explanation.",
    "The researcher records one decision per response: KEEP (include), REMOVE (exclude), REVIEW LATER (defer) or CLEAR (withdraw the decision and return to the automatic classification).",
    "Every decision is recorded with who made it, when, and the reason given, together with a snapshot of the assessment the researcher saw. The history is append-only.",
    "After a settings change the survey is re-assessed in full; decisions already made by a researcher are kept and are not overwritten by the new automatic classification.",
  ].forEach((t) => children.push(bullet(t)));

  children.push(heading("8. Override policy"));
  [
    "An automatic classification is a recommendation. A researcher may override it either way with KEEP or REMOVE; a reason is recorded with the decision.",
    "Thresholds, severities, roles and weights can be changed per survey before or during fieldwork. Every assessment records a fingerprint of the settings it ran under, so a response assessed under older settings is identifiable.",
    "Changing a threshold after fieldwork has begun requires a re-assessment of all responses so the whole dataset is judged by one standard.",
  ].forEach((t) => children.push(bullet(t)));

  children.push(heading("9. Raw-data preservation"));
  children.push(para("No automatic check deletes or alters a response. Answers, timing and device records are stored exactly as collected; the assessment is stored beside them. REMOVE excludes a response from the clean dataset but keeps the row; a response the researcher deletes goes to a recycle bin and can be restored, and only an already-deleted response can be permanently purged, with an audit record. Every export can be produced for all responses (with each marked ACTIVE, KEPT, REMOVED or REVIEW LATER, and TEST or LIVE) or for the clean dataset only."));

  children.push(heading("10. Document stamp"));
  children.push(para(stamp, { colour: SUBTLE, italics: true, size: 19 }));
  children.push(para("Two plans carrying the same definition hash were written from the same survey definition and therefore state the same rules and thresholds.", { colour: SUBTLE, italics: true, size: 19 }));

  const doc = new Document({
    creator: "Rescript",
    title: `Data-Cleaning Plan — ${title}`,
    description: "Data-cleaning plan generated from the survey's quality settings",
    numbering: {
      config: [{
        reference: "cp-bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(0.3), hanging: convertInchesToTwip(0.2) } } } }],
      }],
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}
