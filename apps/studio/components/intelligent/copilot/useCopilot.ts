"use client";
import React from "react";
import type { AnalysisRun } from "@rescript/analytics";
import type { SurveyDefinition } from "@rescript/schema";
import { reviewSurvey, describeAction, type SurveyAction, type SurveyReview, type Interpretation } from "@rescript/engine";
import { useStudio, uid } from "../../studio/store";
import type { CopilotReply, CopilotFinding } from "../../../lib/copilot/prompt";
import { evaluateProposal, rebaseProposal, sameSurvey, changeRecord, changeLabel, memoryFrom, type Proposal, type ProposalState, type ChangeRecord } from "../../../lib/copilot/client";
import {
  OpsRecorder, saveFailure, observeUndo, reapplyActions, sameSurveyCanonical,
  type NewOp, type OpUpdate, type SaveView, type Send,
} from "../../../lib/copilot/history";
import type { OpApiCall, OpFailed, OpIntent, OpProposed, OpSource } from "../../../lib/copilot/operations";
import { excludedLabels, validExclusions } from "../../../lib/copilot/review";
import { describeFailure, isTurnFailure, type FailureCode, type TurnFailure } from "@/lib/copilot/failure";
import type { ChangePlan } from "@/lib/copilot/changePlan";
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
 *
 * THE OPERATION HISTORY (Phase 5 — the audit's R11, R12, R21). Every turn
 * is recorded on the server as it happens (/api/copilot/operations): the
 * engine's readings, the model's turns with their calls and charge, the
 * review's fixes, the grammar's proposals (IntelligentView records those
 * through `recordOp` / `commitApplied`). A proposal is ONE record from its
 * first request to its Apply or Cancel — a revision folds into it — so the
 * history has one entry per change. Apply says only what is true, in order:
 * the store has it (APPLIED), the server numbered it (AI CHANGE #00n — the
 * survey's, not the page's), the save returned (SAVED, or NOT SAVED and
 * why, with a retry; the sandbox saves nothing and says so). The store's
 * own ⌘Z / ⌘⇧Z are watched: undoing an AI change marks it reverted, redoing
 * it marks it applied again.
 */

export interface Passage { doc: string; page: number; heading?: string; excerpt: string }
export interface CopilotEntry {
  id: string;
  kind: "copilot";
  text: string;
  heard?: HeardTranscript;
  status: "thinking" | "ready" | "failed" | "empty" | "plan";
  reply?: CopilotReply;
  /** the change plan the model proposed before building (Phase 2): read, ticked and approved here; `approved` once it was built */
  changePlan?: ChangePlan & { approved?: string[]; failures?: { id: string; failure: TurnFailure }[] };
  /** the research coverage of a generated survey, checked on the clone (Phase 3) */
  coverage?: { ok: boolean; summary: string; unmeasured: string[]; unconnected: string[]; hypotheses: { label: string; text: string; status: string }[] };
  /** a document the engine produced (Phase 5): its name, size and a link to it, what it holds, and what the narrative gate kept */
  output?: { name: string; size: number; url: string; kind: "docx" | "pptx"; summary: string; narrative?: string };
  /** a data question's answer, read on the respondent data (Phase 4): the base, the test behind it, the caveats */
  data?: { n: number; environment: string; dataset: string; source: "data" | "sandbox"; evidence?: { test: string; p: number | null; significant: boolean; effect?: { name: string; value: number } }; caveats: string[]; fromRun?: string };
  error?: string;
  message?: string;
  /** why a model turn failed — the cause and what to do next, never the grammar's "not understood" (Phase 1) */
  failure?: TurnFailure;
  /** what the engine read before handing the sentence to the model: its category, its reason, what it detected */
  handoff?: EngineHandoff;
  usage?: { charge: number };
  context?: { mode: string; researchUsed: boolean; passages: string[]; promptChars: number; outlineChars?: number; cached: boolean; ux?: boolean; uxOnly?: boolean; repair?: { refused: string[]; fixed: boolean } };
  passages?: Record<string, Passage>;
  /** this turn's place in the open proposal */
  proposal?: "open" | "superseded" | "applied" | "cancelled";
  changeN?: number;
  /** the operation-history entry this turn is recorded in (its number, its save state, its record errors) */
  opKey?: string;
  /** what the engine's checks found, for a review turn */
  review?: SurveyReview;
  /** said once the change is applied: what changed, and — for a look-only change — that the structure did not */
  appliedNote?: string;
  /**
   * Answered by the Studio's own engine — no model call. What it resolved
   * (the condition with its option label, the range, the target), the
   * answer's sections with navigable references, the precise refusal and the
   * suggested fix: everything the card shows instead of a model's reply.
   */
  engine?: EngineTurn;
}
export interface EngineHandoff {
  category: string | null;
  reason: string;
  detected: { what: string; value: string }[];
  /** what the engine can do without a model — a question with executable choices (Phase 2) */
  fallback?: { understood: string; question: string; choices: { label: string; text: string }[] };
}
export interface EngineTurn {
  kind: Interpretation["kind"];
  category: string | null;
  understood: string;
  detected: { what: string; value: string }[];
  sections?: { title: string; items: { label: string; key?: string; detail?: string }[] }[];
  choices?: { label: string; text: string }[];
  refusal?: string;
  suggestion?: { text: string; actions?: SurveyAction[] };
  warnings?: string[];
}
export interface ResearchDocView { id: string; ref: string; name: string; format: string; kind?: string; pages: number; ocrPages: number; chars: number; summary: import("../../../lib/copilot/research").DocSummary | null; warnings: string[]; createdAt: string }
export interface ReviewState { rules: SurveyReview; ai: CopilotFinding[]; at: string; running: boolean }
export type PanelTab = "changes" | "review" | "research" | "history" | "analysis" | "findings" | "languages" | "quotas" | "ux" | "inspector";
/** the stored analysis run, as the analytics route returns it (results are not stored — only findings, verdicts and each item's chart) */
export type StoredRunBrief = Pick<AnalysisRun, "computedAt" | "n" | "findings" | "verdicts" | "warnings" | "environment" | "trigger" | "corrections" | "advice" | "discoveries"> & { id?: string; items?: { definition: { name: string; kind: string; options?: Record<string, unknown> }; chart?: string; hypotheses: string[] }[] };

interface Session {
  proposal: Proposal | null;
  /** the history entry the open proposal is recorded in — revisions fold into it; Apply and Cancel close it */
  openOp: string | null;
  history: ChangeRecord[];
  review: ReviewState | null;
  docs: ResearchDocView[] | null;
  durable: boolean;
  confirmed: boolean;
  tab: PanelTab;
  /**
   * The proposal's actions the researcher unticked in the review, by FLAT
   * index (step by step, action by action). Kept with the proposal and reset
   * with it: a new step, a cancel or an apply starts again with everything
   * ticked — an index means nothing against a different chain.
   */
  excluded: number[];
}
const sessions = new Map<string, Session>();
let copilotKnown: boolean | null = null;

/* ------------------------------------------------------------ the operation history's recorder, per survey */

const recorders = new Map<string, OpsRecorder>();
/** each history entry's actions as proposed, for Reapply — kept on the page beside the record (which keeps them too, when small) */
const actionsByOp = new Map<string, SurveyAction[]>();
const SCOPE_KEY = "rescript.sandboxHistory";
let pageScope: string | null = null;
/**
 * The sandbox's history key: one per browser tab, kept in sessionStorage so
 * it survives a reload of that tab (the history is still there) while a new
 * tab — or a new browser — starts empty. Without storage, one per page.
 */
function sandboxScope(): string {
  const fresh = () => `t${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
  try {
    let k = window.sessionStorage.getItem(SCOPE_KEY);
    if (!k) { k = fresh(); window.sessionStorage.setItem(SCOPE_KEY, k); }
    return k;
  } catch { return (pageScope ??= fresh()); }
}
function recorderFor(surveyId: string): OpsRecorder {
  const known = recorders.get(surveyId);
  if (known) return known;
  const scope = surveyId === "sandbox" ? sandboxScope() : null;
  const send: Send = async (method, body, query) => {
    const r = method === "GET"
      ? await fetch(`/api/copilot/operations?${new URLSearchParams({ surveyId, ...(scope ? { scope } : {}), ...(query ?? {}) })}`, { cache: "no-store" })
      : await fetch("/api/copilot/operations", { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId, ...(scope ? { scope } : {}), ...body }) });
    return { status: r.status, data: await r.json().catch(() => null) as Record<string, unknown> | null };
  };
  const rec = new OpsRecorder(send);
  recorders.set(surveyId, rec);
  return rec;
}
const proposedOf = (actions: SurveyAction[]): OpProposed[] => actions.map((a) => ({ description: describeAction(a), action: a as unknown as Record<string, unknown> }));
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

export function useCopilot(opts: {
  entries: unknown[];
  push(e: CopilotEntry): void;
  patch(id: string, p: Partial<CopilotEntry> | ((e: CopilotEntry) => Partial<CopilotEntry>)): void;
  patchAll(fn: (e: CopilotEntry) => Partial<CopilotEntry> | null): void;
  selectedId: string | null;
}) {
  const s = useStudio();
  const key = s.surveyDbId;
  const [session, setSessionState] = React.useState<Session>(() => sessions.get(key) ?? { proposal: null, openOp: null, history: [], review: null, docs: null, durable: true, confirmed: false, tab: "inspector", excluded: [] });
  const setSession = React.useCallback((fn: (x: Session) => Session) => setSessionState((cur) => { const next = fn(cur); sessions.set(key, next); return next; }), [key]);

  /* ------------------------------------------------------------ the operation history */
  const recorder = React.useMemo(() => recorderFor(key), [key]);
  const [, bumpOps] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => recorder.subscribe(bumpOps), [recorder]);
  /* the survey's history as the server has it — earlier sessions, a reload, other editors — read once per page */
  React.useEffect(() => { if (!recorder.loaded) void recorder.refresh(); }, [recorder]);
  const sandbox = s.surveyDbId === "sandbox";

  /** record a turn that proposes nothing (an answer, a refusal, a question back, a failure) */
  const recordOp = React.useCallback((op: NewOp): string => recorder.create(op).key, [recorder]);
  const updateOp = React.useCallback((k: string, u: OpUpdate) => recorder.update(k, u), [recorder]);
  /**
   * Record actions proposed by a turn: into the open proposal's entry when
   * there is one (a revision is part of the same change — its words, its
   * targets, its model calls join it), else a new entry. Returns its key.
   */
  const recordProposal = React.useCallback((text: string, actions: SurveyAction[], meta: { source: OpSource; intent?: OpIntent; detected?: { what: string; value: string }[]; targets?: string[]; apiCalls?: OpApiCall[]; warnings?: string[] }, openKey: string | null): string => {
    const open = openKey ? recorder.get(openKey) : undefined;
    if (open && open.status === "proposed") {
      void recorder.update(open.key, {
        prompt: `${open.prompt} → ${text}`.slice(0, 4000), proposed: [...open.proposed, ...proposedOf(actions)],
        detected: [...open.detected, ...(meta.detected ?? [])], targets: union(open.targets, meta.targets ?? []),
        apiCalls: [...open.apiCalls, ...(meta.apiCalls ?? [])], warnings: union(open.warnings, meta.warnings ?? []),
      });
      actionsByOp.set(open.key, [...(actionsByOp.get(open.key) ?? []), ...actions]);
      return open.key;
    }
    const e = recorder.create({ prompt: text, source: meta.source, status: "proposed", intent: meta.intent, detected: meta.detected, targets: meta.targets, apiCalls: meta.apiCalls, warnings: meta.warnings, proposed: proposedOf(actions) });
    actionsByOp.set(e.key, [...actions]);
    return e.key;
  }, [recorder]);

  /**
   * The save after an Apply, said as it is: the sandbox stores nothing (the
   * record stays "applied", with that said); a real save that returned true
   * is "saved" with its revision; one that returned false is "save_failed"
   * with the store's reason — a conflict, the lock lost, signed out, an
   * error. Never "saved" before `flushDraft()` said so.
   */
  const settleSave = React.useCallback(async (k: string, ok: boolean): Promise<SaveView> => {
    const reverted = recorder.get(k)?.status === "reverted";
    let save: SaveView;
    if (ok && sandbox) {
      save = { state: "sandbox" };
      if (!reverted) void recorder.update(k, { statusDetail: "Sandbox — nothing is saved here; the change lives in this page only." });
    } else if (ok) {
      const revision = s.currentRevision();
      save = { state: "saved", revision };
      if (!reverted) void recorder.update(k, { status: "saved", savedRevision: revision, statusDetail: null });
    } else {
      const f = saveFailure(s.currentSaveState(), s.readOnly);
      save = { state: "failed", ...f };
      if (!reverted) void recorder.update(k, { status: "save_failed", statusDetail: `Not saved: ${f.message}` });
    }
    recorder.note(k, { save });
    return save;
  }, [recorder, sandbox, s]);

  /** the audit row of an AI change (or of its revert), with the server's number — a failure is said on the entry, not swallowed */
  const auditChange = React.useCallback(async (k: string, rec: ChangeRecord, reverted = false) => {
    const body = reverted
      ? { surveyId: s.surveyDbId, n: rec.n ?? undefined, summary: rec.summary.slice(0, 3).join("; "), reverted: true }
      : { surveyId: s.surveyDbId, n: rec.n ?? undefined, request: rec.request.slice(0, 500), summary: rec.summary.slice(0, 6).join("; "), created: rec.created, modified: rec.modified, removed: rec.removed, ...(rec.excluded?.length ? { excluded: rec.excluded } : {}) };
    try {
      const r = await fetch("/api/copilot/record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.ok) { recorder.note(k, { auditError: undefined }); return; }
      const d = await r.json().catch(() => null) as { error?: string } | null;
      recorder.note(k, { auditError: `not in the audit log: ${d?.error ?? `HTTP ${r.status}`}` });
    } catch (e) { recorder.note(k, { auditError: `not in the audit log: ${(e as Error).message || "the network request failed"}` }); }
  }, [recorder, s.surveyDbId]);

  /**
   * AN APPLIED CHANGE, RECORDED — after the store took it (the caller has
   * already called `replace` and read `currentDef()`): the save starts at
   * once; the record moves to `applied` with what was applied, left out and
   * refused, the engine operations, the targets and the surveys before and
   * after; the server's answer is the AI change number; the change joins
   * the page's history (Restore, ⌘Z watching); the audit row carries the
   * number; the save's outcome settles the record. `show` is told each step,
   * so the card says APPLIED · SAVING…, then the number, then the save.
   */
  const commitApplied = React.useCallback(async (k: string, x: { record: ChangeRecord; applied: string[]; excluded: string[]; failed: OpFailed[]; warnings: string[]; engineOps: string[]; targets: string[] }, show?: (n: number | null) => void, openHistory = true): Promise<{ n: number | null; save: SaveView }> => {
    const flushing = s.flushDraft();
    recorder.note(k, { save: { state: "saving" } });
    /* the record joins the history the moment the store took the change — what was created, modified and removed is the
       page's own reading and needs no server; the entry is undoable at once and never reads "Applied …" first and
       "Created …" a round-trip later. The server's number is patched in when it answers. */
    const draft: ChangeRecord = { ...x.record, n: null, key: k };
    setSession((h) => ({ ...h, history: h.history.some((r) => r.key === k) ? h.history.map((r) => (r.key === k ? draft : r)) : [...h.history, draft] }));
    const op = await recorder.update(k, { status: "applied", applied: x.applied, excluded: x.excluded, failed: x.failed, warnings: x.warnings, engineOps: x.engineOps, targets: x.targets, before: x.record.before, after: x.record.after });
    const n = op?.changeN ?? null;
    const record: ChangeRecord = { ...draft, n };
    setSession((h) => ({ ...h, history: h.history.map((r) => (r.key === k ? { ...r, n } : r)), ...(openHistory ? { tab: "history" as const } : {}) }));
    show?.(n);
    void auditChange(k, record);
    const ok = await flushing.catch(() => false);
    const save = await settleSave(k, ok);
    void recorder.settled(k).then(() => recorder.refresh());
    return { n, save };
  }, [recorder, s, setSession, auditChange, settleSave]);

  /** "Try saving again" — the store's flush, and the record moved to what it returned */
  const retrySave = React.useCallback(async (k: string): Promise<SaveView> => {
    recorder.note(k, { save: { state: "saving" } });
    const ok = await s.flushDraft().catch(() => false);
    return settleSave(k, ok);
  }, [recorder, s, settleSave]);

  /*
   * THE STORE'S ⌘Z AND ⌘⇧Z, WATCHED (the audit's R21). An undo that takes
   * the survey back to an AI change's `before` reverts that change in the
   * history; a redo back to its `after` applies it again. The surveys are
   * the store's own (read after `replace`), so identity usually answers.
   */
  React.useEffect(() => {
    const changes = session.history.filter((h) => h.key).map((h) => ({ key: h.key!, before: h.before, after: h.after, reverted: h.reverted }));
    if (!changes.length) return;
    const hit = observeUndo(changes, s.def, sameSurvey);
    if (!hit) return;
    setSession((x) => ({ ...x, history: x.history.map((h) => (h.key === hit.key ? { ...h, reverted: hit.to === "reverted" } : h)) }));
    void recorder.update(hit.key, hit.to === "reverted" ? { status: "reverted", statusDetail: "undone with ⌘Z" } : { status: "applied", statusDetail: "redone with ⌘⇧Z" });
  }, [s.def, session.history, recorder, setSession]);
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
    // a sentence the engine answered never reached the model: the suite drops the reply it had queued for it
    (w as { __rescriptCopilotFakeReset?: () => void }).__rescriptCopilotFakeReset = () => { fakeRef.current = []; };
    return () => { delete w.__rescriptCopilotFake; delete (w as { __rescriptCopilotFakeReset?: () => void }).__rescriptCopilotFakeReset; };
  }, []);

  /*
   * The open proposal, evaluated against the survey as it is now — twice
   * when something is unticked: `full` is every action (what the review
   * lists, so an unticked row stays visible to be ticked again; what a
   * revision is written against), `state` is the included actions only
   * (what Apply writes, what the destructive confirmation and the warnings
   * are about). With nothing unticked they are the same object.
   */
  const excluded = React.useMemo(() => (session.proposal ? validExclusions(session.proposal, session.excluded ?? []) : []), [session.proposal, session.excluded]);
  const full: ProposalState | null = React.useMemo(() => (session.proposal ? evaluateProposal(session.proposal) : null), [session.proposal]);
  const state: ProposalState | null = React.useMemo(() => (session.proposal && excluded.length ? evaluateProposal(session.proposal, { excluded }) : full), [session.proposal, excluded, full]);
  const stale = !!session.proposal && !sameSurvey(session.proposal.base, s.def);

  const copilotTurns = (opts.entries as CopilotEntry[]).filter((e) => (e as { kind?: string }).kind === "copilot");

  /* ------------------------------------------------------------ ask */
  /** "empty": the model's answer had nothing usable — the caller may fall back to the grammar */
  /*
   * THE QUOTA COUNTS — the live `quota_counts` of this survey, read through
   * the same route the Quota dashboard uses, kept here so the copilot's
   * fieldwork advice (the Quotas tab, and the model on a quota turn) reads
   * the real numbers. The sandbox has none.
   */
  const [quotaCounts, setQuotaCounts] = React.useState<Record<string, Record<string, number>> | null>(null);
  const [quotaCountsAt, setQuotaCountsAt] = React.useState<string | null>(null);
  const refreshQuotaCounts = React.useCallback(async () => {
    if (s.surveyDbId === "sandbox") return;
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/quotas?environment=LIVE`, { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json() as { counts?: Record<string, Record<string, number>>; fetchedAt?: string };
      if (d.counts) { setQuotaCounts(d.counts); setQuotaCountsAt(d.fetchedAt ?? new Date().toISOString()); }
    } catch { /* offline: the advice says there are no counts */ }
  }, [s.surveyDbId]);
  React.useEffect(() => { if (s.def.quotas.length) void refreshQuotaCounts(); }, [refreshQuotaCounts, s.def.quotas.length]);
  /* a test seam: the browser suites hand the counts in, since the sandbox has no database */
  React.useEffect(() => {
    const w = window as unknown as { __rescriptQuotaCounts?: (c: Record<string, Record<string, number>>) => void };
    w.__rescriptQuotaCounts = (c) => { setQuotaCounts(c); setQuotaCountsAt(new Date().toISOString()); };
    return () => { delete w.__rescriptQuotaCounts; };
  }, []);

  /*
   * THE ANALYSIS RUN — the plan executed on the responses (findings with
   * their evidence, the hypothesis verdicts), read from the analytics
   * route's latest run so the Findings tab and the model's answers about
   * "what did we find?" rest on numbers the Studio computed. The sandbox has
   * none; the browser suites hand one in through the seam.
   */
  const [analysisRun, setAnalysisRun] = React.useState<StoredRunBrief | null>(null);
  const [runDue, setRunDue] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const [runError, setRunError] = React.useState<string | null>(null);
  const refreshAnalysisRun = React.useCallback(async () => {
    if (s.surveyDbId === "sandbox") return;
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/analytics/plan/latest`, { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json() as { run?: StoredRunBrief | null; due?: string | null };
      setAnalysisRun(d.run ?? null); setRunDue(d.due ?? null);
    } catch { /* offline: the tab says there is no run */ }
  }, [s.surveyDbId]);
  React.useEffect(() => { if (s.def.research?.analysisPlan) void refreshAnalysisRun(); }, [refreshAnalysisRun, !!s.def.research?.analysisPlan]); // eslint-disable-line react-hooks/exhaustive-deps
  const runPlanNow = React.useCallback(async (trigger = "manual"): Promise<boolean> => {
    if (s.surveyDbId === "sandbox") { setRunError("The sandbox has no responses to analyse — open a saved survey with completes."); return false; }
    setRunning(true); setRunError(null);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/analytics/plan/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ environment: "LIVE", trigger }) });
      const d = await r.json().catch(() => null) as { run?: StoredRunBrief; error?: string } | null;
      if (!r.ok || !d?.run) { setRunError(d?.error ?? `The plan could not be run (${r.status}).`); return false; }
      setAnalysisRun(d.run); setRunDue(null);
      return true;
    } catch (e) { setRunError((e as Error).message); return false; }
    finally { setRunning(false); }
  }, [s.surveyDbId]);
  /* the findings report, drafted from the latest run into Analytics → Reports */
  const [lastReport, setLastReport] = React.useState<{ id: string; name: string } | null>(null);
  const [drafting, setDrafting] = React.useState(false);
  const draftReport = React.useCallback(async (): Promise<{ id: string; name: string } | null> => {
    if (s.surveyDbId === "sandbox") { setRunError("The sandbox has no responses, so there is no run to report on."); return null; }
    setDrafting(true); setRunError(null);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/analytics/plan/report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(analysisRun?.id ? { runId: analysisRun.id } : {}) }) });
      const d = await r.json().catch(() => null) as { report?: { id: string; name: string }; error?: string } | null;
      if (!r.ok || !d?.report) { setRunError(d?.error ?? `The report could not be drafted (${r.status}).`); return null; }
      setLastReport({ id: d.report.id, name: d.report.name });
      return d.report;
    } catch (e) { setRunError((e as Error).message); return null; }
    finally { setDrafting(false); }
  }, [s.surveyDbId, analysisRun?.id]);
  React.useEffect(() => {
    const w = window as unknown as { __rescriptAnalysisRun?: (r: StoredRunBrief | null) => void };
    w.__rescriptAnalysisRun = (r) => { setAnalysisRun(r); };
    return () => { delete w.__rescriptAnalysisRun; };
  }, []);
  /** what travels with a turn: the verdicts and the strongest findings, never the results */
  const runForTurn = React.useMemo(() => (analysisRun ? { computedAt: analysisRun.computedAt, n: analysisRun.n, trigger: analysisRun.trigger, environment: analysisRun.environment, verdicts: analysisRun.verdicts, warnings: analysisRun.warnings.slice(0, 6), findings: analysisRun.findings.slice(0, 40),
    /* Phase 4: the correction, the data advice and the discoveries travel too, so a narration can say what holds and what the run found beyond the plan */
    ...(analysisRun.corrections ? { corrections: analysisRun.corrections } : {}), ...(analysisRun.advice ? { advice: analysisRun.advice.slice(0, 8) } : {}),
    ...(analysisRun.discoveries ? { discoveries: { ...analysisRun.discoveries, segments: analysisRun.discoveries.segments.slice(0, 8), trends: analysisRun.discoveries.trends.slice(0, 6), anomalies: analysisRun.discoveries.anomalies.slice(0, 8) } } : {}) } : null), [analysisRun]);

  /*
   * PLAN FIRST (Phase 2). A generation is planned before it is built: the
   * route returns a change plan, the card shows it, and only the approved
   * items are built — one call each. Off, the single-reply turn runs as
   * before. The preference is the researcher's, kept in this browser.
   */
  const [planFirst, setPlanFirstState] = React.useState<boolean>(() => { try { return window.localStorage.getItem("rescript.copilot.planFirst") !== "off"; } catch { return true; } });
  const setPlanFirst = React.useCallback((v: boolean) => { setPlanFirstState(v); try { window.localStorage.setItem("rescript.copilot.planFirst", v ? "on" : "off"); } catch { /* a private window */ } }, []);

  const run = React.useCallback(async (id: string, text: string, mode: "review" | "generate" | undefined, extra: Record<string, unknown>): Promise<"handled" | "unavailable" | "empty"> => {
    setBusy(true);
    try {
      const proposal = session.proposal;
      const working: SurveyDefinition = proposal ? (stale ? evaluateProposal(rebaseProposal(proposal, s.def)).after : evaluateProposal(proposal).after) : s.def;
      const fake = fakeRef.current.shift();
      const r = await fetch("/api/copilot/turn", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ surveyId: s.surveyDbId, message: text, definition: working, selectedId: opts.selectedId, memory: memoryFrom(copilotTurns.map((t) => ({ user: t.text, reply: t.reply }))), ...(mode ? { mode } : {}), ...(fake ? { fake } : {}), ...(themeImage ? { themeImage } : {}), ...(quotaCounts ? { quotaCounts } : {}), ...(runForTurn ? { analysisRun: runForTurn } : {}), planFirst, ...extra }),
      });
      if (themeImage) setThemeImage(null);
      /* every model turn is in the history with the call it made and what it cost — a failed one too */
      const call = (d: Record<string, unknown> | null, error?: string): OpApiCall => {
        const ctx = (d?.context ?? {}) as { mode?: string; cached?: boolean; promptChars?: number };
        return { route: "/api/copilot/turn", mode: ctx.mode ?? mode ?? "", charge: Number((d?.usage as { charge?: number } | undefined)?.charge) || 0, ...(typeof ctx.cached === "boolean" ? { cached: ctx.cached } : {}), ...(typeof ctx.promptChars === "number" ? { promptChars: ctx.promptChars } : {}), ...(error ? { error } : {}) };
      };
      const failedTurn = (d: Record<string, unknown> | null, error: string) => opts.patch(id, { opKey: recordOp({ prompt: text, source: "model", status: "failed", intent: { mode: mode ?? "" }, statusDetail: error, apiCalls: [call(d, error)] }) });
      /*
       * A FAILED TURN SAYS WHY (Phase 1). The route names the cause — not
       * configured, the wallet, a timeout, a refusal, an answer cut off or in
       * words — and the card shows it with what to do next, beside what the
       * engine had already read. None of these is replaced by the grammar's
       * "I did not understand" any more, which only ever hid the real cause;
       * the one case that still reaches the grammar is a well-formed answer
       * with nothing in it ("empty"), where a phrasing the grammar parses is
       * offered instead of the failed turn.
       */
      const failTurn = (d: Record<string, unknown> | null, status: number, fallback: FailureCode) => {
        const failure = isTurnFailure(d?.failure) ? d.failure : describeFailure(fallback, String(d?.error ?? "").slice(0, 200) || undefined);
        const error = `${failure.message}`;
        opts.patch(id, { status: "failed", error, failure, usage: d?.usage as { charge: number } | undefined, context: d?.context as CopilotEntry["context"] });
        failedTurn(d, `${failure.title}: ${failure.message}`);
        void status;
      };
      if (r.status === 501) { setAvailable(false); const d = await r.json().catch(() => null) as Record<string, unknown> | null; failTurn(d, 501, "not_configured"); return "unavailable"; }
      const d = await r.json().catch(() => null) as Record<string, unknown> | null;
      if (!r.ok || !d || d.ok === false) { failTurn(d, r.status, r.status === 402 || r.status === 423 ? "wallet" : "provider"); return "handled"; }
      setAvailable(true);
      if (d.stage === "plan" && d.plan) {
        // the change plan: read and approved before anything is built
        const plan = d.plan as ChangePlan;
        opts.patch(id, { status: "plan", changePlan: plan, usage: d.usage as { charge: number }, context: d.context as CopilotEntry["context"], opKey: recordOp({ prompt: text, source: "model", status: "clarify", intent: { mode: String((d.context as { mode?: string } | undefined)?.mode ?? mode ?? ""), kind: "plan" }, statusDetail: `Change plan: ${plan.items.map((i) => i.title).join("; ")}`.slice(0, 2000), apiCalls: [call(d)] }) });
        return "handled";
      }
      const reply = d.reply as CopilotReply | null;
      const review = d.review as SurveyReview | undefined;
      if (!reply) {
        if (review) {
          // the model had nothing, the engine's own review stands: shown as the answer
          const message = String(d.message ?? "No answer.");
          opts.patch(id, { status: "empty", message, usage: d.usage as { charge: number }, review, opKey: recordOp({ prompt: text, source: "model", status: "answered", intent: { mode: String((d.context as { mode?: string } | undefined)?.mode ?? mode ?? ""), kind: "empty" }, statusDetail: message, apiCalls: [call(d)] }) });
          setSession((x) => ({ ...x, review: { rules: review, ai: [], at: new Date().toISOString(), running: false }, tab: "review" }));
          return "handled";
        }
        // nothing usable: the turn fails with its cause — and the grammar may still read the sentence (a phrasing the engine's
        // recognisers handed on but the grammar parses, "call Q2 PLATFORMS"); the view then shows that reading instead
        failTurn(d, 200, "unusable");
        return "empty";
      }
      const patch: Partial<CopilotEntry> = { status: "ready", reply, usage: d.usage as { charge: number }, context: d.context as CopilotEntry["context"], passages: (d.passages ?? {}) as Record<string, Passage>, ...(review ? { review } : {}) };
      if (d.coverage && typeof d.coverage === "object") patch.coverage = d.coverage as CopilotEntry["coverage"];
      if (d.stage === "executed" && d.plan) {
        const built = d.plan as ChangePlan;
        patch.changePlan = { ...built, approved: built.items.map((i) => i.id), ...(Array.isArray(d.planFailures) ? { failures: d.planFailures as { id: string; failure: TurnFailure }[] } : {}) };
      }
      const intent: OpIntent = { mode: String((d.context as { mode?: string } | undefined)?.mode ?? mode ?? ""), kind: reply.kind };
      const failed = reply.rejected.map((x) => ({ description: "an action the model wrote", reason: x.reason ?? "not in a shape the Studio accepts" }));
      if (reply.actions.length) patch.opKey = recordProposal(text, reply.actions, { source: "model", intent, apiCalls: [call(d)], warnings: failed.map((f) => `Dropped: ${f.reason}`) }, session.openOp);
      else patch.opKey = recordOp({ prompt: text, source: "model", status: reply.kind === "clarify" ? "clarify" : "answered", intent, apiCalls: [call(d)], failed, statusDetail: reply.reply.slice(0, 2000) });
      if (reply.actions.length) {
        // a proposal — or a revision of the open one
        opts.patchAll((e) => (e.proposal === "open" ? { proposal: "superseded" } : null));
        setSession((x) => {
          const base = x.proposal ? (stale ? rebaseProposal(x.proposal, s.def) : x.proposal) : { base: s.def, steps: [] };
          const uxOnly = !!(d.context as { uxOnly?: boolean } | undefined)?.uxOnly;
          return { ...x, proposal: { base: base.base, steps: [...base.steps, { request: text, actions: reply.actions, ...(uxOnly ? { uxOnly } : {}) }] }, openOp: patch.opKey ?? x.openOp, confirmed: false, excluded: [], tab: "changes" };
        });
        patch.proposal = "open";
      }
      if (review || reply.kind === "review") setSession((x) => ({ ...x, review: { rules: review ?? x.review?.rules ?? reviewSurvey(s.def), ai: reply.findings, at: new Date().toISOString(), running: false }, tab: reply.actions.length ? "changes" : "review" }));
      opts.patch(id, patch);
      return "handled";
    } catch (e) {
      const error = (e as Error).message;
      opts.patch(id, { status: "failed", error, opKey: recordOp({ prompt: text, source: "model", status: "failed", intent: { mode: mode ?? "" }, statusDetail: error, apiCalls: [{ route: "/api/copilot/turn", mode: mode ?? "", charge: 0, error }] }) });
      return "handled";
    } finally {
      setBusy(false);
    }
  }, [session.proposal, session.openOp, stale, s.def, s.surveyDbId, opts, copilotTurns, setSession, themeImage, quotaCounts, runForTurn, recordOp, recordProposal, planFirst]);

  const ask = React.useCallback(async (text: string, heard?: HeardTranscript, mode?: "review" | "generate", handoff?: EngineHandoff): Promise<"handled" | "unavailable" | "empty"> => {
    const id = uid("copilot");
    opts.push({ id, kind: "copilot", text, ...(heard ? { heard } : {}), ...(handoff ? { handoff } : {}), status: "thinking" });
    return run(id, text, mode, {});
  }, [opts, run]);

  /** the approved items of a change plan, built one call each into one proposal on the same card */
  const executePlan = React.useCallback(async (entryId: string, items: string[]): Promise<void> => {
    const entry = copilotTurns.find((t) => t.id === entryId);
    if (!entry?.changePlan || entry.status !== "plan" || !items.length) return;
    const mode = (entry.context?.mode === "generate" ? "generate" : undefined) as "generate" | undefined;
    opts.patch(entryId, { status: "thinking", changePlan: { ...entry.changePlan, approved: items } });
    await run(entryId, entry.text, mode, { stage: "execute", plan: entry.changePlan, items });
  }, [copilotTurns, opts, run]);

  /** a change plan the researcher does not want: the card says so, nothing was built or charged beyond the plan */
  const cancelPlan = React.useCallback((entryId: string) => {
    const entry = copilotTurns.find((t) => t.id === entryId);
    if (!entry || entry.status !== "plan") return;
    opts.patch(entryId, { status: "empty", message: "Plan set aside — nothing was built." });
    if (entry.opKey) updateOp(entry.opKey, { status: "cancelled" });
  }, [copilotTurns, opts, updateOp]);

  /*
   * THE ENGINE'S OWN ANSWER. A sentence the engine interpreted
   * deterministically — an edit as actions, a question about the survey as
   * an answer, an ambiguity as a choice, an impossibility as a precise
   * refusal — becomes a turn here without a network call. Actions join the
   * open proposal exactly as a model's would: the same Changes panel, the
   * same Apply, the same history and undo. Nothing is charged.
   */
  const local = React.useCallback((text: string, it: Exclude<Interpretation, { kind: "model" }>, heard?: HeardTranscript): void => {
    const id = uid("copilot");
    const actions = it.kind === "actions" ? it.actions : [];
    const reply: CopilotReply = {
      kind: it.kind === "actions" ? "proposal" : it.kind === "clarify" ? "clarify" : "answer",
      reply: it.kind === "answer" ? it.answer : it.kind === "clarify" ? it.question : it.kind === "refused" ? it.reason : it.understood,
      plan: [], actions, rejected: [], findings: [], assumptions: [], questions: [], sources: [],
    };
    const engine: EngineTurn = {
      kind: it.kind, category: it.category, understood: it.understood, detected: it.detected,
      ...(it.kind === "answer" ? { sections: it.sections } : {}),
      ...(it.kind === "clarify" ? { choices: it.choices } : {}),
      ...(it.kind === "refused" ? { refusal: it.reason, ...(it.suggestion ? { suggestion: it.suggestion } : {}) } : {}),
      ...(it.kind === "actions" && it.warnings?.length ? { warnings: it.warnings } : {}),
    };
    /* recorded: an engine reading costs nothing, and the history says so (no model calls) */
    const intent: OpIntent = { category: it.category ?? null, kind: it.kind };
    const opKey = actions.length
      ? recordProposal(text, actions, { source: "engine", intent, detected: it.detected, targets: it.kind === "actions" ? it.targets : [], warnings: it.kind === "actions" ? it.warnings : undefined }, session.openOp)
      : recordOp({ prompt: text, source: "engine", status: it.kind === "answer" ? "answered" : it.kind === "clarify" ? "clarify" : "refused", intent, detected: it.detected, statusDetail: (it.kind === "answer" ? it.answer : it.kind === "clarify" ? it.question : it.kind === "refused" ? it.reason : it.understood).slice(0, 2000), ...(it.kind === "refused" && it.suggestion?.actions?.length ? { proposed: proposedOf(it.suggestion.actions) } : {}) });
    if (actions.length) {
      opts.patchAll((e) => (e.proposal === "open" ? { proposal: "superseded" } : null));
      setSession((x) => {
        const base = x.proposal ? (stale ? rebaseProposal(x.proposal, s.def) : x.proposal) : { base: s.def, steps: [] };
        return { ...x, proposal: { base: base.base, steps: [...base.steps, { request: text, actions }] }, openOp: opKey, confirmed: false, excluded: [], tab: "changes" };
      });
    }
    opts.push({ id, kind: "copilot", text, ...(heard ? { heard } : {}), status: "ready", reply, engine, opKey, ...(actions.length ? { proposal: "open" as const } : {}) });
  }, [opts, setSession, stale, s.def, session.openOp, recordOp, recordProposal]);
  /*
   * A DATA QUESTION (Phase 4). The engine read the sentence into a query;
   * the answer is on the respondent data, which only the server holds, so
   * the card asks the ask route — no model — and shows the numbers, the
   * test and the base. The sandbox has no respondents: its question is
   * answered from rows a test put on the page, or said to be unanswerable.
   * A planned finding on the same pair, from the last run, is shown too.
   */
  const rowsRef = React.useRef<unknown[] | null>(null);
  React.useEffect(() => {
    const w = window as unknown as { __rescriptAnalyticsRows?: (rows: unknown[] | null) => void };
    w.__rescriptAnalyticsRows = (rows) => { rowsRef.current = rows; };
    return () => { delete w.__rescriptAnalyticsRows; };
  }, []);
  const askData = React.useCallback(async (text: string, it: Extract<Interpretation, { kind: "query" }>, heard?: HeardTranscript): Promise<void> => {
    const id = uid("copilot");
    const engine: EngineTurn = { kind: "query", category: it.category, understood: it.understood, detected: it.detected };
    opts.push({ id, kind: "copilot", text, ...(heard ? { heard } : {}), status: "thinking", reply: { kind: "answer", reply: it.understood, plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] }, engine });
    setBusy(true);
    const fail = (message: string) => {
      opts.patch(id, { status: "ready", reply: { kind: "answer", reply: message, plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] }, engine: { ...engine, kind: "refused", refusal: message }, opKey: recordOp({ prompt: text, source: "engine", status: "refused", intent: { category: it.category, kind: "query" }, detected: it.detected, statusDetail: message.slice(0, 2000) }) });
    };
    try {
      const sandbox = s.surveyDbId === "sandbox";
      const rows = sandbox ? rowsRef.current : null;
      if (sandbox && !rows?.length) { fail("The sandbox has no respondents to read. Open a survey with fieldwork and ask there — the answer comes from its data, with the base and the test."); return; }
      const r = await fetch("/api/copilot/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: s.surveyDbId, query: it.query, ...(sandbox ? { definition: s.def, rows } : {}) }) });
      const d = await r.json().catch(() => null) as { answer?: { text: string; sections: { title: string; items: { label: string; detail?: string }[] }[]; n: number; evidence?: NonNullable<CopilotEntry["data"]>["evidence"]; caveats: string[] }; n?: number; environment?: string; dataset?: string; source?: "data" | "sandbox"; error?: string } | null;
      if (!r.ok || !d?.answer) { fail(d?.error ?? (r.status === 401 ? "Sign in to read this survey's data." : `The data could not be read (HTTP ${r.status}).`)); return; }
      const a = d.answer;
      // the planned finding on the same variables, from the last run, beside the live answer
      const pair = [it.query.variable, ...(it.query.by ?? [])];
      const fromRun = analysisRun?.findings.find((f) => f.variables.length >= 1 && pair.every((v) => f.variables.includes(v)) && (pair.length === 1 || f.variables.length === pair.length));
      const data: CopilotEntry["data"] = { n: a.n, environment: d.environment ?? "LIVE", dataset: d.dataset ?? "clean", source: d.source ?? "data", ...(a.evidence ? { evidence: a.evidence } : {}), caveats: a.caveats, ...(fromRun ? { fromRun: `${fromRun.headline} (run of ${analysisRun!.computedAt.slice(0, 10)})` } : {}) };
      opts.patch(id, { status: "ready", data, reply: { kind: "answer", reply: a.text, plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] }, engine: { ...engine, kind: "answer", sections: a.sections }, opKey: recordOp({ prompt: text, source: "engine", status: "answered", intent: { category: it.category, kind: "query" }, detected: it.detected, statusDetail: a.text.slice(0, 2000), apiCalls: [{ route: "/api/copilot/ask", mode: "data", charge: 0 }] }) });
    } catch (e) {
      fail(`The data could not be read: ${(e as Error).message || "the network request failed"}.`);
    } finally { setBusy(false); }
  }, [opts, s.surveyDbId, s.def, recordOp, analysisRun]);
  /*
   * A DOCUMENT TO PRODUCE (Phase 5). The engine read the sentence into an
   * output request; the output route makes the file — the proposal from the
   * design, the findings report or deck from a fresh run on the data, with
   * the model's narrative through the gate when a model is there. The card
   * holds the file for download and says what it contains and what the
   * gate kept. The sandbox makes the proposal from its own definition and
   * the findings outputs from rows a test put on the page.
   */
  const makeOutput = React.useCallback(async (text: string, it: Extract<Interpretation, { kind: "output" }>, heard?: HeardTranscript): Promise<void> => {
    const id = uid("copilot");
    const engine: EngineTurn = { kind: "output", category: it.category, understood: it.understood, detected: it.detected };
    const reply = (r: string): CopilotReply => ({ kind: "answer", reply: r, plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] });
    opts.push({ id, kind: "copilot", text, ...(heard ? { heard } : {}), status: "thinking", reply: reply(it.understood), engine });
    setBusy(true);
    const fail = (message: string) => opts.patch(id, { status: "ready", reply: reply(message), engine: { ...engine, kind: "refused", refusal: message }, opKey: recordOp({ prompt: text, source: "engine", status: "refused", intent: { category: it.category, kind: "output" }, detected: it.detected, statusDetail: message.slice(0, 2000) }) });
    try {
      const sandbox = s.surveyDbId === "sandbox";
      const rows = sandbox ? rowsRef.current : null;
      if (sandbox && it.output.type !== "proposal_docx" && !rows?.length) { fail("The sandbox has no respondents to report on. Open a survey with fieldwork and ask there — the report and the deck come from a run of its data."); return; }
      const fake = sandbox ? fakeRef.current.shift() : undefined;
      const r = await fetch("/api/copilot/output", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: s.surveyDbId, output: it.output, ...(sandbox ? { definition: s.def, rows, ...(fake ? { fake } : {}) } : {}) }) });
      if (!r.ok) { const d = await r.json().catch(() => null) as { error?: string } | null; fail(d?.error ?? (r.status === 401 ? "Sign in to produce documents for this survey." : `The document could not be produced (HTTP ${r.status}).`)); return; }
      const blob = await r.blob();
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? `output.${it.output.type.endsWith("pptx") ? "pptx" : "docx"}`;
      const summary = r.headers.get("x-rescript-output") ?? "";
      const narrative = r.headers.get("x-rescript-narrative") ?? undefined;
      const url = URL.createObjectURL(blob);
      const output: NonNullable<CopilotEntry["output"]> = { name, size: blob.size, url, kind: name.endsWith(".pptx") ? "pptx" : "docx", summary, ...(narrative ? { narrative } : {}) };
      const said = `${it.output.words[0].toUpperCase()}${it.output.words.slice(1)} is ready: ${name} (${Math.round(blob.size / 1024)} KB). ${summary}${narrative ? ` Narrative gate: ${narrative}.` : ""}`;
      opts.patch(id, { status: "ready", output, reply: reply(said), engine: { ...engine, kind: "answer" }, opKey: recordOp({ prompt: text, source: "engine", status: "answered", intent: { category: it.category, kind: "output" }, detected: it.detected, statusDetail: said.slice(0, 2000), apiCalls: [{ route: "/api/copilot/output", mode: it.output.type, charge: 0 }] }) });
    } catch (e) {
      fail(`The document could not be produced: ${(e as Error).message || "the network request failed"}.`);
    } finally { setBusy(false); }
  }, [opts, s.surveyDbId, s.def, recordOp]);
  /** the survey a new request is read against: the open proposal's result, so a revision builds on what is proposed */
  const working: SurveyDefinition = React.useMemo(() => (session.proposal ? (stale ? evaluateProposal(rebaseProposal(session.proposal, s.def)).after : full?.after ?? s.def) : s.def), [session.proposal, stale, full, s.def]);

  /* ------------------------------------------------------------ review */
  const runReview = React.useCallback(async (text = "Review my survey") => {
    // the engine's own checks at once, for free; the model's reading follows
    setSession((x) => ({ ...x, review: { rules: reviewSurvey(s.def), ai: x.review?.ai ?? [], at: new Date().toISOString(), running: available !== false }, tab: "review" }));
    if (available === false) return;
    await ask(text, undefined, "review");
    setSession((x) => (x.review ? { ...x, review: { ...x.review, running: false } } : x));
  }, [s.def, available, ask, setSession]);

  /** a mechanical fix from the review (or a Reapply from History), previewed like any proposal — no model call; recorded as a "fix" */
  const previewFix = React.useCallback((actions: SurveyAction[], label: string, meta?: { intent?: OpIntent }) => {
    const opKey = recordProposal(label, actions, { source: "fix", intent: meta?.intent ?? { kind: "fix" } }, session.openOp);
    opts.patchAll((e) => (e.proposal === "open" ? { proposal: "superseded" } : null));
    setSession((x) => {
      const base = x.proposal ? (stale ? rebaseProposal(x.proposal, s.def) : x.proposal) : { base: s.def, steps: [] };
      return { ...x, proposal: { base: base.base, steps: [...base.steps, { request: label, actions }] }, openOp: opKey, confirmed: false, excluded: [], tab: "changes" };
    });
  }, [s.def, stale, setSession, opts, recordProposal, session.openOp]);

  /* ------------------------------------------------------------ apply / cancel / undo */
  /**
   * APPLY — and say only what is true. The checks first (read-only, a
   * survey changed underneath, nothing left, an unconfirmed removal); then
   * one labelled `replace`. Only once the store HOLDS the change does the
   * card say APPLIED; the server's number and the save's outcome follow
   * (`commitApplied`), and the returned promise resolves with both — the
   * caller's toast says "saved" only when the save said so.
   */
  const apply = React.useCallback(async (show?: (n: number | null) => void): Promise<{ ok: boolean; reason?: string; message?: string; n?: number | null; save?: SaveView }> => {
    if (!session.proposal || !state) return { ok: false, reason: "There is nothing to apply." };
    if (s.readOnly) return { ok: false, reason: "This project is read-only right now." };
    if (stale) {
      // replay onto the survey as it is now, and ask again: the researcher approves what will actually happen
      setSession((x) => ({ ...x, proposal: x.proposal ? rebaseProposal(x.proposal, s.def) : null, confirmed: false }));
      return { ok: false, reason: "The survey changed since this was proposed. The proposal was replayed onto the current survey — review it again, then apply." };
    }
    if (state.diff.empty) return { ok: false, reason: excluded.length ? "Every change is excluded — tick at least one to apply." : "The proposal changes nothing that could be applied." };
    if (state.destructive.length && !session.confirmed) return { ok: false, reason: "Confirm the changes that remove or rewrite existing content first." };
    const proposal = session.proposal;
    const request = proposal.steps.map((x) => x.request).join(" → ");
    // what was left out is part of the record: "applied 7 of 9 — excluded: Removed option 99 from Q5"
    const left = excluded.length && full ? excludedLabels(proposal, full, excluded) : [];
    /* the number is the server's and comes after the write; the undo label names the change without it */
    const draft = changeRecord(null, request, state, proposal.base, undefined, left);
    const before = s.currentDef();
    s.labelNextEdit(draft.label);
    s.replace(state.after);
    const after = s.currentDef();
    if (after === before) return { ok: false, reason: "Nothing was applied — the editor did not take the change (it may have just become read-only)." };
    // the entry the proposal was recorded in (a proposal made before this page recorded anything gets one now)
    const k = session.openOp ?? recordProposal(request, proposal.steps.flatMap((x) => x.actions), { source: "engine" }, null);
    setSession((x) => ({ ...x, proposal: null, openOp: null, confirmed: false, excluded: [] }));
    const ux = state.diff.ux;
    // a question's default value and custom HTML are look-and-behaviour too
    const qBehaviour = state.diff.questionsModified.flatMap((m) => m.changes.filter((c) => c.field === "default value" || c.field === "custom HTML").map((c) => `${m.code} (${c.field})`));
    const targets = [...new Set([...(state.diff.theme.length ? ["the theme"] : []), ...[...ux.added, ...ux.changed, ...ux.removed].map((x) => x.target), ...qBehaviour])];
    const note = (!ux.empty || state.diff.theme.length > 0 || qBehaviour.length > 0) && state.structureUnchanged
      ? `Done. The look and behaviour of ${targets.slice(0, 3).join(", ")}${targets.length > 3 ? ` and ${targets.length - 3} more` : ""} ${targets.length === 1 ? "has" : "have"} been updated without changing the survey's questions, codes or logic.`
      : undefined;
    opts.patchAll((e) => (e.proposal === "open" || e.proposal === "superseded" ? { proposal: e.proposal === "open" ? "applied" : e.proposal, ...(e.proposal === "open" ? { opKey: k, ...(note ? { appliedNote: note } : {}) } : {}) } : null));
    const ok = state.results.filter((r) => r.ok);
    const done = await commitApplied(k, {
      record: { ...draft, before, after },
      applied: ok.map((r) => r.description),
      excluded: left,
      failed: state.results.filter((r) => !r.ok).map((r) => ({ description: r.description, reason: r.error ?? "" })),
      warnings: state.warnings,
      engineOps: [...new Set(ok.map((r) => r.op))],
      targets: [...new Set(ok.flatMap((r) => r.touched))],
    }, (n) => { opts.patchAll((e) => (e.opKey === k && e.proposal === "applied" ? { changeN: n ?? undefined } : null)); show?.(n); });
    return { ok: true, ...(note ? { message: note } : {}), n: done.n, save: done.save };
  }, [session, state, full, excluded, stale, s, setSession, opts, recordProposal, commitApplied]);

  const cancel = React.useCallback(() => {
    if (session.openOp) void recorder.update(session.openOp, { status: "cancelled", statusDetail: "cancelled before it was applied" });
    setSession((x) => ({ ...x, proposal: null, openOp: null, confirmed: false, excluded: [] }));
    opts.patchAll((e) => (e.proposal === "open" || e.proposal === "superseded" ? { proposal: "cancelled" } : null));
  }, [setSession, opts, recorder, session.openOp]);

  /**
   * RESTORE one AI change — the store's own undo when it is still the last
   * edit; otherwise its "before", said out loud first (it also undoes what
   * came after). A change read back from the server (an earlier session)
   * brings its surveys with it; one whose "before" was not kept cannot be
   * restored, and says so.
   */
  const restore = React.useCallback(async (k: string, force = false): Promise<{ ok: boolean; reason?: string }> => {
    if (s.readOnly) return { ok: false, reason: "This project is read-only right now." };
    const op = recorder.get(k);
    let rec = session.history.find((h) => h.key === k);
    if (rec?.reverted || op?.status === "reverted") return { ok: false, reason: "Nothing to undo." };
    let canonical = false;
    if (!rec) {
      const fullOp = await recorder.fetchOne(k);
      if (!fullOp?.before || !fullOp.after) return { ok: false, reason: "The survey as it was before this change was not kept, so it cannot be restored from here." };
      // jsonb keeps keys sorted: compared canonically, or every restored change would read "changed since"
      canonical = true;
      rec = { n: fullOp.changeN, key: k, at: fullOp.createdAt, request: fullOp.prompt, summary: fullOp.applied, created: [], modified: [], removed: [], before: fullOp.before, after: fullOp.after, label: "" };
    }
    const same = canonical ? sameSurveyCanonical : sameSurvey;
    const tag = changeLabel(rec.n).replace("AI Change", "AI change");
    if (rec.label && s.undoLabel === rec.label && same(s.def, rec.after)) s.undo();
    else {
      if (!force && !same(s.def, rec.after)) return { ok: false, reason: `The survey has changed since ${tag}. Reverting it restores the survey to before that change, which also undoes the edits made after it.` };
      s.labelNextEdit(`Revert ${tag}`);
      s.replace(rec.before);
    }
    const restored = { ...rec, reverted: true };
    setSession((x) => ({ ...x, history: x.history.some((h) => h.key === k) ? x.history.map((h) => (h.key === k ? restored : h)) : [...x.history, restored] }));
    void recorder.update(k, { status: "reverted", statusDetail: force ? "restored from History, with the edits made after it" : "restored from History" });
    void auditChange(k, rec, true);
    return { ok: true };
  }, [session.history, s, setSession, recorder, auditChange]);

  /** REAPPLY: the entry's actions, re-proposed against the survey as it is NOW — through the review again, never written blind */
  const reapply = React.useCallback((k: string): boolean => {
    const op = recorder.get(k);
    if (!op) return false;
    const actions = reapplyActions(op, actionsByOp.get(k));
    if (!actions.length) return false;
    previewFix(actions, `Reapply ${op.changeN ? changeLabel(op.changeN).replace("AI Change", "AI change") : "an earlier change"}: ${op.prompt}`.slice(0, 500), { intent: { kind: "reapply", of: op.changeN ?? op.serverId ?? k } });
    return true;
  }, [recorder, previewFix]);

  /** COMPARE: the surveys before and after an entry — the page's own when it made the change, else the record's */
  const compare = React.useCallback(async (k: string): Promise<{ before: SurveyDefinition; after: SurveyDefinition } | { error: string }> => {
    const rec = session.history.find((h) => h.key === k);
    if (rec) return { before: rec.before, after: rec.after };
    const full = await recorder.fetchOne(k);
    if (full?.before && full.after) return { before: full.before, after: full.after };
    return { error: full ? "The surveys before and after this change were not kept (only an applied change keeps them, up to 2 MB each)." : "This entry could not be read from the history." };
  }, [session.history, recorder]);

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
    available, busy, state, full, stale, proposal: session.proposal,
    /*
     * selective apply: the unticked actions, by flat index; setting them re-evaluates `state`. Ticking one
     * back can bring back a removal nobody confirmed, so that asks for the confirmation again; unticking
     * only takes changes away, so a confirmation given stands.
     */
    excluded, setExcluded: (xs: number[]) => setSession((x) => {
      const next = x.proposal ? validExclusions(x.proposal, xs) : [];
      const reincluded = (x.excluded ?? []).some((i) => !next.includes(i));
      return { ...x, excluded: next, confirmed: reincluded ? false : x.confirmed };
    }), history: session.history, review: session.review,
    /* the operation history: every entry (newest first), where it is kept, and what can be done with one */
    sandbox, ops: recorder.list(), opsDurable: recorder.durable, opsLoaded: recorder.loaded, opsError: recorder.loadError, op: (k: string) => recorder.get(k),
    refreshOps: () => recorder.refresh(), recordOp, updateOp, commitApplied, retrySave, restore, reapply, compare,
    actionsOf: (k: string) => actionsByOp.get(k) ?? null,
    docs: session.docs ?? [], durable: session.durable, uploading, docError,
    confirmed: session.confirmed, setConfirmed: (v: boolean) => setSession((x) => ({ ...x, confirmed: v })),
    tab: session.tab, setTab: (t: PanelTab) => setSession((x) => ({ ...x, tab: t })),
    ask, local, askData, makeOutput, working, runReview, previewFix, apply, cancel, uploadDocs, deleteDoc, refreshDocs,
    planFirst, setPlanFirst, executePlan, cancelPlan,
    themeImage, themeImageError, attachThemeImage, clearThemeImage: () => setThemeImage(null),
    quotaCounts, quotaCountsAt, refreshQuotaCounts,
    analysisRun, runDue, running, runError, refreshAnalysisRun, runPlanNow,
    lastReport, drafting, draftReport,
  };
}
export type Copilot = ReturnType<typeof useCopilot>;
