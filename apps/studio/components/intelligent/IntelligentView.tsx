"use client";
import React from "react";
import type { Condition, SurveyDefinition } from "@rescript/schema";
import { variantRegistry } from "@rescript/schema";
import {
  buildDependencyIndex, objectStatus, applyLogicProposal, proposalTargets, formatCondition, nextQuestionNaming,
  interpretRequest, DEFER_TO_GRAMMAR, diffSurveys,
  type ObjectKey,
  type SurveyAction,
} from "@rescript/engine";
import { useStudio, uid } from "../studio/store";
import { useSelection } from "../studio/SelectionContext";
import { useCommands } from "../studio/CommandContext";
import { createFromVariant } from "../studio/VariantPicker";
import { Inspector } from "../architect/Inspector";
import { Icon } from "../ui/Icon";
import { parseIntent, EXAMPLES } from "../../lib/intelligent/grammar";
import { planProposal, type Proposal, type Intent } from "../../lib/intelligent/proposal";
import { surveyContext } from "../../lib/intelligent/context";
import { coerceIntent } from "../../lib/intelligent/ai";
import { languageName, pickRecordingMime, type HeardTranscript } from "../../lib/intelligent/voice";
import { importRequest, importReviewAnswer, codeFromTitle } from "../../lib/import/chat";
import { ImportCard, ReviewCard, type ImportJob, type ReviewEntry, type ReviewScript } from "./ImportCard";
import type { QuotaImportNote } from "./copilot/QuotasTab";
import { useCopilot, type CopilotEntry } from "./copilot/useCopilot";
import { CopilotCard, SaveFailed } from "./copilot/CopilotCard";
import { CopilotPanel } from "./copilot/CopilotPanel";
import { StructurePane } from "./copilot/StructurePane";
import { proposalCounts, changeRecordOf } from "../../lib/copilot/client";
import { appliedKicker, changeNumber, type SaveView } from "../../lib/copilot/history";

/**
 * INTELLIGENT — describe the change; review it; apply it.
 *
 *   ┌──────────────────────────────────────────────┬─────────────────┐
 *   │ "Show Q5 only when Q3 = Yes and Q4 > 2"      │ INSPECTOR       │
 *   │                                              │ (the object the │
 *   │ PROPOSED CHANGE                              │  proposal is    │
 *   │  Show Q5 only when (Q3 is “Yes” AND Q4 > 2)  │  about — how it │
 *   │  Q3 = Yes AND Q4 > 2          [structure]    │  is wired now)  │
 *   │  [Review Logic]  [Cancel]  [Apply]           │                 │
 *   └──────────────────────────────────────────────┴─────────────────┘
 *
 * This is an assistant over the same engine the other four modes use, not
 * a fifth way to store logic. A sentence is read by the ENGINE first
 * (`interpretRequest`: actions, an answer from the survey's graph, a choice,
 * or a precise refusal — no model call); what it hands on goes to the
 * copilot, or — for explain, diagnose and screening, and with no model — to
 * the grammar, whose INTENT becomes a PROPOSAL against
 * the real survey (lib/intelligent/proposal.ts — the condition is parsed by
 * the expression editor's parser, the changes are validated by the engine),
 * and the proposal is SHOWN. Nothing is written until Apply, and Apply is
 * one labelled, undoable `store.update` that calls `applyLogicProposal` —
 * the same path a click in the Logic panel takes — run on a CLONE first, so
 * a proposal the engine refuses at Apply (it went stale) writes nothing,
 * takes no undo step and leaves the editor clean (the audit's R20).
 *
 * Read-only questions ("what depends on Q3?") are answered from the
 * dependency index and never produce an Apply button at all.
 *
 * SUPER INTELLIGENT IMPORT (the import brief). A questionnaire file —
 * attached with the paperclip, dropped on the conversation, or asked for
 * ("import this file") — becomes an IMPORT turn: estimate, preview, then
 * Create project or Add to this survey (ImportCard). "What could not be
 * migrated?" answers from the survey's own import record, with the custom
 * code the import kept (disabled) offered for Deep analysis — whose reading
 * comes back as an ordinary proposal, reviewed and applied like any other.
 *
 * THE COPILOT (the AI research + survey-programming brief). With a language
 * model configured, what the researcher types or says goes to the copilot
 * (/api/copilot/turn): it reasons about the research — objective,
 * hypotheses, variables — and programs the survey through the engine's
 * controlled action layer. Its proposal is shown whole (the Changes panel:
 * what is created, modified, removed, before/after) and applied as ONE
 * undoable edit, recorded in the AI change history. Research documents
 * attach to the project and are read a few relevant passages at a time.
 * The model is asked only for what the engine cannot do deterministically
 * (generation from a brief, rewording, translation text, research synthesis,
 * narrative findings, phrasing the engine does not parse). The grammar stays
 * for explain, diagnose and screening, and for the shapes it knows when no
 * model is configured or the model's answer is unusable.
 *
 *   ┌──────────┬──────────────────────────────┬────────────────────────┐
 *   │ SURVEY   │ conversation                 │ Changes · Review ·     │
 *   │ blocks,  │  (copilot cards, proposals,  │ Research · History ·   │
 *   │ questions│   imports)                   │ Inspector              │
 *   └──────────┴──────────────────────────────┴────────────────────────┘
 */

interface Turn {
  id: string;
  text: string;
  proposal: Proposal;
  /** applied / cancelled / open */
  state: "open" | "applied" | "cancelled";
  reviewing?: boolean;
  /** when the sentence was spoken: what was heard, and how it was read (§18–§20) */
  heard?: HeardTranscript;
  /** its entry in the operation history (the AI change number and the save live there) */
  opKey?: string;
}

interface ImportTurn { id: string; kind: "import"; job: ImportJob }
interface ReviewTurn { id: string; kind: "review"; text: string; entry: ReviewEntry }
type Entry = Turn | ImportTurn | ReviewTurn | CopilotEntry;
const isProposalTurn = (e: Entry): e is Turn => !("kind" in e);
/** the files behind import turns — kept out of the turn objects, which stay plain data */
const importFiles = new Map<string, File>();

/**
 * The conversation outlives the component. Switching to Grid to look at
 * something and coming back must not wipe what was proposed — §9 says the
 * switch feels magical, and a vanished history is the opposite. Kept per
 * survey for the life of the page, never persisted: proposals are about
 * the survey as it was when they were made.
 */
const sessions = new Map<string, Entry[]>();
/** whether /api/ai/logic answered (true), refused (false) or has not been asked yet — for the page's lifetime */
let aiKnown: boolean | null = null;
/** the same for /api/ai/transcribe: null until the first recording is sent */
let sttKnown: boolean | null = null;

const PREFS_KEY = "rescript.intelligent";
function loadPrefs(): { inspector: number } {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(PREFS_KEY) : null;
    if (raw) { const p = JSON.parse(raw); if (typeof p.inspector === "number") return p; }
  } catch { /* fine */ }
  return { inspector: 360 };
}

