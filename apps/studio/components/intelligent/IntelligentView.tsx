"use client";
import React from "react";
import type { Condition, SurveyDefinition } from "@rescript/schema";
import { variantRegistry } from "@rescript/schema";
import {
  buildDependencyIndex, objectStatus, applyLogicProposal, proposalTargets, formatCondition, nextQuestionNaming,
  type ObjectKey,
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
 * a fifth way to store logic. A sentence becomes an INTENT (the
 * deterministic grammar first; the language model, when configured, for
 * what the grammar does not catch), the intent becomes a PROPOSAL against
 * the real survey (lib/intelligent/proposal.ts — the condition is parsed by
 * the expression editor's parser, the changes are validated by the engine),
 * and the proposal is SHOWN. Nothing is written until Apply, and Apply is
 * one labelled, undoable `store.update` that calls `applyLogicProposal` —
 * the same path a click in the Logic panel takes.
 *
 * Read-only questions ("what depends on Q3?") are answered from the
 * dependency index and never produce an Apply button at all.
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
}

/**
 * The conversation outlives the component. Switching to Grid to look at
 * something and coming back must not wipe what was proposed — §9 says the
 * switch feels magical, and a vanished history is the opposite. Kept per
 * survey for the life of the page, never persisted: proposals are about
 * the survey as it was when they were made.
 */
const sessions = new Map<string, Turn[]>();
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
  const [turns, setTurns] = React.useState<Turn[]>(() => sessions.get(s.surveyDbId) ?? []);
  React.useEffect(() => { sessions.set(s.surveyDbId, turns); }, [turns, s.surveyDbId]);
  const [busy, setBusy] = React.useState(false);
  /** null = unknown yet; false = 501 or no session; true = the route answered */
  const [aiAvailable, setAiAvailableState] = React.useState<boolean | null>(aiKnown);
  const setAiAvailable = React.useCallback((v: boolean) => { aiKnown = v; setAiAvailableState(v); }, []);
  const [prefs, setPrefs] = React.useState(loadPrefs);
  const [showInspector, setShowInspector] = React.useState(true);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const logRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => { try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* fine */ } }, [prefs]);
  React.useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [turns.length, busy]);

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

  /* ---------------------------------------------------------------- ask */
  const ask = React.useCallback(async (sentence: string, heard?: HeardTranscript) => {
    const t = sentence.trim();
    if (!t || busy) return;
    setBusy(true);
    setText("");
    const selectedLabel = primary?.startsWith("question:") ? (s.def.questions.find((q) => q.id === primary.slice(9))?.code ?? null) : null;
    let intent: Intent = parseIntent(t);
    let source: Proposal["source"] = "grammar";
    let plan = planProposal(s.def, intent, source, deps);
    // the grammar did not understand, or understood but could not find the object: ask the model, if there is one
    // the grammar did not understand, could not find the object, or read a condition the parser rejects: the model may know better (§17)
    const askModel = intent.kind === "unknown" || plan.errors.some((e) => /could not find/.test(e)) || (plan.expression?.errors.length ?? 0) > 0;
    if (askModel && aiAvailable !== false) {
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
    setTurns((ts) => [...ts, { id: uid("turn"), text: t, proposal: plan, state: plan.readOnly ? "applied" : "open", ...(heard ? { heard } : {}) }]);
    if (plan.targetKey) selectKey(plan.targetKey);
    setBusy(false);
    inputRef.current?.focus();
  }, [busy, primary, s.def, s.surveyDbId, deps, aiAvailable, selectKey]);

  /* -------------------------------------------------------------- apply */
  const apply = React.useCallback((turn: Turn) => {
    const p = turn.proposal;
    if (p.errors.length || p.readOnly || s.readOnly) { if (s.readOnly) s.toast("This project is read-only right now.", "err"); return; }
    let outcome: string[] = [];
    s.labelNextEdit(`Applied proposal: ${p.summary}`);
    s.update((d) => {
      const r = applyLogicProposal(d, p.changes);
      outcome = r.errors;
    });
    if (outcome.length) {
      s.toast(outcome[0], "err");
      setTurns((ts) => ts.map((x) => x.id === turn.id ? { ...x, proposal: { ...x.proposal, errors: outcome } } : x));
      return;
    }
    setTurns((ts) => ts.map((x) => x.id === turn.id ? { ...x, state: "applied" } : x));
    const targets = proposalTargets(p.changes);
    if (targets[0]) selectKey(`question:${targets[0]}` as ObjectKey);
    s.toast("Applied. Undo with ⌘Z.");
  }, [s, selectKey]);

  const cancel = (turn: Turn) => setTurns((ts) => ts.map((x) => x.id === turn.id ? { ...x, state: "cancelled" } : x));
  const review = (turn: Turn) => setTurns((ts) => ts.map((x) => x.id === turn.id ? { ...x, reviewing: !x.reviewing } : x));

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

  const open = turns.filter((t) => t.state === "open").length;

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
    <div className="iq" data-testid="intelligent-view" style={{ gridTemplateColumns: showInspector ? `minmax(0, 1fr) 6px ${prefs.inspector}px` : "minmax(0, 1fr)" }}>
      <section className="iq-main">
        <div className="iq-toolbar">
          <span className="iq-title"><Icon name="sparkle" size={14} /> Intelligent</span>
          <span className="iq-hint">Describe a change in plain language. Every change is shown for review before it is applied — nothing is written until you press Apply.</span>
          <span className="iq-spacer" />
          <span className="iq-provider" data-testid="iq-provider" data-ai={aiAvailable === null ? "unknown" : aiAvailable ? "on" : "off"} title={aiAvailable === false ? "No language model is configured on this Studio; the built-in grammar handles the common shapes." : aiAvailable ? "The built-in grammar first; the language model for what it does not catch." : "Built-in grammar; the language model is tried when a sentence is not recognised."}>
            {aiAvailable === false ? "grammar only" : aiAvailable ? "grammar + model" : "grammar"}
          </span>
          <button type="button" className={`iq-btn${showInspector ? " on" : ""}`} onClick={() => setShowInspector((v) => !v)} aria-pressed={showInspector} data-testid="iq-toggle-inspector" title="Inspector">
            <Icon name="info" size={13} /> Inspector
          </button>
        </div>

        <div className="iq-log" ref={logRef} data-testid="iq-log">
          {turns.length === 0 && (
            <div className="iq-welcome" data-testid="iq-welcome">
              <h2>How do you want to program your research?</h2>
              <p>Say it. The Studio proposes the exact rule, shows you what it will do, and waits for you to apply it.</p>
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
          {turns.map((turn) => (
            <TurnCard key={turn.id} turn={turn} def={s.def} onApply={() => apply(turn)} onCancel={() => cancel(turn)} onReview={() => review(turn)} onSelect={selectKey} readOnly={s.readOnly} />
          ))}
          {busy && <div className="iq-thinking" data-testid="iq-thinking"><span className="iq-dot" /><span className="iq-dot" /><span className="iq-dot" /></div>}
        </div>

        {voiceError && <p className="iq-voice-error" data-testid="iq-voice-error" role="alert"><Icon name="warning" size={12} /> {voiceError}</p>}
        <form className="iq-ask" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
          <textarea
            ref={inputRef} className="iq-input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
            placeholder={voice === "recording" ? "Listening… click the microphone again when you have finished." : voice === "transcribing" ? "Transcribing…" : open ? "Apply or cancel the proposal above, or describe another change…" : "Show Q5 only when Q3 = Yes and Q4 > 2 — or press the microphone and say it, in any language"}
            rows={2} data-testid="iq-input" aria-label="Describe a change" disabled={busy || voice !== "idle"}
          />
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
          <aside className="iq-inspector" data-testid="iq-inspector">
            <div className="ar-pane-head"><span className="ar-pane-title">Inspector</span></div>
            <div className="ar-inspector-body">
              <Inspector primary={primary} index={index} status={status} onSelect={selectKey} />
            </div>
          </aside>
        </>
      )}
      {/* the command registry is what Apply and the chips share with the other modes */}
      <span hidden data-commands={cmd ? "on" : "off"} />
    </div>
  );
}

/* ------------------------------------------------------------- the card */

function TurnCard({ turn, def, onApply, onCancel, onReview, onSelect, readOnly }: {
  turn: Turn; def: SurveyDefinition;
  onApply(): void; onCancel(): void; onReview(): void; onSelect(key: ObjectKey): void; readOnly: boolean;
}) {
  const p = turn.proposal;
  const blocked = p.errors.length > 0;
  return (
    <article className={`iq-turn ${turn.state}`} data-testid="iq-turn" data-state={turn.state} data-kind={p.intent.kind} data-source={p.source}>
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
            <span className="iq-kicker">{turn.state === "applied" ? "APPLIED" : turn.state === "cancelled" ? "CANCELLED" : blocked ? "PROPOSED CHANGE — NEEDS ATTENTION" : "PROPOSED CHANGE"}</span>
            {p.source === "ai" && <span className="iq-source" title="Read by the language model, checked by the expression parser">model</span>}
          </div>
          {p.summary && <p className="iq-summary" data-testid="iq-summary">{p.summary}</p>}
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
