"use client";
import type { SurveyDefinition } from "@rescript/schema";
import type { QualRequest } from "@rescript/engine";
import { qualPreview, type QualCardPreview } from "../../../lib/copilot/qualCard";
import { allSegments } from "../../../lib/qual/qualWorkspace";
import { httpQualApi, sharedSandboxQualApi, type WorkspaceView } from "../../studio/qual/qualApi";
import { httpSynthesisApi, sandboxSynthesisApi, studyOfDef, type SynthesisApi } from "../../studio/qual/synthesisApi";

/**
 * A QUALITATIVE TURN IN THE COPILOT (2026-10-22). The engine classified the sentence (`interpretQualRequest`);
 * this reads the coded data into a PREVIEW card (what would be done, on what, how many model calls) — and, when
 * the researcher presses Run, does it through the same client the Qualitative panel uses (the routes for a saved
 * project, the page's sandbox workspace otherwise). Nothing runs on the sentence alone.
 */
export interface QualCard extends QualCardPreview {
  request: QualRequest;
  status: "preview" | "running" | "done" | "answered" | "failed";
  result?: string[];
  quotes?: { id: string; quote: string; where: string }[];
  error?: string;
}
interface Ctx { surveyId: string; def: SurveyDefinition }

function clients(c: Ctx): { syn: SynthesisApi; load: () => Promise<WorkspaceView> } {
  if (c.surveyId === "sandbox") {
    const api = sharedSandboxQualApi(() => c.def);
    return { syn: sandboxSynthesisApi(api, () => c.def, () => {}), load: () => api.load() };
  }
  const api = httpQualApi(c.surveyId);
  return { syn: httpSynthesisApi(c.surveyId, () => {}, () => api.load()), load: () => api.load() };
}

export async function qualTurn(req: QualRequest, c: Ctx): Promise<{ card: QualCard; said: string }> {
  try {
    const { load } = clients(c);
    const ws = await load();
    if (!ws.available) return { card: { request: req, status: "failed", title: req.text, lines: [], runnable: false, calls: 0, error: ws.note ?? "The qualitative workspace is not available." }, said: ws.note ?? "The qualitative workspace is not available." };
    const p = qualPreview(req, { state: ws.state, segments: allSegments(ws), objectives: studyOfDef(c.def).objectives, aiReady: c.surveyId === "sandbox" || ws.can.code, sandbox: c.surveyId === "sandbox" });
    const status = p.runnable ? "preview" : "answered";
    return { card: { ...p, request: req, status }, said: `${p.title}${p.runnable ? " — preview below; nothing runs until you press the button." : ""}\n${p.lines.filter(Boolean).join("\n")}` };
  } catch (e) {
    const msg = (e as Error).message || "the request failed";
    return { card: { request: req, status: "failed", title: req.text, lines: [], runnable: false, calls: 0, error: msg }, said: `The qualitative data could not be read: ${msg}` };
  }
}

/** Run: do what the preview said */
export async function runQualCard(card: QualCard, c: Ctx): Promise<{ card: QualCard; said: string }> {
  const { syn } = clients(c);
  const req = card.request;
  try {
    switch (req.op) {
      case "summarise_themes": {
        const r = await syn.writeThemes(card.themeIds);
        const recs = Object.values(r.state.themes).filter((t) => !card.themeIds || card.themeIds.includes(t.record.themeId));
        const lines = recs.map((t) => `${t.record.themeName}: ${t.record.summary.map((x) => x.text).join(" ") || "(no sentence survived the checks)"} — ${t.record.coverage.words}`);
        return { card: { ...card, status: "done", result: [...lines, `${r.calls} model call(s); ${r.dropped.length} sentence(s) dropped as uncited, misattributed or stating numbers. Open Research Tools → Qualitative → Synthesis to edit them.`] }, said: `Wrote ${recs.length} theme summar${recs.length === 1 ? "y" : "ies"} (AI-written, cited).` };
      }
      case "insights": {
        const r = await syn.writeInsights(card.groups ?? null);
        const ins = r.state.insights?.record;
        const obs = (ins?.objectives ?? []).filter((o) => !card.objective || o.ref === `O${card.objective}`);
        const lines = obs.map((o) => `${o.ref} (${o.status.replace(/_/g, " ")}): ${o.findings.map((f) => f.text).join(" ") || "not enough evidence in the coded data"}`);
        return { card: { ...card, status: "done", result: [...lines, ...(ins?.recommendations.length ? [`Recommendations (interpretation): ${ins.recommendations.map((x) => x.text).join(" ")}`] : []), "Every finding cites its excerpts — see Research Tools → Qualitative → Synthesis."] }, said: card.objective ? `Key findings for objective ${card.objective}.` : "Key findings written, objective by objective." };
      }
      case "highlight_reel": {
        const reels = await syn.createReel(req.topic.replace(/^./, (x) => x.toUpperCase()), card.excerptIds ?? []);
        const reel = reels[reels.length - 1];
        return { card: { ...card, status: "done", result: [`Made “${reel?.name}” with ${reel?.items.length ?? 0} quotes — Research Tools → Qualitative → Highlights to reorder, play the clips or export it.`] }, said: `Made the highlight reel “${reel?.name}”.` };
      }
      case "double_coding": {
        await syn.createAssignment({ coderB: "ai", overlapPct: req.overlapPct });
        return { card: { ...card, status: "done", result: ["Set up. Code your share in Research Tools → Qualitative → Double coding, press “Let the AI code”, then submit — the agreement appears when both have submitted."] }, said: "Blind double-coding is set up." };
      }
      case "ask": {
        const a = await syn.ask(req.question);
        return { card: { ...card, status: "done", result: a.notEnoughEvidence ? [`Not enough evidence. ${a.note}`] : a.claims.map((x) => x.text), quotes: a.quotes.map((q) => ({ id: q.id, quote: q.quote, where: [q.source, q.speaker].filter(Boolean).join(" · ") })) }, said: a.notEnoughEvidence ? "Not enough evidence in the coded data to answer that." : a.claims.map((x) => x.text).join(" ") };
      }
      case "auto_code": {
        const cur = await syn.jobs();
        const s = await syn.setAutoCode({ ...cur.settings, enabled: req.enabled });
        return { card: { ...card, status: "done", result: [s.enabled ? "Automatic coding is on: new sources are coded as AI suggestions while the Qualitative workspace is open." : "Automatic coding is off."] }, said: s.enabled ? "Automatic coding is on." : "Automatic coding is off." };
      }
      case "group_session": {
        const id = await syn.createGroup({ title: req.title ?? `${c.def.qualStudy?.title ?? c.def.meta.title} — group session`, mode: req.mode });
        return { card: { ...card, status: "done", result: [`Set up (${req.mode}). Start it and share the link in Research Tools → Qualitative → Group sessions.`] }, said: `A ${req.mode} text group session is set up (${id.slice(0, 8)}).` };
      }
      default: return { card: { ...card, status: "answered" }, said: card.title };
    }
  } catch (e) {
    const msg = (e as Error).message || "the request failed";
    return { card: { ...card, status: "failed", error: msg }, said: `Not done: ${msg}` };
  }
}
