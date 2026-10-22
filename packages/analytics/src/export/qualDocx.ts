import type { SurveyDefinition, QualStudy } from "@rescript/schema";
import { guideMinutes, lintQualStudy } from "@rescript/engine";
import { docKit, definitionStamp, type DocBlock } from "./docx.js";
import { unzipEntries } from "./docxCheck.js";
import type { QualHistoryEntry, QualSegment, QualState, QualExcerpt } from "../qual/types.js";
import { themeFrequency, themeSummaries, FREQUENCY_NOTE } from "../qual/analysis.js";
import { reviewStatus } from "../qual/codebook.js";
import { formatTimestamp } from "../qual/transcripts.js";
import type { AgreementReport } from "../qual/kappa.js";
import type { ThemeSynthesis } from "../qual/synthesis.js";
import type { StudyInsights, GroupComparison } from "../qual/insights.js";
import { OBJECTIVE_WORDS, VERDICT_WORDS } from "../qual/insights.js";
import type { AssignmentAgreement } from "../qual/doubleCoding.js";
import type { SynthClaim } from "../qual/evidence.js";
import { COVERAGE_NOTE } from "../qual/evidence.js";

/**
 * THE QUALITATIVE EDITIONS OF THE WORD EXPORTER (2026-10-18) — two documents
 * built from the same kit as the proposal and the statistical analysis plan
 * (`docKit`: the frame, the headings Word's navigation reads, the tables whose
 * header repeats on every page), so every Rescript document looks and checks
 * the same (`checkDocx` at the route):
 *
 *   • the INTERVIEW / DISCUSSION GUIDE, from `def.qualStudy` alone: objectives,
 *     protocol, session plan and segments, screening, consent and recording
 *     disclosure, ground rules, then the guide section by section — timing,
 *     purpose, what the moderator says, instructions, questions with probes
 *     and conditional probes, exercises and stimuli — and the notes the lint
 *     raises before fieldwork;
 *   • the QUALITATIVE REPORT, from the coded data: objectives, the coding
 *     methodology (sources, inductive / deductive, the AI's part and how much
 *     a person reviewed, inter-coder agreement), the codebook, each theme with
 *     its evidence-based summary (every claim cites excerpt ids), supporting
 *     excerpts (exact quotes with source, speaker and time), contradictory
 *     evidence, group differences (with the note that frequency is not
 *     importance), the researcher's interpretation (never written by the
 *     engine), limitations and the review status with its history.
 *
 * `redact` lets the route print the report for a reader without the contact-
 * details permission: every quote passes through it.
 */

const { h1, h2, label, body, lead, muted, bullet, numbered, divider, gridTable, cover, document, plain } = docKit;

export interface QualGuideDocxOptions { client?: string; author?: string; date?: string }

const KIND_WORDS: Record<string, string> = { opening: "Opening", warm_up: "Warm-up", main: "Topic", exercise: "Exercise", concept: "Concept evaluation", closing: "Closing" };
const MODE_WORDS: Record<string, string> = { in_person: "in person", remote: "remote (video call)", phone: "by phone", mixed: "mixed" };

