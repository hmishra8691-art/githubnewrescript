import type { SurveyDefinition } from "@rescript/schema";
import { INJECTION_NOTICE, INJECTION_WARNING, PROVENANCE_REASON, UNTRUSTED_DATA_RULE, fenceUntrusted, provenanceGate, scanUntrusted, withoutInstructionLines, type InjectionSignal, type ProvenanceExclusion, type SurveyAction } from "@rescript/engine";

/**
 * PROMPT INJECTION IN A COPILOT TURN (audit 2026-10-18) — what the turn route asks, in one place:
 *
 *   assessTurn     does this turn carry text the researcher did not write (research documents' cards and
 *                  passages), and does any of it — or a pasted brief, the survey's own text, an image's file
 *                  name — read like instructions to the AI? And what, then, are the researcher's OWN words?
 *   fenceResearch  the research material as fenced data, the standard rule in front of it (the rule is
 *                  lifted into the cached system blocks by copilotCall; the nonce stays in the user text)
 *   gateReply      the provenance gate on the model's reply: high-risk actions the researcher did not ask
 *                  for are taken out of the proposal — never sent to the browser to replay — and said
 *   turnNotice     the one sentence the turn shows
 */

export interface TurnProvenance {
  /** the turn carries content the researcher did not write */
  untrusted: boolean;
  /** some of it reads like instructions to the AI (the gate's strict set applies) */
  flagged: boolean;
  /** where: "research documents", "pasted brief", "survey text", "theme image names" */
  sources: string[];
  flaggedSources: string[];
  signals: InjectionSignal[];
  /** what the gate reads as the researcher's own request */
  researcherText: string;
}

const MAX_SURVEY_SCAN = 200_000;

/** the survey's own words, for the scan (imported questionnaires land here) */
function surveyText(def: SurveyDefinition | undefined): string {
  if (!def) return "";
  const parts: string[] = [];
  let n = 0;
  for (const q of def.questions ?? []) {
    const x = q as unknown as { text?: string; instruction?: string; customHtml?: string; options?: { label?: string }[]; rows?: { label?: string }[] };
    for (const t of [x.text, x.instruction, x.customHtml, ...(x.options ?? []).map((o) => o.label), ...(x.rows ?? []).map((r) => r.label)]) {
      if (typeof t === "string" && t) { parts.push(t); n += t.length; }
    }
    if (n > MAX_SURVEY_SCAN) break;
  }
  return parts.join("\n");
}

export function assessTurn(input: {
  message: string;
  longBrief: boolean;
  /** the research cards and passages this turn sends ("" when none) */
  research?: string;
  /** the project's research documents (their upload warnings say whether the scan flagged them) */
  docs?: readonly { name: string; warnings?: readonly string[] }[];
  def?: SurveyDefinition;
  /** other untrusted snippets sent this turn (theme image names) */
  extra?: readonly { source: string; text: string }[];
}): TurnProvenance {
  const sources: string[] = [], flaggedSources: string[] = [];
  const signals: InjectionSignal[] = [];
  const take = (source: string, flagged: boolean, sig: InjectionSignal[]) => { if (flagged && !flaggedSources.includes(source)) { flaggedSources.push(source); signals.push(...sig); } };
  if (input.research) {
    sources.push("research documents");
    const s = scanUntrusted(input.research);
    const uploadFlag = (input.docs ?? []).some((d) => (d.warnings ?? []).some((w) => w.startsWith(INJECTION_WARNING)));
    take("research documents", s.flagged || uploadFlag, s.signals.length ? s.signals : [{ kind: "hidden", strength: "strong", excerpt: "flagged when the document was uploaded" }]);
  }
  let researcherText = input.message;
  if (input.longBrief) {
    const s = scanUntrusted(input.message);
    if (s.flagged) { sources.push("pasted brief"); take("pasted brief", true, s.signals); researcherText = withoutInstructionLines(input.message); }
  }
  const st = surveyText(input.def);
  if (st) { const s = scanUntrusted(st); if (s.flagged) { sources.push("survey text"); take("survey text", true, s.signals); } }
  for (const e of input.extra ?? []) {
    const s = scanUntrusted(e.text);
    if (s.flagged) { if (!sources.includes(e.source)) sources.push(e.source); take(e.source, true, s.signals); }
  }
  return { untrusted: sources.length > 0, flagged: flaggedSources.length > 0, sources, flaggedSources, signals: signals.slice(0, 20), researcherText };
}