export function IntelligentView() {
  const s = useStudio();
  const sel = useSelection();
  const cmd = useCommands();

  const deferredDef = React.useDeferredValue(s.def);
  const status = React.useMemo(() => objectStatus(deferredDef), [deferredDef]);
  const index = React.useMemo(() => buildDependencyIndex(deferredDef), [deferredDef]);
  const primary = (sel?.primary ?? (s.selectedQuestionId ? `question:${s.selectedQuestionId}` : null)) as ObjectKey | null;

  const [text, setText] = React.useState("");
  const [turns, setTurns] = React.useState<Entry[]>(() => sessions.get(s.surveyDbId) ?? []);
  React.useEffect(() => { sessions.set(s.surveyDbId, turns); }, [turns, s.surveyDbId]);
  const [busy, setBusy] = React.useState(false);
  /** null = unknown yet; false = 501 or no session; true = the route answered */
  const [aiAvailable, setAiAvailableState] = React.useState<boolean | null>(aiKnown);
  const setAiAvailable = React.useCallback((v: boolean) => { aiKnown = v; setAiAvailableState(v); }, []);
  const [prefs, setPrefs] = React.useState(loadPrefs);
  const [showInspector, setShowInspector] = React.useState(true);
  const [showStructure, setShowStructure] = React.useState(true);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const logRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => { try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* fine */ } }, [prefs]);
  // follow the conversation — but leave the welcome screen at its top
  React.useEffect(() => { if (turns.length) logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [turns.length, busy]);

  const selectedId = primary?.startsWith("question:") ? primary.slice(9) : null;
  const deps = React.useMemo(() => ({
    uid,
    makeQuestion(def: SurveyDefinition, variantId: string) {
      const v = variantRegistry.get(variantId) ?? variantRegistry.get("single_select.radio")!;
      return createFromVariant(v, nextQuestionNaming(def));
    },
    index,
    // "this question", "it", "this block" — the selection is the context (§17)
    selectedId,
  }), [index, selectedId]);

  const selectKey = React.useCallback((key: ObjectKey) => {
    if (sel) sel.dispatch({ type: "select", key });
    else if (key.startsWith("question:")) s.select(key.slice("question:".length));
  }, [sel, s]);

  /* ------------------------------------------------------------ copilot */
  const copilot = useCopilot({
    entries: turns,
    selectedId,
    push: (e) => setTurns((ts) => [...ts, e]),
    patch: (id, p) => setTurns((ts) => ts.map((x) => (x.id === id && "kind" in x && x.kind === "copilot" ? { ...x, ...(typeof p === "function" ? p(x) : p) } : x))),
    patchAll: (fn) => setTurns((ts) => ts.map((x) => { if (!("kind" in x) || x.kind !== "copilot") return x; const p = fn(x); return p ? { ...x, ...p } : x; })),
  });
  const [applyNote, setApplyNote] = React.useState<string | null>(null);
  const applyCopilot = React.useCallback(async () => {
    // what the change is about — the first question it adds, else the first it modifies — becomes the selection once applied, as a grammar Apply always did
    const st = copilot.state;
    const focus = st ? (st.diff.questionsAdded[0]?.id ?? st.diff.questionsModified[0]?.id ?? null) : null;
    const r = await copilot.apply(() => { if (focus) selectKey(`question:${focus}` as ObjectKey); });
    setApplyNote(r.ok ? null : r.reason ?? null);
    if (r.ok) toastApplied(s, r.n ?? null, r.save, r.message);
    else if (r.reason) s.toast(r.reason, "err");
  }, [copilot, s, selectKey]);
  const selectQuestion = React.useCallback((id: string) => selectKey(`question:${id}` as ObjectKey), [selectKey]);
  /*
   * THE RESEARCHER picked a question — in the survey pane or a link in the
   * conversation. With no proposal open, the panel turns to the Inspector,
   * where that question's actions and dependencies are (the audit's R15:
   * the tab never followed the selection, so the dependency view went
   * unseen). An open proposal keeps the Changes tab: the review is what is
   * being read. Selections the Studio makes itself (after Apply, an engine
   * proposal's target) go through `selectQuestion` and move no tab.
   */
  const pickQuestion = React.useCallback((id: string) => {
    selectQuestion(id);
    if (!copilot.proposal) copilot.setTab("inspector");
  }, [selectQuestion, copilot]);
  /* a context-action template goes in the input box, the caret at its end, for the researcher to finish */
  const writeTemplate = React.useCallback((sentence: string) => {
    setText(sentence);
    window.requestAnimationFrame(() => { const el = inputRef.current; if (el) { el.focus(); el.setSelectionRange(sentence.length, sentence.length); } });
  }, []);

  /* ---------------------------------------------------------------- ask */
  const ask = React.useCallback(async (sentence: string, heard?: HeardTranscript) => {
    const t = sentence.trim();
    if (!t || busy) return;
    const imp = importRequest(t);
    if (imp === "pick") { setText(""); fileRef.current?.click(); return; }
    if (imp === "report") { setText(""); showReview(t); return; }
    setBusy(true);
    setText("");
    /*
     * WHO ANSWERS — THE ENGINE FIRST. The Studio's own engine reads the
     * sentence against the survey: an edit it can resolve ("if Q7 is No, skip
     * Q8 through Q12", "randomize these options but keep None last", "mask
     * the brands selected in Q5 from Q10") becomes actions, checked by the
     * logic engine and shown for review; a question about the survey ("what
     * will break if I delete Q15?", "which questions are untranslated?") is
     * answered from its graph; an ambiguity becomes a choice; an impossible
     * request a precise refusal with the fix. None of that calls a model.
     * The language model is asked only for what the engine hands on —
     * generation from a brief, rewording, translation text, research
     * synthesis, narrative findings, phrasing it does not parse — and the
     * engine's "defer to the grammar" goes to the grammar's read-only
     * answers (explain, diagnose, screening) without a model either.
     */
    const ids = (sel?.keys ?? []).filter((k) => k.startsWith("question:")).map((k) => k.slice(9));
    const interp = interpretRequest(copilot.working, t, { selectedId, ...(ids.length > 1 ? { selectedIds: ids } : {}) });
    if (interp.kind !== "model") {
      copilot.local(t, interp, heard);
      if (interp.kind === "actions") {
        setShowInspector(true);
        // the proposal's target is the selection — the inspector shows how it is wired NOW, and "this question" means it next
        const target = interp.targets.find((id) => s.def.questions.some((q) => q.id === id));
        if (target) selectKey(`question:${target}` as ObjectKey);
      }
      setBusy(false); inputRef.current?.focus(); return;
    }
    const deferred = interp.reason === DEFER_TO_GRAMMAR;
    const pre = parseIntent(t);
    const readOnlyExact = deferred || (["find", "explain", "diagnose", "screening"].includes(pre.kind) && !planProposal(s.def, pre, "grammar", deps).errors.length);
    if (!readOnlyExact && copilot.available !== false) {
      // an unusable model answer ("empty") falls through to the grammar; anything else is the copilot's
      const outcome = await copilot.ask(t, heard);
      if (outcome === "handled") { setBusy(false); inputRef.current?.focus(); return; }
    }
    const selectedLabel = primary?.startsWith("question:") ? (s.def.questions.find((q) => q.id === primary.slice(9))?.code ?? null) : null;
    let intent: Intent = parseIntent(t);
    let source: Proposal["source"] = "grammar";
    let plan = planProposal(s.def, intent, source, deps);
    // the grammar did not understand, or understood but could not find the object: ask the model, if there is one
    // the grammar did not understand, could not find the object, or read a condition the parser rejects: the model may know better (§17)
    const askModel = intent.kind === "unknown" || plan.errors.some((e) => /could not find/.test(e)) || (plan.expression?.errors.length ?? 0) > 0;
    // the older single-intent model route is asked only when there is no copilot: one sentence, one model call at most
    if (askModel && aiAvailable !== false && copilot.available === false) {
      try {
        const r = await fetch("/api/ai/logic", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ surveyId: s.surveyDbId, text: t, context: surveyContext(s.def, { selectedId: primary?.startsWith("question:") ? primary.slice(9) : null }), selected: selectedLabel }),
        });
        if (r.status === 501 || r.status === 401 || r.status === 403) setAiAvailable(false);
        else if (r.ok) {
          setAiAvailable(true);
          const d = await r.json().catch(() => null) as { intent?: unknown } | null;
          const ai = coerceIntent(d?.intent);
          if (ai && ai.kind !== "unknown") {
            const p2 = planProposal(s.def, ai, "ai", deps);
            // prefer the model's reading when it produced something the survey accepts
            if (!p2.errors.length || plan.errors.length) { intent = ai; source = "ai"; plan = p2; }
          } else if (ai?.kind === "unknown" && intent.kind === "unknown") {
            plan = { ...plan, errors: [ai.reason] };
          }
        }
      } catch { /* offline: the grammar's answer stands */ }
    }
    // spoken in another language, with nothing to read it into English: say so, rather than "not understood"
    if (heard && heard.language !== "en" && heard.language !== "und" && !heard.english && intent.kind === "unknown") {
      plan = { ...plan, errors: [`I heard this in ${languageName(heard.language)}, but no language model is configured on this Studio to read it into English. Say it in English, or type it.`] };
    }
    /* the grammar's reading is in the history too: proposed, answered, or failed with why */
    const opKey = copilot.recordOp({
      prompt: t, source: source === "ai" ? "model" : "grammar", intent: { kind: intent.kind, ...(source === "ai" ? { reader: "model" } : {}) },
      status: plan.errors.length ? "failed" : plan.readOnly ? "answered" : "proposed",
      proposed: plan.readOnly ? [] : plan.descriptions.map((description) => ({ description })), targets: proposalTargets(plan.changes), warnings: plan.warnings,
      statusDetail: (plan.errors.join(" ") || plan.summary || "").slice(0, 2000) || null,
      ...(source === "ai" ? { apiCalls: [{ route: "/api/ai/logic", charge: 0 }] } : {}),
    });
    setTurns((ts) => {
      // the model had nothing usable and the grammar has an answer: show the answer, not the empty turn
      const lastEntry = ts[ts.length - 1];
      const drop = lastEntry && "kind" in lastEntry && lastEntry.kind === "copilot" && lastEntry.status === "empty" && lastEntry.text === t && !plan.errors.length ? lastEntry.id : null;
      return [...ts.filter((x) => x.id !== drop), { id: uid("turn"), text: t, proposal: plan, state: plan.readOnly ? "applied" : "open", opKey, ...(heard ? { heard } : {}) }];
    });
    if (plan.targetKey) selectKey(plan.targetKey);
    setBusy(false);
    inputRef.current?.focus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, primary, s.def, s.surveyDbId, deps, aiAvailable, selectKey, copilot, sel, selectedId]);

  /* -------------------------------------------------------------- apply */
  /*
   * THE GRAMMAR'S APPLY — on a clone first. `applyLogicProposal` checks the
   * whole proposal and then applies it change by change; run on the store's
   * draft, a refusal still left an undo step and an editor marked unsaved,
   * and a refusal mid-batch (a rename) left half of it written (the audit's
   * R20). Run on a copy, a refused proposal touches nothing: the error is
   * shown, the history records it as failed, the undo label is unchanged.
   * Only a proposal that applied cleanly is written — one labelled `replace`
   * — and recorded like the copilot's: applied, numbered, saved or not.
   */
  const apply = React.useCallback(async (turn: Turn) => {
    const p = turn.proposal;
    if (p.errors.length || p.readOnly || s.readOnly) { if (s.readOnly) s.toast("This project is read-only right now.", "err"); return; }
    const before = s.currentDef();
    const trial = applyLogicProposal(structuredClone(before), p.changes);
    if (trial.errors.length) {
      s.toast(trial.errors[0], "err");
      setTurns((ts) => ts.map((x) => x.id === turn.id && isProposalTurn(x) ? { ...x, proposal: { ...x.proposal, errors: trial.errors } } : x));
      if (turn.opKey) void copilot.updateOp(turn.opKey, { status: "failed", statusDetail: `Not applied — the engine refused it: ${trial.errors.join(" ")}`.slice(0, 2000), failed: p.descriptions.map((description) => ({ description, reason: trial.errors[0] })) });
      return;
    }
    const label = `Applied proposal: ${p.summary}`;
    s.labelNextEdit(label);
    s.replace(trial.def);
    const after = s.currentDef();
    if (after === before) return;
    setTurns((ts) => ts.map((x) => x.id === turn.id ? { ...x, state: "applied" } : x));
    const targets = proposalTargets(p.changes);
    if (targets[0]) selectKey(`question:${targets[0]}` as ObjectKey);
    const opKey = turn.opKey ?? copilot.recordOp({ prompt: turn.text, source: p.source === "ai" ? "model" : "grammar", status: "proposed", intent: { kind: p.intent.kind }, proposed: p.descriptions.map((description) => ({ description })), targets });
    if (!turn.opKey) setTurns((ts) => ts.map((x) => x.id === turn.id ? { ...x, opKey } : x));
    const record = { ...changeRecordOf(null, turn.text, diffSurveys(before, after), before, after), label, key: opKey };
    const done = await copilot.commitApplied(opKey, { record, applied: p.descriptions, excluded: [], failed: [], warnings: p.warnings, engineOps: [...new Set(p.changes.map((c) => c.kind))], targets }, undefined, false);
    toastApplied(s, done.n, done.save);
  }, [s, selectKey, copilot]);

  const cancel = (turn: Turn) => {
    if (turn.opKey) void copilot.updateOp(turn.opKey, { status: "cancelled", statusDetail: "cancelled before it was applied" });
    setTurns((ts) => ts.map((x) => x.id === turn.id ? { ...x, state: "cancelled" } : x));
  };
  /* "Try saving again" on an applied card whose save was refused */
  const retrySave = React.useCallback(async (opKey: string) => {
    const save = await copilot.retrySave(opKey);
    const op = copilot.op(opKey);
    toastApplied(s, op?.changeN ?? null, save, undefined, true);
  }, [copilot, s]);
  /*
   * TEST SEAM — `window.__rescriptGrammarTurn(sentence)`, sandbox only: the
   * grammar's reading of a sentence as a TurnCard, without the engine and the
   * model in front of it (most sentences the grammar knows, the engine now
   * reads first). How a browser suite reaches the grammar's Apply — and a
   * proposal that has gone stale by the time it is applied — directly.
   */
  React.useEffect(() => {
    if (s.surveyDbId !== "sandbox") return;
    const w = window as unknown as { __rescriptGrammarTurn?: (t: string) => void };
    w.__rescriptGrammarTurn = (t) => {
      const intent = parseIntent(t);
      const plan = planProposal(s.def, intent, "grammar", deps);
      const opKey = copilot.recordOp({ prompt: t, source: "grammar", intent: { kind: intent.kind }, status: plan.errors.length ? "failed" : plan.readOnly ? "answered" : "proposed", proposed: plan.readOnly ? [] : plan.descriptions.map((description) => ({ description })), targets: proposalTargets(plan.changes), statusDetail: (plan.errors.join(" ") || plan.summary || "").slice(0, 2000) || null });
      setTurns((ts) => [...ts, { id: uid("turn"), text: t, proposal: plan, state: plan.readOnly ? "applied" : "open", opKey }]);
    };
    return () => { delete w.__rescriptGrammarTurn; };
  }, [s.surveyDbId, s.def, deps, copilot]);
  const review = (turn: Turn) => setTurns((ts) => ts.map((x) => x.id === turn.id && isProposalTurn(x) ? { ...x, reviewing: !x.reviewing } : x));

  /* ------------------------------------------------------------- import */
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = React.useState(false);
  const sandbox = s.surveyDbId === "sandbox";
  const patchJob = React.useCallback((id: string, patch: Partial<ImportJob>) => {
    setTurns((ts) => ts.map((x) => x.id === id && "kind" in x && x.kind === "import" ? { ...x, job: { ...x.job, ...patch } } : x));
  }, []);
  const jobOf = (id: string): ImportJob | undefined => { const e = turns.find((x) => x.id === id); return e && "kind" in e && e.kind === "import" ? e.job : undefined; };

  const postImport = React.useCallback(async (id: string, fields: Record<string, string>) => {
    const file = importFiles.get(id);
    if (!file) throw new Error("The file is no longer available — attach it again.");
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("surveyId", s.surveyDbId);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const r = await fetch("/api/import/analyze", { method: "POST", body: form });
    const d = await r.json().catch(() => null) as Record<string, any> | null;
    if (!d) throw new Error(`The import service did not answer (${r.status}).`);
    if (r.status === 402) throw new Error(String(d.error ?? "The wallet refused this import."));
    return { status: r.status, d };
  }, [s.surveyDbId]);

  const startImport = React.useCallback(async (file: File) => {
    const id = uid("import");
    importFiles.set(id, file);
    const job: ImportJob = { fileName: file.name, size: file.size, stage: "estimating", scope: "full", into: "new" };
    setTurns((ts) => [...ts, { id, kind: "import", job }]);
    try {
      const { d } = await postImport(id, { phase: "estimate" });
      if (!d.ok) { patchJob(id, { stage: "failed", detection: d.detection, error: String(d.error ?? "This file could not be read as a questionnaire.") }); return; }
      patchJob(id, { stage: "estimated", detection: d.detection, workload: d.workload, title: d.title, estimate: d.estimate });
    } catch (e) {
      patchJob(id, { stage: "failed", error: (e as Error).message });
    }
  }, [postImport, patchJob]);

  const runImport = React.useCallback(async (id: string) => {
    const job = jobOf(id);
    if (!job) return;
    const basedOn = s.def;
    patchJob(id, { stage: "running", error: undefined });
    try {
      const { d } = await postImport(id, { phase: "run", scope: job.scope, into: job.into, ...(job.into === "merge" ? { existing: JSON.stringify(basedOn) } : {}) });
      if (!d.report) { patchJob(id, { stage: "failed", error: String(d.error ?? "The import could not be completed.") }); return; }
      patchJob(id, { stage: "ready", report: d.report, definition: d.definition, mapping: d.mapping, actual: d.actual, basedOn, ...(d.report.ok ? {} : { error: "The file was read, but it did not produce a valid survey — see the issues." }) });
    } catch (e) {
      patchJob(id, { stage: "estimated", error: (e as Error).message });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, s.def, postImport, patchJob]);

  const importAudit = (job: ImportJob) => ({
    fileName: job.fileName, label: job.detection?.label, format: job.detection?.format, platform: job.detection?.platform, scope: job.scope,
    fingerprint: job.definition?.imports?.at(-1)?.fingerprint, questions: job.report?.created?.questions, review: job.report?.review.length,
  });

  const createFromImport = React.useCallback(async (id: string) => {
    const job = jobOf(id);
    if (!job?.definition) return;
    patchJob(id, { stage: "creating", error: undefined });
    try {
      const title = job.definition.meta.title || job.title || job.fileName.replace(/\.[^.]+$/, "");
      const r = await fetch("/api/surveys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, code: codeFromTitle(title), definition: job.definition, strict: true, import: importAudit(job) }) });
      const d = await r.json().catch(() => null) as { id?: string; error?: string } | null;
      if (!r.ok || !d?.id) { patchJob(id, { stage: "ready", error: d?.error ?? (r.status === 401 ? "Sign in to create a project." : `The project could not be created (${r.status}).`) }); return; }
      patchJob(id, { stage: "created", createdId: d.id });
      s.toast("Project created from the import.");
    } catch (e) {
      patchJob(id, { stage: "ready", error: (e as Error).message });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, patchJob, s]);

  const mergeImport = React.useCallback((id: string) => {
    const job = jobOf(id);
    if (!job?.definition || s.readOnly) return;
    // the preview was computed against the survey as it was; if it has changed since, the merge would undo that change
    if (job.basedOn && job.basedOn !== s.def && JSON.stringify(job.basedOn) !== JSON.stringify(s.def)) { patchJob(id, { error: "The survey has changed since this preview was made. Analyze again so nothing you just did is lost." , stage: "estimated", report: undefined, definition: undefined }); return; }
    s.labelNextEdit(`Imported ${job.fileName}`);
    s.replace(job.definition);
    patchJob(id, { stage: "merged", basedOn: undefined });
    void fetch("/api/import/record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: s.surveyDbId, ...importAudit(job) }) }).catch(() => {});
    s.toast("Imported into this survey. Undo with ⌘Z.");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, s, patchJob]);

  const cancelImport = (id: string) => { patchJob(id, { stage: "cancelled" }); importFiles.delete(id); };

  const onFiles = (list: FileList | null) => {
    const f = list?.[0];
    if (f) void startImport(f);
    if (fileRef.current) fileRef.current.value = "";
  };
  /*
   * A DROPPED FILE is either a questionnaire to import or research for the
   * copilot to read. A survey export (QSF, Decipher XML, a Rescript JSON) can
   * only be the first; several files, or a paper-like format, could be either
   * — so the researcher says which.
   */
  const researchRef = React.useRef<HTMLInputElement>(null);
  const themeImageRef = React.useRef<HTMLInputElement>(null);
  /*
   * A QUOTA SHEET (research-intelligence Phase 4): the client's Excel / CSV
   * of sample targets, read against this survey by /api/import/quotas into
   * create_quota actions — a proposal in Changes like any other, with what
   * the sheet could not say matched reported in the Quotas tab.
   */
  const quotaSheetRef = React.useRef<HTMLInputElement>(null);
  const [quotaImport, setQuotaImport] = React.useState<QuotaImportNote | null>(null);
  const importQuotaSheet = React.useCallback(async (file: File) => {
    const form = new FormData();
    form.append("file", file); form.append("surveyId", s.surveyDbId); form.append("definition", JSON.stringify(s.def));
    try {
      const r = await fetch("/api/import/quotas", { method: "POST", body: form });
      const d = await r.json().catch(() => null) as { error?: string; actions?: SurveyAction[]; rejected?: { reason: string }[]; issues?: string[]; matched?: Record<string, string>; sheet?: { quotas: QuotaImportNote["quotas"] } } | null;
      if (!r.ok || !d) { s.toast(d?.error ?? `The quota sheet could not be read (${r.status}).`, "err"); return; }
      const actions = d.actions ?? [];
      setQuotaImport({ fileName: file.name, issues: [...(d.issues ?? []), ...(d.rejected ?? []).map((x) => x.reason)], matched: d.matched ?? {}, quotas: d.sheet?.quotas ?? [], actions: actions.length, at: new Date().toISOString() });
      if (actions.length) copilot.previewFix(actions, `Import quotas from ${file.name}`);
      else s.toast(`No quota could be made from ${file.name} — see the Quotas tab for why.`, "err");
      copilot.setTab(actions.length ? "changes" : "quotas");
      setShowInspector(true);
    } catch (e) { s.toast(`The quota sheet could not be read: ${(e as Error).message}`, "err"); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.surveyDbId, s.def, copilot]);
  const [dropChoice, setDropChoice] = React.useState<File[] | null>(null);
  const [attachMenu, setAttachMenu] = React.useState(false);
  const onDropFiles = (list: FileList) => {
    const files = [...list];
    if (files.length === 1 && /\.(?:qsf|xml|json)$/i.test(files[0].name)) { void startImport(files[0]); return; }
    setDropChoice(files);
  };

  /* "what could not be migrated?" — from the survey's own import record */
  const showReview = React.useCallback((sentence: string) => {
    const a = importReviewAnswer(s.def);
    const scripts: ReviewScript[] = (s.def.scripts ?? []).filter((x) => !x.enabled && /^Imported /.test(x.name)).map((x) => ({
      id: x.id, name: x.name, code: x.code, questionId: x.ref, questionCode: x.ref ? s.def.questions.find((q) => q.id === x.ref)?.code : undefined,
    }));
    setTurns((ts) => [...ts, { id: uid("review"), kind: "review", text: sentence, entry: { summary: a.summary, lines: a.lines, scripts, aiOff: aiAvailable === false } }]);
  }, [s.def, aiAvailable]);

  const analyzeScript = React.useCallback(async (turnId: string, scriptId: string) => {
    const e = turns.find((x) => x.id === turnId);
    if (!e || !("kind" in e) || e.kind !== "review") return;
    const sc = e.entry.scripts.find((x) => x.id === scriptId);
    const script = (s.def.scripts ?? []).find((x) => x.id === scriptId);
    if (!sc || !script) return;
    const patch = (p: Partial<ReviewScript>) => setTurns((ts) => ts.map((x) => x.id === turnId && "kind" in x && x.kind === "review" ? { ...x, entry: { ...x.entry, scripts: x.entry.scripts.map((y) => y.id === scriptId ? { ...y, ...p } : y) } } : x));
    patch({ state: "analyzing", error: undefined });
    try {
      const refs = /Reads ([^.]+)\./.exec(script.notes ?? "")?.[1].split(/,\s*/) ?? [];
      const r = await fetch("/api/import/custom-logic", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ surveyId: s.surveyDbId, context: surveyContext(s.def, { selectedId: sc.questionId ?? null }), item: { language: /^Imported (\w+)/.exec(script.name)?.[1] ?? "javascript", code: script.code, location: sc.questionCode ?? "survey", role: script.name.split(" · ")[1] ?? "custom code", refs, questionCode: sc.questionCode } }),
      });
      if (r.status === 501 || r.status === 401 || r.status === 403) { setAiAvailable(false); patch({ state: "failed", error: "No language model is available on this Studio for deep analysis." }); return; }
      const d = await r.json().catch(() => null) as { ok?: boolean; error?: string; analysis?: { explanation: string; dependencies: string[]; equivalent: string; risk: string; intent: unknown } | null; usage?: { charge: number } | null } | null;
      if (!r.ok || !d?.ok) { patch({ state: "failed", error: d?.error ?? `The analysis failed (${r.status}).` }); return; }
      const an = d.analysis;
      const intent = an ? coerceIntent(an.intent) : null;
      const plan = intent && intent.kind !== "unknown" ? planProposal(s.def, intent, "ai", deps) : null;
      patch({ state: "done", explanation: an?.explanation ?? "", dependencies: an?.dependencies ?? [], risk: an?.risk ?? "", equivalent: an?.equivalent, proposed: !!plan && !plan.readOnly, charge: d.usage?.charge });
      if (plan && !plan.readOnly) setTurns((ts) => [...ts, { id: uid("turn"), text: `Rebuild ${script.name}${sc.questionCode ? ` on ${sc.questionCode}` : ""} (from the model's reading of the imported code)`, proposal: plan, state: "open" }]);
    } catch (err) {
      patch({ state: "failed", error: (err as Error).message });
    }
  }, [turns, s.def, s.surveyDbId, deps, setAiAvailable]);

  /* --------------------------------------------------------------- voice */
  /*
   * MICROPHONE → CLOUD TRANSCRIPTION → THE SAME PIPELINE (§18–§21). Click to
   * start, click to stop (or it stops itself after 45 s). The recording goes
   * to /api/ai/transcribe, which hears it with the configured speech provider
   * and, when it was not English, reads it into English with the model. What
   * comes back is asked exactly as a typed sentence would be, with what was
   * heard kept on the turn so the programmer can check the reading.
   */
  const [voice, setVoice] = React.useState<"idle" | "recording" | "transcribing">("idle");
  const [sttAvailable, setSttAvailableState] = React.useState<boolean | null>(sttKnown);
  const setSttAvailable = React.useCallback((v: boolean) => { sttKnown = v; setSttAvailableState(v); }, []);
  const [voiceError, setVoiceError] = React.useState<string | null>(null);
  const recorder = React.useRef<{ rec: MediaRecorder; stream: MediaStream; chunks: Blob[]; timer: number } | null>(null);
  const hintRef = React.useRef<{ hint: string; language: string } | null>(null);

  const sendRecording = React.useCallback(async (blob: Blob) => {
    setVoice("transcribing");
    try {
      const form = new FormData();
      form.append("audio", blob, "instruction.webm");
      form.append("surveyId", s.surveyDbId);
      // the browser suites, against the fake provider, say what the fake should have heard
      if (hintRef.current) { form.append("hint", hintRef.current.hint); form.append("hintLanguage", hintRef.current.language); hintRef.current = null; }
      const r = await fetch("/api/ai/transcribe", { method: "POST", body: form });
      if (r.status === 501) { setSttAvailable(false); setVoiceError("No transcription provider is configured on this Studio."); return; }
      const d = await r.json().catch(() => null) as { ok?: boolean; text?: string; language?: string; english?: string; model?: string; error?: string } | null;
      if (!r.ok || !d?.ok) { setVoiceError(d?.error ?? `Transcription failed (${r.status}).`); return; }
      setSttAvailable(true);
      const heard: HeardTranscript = { text: d.text ?? "", language: d.language ?? "en", ...(d.english ? { english: d.english } : {}), ...(d.model ? { model: d.model } : {}) };
      const sentence = (heard.english || heard.text).trim();
      if (!sentence) { setVoiceError("I could not make out any words — try again, a little closer to the microphone."); return; }
      setText("");
      await ask(sentence, heard);
    } catch (e) {
      setVoiceError((e as Error).message);
    } finally {
      setVoice("idle");
    }
  }, [ask, s.surveyDbId, setSttAvailable]);

  const stopRecording = React.useCallback(() => {
    const r = recorder.current;
    if (!r) return;
    window.clearTimeout(r.timer);
    if (r.rec.state !== "inactive") r.rec.stop();
  }, []);

  const startRecording = React.useCallback(async () => {
    setVoiceError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setVoiceError("This browser cannot record audio."); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickRecordingMime((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        recorder.current = null;
        const blob = new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" });
        if (blob.size === 0) { setVoice("idle"); setVoiceError("Nothing was recorded."); return; }
        void sendRecording(blob);
      };
      rec.start(250);
      const timer = window.setTimeout(() => stopRecording(), 45_000);
      recorder.current = { rec, stream, chunks, timer };
      setVoice("recording");
    } catch (e) {
      setVoiceError(/NotAllowed|Permission/i.test(String((e as Error).name)) ? "Microphone access was refused — allow it in the browser to speak an instruction." : (e as Error).message);
      setVoice("idle");
    }
  }, [sendRecording, stopRecording]);
  React.useEffect(() => () => { const r = recorder.current; if (r) { window.clearTimeout(r.timer); r.stream.getTracks().forEach((t) => t.stop()); } }, []);
  const toggleVoice = () => { if (voice === "recording") stopRecording(); else if (voice === "idle") void startRecording(); };
  // the browser suites set the fake provider's transcript through a global hook, since a fake cannot hear
  React.useEffect(() => {
    (window as unknown as { __rescriptVoiceHint?: (hint: string, language?: string) => void }).__rescriptVoiceHint = (hint, language = "en") => { hintRef.current = { hint, language }; };
    return () => { delete (window as unknown as { __rescriptVoiceHint?: unknown }).__rescriptVoiceHint; };
  }, []);

  /* -------------------------------------------------------------- resize */
  const dragging = React.useRef<{ startX: number; start: number } | null>(null);
  const onDividerDown = (e: React.PointerEvent) => {
    dragging.current = { startX: e.clientX, start: prefs.inspector };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDividerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const w = Math.max(260, Math.min(640, dragging.current.start - (e.clientX - dragging.current.startX)));
    setPrefs({ inspector: w });
  };
  const onDividerUp = () => { dragging.current = null; };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(text); }
  };

  const open = turns.filter((t) => isProposalTurn(t) && t.state === "open").length;

  /*
   * CONTEXT-AWARE EXAMPLES: with a question selected, the first examples
   * are about it — its code, and the question before it as the condition's
   * subject — so the sentences on offer are ones the programmer can send as
   * they are. With nothing selected, the general set.
   */
  const examples = React.useMemo(() => {
    const qid = primary?.startsWith("question:") ? primary.slice(9) : null;
    const q = qid ? s.def.questions.find((x) => x.id === qid) : null;
    if (!q) return EXAMPLES;
    const i = s.def.questions.findIndex((x) => x.id === q.id);
    const prev = i > 0 ? s.def.questions[i - 1] : null;
    const opt = prev?.options?.[0];
    const cond = prev ? `${prev.code} ${opt ? `= ${opt.label.replace(/[“”"]/g, "")}` : "answered"}` : "Q1 answered";
    const about = [
      { text: `Show ${q.code} only when ${cond}`, about: `display logic on ${q.code}` },
      { text: `Make ${q.code} ${q.required ? "optional" : "required"}`, about: q.required ? "optional" : "required" },
      { text: `What depends on ${q.code}?`, about: "dependencies" },
      { text: `Explain ${q.code}`, about: `how ${q.code} behaves` },
    ];
    return [...about, ...EXAMPLES.filter((e) => !/^(Show Q5|Make Q4|What depends|Explain Q5)/.test(e.text))];
  }, [primary, s.def]);

  return (
    <div className="iq cp-workspace" data-testid="intelligent-view" data-undo-depth={s.undoDepth} data-undo-label={s.undoLabel ?? ""} data-save={s.saveState.kind} style={{ gridTemplateColumns: `${showStructure ? "240px " : ""}${showInspector ? `minmax(0, 1fr) 6px ${prefs.inspector}px` : "minmax(0, 1fr)"}` }}>
      {showStructure && <StructurePane def={copilot.state ? copilot.state.after : s.def} diff={copilot.state?.diff ?? null} selectedId={selectedId} onSelect={pickQuestion} />}
      <section
        className={`iq-main${dropping ? " iq-dropping" : ""}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false); }}
        onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDropping(false); onDropFiles(e.dataTransfer.files); } }}
        data-testid="iq-main"
      >
        <div className="iq-toolbar">
          <button type="button" className={`iq-btn${showStructure ? " on" : ""}`} onClick={() => setShowStructure((v) => !v)} aria-pressed={showStructure} data-testid="cp-toggle-structure" title="The survey's structure"><Icon name="layers" size={13} /></button>
          <span className="iq-title"><Icon name="sparkle" size={14} /> Intelligent</span>
          <span className="iq-hint">Describe your research or a change — typed or spoken, in any language. Every change is shown for review before it is applied.</span>
          <span className="iq-spacer" />
          <button type="button" className="iq-btn" onClick={() => { setText("My hypothesis is that … Target respondents: … Create a survey that tests it."); inputRef.current?.focus(); }} data-testid="cp-generate" title="Describe an objective or hypothesis; the copilot proposes the whole survey"><Icon name="plus" size={13} /> Generate survey</button>
          <button type="button" className="iq-btn" onClick={() => { setShowInspector(true); void copilot.runReview(); }} disabled={busy} data-testid="cp-review" title="Check logic, reachability, wording, scales, duplicates, length — and, with a model, research alignment"><Icon name="check" size={13} /> Review</button>
          <button type="button" className="iq-btn" onClick={() => { const last = [...copilot.history].reverse().find((h) => !h.reverted && h.key); if (last?.key) void copilot.restore(last.key).then((r) => { if (!r.ok && r.reason) { setShowInspector(true); copilot.setTab("history"); s.toast(r.reason, "err"); } }); }} disabled={!copilot.history.some((h) => !h.reverted && h.key)} data-testid="cp-undo-last" title="Undo the last AI change, as one operation">Undo AI change</button>
          <span className="iq-provider" data-testid="iq-provider" data-ai={aiAvailable === null && copilot.available === null ? "unknown" : copilot.available || aiAvailable ? "on" : "off"} data-copilot={copilot.available === null ? "unknown" : copilot.available ? "on" : "off"} title={copilot.available === false ? "The Studio's engine reads every request first — edits, logic, options, dependencies, impact — with no model call. No language model is configured, so what the engine hands on (rewording, generation, translation text) is not available." : "The Studio's engine reads every request first and does everything it can deterministically, with no model call; the copilot (the configured model) is asked only for what it hands on."}>
            {copilot.available === false ? "engine only" : copilot.available ? "engine + copilot" : aiAvailable ? "engine + model" : "engine"}
          </span>
          <button type="button" className={`iq-btn${showInspector ? " on" : ""}`} onClick={() => setShowInspector((v) => !v)} aria-pressed={showInspector} data-testid="iq-toggle-inspector" title="Inspector">
            <Icon name="info" size={13} /> Panel
          </button>
        </div>

        <div className="iq-log" ref={logRef} data-testid="iq-log">
          {turns.length === 0 && (
            <div className="iq-welcome" data-testid="iq-welcome">
              <h2>How do you want to program your research?</h2>
              <p>Tell it your objective or hypothesis, attach your research, or describe a change. The copilot proposes the survey — questions, scales, logic — shows you exactly what it will do, and waits for you to apply it.</p>
              <div className="cp-welcome-row">
                <button type="button" className="iq-example cp-welcome" onClick={() => { setText("My hypothesis is that younger consumers are more likely to buy premium skincare because of social media influence. Create a survey that tests it."); inputRef.current?.focus(); }} data-testid="cp-welcome-generate">
                  <span className="iq-example-text"><Icon name="sparkle" size={13} /> Generate a survey from a hypothesis</span>
                  <span className="iq-example-about">variables, constructs, screening, scales, logic</span>
                </button>
                <button type="button" className="iq-example cp-welcome" onClick={() => researchRef.current?.click()} data-testid="cp-welcome-research">
                  <span className="iq-example-text"><Icon name="paperclip" size={13} /> Attach research — papers, reports, briefs</span>
                  <span className="iq-example-about">PDF (with OCR), Word, text · read before it designs</span>
                </button>
              </div>
              <button type="button" className="iq-example iqi-welcome-import" onClick={() => fileRef.current?.click()} data-testid="iq-import-start">
                <span className="iq-example-text"><Icon name="paperclip" size={13} /> Import a questionnaire — Qualtrics QSF, Decipher XML, Word, Excel, CSV, PDF or text</span>
                <span className="iq-example-about">reverse-engineered into Rescript · previewed before anything is created</span>
              </button>
              <div className="iq-examples">
                {examples.map((e) => (
                  <button key={e.text} type="button" className="iq-example" onClick={() => setText(e.text)} data-testid="iq-example">
                    <span className="iq-example-text">{e.text}</span>
                    <span className="iq-example-about">{e.about}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((turn) => {
            if (!isProposalTurn(turn)) {
              if (turn.kind === "import") return (
                <ImportCard key={turn.id} job={turn.job} readOnly={s.readOnly} sandbox={sandbox}
                  onPatch={(p) => patchJob(turn.id, p)} onRun={() => void runImport(turn.id)} onCreate={() => void createFromImport(turn.id)}
                  onMerge={() => mergeImport(turn.id)} onCancel={() => cancelImport(turn.id)} onReviewAfter={() => showReview("What needs review after the import?")} />
              );
              if (turn.kind === "copilot") {
                const open = turn.proposal === "open" && copilot.state;
                return (
                  <CopilotCard key={turn.id} entry={turn} def={copilot.state && turn.proposal === "open" ? copilot.state.after : s.def} onSelect={pickQuestion}
                    onReviewChanges={() => { setShowInspector(true); copilot.setTab("changes"); }} onApply={() => void applyCopilot()} onCancel={copilot.cancel}
                    op={turn.opKey ? copilot.op(turn.opKey) : undefined} onRetrySave={() => turn.opKey && void retrySave(turn.opKey)}
                    onAnswer={(q) => { setText(`${q} — `); inputRef.current?.focus(); }}
                    onSelectKey={(k) => selectKey(k as ObjectKey)} onAsk={(q) => void ask(q)}
                    onPreviewFix={(actions, label) => { copilot.previewFix(actions, label); setShowInspector(true); }}
                    counts={open ? proposalCounts(copilot.state!.diff, copilot.state!.after) : null}
                    canApply={!!open && !s.readOnly && !copilot.state!.diff.empty && (!copilot.state!.destructive.length || copilot.confirmed)}
                    refused={open ? copilot.state!.errors : []}
                    applyLabel={open && copilot.excluded.length ? "Apply the ticked changes" : undefined}
                    applyTitle={s.readOnly ? "Read-only" : open && copilot.state!.diff.empty ? (copilot.state!.errors.length ? "Nothing to apply — the Studio refused every change (the reasons are listed above)" : "Nothing to apply — the proposal leaves the survey as it is") : copilot.state?.destructive.length && !copilot.confirmed ? "Some changes remove or rewrite existing content — confirm them in the Changes panel first" : "Apply as one undoable change"} />
                );
              }
              return <ReviewCard key={turn.id} text={turn.text} entry={turn.entry} onSelect={(qid) => selectKey(`question:${qid}` as ObjectKey)} onAnalyze={(sid) => void analyzeScript(turn.id, sid)} />;
            }
            return <TurnCard key={turn.id} turn={turn} def={s.def} onApply={() => void apply(turn)} onCancel={() => cancel(turn)} onReview={() => review(turn)} onSelect={selectKey} readOnly={s.readOnly}
              save={turn.opKey ? copilot.op(turn.opKey)?.save : undefined} changeN={turn.opKey ? copilot.op(turn.opKey)?.changeN ?? null : null} onRetrySave={() => turn.opKey && void retrySave(turn.opKey)} />;
          })}
          {busy && <div className="iq-thinking" data-testid="iq-thinking"><span className="iq-dot" /><span className="iq-dot" /><span className="iq-dot" /></div>}
        </div>

        {voiceError && <p className="iq-voice-error" data-testid="iq-voice-error" role="alert"><Icon name="warning" size={12} /> {voiceError}</p>}
        {dropChoice && (
          <div className="cp-drop-choice" data-testid="cp-drop-choice">
            <span>{dropChoice.length === 1 ? `“${dropChoice[0].name}”` : `${dropChoice.length} files`} — use as:</span>
            <button type="button" className="iq-btn primary" onClick={() => { void copilot.uploadDocs(dropChoice); setShowInspector(true); setDropChoice(null); }} data-testid="cp-drop-research">Research for the copilot</button>
            <button type="button" className="iq-btn" onClick={() => { void startImport(dropChoice[0]); setDropChoice(null); }} disabled={dropChoice.length > 1} data-testid="cp-drop-import">A questionnaire to import</button>
            {dropChoice.length === 1 && /\.(?:xlsx|xls|csv|tsv)$/i.test(dropChoice[0].name) && <button type="button" className="iq-btn" onClick={() => { void importQuotaSheet(dropChoice[0]); setDropChoice(null); }} data-testid="cp-drop-quotas">A quota sheet</button>}
            <button type="button" className="iq-btn" onClick={() => setDropChoice(null)}>Cancel</button>
          </div>
        )}
        <form className="iq-ask" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
          <textarea
            ref={inputRef} className="iq-input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
            placeholder={voice === "recording" ? "Listening… click the microphone again when you have finished." : voice === "transcribing" ? "Transcribing…" : copilot.proposal ? "Revise the proposal — “reduce this to 20 questions”, “remove demographics” — or apply it…" : open ? "Apply or cancel the proposal above, or describe another change…" : "Describe your research or a change — “Show Q5 only when Q3 = Yes”, “create a survey to test my hypothesis…” — or press the microphone"}
            rows={2} data-testid="iq-input" aria-label="Describe a change" disabled={busy || voice !== "idle"}
          />
          <input ref={fileRef} type="file" hidden onChange={(e) => onFiles(e.target.files)} data-testid="iq-file" accept=".qsf,.xml,.docx,.xlsx,.xls,.csv,.tsv,.pdf,.txt,.json,.doc,application/json,text/xml,application/xml,text/plain,text/csv,application/pdf" />
          <input ref={themeImageRef} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void copilot.attachThemeImage(f); }} data-testid="cp-theme-image-file" />
          {(copilot.themeImage || copilot.themeImageError) && (
            <span className="cp-theme-chip" data-testid="cp-theme-image-chip">
              {copilot.themeImage ? (<>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={copilot.themeImage.url} alt="" />
                {copilot.themeImage.dominant.slice(0, 5).map((c) => <i key={c} style={{ background: c }} title={c} />)}
                <span>theme image · sent with your next request</span>
                <button type="button" onClick={copilot.clearThemeImage} aria-label="Remove the theme image">×</button>
              </>) : <span className="iq-error">{copilot.themeImageError}</span>}
            </span>
          )}
          <input ref={quotaSheetRef} type="file" hidden accept=".xlsx,.csv,.tsv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importQuotaSheet(f); }} data-testid="cp-quota-sheet-file" />
          <input ref={researchRef} type="file" hidden multiple onChange={(e) => { void copilot.uploadDocs([...(e.target.files ?? [])]); setShowInspector(true); e.target.value = ""; }} data-testid="cp-research-file" accept=".pdf,.docx,.txt,.md,.csv,.xlsx" />
          <span className="cp-attach-wrap">
            <button type="button" className="iq-attach" onClick={() => setAttachMenu((v) => !v)} disabled={busy || voice !== "idle"} data-testid="iq-attach" aria-label="Attach files" aria-expanded={attachMenu} title="Attach research documents for the copilot, or import a questionnaire">
              <Icon name="paperclip" size={15} />
            </button>
            {attachMenu && (
              <span className="cp-attach-menu" role="menu" data-testid="cp-attach-menu">
                <button type="button" role="menuitem" onClick={() => { setAttachMenu(false); researchRef.current?.click(); }} data-testid="iq-attach-research"><b>Research documents</b><span className="iqi-dim">papers, reports, briefs — the copilot reads them</span></button>
                <button type="button" role="menuitem" onClick={() => { setAttachMenu(false); fileRef.current?.click(); }} data-testid="iq-attach-import"><b>Import a questionnaire</b><span className="iqi-dim">QSF, Decipher, Word, Excel, PDF → a Rescript survey</span></button>
                <button type="button" role="menuitem" onClick={() => { setAttachMenu(false); quotaSheetRef.current?.click(); }} data-testid="iq-attach-quotas"><b>Quota sheet</b><span className="iqi-dim">Excel / CSV of sample targets → quotas, as a proposal</span></button>
                <button type="button" role="menuitem" onClick={() => { setAttachMenu(false); themeImageRef.current?.click(); }} data-testid="iq-attach-theme"><b>Theme image</b><span className="iqi-dim">build the survey&apos;s theme from an image, or use it as the background</span></button>
              </span>
            )}
          </span>
          <button
            type="button" className={`iq-mic${voice === "recording" ? " recording" : voice === "transcribing" ? " busy" : ""}`} data-testid="iq-mic" data-state={voice}
            onClick={toggleVoice} disabled={busy || voice === "transcribing" || sttAvailable === false} aria-pressed={voice === "recording"}
            aria-label={voice === "recording" ? "Stop and transcribe" : "Speak an instruction"}
            title={sttAvailable === false ? "No transcription provider is configured on this Studio" : voice === "recording" ? "Stop — the recording is transcribed and proposed" : "Speak an instruction — any language; it is transcribed, read into English and proposed for review"}
          >
            <MicIcon />
            {voice === "recording" && <span className="iq-mic-pulse" aria-hidden="true" />}
          </button>
          <button type="submit" className="iq-send" disabled={busy || !text.trim() || voice !== "idle"} data-testid="iq-send" title="Propose (Enter)">
            <Icon name="chevron-right" size={14} /> Propose
          </button>
        </form>
      </section>

      {showInspector && (
        <>
          <div className="iq-divider" onPointerDown={onDividerDown} onPointerMove={onDividerMove} onPointerUp={onDividerUp} role="separator" aria-orientation="vertical" />
          <div className="cp-panel-wrap" data-testid="iq-inspector">
            <CopilotPanel copilot={copilot} def={s.def} onSelect={selectQuestion} onApply={applyCopilot} applyNote={applyNote} readOnly={s.readOnly}
              onImportQuotaSheet={() => quotaSheetRef.current?.click()} quotaImport={quotaImport}
              primary={primary} index={index} onSelectKey={(k) => selectKey(k as ObjectKey)} onAsk={(t) => void ask(t)} onTemplate={writeTemplate}
              inspector={<div className="ar-inspector-body"><Inspector primary={primary} index={index} status={status} onSelect={selectKey} /></div>} />
          </div>
        </>
      )}
      {/* the command registry is what Apply and the chips share with the other modes */}
      <span hidden data-commands={cmd ? "on" : "off"} />
    </div>
  );
}

/* ------------------------------------------------------------- the card */

function TurnCard({ turn, def, onApply, onCancel, onReview, onSelect, readOnly, save, changeN, onRetrySave }: {
  turn: Turn; def: SurveyDefinition;
  onApply(): void; onCancel(): void; onReview(): void; onSelect(key: ObjectKey): void; readOnly: boolean;
  /** an applied proposal's save, and its AI change number — the kicker says only what is true */
  save?: SaveView; changeN?: number | null; onRetrySave?(): void;
}) {
  const p = turn.proposal;
  const blocked = p.errors.length > 0;
  return (
    <article className={`iq-turn ${turn.state}`} data-testid="iq-turn" data-state={turn.state} data-kind={p.intent.kind} data-source={p.source} data-save={turn.state === "applied" && !p.readOnly ? save?.state ?? "" : ""}>
      <div className="iq-said" data-testid="iq-said"><Icon name="user" size={13} /> <span>{turn.text}</span></div>
      {turn.heard && (
        // what the microphone heard, and — when it was not English — how it was read, so the reading can be checked before Apply (§20)
        <div className="iq-heard" data-testid="iq-heard" data-language={turn.heard.language}>
          <MicIcon size={12} />
          <span><span className="iq-heard-kw">Heard{turn.heard.language && turn.heard.language !== "und" ? ` (${languageName(turn.heard.language)})` : ""}:</span> {turn.heard.text}</span>
          {turn.heard.english && turn.heard.english !== turn.heard.text && <span><span className="iq-heard-kw">Read as:</span> {turn.heard.english}</span>}
        </div>
      )}

      {p.readOnly ? (
        <div className="iq-card answer" data-testid="iq-answer">
          <div className="iq-card-head"><span className="iq-kicker">{blocked ? "NOT UNDERSTOOD" : "ANSWER"}</span>{p.source === "ai" && <span className="iq-source">model</span>}</div>
          {p.summary && <p className="iq-summary">{p.summary}</p>}
          {p.errors.map((e, i) => <p key={i} className="iq-error" data-testid="iq-error"><Icon name="warning" size={12} /> {e}</p>)}
          {p.answer && p.answer.length > 0 && (
            <ul className="iq-answer-list">
              {p.answer.map((l, i) => (
                <li key={i}>
                  {l.key ? <button type="button" className="iq-chip" onClick={() => onSelect(l.key!)} data-testid="iq-chip" data-key={l.key}>{l.text}</button> : <span>{l.text}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className={`iq-card proposal${blocked ? " blocked" : ""}`} data-testid="iq-proposal">
          <div className="iq-card-head">
            <span className="iq-kicker">{turn.state === "applied" ? appliedKicker(save, changeN) : turn.state === "cancelled" ? "CANCELLED" : blocked ? "PROPOSED CHANGE — NEEDS ATTENTION" : "PROPOSED CHANGE"}</span>
            {p.source === "ai" && <span className="iq-source" title="Read by the language model, checked by the expression parser">model</span>}
          </div>
          {p.summary && <p className="iq-summary" data-testid="iq-summary">{p.summary}</p>}
          {turn.state === "applied" && save?.state === "failed" && <SaveFailed save={save} onRetry={onRetrySave} />}
          {p.expression && (
            <div className="iq-expression" data-testid="iq-expression">
              <div className="iq-expression-row"><span className="iq-label">Condition</span><code className="mono">{p.expression.canonical || p.expression.text}</code></div>
              {p.expression.summary && <div className="iq-expression-row"><span className="iq-label">Reads as</span><span>{p.expression.summary}</span></div>}
              {p.expression.errors.map((e, i) => <p key={`e${i}`} className="iq-error" data-testid="iq-error"><Icon name="warning" size={12} /> {e.message}</p>)}
              {p.expression.warnings.map((w, i) => <p key={`w${i}`} className="iq-warning"><Icon name="warning" size={12} /> {w.message}</p>)}
            </div>
          )}
          {p.descriptions.length > 0 && (
            <ul className="iq-changes" data-testid="iq-changes">
              {p.descriptions.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          )}
          {p.errors.map((e, i) => <p key={i} className="iq-error" data-testid="iq-error"><Icon name="warning" size={12} /> {e}</p>)}
          {p.warnings.map((w, i) => <p key={i} className="iq-warning" data-testid="iq-warning"><Icon name="warning" size={12} /> {w}</p>)}
          {turn.reviewing && p.expression?.condition && (
            <div className="iq-review" data-testid="iq-review">
              <div className="iq-label">Structure</div>
              <RuleTree def={def} c={p.expression.condition} depth={0} />
            </div>
          )}
          {turn.reviewing && !p.expression?.condition && p.changes.length > 0 && (
            <div className="iq-review" data-testid="iq-review">
              <div className="iq-label">Change</div>
              <pre className="iq-json mono">{JSON.stringify(p.changes.map((c) => c.kind === "add_question" ? { ...c, question: { id: c.question.id, code: c.question.code, type: c.question.type, variant: c.question.variant, text: c.question.text, options: c.question.options?.map((o) => o.label) } } : c), null, 2)}</pre>
            </div>
          )}
          {turn.state === "open" && (
            <div className="iq-actions">
              <button type="button" className={`iq-btn${turn.reviewing ? " on" : ""}`} onClick={onReview} data-testid="iq-review-btn" disabled={!p.changes.length}>Review Logic</button>
              <span className="iq-spacer" />
              <button type="button" className="iq-btn" onClick={onCancel} data-testid="iq-cancel">Cancel</button>
              <button type="button" className="iq-btn primary" onClick={onApply} disabled={blocked || readOnly} data-testid="iq-apply" title={blocked ? "Fix the problems above first" : readOnly ? "Read-only" : "Apply this change (undoable)"}>Apply</button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/** the condition as nested groups — the structured view the brief asks for */
function RuleTree({ def, c, depth }: { def: SurveyDefinition; c: Condition; depth: number }) {
  if (c.type === "rule") return <code className="iq-rule mono">{formatCondition(def, c)}</code>;
  const label = c.op === "and" ? "ALL of" : c.op === "or" ? "ANY of" : c.children.length > 1 ? "NONE of" : "NOT";
  return (
    <div className={`iq-group ${c.op}`} data-depth={depth}>
      <span className="iq-op">{label}</span>
      <div className="iq-group-body">
        {c.children.map((k, i) => <RuleTree key={i} def={def} c={k} depth={depth + 1} />)}
      </div>
    </div>
  );
}

/** a microphone — inline, since the icon set has none */
function MicIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
    </svg>
  );
}

/** the toast after an Apply (or a retried save): what is true, with the number the server gave it */
function toastApplied(s: { surveyDbId: string; toast(msg: string, kind?: "ok" | "err"): void }, n: number | null, save: SaveView | undefined, message?: string, retry = false) {
  const as = n ? `AI change ${changeNumber(n)}` : "one change (the history could not number it)";
  const lead = message ? `${message} ` : "";
  if (!save || save.state === "saving") s.toast(`${lead}Applied as ${as}. Undo from History, or ⌘Z.`);
  else if (save.state === "saved") s.toast(retry ? `Saved ${as}.` : `${lead}Applied and saved as ${as}. Undo from History, or ⌘Z.`);
  else if (save.state === "sandbox") s.toast(`${lead}Applied as ${as} — the sandbox saves nothing. Undo from History, or ⌘Z.`);
  else s.toast(`${retry ? "Still not saved" : `Applied as ${as}, but NOT saved`} — ${save.message}. Try saving again from the card.`, "err");
}
