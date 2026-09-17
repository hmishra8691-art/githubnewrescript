"use client";
import React from "react";
import type { Condition, SkipRule, SurveyDefinition } from "@rescript/schema";
import type { ResponseState } from "@rescript/engine";
import {
  RecordingUploader, pickAudioMime, pickRecordingMime, type UploadState,
} from "@/lib/uploader";
import {
  CHOICE_KINDS, CODE_LANGUAGES, CODE_LANGUAGE_SAY, PERMISSION_SAY, RECORDED_KINDS, RESPONSE_SAY, TYPED_KINDS, answerValueOf,
  checkCodeAnswer, codeAnswerLanguage, continueFlow, expectedBytes, permissionAdvice, readCodeSettings, resumeFlow,
  toResponseState, toSurveyDefinition,
  type CodeLanguage, type CodeSettings, type FlowKind, type FlowPosition,
} from "@rescript/interviews";
import { CodeEditor } from "@/components/CodeEditor";

/**
 * THE CANDIDATE'S INTERVIEW — ONE SCREEN, START TO FINISH.
 *
 * One rule above all others, unchanged from the first version: **nobody is
 * told an answer is safe until the store has confirmed it.** The word "Saved"
 * appears in one place in this file and it is downstream of a HEAD the server
 * performed against the object store.
 *
 * ## What changed, and why it is not a collection of features
 *
 * The previous version was a video recorder that showed one prompt after
 * another in a fixed order. This one is an interview:
 *
 *  · the ORDER is decided by `@rescript/engine` — the same condition language,
 *    display logic and skip rules the survey side has run for years, driven
 *    through one adapter (`toSurveyDefinition`). The browser walks the flow
 *    to know what to show next; the server walks it again at `finish` and is
 *    the only authority on what was owed;
 *  · a question may be answered by VIDEO, AUDIO, typed TEXT, or a CHOICE, and
 *    the screen asks for a camera only when something needs one;
 *  · a question may have the INTERVIEWER ASKING IT on video. That clip plays
 *    itself when the question appears, cannot be scrubbed past, and nothing
 *    may be answered until it has ended — enforced here as a disabled control
 *    and on the server as a refused request, because a gate that only lives
 *    in a browser is a suggestion;
 *  · while the candidate speaks, a LIVE TRANSCRIPT preview appears where the
 *    browser offers one. It is labelled as a preview and is never stored: the
 *    transcript of record comes from the recording, later, server-side;
 *  · every telemetry event names the QUESTION it happened on. Previously
 *    `response_id` and `question_id` were null on every row, which is why
 *    "time spent on each question" was unrecoverable even from raw data.
 *
 * ## Telemetry is a courtesy, not a verdict
 *
 * Batched, flushed on a timer and on unmount, never allowed to interrupt
 * anything, and every kind has one neutral sentence in `TELEMETRY_SAY`. The
 * gap between `question_shown` and `answer_started` is a subtraction a
 * reviewer can see, not a number this screen asserts about a person.
 */

type Phase = "loading" | "gate" | "devices" | "consent" | "question" | "done";

interface Question {
  responseId: string; questionId: string; code: string; position: number;
  prompt: string; guidance: string; kind: FlowKind;
  required: boolean; minSeconds: number | null; maxSeconds: number;
  maxRetries: number; thinkSeconds: number; status: string; retries: number;
  options: { code: string; label: string }[];
  answerText: string | null; answerValue: unknown;
  promptMedia: { id: string; mimeType: string | null; durationSeconds: number | null } | null;
  promptWatchedAt: string | null;
  visibleIf: Condition | null;
  skipLogic: SkipRule[];
  /** the code question's own settings; absent for every other kind */
  codeSettings?: CodeSettings | null;
}