/** The research material as data: the standard rule (static — lifted into a cached block), then the fence with this turn's nonce. */
export function fenceResearch(research: string, nonce: string): string {
  return `${UNTRUSTED_DATA_RULE}\n\n${fenceUntrusted(research, { source: "uploaded research documents (cards and passages)", nonce })}`;
}

interface GateableReply { kind: string; reply: string; actions: SurveyAction[]; rejected: { index: number; reason: string }[]; findings: unknown[]; memory?: string }

/** the provenance exclusions recorded on a reply (its `rejected` entries the gate wrote) */
export const provenanceRejections = (r: { rejected: { reason: string }[] } | null | undefined) => (r?.rejected ?? []).filter((x) => x.reason.endsWith(PROVENANCE_REASON));

/**
 * The gate on one reply. Untouched when the turn carried nothing untrusted. Otherwise each high-risk action
 * the researcher's own words do not ask for is removed from `actions` and recorded in `rejected` with its
 * reason; a reply left with nothing to propose says so in the Studio's words (the model's account of the
 * change it was steered into is not repeated), and a memory that itself reads like instructions is dropped.
 */
export function gateReply<R extends GateableReply>(reply: R, def: SurveyDefinition, prov: TurnProvenance, opts: { allowUrls?: readonly string[] } = {}): { reply: R; excluded: ProvenanceExclusion[] } {
  if (!prov.untrusted) return { reply, excluded: [] };
  const g = provenanceGate(def, reply.actions, { untrusted: true, strict: prov.flagged, researcherText: prov.researcherText, allowUrls: opts.allowUrls });
  let out: R = reply;
  if (g.excluded.length) {
    const said = `Not applied: ${g.excluded.length === 1 ? "one change" : `${g.excluded.length} changes`} that came from document content, not from your request (${[...new Set(g.excluded.map((e) => e.why))].slice(0, 3).join("; ")}). Ask for ${g.excluded.length === 1 ? "it" : "them"} explicitly if you want ${g.excluded.length === 1 ? "it" : "them"}.`;
    const rejected = [...reply.rejected, ...g.excluded.map((e) => ({ index: -1, reason: `${e.op.replace(/_/g, " ")} — ${e.reason}` }))];
    out = g.kept.length
      ? { ...reply, actions: g.kept, rejected, reply: `${reply.reply} ${said}`.slice(0, 4000) }
      : { ...reply, actions: [], rejected, kind: reply.findings.length ? "review" : "answer", reply: said };
  }
  if (prov.flagged && out.memory && scanUntrusted(out.memory).flagged) { const { memory: _drop, ...rest } = out; out = rest as R; }
  return { reply: out, excluded: g.excluded };
}

/** the sentence the turn shows: the scan's notice, or what the gate left out when the scan saw nothing */
export function turnNotice(prov: TurnProvenance, excluded: number): string | undefined {
  if (prov.flagged) {
    const src = prov.flaggedSources[0];
    const lead = src === "research documents" ? INJECTION_NOTICE : `This ${src === "pasted brief" ? "brief" : src} contains text that looks like instructions to the AI; it was treated as data.`;
    return excluded ? `${lead} ${excluded === 1 ? "One change it asked for was" : `${excluded} changes it asked for were`} left out.` : lead;
  }
  if (excluded) return `${excluded === 1 ? "One change" : `${excluded} changes`} came from document content rather than your request and ${excluded === 1 ? "was" : "were"} left out.`;
  return undefined;
}

/** a reply that replaces another (the repair, the coverage pass) keeps the gate's record of what it left out */
export function carryProvenance<R extends { rejected: { index: number; reason: string }[] }>(from: { rejected: { index: number; reason: string }[] } | null | undefined, to: R): R {
  const add = provenanceRejections(from).filter((x) => !to.rejected.some((y) => y.reason === x.reason));
  return add.length ? { ...to, rejected: [...to.rejected, ...add] } : to;
}
