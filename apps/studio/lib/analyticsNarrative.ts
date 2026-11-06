import type { SupabaseClient } from "@supabase/supabase-js";
import { aiModelName, completeJson } from "@rescript/ai";
import { briefText, claimsBrief, claimsFromRun, claimsHash, gateNarrative, hash64, promptVersion, redactPrompt, redactRunForModel, NARRATIVE_INSTRUCTIONS, type AnalysisRun, type NarrativeSections } from "@rescript/analytics";
import { aiAllowed } from "./aiPolicy";
import { keepReply, recordAiRefused, recordAiText, replyFromCache, replyKey } from "./aiText";
import { billingProjectFor, meteredAi } from "./metering";
import { aiReadyFor, connectionTag } from "./byok/connect";
import { outputBudget } from "./copilot/budget";
import type { AuthedUser } from "./guard";

/**
 * THE GATED NARRATIVE, in one place (Analytics upgrade M2). The model writes from the run's CLAIMS only, through
 * the gate (audit A-1): what is sent is redacted first (A-7), the project's AI switch is asked before the cache
 * is read (A-2), the reply is kept under its claims and prompt version (A-6), and what stands is recorded. The
 * copilot's findings outputs and the Analytics Overview both read this; neither holds a copy of the rule.
 *
 * When there is no model, the model is off, or it gives nothing, the engine's words stand — the caller always
 * has them (`reportNarrative`), and `gate` says which it is showing. Nothing here is ever a finding: every
 * sentence the model offers is checked against the numbers of the claims it cites.
 */
export type NarrativeRun = Pick<AnalysisRun, "computedAt" | "trigger" | "environment" | "n" | "findings" | "verdicts" | "warnings"> & { corrections?: AnalysisRun["corrections"]; discoveries?: AnalysisRun["discoveries"]; advice?: AnalysisRun["advice"]; kpis?: AnalysisRun["kpis"]; since?: AnalysisRun["since"] };

export interface GatedNarrativeOutcome {
  narrative: NarrativeSections | null;
  /** what happened, in words a person can read: "7 of 9 sentences kept; 1 replaced…" or why the engine's words stand */
  gate: string;
  source: "model" | "engine";
  cached: boolean;
}

export async function gatedNarrativeFor(user: AuthedUser | null, db: SupabaseClient | null, surveyId: string, run: NarrativeRun, opts: { audience: string; fake?: unknown; operation?: "copilot_narrative" | "overview_summary" }): Promise<GatedNarrativeOutcome> {
  const operation = opts.operation ?? "copilot_narrative";
  const none = (gate: string): GatedNarrativeOutcome => ({ narrative: null, gate, source: "engine", cached: false });
  if (!(await aiReadyFor(user, surveyId, operation))) return none("no model configured - the engine's words stand");
  const red = redactRunForModel(run);
  const claims = claimsFromRun(red.run);
  const pv = promptVersion(NARRATIVE_INSTRUCTIONS);
  const model = aiModelName("large");
  let raw: unknown = opts.fake ?? null;
  let aiOff: string | null = null;
  let cached = false;
  let failure: string | null = null;
  let charge = 0;
  const allowed = await aiAllowed(surveyId, operation);
  if (!allowed.allowed) { raw = null; aiOff = allowed.message ?? "AI is off for this project."; void recordAiRefused({ userId: user?.userId ?? null, surveyId }, operation, allowed.reason ?? "project_internal"); }
  else if (!raw) {
    const brief = briefText(red.run, { maxFindings: 25 });
    const prompt = redactPrompt(`${NARRATIVE_INSTRUCTIONS}\n\nAUDIENCE: ${opts.audience}.\n\nRUN BRIEF:\n${brief}\n\nCLAIMS (cite these ids):\n${claimsBrief(claims)}`).text;
    const conn = await connectionTag({ userId: user?.userId, customerId: user?.customerId, surveyId, operation });
    const key = replyKey({ op: "narrative", pv, model, audience: opts.audience, claims: claimsHash(claims), brief: hash64(brief), ...(conn ? { conn } : {}) });
    const hit = await replyFromCache<unknown>(db ?? undefined, surveyId, key);
    if (hit) { raw = hit; cached = true; }
    else {
      const billing = await billingProjectFor(user, surveyId);
      if (!("response" in billing)) {
        const nb = outputBudget("narrative");
        const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: prompt, maxTokens: nb.expectedTokens, operation }, () => completeJson("You write research findings for clients. Answer with JSON only.", prompt, nb.maxTokens, { timeoutMs: nb.timeoutMs, continuations: nb.continuations })).catch((e: unknown) => { failure = e instanceof Error ? e.message : "the model call failed"; return null; });
        if (m && !m.ok) { if (m.reason === "ai_off") aiOff = m.message; else failure = m.message; }
        if (m && m.ok) { raw = m.value; charge = m.event?.customerCharge ?? 0; await keepReply(db ?? undefined, surveyId, key, raw); }
      } else failure = "the workspace could not be charged";
    }
  }
  const g = raw && typeof raw === "object" ? gateNarrative(red.run, raw as Record<string, unknown>, { claims }) : null;
  if (g && g.offered) {
    const gate = `${g.kept} of ${g.offered} sentences kept${g.replaced ? `; ${g.replaced} replaced by the engine's wording` : ""}${g.rejected.length ? `; dropped: ${g.rejected.map((r) => `${r.section}: ${r.reason}`).join(" | ")}` : ""}${red.withheld.length ? `; ${red.withheld.length} small-group finding${red.withheld.length === 1 ? "" : "s"} not sent to the model` : ""}`;
    if (!opts.fake) void recordAiText({ userId: user?.userId ?? null, surveyId }, { operation, model, promptVersion: pv, claimsHash: claimsHash(claims), claims: [...new Set(g.sentences.flatMap((x) => x.claims))], offered: g.offered, kept: g.kept, replaced: g.replaced, rejected: g.rejected.map((r) => ({ reason: r.reason })), withheld: red.withheld, cached, charge });
    return { narrative: g.accepted, gate, source: "model", cached };
  }
  return none(aiOff ? `${aiOff} The engine's words stand.` : failure ? `the model could not be used (${failure}) - the engine's words stand` : "the model gave nothing - the engine's words stand");
}