/** The interview guide or focus-group discussion guide, as a Word document. */
export function buildQualGuideDocx(def: SurveyDefinition, opts: QualGuideDocxOptions = {}): Promise<Buffer> {
  const s = def.qualStudy;
  if (!s) throw new Error("this survey has no interview or focus-group guide yet");
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const kind = s.kind === "focus_group" ? "Focus-group discussion guide" : "Interview guide";
  const title = s.title ?? def.meta.title;
  const out: DocBlock[] = [];
  const planned = guideMinutes(s);
  out.push(...cover(kind, title, [opts.client ? `Prepared for ${opts.client}` : "", `${date}${opts.author ? ` · ${opts.author}` : ""}`, `${s.sections.length} sections${planned ? ` · ${planned} minutes timed` : ""}${s.durationMinutes ? ` · session ${s.durationMinutes} minutes` : ""}`, `Project: ${def.meta.title}${def.meta.code ? ` (${def.meta.code})` : ""}`]));
  let sec = 0;
  const H1 = (t: string) => h1(`${++sec}. ${t}`);

  out.push(H1("Objectives and protocol"));
  if (s.objectives.length) for (const o of s.objectives) out.push(numbered(o)); else out.push(muted("No objectives are recorded."));
  if (s.protocol) out.push(label("Protocol"), body(s.protocol));
  const sp = s.sessionPlan;
  const planBits = [sp.sessions ? `${sp.sessions} ${s.kind === "focus_group" ? "group" : "interview"}${sp.sessions === 1 ? "" : "s"}` : "", sp.participantsPerSession ? `${sp.participantsPerSession} participant${sp.participantsPerSession === 1 ? "" : "s"} each` : "", sp.mode ? MODE_WORDS[sp.mode] ?? sp.mode : "", s.durationMinutes ? `${s.durationMinutes} minutes` : ""].filter(Boolean);
  if (planBits.length || sp.notes) out.push(label("Session plan"), body(`${planBits.join(", ")}${planBits.length ? "." : ""}${sp.notes ? ` ${sp.notes}` : ""}`.trim()));
  if (s.segments.length) { out.push(label("Participant segments")); out.push(gridTable(["Segment", "Who", "Planned"], s.segments.map((g) => [g.name, g.description ?? "", g.target != null ? String(g.target) : "—"]), [2600, 5000, 1400])); }

  out.push(H1("Recruitment and screening"));
  if (!s.screening.length) out.push(muted("No screening criteria are recorded."));
  else out.push(gridTable(["Criterion", "Rule", "Quota"], s.screening.map((c) => [c.criterion, c.rule === "exclude" ? "Exclude" : "Include", c.quota ?? ""]), [5600, 1400, 2000]));

  out.push(H1("Consent and recording"));
  if (s.consent.statement) out.push(label("Consent statement"), body(s.consent.statement)); else out.push(muted("No consent statement is recorded — read the standard statement and obtain consent before the session starts."));
  if (s.consent.recordingDisclosure) out.push(label("Recording disclosure"), body(s.consent.recordingDisclosure)); else out.push(muted("No recording disclosure is recorded: say what is recorded, who will see it and how long it is kept."));
  if (s.consent.dataUse) out.push(label("How the data are used"), body(s.consent.dataUse));
  if (s.groundRules.length) { out.push(label("Ground rules")); for (const g of s.groundRules) out.push(bullet(g)); }

  out.push(H1("The guide"));
  out.push(gridTable(["", "Section", "Type", "Minutes", "Questions"], s.sections.map((x, i) => [String(i + 1), x.title, KIND_WORDS[x.kind] ?? x.kind, x.minutes != null ? String(x.minutes) : "—", String(x.questions.length)]), [500, 4000, 1900, 1200, 1400]));
  s.sections.forEach((x, i) => {
    out.push(h2(`${sec}.${i + 1} ${x.title}${x.minutes != null ? ` (${x.minutes} min)` : ""}`));
    if (x.purpose) out.push(muted(`Purpose: ${x.purpose}`));
    if (x.script) out.push(label("Moderator says"), body(`“${x.script}”`));
    if (x.instructions.length) { out.push(label("Moderator instructions")); for (const t of x.instructions) out.push(bullet(t)); }
    if (x.stimuli.length) { out.push(label("Stimuli")); for (const t of x.stimuli) out.push(bullet(t)); }
    if (x.exercise) { out.push(label(`Exercise: ${x.exercise.title}`)); if (x.exercise.instructions) out.push(body(x.exercise.instructions)); if (x.exercise.materials.length) out.push(muted(`Materials: ${x.exercise.materials.join("; ")}`)); }
    x.questions.forEach((q, k) => {
      out.push(body(`Q${i + 1}.${k + 1}  ${q.text}${q.minutes != null ? `  (${q.minutes} min)` : ""}`));
      for (const p of q.probes) out.push(bullet(`Probe: ${p}`));
      for (const c of q.conditionalProbes) out.push(bullet(`If the participant mentions ${c.ifMentions} → ask: ${c.ask}`));
      if (q.moderatorNote) out.push(muted(`Note: ${q.moderatorNote}`));
    });
  });
  const notes = lintQualStudy(s);
  if (notes.length) { out.push(H1("Notes before fieldwork")); for (const n of notes) out.push(bullet(n)); }
  out.push(divider());
  out.push(muted(`This guide is for a human moderator; Rescript records sessions, recordings and transcripts but does not run live sessions. ${definitionStamp(def).text} · generated ${date}`));
  return document(`${title} — ${kind.toLowerCase()}`, `${kind} for ${def.meta.title}`, out, { header: `${def.meta.title} — ${kind}`, footer: `${opts.client ? `Prepared for ${opts.client} · ` : ""}${date}` });
}

