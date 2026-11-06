/**
 * THE MIXED-METHODS HAND-OFF (platform audit 2026-11-05; capability `mixed_methods`, previously partial).
 *
 * Both phases of a mixed-methods study were designed here — a qualitative guide, then the quantitative survey
 * from its propositions — and nothing handed the qualitative themes to the quantitative phase: the researcher
 * retyped them. This turns the coded, synthesised themes of the qualitative phase into what the quantitative
 * phase is built from, in the research design's own vocabulary:
 *
 *   a HYPOTHESIS per theme     — a proposition the survey can test, with the qualitative evidence it rests on
 *                                (how many participants raised it, the synthesis's first claim) in the words
 *   a RESEARCH QUESTION per theme
 *   a CONSTRUCT per theme      — named for the theme, defined by its description or synthesis, with the codes
 *                                under it as the facets a scale would measure
 *   two QUESTION DRAFTS        — an agreement grid with one row per theme, and a "which matters most" item —
 *                                the simplest instrument that measures every theme's prevalence
 *
 * Only themes a person has reviewed are handed over by default (`includeAiSuggested` widens it): the
 * quantitative phase must not be built on a machine's draft. Everything is a PROPOSAL the Studio applies to
 * the definition under the usual edit rules; nothing here writes anything. A theme already present as a
 * hypothesis or construct (by name) is reported as skipped, so the hand-off can be run again after more
 * coding without duplicating what it did the first time.
 */
import type { QualState, QualTheme } from "./types.js";
import type { ThemeSynthesis } from "./synthesis.js";

export interface HandoffTheme {
  themeId: string;
  name: string;
  hypothesis: string;
  researchQuestion: string;
  construct: { name: string; role: "independent"; definition: string; facets: string[]; origin: "qualitative" };
  evidence: { participants: number; sources: number; totalSources: number; excerpts: number; firstClaim: string | null };
}

export interface HandoffQuestionDraft {
  id: string;
  code: string;
  variableName: string;
  type: "matrix_single" | "single_select";
  text: string;
  rows?: { code: string; label: string }[];
  options: { code: number; label: string }[];
  settings?: Record<string, unknown>;
}

export interface HandoffProposal {
  themes: HandoffTheme[];
  hypotheses: string[];
  researchQuestions: string[];
  constructs: HandoffTheme["construct"][];
  questions: HandoffQuestionDraft[];
  skipped: { themeId: string; name: string; why: string }[];
  statement: string;
}

export interface HandoffOptions {
  /** the research design as it stands, so what is already there is skipped rather than duplicated */
  existing?: { hypotheses?: readonly string[]; constructs?: readonly { name: string }[]; researchQuestions?: readonly string[] };
  /** question codes already in use, so the drafts do not collide */
  takenCodes?: readonly string[];
  includeAiSuggested?: boolean;
  /** the population the hypotheses speak of (default "respondents") */
  population?: string;
}

