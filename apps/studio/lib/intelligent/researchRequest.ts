import { LAUNCHERS } from "../agents/launch.ts";

/**
 * THE RESEARCH AGENTS, REACHED BY SAYING WHAT YOU WANT (2026-11-08 — one researcher-facing system).
 *
 * The separate AI Agents tab is gone; Intelligent mode is the only place a researcher starts AI work. Building,
 * reworking, translating and exams were already planned from a Copilot sentence (the registered planners' own
 * `matches`). The three research agents — run the analysis plan, draft the findings report, recommend next steps —
 * are started by name only, because they write the analytics tables and need the Data Analytics edit right, which a
 * Copilot turn does not check. So Intelligent mode recognises those three requests here, deterministically, and starts
 * the same planner through POST /api/copilot/tasks — the route that checks that right — with the options the launcher
 * would have sent (dataset, audience, focus, the decision). Nothing else changes: same planners, same steps, same
 * checks.
 *
 * Narrow on purpose: a sentence that merely mentions a report or an analysis ("add a question about the annual
 * report", "explain the analysis framework") is not one of these; the Copilot reads it as before.
 */
export type ResearchPlanner = "analysis" | "report" | "decision";
export interface ResearchRequest { planner: ResearchPlanner; options: Record<string, unknown>; label: string }

const norm = (s: string) => s.toLowerCase().replace(/[“”"’']/g, "").replace(/\s+/g, " ").trim();
const optionsFor = (id: "analyse" | "report" | "decide", fields: Record<string, string>) => LAUNCHERS.find((l) => l.id === id)?.options?.(fields) ?? {};

const ANALYSE = /\b(?:run|execute|apply|do)\b.{0,30}\b(?:analysis plan|planned analys[ie]s|analysis framework on the data|every analysis|all (?:the )?analys[ie]s)\b|\b(?:analy[sz]e|analyse) (?:the |our |all (?:the )?)?(?:data|responses|results)\b|\brun (?:the )?(?:crosstabs|tabs|significance tests) (?:on|for) (?:the )?(?:data|responses)\b/;
const REPORT = /\b(?:draft|write|create|prepare|build|make|generate)\b.{0,25}\b(?:findings report|findings storyline|report of (?:the )?findings|storyline (?:of|from) (?:the )?findings|results report|research report|topline report)\b/;
const DECIDE = /\b(?:recommend(?:ations?)?|suggest)\b.{0,25}\bnext steps\b|\b(?:decision brief|recommendations? (?:from|based on) (?:the )?(?:findings|results|data))\b|\bwhat should we (?:do|decide) (?:next |based on|from|given)\b/;

export function researchRequest(text: string): ResearchRequest | null {
  const t = norm(text);
  if (!t || t.length > 600) return null;
  /* a questionnaire edit that names one of these words is still a questionnaire edit */
  if (/\b(?:add|insert|create|write) (?:a |an |the )?(?:new )?question\b/.test(t)) return null;
  if (DECIDE.test(t)) {
    const m = /\b(?:for|on|about) (?:the decision|whether)[: ]+(.{4,200})$/.exec(text.trim()) ?? /\b(?:decision)[: ]+(.{4,200})$/.exec(text.trim());
    return { planner: "decision", options: optionsFor("decide", { question: m?.[1]?.trim() ?? "" }), label: "Recommend next steps" };
  }
  if (REPORT.test(t)) {
    const audience = /\bexec(?:utive)?s?\b|\bleadership\b|\bboard\b/.test(t) ? "executive" : /\bresearchers?\b|\banalysts?\b|\btechnical\b/.test(t) ? "researcher" : "client";
    const focus = /\b(?:leading with|lead with|focus(?:ing)? on|focussing on)\s+(.{3,200})$/i.exec(text.trim())?.[1]?.trim() ?? "";
    return { planner: "report", options: optionsFor("report", { audience, focus }), label: "Draft the findings report" };
  }
  if (ANALYSE.test(t)) {
    const dataset = /\btest (?:responses|data)\b/.test(t) ? "TEST" : /\ball responses\b|\btest and live\b|\blive and test\b/.test(t) ? "ALL" : "LIVE";
    const clean = /\bclean(?:ed)? (?:data(?:set)?|responses)\b|\bquality removals?\b/.test(t) ? "clean" : "all";
    return { planner: "analysis", options: optionsFor("analyse", { dataset, clean }), label: "Run the analysis plan" };
  }
  return null;
}