/* ------------------------------------------------------------ the qualitative report */

export interface QualSourceInfo { id: string; title: string; kind: "transcript" | "open_ends"; date?: string; speakers?: number; segments?: number }
export interface QualReportOptions {
  state: QualState;
  segments: QualSegment[];
  sources: QualSourceInfo[];
  history?: QualHistoryEntry[];
  agreement?: AgreementReport | null;
  /** the researcher's own interpretation, printed as theirs; the engine never writes one */
  interpretation?: string;
  /** printed for a reader without the contact-details permission: every quote passes through it */
  redact?: (text: string) => string;
  /** how coder ids read in the report ("ai" → "AI (suggested)") */
  coderName?: (id: string) => string;
  client?: string; author?: string; date?: string;
  /* F2 2026-10-22: AI synthesis in the report — each optional, each labelled as the model's writing */
  /** the stored AI theme summaries, with whether each is still about the coding as it is ("stale" is printed) */
  syntheses?: (ThemeSynthesis & { state?: "current" | "stale" })[];
  /** the study-level insights: key findings per objective, hypotheses, surprises, recommendations (interpretation) */
  insights?: (StudyInsights & { state?: "current" | "stale" }) | null;
  /** two participant groups side by side, by code */
  comparison?: GroupComparison | null;
  /** a blind double-coding assignment's agreement (κ and α per code) */
  doubleCoding?: (AssignmentAgreement & { name?: string }) | null;
}

const statusWord = (s: string) => (s === "human_reviewed" ? "reviewed" : s === "ai_suggested" ? "AI-suggested" : "rejected");