const AGREE: HandoffQuestionDraft["options"] = [
  { code: 1, label: "Strongly disagree" }, { code: 2, label: "Disagree" }, { code: 3, label: "Neither" }, { code: 4, label: "Agree" }, { code: 5, label: "Strongly agree" },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sentence = (s: string) => { const t = s.trim(); return /[.!?]$/.test(t) ? t : `${t}.`; };

function freeCode(base: string, taken: Set<string>): string {
  let code = base;
  for (let i = 2; taken.has(code); i++) code = `${base}_${i}`;
  taken.add(code);
  return code;
}

export function qualHandoff(state: QualState, syntheses: readonly ThemeSynthesis[], opts: HandoffOptions = {}): HandoffProposal {
  const population = (opts.population ?? "respondents").trim() || "respondents";
  const existingH = new Set((opts.existing?.hypotheses ?? []).map(norm));
  const existingC = new Set((opts.existing?.constructs ?? []).map((c) => norm(c.name)));
  const existingQ = new Set((opts.existing?.researchQuestions ?? []).map(norm));
  const synth = new Map(syntheses.map((s) => [s.themeId, s]));
  const themes: HandoffTheme[] = [];
  const skipped: HandoffProposal["skipped"] = [];

  const topLevel = (t: QualTheme) => !t.parentId;
  for (const theme of state.codebook.themes) {
    if (theme.status === "rejected") { skipped.push({ themeId: theme.id, name: theme.name, why: "rejected by a reviewer" }); continue; }
    if (theme.status === "ai_suggested" && !opts.includeAiSuggested) { skipped.push({ themeId: theme.id, name: theme.name, why: "not yet reviewed by a person" }); continue; }
    if (!topLevel(theme)) { skipped.push({ themeId: theme.id, name: theme.name, why: "a subtheme — carried as a facet of its parent" }); continue; }
    if (existingC.has(norm(theme.name))) { skipped.push({ themeId: theme.id, name: theme.name, why: "already a construct in the research design" }); continue; }

    const s = synth.get(theme.id) ?? null;
    const codes = state.codebook.codes.filter((c) => c.themeId === theme.id && c.status !== "rejected");
    const subthemes = state.codebook.themes.filter((t) => t.parentId === theme.id && t.status !== "rejected");
    const facets = [...new Set([...subthemes.map((t) => t.name), ...codes.map((c) => c.name)])].slice(0, 12);
    const excerpts = state.excerpts.filter((e) => e.status !== "rejected" && codes.some((c) => c.id === e.codeId));
    const counts = s?.counts ?? null;
    const participants = counts?.participants ?? new Set(excerpts.map((e) => e.sourceId)).size;
    const sources = counts?.sources ?? new Set(excerpts.map((e) => e.sourceId)).size;
    const totalSources = counts?.totalSources ?? 0;
    const firstClaim = s?.summary?.[0]?.text?.trim() || null;
    const definition = sentence(theme.description?.trim() || firstClaim || `What participants meant by “${theme.name}” in the qualitative phase`);
    const prevalence = totalSources > 0 ? `${sources} of ${totalSources} qualitative sources` : `${sources} qualitative source${sources === 1 ? "" : "s"}`;

    const hypothesis = `“${theme.name}” is widespread among ${population}: a majority will agree with it when asked directly, and agreement will differ by segment. Qualitative phase: raised in ${prevalence}${firstClaim ? ` — ${sentence(firstClaim)}` : "."}`;
    const researchQuestion = `How widespread is “${theme.name}” among ${population}, and which segments hold it most strongly?`;
    if (existingH.has(norm(hypothesis)) || existingQ.has(norm(researchQuestion))) { skipped.push({ themeId: theme.id, name: theme.name, why: "already handed over" }); continue; }

    themes.push({
      themeId: theme.id, name: theme.name, hypothesis, researchQuestion,
      construct: { name: theme.name, role: "independent", definition, facets, origin: "qualitative" },
      evidence: { participants, sources, totalSources, excerpts: excerpts.length, firstClaim },
    });
  }

  const taken = new Set((opts.takenCodes ?? []).map((c) => c.toUpperCase()));
  const questions: HandoffQuestionDraft[] = [];
  if (themes.length) {
    const gridCode = freeCode("QUAL_THEMES", taken);
    questions.push({
      id: `q_${gridCode.toLowerCase()}`, code: gridCode, variableName: gridCode, type: "matrix_single",
      text: "How much do you agree or disagree with each of the following?",
      rows: themes.map((t, i) => ({ code: `t${i + 1}`, label: t.name })),
      options: AGREE,
      settings: { origin: "qualitative_handoff", themeIds: themes.map((t) => t.themeId) },
    });
    if (themes.length >= 2) {
      const pickCode = freeCode("QUAL_THEME_TOP", taken);
      questions.push({
        id: `q_${pickCode.toLowerCase()}`, code: pickCode, variableName: pickCode, type: "single_select",
        text: "Which one of these matters most to you?",
        options: themes.map((t, i) => ({ code: i + 1, label: t.name })),
        settings: { origin: "qualitative_handoff", themeIds: themes.map((t) => t.themeId) },
      });
    }
  }

  const statement = themes.length
    ? `${themes.length} reviewed theme${themes.length === 1 ? "" : "s"} handed to the quantitative phase: ${themes.length} hypothes${themes.length === 1 ? "is" : "es"}, ${themes.length} research question${themes.length === 1 ? "" : "s"}, ${themes.length} construct${themes.length === 1 ? "" : "s"} and ${questions.length} question draft${questions.length === 1 ? "" : "s"}.${skipped.length ? ` ${skipped.length} theme${skipped.length === 1 ? "" : "s"} skipped.` : ""}`
    : skipped.length
      ? `Nothing to hand over: ${skipped.length} theme${skipped.length === 1 ? "" : "s"} skipped (${[...new Set(skipped.map((s) => s.why))].join("; ")}).`
      : "Nothing to hand over: the qualitative phase has no themes yet.";

  return {
    themes,
    hypotheses: themes.map((t) => t.hypothesis),
    researchQuestions: themes.map((t) => t.researchQuestion),
    constructs: themes.map((t) => t.construct),
    questions,
    skipped,
    statement,
  };
}