interface StartReply {
  ok: boolean;
  interview: { id: string; status: string; candidateName: string | null; consentGivenAt: string | null; isTest: boolean };
  project: { name: string; instructions: string; consentText: string; mode?: string; retentionSay?: string | null };
  questions: Question[];
  sequence: string[];
  seed: string | null;
  projectName: string;
  canRecord: boolean;
  error?: string;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * How long to wait for the interview to open before saying so.
 *
 * `fetch` has no timeout of its own, and the respondent has no way to tell a
 * slow server from a dead one. Twenty seconds is long enough for a bad mobile
 * connection and short enough that nobody sits staring at a spinner.
 */
const BOOT_TIMEOUT_MS = 20_000;

/** The browser's speech recogniser, where there is one. Chrome and Safari; not Firefox. */
type Recogniser = {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: (() => void) | null; onend: (() => void) | null;
  start(): void; stop(): void;
};
function makeRecogniser(): Recogniser | null {
  const w = globalThis as unknown as { SpeechRecognition?: new () => Recogniser; webkitSpeechRecognition?: new () => Recogniser };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  try { return new Ctor(); } catch { return null; }
}

export function Interview({ token }: { token: string }) {
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [fatal, setFatal] = React.useState<string | null>(null);
  const [data, setData] = React.useState<StartReply | null>(null);
  const [currentId, setCurrentId] = React.useState<string | null>(null);
  const [agreed, setAgreed] = React.useState(false);

  const streamRef = React.useRef<MediaStream | null>(null);
  const monitorRef = React.useRef<HTMLVideoElement | null>(null);
  const [camera, setCamera] = React.useState<"granted" | "denied" | "prompt" | "unavailable">("prompt");
  const [mic, setMic] = React.useState<"granted" | "denied" | "prompt" | "unavailable">("prompt");

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const audioRecorderRef = React.useRef<MediaRecorder | null>(null);
  const uploaderRef = React.useRef<RecordingUploader | null>(null);
  /** the audio-only companion's uploader — what actually gets transcribed */
  const audioUploaderRef = React.useRef<RecordingUploader | null>(null);
  const startedAtRef = React.useRef(0);
  const tickRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const [recording, setRecording] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [upload, setUpload] = React.useState<UploadState | null>(null);

  /* the stimulus clip */
  const promptRef = React.useRef<HTMLVideoElement | null>(null);
  const [promptUrl, setPromptUrl] = React.useState<string | null>(null);
  const [promptState, setPromptState] = React.useState<"idle" | "loading" | "playing" | "blocked" | "ended" | "failed">("idle");
  const watchedToRef = React.useRef(0);

  /* thinking time and typed answers */
  const [thinkLeft, setThinkLeft] = React.useState<number | null>(null);
  const [typed, setTyped] = React.useState("");
  const [chosen, setChosen] = React.useState<string[]>([]);
  const [codeLanguage, setCodeLanguage] = React.useState<CodeLanguage>("python");
  const [saving, setSaving] = React.useState(false);

  /* the live transcript preview */
  const recogniserRef = React.useRef<Recogniser | null>(null);
  const [liveText, setLiveText] = React.useState("");
  const [liveSupported, setLiveSupported] = React.useState<boolean | null>(null);

  /* the flow, walked by the engine */
  const defRef = React.useRef<SurveyDefinition | null>(null);
  const flowRef = React.useRef<ResponseState | null>(null);

  /* ---------------------------------------------------------- telemetry */

  const queue = React.useRef<{ kind: string; detail?: Record<string, unknown>; clientAt: string; responseId?: string; questionId?: string }[]>([]);
  const currentRef = React.useRef<Question | null>(null);
  /**
   * Every event is attributed to the question on screen unless told otherwise.
   * This is the fix for `response_id` and `question_id` being null on every
   * telemetry row the product had ever written.
   */
  const tell = React.useCallback((kind: string, detail?: Record<string, unknown>, at?: { responseId?: string; questionId?: string }) => {
    const q = currentRef.current;
    queue.current.push({
      kind, detail, clientAt: new Date().toISOString(),
      responseId: at?.responseId ?? q?.responseId, questionId: at?.questionId ?? q?.questionId,
    });
    if (queue.current.length > 30) void flush();
  }, []);
  const flush = React.useCallback(async () => {
    const events = queue.current.splice(0, queue.current.length);
    if (!events.length) return;
    try {
      await fetch("/api/candidate/telemetry", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, events }), keepalive: true,
      });
    } catch { /* never a reason a candidate sees anything */ }
  }, [token]);

  /* --------------------------------------------------------------- boot */

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ctl = new AbortController();
        const deadline = setTimeout(() => ctl.abort(), BOOT_TIMEOUT_MS);
        let reply: StartReply;
        try {
          const res = await fetch("/api/candidate/start", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ token }), signal: ctl.signal,
          });
          reply = (await res.json()) as StartReply;
          if (cancelled) return;
          if (!res.ok || !reply.ok) { setFatal(reply.error ?? "This interview could not be opened."); setPhase("gate"); return; }
        } finally {
          clearTimeout(deadline);
        }

        if (!reply.questions.length) {
          setFatal("This interview has no questions yet. Please tell whoever invited you — there is nothing for you to do here until they add them.");
          setPhase("gate");
          return;
        }

        /*
         * Build the same definition the server builds at `finish`, from the
         * same rows, and let the engine say where to begin. Answers already
         * given feed the state so a reload resumes at the right place — and
         * a question whose display logic now hides it is walked past rather
         * than shown.
         */
        const def = toSurveyDefinition(
          { id: reply.interview.id, name: reply.projectName },
          reply.questions.map((q) => ({
            id: q.questionId, code: q.code, kind: q.kind, prompt: q.prompt, required: q.required,
            options: q.options, visibleIf: q.visibleIf, skipLogic: q.skipLogic,
          })),
          reply.sequence,
        );
        const state = toResponseState(def, { id: reply.interview.id, seed: reply.seed }, reply.questions.map((q) => ({
          questionId: q.questionId, status: q.status, answerKind: q.kind,
          answerText: q.answerText, answerValue: q.answerValue,
        })));
        defRef.current = def;
        flowRef.current = state;

        const firstOpen = reply.sequence.findIndex((id) => {
          const q = reply.questions.find((x) => x.questionId === id);
          return q && q.status !== "stored" && q.status !== "skipped";
        });
        const pos = firstOpen < 0
          ? resumeFlow(def, state, reply.sequence.length - 1)
          : resumeFlow(def, state, firstOpen);

        setData(settleHidden(reply, pos));
        setCurrentId(pos.questionId ?? reply.sequence[reply.sequence.length - 1] ?? null);
        setPhase("devices");
        setAgreed(!!reply.interview.consentGivenAt);
      } catch (e) {
        if (cancelled) return;
        setFatal((e as Error)?.name === "AbortError"
          ? "The server did not answer in time. Please check your connection and reload this page."
          : "We could not reach the server. Please check your connection and reload.");
        setPhase("gate");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /**
   * Questions the engine walked past are told to the server as skipped by
   * logic, so a row that was never shown does not sit `pending` for ever and
   * make `finish` think something is missing. Returns the reply with those
   * rows marked, without mutating the one it was given.
   */
  function settleHidden(reply: StartReply, pos: FlowPosition): StartReply {
    const hidden = new Set(pos.hiddenByLogic);
    if (!hidden.size) return reply;
    for (const q of reply.questions) {
      if (!hidden.has(q.questionId) || q.status === "stored" || q.status === "skipped") continue;
      void fetch("/api/candidate/answer", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, responseId: q.responseId, action: "skip", reason: "logic" }),
      }).catch(() => {});
    }
    return {
      ...reply,
      questions: reply.questions.map((q) =>
        hidden.has(q.questionId) && q.status !== "stored" && q.status !== "skipped" ? { ...q, status: "skipped" } : q),
    };
  }

  /* the browser's account of itself */
  React.useEffect(() => {
    const hidden = () => tell(document.hidden ? "visibility_hidden" : "visibility_visible");
    const blur = () => tell("window_blurred");
    const focus = () => tell("window_focused");
    const copy = () => tell("copy");
    const paste = () => tell("paste");
    const offline = () => { tell("network_offline"); void uploaderRef.current?.resume(); };
    const online = () => { tell("network_online"); void uploaderRef.current?.resume(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    document.addEventListener("copy", copy);
    document.addEventListener("paste", paste);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    tell("page_reloaded");
    const beat = setInterval(() => void flush(), 20_000);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      document.removeEventListener("copy", copy);
      document.removeEventListener("paste", paste);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      clearInterval(beat);
      void flush();
    };
  }, [tell, flush]);

  React.useEffect(() => {
    if (!recording && upload?.phase !== "uploading" && !saving) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recording, upload?.phase, saving]);

  /* ------------------------------------------------------------- devices */

  const current = React.useMemo(
    () => data?.questions.find((q) => q.questionId === currentId) ?? null,
    [data, currentId],
  );
  currentRef.current = current;

  /** Does anything in this interview need a camera? A microphone? */
  const needs = React.useMemo(() => {
    const kinds = new Set((data?.questions ?? []).map((q) => q.kind));
    return { camera: kinds.has("video"), mic: kinds.has("video") || kinds.has("audio") };
  }, [data]);

  const openDevices = React.useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: needs.camera ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false,
        audio: true,
      });
      streamRef.current = stream;
      if (monitorRef.current) {
        monitorRef.current.srcObject = stream;
        monitorRef.current.muted = true;
        await monitorRef.current.play().catch(() => {});
      }
      setCamera(!needs.camera ? "granted" : stream.getVideoTracks().length ? "granted" : "unavailable");
      setMic(stream.getAudioTracks().length ? "granted" : "unavailable");
      tell("camera_permission", { state: "granted" });
      tell("microphone_permission", { state: "granted" });
      for (const track of stream.getTracks()) {
        track.addEventListener("ended", () => {
          tell(track.kind === "video" ? "camera_lost" : "microphone_lost");
          /* legible, not silent: a dead track means the next take would be black or mute */
          if (track.kind === "video") setCamera("unavailable"); else setMic("unavailable");
        });
      }
    } catch (e) {
      const name = (e as Error)?.name ?? "";
      const state = name === "NotFoundError" ? "unavailable" : "denied";
      setCamera(state); setMic(state);
      tell("camera_permission", { state });
      tell("microphone_permission", { state });
    }
  }, [tell, needs.camera]);

  /*
   * THE SELF-VIEW, RE-ATTACHED WHEREVER IT MOUNTS.
   *
   * `monitorRef` is bound to a `<video>` on the devices screen and to a
   * different one on the question screen. React unmounts the first and mounts
   * the second with an empty `srcObject`, so the candidate used to record into
   * a black box. Whenever the current element changes and a stream exists, it
   * is attached again.
   */
  React.useEffect(() => {
    const el = monitorRef.current;
    const stream = streamRef.current;
    if (!el || !stream || el.srcObject === stream) return;
    el.srcObject = stream;
    el.muted = true;
    void el.play().catch(() => {});
  }, [phase, currentId]);

  React.useEffect(() => () => {
    for (const t of streamRef.current?.getTracks() ?? []) t.stop();
    recogniserRef.current?.stop();
  }, []);

  /* ------------------------------------------------------------- consent */

  async function giveConsent() {
    const res = await fetch("/api/candidate/consent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, agreed: true }),
    });
    const reply = await res.json().catch(() => ({}));
    if (!res.ok || !reply.ok) { setFatal(reply.error ?? "We could not record your agreement."); return; }
    setAgreed(true);
    tell("consent_given");
    setPhase("question");
  }

  /* --------------------------------------------------- the question shown */

  /*
   * Entering a question: say so, reset the per-question controls, load the
   * clip if there is one, start the thinking clock if there is no clip.
   */
  React.useEffect(() => {
    if (phase !== "question" || !current) return;
    tell("question_shown", { code: current.code, kind: current.kind });
    if (current.kind === "code") {
      const cs = readCodeSettings(current.codeSettings);
      /* a reload shows what was written; a fresh question shows the interviewer's starter */
      setTyped(current.answerText ?? cs.starter);
      setCodeLanguage(codeAnswerLanguage(current.answerValue, cs.language));
      setChosen([]);
    } else {
      setTyped(current.answerText ?? "");
      setChosen(Array.isArray(current.answerValue) ? current.answerValue.map(String)
        : current.answerValue ? [String(current.answerValue)] : []);
    }
    setLiveText("");
    setUpload(null);
    setElapsed(0);
    setFatal(null);
    watchedToRef.current = 0;

    if (current.promptMedia && !current.promptWatchedAt) {
      setPromptState("loading");
      setThinkLeft(null);
      void loadPrompt(current);
    } else {
      setPromptState(current.promptMedia ? "ended" : "idle");
      setPromptUrl(null);
      beginThinking(current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, currentId]);

  function beginThinking(q: Question) {
    if (q.status === "stored" || !q.thinkSeconds || !RECORDED_KINDS.includes(q.kind)) { setThinkLeft(null); return; }
    setThinkLeft(q.thinkSeconds);
  }
  React.useEffect(() => {
    if (thinkLeft === null || thinkLeft <= 0) return;
    const t = setTimeout(() => setThinkLeft((n) => (n === null ? null : n - 1)), 1000);
    return () => clearTimeout(t);
  }, [thinkLeft]);

  async function loadPrompt(q: Question) {
    if (!q.promptMedia) return;
    try {
      const res = await fetch("/api/candidate/prompt", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, mediaId: q.promptMedia.id }),
      });
      const reply = await res.json().catch(() => ({}));
      if (!res.ok || !reply.ok) { setPromptState("failed"); return; }
      setPromptUrl(reply.url);
    } catch { setPromptState("failed"); }
  }

  /*
   * AUTOPLAY, AND WHAT TO DO WHEN THE BROWSER REFUSES IT.
   *
   * Browsers allow unmuted autoplay only after a user gesture on the page. The
   * candidate has pressed Continue and Agree by now, so `play()` normally
   * succeeds. When it does not — a strict setting, a background tab — the
   * promise rejects and the screen shows one Play button rather than a frozen
   * frame. The gate is the same either way: nothing is answerable until
   * `ended`.
   */
  React.useEffect(() => {
    const el = promptRef.current;
    if (!el || !promptUrl) return;
    el.currentTime = 0;
    el.play().then(() => setPromptState("playing")).catch(() => setPromptState("blocked"));
  }, [promptUrl]);

  function onPromptTime() {
    const el = promptRef.current;
    if (!el) return;
    /*
     * No scrubbing forward. Seeking past the furthest point actually watched
     * is snapped back — the clip can be rewatched, not skipped. `seeking` is
     * the event the scrubber fires; `timeupdate` keeps the high-water mark.
     */
    if (el.currentTime > watchedToRef.current + 1.5) el.currentTime = watchedToRef.current;
    else watchedToRef.current = Math.max(watchedToRef.current, el.currentTime);
  }

  async function onPromptEnded() {
    if (!current) return;
    setPromptState("ended");
    void fetch("/api/candidate/answer", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, responseId: current.responseId, action: "watched" }),
    }).catch(() => {});
    setData((d) => d && ({
      ...d,
      questions: d.questions.map((q) =>
        q.responseId === current.responseId ? { ...q, promptWatchedAt: new Date().toISOString() } : q),
    }));
    beginThinking(current);
  }

  /** the one condition every answer control shares */
  const promptGateOpen = !current?.promptMedia || !!current.promptWatchedAt || promptState === "ended";

  /* ----------------------------------------------------------- recording */

  function startLiveTranscript() {
    const r = makeRecogniser();
    if (!r) { setLiveSupported(false); tell("live_transcript_unsupported"); return; }
    setLiveSupported(true);
    r.continuous = true; r.interimResults = true; r.lang = navigator.language || "en";
    let finalText = "";
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        const t = res[0]?.transcript ?? "";
        if (res.isFinal) finalText += `${t} `; else interim += t;
      }
      setLiveText(`${finalText}${interim}`.trim());
    };
    r.onerror = () => { /* a preview that fails is a preview that stops */ };
    r.onend = () => { /* nothing: the recording decides when we are done */ };
    try { r.start(); recogniserRef.current = r; } catch { setLiveSupported(false); }
  }
  function stopLiveTranscript() {
    try { recogniserRef.current?.stop(); } catch { /* already stopped */ }
    recogniserRef.current = null;
  }

  async function startRecording() {
    if (!current || !streamRef.current || !promptGateOpen) return;
    const video = current.kind === "video";
    const mime = video ? pickRecordingMime() : pickAudioMime();
    const tracks = video ? streamRef.current : new MediaStream(streamRef.current.getAudioTracks());
    tell("answer_started", { code: current.code, kind: current.kind, afterThinkSeconds: current.thinkSeconds - (thinkLeft ?? 0) });
    setThinkLeft(null);

    const uploader = new RecordingUploader({
      token,
      responseId: current.responseId,
      mimeType: mime,
      estimatedBytes: expectedBytes(current.maxSeconds, video ? "video" : "audio"),
      beginExtra: video ? {} : { kind: "answer_audio" },
      onState: setUpload,
      onTelemetry: tell,
    });
    uploaderRef.current = uploader;
    try {
      await uploader.begin();
    } catch {
      return;   // the uploader has already set a message
    }

    const recorder = new MediaRecorder(tracks, video
      ? { mimeType: mime, videoBitsPerSecond: 900_000, audioBitsPerSecond: 96_000 }
      : { mimeType: mime, audioBitsPerSecond: 64_000 });
    recorder.ondataavailable = (e) => { if (e.data.size) uploader.push(e.data); };
    recorderRef.current = recorder;

    /*
     * The audio-only companion is what gets transcribed, for VIDEO answers. An
     * audio answer IS its own companion — one recording, labelled
     * `answer_audio`, transcribed directly — so no second recorder is made.
     */
    if (video) {
      try {
        const audioMime = pickAudioMime();
        const audioUploader = new RecordingUploader({
          token,
          responseId: current.responseId,
          mimeType: audioMime,
          estimatedBytes: expectedBytes(current.maxSeconds, "audio"),
          beginExtra: { kind: "answer_audio" },
          onState: () => {},
          onTelemetry: tell,
        });
        const audio = new MediaRecorder(new MediaStream(streamRef.current.getAudioTracks()), {
          mimeType: audioMime, audioBitsPerSecond: 64_000,
        });
        audio.ondataavailable = (e) => { if (e.data.size) audioUploader.push(e.data); };
        audioRecorderRef.current = audio;
        audioUploaderRef.current = audioUploader;
        await audioUploader.begin();
        audio.start(5000);
      } catch {
        audioRecorderRef.current = null;
        void audioUploaderRef.current?.abandon();
        audioUploaderRef.current = null;
      }
    }

    recorder.start(5000);
    startLiveTranscript();
    startedAtRef.current = Date.now();
    setElapsed(0);
    setRecording(true);
    tell("recording_started", { code: current.code });

    tickRef.current = setInterval(() => {
      const s = (Date.now() - startedAtRef.current) / 1000;
      setElapsed(s);
      if (s >= current.maxSeconds) void stopRecording();
    }, 250);
  }

  async function stopRecording() {
    if (!recorderRef.current || !current) return;
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    const seconds = (Date.now() - startedAtRef.current) / 1000;
    setRecording(false);
    stopLiveTranscript();
    tell("recording_stopped", { seconds: Math.round(seconds) });

    await new Promise<void>((resolve) => {
      const r = recorderRef.current!;
      r.onstop = () => resolve();
      try { r.stop(); } catch { resolve(); }
    });
    recorderRef.current = null;
    await new Promise<void>((resolve) => {
      const a = audioRecorderRef.current;
      if (!a) return resolve();
      a.onstop = () => resolve();
      try { a.stop(); } catch { resolve(); }
    });

    if (current.minSeconds && seconds < current.minSeconds) {
      tell("recording_too_short", { seconds: Math.round(seconds), minimum: current.minSeconds });
      await uploaderRef.current?.abandon();
      await audioUploaderRef.current?.abandon().catch(() => {});
      audioUploaderRef.current = null;
      setUpload({
        phase: "failed", progress: 0, partsDone: 0, partsTotal: 0, attempt: 0, mediaId: null,
        message: `That answer was ${fmt(seconds)} — this question asks for at least ${fmt(current.minSeconds)}. Please record again.`,
      });
      return;
    }

    const audioDone = audioUploaderRef.current
      ? audioUploaderRef.current.finish(seconds).catch(() => ({ ok: false as const }))
      : Promise.resolve({ ok: false as const });

    const out = await uploaderRef.current?.finish(seconds);
    void audioDone.then((a) => {
      if (!a.ok && current.kind === "video") tell("transcript_unavailable", { code: current.code });
      audioUploaderRef.current = null;
    });
    if (out?.ok) {
      markStored(current, "answered");
      tell("question_answered", { code: current.code, seconds: Math.round(seconds) });
    }
  }

  /** Record locally that an answer landed, and feed the engine's state. */
  function markStored(q: Question, value: ResponseState["answers"][string], extra?: Partial<Question>) {
    if (flowRef.current) flowRef.current.answers[q.questionId] = value;
    setData((d) => d && ({
      ...d,
      questions: d.questions.map((x) => x.responseId === q.responseId ? { ...x, ...extra, status: "stored" } : x),
    }));
  }

  async function retake() {
    if (!current) return;
    await uploaderRef.current?.abandon();
    await audioUploaderRef.current?.abandon().catch(() => {});
    audioUploaderRef.current = null;
    uploaderRef.current = null;
    setUpload(null);
    setElapsed(0);
    /*
     * The server retires the old take — previously this was local state only,
     * so a reload showed the discarded answer as saved and the retry budget
     * reset to whatever the server last knew.
     */
    const res = await fetch("/api/candidate/answer", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, responseId: current.responseId, action: "retake" }),
    });
    const reply = await res.json().catch(() => ({}));
    if (!res.ok || !reply.ok) { setFatal(reply.error ?? "That could not be re-recorded."); return; }
    if (flowRef.current) delete flowRef.current.answers[current.questionId];
    setData((d) => d && ({
      ...d,
      questions: d.questions.map((q) =>
        q.responseId === current.responseId ? { ...q, status: "pending", retries: reply.retries ?? q.retries + 1 } : q),
    }));
  }

  /* ----------------------------------------------------- typed and chosen */

  async function submitAnswer() {
    if (!current || !promptGateOpen) return;
    const isChoice = CHOICE_KINDS.includes(current.kind);
    const isCode = current.kind === "code";
    /*
     * A code answer keeps its whitespace — indentation is part of the answer —
     * and is checked by the same rule the server applies, so Save is never
     * enabled for something the route will refuse.
     */
    if (isCode) {
      const verdict = checkCodeAnswer(typed, codeLanguage, readCodeSettings(current.codeSettings));
      if (!verdict.ok) { setFatal(verdict.error); return; }
    }
    const value = isChoice ? (current.kind === "single_choice" ? chosen[0] : chosen) : isCode ? typed : typed.trim();
    if (isChoice ? !chosen.length : !typed.trim()) return;
    setSaving(true); setFatal(null);
    const res = await fetch("/api/candidate/answer", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, responseId: current.responseId, action: "answer", value, ...(isCode ? { language: codeLanguage } : {}) }),
    });
    const reply = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok || !reply.ok) { setFatal(reply.error ?? "That answer could not be saved."); return; }
    const answerValue = isChoice ? value : isCode ? { language: codeLanguage } : null;
    markStored(current, answerValueOf({
      questionId: current.questionId, status: "stored", answerKind: current.kind,
      answerText: isChoice ? null : String(value), answerValue,
    }), isChoice ? { answerValue: value } : isCode ? { answerText: String(value), answerValue } : { answerText: String(value) });
  }

  /* ---------------------------------------------------------- navigation */

  const ordered = React.useMemo(() => {
    if (!data) return [] as Question[];
    const byId = new Map(data.questions.map((q) => [q.questionId, q]));
    return data.sequence.map((id) => byId.get(id)).filter((q): q is Question => !!q);
  }, [data]);
  const shownIndex = ordered.findIndex((q) => q.questionId === currentId);
  const done = ordered.filter((q) => q.status === "stored").length;

  /**
   * Ask the engine what comes next. Skip rules on the answered question and
   * display logic on everything after it are evaluated here against the
   * answers so far; whatever it walked past is settled as skipped by logic.
   */
  async function next(skipCurrent = false) {
    if (!current || !data || !defRef.current || !flowRef.current) return;
    setUpload(null);
    uploaderRef.current = null;
    setElapsed(0);

    if (skipCurrent && current.status !== "stored") {
      const res = await fetch("/api/candidate/answer", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, responseId: current.responseId, action: "skip", reason: "optional" }),
      });
      const reply = await res.json().catch(() => ({}));
      if (!res.ok || !reply.ok) { setFatal(reply.error ?? "That could not be skipped."); return; }
      setData((d) => d && ({
        ...d, questions: d.questions.map((q) => q.responseId === current.responseId ? { ...q, status: "skipped" } : q),
      }));
    }

    /* the engine is positioned on the current page; advance from there */
    flowRef.current.stepIndex = Math.max(0, shownIndex);
    const pos = continueFlow(defRef.current, flowRef.current);
    if (pos.hiddenByLogic.length) setData((d) => (d ? settleHidden(d, pos) : d));
    if (pos.done || !pos.questionId) {
      /* nothing left to show: offer Finish on the last question rather than a blank */
      setCurrentId(ordered[ordered.length - 1]?.questionId ?? null);
      setAtEnd(true);
      return;
    }
    setCurrentId(pos.questionId);
  }
  const [atEnd, setAtEnd] = React.useState(false);

  async function finish() {
    await flush();
    const res = await fetch("/api/candidate/finish", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const reply = await res.json().catch(() => ({}));
    if (!res.ok || !reply.ok) {
      const first = reply?.outstanding?.[0];
      setFatal(reply.error ?? "Some answers are still missing.");
      if (first) {
        const q = data?.questions.find((x) => x.responseId === first.responseId);
        if (q) { setAtEnd(false); setCurrentId(q.questionId); setFatal(`${reply.error} Let's go back to ${first.code}.`); }
      }
      return;
    }
    setPhase("done");
  }

  /* --------------------------------------------------------------- views */

  if (phase === "loading") {
    return <main className="wrap"><div className="card"><p className="muted">Opening your interview…</p></div></main>;
  }

  if (phase === "gate" || (fatal && !data)) {
    return (
      <main className="wrap">
        <div className="card">
          <h1>This interview cannot be opened</h1>
          <p data-testid="gate-message">{fatal}</p>
        </div>
      </main>
    );
  }

  if (!data) return <main className="wrap"><div className="card"><p className="muted">Opening your interview…</p></div></main>;

  if (phase === "done") {
    if (data.project.mode === "mock") {
      return <MockFeedback token={token} projectName={data.project.name} />;
    }
    return (
      <main className="wrap">
        <div className="card" data-testid="done">
          <h1>Thank you</h1>
          <p>Your interview is complete and every answer has been confirmed in storage. You can close this page.</p>
          {data.project.retentionSay && <p className="tiny muted">{data.project.retentionSay}</p>}
          <p className="muted small">{data.project.name}</p>
        </div>
      </main>
    );
  }

  if (phase === "devices") {
    const recordedCount = ordered.filter((q) => RECORDED_KINDS.includes(q.kind)).length;
    const ready = (!needs.camera || camera === "granted") && (!needs.mic || mic === "granted");
    return (
      <main className="wrap">
        <div className="card">
          <h1>{data.project.name}</h1>
          {data.interview.candidateName && <p className="muted">Hello {data.interview.candidateName}.</p>}
          {data.project.instructions && <p style={{ whiteSpace: "pre-wrap" }}>{data.project.instructions}</p>}
          <p className="muted small">
            {ordered.length} question{ordered.length === 1 ? "" : "s"}.{" "}
            {recordedCount
              ? `You record ${recordedCount === ordered.length ? "each" : `${recordedCount} of the`} answer${recordedCount === 1 ? "" : "s"} and can see exactly when each one has been saved.`
              : "Every answer is typed or chosen — nothing is recorded."}
          </p>
          {data.project.retentionSay && (
            <p className="tiny muted" data-testid="retention-notice">{data.project.retentionSay}</p>
          )}
        </div>

        {!data.canRecord && recordedCount > 0 && (
          <div className="note bad" data-testid="cannot-record">
            This interview cannot accept recordings at the moment. Please contact the company that
            invited you — please do not record your answers until this is resolved, because we would
            not be able to keep them.
          </div>
        )}

        {needs.mic ? (
          <div className="card">
            <h2>{needs.camera ? "Check your camera and microphone" : "Check your microphone"}</h2>
            {needs.camera && <video ref={monitorRef} playsInline data-testid="monitor" style={{ aspectRatio: "16 / 9" }} />}
            <div className="row" style={{ marginTop: 12 }}>
              {needs.camera && (
                <span className={`pill ${camera === "granted" ? "ok" : camera === "denied" ? "bad" : ""}`} data-testid="camera-state">
                  Camera: {PERMISSION_SAY[camera]}
                </span>
              )}
              <span className={`pill ${mic === "granted" ? "ok" : mic === "denied" ? "bad" : ""}`} data-testid="mic-state">
                Microphone: {PERMISSION_SAY[mic]}
              </span>
            </div>
            {/* advice for whichever device is the problem — previously only the camera's was ever shown */}
            {needs.camera && permissionAdvice("camera", camera) && (
              <p className="small muted" style={{ marginTop: 10 }}>{permissionAdvice("camera", camera)}</p>
            )}
            {permissionAdvice("microphone", mic) && (
              <p className="small muted" style={{ marginTop: 6 }}>{permissionAdvice("microphone", mic)}</p>
            )}
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn secondary" onClick={openDevices} data-testid="check-devices">
                {ready ? "Check again" : needs.camera ? "Allow camera and microphone" : "Allow microphone"}
              </button>
              <button className="btn" disabled={!ready || (!data.canRecord && recordedCount > 0)}
                onClick={() => setPhase(agreed ? "question" : "consent")} data-testid="devices-continue">
                Continue
              </button>
            </div>
          </div>
        ) : (
          <div className="card">
            <p className="muted small">No camera or microphone is needed for this interview.</p>
            <button className="btn" onClick={() => setPhase(agreed ? "question" : "consent")} data-testid="devices-continue">
              Continue
            </button>
          </div>
        )}
      </main>
    );
  }

  if (phase === "consent") {
    return (
      <main className="wrap">
        <div className="card">
          <h1>Before you start</h1>
          <p style={{ whiteSpace: "pre-wrap" }} data-testid="consent-text">{data.project.consentText}</p>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" onClick={giveConsent} data-testid="agree">I agree — start the interview</button>
          </div>
          {fatal && <p className="note bad" style={{ marginTop: 12 }}>{fatal}</p>}
        </div>
      </main>
    );
  }

  /* ---- the question ---- */
  if (!current) {
    return (
      <main className="wrap">
        <div className="card">
          <h1>Nothing left to answer</h1>
          <button className="btn big" onClick={finish} data-testid="finish">Finish the interview</button>
          {fatal && <p className="note warn" style={{ marginTop: 12 }}>{fatal}</p>}
        </div>
      </main>
    );
  }
  const q = current;
  const stored = q.status === "stored";
  const last = atEnd || shownIndex === ordered.length - 1;
  const busy = recording || saving || (upload?.phase === "uploading" || upload?.phase === "finishing" || upload?.phase === "preparing");
  const recorded = RECORDED_KINDS.includes(q.kind);
  const codeKind = q.kind === "code";
  const typedKind = TYPED_KINDS.includes(q.kind) && !codeKind;
  const choiceKind = CHOICE_KINDS.includes(q.kind);
  const codeSettings = codeKind ? readCodeSettings(q.codeSettings) : null;
  const codeVerdict = codeKind && codeSettings ? checkCodeAnswer(typed, codeLanguage, codeSettings) : null;
  const canAnswerNow = promptGateOpen && !stored && !busy;

  return (
    <main className="wrap">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span className="tiny muted">{data.project.name}</span>
        <span className="tiny muted" data-testid="progress">
          Question {Math.max(0, shownIndex) + 1} of {ordered.length} · {done} saved
        </span>
      </div>
      <div className="bar thin" aria-hidden><i style={{ width: `${Math.round(((Math.max(0, shownIndex) + (stored ? 1 : 0)) / Math.max(1, ordered.length)) * 100)}%` }} /></div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }} data-testid="question-code">{q.code}</h2>
          <span className="tiny muted">
            {q.required ? "Required" : "Optional"}
            {recorded ? ` · up to ${fmt(q.maxSeconds)}` : ""}
            {recorded && q.minSeconds ? ` · at least ${fmt(q.minSeconds)}` : ""}
          </span>
        </div>

        {/* the interviewer asking, when there is a clip */}
        {q.promptMedia && (
          <div style={{ marginTop: 12 }} data-testid="prompt-video" data-state={promptState}>
            <video
              ref={promptRef}
              src={promptUrl ?? undefined}
              playsInline
              controls
              controlsList="nodownload noplaybackrate noremoteplayback"
              disablePictureInPicture
              onTimeUpdate={onPromptTime}
              onSeeking={onPromptTime}
              onEnded={() => void onPromptEnded()}
              onPlaying={() => setPromptState("playing")}
              onWaiting={() => tell("prompt_playback_stalled")}
              style={{ width: "100%", aspectRatio: "16 / 9", background: "#000", borderRadius: 8 }}
            />
            {promptState === "loading" && <p className="tiny muted" style={{ marginTop: 6 }}>Loading the question…</p>}
            {promptState === "blocked" && (
              <button className="btn" style={{ marginTop: 8 }} data-testid="prompt-play"
                onClick={() => promptRef.current?.play().then(() => setPromptState("playing")).catch(() => {})}>
                Play the question
              </button>
            )}
            {promptState === "playing" && (
              <p className="tiny muted" style={{ marginTop: 6 }} data-testid="prompt-gate">
                Watch the question through — you can answer as soon as it ends.
              </p>
            )}
            {promptState === "failed" && (
              <p className="note warn" style={{ marginTop: 8 }}>
                The question video could not be loaded. The question is written below.
              </p>
            )}
          </div>
        )}

        <p style={{ fontSize: 18, marginTop: 10 }} data-testid="question-prompt">{q.prompt}</p>
        {q.guidance && <p className="small muted">{q.guidance}</p>}

        {thinkLeft !== null && thinkLeft > 0 && !stored && (
          <p className="note" data-testid="thinking">
            Take a moment — {fmt(thinkLeft)} to think. You can start whenever you are ready.
          </p>
        )}
      </div>

      {/* ---- recorded answers ---- */}
      {recorded && (
        <div className="card">
          {q.kind === "video"
            ? <video ref={monitorRef} playsInline muted data-testid="monitor" style={{ aspectRatio: "16 / 9", width: "100%", background: "#000", borderRadius: 8 }} />
            : <div className="row" style={{ gap: 8 }}>{recording && <span className="dot live" />}<span className="muted">Audio only — your camera is not used for this question.</span></div>}

          <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
            <span className="row" style={{ gap: 8 }}>
              {recording && q.kind === "video" && <span className="dot live" />}
              <strong data-testid="clock">{fmt(elapsed)}</strong>
              <span className="tiny muted">of {fmt(q.maxSeconds)}</span>
            </span>
            <span className="tiny muted" data-testid="upload-state">
              {stored ? RESPONSE_SAY.stored : upload ? uploadWord(upload) : recording ? "Recording" : RESPONSE_SAY[q.status as keyof typeof RESPONSE_SAY] ?? q.status}
            </span>
          </div>

          {/*
            * The live transcript: a PREVIEW, labelled as one. What is saved and
            * analysed is the transcript of the recording, produced later by the
            * server — this is the browser's own recogniser, which is fast and
            * approximate and never stored.
            */}
          {recording && liveSupported !== false && (
            <div className="note" style={{ marginTop: 10, minHeight: 44 }} data-testid="live-transcript">
              <span className="tiny muted">Live preview — the saved transcript comes from your recording.</span>
              <p style={{ margin: "4px 0 0" }}>{liveText || <span className="muted">Listening…</span>}</p>
            </div>
          )}

          {upload && upload.phase !== "idle" && (
            <div style={{ marginTop: 12 }}>
              <div className="bar"><i style={{ width: `${Math.round(upload.progress * 100)}%` }} /></div>
              <p className="tiny muted" style={{ marginTop: 6 }} data-testid="upload-detail">
                {upload.partsTotal > 1
                  ? `${upload.partsDone} of ${upload.partsTotal} parts safely stored`
                  : upload.phase === "stored" ? "Confirmed in storage" : "Sending"}
                {upload.message ? ` — ${upload.message}` : ""}
              </p>
            </div>
          )}

          {upload?.phase === "failed" && (
            <div className="note bad" style={{ marginTop: 12 }} data-testid="upload-failed">
              {upload.message ?? "Your answer could not be saved."}{" "}
              <button className="btn secondary" style={{ marginTop: 8 }}
                onClick={() => void uploaderRef.current?.resume()} data-testid="upload-retry">
                Try again
              </button>
            </div>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            {!recording && !stored && (
              <button className="btn big" onClick={startRecording} disabled={!canAnswerNow || !streamRef.current} data-testid="record"
                title={!promptGateOpen ? "Watch the question first" : undefined}>
                {q.retries > 0 ? "Record again" : "Start recording"}
              </button>
            )}
            {recording && (
              <button className="btn big" onClick={stopRecording} data-testid="stop">Stop and save</button>
            )}
            {stored && q.retries < q.maxRetries && (
              <button className="btn secondary" onClick={retake} data-testid="retake">
                Record again ({q.maxRetries - q.retries} left)
              </button>
            )}
          </div>
        </div>
      )}

      {/* ---- typed answers ---- */}
      {typedKind && (
        <div className="card">
          <textarea
            value={typed}
            onChange={(e) => { if (!typed && e.target.value) tell("answer_started", { code: q.code, kind: q.kind }); setTyped(e.target.value); }}
            rows={q.kind === "long_text" ? 8 : 3}
            disabled={!promptGateOpen || stored || saving}
            placeholder={promptGateOpen ? "Type your answer here" : "Watch the question first"}
            data-testid="typed-answer"
            style={{ width: "100%", fontSize: 16 }}
          />
          <div className="row" style={{ marginTop: 12, justifyContent: "space-between", alignItems: "center" }}>
            <span className="tiny muted" data-testid="upload-state">{stored ? RESPONSE_SAY.stored : `${typed.trim().length} characters`}</span>
            {!stored && (
              <button className="btn big" onClick={submitAnswer} disabled={!canAnswerNow || !typed.trim()} data-testid="submit-answer">
                {saving ? "Saving…" : "Save answer"}
              </button>
            )}
            {stored && (
              <button className="btn secondary" data-testid="edit-answer"
                onClick={() => setData((d) => d && ({ ...d, questions: d.questions.map((x) => x.responseId === q.responseId ? { ...x, status: "pending" } : x) }))}>
                Change answer
              </button>
            )}
          </div>
        </div>
      )}

      {/* ---- code answers ---- */}
      {codeKind && codeSettings && (
        <div className="card" data-testid="code-answer">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
            <span className="tiny muted">
              {codeSettings.allowLanguageChoice ? "Write in any language below." : `Write in ${CODE_LANGUAGE_SAY[codeSettings.language]}.`}
              {" "}Nothing is run — a person reads your code.
            </span>
            {codeSettings.allowLanguageChoice ? (
              <select value={codeLanguage} onChange={(e) => setCodeLanguage(e.target.value as CodeLanguage)}
                disabled={!promptGateOpen || stored || saving} data-testid="code-language" aria-label="Language">
                {CODE_LANGUAGES.map((l) => <option key={l} value={l}>{CODE_LANGUAGE_SAY[l]}</option>)}
              </select>
            ) : <span className="pill">{CODE_LANGUAGE_SAY[codeSettings.language]}</span>}
          </div>
          <CodeEditor
            value={typed}
            language={codeLanguage}
            disabled={!promptGateOpen || stored || saving}
            maxChars={codeSettings.maxChars}
            placeholder={promptGateOpen ? "Write your code here" : "Watch the question first"}
            onChange={(next) => { if (typed === codeSettings.starter && next !== typed) tell("answer_started", { code: q.code, kind: q.kind }); setTyped(next); }}
            onPaste={(chars) => tell("paste", { code: q.code, kind: q.kind, chars, responseId: q.responseId })}
          />
          <div className="row" style={{ marginTop: 12, justifyContent: "space-between", alignItems: "center" }}>
            <span className="tiny muted" data-testid="upload-state">
              {stored ? RESPONSE_SAY.stored : codeVerdict && !codeVerdict.ok && codeVerdict.code !== "empty" ? codeVerdict.error : `${typed.split("\n").length} line${typed.split("\n").length === 1 ? "" : "s"}`}
            </span>
            {!stored && (
              <button className="btn big" onClick={submitAnswer} disabled={!canAnswerNow || !codeVerdict?.ok} data-testid="submit-answer">
                {saving ? "Saving…" : "Save answer"}
              </button>
            )}
            {stored && (
              <button className="btn secondary" data-testid="edit-answer"
                onClick={() => setData((d) => d && ({ ...d, questions: d.questions.map((x) => x.responseId === q.responseId ? { ...x, status: "pending" } : x) }))}>
                Change answer
              </button>
            )}
          </div>
        </div>
      )}

      {/* ---- chosen answers ---- */}
      {choiceKind && (
        <div className="card" data-testid="choice-answer">
          <p className="tiny muted" style={{ marginTop: 0 }}>{q.kind === "single_choice" ? "Choose one" : "Choose all that apply"}</p>
          {q.options.map((o) => {
            const on = chosen.includes(o.code);
            return (
              <label key={o.code} className="row" style={{ gap: 10, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--line)" }}>
                <input
                  type={q.kind === "single_choice" ? "radio" : "checkbox"}
                  name={`choice-${q.responseId}`}
                  checked={on}
                  disabled={!promptGateOpen || stored || saving}
                  onChange={() => {
                    if (!chosen.length) tell("answer_started", { code: q.code, kind: q.kind });
                    setChosen(q.kind === "single_choice" ? [o.code] : on ? chosen.filter((c) => c !== o.code) : [...chosen, o.code]);
                  }}
                  data-testid={`option-${o.code}`}
                />
                <span style={{ fontSize: 16 }}>{o.label}</span>
              </label>
            );
          })}
          <div className="row" style={{ marginTop: 12, justifyContent: "space-between", alignItems: "center" }}>
            <span className="tiny muted" data-testid="upload-state">{stored ? RESPONSE_SAY.stored : ""}</span>
            {!stored && (
              <button className="btn big" onClick={submitAnswer} disabled={!canAnswerNow || !chosen.length} data-testid="submit-answer">
                {saving ? "Saving…" : "Save answer"}
              </button>
            )}
            {stored && (
              <button className="btn secondary" data-testid="edit-answer"
                onClick={() => setData((d) => d && ({ ...d, questions: d.questions.map((x) => x.responseId === q.responseId ? { ...x, status: "pending" } : x) }))}>
                Change answer
              </button>
            )}
          </div>
        </div>
      )}

      {/* ---- moving on ---- */}
      <div className="card">
        <div className="row" style={{ gap: 10 }}>
          {stored && !last && (
            <button className="btn" onClick={() => void next()} data-testid="next">Next question</button>
          )}
          {last && (stored || !q.required || atEnd) && !recording && (
            <button className="btn big" onClick={finish} data-testid="finish">Finish the interview</button>
          )}
          {!q.required && !stored && !recording && !last && (
            <button className="btn secondary" onClick={() => void next(true)} data-testid="skip">Skip this one</button>
          )}
          {!promptGateOpen && !stored && (
            <span className="tiny muted" data-testid="gate-note">The answer controls open once the question has played through.</span>
          )}
        </div>
        {fatal && <p className="note warn" style={{ marginTop: 12 }} data-testid="inline-error">{fatal}</p>}
      </div>

      <p className="tiny muted">
        An answer is only marked as saved once it has been confirmed in storage. If you reload,
        this page opens on the first question you have not yet answered.
      </p>
    </main>
  );
}

function uploadWord(s: UploadState): string {
  switch (s.phase) {
    case "preparing": return "Getting ready";
    case "uploading": return RESPONSE_SAY.uploading;
    case "waiting": return "Reconnecting";
    case "finishing": return "Confirming";
    case "stored": return RESPONSE_SAY.stored;
    case "failed": return "Not saved";
    default: return "";
  }
}


/* ================================================================== mock */

interface FeedbackReply {
  ok: boolean;
  ready: boolean;
  say?: string;
  retention?: string;
  feedback?: {
    overall: number | null; headline: string; caveat: string;
    didWell: { code: string; title: string; quotes: string[]; advice: string | null }[];
    needsWork: { code: string; title: string; quotes: string[]; advice: string | null }[];
    nearlyThere: { code: string; title: string; quotes: string[]; advice: string | null }[];
    recommendedChanges: string[];
    practiceNext: { reason: string; categories: string[] };
  };
  narrative?: string | null;
  practice?: { key: string; title: string; minutes: number; category: string }[];
  downloads?: { mediaId: string; questionId: string | null; url: string; expiresIn: number }[];
}

/**
 * WHAT YOU SAID, READ BACK TO YOU.
 *
 * Only a mock interview ever reaches this screen — the route behind it answers
 * 404 for anything else, so a hiring candidate cannot get here by finishing.
 * It polls while the transcripts and analysis run, and says what it is waiting
 * for rather than spinning. The caveat is the first thing on the card and it
 * says what a gap means: the words were not found, not that you cannot do it.
 */
function MockFeedback({ token, projectName }: { token: string; projectName: string }) {
  const [reply, setReply] = React.useState<FeedbackReply | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let stop = false;
    let attempts = 0;
    const tick = async () => {
      try {
        const res = await fetch("/api/candidate/feedback", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, downloads: true }),
        });
        const j = (await res.json().catch(() => ({}))) as FeedbackReply & { error?: string };
        if (stop) return;
        if (!res.ok) { setError(j.error ?? "Feedback is not available."); return; }
        setReply(j);
        if (!j.ready && attempts++ < 60) setTimeout(tick, 5000);
      } catch { if (!stop) setError("We could not reach the server."); }
    };
    void tick();
    return () => { stop = true; };
  }, [token]);

  if (error) {
    return <main className="wrap"><div className="card"><h1>Thank you</h1><p className="note warn">{error}</p></div></main>;
  }
  if (!reply) {
    return <main className="wrap"><div className="card"><h1>Thank you</h1><p className="muted">Fetching your feedback…</p></div></main>;
  }
  if (!reply.ready) {
    return (
      <main className="wrap">
        <div className="card" data-testid="feedback-waiting">
          <h1>Thank you</h1>
          <p>Your answers are saved. {reply.say}</p>
          <p className="tiny muted">This page updates itself. Feedback usually takes a few minutes.</p>
          {reply.retention && <p className="tiny muted">{reply.retention}</p>}
          <Downloads items={reply.downloads ?? []} />
        </div>
      </main>
    );
  }

  const f = reply.feedback!;
  return (
    <main className="wrap">
      <div className="card" data-testid="feedback">
        <h1>Your feedback</h1>
        <p className="tiny muted">{projectName}</p>
        <p className="note">{f.caveat}</p>
        <div className="row" style={{ gap: 16, alignItems: "flex-end" }}>
          <div style={{ fontSize: 40, fontWeight: 700, lineHeight: 1 }} data-testid="feedback-overall">
            {f.overall === null ? "—" : f.overall}{f.overall !== null && <span className="muted" style={{ fontSize: 16, fontWeight: 400 }}> / 100</span>}
          </div>
          <p style={{ margin: 0 }}>{f.headline}</p>
        </div>
      </div>

      <FeedbackGroup title="What you did well" items={f.didWell} tone="ok" empty="Nothing was clearly shown yet — see below for what to add." />
      <FeedbackGroup title="Nearly there" items={f.nearlyThere} tone="" empty="" />
      <FeedbackGroup title="What to add next time" items={f.needsWork} tone="warn" empty="Every requirement had quoted evidence. Well done." />

      {f.recommendedChanges.length > 0 && (
        <div className="card" data-testid="feedback-changes">
          <h2 style={{ marginTop: 0 }}>Recommended changes</h2>
          <ul>{f.recommendedChanges.map((c) => <li key={c} className="small">{c}</li>)}</ul>
        </div>
      )}

      {reply.narrative && (
        <div className="card"><h2 style={{ marginTop: 0 }}>What the transcripts covered</h2><p className="small">{reply.narrative}</p></div>
      )}

      {reply.practice && reply.practice.length > 0 && (
        <div className="card" data-testid="feedback-practice">
          <h2 style={{ marginTop: 0 }}>Practise next</h2>
          <p className="tiny muted">{f.practiceNext.reason}</p>
          {reply.practice.map((p) => (
            <p key={p.key} className="small" style={{ margin: "6px 0" }}>
              <strong>{p.title}</strong> <span className="muted">· about {p.minutes} min</span>
            </p>
          ))}
          <a className="btn secondary" href="/practice">Choose another practice interview</a>
        </div>
      )}

      <div className="card">
        <Downloads items={reply.downloads ?? []} />
        {reply.retention && <p className="tiny muted" style={{ marginTop: 8 }}>{reply.retention}</p>}
      </div>
    </main>
  );
}

