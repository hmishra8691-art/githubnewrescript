"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { reviewSurvey, type SurveyAction, type SurveyReview } from "@rescript/engine";
import { useStudio, uid } from "../../studio/store";
import type { CopilotReply, CopilotFinding } from "../../../lib/copilot/prompt";
import { evaluateProposal, rebaseProposal, sameSurvey, changeRecord, memoryFrom, type Proposal, type ProposalState, type ChangeRecord } from "../../../lib/copilot/client";
import type { HeardTranscript } from "../../../lib/intelligent/voice";
import { prepareThemeImage, type ThemeImage } from "../../../lib/copilot/themeImage";

/**
 * THE COPILOT'S STATE AND ITS REQUESTS, for IntelligentView.
 *
 * One conversation per survey, kept for the life of the page (switching to
 * Grid and back must not lose it). One OPEN proposal at a time: a new
 * request while it is open revises it. Apply is one labelled, undoable
 * `store.replace`; every applied change is an entry in the AI change
 * history, with its before and after, and can be undone as one operation.
 */

export interface Passage { doc: string; page: number; heading?: string; excerpt: string }
export interface CopilotEntry {
  id: string;
  kind: "copilot";
  text: string;
  heard?: HeardTranscript;
  status: "thinking" | "ready" | "failed" | "empty";
  reply?: CopilotReply;
  error?: string;
  message?: string;
  usage?: { charge: number };
  context?: { mode: string; researchUsed: boolean; passages: string[]; promptChars: number; outlineChars?: number; cached: boolean; ux?: boolean; uxOnly?: boolean; repair?: { refused: string[]; fixed: boolean } };
  passages?: Record<string, Passage>;
  /** this turn's place in the open proposal */
  proposal?: "open" | "superseded" | "applied" | "cancelled";
  changeN?: number;
  /** what the engine's checks found, for a review turn */
  review?: SurveyReview;
  /** said once the change is applied: what changed, and — for a look-only change — that the structure did not */
  appliedNote?: string;
}
export interface ResearchDocView { id: string; ref: string; name: string; format: string; kind?: string; pages: number; ocrPages: number; chars: number; summary: import("../../../lib/copilot/research").DocSummary | null; warnings: string[]; createdAt: string }
export interface ReviewState { rules: SurveyReview; ai: CopilotFinding[]; at: string; running: boolean }
export type PanelTab = "changes" | "review" | "research" | "history" | "analysis" | "ux" | "inspector";

interface Session {
  proposal: Proposal | null;
  history: ChangeRecord[];
  review: ReviewState | null;
  docs: ResearchDocView[] | null;
  durable: boolean;
  confirmed: boolean;
  tab: PanelTab;
}
const sessions = new Map<string, Session>();
let copilotKnown: boolean | null = null;

