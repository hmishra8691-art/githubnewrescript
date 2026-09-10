"use client";
import React from "react";
import type { Question, SurveyDefinition, Option, AiConversation } from "@rescript/schema";
import {
  effectiveQuestion,
  spokenSegments,
  spokenText,
  parseVoiceCommand,
  applicableCommands,
  matchSpokenAnswer,
  readBack,
  resolveVoiceLocale,
  optionSpokenLabel,
  toggleMultiValue,
  type EvalContext,
  type SpokenSegment,
  type VoiceRecord,
} from "@rescript/engine";
import { sttProvider, type SttSession } from "./providers";
import { useSpeaker } from "./speaker";

/**
 * THE VOICE CONSOLE — the respondent's side of an AI Conversational Survey
 * when voice is on.
 *
 * It sits above the question(s) on screen. It READS: the current question's
 * spoken script (engine `spokenSegments` — question, pause, options one by
 * one, grid rows, a validation error) in the survey's voice and locale, with
 * captions when they are on. It LISTENS: the respondent presses the
 * microphone (or, in voice-only mode, it listens as soon as the question has
 * been read) and what they say is either a COMMAND ("repeat", "read the
 * options", "next", "go back", "remove Samsung") or an ANSWER, which the
 * engine maps onto the question's own values — a code, a list of codes, a
 * number, a row's column, or the text of an open end. The survey stores the
 * VALUE; the transcript goes beside it only when transcripts are stored.
 *
 * It never guesses. Below the confidence threshold, or when what was said
 * matched only loosely, it asks — "Did you mean Samsung?" — and waits for a
 * yes. Multi-select changes are read back and confirmed when the survey says
 * so. What it cannot map, it says so, and the question stays answerable on
 * screen exactly as before: voice is a layer over the ordinary rendering,
 * never a replacement for it.
 *
 * Deterministic logic is untouched: the options it reads and matches are the
 * VISIBLE ones (masking applied by `effectiveQuestion`), values go through the
 * same `onChange` the screen uses, and navigation commands call the same Next
 * and Back.
 */

export interface VoiceConsoleProps {
  def: SurveyDefinition;
  /** the questions on screen, in order; the console answers `activeIndex` */
  questions: Question[];
  ctx: EvalContext;
  cfg: AiConversation;
  /** the current value of each question on screen (by index) */
  values: unknown[];
  /** validation errors on screen, by question id */
  errors?: Record<string, string>;
  onChange(q: Question, value: unknown): void;
  onOtherChange?(q: Question, text: string): void;
  onNext(): void;
  onBack(): void;
  canGoBack: boolean;
  /** a brief acknowledgement of the previous answer, spoken before the question (conversational modes) */
  acknowledgement?: string | null;
  /** record what was heard for a question (engine `recordVoice`); the console never writes state itself */
  onVoice?(q: Question, rec: Partial<VoiceRecord>): void;
  /** the survey's language, for locale matching */
  surveyLanguage?: string | null;
  /** a title for the console, e.g. the interviewer's name */
  label?: string;
}

const TEXT_TYPES = new Set(["open_text", "long_text"]);
const NUMBER_TYPES = new Set(["numeric", "slider", "nps"]);
const SINGLE_TYPES = new Set(["single_select", "dropdown", "image_select_single", "button_select", "likert", "scale"]);
const MULTI_TYPES = new Set(["multi_select", "multi_dropdown", "image_select"]);

const REASONS: Record<string, string> = {
  "not-allowed": "Microphone access was refused. Allow it in your browser and try again.",
  "service-not-allowed": "Speech recognition is not available in this browser.",
  "no-speech": "No speech was heard.",
  "audio-capture": "No microphone was found.",
  "network": "Speech recognition needs a network connection.",
  "aborted": "",
};

type Pending =
  | { kind: "value"; q: Question; value: unknown; say: string; transcript: string; confidence: number }
  | { kind: "other"; q: Question; code: string };

/** The columns a matrix question is answered with (its first column's options, else its options). */
function gridColumns(q: Question, view: ReturnType<typeof effectiveQuestion>): Option[] {
  const first = (view.columns[0] as { options?: Option[] } | undefined)?.options;
  return first?.length ? first : view.options;
}