/** The qualitative report, as a Word document. */
export function buildQualReportDocx(def: SurveyDefinition, o: QualReportOptions): Promise<Buffer> {
  const date = o.date ?? new Date().toISOString().slice(0, 10);
  const red = o.redact ?? ((t: string) => t);
  const st = o.state, cb = st.codebook;
  const s: QualStudy | undefined = def.qualStudy;
  const title = s?.title ?? def.research?.objective ?? def.meta.title;
  const out: DocBlock[] = [];
  const rs = reviewStatus(st);
  const srcTitle = new Map(o.sources.map((x) => [x.id, x.title]));
  const where = (e: QualExcerpt) => [srcTitle.get(e.sourceId) ?? e.sourceId, e.speaker, e.start != null ? formatTimestamp(e.start) : ""].filter(Boolean).join(" · ");
  const quoteLine = (e: QualExcerpt) => bullet(`“${red(e.quote)}” — ${where(e)} [${e.id}${e.status === "ai_suggested" ? ", AI-suggested" : ""}]`);
  out.push(...cover("Qualitative report", plain(title, 90), [o.client ? `Prepared for ${o.client}` : "", `${date}${o.author ? ` · ${o.author}` : ""}`, `${o.sources.length} source${o.sources.length === 1 ? "" : "s"} · ${cb.codes.filter((c) => c.status !== "rejected").length} codes · ${cb.themes.filter((t) => t.status !== "rejected").length} themes`, `Project: ${def.meta.title}`]));
  let sec = 0;
  const H1 = (t: string) => h1(`${++sec}. ${t}`);

  out.push(H1("Objectives"));
  const objectives = s?.objectives.length ? s.objectives : [def.research?.objective, ...(def.research?.researchQuestions ?? [])].filter((x): x is string => !!x);
  if (objectives.length) for (const x of objectives) out.push(numbered(x)); else out.push(muted("No objectives are recorded in the guide or the research design."));

  const byId = new Map(st.excerpts.map((e) => [e.id, e]));
  const claimLine = (c: SynthClaim, prefix = "") => bullet(`${prefix}${red(c.text)} [${c.excerptIds.join(", ")}]${c.origin === "edited" ? " (edited by the researcher)" : c.origin === "human" ? " (written by the researcher)" : ""}${c.interpretation ? " — interpretation" : ""}${c.support ? ` · ${c.support.sources} source${c.support.sources === 1 ? "" : "s"}` : ""}`);
  const quotesOf = (c: SynthClaim, n = 2) => c.excerptIds.map((id) => byId.get(id)).filter((e): e is QualExcerpt => !!e).slice(0, n).map((e) => quoteLine(e));
  const ins = o.insights;
  if (ins) {
    out.push(H1("Key findings"));
    out.push(muted(`Written by AI from the coded excerpts each sentence cites${ins.status === "edited" ? ", then edited by the researcher" : ""}; generated ${ins.generatedAt.slice(0, 10)}. ${ins.state === "stale" ? "THE CODING HAS CHANGED SINCE: regenerate before relying on these findings. " : ""}Counts are the Studio's; recommendations are interpretation.`));
    if (ins.executiveSummary.length) { out.push(label("Executive summary")); for (const c of ins.executiveSummary) out.push(claimLine(c)); }
    for (const ob of ins.objectives) {
      out.push(h2(`${ob.ref}. ${plain(ob.objective, 120)} — ${OBJECTIVE_WORDS[ob.status]}`));
      if (ob.note) out.push(muted(ob.note));
      if (!ob.findings.length) out.push(muted("Not enough evidence in the coded data to answer this objective."));
      for (const c of ob.findings) { out.push(claimLine(c)); out.push(...quotesOf(c)); }
    }
    if (ins.hypotheses.length) { out.push(label("Hypotheses")); for (const h of ins.hypotheses) { out.push(body(`${h.ref}: ${h.hypothesis} — ${VERDICT_WORDS[h.verdict]}${h.note ? ` (${h.note})` : ""}`)); for (const c of h.claims) out.push(claimLine(c)); } }
    if (ins.surprises.length) { out.push(label("Surprises")); for (const c of ins.surprises) out.push(claimLine(c)); }
    if (ins.framing.kind !== "none") { out.push(label(ins.framing.kind === "journey" ? "The journey" : "Decision drivers")); for (const s of ins.framing.stages) { out.push(body(s.name)); for (const c of s.claims) out.push(claimLine(c)); } }
    if (ins.segments.length) { out.push(label("Segment differences")); for (const c of ins.segments) out.push(claimLine(c, `${c.groups.join(" vs ")}: `)); }
    if (ins.recommendations.length) { out.push(label("Recommendations (interpretation, not findings)")); for (const c of ins.recommendations) out.push(claimLine(c)); }
  }

  out.push(H1("Method and coding"));
  const participantSegs = o.segments.filter((x) => x.role !== "moderator");
  out.push(body(`${o.sources.length} source${o.sources.length === 1 ? "" : "s"} (${o.sources.filter((x) => x.kind === "transcript").length} transcript${o.sources.filter((x) => x.kind === "transcript").length === 1 ? "" : "s"}, ${o.sources.filter((x) => x.kind === "open_ends").length} set${o.sources.filter((x) => x.kind === "open_ends").length === 1 ? "" : "s"} of open-ended answers): ${o.segments.length} segments, ${participantSegs.length} of them participants' (moderator turns are context and are not counted as evidence).`));
  if (o.sources.length) out.push(gridTable(["Source", "Type", "Date", "Segments"], o.sources.map((x) => [x.title, x.kind === "transcript" ? "Transcript" : "Open-ended answers", x.date ?? "", x.segments != null ? String(x.segments) : ""]), [4200, 2000, 1400, 1400]));
  out.push(label("Coding"));
  out.push(body(`${cb.method === "deductive" ? `Deductive: the codes come from a framework${cb.framework ? ` (“${plain(cb.framework, 160)}”)` : ""} and were applied to the data.` : "Inductive: the codes were developed from the data."} The AI proposed codes, themes and excerpts in batches; every quote it returned was checked to be an exact span of its source and rejected otherwise. Personal details (e-mail addresses, phone numbers, the names list) were replaced before any text was sent to the model.`));
  out.push(body(`Review status: ${rs.codes.human_reviewed} of ${rs.codes.human_reviewed + rs.codes.ai_suggested} codes and ${rs.excerpts.human_reviewed} of ${rs.excerpts.human_reviewed + rs.excerpts.ai_suggested} excerpts reviewed by a person; ${rs.codes.rejected} codes and ${rs.excerpts.rejected} excerpts rejected.`));
  if (o.agreement && o.agreement.codes.length) {
    const nm = o.coderName ?? ((x: string) => x);
    out.push(label("Inter-coder agreement"));
    out.push(body(`${nm(o.agreement.coderA)} and ${nm(o.agreement.coderB)} on ${o.agreement.units.length} segments: ${o.agreement.meanKappa != null ? `mean Cohen's κ ${o.agreement.meanKappa.toFixed(2)}` : "no code had a defined kappa"}. ${o.agreement.note}`));
    out.push(gridTable(["Code", "κ", "Reading", "Both", "Only A", "Only B", "Neither"], o.agreement.codes.map((c) => [c.codeName, c.kappa == null ? "—" : c.kappa.toFixed(2), c.words, String(c.both), String(c.onlyA), String(c.onlyB), String(c.neither)]), [2600, 800, 1800, 900, 1000, 1000, 900]));
  }

  if (o.doubleCoding && o.doubleCoding.codes.length) {
    const d = o.doubleCoding, nm = o.coderName ?? ((x: string) => x);
    out.push(label("Blind double-coding"));
    out.push(body(`${d.name ? `“${d.name}”: ` : ""}${nm(d.coderA)} and ${nm(d.coderB)} coded ${d.units} segments without seeing each other's coding. Pooled κ ${d.pooled.kappa == null ? "—" : d.pooled.kappa.toFixed(2)}, pooled α ${d.pooled.alpha == null ? "—" : d.pooled.alpha.toFixed(2)}; mean κ ${d.meanKappa == null ? "—" : d.meanKappa.toFixed(2)}. ${d.note}`));
    out.push(gridTable(["Code", "κ", "α", "Both", "Only A", "Only B", "Neither"], d.codes.map((c) => [c.codeName, c.kappa == null ? "—" : c.kappa.toFixed(2), c.alpha == null ? "—" : c.alpha.toFixed(2), String(c.table.both), String(c.table.onlyA), String(c.table.onlyB), String(c.table.neither)]), [2600, 800, 800, 900, 1000, 1000, 900]));
  }
  if (o.syntheses?.length || ins) {
    out.push(label("AI synthesis"));
    out.push(body(`Theme summaries${ins ? " and key findings" : ""} were written by an AI model from the coded excerpts only: personal details were redacted before sending, each sentence had to cite the excerpts it rests on and was dropped otherwise, sentences stating numbers the excerpts do not contain were dropped, and every count, share and coverage figure was computed by the Studio. ${COVERAGE_NOTE}`));
  }

  out.push(H1("Codebook"));
  const themeName = new Map(cb.themes.map((t) => [t.id, t.name]));
  const codeName = new Map(cb.codes.map((c) => [c.id, c.name]));
  const live = cb.codes.filter((c) => c.status !== "rejected");
  if (!live.length) out.push(muted("No codes yet."));
  else out.push(gridTable(["Code", "Definition", "Include / exclude", "Theme", "Status"], live.map((c) => [c.parentId ? `${codeName.get(c.parentId) ?? ""} › ${c.name}` : c.name, c.definition, [c.include ? `Include: ${c.include}` : "", c.exclude ? `Exclude: ${c.exclude}` : ""].filter(Boolean).join(" "), c.themeId ? themeName.get(c.themeId) ?? "" : "—", statusWord(c.status)]), [1800, 2800, 2200, 1300, 900]));
  if (cb.relationships.length) { out.push(label("Relationships")); for (const r of cb.relationships) out.push(bullet(`${codeName.get(r.from) ?? r.from} ${r.kind.replace("_", " ")} ${codeName.get(r.to) ?? r.to}${r.note ? ` — ${r.note}` : ""}`)); }

  out.push(H1("Themes"));
  const sums = themeSummaries(st, o.segments);
  if (!sums.length) out.push(muted("No themes yet."));
  for (const t of sums) {
    const theme = cb.themes.find((x) => x.id === t.themeId);
    out.push(h2(`${theme?.parentId ? `${themeName.get(theme.parentId) ?? ""} › ` : ""}${t.name}`));
    if (theme?.description) out.push(muted(theme.description));
    out.push(muted(`Status: ${t.status}.`));
    for (const c of t.claims) out.push(bullet(`${c.text} [${c.excerptIds.join(", ")}]`));
    const sy = o.syntheses?.find((x) => x.themeId === t.themeId);
    if (sy) {
      out.push(label(`AI theme summary${sy.status === "edited" ? " (edited by the researcher)" : ""}`));
      out.push(muted(`${sy.coverage.words}${sy.state === "stale" ? " · THE CODING HAS CHANGED SINCE THIS SUMMARY WAS WRITTEN — regenerate it" : ""} · written ${sy.generatedAt.slice(0, 10)}.`));
      for (const c of sy.summary) out.push(claimLine(c));
      if (sy.nuance.length) { out.push(muted("Nuance")); for (const c of sy.nuance) out.push(claimLine(c)); }
      if (sy.tensions.length) { out.push(muted("Tensions")); for (const c of sy.tensions) out.push(claimLine(c)); }
      if (sy.bySegment.length) { out.push(muted("By participant group")); for (const c of sy.bySegment) out.push(claimLine(c, `${c.group}: `)); }
      if (sy.contradicting.length) { out.push(muted("What runs against it")); for (const c of sy.contradicting) out.push(claimLine(c)); }
    }
    if (t.quotes.length) { out.push(label("Supporting excerpts")); for (const e of t.quotes) out.push(quoteLine(e)); }
    if (t.negative.length) { out.push(label("Contradictory evidence")); for (const e of t.negative.slice(0, 5)) out.push(quoteLine(e)); }
  }

  out.push(H1("Group differences"));
  const table = themeFrequency(st, o.segments, { level: "theme" });
  if (table.groups.length < 2) out.push(muted("The sources are not split into groups (assign speakers to participant segments to compare them)."));
  else {
    out.push(gridTable(["Theme", "All", ...table.groups], table.rows.map((r) => [r.level === "subtheme" ? `  › ${r.name}` : r.name, `${r.total.sources} src · ${r.total.segments} seg`, ...table.groups.map((g) => `${r.byGroup[g].segments} seg (${r.byGroup[g].share}%)`)])));
    out.push(muted(`Segments mentioning the theme, and their share of the group's participant segments (${table.groups.map((g) => `${g}: ${table.groupTotals[g].segments}`).join(", ")}).`));
  }
  if (o.comparison && o.comparison.rows.length) {
    const c = o.comparison;
    out.push(label(`${c.a} compared with ${c.b}`));
    out.push(gridTable(["Theme", `${c.a} (${c.base.a.segments} seg)`, `${c.b} (${c.base.b.segments} seg)`, "Difference (points)"], c.rows.map((r) => [r.theme, `${r.a.segments} (${r.a.share}%)`, `${r.b.segments} (${r.b.share}%)`, `${r.difference > 0 ? "+" : ""}${r.difference}`]), [3400, 1900, 1900, 1800]));
    for (const r of c.rows.slice(0, 4)) for (const e of [r.quoteA, r.quoteB].filter((x): x is QualExcerpt => !!x)) out.push(quoteLine(e));
    out.push(muted(c.note));
  }
  out.push(muted(FREQUENCY_NOTE));

  out.push(H1("Interpretation"));
  if (o.interpretation?.trim()) out.push(body(o.interpretation.trim())); else out.push(muted("Not written yet: the interpretation is the researcher's. The engine reports the evidence above and does not interpret it."));

  out.push(H1("Limitations"));
  for (const l of [
    "Qualitative samples are purposive and small: the findings describe the range of views among these participants and are not population estimates.",
    FREQUENCY_NOTE,
    ...(rs.codes.ai_suggested || rs.excerpts.ai_suggested ? [`${rs.codes.ai_suggested} code${rs.codes.ai_suggested === 1 ? "" : "s"} and ${rs.excerpts.ai_suggested} excerpt${rs.excerpts.ai_suggested === 1 ? "" : "s"} are still AI suggestions that no person has reviewed.`] : []),
    "Transcripts produced by speech-to-text can mishear words and speakers; quotes are exact spans of the transcript as stored, not of the recording.",
    ...(o.redact ? ["Personal details are redacted in this copy of the report."] : []),
    ...(o.syntheses?.length || o.insights ? ["Theme summaries and key findings were written by an AI model and checked mechanically (citations, groups, numbers), not for meaning: a sentence can cite real excerpts and still over-read them. Review them against the quotes before relying on them."] : []),
    ...((o.syntheses ?? []).some((x) => x.state === "stale") || o.insights?.state === "stale" ? ["Some AI-written sections predate the latest coding changes (marked as such)."] : []),
  ]) out.push(bullet(l));

  out.push(H1("Review status and history"));
  out.push(gridTable(["", "Reviewed", "AI-suggested", "Rejected"], [["Codes", String(rs.codes.human_reviewed), String(rs.codes.ai_suggested), String(rs.codes.rejected)], ["Themes", String(rs.themes.human_reviewed), String(rs.themes.ai_suggested), String(rs.themes.rejected)], ["Excerpts", String(rs.excerpts.human_reviewed), String(rs.excerpts.ai_suggested), String(rs.excerpts.rejected)]], [2400, 2200, 2200, 2200]));
  const hist = (o.history ?? []).slice(-25);
  if (hist.length) { const nm = o.coderName ?? ((x: string) => x); out.push(label("Recent changes")); out.push(gridTable(["When", "Who", "What"], hist.map((h) => [h.at.slice(0, 16).replace("T", " "), nm(h.actor), red(h.detail)]), [1800, 1800, 5400])); }
  out.push(divider());
  out.push(muted(`${definitionStamp(def).text} · codebook v${cb.version} · generated ${date}`));
  return document(`${plain(title, 80)} — qualitative report`, `Qualitative report for ${def.meta.title}`, out, { header: `${def.meta.title} — Qualitative report`, footer: `${o.client ? `Prepared for ${o.client} · ` : ""}${date}` });
}

/* ------------------------------------------------------------ reading a .docx transcript */

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");

/** The text of a Word document, one line per paragraph (tabs and line breaks kept) — for importing a .docx transcript. */
export function readDocxText(buf: Buffer | Uint8Array): string {
  const entries = unzipEntries(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  const xml = entries.get("word/document.xml")?.toString("utf8");
  if (!xml) throw new Error("not a Word document (no word/document.xml)");
  const bodyXml = xml.replace(/^[\s\S]*?<w:body[^>]*>/, "").replace(/<\/w:body>[\s\S]*$/, "");
  const paras = bodyXml.split(/<\/w:p>/);
  const lines: string[] = [];
  for (const p of paras) {
    let t = "";
    for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g)) t += m[1] !== undefined ? decode(m[1]) : m[0] === "<w:tab/>" ? "\t" : "\n";
    lines.push(t);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