function FeedbackGroup({ title, items, tone, empty }: {
  title: string; tone: string; empty: string;
  items: { code: string; title: string; quotes: string[]; advice: string | null }[];
}) {
  if (!items.length && !empty) return null;
  return (
    <div className="card" data-testid={`feedback-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      {items.length === 0 ? <p className="muted small">{empty}</p> : items.map((it) => (
        <div key={it.code} style={{ borderTop: "1px solid var(--line)", paddingTop: 8, marginTop: 8 }}>
          <span className={`pill ${tone}`}>{it.code}</span> <strong>{it.title}</strong>
          {it.quotes.map((q, i) => (
            <blockquote key={i} style={{ margin: "6px 0", paddingLeft: 10, borderLeft: "3px solid var(--line)" }}>&ldquo;{q}&rdquo;</blockquote>
          ))}
          {!it.quotes.length && it.advice && (
            <p className="small" style={{ margin: "6px 0 0" }}><span className="muted">A stronger answer would include:</span> {it.advice}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function Downloads({ items }: { items: { mediaId: string; url: string; expiresIn: number }[] }) {
  if (!items.length) return null;
  return (
    <div data-testid="feedback-downloads">
      <h2 style={{ marginTop: 0 }}>Your recordings</h2>
      <p className="tiny muted">Links work for {Math.round(items[0]!.expiresIn / 60)} minutes; reload this page for fresh ones.</p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {items.map((d, i) => <a key={d.mediaId} className="btn small secondary" href={d.url}>Download answer {i + 1}</a>)}
      </div>
    </div>
  );
}
