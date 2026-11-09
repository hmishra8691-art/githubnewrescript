import { NextRequest, NextResponse } from "next/server";
import { aiProviderName, completeJson } from "@rescript/ai";
import { contextGaps, draftPlanByRules, interviewShape, planningPrompt, readPlan, PLANNER_RULES, PLANNER_SCHEMA, type PlanningInput } from "@rescript/engine";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { aiReadyFor } from "@/lib/byok/connect";
import { billingProjectFor, meteredAi, refusalResponse } from "@/lib/metering";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/surveys/{id}/qual/plan { context, answers?: [{question, answer}], format?: voice|chat|hybrid }
 * — RESEARCH CONTEXT → INTERVIEW PLAN (2026-11-08). The researcher's own words become a structured plan (objectives,
 * themes with depth, questions and probes, format, expected insights, what respondents are told, and the questions
 * still to ask them) with its derived length and depth (`interviewShape`). Nothing is written: the researcher edits
 * and approves the plan in Research Tools → Qualitative → Plan, which applies it as one undoable edit.
 *
 * With a model (metered as one AI request on the project, `qual_plan`): the model plans; a reply without a usable
 * theme falls back to the rules' draft, said so. Without one: the rules' draft from the researcher's words, labelled.
 * `project.read`: planning writes nothing (approval is an ordinary edit, under the editing lock); it is metered on the project. The sandbox may plan without a session.
 */
const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  const surveyId = params.id;
  const authed = isFailure(user) ? null : user;
  if (surveyId !== "sandbox") {
    if (isFailure(user)) return user.response;
    const ctx = await requireProjectFor(user, surveyId, "project.read");
    if (isFailure(ctx)) return ctx.response;
  }
  let body: { context?: unknown; answers?: unknown; format?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const context = typeof body.context === "string" ? body.context.trim().slice(0, 12_000) : "";
  if (context.length < 20) return json({ error: "Describe the research in a few sentences first — what you want to learn, why, and who you want to hear from." }, 400);
  const answers = (Array.isArray(body.answers) ? body.answers : []).map((a) => ({ question: String((a as { question?: unknown })?.question ?? "").slice(0, 300), answer: String((a as { answer?: unknown })?.answer ?? "").slice(0, 2000) })).filter((a) => a.question && a.answer.trim()).slice(0, 10);
  const format = body.format === "voice" || body.format === "chat" || body.format === "hybrid" ? body.format : null;
  const input: PlanningInput = { context, answers, format };

  let plan = null as ReturnType<typeof readPlan>;
  let note: string | null = null;
  let charge = 0;
  const ready = aiProviderName() !== "fake" && (await aiReadyFor(authed, surveyId === "sandbox" ? null : surveyId, "qual_plan").catch(() => false));
  if (ready) {
    const billing = await billingProjectFor(authed, surveyId, "project.read");
    if ("response" in billing) return billing.response;
    const prompt = planningPrompt(input);
    try {
      const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: PLANNER_RULES + prompt, maxTokens: 3500, operation: "qual_plan" }, () => completeJson(PLANNER_RULES, prompt, 3500, { schema: { name: "interview_plan", schema: PLANNER_SCHEMA }, timeoutMs: 120_000, retries: 1 }));
      if (!m.ok) return refusalResponse(m as never);
      plan = readPlan(m.value, input);
      charge = Number((m as { event?: { customerCharge?: number } }).event?.customerCharge ?? 0) || 0;
      if (!plan) note = "The AI's plan had no usable theme, so this draft was made from your words by rules — review it carefully, or say more and draft again.";
    } catch (e) {
      console.warn("[rescript:qual] planning call failed", JSON.stringify({ survey: surveyId.slice(0, 8), error: (e as Error).message.slice(0, 200) }));
      note = "The AI could not plan this just now, so this draft was made from your words by rules — review it carefully, or try again.";
    }
  } else note = "No AI model is available here, so this draft was made from your words by rules — a starting point to edit, not a finished plan.";
  if (!plan) plan = draftPlanByRules(input);
  /* the model's questions for the researcher, plus anything a good brief has that this one still lacks */
  const gaps = contextGaps(input).filter((g) => !plan!.clarifications.some((c) => c.question === g.question));
  if (plan.source === "model") plan.clarifications = [...plan.clarifications, ...gaps].slice(0, 4);
  return json({ ok: true, plan, shape: interviewShape(plan), note, usage: { charge } });
}