export function VoiceConsole(p: VoiceConsoleProps) {
  const { cfg, ctx, def } = p;
  const v = cfg.voice;
  const [muted, setMuted] = React.useState(false);
  const [listening, setListening] = React.useState(false);
  const [interim, setInterim] = React.useState("");
  const [heard, setHeard] = React.useState<{ text: string; confidence: number } | null>(null);
  const [status, setStatus] = React.useState<string>("");
  const [reason, setReason] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [active, setActive] = React.useState(0);
  const [optionsRequested, setOptionsRequested] = React.useState(false);
  const [rowCode, setRowCode] = React.useState<string | undefined>(undefined);
  const [showHelp, setShowHelp] = React.useState(false);
  const [showTranscript, setShowTranscript] = React.useState(false);
  const [language, setLanguage] = React.useState<string | null>(null);
  const counters = React.useRef<Record<string, { repeats: number; clarifications: number }>>({});
  const stt = React.useRef<SttSession | null>(null);

  const activeIndex = Math.min(active, Math.max(0, p.questions.length - 1));
  const q = p.questions[activeIndex];
  const value = p.values[activeIndex];
  const view = React.useMemo(() => (q ? effectiveQuestion(q, ctx) : { options: [], rows: [], columns: [] }), [q, ctx]);
  const isGrid = !!q && /^matrix_/.test(q.type);
  const columns = React.useMemo(() => (q && isGrid ? gridColumns(q, view) : []), [q, isGrid, view]);

  /* the locale: the question's own speech language, else the survey's voice locale rules, else the respondent's */
  const respondentLocale = typeof navigator !== "undefined" ? navigator.language : null;
  const lang = language
    ?? q?.settings.speechLang
    ?? resolveVoiceLocale(v, v.locale.switching === "single" && v.locale.dialect === "match" && v.locale.language === "auto" ? null : respondentLocale, p.surveyLanguage ?? undefined);

  /* the script for what is on screen: an acknowledgement, then every shown question in order */
  const segments = React.useMemo<SpokenSegment[]>(() => {
    const out: SpokenSegment[] = [];
    if (p.acknowledgement && cfg.conversation !== "standard") out.push({ text: p.acknowledgement, kind: "ack", pauseMs: v.pauses.afterAnswerMs });
    p.questions.forEach((qq, i) => {
      const vw = i === activeIndex ? view : effectiveQuestion(qq, ctx);
      const grid = /^matrix_/.test(qq.type);
      out.push(...spokenSegments(def, qq, ctx, cfg, {
        options: grid ? gridColumns(qq, vw) : vw.options,
        rows: grid ? vw.rows.map((r) => ({ code: r.code, label: r.label })) : undefined,
        columns: grid ? gridColumns(qq, vw).map((c) => ({ code: c.code, label: optionSpokenLabel(qq, c) })) : undefined,
        error: p.errors?.[qq.id],
        optionsRequested: i === activeIndex && optionsRequested,
        rowCode: i === activeIndex ? rowCode : undefined,
      }));
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.questions, p.errors, p.acknowledgement, cfg, ctx, def, optionsRequested, rowCode, activeIndex, view]);

  const speaker = useSpeaker(segments, {
    providerKey: v.provider, lang, rate: v.audio.rate, pitch: v.audio.pitch, volume: v.audio.volume,
    profile: { gender: v.profile.gender, ageStyle: v.profile.ageStyle, voiceId: v.profile.voiceId, fallbackVoiceId: v.profile.fallbackVoiceId },
  }, !muted && v.reading.question !== false);

  /* a new set of questions on screen: start from the first one, forget requests */
  const qKey = p.questions.map((x) => x.id).join("|");
  React.useEffect(() => { setActive(0); setOptionsRequested(false); setRowCode(undefined); setPending(null); setHeard(null); setStatus(""); }, [qKey]);

  const sttP = sttProvider(v.provider);
  const canListen = !!sttP?.available() && cfg.interaction !== "text" && v.interaction.listen;
  const store = v.interaction.transcript === "store";

  const say = React.useCallback((text: string, kind: SpokenSegment["kind"] = "prompt") => {
    if (muted || !text) return;
    speaker.speakNow([{ text, kind, pauseMs: 0 }]);
  }, [muted, speaker]);

  /** read the question again — without the acknowledgement that preceded it the first time */
  const replay = () => speaker.speakNow(segments.filter((s) => s.kind !== "ack"));

  const bump = (qq: Question, k: "repeats" | "clarifications") => {
    const c = counters.current[qq.id] ?? (counters.current[qq.id] = { repeats: 0, clarifications: 0 });
    c[k] += 1;
    p.onVoice?.(qq, { [k]: c[k], lang }, );
  };

  /** Ask the respondent to confirm before anything is stored. */
  const askConfirm = (qq: Question, next: unknown, sayText: string, transcript: string, confidence: number) => {
    setPending({ kind: "value", q: qq, value: next, say: sayText, transcript, confidence });
    setStatus(`${sayText} Say "yes" to confirm or "no" to try again.`);
    say(`${sayText} Is that right?`);
  };

  const commit = (qq: Question, next: unknown, transcript: string, confidence: number) => {
    p.onChange(qq, next);
    p.onVoice?.(qq, { transcript: store ? transcript : "", confidence, lang });
    setPending(null);
    setStatus("");
    /* on a page with several questions, move on to the next unanswered one */
    if (p.questions.length > 1 && activeIndex < p.questions.length - 1) setActive(activeIndex + 1);
  };

  const clarify = (qq: Question, text: string) => {
    bump(qq, "clarifications");
    setStatus(text);
    say(text);
  };

  const optionsHelp = () => {
    const opts = (isGrid ? columns : view.options).map((o) => optionSpokenLabel(q!, o));
    return opts.length ? `You can say one of: ${opts.slice(0, 12).join(", ")}${opts.length > 12 ? ", and more" : ""}.` : "";
  };

  const handleAnswer = (qq: Question, transcript: string, confidence: number) => {
    const th = v.interaction.confidenceThreshold;
    if (TEXT_TYPES.has(qq.type)) {
      const prev = typeof value === "string" ? value : "";
      const next = [prev.trim(), transcript.trim()].filter(Boolean).join(" ");
      commit(qq, next, transcript, confidence);
      if (confidence < th) setStatus("I may have misheard — please check the text and edit it if needed.");
      return;
    }
    if (NUMBER_TYPES.has(qq.type) && !view.options.length) {
      const m = matchSpokenAnswer(qq, transcript, view.options, confidence);
      if (m.number == null) return clarify(qq, "I didn't catch a number. Please say the number again.");
      if (m.ambiguous || m.confidence < th) return askConfirm(qq, m.number, `I heard ${m.number}.`, transcript, m.confidence);
      return commit(qq, m.number, transcript, m.confidence);
    }
    if (isGrid) {
      const rows = view.rows;
      const row = rowCode ? rows.find((r) => String(r.code) === rowCode) : rows.find((r) => (value as Record<string, unknown> | undefined)?.[String(r.code)] == null) ?? rows[0];
      if (!row) return clarify(qq, "There is nothing to rate here.");
      const m = matchSpokenAnswer({ ...qq, type: qq.type === "matrix_multi" ? "multi_select" : "single_select" } as Question, transcript, columns, confidence);
      if (!m.codes.length) return clarify(qq, `I didn't catch that for ${row.label}. ${columns.length ? `You can say one of: ${columns.map((c) => optionSpokenLabel(qq, c)).join(", ")}.` : ""}`);
      const current = (value as Record<string, unknown> | undefined) ?? {};
      const cell = qq.type === "matrix_multi" ? toggleMultiValue((Array.isArray(current[String(row.code)]) ? current[String(row.code)] : []) as (string | number)[], m.codes[0], columns) : columns.find((c) => String(c.code) === m.codes[0])!.code;
      const next = { ...current, [String(row.code)]: cell };
      const label = `${row.label}: ${readBack(qq, m.codes, columns)}.`;
      if (m.ambiguous || m.confidence < th) return askConfirm(qq, next, `I heard ${label}`, transcript, m.confidence);
      p.onChange(qq, next);
      p.onVoice?.(qq, { transcript: store ? transcript : "", confidence: m.confidence, lang });
      const idx = rows.findIndex((r) => String(r.code) === String(row.code));
      const nextRow = rows.slice(idx + 1).find((r) => next[String(r.code)] == null) ?? rows.find((r) => next[String(r.code)] == null);
      setRowCode(nextRow ? String(nextRow.code) : undefined);
      setStatus(nextRow ? `${label} Next: ${nextRow.label}.` : `${label} All rows answered.`);
      // in respondent-driven grids the new row is read by the script itself (rowCode changed); otherwise name it here
      if (!nextRow) say("Thank you. That is every row."); else if (v.reading.gridMode !== "respondent_driven") say(nextRow.label, "row");
      return;
    }
    const multi = MULTI_TYPES.has(qq.type);
    if (!SINGLE_TYPES.has(qq.type) && !multi && !view.options.length) {
      setStatus("This question is answered on screen. You can still say “next”, “back” or “repeat”.");
      return;
    }
    const m = matchSpokenAnswer(qq, transcript, view.options, confidence);
    if (!m.codes.length && !m.removed.length) {
      return clarify(qq, v.interaction.clarification ? `I didn't catch that. ${optionsHelp()}` : "I didn't catch that.");
    }
    if (m.other && m.codes.length) {
      const code = m.codes[0];
      const next = multi ? toggleMultiValue((Array.isArray(value) ? value : []) as (string | number)[], code, view.options, qq.settings.maxSelections) : code;
      p.onChange(qq, next);
      p.onVoice?.(qq, { transcript: store ? transcript : "", confidence: m.confidence, lang });
      setPending({ kind: "other", q: qq, code });
      setStatus("Other — please say what it is.");
      say("Other. Please tell me what it is.");
      return;
    }
    if (multi) {
      let arr = (Array.isArray(value) ? value : []) as (string | number)[];
      for (const c of m.codes) if (!arr.some((x) => String(x) === c)) arr = toggleMultiValue(arr, view.options.find((o) => String(o.code) === c)!.code, view.options, qq.settings.maxSelections);
      for (const c of m.removed) if (arr.some((x) => String(x) === c)) arr = toggleMultiValue(arr, view.options.find((o) => String(o.code) === c)!.code, view.options, qq.settings.maxSelections);
      const words = [m.codes.length ? `added ${readBack(qq, m.codes, view.options)}` : "", m.removed.length ? `removed ${readBack(qq, m.removed, view.options)}` : ""].filter(Boolean).join(" and ");
      const sel = arr.map(String);
      const summary = sel.length ? `You now have ${readBack(qq, sel, view.options)}.` : "Nothing is selected.";
      if (m.ambiguous || m.confidence < th || (v.interaction.confirmMultiSelect && v.interaction.clarifyAmbiguous && m.unmatched.length)) return askConfirm(qq, arr, `I heard ${words}. ${summary}`, transcript, m.confidence);
      // "none of the above" is unambiguous — it is not read back for confirmation
      if (v.interaction.confirmMultiSelect && !m.none) return askConfirm(qq, arr, `I ${words}. ${summary}`, transcript, m.confidence);
      commit(qq, arr, transcript, m.confidence);
      setStatus(summary);
      say(summary, "ack");
      return;
    }
    const code = m.codes[0];
    const opt = view.options.find((o) => String(o.code) === code)!;
    if (m.ambiguous || m.confidence < th) return askConfirm(qq, opt.code, `I heard ${optionSpokenLabel(qq, opt)}.`, transcript, m.confidence);
    commit(qq, opt.code, transcript, m.confidence);
    setStatus(`${optionSpokenLabel(qq, opt)}.`);
    say(optionSpokenLabel(qq, opt), "ack");
  };

  const handleUtterance = (transcript: string, confidence: number) => {
    if (!q) return;
    setHeard({ text: transcript, confidence });
    const cmd = parseVoiceCommand(transcript);

    /* a confirmation in progress */
    if (pending) {
      if (pending.kind === "other") {
        if (cmd?.kind === "next" || cmd?.kind === "back" || cmd?.kind === "repeat") { setPending(null); }
        else { p.onOtherChange?.(pending.q, transcript.trim()); setPending(null); setStatus(`Other: ${transcript.trim()}`); say("Thank you.", "ack"); return; }
      } else if (cmd?.kind === "confirm" || (cmd?.kind === "none" && /^(no|nope)$/i.test(transcript.trim()))) {
        const yes = cmd.kind === "confirm" ? cmd.yes : false;
        if (yes) { commit(pending.q, pending.value, pending.transcript, pending.confidence); say("Thank you.", "ack"); }
        else { setPending(null); setStatus("Okay — please say your answer again."); say("Okay, please say it again."); }
        return;
      } else if (!cmd || cmd.kind === "select" || cmd.kind === "remove") {
        /* they answered again instead of confirming: take the new answer */
        setPending(null);
      }
    }

    const hasOptions = (isGrid ? columns : view.options).length > 0;
    const allowed = new Set(applicableCommands(q, value != null, p.canGoBack, hasOptions));
    if (cmd && v.interaction.navigationCommands && allowed.has(cmd.kind)) {
      switch (cmd.kind) {
        case "next": setStatus(""); p.onNext(); return;
        case "back": setStatus(""); p.onBack(); return;
        case "skip": setStatus("Skipped."); p.onNext(); return;
        case "repeat": bump(q, "repeats"); replay(); return;
        case "clarify": bump(q, "clarifications"); setStatus(spokenText(segments.filter((s) => s.kind !== "ack"))); replay(); return;
        case "help": setShowHelp(true); say(`You can say: ${[...allowed].filter((k) => k !== "select" && k !== "remove" && k !== "row").join(", ")}${hasOptions ? ", or the name of an option" : ""}.`); return;
        case "read_options": bump(q, "repeats"); speaker.speakNow(spokenSegments(def, q, ctx, cfg, { options: isGrid ? columns : view.options, optionsRequested: true }).filter((s) => s.kind === "option" || s.kind === "prompt")); return;
        case "select": handleAnswer(q, cmd.target, confidence); return;
        case "remove": handleAnswer(q, `remove ${cmd.target}`, confidence); return;
        case "row": {
          const m = matchSpokenAnswer({ ...q, type: "single_select", options: view.rows.map((r) => ({ code: r.code, label: r.label })) } as Question, cmd.target, view.rows as unknown as Option[], confidence);
          if (m.codes.length) { setRowCode(m.codes[0]); const r = view.rows.find((x) => String(x.code) === m.codes[0]); setStatus(`Rating ${r?.label}.`); say(`${r?.label}. ${columns.map((c) => optionSpokenLabel(q, c)).join(", ")}.`); }
          else clarify(q, "Which row? Please say its name.");
          return;
        }
        case "none": case "other": handleAnswer(q, transcript, confidence); return;
        default: break;
      }
    }
    handleAnswer(q, transcript, confidence);
  };

  const startListening = () => {
    if (!sttP || listening) return;
    speaker.stop();
    setReason(null);
    setInterim("");
    setListening(true);
    let finalText = "", conf = 1, got = false;
    stt.current = sttP.start({ lang, continuous: false, interim: true }, (r) => {
      if (r.isFinal) { finalText += (finalText ? " " : "") + r.transcript; conf = Math.min(conf, r.confidence); got = true; }
      else setInterim(r.transcript);
    }, (why) => {
      setListening(false);
      setInterim("");
      if (why && REASONS[why] !== "") { setReason(REASONS[why] ?? `Speech recognition failed (${why}).`); }
      if (got && finalText.trim()) handleUtterance(finalText.trim(), conf);
    });
  };
  const stopListening = () => { stt.current?.stop(); setListening(false); };
  React.useEffect(() => () => stt.current?.abort(), []);

  /* voice-only: listen as soon as the script has been read */
  const wasSpeaking = React.useRef(false);
  React.useEffect(() => {
    if (cfg.interaction === "voice" && canListen && wasSpeaking.current && !speaker.speaking && !listening && !muted) startListening();
    wasSpeaking.current = speaker.speaking;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaker.speaking]);

  if (!q) return null;
  const caption = speaker.segmentIndex != null ? segments[speaker.segmentIndex]?.text : null;
  const languages = v.locale.switching === "respondent" ? [v.locale.language !== "auto" ? v.locale.language : lang.split("-")[0], v.locale.secondaryLanguage].filter((x): x is string => !!x) : [];

  return (
    <div
      className={`rs-voice-console${listening ? " listening" : ""}${speaker.speaking ? " speaking" : ""}`}
      data-testid="rs-voice-bar"
      data-speaking={speaker.speaking ? "1" : "0"}
      data-muted={muted ? "1" : "0"}
      data-listening={listening ? "1" : "0"}
      data-lang={lang}
      data-active-qid={q.id}
      data-pending={pending ? "1" : "0"}
      role="region"
      aria-label={p.label ?? "Voice interviewer"}
    >
      <div className="rs-voice-row">
        <span className="rs-voice-label">
          {p.label ?? "Voice interviewer"}
          {" · "}
          {!speaker.available && !canListen
            ? "not available in this browser"
            : muted ? "sound off" : speaker.speaking ? "speaking…" : listening ? "listening…" : "ready"}
        </span>
        <span className="rs-voice-controls">
          {speaker.available && (
            <>
              <button type="button" className="rs-btn-mini" data-testid="rs-voice-replay" onClick={() => { bump(q, "repeats"); replay(); }} disabled={muted} aria-label="Read the question again">🔊 Repeat</button>
              {(isGrid ? columns : view.options).length > 0 && v.reading.optionMode !== "none" && (
                <button type="button" className="rs-btn-mini" data-testid="rs-voice-options" onClick={() => { speaker.speakNow(spokenSegments(def, q, ctx, cfg, { options: isGrid ? columns : view.options, optionsRequested: true }).filter((s) => s.kind === "option" || s.kind === "prompt")); }} disabled={muted}>Read options</button>
              )}
              <button type="button" className="rs-btn-mini" data-testid="rs-voice-mute" onClick={() => { setMuted((m) => !m); if (!muted) speaker.stop(); }} aria-pressed={muted}>{muted ? "Unmute" : "Mute"}</button>
            </>
          )}
          {canListen && (
            <button
              type="button"
              className={`rs-btn-mini rs-voice-mic${listening ? " on" : ""}`}
              data-testid="rs-voice-mic"
              aria-pressed={listening}
              aria-label={listening ? "Stop listening" : "Answer by voice"}
              onClick={listening ? stopListening : startListening}
            >{listening ? "■ Stop" : "🎤 Speak"}</button>
          )}
          {languages.length > 1 && (
            <select className="rs-voice-lang" data-testid="rs-voice-lang" value={lang.split("-")[0]} onChange={(e) => setLanguage(e.target.value)} aria-label="Language">
              {languages.map((l) => <option key={l} value={l}>{l.toUpperCase()}</option>)}
            </select>
          )}
          <button type="button" className="rs-btn-mini" data-testid="rs-voice-help" onClick={() => setShowHelp((h) => !h)} aria-expanded={showHelp}>?</button>
        </span>
      </div>
      {v.interaction.captions && (caption || speaker.speaking) && (
        <div className="rs-voice-caption" data-testid="rs-voice-caption" aria-live="polite">{caption}</div>
      )}
      {p.questions.length > 1 && (
        <div className="rs-voice-active" data-testid="rs-voice-active">Answering: <span dangerouslySetInnerHTML={{ __html: q.text }} /></div>
      )}
      {(listening || interim) && (
        <div className="rs-voice-heard" data-testid="rs-voice-interim" aria-live="polite">{interim ? `“${interim}”` : "Listening…"}</div>
      )}
      {heard && !listening && (
        <div className="rs-voice-heard" data-testid="rs-voice-heard" data-confidence={heard.confidence.toFixed(2)}>You said: “{heard.text}”</div>
      )}
      {status && <div className="rs-voice-status" role="status" data-testid="rs-voice-status">{status}</div>}
      {pending?.kind === "value" && (
        <div className="rs-voice-confirm" data-testid="rs-voice-confirm">
          <button type="button" className="rs-btn-mini" data-testid="rs-voice-yes" onClick={() => { commit(pending.q, pending.value, pending.transcript, pending.confidence); }}>Yes</button>
          <button type="button" className="rs-btn-mini" data-testid="rs-voice-no" onClick={() => { setPending(null); setStatus(""); }}>No</button>
        </div>
      )}
      {reason && <div className="rs-voice-reason" role="status" data-testid="rs-voice-reason">{reason}</div>}
      {showHelp && (
        <div className="rs-voice-help" data-testid="rs-voice-help-panel">
          <strong>You can say:</strong> {applicableCommands(q, value != null, p.canGoBack, (isGrid ? columns : view.options).length > 0).map((k) => ({
            next: "“next”", back: "“go back”", repeat: "“repeat”", skip: "“skip”", help: "“help”", read_options: "“read the options”", none: "“none”", other: "“other”", select: "“select …”", remove: "“remove …”", row: "“rate … first”", clarify: "“I didn't understand”", confirm: "“yes” / “no”",
          })[k]).join(", ")}{(isGrid ? columns : view.options).length > 0 ? ", or the name of an option" : ""}.
          <button type="button" className="rs-btn-mini" data-testid="rs-voice-transcript-toggle" onClick={() => setShowTranscript((t) => !t)} style={{ marginLeft: 8 }}>{showTranscript ? "Hide script" : "Show script"}</button>
          {showTranscript && <div className="rs-voice-script" data-testid="rs-voice-script">{spokenText(segments)}</div>}
        </div>
      )}
    </div>
  );
}
