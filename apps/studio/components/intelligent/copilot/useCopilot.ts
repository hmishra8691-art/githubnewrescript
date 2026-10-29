"use client";
import React from "react";
import type { AnalysisRun } from "@rescript/analytics";
import type { SurveyDefinition } from "@rescript/schema";
import { UNSUPPORTED_MESSAGE, reviewSurvey, describeAction, describeWorkflow, researchWorkflow, type ExecutionMode, type ResearchWorkflow, type SurveyAction, type SurveyReview, type Interpretation, type WorkflowStep } from "@rescript/engine";
import type { WorkflowResponse } from "../../../app/api/copilot/workflow/route";
import { useStudio, uid } from "../../studio/store";
import type { CopilotReply, CopilotFinding } from "../../../lib/copilot/prompt";
import { evaluateProposal, rebaseProposal, sameSurvey, changeRecord, changeLabel, memoryFrom, type Proposal, type ProposalState, type ChangeRecord } from "../../../lib/copilot/client";
/* production intents (2026-10-18): a repeated step is one step; "undo" / "apply it" said in words */
import { foldPrompt, lastUndoable, repeatsTail, withStep } from "../../../lib/copilot/proposalSteps";
import { NOTICES, replyLanguage } from "../../../lib/copilot/notices";
import {
  OpsRecorder, memoryFromOps, saveFailure, observeUndo, reapplyActions, sameSurveyCanonical,
  type NewOp, type OpUpdate, type SaveView, type Send,
} from "../../../lib/copilot/history";
import type { OpApiCall, OpFailed, OpIntent, OpProposed, OpSource } from "../../../lib/copilot/operations";
import { excludedLabels, validExclusions } from "../../../lib/copilot/review";
import { describeFailure, failureFromException, failureFromRefusal, failureFromTransport, isTurnFailure, type FailureCode, type TurnFailure } from "@/lib/copilot/failure";
import {
  STATUS, MAX_STALLED_ROUNDS, autoRetriesFor, clearCheckpoint, failureOfResponse, interruptedFailure, isTemporary, loadCheckpoint, mergeBuilt, pausedFailure, pendingIds, saveCheckpoint, waitBeforeRetry,
  type BuiltItem, type Checkpoint, type TurnResponse,
} from "@/lib/copilot/resume";
import type { ChangePlan } from "@/lib/copilot/changePlan";
import type { HeardTranscript } from "../../../lib/intelligent/voice";
import { prepareThemeImage, type ThemeImage } from "../../../lib/copilot/themeImage";
/* response streaming (2026-10-18): the turn read as events — text, progress, checkpoints — or as JSON from an older server */
import { NDJSON, clientStreaming, readTurnResponse } from "../../../lib/copilot/stream";
import { isArtifactType, editionOf, mimeOf, ARTIFACT_LABEL, type ArtifactType } from "../../../lib/artifacts/core";
import { fetchArtifactLines, fetchArtifactLink, sandboxFingerprint, saveBytes, saveUrl, sessionStore } from "../../../lib/artifacts/client";
import { sandboxFind, sandboxGet, sandboxLines, sandboxPut, sandboxTheme, fromBase64 } from "../../../lib/artifacts/sandboxStore";
import { themeTurn, themeWithModel, applyThemeTurn, saveThemeTurn, type ThemeCard } from "../../../lib/copilot/reportThemeTurn";
import { qualTurn, runQualCard, type QualCard } from "./qualTurn";
import type { QualRequest } from "@rescript/engine";
import type { TaskClientView } from "../../../lib/tasks/service";

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
  status: "thinking" | "ready" | "failed" | "empty" | "plan" | "task";
  /** a planned task (2026-10-29, docs/EXECUTION-ENGINE-2026-10-29.md): the persisted plan's state, refreshed by the page's drive loop */
  task?: TaskClientView;
  reply?: CopilotReply;
  /** the change plan the model proposed before building (Phase 2): read, ticked and approved here; `approved` once it was built */
  changePlan?: ChangePlan & { approved?: string[]; failures?: { id: string; failure: TurnFailure }[] };
  /** the research coverage of a generated survey, checked on the clone (Phase 3) */
  coverage?: { ok: boolean; summary: string; unmeasured: string[]; unconnected: string[]; hypotheses: { label: string; text: string; status: string }[] };
  /** a document the engine produced (Phase 5): its name, size and a link to it, what it holds, and what the narrative gate kept */
  output?: {
    name: string; size: number; url: string; kind: "docx" | "pptx"; summary: string; narrative?: string;
    /*
     * THE KEPT DOCUMENT (2026-10-18): which stored version this is, so the card offers it again after a reload
     * and downloads it without generating. `url` is a blob URL only while this page holds the bytes; a restored
     * card has none and asks for a fresh signed link (or, in the sandbox, reads the tab's copy) on Download.
     */
    type?: string; edition?: string; artifactId?: string; version?: number; fingerprint?: string;
    /** the stored copy was sent — nothing was generated */
    reused?: boolean;
    /** offered again after a reload */
    restored?: boolean;
    /** the document made now would differ (the design, the data, the theme changed): "a new version is available" */
    stale?: boolean;
    /** why a stored copy was not used, or a new one not kept */
    note?: string;
    theme?: string;
  };
  /** a report theme turn (2026-10-18): the preview, and what was applied or saved */
  theme?: ThemeCard;
  /** a qualitative synthesis request (F2 2026-10-22): the preview card, then the result once Run was pressed */
  qual?: QualCard;
  /** a data question's answer, read on the respondent data (Phase 4): the base, the test behind it, the caveats */
  data?: { n: number; environment: string; dataset: string; source: "data" | "sandbox"; evidence?: { test: string; p: number | null; significant: boolean; effect?: { name: string; value: number } }; caveats: string[]; fromRun?: string };
  error?: string;
  message?: string;
  /**
   * What an unfinished generation is doing, in the researcher's words — never a
   * spinner without a reason: generating, waiting for AI capacity (with when it
   * resumes), resuming, or done. No status codes, no provider text.
   */
  progress?: { phase: "planning" | "generating" | "waiting" | "resuming" | "done" | "partial"; message: string; done?: number; total?: number; until?: number; /** streamed (2026-10-18): the step the server is on — "Item 2 of 5: Screener", "Checking the proposal" */ step?: string };
  /** streamed (2026-10-18): the reply text as the model writes it, shown in the pending card until the result replaces it; `part` is what it belongs to (the reply, a plan's summary, a plan item) */
  live?: { part?: string; text: string };
  /** the work kept for a build that stopped: items built, items still to build, items that failed — what Resume and Review-what's-ready act on */
  work?: { built: number; total: number; pending: number; failed: number };
  /** a heads-up from the AI service, only when its allowance is nearly spent */
  notice?: string;
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
export type PanelTab = "changes" | "review" | "research" | "history" | "analysis" | "findings" | "workflow" | "languages" | "quotas" | "ux" | "inspector";
/** what the workflow route told the Studio (Phase 6): the execution mode, the model, the cost of each model step, whether fieldwork data exists */
export type WorkflowInfo = Omit<WorkflowResponse, "workflow">;
/** the stored analysis run, as the analytics route returns it (results are not stored — only findings, verdicts and each item's chart) */
export type StoredRunBrief = Pick<AnalysisRun, "computedAt" | "n" | "findings" | "verdicts" | "warnings" | "environment" | "trigger" | "corrections" | "advice" | "discoveries" | "kpis" | "since"> & { id?: string; items?: { definition: { name: string; kind: string; options?: Record<string, unknown> }; chart?: string; hypotheses: string[] }[] };

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
      /* the same request again (a chip pressed twice): one step, one record line — not "Plan the analysis → Plan the analysis" (production intents, 2026-10-18) */
      if (foldPrompt(open.prompt, text) === open.prompt.slice(0, 4000) && repeatsTail(actionsByOp.get(open.key) ?? [], actions)) return open.key;
      void recorder.update(open.key, {
        prompt: foldPrompt(open.prompt, text), proposed: [...open.proposed, ...proposedOf(actions)],
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
    /*
     * The History tab opens HERE, with the draft, at the moment of Apply — not when the server's number arrives.
     * Opened after the round trip, a slow answer (a cold server compiling the route, a busy one) switched the
     * panel away from whatever tab the researcher had chosen in the meantime (2026-10-18: phase6-agent-test lost
     * its Workflow tab after Apply on a freshly started server). The answer only patches the number in.
     */
    setSession((h) => ({ ...h, history: h.history.some((r) => r.key === k) ? h.history.map((r) => (r.key === k ? draft : r)) : [...h.history, draft], ...(openHistory ? { tab: "history" as const } : {}) }));
    const op = await recorder.update(k, { status: "applied", applied: x.applied, excluded: x.excluded, failed: x.failed, warnings: x.warnings, engineOps: x.engineOps, targets: x.targets, before: x.record.before, after: x.record.after });
    const n = op?.changeN ?? null;
    const record: ChangeRecord = { ...draft, n };
    setSession((h) => ({ ...h, history: h.history.map((r) => (r.key === k ? { ...r, n } : r)) }));
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
  /** TEST SEAM: scripted faults / time budgets for the next requests (fake provider only), one entry per request */
  const faultRef = React.useRef<{ faults?: unknown[]; budgetMs?: number }[]>([]);
  /** the unfinished builds' checkpoints by card, and the waits a click can end */
  const checkpointRef = React.useRef<Map<string, Checkpoint>>(new Map());
  const wakeRef = React.useRef<Map<string, () => void>>(new Map());
  /* an image to build the theme from, sent with the next request */
  const [themeImage, setThemeImage] = React.useState<ThemeImage | null>(null);
  const [themeImageError, setThemeImageError] = React.useState<string | null>(null);
  const attachThemeImage = React.useCallback(async (file: File) => {
    setThemeImageError(null);
    try { setThemeImage(await prepareThemeImage(file, s.surveyDbId)); } catch (e) { setThemeImageError((e as Error).message); }
  }, [s.surveyDbId]);

  /*
   * STREAMING (2026-10-18). Requests ask for the streamed protocol unless switched off
   * (`localStorage["rescript.copilot.stream"] = "off"`, or NEXT_PUBLIC_COPILOT_STREAMING=off at build).
   * TEST SEAM: `window.__rescriptCopilotStream(cfg | [cfg1, cfg2, …] | null)` sends `fakeStream` with every
   * turn until reset (a list: one per request, the last one kept) — the fake provider streams (and the route
   * streams to the fake) only with it.
   */
  const streamSeamRef = React.useRef<unknown>(null);
  React.useEffect(() => {
    const w = window as unknown as { __rescriptCopilotStream?: (cfg: unknown) => void };
    w.__rescriptCopilotStream = (cfg) => { streamSeamRef.current = cfg ?? null; };
    return () => { delete w.__rescriptCopilotStream; };
  }, []);

  // the browser suites stand in for the model through this hook, as the voice suite does for the microphone
  React.useEffect(() => {
    const w = window as unknown as { __rescriptCopilotFake?: (reply: unknown) => void };
    w.__rescriptCopilotFake = (reply) => { fakeRef.current.push(reply); };
    // a sentence the engine answered never reached the model: the suite drops the reply it had queued for it
    (w as { __rescriptCopilotFakeReset?: () => void }).__rescriptCopilotFakeReset = () => { fakeRef.current = []; };
    (w as { __rescriptCopilotFault?: (f: { faults?: unknown[]; budgetMs?: number }) => void }).__rescriptCopilotFault = (f) => { faultRef.current.push(f); };
    return () => { delete w.__rescriptCopilotFake; delete (w as { __rescriptCopilotFakeReset?: () => void }).__rescriptCopilotFakeReset; delete (w as { __rescriptCopilotFault?: unknown }).__rescriptCopilotFault; };
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

  /*
   * THE EXECUTION CHOICE (Phase 6). A project runs INTERNAL (nothing is sent
   * to a language model: the engine's reading, the standard items, the
   * workflow's own steps) or CLOUD (model steps go to the model). The
   * project's choice is a project setting the workflow route keeps (the
   * sandbox keeps it in the browser); `cloudOnce` lets one request through.
   */
  const [executionMode, setExecutionModeState] = React.useState<ExecutionMode>(() => { try { return window.localStorage.getItem("rescript.copilot.mode") === "internal" ? "internal" : "cloud"; } catch { return "cloud"; } });
  const [workflowInfo, setWorkflowInfo] = React.useState<WorkflowInfo | null>(null);
  const [workflowError, setWorkflowError] = React.useState<string | null>(null);
  const [workflowObjective, setWorkflowObjective] = React.useState<string | null>(null);
  const [workflowLoading, setWorkflowLoading] = React.useState(false);
  /** the outputs produced this session — the engine cannot see a file, so the workflow is told */
  const producedRef = React.useRef<("design_document" | "deck")[]>([]);
  /** one request let through to the cloud while the project runs internally — reset by the call that used it */
  const cloudOnceRef = React.useRef(false);
  const [cloudOnce, setCloudOnceState] = React.useState(false);
  const setCloudOnce = React.useCallback((v: boolean) => { cloudOnceRef.current = v; setCloudOnceState(v); }, []);

  const run = React.useCallback(async (id: string, text: string, mode: "review" | "generate" | undefined, extra: Record<string, unknown>, handoff?: EngineHandoff): Promise<"handled" | "unavailable" | "empty"> => {
    /* what the engine read before handing the sentence on, and the selection it was read with — kept on every model record so the language corpus (Phase 8) can replay the sentence */
    const read: OpIntent = { engine: "model", ...(handoff ? { engineCategory: handoff.category ?? null, engineReason: handoff.reason.slice(0, 200) } : {}), ...(opts.selectedId ? { selected: opts.selectedId } : {}) };
    /* internal mode: the call is not made, the card says why and where the switch is, the history records a turn that cost nothing */
    if (executionMode === "internal" && !cloudOnceRef.current) {
      const failure = describeFailure("internal_mode");
      opts.patch(id, { status: "failed", error: failure.message, failure, opKey: recordOp({ prompt: text, source: "model", status: "failed", intent: { ...read, mode: mode ?? "", execution: "internal" }, statusDetail: `${failure.title}: ${failure.message}`, apiCalls: [] }) });
      return "unavailable";
    }
    /* the one-time consent travels with the request: the server enforces the project's Internal setting and needs to know this call was allowed once (audit A-2) */
    const usedOnce = cloudOnceRef.current;
    if (usedOnce) { cloudOnceRef.current = false; setCloudOnceState(false); }
    setBusy(true);
    try {
      const proposal = session.proposal;
      const working: SurveyDefinition = proposal ? (stale ? evaluateProposal(rebaseProposal(proposal, s.def)).after : evaluateProposal(proposal).after) : s.def;
      const fake = fakeRef.current.shift();
      /*
       * THE CHECKPOINT. From the moment a request is sent the researcher's
       * words — and, for a plan being built, every item as it comes back — are
       * kept: in memory for Resume, in the browser's storage for a reload. The
       * server is told which items are done and never builds them again.
       */
      const isBuild = extra.stage === "execute";
      const plan = isBuild ? (extra.plan as ChangePlan) : undefined;
      const items = isBuild ? (extra.items as string[]) : undefined;
      const finalize = extra.finalize === true;
      const given = Array.isArray(extra.done) ? (extra.done as (BuiltItem & { applied?: boolean })[]) : [];
      const cp: Checkpoint = {
        v: 1, entryId: id, surveyId: s.surveyDbId, text, ...(mode ? { mode } : {}), kind: isBuild ? "build" : "turn", ...(plan ? { plan } : {}), ...(items ? { items } : {}),
        built: given.filter((g) => !g.applied).map((g) => ({ id: g.id, raw: g.raw })), applied: given.filter((g) => g.applied).map((g) => ({ id: g.id, raw: g.raw })), failed: [], at: Date.now(),
      };
      const store = (): Storage | null => { try { return window.localStorage; } catch { return null; } };
      const remember = () => { cp.at = Date.now(); checkpointRef.current.set(id, cp); saveCheckpoint(store(), cp); };
      const forget = () => { checkpointRef.current.delete(id); clearCheckpoint(store(), s.surveyDbId); };
      if (!finalize) remember();
      const startBuilt = cp.built.length;
      const total = items?.length ?? 0;
      let chargeAcc = 0;
      const workOf = () => (isBuild ? { built: cp.built.length, total, pending: pendingIds(items ?? [], cp.built, cp.failed).length, failed: cp.failed.length } : undefined);
      /* the words on the card for this moment — only where there is a generation to describe */
      let lastSaid: CopilotEntry["progress"] | undefined;
      const say = (progress: CopilotEntry["progress"] | undefined) => { lastSaid = progress; opts.patch(id, { progress }); };
      if (isBuild && !finalize) say({ phase: "generating", message: STATUS.building(cp.built.length, total), done: cp.built.length, total });
      else if (mode === "generate") say({ phase: "planning", message: planFirst ? STATUS.planning : STATUS.generating });
      /* one round trip. A scripted fault (browser suites) rides along; a request that never gets a JSON answer is status 0 */
      /*
       * STREAMED (2026-10-18): the reply text as the model writes it (shown in the pending card, at most every
       * 60 ms), the step the server is on, and — building a plan — each item the moment it is built, kept in the
       * checkpoint at once, so a connection lost mid-request costs only the item in flight. Heartbeats only keep
       * the reader's idle clock from running out; a stream that breaks before its result is status 0, the
       * dropped connection the resume logic below already handles.
       */
      let live: { part?: string; text: string } | null = null;
      let liveTimer: ReturnType<typeof setTimeout> | null = null;
      const showLive = () => { liveTimer = null; opts.patch(id, { live: live ? { ...live } : undefined }); };
      const streamHandlers = {
        onText: (delta: string, part: string | undefined) => {
          if (!live || live.part !== part) live = { ...(part ? { part } : {}), text: "" };
          live.text += delta;
          if (!liveTimer) liveTimer = setTimeout(showLive, 60);
        },
        onProgress: (e: { stage: string; item?: number; of?: number; label?: string }) => {
          if (e.stage === "item") say({ phase: "generating", message: STATUS.building(cp.built.length, total), done: cp.built.length, total, step: `Item ${e.item ?? "?"} of ${e.of ?? "?"}${e.label ? `: ${e.label}` : ""}` });
          else if (e.stage === "plan") say({ phase: "planning", message: STATUS.planning, ...(e.label ? { step: e.label } : {}) });
          else if (lastSaid && e.label) say({ ...lastSaid, step: e.label });
        },
        onCheckpoint: (itemId: string, raw: unknown) => {
          if (!isBuild || typeof itemId !== "string") return;
          cp.built = mergeBuilt(cp.built, [{ id: itemId, raw }]);
          remember();
          say({ phase: "generating", message: STATUS.building(cp.built.length, total), done: cp.built.length, total, ...(lastSaid?.step ? { step: lastSaid.step } : {}) });
        },
      };
      const send = async (): Promise<TurnResponse> => {
        const f = faultRef.current.shift();
        const sentFake = Array.isArray(fake) ? fake.slice(cp.built.length - startBuilt) : fake;
        let stored: string | null = null; try { stored = window.localStorage.getItem("rescript.copilot.stream"); } catch { /* a private window */ }
        const streamOn = clientStreaming(stored, process.env.NEXT_PUBLIC_COPILOT_STREAMING);
        /* the seam: one config for every request, or a list — one per request, the last one kept */
        const seamCfg = streamSeamRef.current;
        const seam: unknown = Array.isArray(seamCfg) ? (seamCfg.length > 1 ? seamCfg.shift() : seamCfg[0]) : seamCfg;
        if (live) { live = null; showLive(); }
        try {
          const r = await fetch("/api/copilot/turn", {
            method: "POST", headers: { "content-type": "application/json", ...(streamOn ? { accept: `${NDJSON}, application/json` } : {}) },
            body: JSON.stringify({ surveyId: s.surveyDbId, message: text, definition: working, selectedId: opts.selectedId, memory: memoryFrom(copilotTurns.map((t) => ({ user: t.text, reply: t.reply })), memoryFromOps(recorder.list())), ...(mode ? { mode } : {}), ...(sentFake ? { fake: sentFake } : {}), ...(themeImage ? { themeImage } : {}), ...(quotaCounts ? { quotaCounts } : {}), ...(runForTurn ? { analysisRun: runForTurn } : {}), planFirst, ...(usedOnce ? { aiOnce: true } : {}), ...extra, ...(isBuild ? { done: [...cp.built, ...(cp.applied ?? []).map((a) => ({ ...a, applied: true }))] } : {}), ...(f?.faults ? { faults: f.faults } : {}), ...(f?.budgetMs ? { budgetMs: f.budgetMs } : {}), ...(seam ? { fakeStream: seam } : {}) }),
          });
          const t = await readTurnResponse(r, streamHandlers);
          return { status: t.status, ok: t.ok, d: t.d };
        } catch { return { status: 0, ok: false, d: null }; }
        finally { if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; } }
      };
      /* a wait the researcher can end with "Resume now" */
      const pause = (ms: number) => new Promise<void>((resolve) => { const end = () => { clearTimeout(t); wakeRef.current.delete(id); resolve(); }; const t = setTimeout(end, ms); wakeRef.current.set(id, end); });
      const waitFor = async (ms: number) => {
        say({ phase: "waiting", message: STATUS.waiting, until: Date.now() + ms, done: cp.built.length, total });
        await pause(ms);
        say({ phase: "resuming", message: STATUS.resuming, done: cp.built.length, total });
      };
      /* a temporary failure of the whole request — busy, a dropped connection, the platform's own time limit — is waited out and sent again, with the same words and the same checkpoint */
      const exchange = async (): Promise<TurnResponse> => {
        for (let attempt = 0; ; attempt++) {
          const res = await send();
          if (!isTemporary(res) || attempt >= autoRetriesFor(res)) return res;
          await waitFor(waitBeforeRetry(failureOfResponse(res) ?? failureFromTransport(res.status), attempt));
        }
      };
      /* stopped, with the work kept: the card says why, what is kept, and offers Resume / Review what's ready */
      const stopWith = (failure: TurnFailure) => {
        const f = isBuild ? pausedFailure(failure, cp.built.length, total) : failure;
        remember();
        opts.patch(id, { status: "failed", error: f.message, failure: f, progress: undefined, work: workOf(), usage: { charge: chargeAcc } });
        opts.patch(id, { opKey: recordOp({ prompt: text, source: "model", status: "failed", intent: { ...read, mode: mode ?? "" }, statusDetail: `${f.title}: ${f.message}`, apiCalls: [{ route: "/api/copilot/turn", mode: mode ?? "", charge: chargeAcc, error: `${f.title}: ${f.message}` }] }) });
      };
      let res: TurnResponse;
      let stalls = 0;
      for (;;) {
        res = await exchange();
        const pd = res.d;
        if (!(res.ok && pd?.stage === "progress")) break;
        /* a checkpoint from the server: what it built before its time ran out or the provider paused it */
        chargeAcc += Number((pd.usage as { charge?: number } | undefined)?.charge) || 0;
        const newly = Array.isArray(pd.built) ? (pd.built as BuiltItem[]) : [];
        cp.built = mergeBuilt(cp.built, newly);
        if (Array.isArray(pd.failed)) cp.failed = pd.failed as { id: string; failure: TurnFailure }[];
        remember();
        say({ phase: "generating", message: STATUS.building(cp.built.length, total), done: cp.built.length, total });
        const notice = (pd.context as { notice?: string } | undefined)?.notice;
        if (notice) opts.patch(id, { notice });
        if (isTurnFailure(pd.halted)) { setBusy(false); stopWith(pd.halted); return "handled"; }
        stalls = newly.length ? 0 : stalls + 1;
        const wf = pd.waiting as { retryAfterMs?: number; failure?: TurnFailure } | undefined;
        if (stalls > MAX_STALLED_ROUNDS) { stopWith(wf?.failure && isTurnFailure(wf.failure) ? wf.failure : describeFailure("capacity")); return "handled"; }
        if (wf) await waitFor(waitBeforeRetry({ retryAfterMs: wf.retryAfterMs }, stalls));
      }
      const r = { status: res.status, ok: res.ok };
      /* the streamed text was a preview: the result (or the failure) replaces it */
      if (live) { live = null; opts.patch(id, { live: undefined }); }
      if (themeImage) setThemeImage(null);
      /* every model turn is in the history with the call it made and what it cost — a failed one too */
      const call = (d: Record<string, unknown> | null, error?: string): OpApiCall => {
        const ctx = (d?.context ?? {}) as { mode?: string; cached?: boolean; promptChars?: number };
        return { route: "/api/copilot/turn", mode: ctx.mode ?? mode ?? "", charge: Number((d?.usage as { charge?: number } | undefined)?.charge) || 0, ...(typeof ctx.cached === "boolean" ? { cached: ctx.cached } : {}), ...(typeof ctx.promptChars === "number" ? { promptChars: ctx.promptChars } : {}), ...(error ? { error } : {}) };
      };
      const failedTurn = (d: Record<string, unknown> | null, error: string) => opts.patch(id, { opKey: recordOp({ prompt: text, source: "model", status: "failed", intent: { ...read, mode: mode ?? "" }, statusDetail: error, apiCalls: [call(d, error)] }) });
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
        /* the server's own failure when it sent one; when no JSON came back at all, what the status means (the platform's time limit, a dropped connection) — never a bare "provider refused" */
        /* the Studio's own refusals (signed out, a request it could not read, a locked project) carry no `failure`: each gets its own sentence, never "the AI service could not process this" (AI-04) */
        let failure = isTurnFailure(d?.failure) ? d.failure : !d ? failureFromTransport(status) : (status >= 400 ? failureFromRefusal(status, d) : null) ?? describeFailure(fallback, String(d?.error ?? "").slice(0, 200) || undefined);
        if (isBuild) failure = pausedFailure(failure, cp.built.length, total);
        const error = `${failure.message}`;
        /* the work stays saved unless the failure is one no Resume can change (nothing usable, no model, internal mode) */
        if (["unusable", "engine_unparsed", "internal_mode", "not_configured"].includes(failure.code)) forget(); else remember();
        opts.patch(id, { status: "failed", error, failure, progress: undefined, work: workOf(), usage: { charge: chargeAcc + (Number((d?.usage as { charge?: number } | undefined)?.charge) || 0) }, context: d?.context as CopilotEntry["context"] });
        failedTurn(d, `${failure.title}: ${failure.message}`);
        void status;
      };
      /* the progress responses of earlier rounds were already counted: this is the last round's */
      const d = res.d;
      if (r.status === 501) { setAvailable(false); failTurn(d, 501, "not_configured"); return "unavailable"; }
      if (!r.ok || !d || d.ok === false) { failTurn(d, r.status, r.status === 402 || r.status === 423 ? "wallet" : "provider"); return "handled"; }
      setAvailable(true);
      if (d.stage === "task" && d.task) {
        /* PLAN FIRST (2026-10-29): the request became a persisted task of small steps — the execution panel shows it, the drive loop runs it */
        const tv = d.task as TaskClientView;
        forget();
        const reply = d.reply as CopilotReply | undefined;
        opts.patch(id, { status: "task", task: tv, ...(reply ? { reply } : {}), progress: undefined, usage: d.usage as { charge: number }, context: d.context as CopilotEntry["context"], opKey: recordOp({ prompt: text, source: "model", status: "clarify", intent: { ...read, mode: "task", kind: "task" }, statusDetail: `Planned as a task (${tv.id}, ${tv.progress.total} steps)`, apiCalls: [call(d)] }) });
        setTaskDurable(d.durable === true);
        void driveTaskRef.current?.(id, tv.id);
        return "handled";
      }
      if (d.stage === "plan" && d.plan) {
        // the change plan: read and approved before anything is built
        const plan = d.plan as ChangePlan;
        forget();
        opts.patch(id, { status: "plan", changePlan: plan, progress: undefined, usage: d.usage as { charge: number }, context: d.context as CopilotEntry["context"], opKey: recordOp({ prompt: text, source: "model", status: "clarify", intent: { ...read, mode: String((d.context as { mode?: string } | undefined)?.mode ?? mode ?? ""), kind: "plan" }, statusDetail: `Change plan: ${plan.items.map((i) => i.title).join("; ")}`.slice(0, 2000), apiCalls: [call(d)] }) });
        return "handled";
      }
      const reply = d.reply as CopilotReply | null;
      const review = d.review as SurveyReview | undefined;
      /* the whole charge of this turn: every round of it, once */
      const charged = { charge: chargeAcc + (Number((d.usage as { charge?: number } | undefined)?.charge) || 0) };
      const notice = (d.context as { notice?: string } | undefined)?.notice;
      /* a partial build keeps its place: what is in the proposal now is context for building the rest, never merged twice */
      const partialIds = d.partial && Array.isArray(d.planPending) ? (d.planPending as string[]) : [];
      if (partialIds.length) { cp.applied = mergeBuilt(cp.applied ?? [], cp.built); cp.built = []; cp.items = partialIds; remember(); } else forget();
      if (!reply) {
        if (review) {
          // the model had nothing, the engine's own review stands: shown as the answer
          const message = String(d.message ?? "No answer.");
          opts.patch(id, { status: "empty", message, usage: d.usage as { charge: number }, review, opKey: recordOp({ prompt: text, source: "model", status: "answered", intent: { ...read, mode: String((d.context as { mode?: string } | undefined)?.mode ?? mode ?? ""), kind: "empty" }, statusDetail: message, apiCalls: [call(d)] }) });
          setSession((x) => ({ ...x, review: { rules: review, ai: [], at: new Date().toISOString(), running: false }, tab: "review" }));
          return "handled";
        }
        // nothing usable: the turn fails with its cause — and the grammar may still read the sentence (a phrasing the engine's
        // recognisers handed on but the grammar parses, "call Q2 PLATFORMS"); the view then shows that reading instead
        failTurn(d, 200, "unusable");
        return "empty";
      }
      /* "ready for review" only when there is something to review: a build whose items came back empty is not a draft (2026-10-17) */
      const doneBuilding = isBuild && !partialIds.length && reply.actions.length > 0;
      const patch: Partial<CopilotEntry> = { status: "ready", reply, usage: charged, ...(notice ? { notice } : {}), progress: doneBuilding ? { phase: "done", message: STATUS.ready } : partialIds.length ? { phase: "partial", message: STATUS.partial((cp.applied ?? []).length, (cp.applied ?? []).length + partialIds.length), done: (cp.applied ?? []).length, total: (cp.applied ?? []).length + partialIds.length } : undefined, ...(partialIds.length ? { work: { built: (cp.applied ?? []).length, total: (cp.applied ?? []).length + partialIds.length, pending: partialIds.length, failed: Array.isArray(d.planFailures) ? (d.planFailures as unknown[]).length : 0 } } : {}), context: d.context as CopilotEntry["context"], passages: (d.passages ?? {}) as Record<string, Passage>, ...(review ? { review } : {}) };
      if (d.coverage && typeof d.coverage === "object") patch.coverage = d.coverage as CopilotEntry["coverage"];
      if (d.stage === "executed" && d.plan) {
        const built = d.plan as ChangePlan;
        patch.changePlan = { ...built, approved: built.items.map((i) => i.id), ...(Array.isArray(d.planFailures) ? { failures: d.planFailures as { id: string; failure: TurnFailure }[] } : {}) };
      }
      /* the model's running memory and its reply travel in the record, so a reload keeps the thread (AI-05) */
      const intent: OpIntent = { ...read, mode: String((d.context as { mode?: string } | undefined)?.mode ?? mode ?? ""), kind: reply.kind, ...(reply.memory ? { memory: reply.memory } : {}), ...(reply.reply ? { reply: reply.reply.slice(0, 500) } : {}) };
      const failed = reply.rejected.map((x) => ({ description: "an action the model wrote", reason: x.reason ?? "not in a shape the Studio accepts" }));
      if (reply.actions.length) patch.opKey = recordProposal(text, reply.actions, { source: "model", intent, apiCalls: [call(d)], warnings: failed.map((f) => `Dropped: ${f.reason}`) }, session.openOp);
      else patch.opKey = recordOp({ prompt: text, source: "model", status: reply.kind === "clarify" ? "clarify" : "answered", intent, apiCalls: [call(d)], failed, statusDetail: reply.reply.slice(0, 2000) });
      if (reply.actions.length) {
        // a proposal — or a revision of the open one
        opts.patchAll((e) => (e.proposal === "open" ? { proposal: "superseded" } : null));
        setSession((x) => {
          const base = x.proposal ? (stale ? rebaseProposal(x.proposal, s.def) : x.proposal) : { base: s.def, steps: [] };
          const uxOnly = !!(d.context as { uxOnly?: boolean } | undefined)?.uxOnly;
          const uxOnlyInferred = !!(d.context as { uxOnlyInferred?: boolean } | undefined)?.uxOnlyInferred;
          return { ...x, proposal: { base: base.base, steps: withStep(base.steps, { request: text, actions: reply.actions, ...(uxOnly ? { uxOnly } : {}), ...(uxOnly && uxOnlyInferred ? { uxOnlyInferred } : {}) }) }, openOp: patch.opKey ?? x.openOp, confirmed: false, excluded: [], tab: "changes" };
        });
        patch.proposal = "open";
      }
      if (review || reply.kind === "review") setSession((x) => ({ ...x, review: { rules: review ?? x.review?.rules ?? reviewSurvey(s.def), ai: reply.findings, at: new Date().toISOString(), running: false }, tab: reply.actions.length ? "changes" : "review" }));
      opts.patch(id, patch);
      return "handled";
    } catch (e) {
      /* an exception in the page: a sentence and a retry — the raw JavaScript message goes to the console, never to the card */
      const failure = failureFromException(e);
      console.warn("[rescript:copilot] turn failed in the page", e);
      const error = failure.message;
      opts.patch(id, { status: "failed", error, failure, progress: undefined, opKey: recordOp({ prompt: text, source: "model", status: "failed", intent: { ...read, mode: mode ?? "" }, statusDetail: `${failure.title}: ${failure.message}`, apiCalls: [{ route: "/api/copilot/turn", mode: mode ?? "", charge: 0, error: `${failure.title}: ${failure.message}` }] }) });
      return "handled";
    } finally {
      setBusy(false);
    }
  }, [session.proposal, session.openOp, stale, s.def, s.surveyDbId, opts, copilotTurns, setSession, themeImage, quotaCounts, runForTurn, recordOp, recordProposal, planFirst, executionMode]);

  const ask = React.useCallback(async (text: string, heard?: HeardTranscript, mode?: "review" | "generate", handoff?: EngineHandoff): Promise<"handled" | "unavailable" | "empty"> => {
    const id = uid("copilot");
    opts.push({ id, kind: "copilot", text, ...(heard ? { heard } : {}), ...(handoff ? { handoff } : {}), status: "thinking" });
    return run(id, text, mode, {}, handoff);
  }, [opts, run]);

  /** the approved items of a change plan, built one call each into one proposal on the same card */
  const executePlan = React.useCallback(async (entryId: string, items: string[]): Promise<void> => {
    const entry = copilotTurns.find((t) => t.id === entryId);
    if (!entry?.changePlan || entry.status !== "plan" || !items.length) return;
    const mode = (entry.context?.mode === "generate" ? "generate" : undefined) as "generate" | undefined;
    opts.patch(entryId, { status: "thinking", changePlan: { ...entry.changePlan, approved: items } });
    await run(entryId, entry.text, mode, { stage: "execute", plan: entry.changePlan, items });
  }, [copilotTurns, opts, run]);

  /*
   * KEEPING AND RESUMING THE WORK. The checkpoint of a card (its words, its
   * plan, the items built) is in memory and in the browser's storage. After a
   * pause — a busy provider, a connection to fix, a reload — Resume sends it
   * again from where it stopped; Review what's ready turns what exists into a
   * proposal; Build the rest continues a partial one; Discard lets it go.
   */
  const checkpointOf = React.useCallback((entryId: string): Checkpoint | null => {
    const mem = checkpointRef.current.get(entryId);
    if (mem) return mem;
    let store: Storage | null = null; try { store = window.localStorage; } catch { /* a private window */ }
    const cp = loadCheckpoint(store, s.surveyDbId);
    return cp && cp.entryId === entryId ? cp : null;
  }, [s.surveyDbId]);
  const resume = React.useCallback(async (entryId: string): Promise<void> => {
    const cp = checkpointOf(entryId);
    if (!cp) return;
    opts.patch(entryId, { status: "thinking", error: undefined, failure: undefined, progress: { phase: "resuming", message: STATUS.resuming }, ...(cp.kind === "build" ? {} : {}) });
    await run(entryId, cp.text, cp.mode, cp.kind === "build" ? { stage: "execute", plan: cp.plan, items: cp.items, done: [...cp.built, ...(cp.applied ?? []).map((a) => ({ ...a, applied: true }))] } : {});
  }, [checkpointOf, opts, run]);
  /** open what is built so far as a proposal; the items still to build stay pending */
  const reviewReady = React.useCallback(async (entryId: string): Promise<void> => {
    const cp = checkpointOf(entryId);
    if (!cp || cp.kind !== "build" || !cp.built.length) return;
    opts.patch(entryId, { status: "thinking", error: undefined, failure: undefined, progress: { phase: "resuming", message: STATUS.resuming } });
    await run(entryId, cp.text, cp.mode, { stage: "execute", plan: cp.plan, items: cp.items, finalize: true, done: [...cp.built, ...(cp.applied ?? []).map((a) => ({ ...a, applied: true }))] });
  }, [checkpointOf, opts, run]);
  /** a partial proposal's remaining items, built on a new card as a revision of the open proposal */
  const buildRemaining = React.useCallback(async (entryId: string): Promise<void> => {
    const cp = checkpointOf(entryId);
    if (!cp || cp.kind !== "build" || !cp.items?.length) return;
    const id = uid("copilot");
    opts.push({ id, kind: "copilot", text: `Build the remaining ${cp.items.length} item${cp.items.length === 1 ? "" : "s"} of the plan`, status: "thinking", changePlan: { ...(cp.plan as ChangePlan), approved: cp.items } });
    checkpointRef.current.delete(entryId);
    await run(id, cp.text, cp.mode, { stage: "execute", plan: cp.plan, items: cp.items, done: (cp.applied ?? []).map((a) => ({ ...a, applied: true })) });
  }, [checkpointOf, opts, run]);
  /** end the current wait now and try again */
  const resumeNow = React.useCallback((entryId: string) => { wakeRef.current.get(entryId)?.(); }, []);
  const discardWork = React.useCallback((entryId: string) => {
    checkpointRef.current.delete(entryId);
    try { clearCheckpoint(window.localStorage, s.surveyDbId); } catch { /* a private window */ }
    opts.patch(entryId, { status: "empty", message: "The saved work was discarded.", failure: undefined, error: undefined, work: undefined, progress: undefined });
  }, [opts, s.surveyDbId]);
  /* a reload in the middle of a generation: the request, the plan and the items built come back as a card that offers to carry on */
  const restoredRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (restoredRef.current === s.surveyDbId) return;
    restoredRef.current = s.surveyDbId;
    let store: Storage | null = null; try { store = window.localStorage; } catch { return; }
    const cp = loadCheckpoint(store, s.surveyDbId);
    if (!cp || copilotTurns.some((t) => t.id === cp.entryId)) return;
    checkpointRef.current.set(cp.entryId, cp);
    const failure = interruptedFailure(cp);
    const total = cp.items?.length ?? 0;
    opts.push({ id: cp.entryId, kind: "copilot", text: cp.text, status: "failed", error: failure.message, failure, ...(cp.kind === "build" ? { changePlan: { ...(cp.plan as ChangePlan), approved: cp.items ?? [] }, work: { built: cp.built.length, total, pending: pendingIds(cp.items ?? [], cp.built, cp.failed).length, failed: cp.failed.length } } : {}) });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.surveyDbId]);

  /*
   * THE EXECUTION PANEL'S DRIVER (2026-10-29, docs/EXECUTION-ENGINE-2026-10-29.md). The task lives on the server;
   * this page only carries it on (POST …/advance: one slice of one or two steps under the researcher's own meter,
   * safe to repeat and to run beside the cron) and shows its persisted state. A reload, a navigation away and
   * back, a dropped connection: the effect below finds the survey's open task again and reattaches. Nothing here
   * decides success — the panel shows what the server says, and the work carries on in the background (the cron)
   * when this page is gone.
   */
  const [taskDurable, setTaskDurable] = React.useState(false);
  const taskDrivers = React.useRef(new Map<string, { stop: boolean }>());
  const taskDriveRef = React.useRef(true);
  const taskBudgetRef = React.useRef<number | null>(null);
  const driveTaskRef = React.useRef<((entryId: string, taskId: string) => Promise<void>) | null>(null);
  React.useEffect(() => {
    /* TEST SEAMS (fake provider only): `__rescriptCopilotTaskDrive(false)` stops the page's own advance loop (the panel then only polls); `__rescriptCopilotTaskBudget(ms)` caps each advance */
    const w = window as unknown as { __rescriptCopilotTaskDrive?: (on: boolean) => void; __rescriptCopilotTaskBudget?: (ms: number | null) => void };
    w.__rescriptCopilotTaskDrive = (on) => { taskDriveRef.current = on !== false; };
    w.__rescriptCopilotTaskBudget = (ms) => { taskBudgetRef.current = typeof ms === "number" && ms > 0 ? ms : null; };
    return () => { delete w.__rescriptCopilotTaskDrive; delete w.__rescriptCopilotTaskBudget; };
  }, []);
  const taskCall = React.useCallback(async (path: string, body?: Record<string, unknown>): Promise<{ status: number; d: Record<string, unknown> | null }> => {
    try {
      const r = body ? await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: s.surveyDbId, ...(cloudOnce ? { aiOnce: true } : {}), ...body }) }) : await fetch(path, { cache: "no-store" });
      return { status: r.status, d: await r.json().catch(() => null) as Record<string, unknown> | null };
    } catch { return { status: 0, d: null }; }
  }, [s.surveyDbId, cloudOnce]);
  const taskQuery = `surveyId=${encodeURIComponent(s.surveyDbId)}`;
  const driveTask = React.useCallback(async (entryId: string, taskId: string): Promise<void> => {
    if (taskDrivers.current.has(taskId)) return;
    const h = { stop: false };
    taskDrivers.current.set(taskId, h);
    let fails = 0;
    try {
      while (!h.stop) {
        const drive = taskDriveRef.current;
        const r = drive ? await taskCall(`/api/copilot/tasks/${taskId}/advance`, { ...(taskBudgetRef.current ? { budgetMs: taskBudgetRef.current } : {}) }) : await taskCall(`/api/copilot/tasks/${taskId}?${taskQuery}`);
        if (h.stop) break;
        const v = r.d?.task as TaskClientView | undefined;
        if (v) { opts.patch(entryId, { task: v, usage: { charge: Number(v.spend?.charge) || 0 } }); fails = 0; } else fails++;
        if (r.status === 404 || r.status === 401 || r.status === 403 || fails > 6) break;
        if (v && v.drive !== "advance") break;
        const slice = r.d?.slice as { stoppedBy?: string; retryAfterMs?: number } | null | undefined;
        /* a dropped connection or a server restart: wait and carry on (the server kept everything) */
        const wait = !v ? Math.min(30_000, 1000 * 2 ** Math.min(fails, 5)) : !drive ? 2500 : slice?.retryAfterMs ? Math.min(60_000, slice.retryAfterMs) : slice?.stoppedBy === "backoff" ? 3000 : 250;
        await new Promise((res) => setTimeout(res, wait));
      }
    } finally { taskDrivers.current.delete(taskId); }
  }, [opts, taskCall, taskQuery]);
  driveTaskRef.current = driveTask;
  /* leaving the page stops this page's loop (the cron carries the task on); coming back reattaches */
  React.useEffect(() => () => { for (const h of taskDrivers.current.values()) h.stop = true; }, []);
  const reattachedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (reattachedRef.current === s.surveyDbId) return;
    reattachedRef.current = s.surveyDbId;
    void (async () => {
      const r = await taskCall(`/api/copilot/tasks?${taskQuery}`);
      const v = r.d?.task as TaskClientView | null | undefined;
      setTaskDurable(r.d?.durable === true);
      if (!v || v.status === "cancelled" || v.status === "completed" || v.status === "failed") return;
      const existing = (opts.entries as CopilotEntry[]).find((e) => e.task?.id === v.id);
      const entryId = existing?.id ?? uid("copilot");
      if (!existing) opts.push({ id: entryId, kind: "copilot", text: v.deliverables?.length ? `Task: ${v.deliverables.join(", ")}` : "A task in progress", status: "task", task: v });
      if (v.drive === "advance") void driveTask(entryId, v.id);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.surveyDbId]);
  /** the panel's buttons: pause / resume / retry / cancel — then carry on driving when it runs again */
  const taskAction = React.useCallback(async (entryId: string, action: "pause" | "cancel" | "resume" | "retry" | "advance" | "refresh", stepId?: string): Promise<void> => {
    const e = (opts.entries as CopilotEntry[]).find((x) => x.id === entryId);
    const tid = e?.task?.id;
    if (!tid) return;
    if (action === "pause" || action === "cancel") { const h = taskDrivers.current.get(tid); if (h) h.stop = true; }
    const r = action === "refresh" ? await taskCall(`/api/copilot/tasks/${tid}?${taskQuery}`) : action === "advance" ? { d: null, status: 0 } : await taskCall(`/api/copilot/tasks/${tid}/${action}`, stepId ? { stepId } : {});
    const v = r.d?.task as TaskClientView | undefined;
    if (v) opts.patch(entryId, { task: v });
    if (action === "advance" || (v && v.drive === "advance")) void driveTask(entryId, tid);
  }, [opts, taskCall, taskQuery, driveTask]);
  /** the completed task's result, opened as ONE proposal in the ordinary review → Apply (History, undo) */
  const openTaskResult = React.useCallback(async (entryId: string): Promise<{ ok: boolean; reason?: string }> => {
    const e = (opts.entries as CopilotEntry[]).find((x) => x.id === entryId);
    const tid = e?.task?.id;
    if (!tid || e.task?.status !== "completed") return { ok: false, reason: "The task has not completed." };
    const r = await taskCall(`/api/copilot/tasks/${tid}?${taskQuery}&result=1`);
    const res = r.d?.result as { actions?: SurveyAction[] } | null | undefined;
    if (!res) return { ok: false, reason: "The result could not be read — try again." };
    const actions = Array.isArray(res.actions) ? res.actions : [];
    const reply: CopilotReply = { kind: actions.length ? "proposal" : "answer", reply: actions.length ? `The task is complete: ${actions.length} change${actions.length === 1 ? "" : "s"} are ready to review.` : "The task is complete; it proposed no change.", plan: [], actions, rejected: [], findings: [], assumptions: [], questions: [], sources: [] };
    const opKey = actions.length ? recordProposal(e.text, actions, { source: "model", intent: { engine: "model", mode: "task", kind: "proposal" }, apiCalls: [{ route: "/api/copilot/tasks", mode: "task", charge: Number(e.task?.spend?.charge) || 0 }] }, session.openOp) : undefined;
    if (actions.length) {
      opts.patchAll((x) => (x.proposal === "open" ? { proposal: "superseded" } : null));
      setSession((x) => {
        const base = x.proposal ? (stale ? rebaseProposal(x.proposal, s.def) : x.proposal) : { base: s.def, steps: [] };
        return { ...x, proposal: { base: base.base, steps: withStep(base.steps, { request: e.text, actions }) }, openOp: opKey ?? x.openOp, confirmed: false, excluded: [], tab: "changes" };
      });
    }
    opts.patch(entryId, { status: "ready", reply, ...(actions.length ? { proposal: "open" as const, opKey } : {}), usage: { charge: Number(e.task?.spend?.charge) || 0 } });
    return { ok: true };
  }, [opts, taskCall, taskQuery, recordProposal, session.openOp, setSession, stale, s.def]);
  /** the task the execution panel shows: the newest entry that carries one */
  const activeTask = React.useMemo(() => { const es = (opts.entries as CopilotEntry[]).filter((e) => e.kind === "copilot" && e.task); const e = es[es.length - 1]; return e ? { entryId: e.id, task: e.task! } : null; }, [opts.entries]);

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
  const local = React.useCallback((text: string, it: Exclude<Interpretation, { kind: "model" | "workflow" }>, heard?: HeardTranscript, workflowStep?: string): void => {
    const id = uid("copilot");
    const actions = it.kind === "actions" ? it.actions : [];
    const reply: CopilotReply = {
      kind: it.kind === "actions" ? "proposal" : it.kind === "clarify" ? "clarify" : "answer",
      /* the engine's "outside Intelligent Mode" sentence in the researcher's language (notices.ts) */
      reply: it.kind === "answer" ? it.answer : it.kind === "clarify" ? it.question : it.kind === "refused" ? (it.reason === UNSUPPORTED_MESSAGE ? NOTICES.unsupported(replyLanguage(text), it.reason) : it.reason) : it.understood,
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
    const intent: OpIntent = { category: it.category ?? null, kind: it.kind, engine: it.kind, ...(it.kind === "actions" ? { ops: it.actions.map((a) => a.op).join(",").slice(0, 500) } : {}), ...(opts.selectedId ? { selected: opts.selectedId } : {}), ...(workflowStep ? { workflow: workflowStep } : {}) };
    const opKey = actions.length
      ? recordProposal(text, actions, { source: "engine", intent, detected: it.detected, targets: it.kind === "actions" ? it.targets : [], warnings: it.kind === "actions" ? it.warnings : undefined }, session.openOp)
      : recordOp({ prompt: text, source: "engine", status: it.kind === "answer" ? "answered" : it.kind === "clarify" ? "clarify" : "refused", intent, detected: it.detected, statusDetail: (it.kind === "answer" ? it.answer : it.kind === "clarify" ? it.question : it.kind === "refused" ? it.reason : it.understood).slice(0, 2000), ...(it.kind === "refused" && it.suggestion?.actions?.length ? { proposed: proposedOf(it.suggestion.actions) } : {}) });
    if (actions.length) {
      opts.patchAll((e) => (e.proposal === "open" ? { proposal: "superseded" } : null));
      setSession((x) => {
        const base = x.proposal ? (stale ? rebaseProposal(x.proposal, s.def) : x.proposal) : { base: s.def, steps: [] };
        return { ...x, proposal: { base: base.base, steps: withStep(base.steps, { request: text, actions }) }, openOp: opKey, confirmed: false, excluded: [], tab: "changes" };
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
      opts.patch(id, { status: "ready", reply: { kind: "answer", reply: message, plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] }, engine: { ...engine, kind: "refused", refusal: message }, opKey: recordOp({ prompt: text, source: "engine", status: "refused", intent: { category: it.category, kind: "query", engine: "query", ...(opts.selectedId ? { selected: opts.selectedId } : {}) }, detected: it.detected, statusDetail: message.slice(0, 2000) }) });
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
      opts.patch(id, { status: "ready", data, reply: { kind: "answer", reply: a.text, plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] }, engine: { ...engine, kind: "answer", sections: a.sections }, opKey: recordOp({ prompt: text, source: "engine", status: "answered", intent: { category: it.category, kind: "query", engine: "query", ...(opts.selectedId ? { selected: opts.selectedId } : {}) }, detected: it.detected, statusDetail: a.text.slice(0, 2000), apiCalls: [{ route: "/api/copilot/ask", mode: "data", charge: 0 }] }) });
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
  const makeOutput = React.useCallback(async (text: string, it: Extract<Interpretation, { kind: "output" }>, heard?: HeardTranscript, workflowStep?: string, how: { regenerate?: boolean } = {}): Promise<void> => {
    const id = uid("copilot");
    const engine: EngineTurn = { kind: "output", category: it.category, understood: it.understood, detected: it.detected };
    const reply = (r: string): CopilotReply => ({ kind: "answer", reply: r, plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] });
    opts.push({ id, kind: "copilot", text, ...(heard ? { heard } : {}), status: "thinking", reply: reply(it.understood), engine });
    setBusy(true);
    const fail = (message: string) => opts.patch(id, { status: "ready", reply: reply(message), engine: { ...engine, kind: "refused", refusal: message }, opKey: recordOp({ prompt: text, source: "engine", status: "refused", intent: { category: it.category, kind: "output", engine: "output" }, detected: it.detected, statusDetail: message.slice(0, 2000) }) });
    try {
      const sandbox = s.surveyDbId === "sandbox";
      const rows = sandbox ? rowsRef.current : null;
      /* the documents made from the design alone (the proposal, the research plan, the SAP) need no respondents — the sandbox used to refuse the SAP and the plan as if they were findings (2026-10-17) */
      if (sandbox && !["proposal_docx", "research_plan_docx", "sap_docx"].includes(it.output.type) && !rows?.length) { fail("The sandbox has no respondents to report on. Open a survey with fieldwork and ask there — the report and the deck come from a run of its data."); return; }
      const regenerate = how.regenerate === true || it.output.regenerate === true;
      /* the sandbox keeps its documents in this tab (sandbox only): the same inputs again are the same document — no request, nothing generated (2026-10-18) */
      const atype = it.output.type as ArtifactType;
      const sbx = sandbox ? sandboxTheme(sessionStore()) : null;
      const sbxFp = sandbox ? sandboxFingerprint({ type: atype, audience: it.output.audience, def: s.def, theme: sbx?.theme, structure: sbx?.structure, rows }) : null;
      const kept = sandbox && !regenerate && sbxFp ? sandboxFind(sessionStore(), atype, editionOf(atype, it.output.audience), sbxFp) : null;
      if (kept) {
        const bytes = fromBase64(kept.base64);
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: kept.mime }));
        const output: NonNullable<CopilotEntry["output"]> = { name: kept.name, size: kept.size, url, kind: kept.name.endsWith(".pptx") ? "pptx" : "docx", summary: kept.summary ?? "", ...(kept.narrative ? { narrative: kept.narrative } : {}), type: kept.type, edition: kept.edition, artifactId: kept.id, version: kept.version, fingerprint: kept.fingerprint, reused: true };
        const said = `${it.output.words[0].toUpperCase()}${it.output.words.slice(1)} is ready: ${kept.name} (${Math.round(kept.size / 1024)} KB). ${kept.summary ?? ""} Version ${kept.version}, kept from earlier — nothing changed, so nothing was regenerated.`;
        opts.patch(id, { status: "ready", output, reply: reply(said), engine: { ...engine, kind: "answer" }, opKey: recordOp({ prompt: text, source: "engine", status: "answered", intent: { category: it.category, kind: "output", engine: "output", ...(workflowStep ? { workflow: workflowStep } : {}) }, detected: it.detected, statusDetail: said.slice(0, 2000) }) });
        return;
      }
      const fake = sandbox ? fakeRef.current.shift() : undefined;
      const r = await fetch("/api/copilot/output", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: s.surveyDbId, output: { ...it.output, ...(regenerate ? { regenerate: true } : {}) }, source: workflowStep ? "workflow" : "copilot", ...(executionMode === "internal" ? { narrative: false } : {}), ...(sandbox ? { definition: s.def, rows, ...(fake ? { fake } : {}), ...(sbx?.theme ? { theme: sbx.theme } : {}), ...(sbx?.structure ? { structure: sbx.structure } : {}) } : {}) }) });
      if (!r.ok) { const d = await r.json().catch(() => null) as { error?: string } | null; fail(d?.error ?? (r.status === 401 ? "Sign in to produce documents for this survey." : `The document could not be produced (HTTP ${r.status}).`)); return; }
      const blob = await r.blob();
      /* a document is offered only when it is one: never an empty or non-ZIP body behind a "ready" card (2026-10-17) */
      const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
      if (blob.size < 100 || head[0] !== 0x50 || head[1] !== 0x4b) { fail(`The document could not be produced: the server sent ${blob.size ? "something that is not a Word or PowerPoint file" : "an empty file"}. Try again.`); return; }
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? `output.${it.output.type.endsWith("pptx") ? "pptx" : "docx"}`;
      const summary = r.headers.get("x-rescript-output") ?? "";
      const narrative = r.headers.get("x-rescript-narrative") ?? undefined;
      const url = URL.createObjectURL(blob);
      /* which kept version this is (a saved project), or keep it in the tab (the sandbox) */
      let artifactId = r.headers.get("x-rescript-artifact-id") ?? undefined;
      let version = Number(r.headers.get("x-rescript-artifact-version") ?? "") || undefined;
      const reused = r.headers.get("x-rescript-artifact-reused") === "1";
      const note = r.headers.get("x-rescript-artifact-note") ?? undefined;
      const themeName = r.headers.get("x-rescript-theme") ?? undefined;
      const fingerprint = sbxFp ?? r.headers.get("x-rescript-artifact-fingerprint") ?? undefined;
      if (sandbox && sbxFp) {
        const keptNow = sandboxPut(sessionStore(), { type: atype, edition: editionOf(atype, it.output.audience), fingerprint: sbxFp, name, mime: blob.type || mimeOf(atype), summary, narrative: narrative ?? null, regenerate }, new Uint8Array(await blob.arrayBuffer()));
        if (keptNow) { artifactId = keptNow.id; version = keptNow.version; }
      }
      const output: NonNullable<CopilotEntry["output"]> = { name, size: blob.size, url, kind: name.endsWith(".pptx") ? "pptx" : "docx", summary, ...(narrative ? { narrative } : {}), type: atype, edition: editionOf(atype, it.output.audience), ...(artifactId ? { artifactId } : {}), ...(version ? { version } : {}), ...(fingerprint ? { fingerprint } : {}), reused, ...(note ? { note } : {}), ...(themeName ? { theme: themeName } : {}) };
      /* the first sentence is what it always was (the suites read it); what is kept, and the theme, follow */
      const said = `${it.output.words[0].toUpperCase()}${it.output.words.slice(1)} is ready: ${name} (${Math.round(blob.size / 1024)} KB). ${summary}${narrative ? ` Narrative gate: ${narrative}.` : ""}${version ? ` Version ${version}${reused ? ", kept from earlier — nothing changed, so nothing was regenerated" : ""}.` : ""}${themeName ? ` Theme: ${themeName}.` : ""}${note ? ` ${note}` : ""}`;
      opts.patch(id, { status: "ready", output, reply: reply(said), engine: { ...engine, kind: "answer" }, opKey: recordOp({ prompt: text, source: "engine", status: "answered", intent: { category: it.category, kind: "output", engine: "output", ...(workflowStep ? { workflow: workflowStep } : {}) }, detected: it.detected, statusDetail: said.slice(0, 2000), apiCalls: [{ route: "/api/copilot/output", mode: it.output.type, charge: 0 }] }) });
      /* the workflow's own outputs are marked produced (the deck, the design document) */
      const produced = it.output.type === "proposal_docx" || it.output.type === "research_plan_docx" ? "design_document" : it.output.type === "findings_pptx" ? "deck" : null;
      if (produced && !producedRef.current.includes(produced)) { producedRef.current = [...producedRef.current, produced]; setWorkflowInfo((x) => (x ? { ...x } : x)); }
    } catch (e) {
      fail(`The document could not be produced: ${(e as Error).message || "the network request failed"}.`);
    } finally { setBusy(false); }
  }, [opts, s.surveyDbId, s.def, recordOp, executionMode]);

  /*
   * KEPT DOCUMENTS AFTER A RELOAD (2026-10-18). The cards the copilot made are page state; the documents
   * are not. On opening a survey the copilot asks which documents are kept (a saved project: the
   * artifacts list; the sandbox: this tab's copies) and offers each document line's latest version again
   * — Download takes the stored file, nothing is generated; "a new version is available" when what it is
   * made from changed since.
   */
  const restoredDocsRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (restoredDocsRef.current === s.surveyDbId) return;
    restoredDocsRef.current = s.surveyDbId;
    let live = true;
    let done = s.surveyDbId === "sandbox";
    const card = (o: NonNullable<CopilotEntry["output"]>, label: string, when: string) => opts.push({ id: uid("copilot"), kind: "copilot", text: `${label} — kept`, status: "ready", output: o, reply: { kind: "answer", reply: `${label}, version ${o.version} (${when.slice(0, 10)}) is kept: ${o.name}. Download takes the stored file${o.stale ? " — the design, the data or the theme changed since, so a new version is available" : ""}.`, plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] } });
    (async () => {
      if (s.surveyDbId === "sandbox") {
        const st = sandboxTheme(sessionStore());
        for (const l of sandboxLines(sessionStore())) {
          const now = sandboxFingerprint({ type: l.type, audience: l.edition, def: s.def, theme: st.theme, structure: st.structure, rows: rowsRef.current });
          card({ name: l.latest.name, size: l.latest.size, url: "", kind: l.latest.name.endsWith(".pptx") ? "pptx" : "docx", summary: l.latest.summary ?? "", type: l.type, edition: l.edition, artifactId: l.latest.id, version: l.latest.version, fingerprint: l.latest.fingerprint, restored: true, stale: now !== l.latest.fingerprint }, ARTIFACT_LABEL[l.type] ?? l.type, l.latest.createdAt);
        }
        return;
      }
      const got = await fetchArtifactLines(s.surveyDbId);
      if (!live) return;
      done = true;
      if (!got.ok) return;
      for (const l of got.lines.filter((x) => x.latest.source === "copilot" || x.latest.source === "workflow")) {
        card({ name: l.latest.name, size: l.latest.size, url: "", kind: l.latest.name.endsWith(".pptx") ? "pptx" : "docx", summary: l.latest.summary ?? "", ...(l.latest.narrative ? { narrative: l.latest.narrative } : {}), type: l.type, edition: l.edition, artifactId: l.latest.id, version: l.latest.version, fingerprint: l.latest.fingerprint, restored: true, stale: l.state === "stale" }, l.label, l.latest.createdAt);
      }
    })().catch(() => { /* nothing kept to offer: the conversation starts empty, as before */ });
    /* an effect torn down before its answer came (React's development double-mount does exactly this) must let the next run ask again — or the cards never come back */
    return () => { live = false; if (!done) restoredDocsRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.surveyDbId]);

  /* the sandbox recomputes "a new version is available" as the design changes (a saved project learns it from the artifacts list on the next open) */
  React.useEffect(() => {
    if (s.surveyDbId !== "sandbox") return;
    const t = window.setTimeout(() => {
      const st = sandboxTheme(sessionStore());
      opts.patchAll((x) => {
        const o = x.output;
        if (!o?.fingerprint || !o.type || !isArtifactType(o.type)) return null;
        const stale = sandboxFingerprint({ type: o.type, audience: o.edition, def: s.def, theme: st.theme, structure: st.structure, rows: rowsRef.current }) !== o.fingerprint;
        return stale === !!o.stale ? null : { output: { ...o, stale } };
      });
    }, 300);
    return () => window.clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.def, s.surveyDbId]);

  /** Download on a card: the bytes this page holds, the tab's copy (sandbox), or a fresh signed link to the kept file — never a regeneration */
  const downloadOutput = React.useCallback(async (entryId: string): Promise<{ ok: boolean; error?: string }> => {
    const e = copilotTurns.find((t) => t.id === entryId);
    const o = e?.output;
    if (!o) return { ok: false, error: "Nothing to download." };
    if (o.url) { saveUrl(o.url, o.name); return { ok: true }; }
    if (s.surveyDbId === "sandbox") {
      const kept = o.artifactId ? sandboxGet(sessionStore(), o.artifactId) : null;
      if (!kept) { const error = "This tab no longer holds that document (the sandbox keeps two versions per document). Ask for it again."; opts.patch(entryId, { output: { ...o, note: error } }); return { ok: false, error }; }
      saveBytes(fromBase64(kept.base64), kept.name, kept.mime);
      return { ok: true };
    }
    if (!o.artifactId) return { ok: false, error: "This document was not kept — ask for it again." };
    const link = await fetchArtifactLink(s.surveyDbId, o.artifactId);
    if (!link.ok) { opts.patch(entryId, { output: { ...o, note: link.error } }); return { ok: false, error: link.error }; }
    saveUrl(link.link.url, link.link.name);
    return { ok: true };
  }, [copilotTurns, s.surveyDbId, opts]);

  /** "a new version is available" → Regenerate: the same document, made again from what it is made from now */
  const regenerateOutput = React.useCallback(async (entryId: string): Promise<void> => {
    const o = copilotTurns.find((t) => t.id === entryId)?.output;
    if (!o?.type || !isArtifactType(o.type)) return;
    const words = ARTIFACT_LABEL[o.type] ?? o.type;
    const audience = o.edition === "executive" || o.edition === "researcher" ? o.edition : "client";
    await makeOutput(`Regenerate ${words.toLowerCase()}`, { kind: "output", category: "reporting", understood: `Regenerate ${words.toLowerCase()} from what it is made from now.`, output: { type: o.type, audience, words: words.toLowerCase() }, detected: [] }, undefined, undefined, { regenerate: !o.stale });
    opts.patch(entryId, { output: { ...o, stale: false } });
  }, [copilotTurns, makeOutput, opts]);

  /* ------------------------------------------------------------ report themes (2026-10-18) */
  const themeRequest = React.useCallback(async (text: string, it: Extract<Interpretation, { kind: "theme" }>, heard?: HeardTranscript): Promise<void> => {
    const id = uid("copilot");
    const engine: EngineTurn = { kind: "answer", category: it.category, understood: it.understood, detected: it.detected };
    const reply = (r: string): CopilotReply => ({ kind: "answer", reply: r, plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] });
    opts.push({ id, kind: "copilot", text, ...(heard ? { heard } : {}), status: "thinking", reply: reply(it.understood), engine });
    const t = await themeTurn(text, it.request, { surveyId: s.surveyDbId, def: s.def, store: sessionStore() });
    opts.patch(id, { status: "ready", theme: t.card, reply: reply(t.said), engine, opKey: recordOp({ prompt: text, source: "engine", status: "answered", intent: { category: it.category, kind: "theme", engine: "theme", ops: it.request.op }, detected: it.detected, statusDetail: t.said.slice(0, 2000) }) });
  }, [opts, s.surveyDbId, s.def, recordOp]);
  const themeCardAction = React.useCallback(async (entryId: string, action: { kind: "apply" } | { kind: "save"; name: string; scope: "user" | "org" } | { kind: "model" }): Promise<void> => {
    const e = copilotTurns.find((t) => t.id === entryId);
    if (!e?.theme) return;
    const ctx = { surveyId: s.surveyDbId, def: s.def, store: sessionStore() };
    const r = action.kind === "apply" ? await applyThemeTurn(e.theme, ctx) : action.kind === "save" ? await saveThemeTurn(e.theme, action.name, action.scope, ctx) : await themeWithModel(e.text, e.theme, ctx);
    opts.patch(entryId, { theme: r.card, reply: { kind: "answer", reply: r.said, plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] } });
    /* the kept documents' cards now say whether a new version is available under the new look */
    if (action.kind !== "model" && r.card.status !== "preview") opts.patchAll((x) => (x.output?.artifactId && x.output.fingerprint && x.output.type && isArtifactType(x.output.type) && s.surveyDbId === "sandbox" ? { output: { ...x.output, stale: sandboxFingerprint({ type: x.output.type, audience: x.output.edition, def: s.def, theme: sandboxTheme(sessionStore()).theme, structure: sandboxTheme(sessionStore()).structure, rows: rowsRef.current }) !== x.output.fingerprint } } : x.output?.artifactId && s.surveyDbId !== "sandbox" ? { output: { ...x.output, stale: true } } : null));
  }, [copilotTurns, s.surveyDbId, s.def, opts]);
  /* ------------------------------------------------------------ qualitative synthesis requests (F2 2026-10-22) */
  const qualRequest = React.useCallback(async (text: string, req: QualRequest, heard?: HeardTranscript): Promise<void> => {
    const id = uid("copilot");
    const engine: EngineTurn = { kind: "answer", category: "analysis", understood: req.text, detected: [{ what: "qualitative request", value: req.op }] };
    const reply = (r: string): CopilotReply => ({ kind: "answer", reply: r, plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] });
    opts.push({ id, kind: "copilot", text, ...(heard ? { heard } : {}), status: "thinking", reply: reply("Reading the coded data…"), engine });
    const t = await qualTurn(req, { surveyId: s.surveyDbId, def: s.def });
    opts.patch(id, { status: "ready", qual: t.card, reply: reply(t.said), engine, opKey: recordOp({ prompt: text, source: "engine", status: "answered", intent: { category: "analysis", kind: "qual", engine: "qual", ops: req.op }, detected: engine.detected, statusDetail: t.said.slice(0, 2000) }) });
  }, [opts, s.surveyDbId, s.def, recordOp]);
  const qualCardAction = React.useCallback(async (entryId: string): Promise<void> => {
    const e = copilotTurns.find((t) => t.id === entryId);
    if (!e?.qual || !(e.qual.status === "preview" || (e.qual.status === "failed" && e.qual.runnable))) return;
    /* a retry of a failed run starts from the preview again (the old error goes) */
    const { error: _old, ...ready } = e.qual;
    void _old;
    opts.patch(entryId, { qual: { ...ready, status: "running" } });
    const r = await runQualCard({ ...ready, status: "preview" }, { surveyId: s.surveyDbId, def: s.def });
    opts.patch(entryId, { qual: r.card, reply: { kind: "answer", reply: r.said, plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] } });
  }, [copilotTurns, s.surveyDbId, s.def, opts]);
  /** the survey a new request is read against: the open proposal's result, so a revision builds on what is proposed */
  const working: SurveyDefinition = React.useMemo(() => (session.proposal ? (stale ? evaluateProposal(rebaseProposal(session.proposal, s.def)).after : full?.after ?? s.def) : s.def), [session.proposal, stale, full, s.def]);
  /*
   * THE RESEARCH WORKFLOW (Phase 6). The planner is the engine's and runs
   * here, on the survey as it is (the open proposal included), so a step
   * applied is a step done at once; the route adds what only the server
   * knows — the project's execution mode, the model, the cost of each model
   * step priced before any call, whether fieldwork data exists.
   */
  const refreshWorkflow = React.useCallback(async (opt: { objective?: string; setMode?: ExecutionMode } = {}): Promise<WorkflowInfo | null> => {
    setWorkflowLoading(true);
    setWorkflowError(null);
    try {
      const sandbox = s.surveyDbId === "sandbox";
      const body = { surveyId: s.surveyDbId, ...(sandbox ? { definition: s.def, runAvailable: !!rowsRef.current?.length, mode: executionMode } : {}), ...(opt.objective ? { objective: opt.objective } : {}), ...(opt.setMode ? { setMode: opt.setMode } : {}), produced: producedRef.current };
      const r = await fetch("/api/copilot/workflow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const d = await r.json().catch(() => null) as { error?: string } | null; setWorkflowError(d?.error ?? (r.status === 401 ? "Sign in to see the workflow for this survey." : `The workflow could not be read (HTTP ${r.status}).`)); return null; }
      const d = await r.json() as WorkflowResponse;
      const { workflow: _w, ...info } = d;
      void _w;
      setWorkflowInfo(info);
      if (!sandbox && info.mode.project !== executionMode) { setExecutionModeState(info.mode.project); try { window.localStorage.setItem("rescript.copilot.mode", info.mode.project); } catch { /* a private window */ } }
      return info;
    } catch (e) { setWorkflowError(`The workflow could not be read: ${(e as Error).message || "the network request failed"}.`); return null; }
    finally { setWorkflowLoading(false); }
  }, [s.surveyDbId, s.def, executionMode]);
  const setExecutionMode = React.useCallback(async (mode: ExecutionMode) => {
    setExecutionModeState(mode);
    try { window.localStorage.setItem("rescript.copilot.mode", mode); } catch { /* a private window */ }
    if (s.surveyDbId !== "sandbox") await refreshWorkflow({ setMode: mode });
    else setWorkflowInfo((x) => (x ? { ...x, mode: { ...x.mode, project: mode, effective: x.model.configured ? mode : "internal", override: false } } : x));
  }, [s.surveyDbId, refreshWorkflow]);
  /** the workflow on the survey as it stands here, in the effective mode */
  const workflow: ResearchWorkflow = React.useMemo(() => researchWorkflow(working, { mode: workflowInfo ? workflowInfo.mode.effective : available === false ? "internal" : executionMode, runAvailable: workflowInfo?.runAvailable ?? (s.surveyDbId === "sandbox" ? !!rowsRef.current?.length : !!analysisRun), produced: producedRef.current, ...(workflowObjective ? { objective: workflowObjective } : {}) }), [working, workflowInfo, executionMode, available, workflowObjective, analysisRun, s.surveyDbId]);
  /** "start the research workflow for …": the card says where the study stands, the tab opens on the steps */
  const showWorkflow = React.useCallback(async (text: string, it: Extract<Interpretation, { kind: "workflow" }>, heard?: HeardTranscript): Promise<void> => {
    const id = uid("copilot");
    if (it.objective) setWorkflowObjective(it.objective);
    const engine: EngineTurn = { kind: "answer", category: it.category, understood: it.understood, detected: it.detected };
    const reply = (r: string): CopilotReply => ({ kind: "answer", reply: r, plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] });
    opts.push({ id, kind: "copilot", text, ...(heard ? { heard } : {}), status: "thinking", reply: reply(it.understood), engine });
    setSession((x) => ({ ...x, tab: "workflow" }));
    const info = await refreshWorkflow(it.objective ? { objective: it.objective } : {});
    const wf = researchWorkflow(working, { mode: info ? info.mode.effective : executionMode, runAvailable: info?.runAvailable ?? false, produced: producedRef.current, ...(it.objective ? { objective: it.objective } : {}) });
    const said = `${describeWorkflow(wf)}${info ? `\nExecution: ${info.mode.effective}${info.cost.steps.length ? ` · model steps from here: ${info.cost.steps.map((c) => `${c.id} (${c.tier}, ${c.model}, ${c.charge} credits)`).join(", ")}` : ""}` : ""}`;
    opts.patch(id, { status: "ready", reply: reply(said), opKey: recordOp({ prompt: text, source: "engine", status: "answered", intent: { category: it.category, kind: "workflow", engine: "workflow", ...(it.objective ? { objective: it.objective.slice(0, 200) } : {}) }, detected: it.detected, statusDetail: said.slice(0, 2000) }) });
  }, [opts, setSession, refreshWorkflow, working, executionMode, recordOp]);
  /** one step, as the researcher approved it: the engine's actions as a proposal, an output as a file, a model step as a model turn */
  const runWorkflowStep = React.useCallback(async (step: WorkflowStep): Promise<void> => {
    if (step.status === "ready" && step.executor === "output" && step.output) { await makeOutput(step.sentence ?? step.title, { kind: "output", category: "reporting", understood: `Produce ${step.output.words} (workflow: ${step.title.toLowerCase()}).`, output: step.output, detected: [] }, undefined, step.id); return; }
    if (step.status === "ready" && step.actions?.length) { local(step.sentence ?? step.title, { kind: "actions", category: "research_design", understood: `${step.title}: ${step.why}`, actions: step.actions, detected: [], targets: [] }, undefined, step.id); return; }
    if ((step.status === "model" || (step.status === "needs_input" && step.model)) && step.sentence) { await ask(step.sentence, undefined, undefined, { category: "research_design", reason: `workflow step ${step.id}: ${step.why}`, detected: [] }); }
  }, [makeOutput, local, ask]);

  /* ------------------------------------------------------------ review */
  const runReview = React.useCallback(async (text = "Review my survey") => {
    // the engine's own checks at once, for free; the model's reading follows
    setSession((x) => ({ ...x, review: { rules: reviewSurvey(s.def), ai: x.review?.ai ?? [], at: new Date().toISOString(), running: available !== false }, tab: "review" }));
    if (available === false) return;
    await ask(text, undefined, "review");
    setSession((x) => (x.review ? { ...x, review: { ...x.review, running: false } } : x));
  }, [s.def, available, ask, setSession]);

  /** the engine's review in the Review tab, and nothing else — for a review asked for in a sentence when no model's reading follows (none, or internal mode) */
  const showReview = React.useCallback(() => {
    setSession((x) => ({ ...x, review: { rules: reviewSurvey(s.def), ai: x.review?.ai ?? [], at: new Date().toISOString(), running: false }, tab: "review" }));
  }, [s.def, setSession]);

  /** a mechanical fix from the review (or a Reapply from History), previewed like any proposal — no model call; recorded as a "fix" */
  const previewFix = React.useCallback((actions: SurveyAction[], label: string, meta?: { intent?: OpIntent }) => {
    const opKey = recordProposal(label, actions, { source: "fix", intent: meta?.intent ?? { kind: "fix" } }, session.openOp);
    opts.patchAll((e) => (e.proposal === "open" ? { proposal: "superseded" } : null));
    setSession((x) => {
      const base = x.proposal ? (stale ? rebaseProposal(x.proposal, s.def) : x.proposal) : { base: s.def, steps: [] };
      return { ...x, proposal: { base: base.base, steps: withStep(base.steps, { request: label, actions }) }, openOp: opKey, confirmed: false, excluded: [], tab: "changes" };
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

  /**
   * "UNDO WHAT YOU JUST DID", SAID IN WORDS (production intents, 2026-10-18). "जो changes अभी आपने किया उसे
   * reward back कर दो" reached the model, which proposed "Remove the custom code of survey" (refused). Undo is
   * the Studio's own: an open proposal is set aside (nothing was applied); otherwise the last change is
   * restored exactly as the toolbar's "Undo AI change" restores it — and when later edits would go with it,
   * nothing is done and History says so, where Restore… asks first. No model call, nothing charged.
   */
  const undoLast = React.useCallback(async (text: string, heard?: HeardTranscript): Promise<{ ok: boolean; reason?: string }> => {
    const detected = [{ what: "read as", value: "undo the last Intelligent Mode change" }];
    const say = (understood: string, answer: string) => local(text, { kind: "answer", category: "survey_editing", understood, answer, sections: [], detected }, heard);
    if (session.proposal) {
      cancel();
      say("Undo: the open proposal, which was not applied.", "Nothing had been applied yet, so the open proposal was set aside and the survey is as it was. It stays in History, where Reapply proposes it again.");
      return { ok: true };
    }
    const k = lastUndoable(session.history, recorder.list());
    if (!k) { say("Undo: there is no change to undo.", "There is no Intelligent Mode change to undo in this survey's history — nothing was changed."); return { ok: false, reason: "nothing to undo" }; }
    const op = recorder.get(k);
    const tag = op?.changeN ? changeLabel(op.changeN).replace("AI Change", "AI change") : "the last AI change";
    const r = await restore(k);
    if (r.ok) say(`Undo: ${tag}${op?.prompt ? ` (“${op.prompt.slice(0, 80)}”)` : ""}.`, `Undone: ${tag} — the survey is back to how it was before it. Reapply it from History if you change your mind.`);
    else {
      setSession((x) => ({ ...x, tab: "history" }));
      say(`Undo: ${tag} — not done.`, `${r.reason ?? "It could not be undone."} Nothing was changed. History is open: Restore… on that change goes back anyway, after asking.`);
    }
    return r;
  }, [session.proposal, session.history, cancel, recorder, restore, local, setSession]);

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
    /* the language corpus (Phase 8): the project's sentences with their readings, as the server's file */
    exportCorpus: async (): Promise<{ ok: true; name: string; blob: Blob } | { ok: false; error: string }> => {
      const r = await fetch("/api/copilot/corpus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: key, ...(sandbox ? { scope: sandboxScope(), definition: s.def } : {}), download: true }) });
      if (!r.ok) { const j = await r.json().catch(() => null) as { error?: string } | null; return { ok: false, error: j?.error ?? r.statusText }; }
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "language-corpus.json";
      return { ok: true, name, blob: await r.blob() };
    },
    actionsOf: (k: string) => actionsByOp.get(k) ?? null,
    docs: session.docs ?? [], durable: session.durable, uploading, docError,
    confirmed: session.confirmed, setConfirmed: (v: boolean) => setSession((x) => ({ ...x, confirmed: v })),
    tab: session.tab, setTab: (t: PanelTab) => setSession((x) => ({ ...x, tab: t })),
    ask, local, askData, makeOutput, working, runReview, showReview, previewFix, apply, cancel, undoLast, uploadDocs, deleteDoc, refreshDocs,
    downloadOutput, regenerateOutput, themeRequest, themeCardAction, qualRequest, qualCardAction,
    planFirst, setPlanFirst, executePlan, cancelPlan, resume, reviewReady, buildRemaining, resumeNow, discardWork,
    taskAction, openTaskResult, activeTask, taskDurable,
    executionMode, setExecutionMode, cloudOnce, setCloudOnce, workflow, workflowInfo, workflowError, workflowLoading, workflowObjective, refreshWorkflow, showWorkflow, runWorkflowStep,
    themeImage, themeImageError, attachThemeImage, clearThemeImage: () => setThemeImage(null),
    quotaCounts, quotaCountsAt, refreshQuotaCounts,
    analysisRun, runDue, running, runError, refreshAnalysisRun, runPlanNow,
    lastReport, drafting, draftReport,
  };
}
export type Copilot = ReturnType<typeof useCopilot>;