export function useCopilot(opts: {
  entries: unknown[];
  push(e: CopilotEntry): void;
  patch(id: string, p: Partial<CopilotEntry> | ((e: CopilotEntry) => Partial<CopilotEntry>)): void;
  patchAll(fn: (e: CopilotEntry) => Partial<CopilotEntry> | null): void;
  selectedId: string | null;
}) {
  const s = useStudio();
  const key = s.surveyDbId;
  const [session, setSessionState] = React.useState<Session>(() => sessions.get(key) ?? { proposal: null, history: [], review: null, docs: null, durable: true, confirmed: false, tab: "inspector" });
  const setSession = React.useCallback((fn: (x: Session) => Session) => setSessionState((cur) => { const next = fn(cur); sessions.set(key, next); return next; }), [key]);
  const [available, setAvailableState] = React.useState<boolean | null>(copilotKnown);
  const setAvailable = (v: boolean) => { copilotKnown = v; setAvailableState(v); };
  const [busy, setBusy] = React.useState(false);
  const fakeRef = React.useRef<unknown[]>([]);
  /* an image to build the theme from, sent with the next request */
  const [themeImage, setThemeImage] = React.useState<ThemeImage | null>(null);
  const [themeImageError, setThemeImageError] = React.useState<string | null>(null);
  const attachThemeImage = React.useCallback(async (file: File) => {
    setThemeImageError(null);
    try { setThemeImage(await prepareThemeImage(file, s.surveyDbId)); } catch (e) { setThemeImageError((e as Error).message); }
  }, [s.surveyDbId]);

  // the browser suites stand in for the model through this hook, as the voice suite does for the microphone
  React.useEffect(() => {
    const w = window as unknown as { __rescriptCopilotFake?: (reply: unknown) => void };
    w.__rescriptCopilotFake = (reply) => { fakeRef.current.push(reply); };
    return () => { delete w.__rescriptCopilotFake; };
  }, []);

  /* the open proposal, evaluated against the survey as it is now */
  const state: ProposalState | null = React.useMemo(() => (session.proposal ? evaluateProposal(session.proposal) : null), [session.proposal]);
  const stale = !!session.proposal && !sameSurvey(session.proposal.base, s.def);

  const copilotTurns = (opts.entries as CopilotEntry[]).filter((e) => (e as { kind?: string }).kind === "copilot");

  /* ------------------------------------------------------------ ask */
  /** "empty": the model's answer had nothing usable — the caller may fall back to the grammar */
  const ask = React.useCallback(async (text: string, heard?: HeardTranscript, mode?: "review" | "generate"): Promise<"handled" | "unavailable" | "empty"> => {
    const id = uid("copilot");
    opts.push({ id, kind: "copilot", text, ...(heard ? { heard } : {}), status: "thinking" });
    setBusy(true);
    try {
      const proposal = session.proposal;
      const working: SurveyDefinition = proposal ? (stale ? evaluateProposal(rebaseProposal(proposal, s.def)).after : evaluateProposal(proposal).after) : s.def;
      const fake = fakeRef.current.shift();
      const r = await fetch("/api/copilot/turn", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ surveyId: s.surveyDbId, message: text, definition: working, selectedId: opts.selectedId, memory: memoryFrom(copilotTurns.map((t) => ({ user: t.text, reply: t.reply }))), ...(mode ? { mode } : {}), ...(fake ? { fake } : {}), ...(themeImage ? { themeImage } : {}) }),
      });
      if (themeImage) setThemeImage(null);
      if (r.status === 501) { setAvailable(false); opts.patch(id, { status: "failed", error: "No language model is configured on this Studio." }); return "unavailable"; }
      const d = await r.json().catch(() => null) as Record<string, unknown> | null;
      if (!r.ok || !d || d.ok === false) { opts.patch(id, { status: "failed", error: String(d?.error ?? `The copilot could not answer (${r.status}).`) }); return "handled"; }
      setAvailable(true);
      const reply = d.reply as CopilotReply | null;
      const review = d.review as SurveyReview | undefined;
      if (!reply) { opts.patch(id, { status: "empty", message: String(d.message ?? "No answer."), usage: d.usage as { charge: number }, ...(review ? { review } : {}) }); if (review) setSession((x) => ({ ...x, review: { rules: review, ai: [], at: new Date().toISOString(), running: false }, tab: "review" })); return review ? "handled" : "empty"; }
      const patch: Partial<CopilotEntry> = { status: "ready", reply, usage: d.usage as { charge: number }, context: d.context as CopilotEntry["context"], passages: (d.passages ?? {}) as Record<string, Passage>, ...(review ? { review } : {}) };
      if (reply.actions.length) {
        // a proposal — or a revision of the open one
        opts.patchAll((e) => (e.proposal === "open" ? { proposal: "superseded" } : null));
        setSession((x) => {
          const base = x.proposal ? (stale ? rebaseProposal(x.proposal, s.def) : x.proposal) : { base: s.def, steps: [] };
          const uxOnly = !!(d.context as { uxOnly?: boolean } | undefined)?.uxOnly;
          return { ...x, proposal: { base: base.base, steps: [...base.steps, { request: text, actions: reply.actions, ...(uxOnly ? { uxOnly } : {}) }] }, confirmed: false, tab: "changes" };
        });
        patch.proposal = "open";
      }
      if (review || reply.kind === "review") setSession((x) => ({ ...x, review: { rules: review ?? x.review?.rules ?? reviewSurvey(s.def), ai: reply.findings, at: new Date().toISOString(), running: false }, tab: reply.actions.length ? "changes" : "review" }));
      opts.patch(id, patch);
      return "handled";
    } catch (e) {
      opts.patch(id, { status: "failed", error: (e as Error).message });
      return "handled";
    } finally {
      setBusy(false);
    }
  }, [session.proposal, stale, s.def, s.surveyDbId, opts, copilotTurns, setSession, themeImage]);

  /* ------------------------------------------------------------ review */
  const runReview = React.useCallback(async (text = "Review my survey") => {
    // the engine's own checks at once, for free; the model's reading follows
    setSession((x) => ({ ...x, review: { rules: reviewSurvey(s.def), ai: x.review?.ai ?? [], at: new Date().toISOString(), running: available !== false }, tab: "review" }));
    if (available === false) return;
    await ask(text, undefined, "review");
    setSession((x) => (x.review ? { ...x, review: { ...x.review, running: false } } : x));
  }, [s.def, available, ask, setSession]);

  /** a mechanical fix from the review, previewed like any proposal — no model call */
  const previewFix = React.useCallback((actions: SurveyAction[], label: string) => {
    opts.patchAll((e) => (e.proposal === "open" ? { proposal: "superseded" } : null));
    setSession((x) => {
      const base = x.proposal ? (stale ? rebaseProposal(x.proposal, s.def) : x.proposal) : { base: s.def, steps: [] };
      return { ...x, proposal: { base: base.base, steps: [...base.steps, { request: label, actions }] }, confirmed: false, tab: "changes" };
    });
  }, [s.def, stale, setSession, opts]);

  /* ------------------------------------------------------------ apply / cancel / undo */
  const apply = React.useCallback((): { ok: boolean; reason?: string; message?: string } => {
    if (!session.proposal || !state) return { ok: false, reason: "There is nothing to apply." };
    if (s.readOnly) return { ok: false, reason: "This project is read-only right now." };
    if (stale) {
      // replay onto the survey as it is now, and ask again: the researcher approves what will actually happen
      setSession((x) => ({ ...x, proposal: x.proposal ? rebaseProposal(x.proposal, s.def) : null, confirmed: false }));
      return { ok: false, reason: "The survey changed since this was proposed. The proposal was replayed onto the current survey — review it again, then apply." };
    }
    if (state.diff.empty) return { ok: false, reason: "The proposal changes nothing that could be applied." };
    if (state.destructive.length && !session.confirmed) return { ok: false, reason: "Confirm the changes that remove or rewrite existing content first." };
    const n = session.history.length + 1;
    const request = session.proposal.steps.map((x) => x.request).join(" → ");
    const rec = changeRecord(n, request, state, session.proposal.base);
    s.labelNextEdit(rec.label);
    s.replace(state.after);
    setSession((x) => ({ ...x, proposal: null, confirmed: false, history: [...x.history, rec], tab: "history" }));
    const ux = state.diff.ux;
    // a question's default value and custom HTML are look-and-behaviour too
    const qBehaviour = state.diff.questionsModified.flatMap((m) => m.changes.filter((c) => c.field === "default value" || c.field === "custom HTML").map((c) => `${m.code} (${c.field})`));
    const targets = [...new Set([...(state.diff.theme.length ? ["the theme"] : []), ...[...ux.added, ...ux.changed, ...ux.removed].map((x) => x.target), ...qBehaviour])];
    const note = (!ux.empty || state.diff.theme.length > 0 || qBehaviour.length > 0) && state.structureUnchanged
      ? `Done. The look and behaviour of ${targets.slice(0, 3).join(", ")}${targets.length > 3 ? ` and ${targets.length - 3} more` : ""} ${targets.length === 1 ? "has" : "have"} been updated without changing the survey's questions, codes or logic.`
      : undefined;
    opts.patchAll((e) => (e.proposal === "open" || e.proposal === "superseded" ? { proposal: e.proposal === "open" ? "applied" : e.proposal, ...(e.proposal === "open" ? { changeN: n, ...(note ? { appliedNote: note } : {}) } : {}) } : null));
    void fetch("/api/copilot/record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: s.surveyDbId, n, request: request.slice(0, 500), summary: rec.summary.slice(0, 6).join("; "), created: rec.created, modified: rec.modified, removed: rec.removed }) }).catch(() => {});
    return { ok: true, ...(note ? { message: note } : {}) };
  }, [session, state, stale, s, setSession, opts]);

  const cancel = React.useCallback(() => {
    setSession((x) => ({ ...x, proposal: null, confirmed: false }));
    opts.patchAll((e) => (e.proposal === "open" || e.proposal === "superseded" ? { proposal: "cancelled" } : null));
  }, [setSession, opts]);

  /** undo one AI change: the store's own undo when it is still the last edit; otherwise restore its "before", said out loud */
  const revert = React.useCallback((n: number, force = false): { ok: boolean; reason?: string } => {
    const rec = session.history.find((h) => h.n === n);
    if (!rec || rec.reverted) return { ok: false, reason: "Nothing to undo." };
    if (s.readOnly) return { ok: false, reason: "This project is read-only right now." };
    if (s.undoLabel === rec.label && sameSurvey(s.def, rec.after)) s.undo();
    else {
      if (!force && !sameSurvey(s.def, rec.after)) return { ok: false, reason: `The survey has changed since AI change #${String(n).padStart(3, "0")}. Reverting it restores the survey to before that change, which also undoes the edits made after it.` };
      s.labelNextEdit(`Revert AI change #${String(n).padStart(3, "0")}`);
      s.replace(rec.before);
    }
    setSession((x) => ({ ...x, history: x.history.map((h) => (h.n === n ? { ...h, reverted: true } : h)) }));
    void fetch("/api/copilot/record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: s.surveyDbId, n, summary: rec.summary.slice(0, 3).join("; "), reverted: true }) }).catch(() => {});
    return { ok: true };
  }, [session.history, s, setSession]);

  /* ------------------------------------------------------------ research documents */
  const [uploading, setUploading] = React.useState(false);
  const [docError, setDocError] = React.useState<string | null>(null);
  const fakeDocRef = React.useRef<{ summary?: unknown; ocr?: string } | null>(null);
  React.useEffect(() => {
    const w = window as unknown as { __rescriptCopilotFakeDoc?: (x: { summary?: unknown; ocr?: string }) => void };
    w.__rescriptCopilotFakeDoc = (x) => { fakeDocRef.current = x; };
    return () => { delete w.__rescriptCopilotFakeDoc; };
  }, []);
  const refreshDocs = React.useCallback(async () => {
    const r = await fetch(`/api/copilot/documents?surveyId=${encodeURIComponent(s.surveyDbId)}`).catch(() => null);
    const d = r && r.ok ? await r.json().catch(() => null) as { documents?: ResearchDocView[]; durable?: boolean } | null : null;
    if (d?.documents) setSession((x) => ({ ...x, docs: d.documents!, durable: d.durable !== false }));
  }, [s.surveyDbId, setSession]);
  React.useEffect(() => { if (session.docs === null) void refreshDocs(); }, [session.docs, refreshDocs]);
  const uploadDocs = React.useCallback(async (files: File[]) => {
    if (!files.length) return;
    setUploading(true); setDocError(null);
    setSession((x) => ({ ...x, tab: "research" }));
    try {
      const form = new FormData();
      for (const f of files.slice(0, 5)) form.append("files", f, f.name);
      form.append("surveyId", s.surveyDbId);
      const fake = fakeDocRef.current; fakeDocRef.current = null;
      if (fake?.summary) form.append("fakeSummary", JSON.stringify(fake.summary));
      if (fake?.ocr) form.append("fakeOcr", fake.ocr);
      const r = await fetch("/api/copilot/documents", { method: "POST", body: form });
      const d = await r.json().catch(() => null) as { documents?: ResearchDocView[]; durable?: boolean; error?: string; added?: { name: string; error?: string }[] } | null;
      if (!r.ok || !d?.documents) { setDocError(d?.error ?? `The documents could not be added (${r.status}).`); return; }
      const failed = (d.added ?? []).filter((a) => a.error);
      if (failed.length) setDocError(failed.map((a) => `${a.name}: ${a.error}`).join(" "));
      setSession((x) => ({ ...x, docs: d.documents!, durable: d.durable !== false }));
    } catch (e) { setDocError((e as Error).message); } finally { setUploading(false); }
  }, [s.surveyDbId, setSession]);
  const deleteDoc = React.useCallback(async (id: string) => {
    await fetch(`/api/copilot/documents?surveyId=${encodeURIComponent(s.surveyDbId)}&id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    await refreshDocs();
  }, [s.surveyDbId, refreshDocs]);

  return {
    available, busy, state, stale, proposal: session.proposal, history: session.history, review: session.review,
    docs: session.docs ?? [], durable: session.durable, uploading, docError,
    confirmed: session.confirmed, setConfirmed: (v: boolean) => setSession((x) => ({ ...x, confirmed: v })),
    tab: session.tab, setTab: (t: PanelTab) => setSession((x) => ({ ...x, tab: t })),
    ask, runReview, previewFix, apply, cancel, revert, uploadDocs, deleteDoc, refreshDocs,
    themeImage, themeImageError, attachThemeImage, clearThemeImage: () => setThemeImage(null),
  };
}
export type Copilot = ReturnType<typeof useCopilot>;
