"use client";
import React from "react";
import "./qual.css";
import { guideMinutes, lintQualStudy, measurementOf } from "@rescript/engine";
import {
  themeFrequency, themeSummaries, themeSentiment, codersOf, reviewStatus, formatTimestamp, FREQUENCY_NOTE,
  type QualOp, type QualExcerpt, type QualCode,
} from "@rescript/analytics";
import { useStudio } from "../store";
import { allSegments } from "@/lib/qual/qualWorkspace";
import { httpQualApi, sharedSandboxQualApi, agreementOf, QualApiError, type QualApi, type WorkspaceView, type CodingReport } from "./qualApi";
import { AiInterviewsTab } from "./AiInterviewsTab";
/* F2 2026-10-22: AI synthesis, blind double-coding, highlight reels, text group sessions, transcript correction, auto-coding */
import { httpSynthesisApi, sandboxSynthesisApi, type SynthesisApi } from "./synthesisApi";
import { SynthesisTab } from "./SynthesisTab";
import { DoubleCodingTab } from "./DoubleCodingTab";
import { HighlightsTab } from "./HighlightsTab";
import { GroupsTab } from "./GroupsTab";
/* G3 2026-10-22: alerts (Slack / Teams / webhook / e-mail / bell) and panel recruitment */
import { AlertsPanelsTab } from "./AlertsPanelsTab";
import { AutoCodePanel, CorrectableText, SynApiContext } from "./TranscriptTools";
/* G2 2026-10-22: live human-moderated sessions (focus groups / IDIs) with multi-party video */
import { LiveSessionsTab } from "./LiveSessionsTab";
import { ClipPlayer } from "./ClipPlayer";

/**
 * THE QUALITATIVE WORKSPACE (2026-10-18) — Research Tools → Qualitative.
 *
 *   Guide        the interview / focus-group guide on the definition (made and edited in
 *                Intelligent Mode), its lint, the Word export
 *   Sessions     session records: date, moderator, participants and segments, consent, notes,
 *                observations; a recording uploaded to private storage, played through a
 *                short signed URL, transcribed through the configured speech-to-text provider
 *   Transcripts  import (.txt / .vtt / .srt / .docx / "Speaker: text"), open-ended answers,
 *                the speaker map (moderator, participant segment)
 *   Coding       the AI's codebook proposal (redacted, batched, every quote checked verbatim),
 *                human review (accept / reject / rename / merge / split / reassign / add), two
 *                coders' agreement (Cohen's kappa per code), the history
 *   Themes       frequency by group (frequency ≠ importance), evidence-based summaries citing
 *                excerpt ids, representative quotes, contradictory evidence
 *   Report       the qualitative report as a Word document
 *
 * Live sessions (G2 2026-10-22): live human-moderated focus groups / IDIs in the browser — moderator, participants
 * by link, a back room of observers, recording per speaker → one transcript.
 */

type Tab = "guide" | "ai" | "sessions" | "transcripts" | "coding" | "themes" | "report" | "synthesis" | "double" | "highlights" | "groups" | "live" | "alerts";
const TABS: { key: Tab; label: string }[] = [
  { key: "guide", label: "Guide" }, { key: "ai", label: "AI interviews" }, { key: "sessions", label: "Sessions" }, { key: "transcripts", label: "Transcripts" },
  { key: "coding", label: "Coding" }, { key: "themes", label: "Themes" }, { key: "synthesis", label: "Synthesis" }, { key: "double", label: "Double coding" }, { key: "highlights", label: "Highlights" }, { key: "groups", label: "Group sessions" }, { key: "live", label: "Live sessions" }, { key: "alerts", label: "Alerts & panels" }, { key: "report", label: "Report" },
];
const STATUS_BADGE: Record<string, string> = { ai_suggested: "warning", human_reviewed: "success", rejected: "error" };
const STATUS_WORD: Record<string, string> = { ai_suggested: "AI-suggested", human_reviewed: "Reviewed", rejected: "Rejected" };
const segKey = (s: { sourceId: string; id?: string; segmentId?: string }) => `${s.sourceId}|${s.segmentId ?? s.id}`;

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function QualPanel() {
  const s = useStudio();
  const defRef = React.useRef(s.def);
  defRef.current = s.def;
  const api = React.useMemo<QualApi>(() => (s.surveyDbId === "sandbox" ? sharedSandboxQualApi(() => defRef.current) : httpQualApi(s.surveyDbId)), [s.surveyDbId]);
  /* G3: a deep link (an alert's "open the live view") names the tab: ?qual=ai|alerts|… */
  const [tab, setTab] = React.useState<Tab>(() => { if (typeof window === "undefined") return "guide"; const q = new URLSearchParams(window.location.search).get("qual"); return (TABS.some((t) => t.key === q) ? q : "guide") as Tab; });
  const [ws, setWs] = React.useState<WorkspaceView | null>(null);
  const syn = React.useMemo<SynthesisApi>(() => (api.sandbox ? sandboxSynthesisApi(api, () => defRef.current, setWs) : httpSynthesisApi(s.surveyDbId, setWs, () => api.load())), [api, s.surveyDbId]);
  const [error, setError] = React.useState<{ text: string; status?: number } | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const run = React.useCallback(async <T,>(label: string, fn: () => Promise<T>, done?: (v: T) => void) => {
    setBusy(label); setError(null); setNote(null);
    try { const v = await fn(); done?.(v); return v; }
    catch (e) {
      const err = e as QualApiError;
      setError({ text: err.message, status: err.status });
      if (err.code === "version_conflict") { try { setWs(await api.load()); } catch { /* keep */ } }
      return undefined;
    } finally { setBusy(null); }
  }, [api]);

  React.useEffect(() => { void run("load", () => api.load(), setWs); }, [api, run]);

  const forbidden = error?.status === 403 && !ws;
  return (
    <div className="ql" data-testid="qual-panel" data-sandbox={api.sandbox ? "1" : "0"}>
      <div className="ql-head">
        <h2>Qualitative research</h2>
        <div className="ql-tabs" role="tablist">
          {TABS.map((t) => <button key={t.key} type="button" role="tab" className="ql-tab" aria-selected={tab === t.key} data-testid={`qual-tab-${t.key}`} onClick={() => setTab(t.key)}>{t.label}</button>)}
        </div>
        <span className="grow" />
        {busy && <span className="chip" data-testid="qual-busy">{busy}…</span>}
      </div>
      <p className="ql-muted">Plan moderated interviews and focus groups, keep session records and recordings, import or transcribe transcripts, and code them with AI assistance and human review. Run live human-moderated sessions in the browser (Live sessions: video, a waiting room, a back room for observers, recording per speaker), or let an AI moderator run one-to-one interviews (AI interviews).</p>
      {error && <div className={`alert ${error.status === 403 ? "warning" : "error"}`} data-testid="qual-error" data-status={error.status ?? ""}>{error.text}</div>}
      {note && <div className="alert success" data-testid="qual-note">{note}</div>}
      {forbidden ? <div className="empty" data-testid="qual-forbidden">Qualitative data belong to the Data module, and your access does not include it. The guide can still be exported from Intelligent Mode.</div>
        : tab === "guide" ? <GuideTab api={api} run={run} />
        : tab === "ai" ? <AiInterviewsTab qualApi={api} setWs={setWs} setNote={setNote} />
        : tab === "alerts" ? <AlertsPanelsTab />
        : !ws ? <div className="sk" style={{ height: 120 }} />
        : !ws.available ? <div className="alert warning" data-testid="qual-unavailable">{ws.note}</div>
        : tab === "sessions" ? <SessionsTab ws={ws} api={api} run={run} setWs={setWs} setNote={setNote} />
        : tab === "transcripts" ? <SynApiContext.Provider value={syn}><AutoCodePanel ws={ws} api={syn} run={run} setWs={setWs} /><TranscriptsTab ws={ws} api={api} run={run} setWs={setWs} setNote={setNote} /></SynApiContext.Provider>
        : tab === "synthesis" ? <SynthesisTab ws={ws} api={syn} run={run} />
        : tab === "double" ? <DoubleCodingTab ws={ws} api={syn} run={run} setWs={setWs} />
        : tab === "highlights" ? <HighlightsTab ws={ws} api={syn} run={run} />
        : tab === "groups" ? <GroupsTab ws={ws} api={syn} run={run} setWs={setWs} />
        : tab === "live" ? <LiveSessionsTab ws={ws} api={api} run={run} setWs={setWs} setNote={setNote} />
        : tab === "coding" ? <CodingTab ws={ws} api={api} run={run} setWs={setWs} />
        : tab === "themes" ? <ThemesTab ws={ws} />
        : <ReportTab ws={ws} api={api} run={run} />}
    </div>
  );
}

type Run = <T>(label: string, fn: () => Promise<T>, done?: (v: T) => void) => Promise<T | undefined>;
/** recordings uploaded from this page, kept so a format the server cannot split can be decoded here instead (#17) */
const uploadedFiles = new Map<string, File>();

/* ------------------------------------------------------------ Guide */

function GuideTab({ api, run }: { api: QualApi; run: Run }) {
  const s = useStudio();
  const q = s.def.qualStudy;
  if (!q) return (
    <div className="empty" data-testid="qual-guide-empty">
      <p><b>No interview or focus-group guide yet.</b></p>
      <p className="ql-muted">Ask Intelligent Mode, for example: “Create a 60-minute interview guide about why customers switch broadband provider” or “Create a 90-minute focus-group discussion guide to test two loyalty concepts”. Then edit it the same way (“add a probe about price to the triggers question”, “add a card-sort exercise”) — only what you name changes.</p>
    </div>
  );
  const lint = lintQualStudy(q);
  const minutes = guideMinutes(q);
  return (
    <div data-testid="qual-guide" data-kind={q.kind}>
      <div className="ql-row">
        <span className="badge neutral" data-testid="qual-guide-kind">{q.kind === "focus_group" ? "Focus-group discussion guide" : "Interview guide"}</span>
        <b>{q.title ?? s.def.meta.title}</b>
        <span className="ql-muted">{q.sections.length} sections · {minutes} min timed{q.durationMinutes ? ` of ${q.durationMinutes}` : ""}</span>
        <span className="grow" />
        <button type="button" className="btn small primary" data-testid="qual-export-guide" onClick={() => run("Exporting the guide", () => api.exportDocx("guide"), (r) => save(r.blob, r.name))}>Export guide (.docx)</button>
      </div>
      {q.objectives.length > 0 && <><div className="eyebrow">Objectives</div><ol className="ql-list">{q.objectives.map((o, i) => <li key={i}>{o}</li>)}</ol></>}
      {q.groundRules.length > 0 && <><div className="eyebrow">Ground rules</div><ul className="ql-list">{q.groundRules.map((g, i) => <li key={i}>{g}</li>)}</ul></>}
      {(q.consent.statement || q.consent.recordingDisclosure) && <><div className="eyebrow">Consent and recording</div>{q.consent.statement && <p>{q.consent.statement}</p>}{q.consent.recordingDisclosure && <p className="ql-muted">{q.consent.recordingDisclosure}</p>}</>}
      {q.screening.length > 0 && <><div className="eyebrow">Screening</div><ul className="ql-list">{q.screening.map((c, i) => <li key={i}>{c.rule === "exclude" ? "Exclude: " : ""}{c.criterion}{c.quota ? ` (${c.quota})` : ""}</li>)}</ul></>}
      {q.segments.length > 0 && <div className="ql-row">{q.segments.map((g) => <span key={g.id} className="chip">{g.name}{g.target != null ? ` · ${g.target}` : ""}</span>)}</div>}
      {q.sections.map((sec, i) => (
        <div key={sec.id} className="card ql-section" data-testid="qual-guide-section" data-title={sec.title}>
          <div className="ql-row"><b>{i + 1}. {sec.title}</b><span className="chip">{sec.kind.replace("_", "-")}</span>{sec.minutes != null && <span className="ql-muted">{sec.minutes} min</span>}</div>
          {sec.purpose && <p className="ql-muted">Purpose: {sec.purpose}</p>}
          {sec.script && <p className="ql-script">“{sec.script}”</p>}
          {sec.instructions.map((t, k) => <p key={k} className="ql-muted">Moderator: {t}</p>)}
          {sec.exercise && <p><b>Exercise:</b> {sec.exercise.title}{sec.exercise.instructions ? ` — ${sec.exercise.instructions}` : ""}</p>}
          {sec.stimuli.length > 0 && <p className="ql-muted">Stimuli: {sec.stimuli.join("; ")}</p>}
          <ol className="ql-list">
            {sec.questions.map((qq) => (
              <li key={qq.id} data-testid="qual-guide-question">{qq.text}
                {qq.probes.map((p, k) => <div key={k} className="ql-probe" data-testid="qual-guide-probe">Probe: {p}</div>)}
                {qq.conditionalProbes.map((c, k) => <div key={k} className="ql-probe">If they mention {c.ifMentions} → {c.ask}</div>)}
              </li>
            ))}
          </ol>
        </div>
      ))}
      {lint.length > 0 && <div className="alert info" data-testid="qual-guide-lint"><b>Before fieldwork</b><ul className="ql-list">{lint.map((l, i) => <li key={i}>{l}</li>)}</ul></div>}
    </div>
  );
}

/* ------------------------------------------------------------ Sessions */

function SessionsTab({ ws, api, run, setWs, setNote }: { ws: WorkspaceView; api: QualApi; run: Run; setWs: (w: WorkspaceView) => void; setNote: (n: string) => void }) {
  const s = useStudio();
  const segs = s.def.qualStudy?.segments.map((g) => g.name) ?? [];
  const [form, setForm] = React.useState({ title: "", kind: s.def.qualStudy?.kind ?? "interview", scheduledAt: "", moderator: "", participants: "", consent: false, recording: false, notes: "" });
  const [progress, setProgress] = React.useState<Record<string, string>>({});
  const create = () => run("Saving the session", () => api.saveSession({
    title: form.title, kind: form.kind, scheduledAt: form.scheduledAt || null, moderator: form.moderator || null, notes: form.notes || null,
    participants: form.participants.split(/\n|,/).map((x) => x.trim()).filter(Boolean).map((x) => { const [label, segment] = x.split(":").map((y) => y.trim()); return segment ? { label, segment } : { label }; }),
    consent: { captured: form.consent, recording: form.recording },
  }), (w) => { setWs(w); setForm({ ...form, title: "", participants: "", notes: "" }); });
  return (
    <div data-testid="qual-sessions">
      {!ws.can.manage && <div className="alert info">You can read sessions; adding or changing them needs Data: Edit.</div>}
      {ws.sessions.length === 0 && <div className="empty">No sessions recorded yet.</div>}
      {ws.sessions.map((x) => (
        <div key={x.id} className="card ql-section" data-testid="qual-session" data-title={x.title}>
          <div className="ql-row">
            <b>{x.title}</b><span className="chip">{x.kind === "focus_group" ? "Focus group" : "Interview"}</span>
            <span className="badge neutral">{x.status}</span>
            {x.scheduledAt && <span className="ql-muted">{x.scheduledAt.slice(0, 16).replace("T", " ")}</span>}
            {x.moderator && <span className="ql-muted">Moderator: {x.moderator}</span>}
            <span className={`badge ${x.consent.captured ? "success" : "warning"}`}>{x.consent.captured ? "Consent captured" : "Consent not recorded"}</span>
            {x.consent.recording !== undefined && <span className={`badge ${x.consent.recording ? "success" : "warning"}`}>{x.consent.recording ? "Consent to record" : "No consent to record"}</span>}
          </div>
          {x.participants.length > 0 && <div className="ql-row">{x.participants.map((p) => <span key={p.id} className="chip">{p.label}{p.segment ? ` · ${p.segment}` : ""}</span>)}</div>}
          {x.notes && <p className="ql-muted">{x.notes}</p>}
          <div className="ql-row">
            {x.recordingMediaId ? <span className="badge success" data-testid="qual-recording-stored">Recording stored</span> : <span className="ql-muted">No recording</span>}
            {ws.can.manage && !api.sandbox && (
              <label className="btn small">{x.recordingMediaId ? "Replace recording" : "Upload recording"}
                <input type="file" accept="audio/*,video/*" hidden data-testid="qual-recording-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) { uploadedFiles.set(x.id, f); void run("Uploading the recording", () => api.uploadRecording(x.id, f, (p, phase) => setProgress((cur) => ({ ...cur, [x.id]: `${phase} ${Math.round(p * 100)}%` }))), setWs); } }} />
              </label>
            )}
            {progress[x.id] && <span className="chip">{progress[x.id]}</span>}
            {x.recordingMediaId && ws.can.playback && <>
              <button type="button" className="btn small" onClick={() => run("Opening the recording", () => api.recordingUrl(x.recordingMediaId!, false), (u) => window.open(u, "_blank", "noopener"))}>Play</button>
              <button type="button" className="btn small" onClick={() => run("Preparing the download", () => api.recordingUrl(x.recordingMediaId!, true), (u) => { window.location.href = u; })}>Download</button>
            </>}
            {x.recordingMediaId && ws.can.manage && <button type="button" className="btn small" data-testid="qual-transcribe" disabled={!ws.stt.ready} title={ws.stt.ready ? "" : ws.stt.reason} onClick={() => run("Transcribing", async () => {
              try { return await api.transcribe(x.id); }
              catch (err) {
                /* #17: a long recording the server cannot split (M4A, MP4, WebM, OGG, FLAC) is decoded in this browser instead */
                if (err instanceof QualApiError && (err.code === "stt_unsplittable" || err.status === 415)) {
                  const f = uploadedFiles.get(x.id);
                  if (f) return api.transcribeInBrowser(f, { sessionId: x.id }, (d, n, phase) => setProgress((cur) => ({ ...cur, [x.id]: phase === "transcribing" ? `part ${d + 1}/${n}` : phase })));
                  throw new QualApiError(`${err.message} It can be decoded in this browser instead: in Transcripts, choose this session and “Transcribe a recording in this browser…” with the same file.`, 415, err.code);
                }
                throw err;
              }
            }, (r) => { setWs(r.ws); setNote(`Transcribed.${r.warnings.length ? ` ${r.warnings.join(" ")}` : ""}`); })}>Transcribe</button>}
            {api.sandbox && <span className="ql-muted">Recordings need a saved project (private storage).</span>}
            <span className="grow" />
            {ws.can.manage && <button type="button" className="btn small" onClick={() => run("Saving", () => api.saveSession({ status: x.status === "completed" ? "planned" : "completed" }, x.id), setWs)}>{x.status === "completed" ? "Mark planned" : "Mark completed"}</button>}
            {ws.can.manage && <button type="button" className="btn small danger" onClick={() => run("Deleting", () => api.deleteSession(x.id), setWs)}>Delete</button>}
          </div>
        </div>
      ))}
      {ws.can.manage && (
        <div className="card ql-section" data-testid="qual-session-form">
          <div className="eyebrow">Record a session</div>
          <div className="ql-grid">
            <label className="f"><span>Title</span><input className="input" data-testid="qual-session-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="IDI 1 — recent switcher" /></label>
            <label className="f"><span>Type</span><select className="select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "interview" | "focus_group" })}><option value="interview">Interview</option><option value="focus_group">Focus group</option></select></label>
            <label className="f"><span>Date and time</span><input className="input" type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} /></label>
            <label className="f"><span>Moderator</span><input className="input" value={form.moderator} onChange={(e) => setForm({ ...form, moderator: e.target.value })} /></label>
          </div>
          <label className="f"><span>Participants — one per line, “label: segment”{segs.length ? ` (segments: ${segs.join(", ")})` : ""}</span><textarea className="ta" rows={3} data-testid="qual-session-participants" value={form.participants} onChange={(e) => setForm({ ...form, participants: e.target.value })} placeholder={"P1: Recent switchers\nP2: Considered but stayed"} /></label>
          <div className="ql-row"><label><input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} /> Consent captured</label><label><input type="checkbox" checked={form.recording} onChange={(e) => setForm({ ...form, recording: e.target.checked })} /> Consent to record</label></div>
          <label className="f"><span>Notes and observations</span><textarea className="ta" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
          <button type="button" className="btn primary small" data-testid="qual-session-save" disabled={!form.title.trim()} onClick={create}>Save session</button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ Transcripts */

function TranscriptsTab({ ws, api, run, setWs, setNote }: { ws: WorkspaceView; api: QualApi; run: Run; setWs: (w: WorkspaceView) => void; setNote: (n: string) => void }) {
  const s = useStudio();
  const [title, setTitle] = React.useState("");
  const [text, setText] = React.useState("");
  const [sessionId, setSessionId] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);
  const [oe, setOe] = React.useState<string[]>([]);
  const openQs = s.def.questions.filter((q) => measurementOf(q) === "text");
  const done = (r: { ws: WorkspaceView; warnings: string[] }) => { setWs(r.ws); setText(""); setTitle(""); setNote(`Imported.${r.warnings.length ? ` ${r.warnings.join(" ")}` : ""}`); };
  return (
    <div data-testid="qual-transcripts">
      {ws.transcripts.length === 0 && <div className="empty">No transcripts yet — import one below.</div>}
      {ws.transcripts.map((t) => (
        <div key={t.id} className="card ql-section" data-testid="qual-transcript" data-title={t.title}>
          <div className="ql-row">
            <b>{t.title}</b><span className="chip">{t.source === "stt" ? "Transcribed" : t.source === "open_ends" ? "Open-ended answers" : t.source === "ai_interview" ? "AI interview" : "Imported"}</span>
            {t.format && <span className="badge neutral">{t.format}</span>}
            <span className="ql-muted">{t.segments.length} segments · {Object.keys(t.speakers).length} speakers</span>
            {!ws.pii && <span className="badge warning">Redacted</span>}
            <span className="grow" />
            <button type="button" className="btn small" data-testid="qual-transcript-open" onClick={() => setOpen(open === t.id ? null : t.id)}>{open === t.id ? "Close" : "Open"}</button>
            {ws.can.manage && <button type="button" className="btn small danger" onClick={() => run("Deleting", () => api.deleteTranscript(t.id), setWs)}>Delete</button>}
          </div>
          {t.warnings.map((w, i) => <p key={i} className="ql-muted">⚠ {w}</p>)}
          {open === t.id && <TranscriptDetail t={t} ws={ws} api={api} run={run} setWs={setWs} />}
        </div>
      ))}
      {ws.can.manage && (
        <div className="card ql-section" data-testid="qual-import">
          <div className="eyebrow">Import a transcript</div>
          <p className="ql-muted">Plain text, WebVTT (.vtt) or SubRip (.srt) captions with timestamps, a Word document (.docx), or “Speaker: text” lines. Speaker names and timestamps are kept.</p>
          <div className="ql-grid">
            <label className="f"><span>Title</span><input className="input" data-testid="qual-import-title" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
            <label className="f"><span>Session</span><select className="select" data-testid="qual-import-session" value={sessionId} onChange={(e) => setSessionId(e.target.value)}><option value="">— none —</option>{ws.sessions.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label>
          </div>
          <textarea className="ta" rows={6} data-testid="qual-import-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={"Moderator: What made you think about switching?\nP1: The price went up twice last year."} />
          <div className="ql-row">
            <button type="button" className="btn primary small" data-testid="qual-import-submit" disabled={!text.trim()} onClick={() => run("Importing", () => api.importText({ text, title: title || undefined, sessionId: sessionId || null }), done)}>Import text</button>
            <label className="btn small">Import a file…<input type="file" hidden accept=".txt,.vtt,.srt,.docx,text/plain,text/vtt" data-testid="qual-import-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void run("Importing", () => api.importFile(f, { title: title || undefined, sessionId: sessionId || null }), done); }} /></label>
          </div>
          {/* #17: any recording the browser can play (M4A/AAC, MP4, WebM/Opus, OGG, FLAC, WAV, MP3) — decoded here, transcribed in parts with word timings */}
          <div className="ql-row" data-testid="qual-browser-stt">
            <label className={`btn small${api.sandbox || sessionId ? "" : " disabled"}`} title={api.sandbox ? "Decoded in this page; the recording stays in this page for clips" : sessionId ? "Decoded in this browser; the session's uploaded recording is what clips play from" : "Choose the session whose recording this is"}>
              Transcribe a recording in this browser…
              <input type="file" hidden accept="audio/*,video/*,.m4a,.aac,.mp4,.webm,.ogg,.opus,.flac,.wav,.mp3" data-testid="qual-browser-stt-file" disabled={!api.sandbox && !sessionId}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void run("Decoding and transcribing", () => api.transcribeInBrowser(f, { title: title || undefined, sessionId: sessionId || null }, (d, n, phase) => setNote(phase === "transcribing" ? `Transcribing part ${d + 1} of ${n}…` : phase === "done" ? "Merging the parts…" : `${phase[0].toUpperCase()}${phase.slice(1)} the recording in this browser…`)), (r) => { setWs(r.ws); setNote(`Transcribed.${r.warnings.length ? ` ${r.warnings.join(" ")}` : ""}`); }); }} />
            </label>
            <span className="ql-muted">Any format your browser plays — decoded here to 16 kHz mono, sent in parts of at most 24 MB with 2 s of overlap, with word timings so clips play exactly a quote.</span>
          </div>
          {openQs.length > 0 && (
            <div className="ql-oe">
              <div className="eyebrow">Or code open-ended survey answers</div>
              <div className="ql-row">{openQs.map((q) => <label key={q.id} className="chip"><input type="checkbox" checked={oe.includes(q.id)} onChange={(e) => setOe(e.target.checked ? [...oe, q.id] : oe.filter((x) => x !== q.id))} /> {q.code}</label>)}</div>
              <button type="button" className="btn small" disabled={!oe.length || api.sandbox} title={api.sandbox ? "needs a saved project with responses" : ""} onClick={() => run("Adding the answers", () => api.openEnds(oe), done)}>Add the answers (live completes)</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TranscriptDetail({ t, ws, api, run, setWs }: { t: WorkspaceView["transcripts"][number]; ws: WorkspaceView; api: QualApi; run: Run; setWs: (w: WorkspaceView) => void }) {
  const [map, setMap] = React.useState(t.speakers);
  React.useEffect(() => setMap(t.speakers), [t.speakers]);
  const groups = [...new Set(ws.sessions.flatMap((x) => x.participants.map((p) => p.segment).filter((g): g is string => !!g)))];
  return (
    <div>
      {Object.keys(map).length > 0 && (
        <div className="ql-speakers" data-testid="qual-speakers">
          {Object.entries(map).map(([label, info]) => (
            <div key={label} className="ql-row" data-testid="qual-speaker" data-label={label}>
              <b style={{ minWidth: 120 }}>{label}</b>
              <select className="select small" value={info.role ?? "participant"} disabled={!ws.can.manage} data-testid="qual-speaker-role" onChange={(e) => setMap({ ...map, [label]: { ...info, role: e.target.value as "moderator" | "participant" } })}><option value="participant">Participant</option><option value="moderator">Moderator</option></select>
              <input className="input small" list={`ql-groups-${t.id}`} placeholder="segment / group" value={info.group ?? ""} disabled={!ws.can.manage} data-testid="qual-speaker-group" onChange={(e) => setMap({ ...map, [label]: { ...info, group: e.target.value } })} />
            </div>
          ))}
          <datalist id={`ql-groups-${t.id}`}>{groups.map((g) => <option key={g} value={g} />)}</datalist>
          {ws.can.manage && <button type="button" className="btn small" data-testid="qual-speakers-save" onClick={() => run("Saving speakers", () => api.updateTranscript(t.id, { speakers: map }), setWs)}>Save speakers</button>}
        </div>
      )}
      <div className="table-wrap"><table className="grid ql-segments"><thead><tr><th>#</th><th>Speaker</th><th>Time</th><th>Text</th></tr></thead><tbody>
        {t.segments.slice(0, 400).map((g) => <tr key={g.id} data-testid="qual-segment" data-role={g.role ?? ""}><td>{g.id}</td><td>{g.speaker ?? ""}{g.role === "moderator" ? " (mod)" : ""}{g.group ? <div className="ql-muted">{g.group}</div> : null}</td><td>{formatTimestamp(g.start)}</td><td><CorrectableText ws={ws} run={run} transcriptId={t.id} segmentId={g.id} text={g.text} setWs={setWs} /></td></tr>)}
      </tbody></table></div>
      {t.segments.length > 400 && <p className="ql-muted">Showing the first 400 of {t.segments.length} segments.</p>}
    </div>
  );
}

/* ------------------------------------------------------------ Coding */

function CodingTab({ ws, api, run, setWs }: { ws: WorkspaceView; api: QualApi; run: Run; setWs: (w: WorkspaceView) => void }) {
  const cb = ws.state.codebook;
  const segs = React.useMemo(() => allSegments(ws), [ws]);
  const [mode, setMode] = React.useState<"inductive" | "deductive">("inductive");
  const [framework, setFramework] = React.useState("");
  const [sources, setSources] = React.useState<string[]>([]);
  const [report, setReport] = React.useState<CodingReport | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [focus, setFocus] = React.useState<string | null>(null);
  const [mergeInto, setMergeInto] = React.useState("");
  const [themeName, setThemeName] = React.useState("");
  const [codeForm, setCodeForm] = React.useState({ name: "", definition: "", include: "", exclude: "" });
  const [rename, setRename] = React.useState<Record<string, string>>({});
  const [manual, setManual] = React.useState({ segment: "", quote: "" });
  /* #17: an excerpt's clip — exactly its words when the transcript has word timings */
  const [clip, setClip] = React.useState<{ url: string; start: number; end: number; id: string; byWords?: boolean; approximate?: boolean } | null>(null);
  const hasMedia = (sourceId: string) => { const t = ws.transcripts.find((x) => x.id === sourceId); return !!(t?.mediaId || ws.sessions.find((x) => x.id === t?.sessionId)?.recordingMediaId); };
  const [split, setSplit] = React.useState({ a: "", b: "", toB: [] as string[] });
  const [pair, setPair] = React.useState({ a: "", b: "" });
  const [names, setNames] = React.useState((ws.settings?.redactNames ?? []).join("\n"));
  const op = (o: QualOp, label = "Saving") => run(label, () => api.op(o), setWs);
  const live = cb.codes.filter((c) => c.status !== "rejected");
  const count = (c: QualCode) => ws.state.excerpts.filter((e) => e.codeId === c.id && e.status !== "rejected").length;
  const focused = cb.codes.find((c) => c.id === focus) ?? null;
  const excerptsOf = (id: string) => ws.state.excerpts.filter((e) => e.codeId === id);
  const coders = codersOf(ws.state);
  const agr = pair.a && pair.b && pair.a !== pair.b ? agreementOf(ws, pair.a, pair.b) : null;
  const rs = reviewStatus(ws.state);
  const who = (id: string) => ws.people[id] ?? (id === "sandbox-user" ? "You" : id.slice(0, 8));
  return (
    <div data-testid="qual-coding" data-version={ws.version}>
      {!ws.can.code && <div className="alert info">You can read the codes; coding needs Data: View and Data Analytics: Edit.</div>}
      <div className="ql-row ql-status" data-testid="qual-review-status">
        <span className="badge success">{rs.codes.human_reviewed} codes reviewed</span><span className="badge warning">{rs.codes.ai_suggested} AI-suggested</span>
        <span className="badge success">{rs.excerpts.human_reviewed} excerpts reviewed</span><span className="badge warning">{rs.excerpts.ai_suggested} to review</span>
        <span className="ql-muted">codebook v{cb.version}</span>
      </div>
      {ws.can.code && (
        <div className="card ql-section" data-testid="qual-ai">
          <div className="eyebrow">AI codebook proposal</div>
          <p className="ql-muted">The segments are sent with e-mails, phone numbers and the names list redacted, in batches (one model call each, metered). Every quote the model returns must be an exact span of its segment — anything else is rejected and listed. Codes and excerpts arrive as AI suggestions for you to review.</p>
          <div className="ql-row">
            <label><input type="radio" checked={mode === "inductive"} onChange={() => setMode("inductive")} /> Inductive (from the data)</label>
            <label><input type="radio" checked={mode === "deductive"} data-testid="qual-ai-deductive" onChange={() => setMode("deductive")} /> Deductive (the codebook / a framework)</label>
          </div>
          {mode === "deductive" && <textarea className="ta" rows={3} placeholder="Paste the framework (optional when the codebook already has codes)" value={framework} onChange={(e) => setFramework(e.target.value)} />}
          <div className="ql-row">{ws.transcripts.map((t) => <label key={t.id} className="chip"><input type="checkbox" checked={sources.includes(t.id)} onChange={(e) => setSources(e.target.checked ? [...sources, t.id] : sources.filter((x) => x !== t.id))} /> {t.title}</label>)}<span className="ql-muted">{sources.length ? `${sources.length} selected` : "all sources"}</span></div>
          <button type="button" className="btn primary small" data-testid="qual-ai-code" disabled={!segs.length} onClick={() => run("Coding with AI", () => api.aiCode({ mode, ...(framework.trim() ? { framework } : {}), ...(sources.length ? { sourceIds: sources } : {}) }), (r) => { setWs(r.ws); setReport(r.report); })}>{cb.codes.length ? "Re-run AI coding" : "Propose codes (AI)"}</button>
          {report && (
            <div className="ql-report" data-testid="qual-ai-report" data-rejected={report.rejected.length} data-excerpts={report.added.excerpts}>
              <p>{report.added.codes} new codes, {report.added.themes} new themes, {report.added.excerpts} excerpts suggested · {report.calls} model call{report.calls === 1 ? "" : "s"} ({report.provider}) · redacted before sending: {Object.entries(report.redaction).map(([k, v]) => `${v} ${k}`).join(", ")}{report.skippedSegments ? ` · ${report.skippedSegments} segments over the run's limit were not sent` : ""}</p>
              {report.rejected.length > 0 && <div data-testid="qual-rejected"><b>Rejected — not verbatim or not codable ({report.rejected.length})</b><ul className="ql-list">{report.rejected.slice(0, 20).map((r, i) => <li key={i} data-testid="qual-rejected-item">“{r.quote.slice(0, 120)}” ({r.code}, {r.segmentRef}): {r.reason}</li>)}</ul></div>}
            </div>
          )}
        </div>
      )}

      <div className="ql-cols">
        <div className="card ql-section" data-testid="qual-codebook">
          <div className="eyebrow">Themes</div>
          {cb.themes.map((t) => (
            <div key={t.id} className="ql-row" data-testid="qual-theme" data-name={t.name}>
              <span className={`badge ${STATUS_BADGE[t.status]}`}>{STATUS_WORD[t.status]}</span>
              {t.parentId && <span className="ql-muted">↳</span>}
              <input className="input small" value={rename[t.id] ?? t.name} disabled={!ws.can.code} data-testid="qual-theme-name" onChange={(e) => setRename({ ...rename, [t.id]: e.target.value })} />
              {ws.can.code && rename[t.id] !== undefined && rename[t.id] !== t.name && <button type="button" className="btn small" data-testid="qual-theme-rename" onClick={() => { void op({ op: "update_theme", themeId: t.id, name: rename[t.id] }, "Renaming"); setRename(({ [t.id]: _x, ...rest }) => rest); }}>Rename</button>}
              {ws.can.code && t.status === "ai_suggested" && <button type="button" className="btn small" onClick={() => op({ op: "review_theme", themeId: t.id, decision: "accept" })}>Accept</button>}
            </div>
          ))}
          {ws.can.code && <div className="ql-row"><input className="input small" placeholder="New theme" value={themeName} data-testid="qual-theme-new" onChange={(e) => setThemeName(e.target.value)} /><button type="button" className="btn small" disabled={!themeName.trim()} onClick={() => { void op({ op: "add_theme", name: themeName }); setThemeName(""); }}>Add theme</button></div>}

          <div className="eyebrow">Codes</div>
          {cb.codes.length === 0 && <div className="empty">No codes yet.</div>}
          {cb.codes.map((c) => (
            <div key={c.id} className={`ql-code ${focus === c.id ? "on" : ""}`} data-testid="qual-code" data-name={c.name} data-status={c.status}>
              <div className="ql-row">
                {ws.can.code && <input type="checkbox" checked={selected.includes(c.id)} data-testid="qual-code-select" onChange={(e) => setSelected(e.target.checked ? [...selected, c.id] : selected.filter((x) => x !== c.id))} />}
                <button type="button" className="btn ghost small" data-testid="qual-code-open" onClick={() => setFocus(focus === c.id ? null : c.id)}><b>{c.name}</b></button>
                <span className={`badge ${STATUS_BADGE[c.status]}`}>{STATUS_WORD[c.status]}</span>
                <span className="ql-muted">{count(c)} excerpts</span>
                <span className="grow" />
                {ws.can.code && <select className="select small" value={c.themeId ?? ""} data-testid="qual-code-theme" onChange={(e) => op({ op: "assign_code", codeId: c.id, themeId: e.target.value || null })}><option value="">— no theme —</option>{cb.themes.filter((t) => t.status !== "rejected").map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
                {ws.can.code && c.status !== "human_reviewed" && <button type="button" className="btn small" data-testid="qual-code-accept" onClick={() => op({ op: "review_code", codeId: c.id, decision: "accept" })}>Accept</button>}
                {ws.can.code && c.status !== "rejected" && <button type="button" className="btn small danger" data-testid="qual-code-reject" onClick={() => op({ op: "review_code", codeId: c.id, decision: "reject" })}>Reject</button>}
              </div>
              <div className="ql-muted">{c.definition}{c.include ? ` · include: ${c.include}` : ""}{c.exclude ? ` · exclude: ${c.exclude}` : ""}</div>
            </div>
          ))}
          {ws.can.code && selected.length >= 2 && (
            <div className="ql-row" data-testid="qual-merge">
              <span>Merge {selected.length} codes into</span>
              <select className="select small" value={mergeInto} data-testid="qual-merge-into" onChange={(e) => setMergeInto(e.target.value)}><option value="">choose…</option>{selected.map((id) => <option key={id} value={id}>{cb.codes.find((c) => c.id === id)?.name}</option>)}</select>
              <button type="button" className="btn small primary" data-testid="qual-merge-go" disabled={!mergeInto} onClick={() => { void op({ op: "merge_codes", intoId: mergeInto, fromIds: selected.filter((x) => x !== mergeInto) }, "Merging"); setSelected([]); setMergeInto(""); }}>Merge</button>
            </div>
          )}
          {ws.can.code && (
            <div className="ql-add" data-testid="qual-code-form">
              <div className="eyebrow">Add a code</div>
              <input className="input small" placeholder="Name" value={codeForm.name} data-testid="qual-code-new" onChange={(e) => setCodeForm({ ...codeForm, name: e.target.value })} />
              <input className="input small" placeholder="Definition" value={codeForm.definition} onChange={(e) => setCodeForm({ ...codeForm, definition: e.target.value })} />
              <input className="input small" placeholder="Include when…" value={codeForm.include} onChange={(e) => setCodeForm({ ...codeForm, include: e.target.value })} />
              <input className="input small" placeholder="Exclude when…" value={codeForm.exclude} onChange={(e) => setCodeForm({ ...codeForm, exclude: e.target.value })} />
              <button type="button" className="btn small" disabled={!codeForm.name.trim()} onClick={() => { void op({ op: "add_code", ...codeForm }); setCodeForm({ name: "", definition: "", include: "", exclude: "" }); }}>Add code</button>
            </div>
          )}
        </div>

        <div className="card ql-section" data-testid="qual-excerpts">
          {clip && <ClipPlayer clip={clip} testId="qual-clip-player" onClose={() => setClip(null)} />}
          {!focused ? <div className="empty">Open a code to review its excerpts.</div> : <>
            <div className="ql-row">
              <b>{focused.name}</b>
              {ws.can.code && <><input className="input small" value={rename[focused.id] ?? focused.name} data-testid="qual-code-name" onChange={(e) => setRename({ ...rename, [focused.id]: e.target.value })} />
                <button type="button" className="btn small" data-testid="qual-code-rename" disabled={!rename[focused.id] || rename[focused.id] === focused.name} onClick={() => { void op({ op: "update_code", codeId: focused.id, name: rename[focused.id] }, "Renaming"); setRename(({ [focused.id]: _x, ...rest }) => rest); }}>Rename</button></>}
            </div>
            {excerptsOf(focused.id).map((e: QualExcerpt) => (
              <div key={e.id} className="ql-excerpt" data-testid="qual-excerpt" data-id={e.id} data-status={e.status} data-source={e.sourceId} data-segment={e.segmentId} data-start={e.charStart} data-end={e.charEnd}>
                <blockquote data-testid="qual-excerpt-quote">“{e.quote}”</blockquote>
                <div className="ql-row">
                  <span className="ql-muted">{ws.transcripts.find((t) => t.id === e.sourceId)?.title ?? "source"} · {e.speaker ?? ""}{e.start != null ? ` · ${formatTimestamp(e.start)}` : ""} · {e.id} · coded by {who(e.coder)}</span>
                  <span className={`badge ${STATUS_BADGE[e.status]}`}>{STATUS_WORD[e.status]}</span>
                  {e.negativeCase && <span className="badge error">Negative case</span>}
                  {ws.can.playback && e.start != null && hasMedia(e.sourceId) && <button type="button" className="btn small" data-testid="qual-excerpt-play" onClick={() => run("Opening the clip", () => api.clip(e.id), (c) => setClip({ ...c, id: e.id }))}>▶ Play clip</button>}
                  <span className="grow" />
                  {ws.can.code && <>
                    {e.status !== "human_reviewed" && <button type="button" className="btn small" data-testid="qual-excerpt-accept" onClick={() => op({ op: "review_excerpt", excerptId: e.id, decision: "accept" })}>Accept</button>}
                    {e.status !== "rejected" && <button type="button" className="btn small danger" onClick={() => op({ op: "review_excerpt", excerptId: e.id, decision: "reject" })}>Reject</button>}
                    <button type="button" className="btn small" onClick={() => op({ op: "review_excerpt", excerptId: e.id, decision: "accept", negativeCase: !e.negativeCase })}>{e.negativeCase ? "Not a negative case" : "Negative case"}</button>
                    <select className="select small" value="" onChange={(ev) => ev.target.value && op({ op: "reassign_excerpt", excerptId: e.id, codeId: ev.target.value })}><option value="">Move to…</option>{live.filter((c) => c.id !== focused.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                    <label className="ql-muted"><input type="checkbox" checked={split.toB.includes(e.id)} onChange={(ev) => setSplit({ ...split, toB: ev.target.checked ? [...split.toB, e.id] : split.toB.filter((x) => x !== e.id) })} /> split off</label>
                  </>}
                </div>
              </div>
            ))}
            {ws.can.code && split.toB.length > 0 && (
              <div className="ql-row" data-testid="qual-split">
                <span>Split “{focused.name}”: the ticked excerpts go to</span>
                <input className="input small" placeholder="new code" value={split.b} onChange={(e) => setSplit({ ...split, b: e.target.value })} />
                <span>the rest to</span>
                <input className="input small" placeholder={`keep “${focused.name}”`} value={split.a} onChange={(e) => setSplit({ ...split, a: e.target.value })} />
                <button type="button" className="btn small primary" disabled={!split.b.trim()} onClick={() => {
                  const rest = excerptsOf(focused.id).map((x) => x.id).filter((x) => !split.toB.includes(x));
                  void op({ op: "split_code", codeId: focused.id, into: [{ name: split.b, excerptIds: split.toB }, ...(split.a.trim() ? [{ name: split.a, excerptIds: rest }] : [])], removeOriginal: !!split.a.trim() }, "Splitting");
                  setSplit({ a: "", b: "", toB: [] });
                }}>Split</button>
              </div>
            )}
            {ws.can.code && ws.pii && (
              <div className="ql-add" data-testid="qual-manual">
                <div className="eyebrow">Code a passage by hand</div>
                <select className="select small" value={manual.segment} data-testid="qual-manual-segment" onChange={(e) => setManual({ ...manual, segment: e.target.value })}><option value="">choose a segment…</option>{segs.filter((g) => g.role !== "moderator").slice(0, 500).map((g) => <option key={segKey(g)} value={segKey(g)}>{ws.transcripts.find((t) => t.id === g.sourceId)?.title} · {g.id} · {g.speaker ?? ""}: {g.text.slice(0, 60)}</option>)}</select>
                <input className="input small" placeholder="the exact words" value={manual.quote} data-testid="qual-manual-quote" onChange={(e) => setManual({ ...manual, quote: e.target.value })} />
                <button type="button" className="btn small" data-testid="qual-manual-add" disabled={!manual.segment || !manual.quote.trim()} onClick={() => { const [sourceId, segmentId] = manual.segment.split("|"); void op({ op: "add_excerpt", codeId: focused.id, sourceId, segmentId, quote: manual.quote }, "Coding"); setManual({ segment: manual.segment, quote: "" }); }}>Add excerpt</button>
              </div>
            )}
          </>}
        </div>
      </div>

      <div className="card ql-section" data-testid="qual-agreement">
        <div className="eyebrow">Compare two coders</div>
        <div className="ql-row">
          <select className="select small" value={pair.a} data-testid="qual-coder-a" onChange={(e) => setPair({ ...pair, a: e.target.value })}><option value="">coder A…</option>{coders.map((c) => <option key={c} value={c}>{who(c)}</option>)}</select>
          <select className="select small" value={pair.b} data-testid="qual-coder-b" onChange={(e) => setPair({ ...pair, b: e.target.value })}><option value="">coder B…</option>{coders.map((c) => <option key={c} value={c}>{who(c)}</option>)}</select>
          {coders.length < 2 && <span className="ql-muted">Two coders are needed (the AI counts as one).</span>}
        </div>
        {agr && (
          <>
            <p className="ql-muted">{agr.note}{agr.meanKappa != null ? ` Mean κ ${agr.meanKappa.toFixed(2)}.` : ""}</p>
            <div className="table-wrap"><table className="grid" data-testid="qual-kappa"><thead><tr><th>Code</th><th>κ</th><th>Reading</th><th>Both</th><th>Only A</th><th>Only B</th><th>Neither</th><th>Disagreements</th></tr></thead><tbody>
              {agr.codes.map((c) => <tr key={c.codeId} data-testid="qual-kappa-row" data-kappa={c.kappa ?? ""}><td>{c.codeName}</td><td>{c.kappa == null ? "—" : c.kappa.toFixed(2)}</td><td>{c.words}</td><td>{c.both}</td><td>{c.onlyA}</td><td>{c.onlyB}</td><td>{c.neither}</td><td>{c.disagreements.slice(0, 6).map((d) => `${d.segmentKey.split("|")[1]} (${d.appliedBy})`).join(", ")}</td></tr>)}
            </tbody></table></div>
          </>
        )}
      </div>

      {ws.can.settings && (
        <div className="card ql-section" data-testid="qual-redaction">
          <div className="eyebrow">Redaction names</div>
          <p className="ql-muted">Names replaced (with e-mail addresses and phone numbers) before any text is sent to the AI, and for members without contact-details access. One per line.</p>
          <textarea className="ta" rows={3} value={names} data-testid="qual-redaction-names" onChange={(e) => setNames(e.target.value)} />
          <button type="button" className="btn small" onClick={() => run("Saving", () => api.settings(names.split("\n").map((x) => x.trim()).filter(Boolean)), setWs)}>Save names</button>
        </div>
      )}

      <div className="card ql-section" data-testid="qual-history">
        <div className="eyebrow">History</div>
        {ws.history.length === 0 ? <div className="ql-muted">Nothing yet.</div> : <ul className="ql-list">{ws.history.slice(-40).reverse().map((h, i) => <li key={i} data-testid="qual-history-item"><span className="ql-muted">{h.at.slice(0, 16).replace("T", " ")} · {h.actor}</span> — {h.detail}</li>)}</ul>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Themes */

function ThemesTab({ ws }: { ws: WorkspaceView }) {
  const segs = React.useMemo(() => allSegments(ws), [ws]);
  const table = React.useMemo(() => themeFrequency(ws.state, segs, { level: "theme" }), [ws, segs]);
  const sums = React.useMemo(() => themeSummaries(ws.state, segs), [ws, segs]);
  const title = (id: string) => ws.transcripts.find((t) => t.id === id)?.title ?? "source";
  return (
    <div data-testid="qual-themes">
      <div className="alert info" data-testid="qual-frequency-note">{FREQUENCY_NOTE}</div>
      {table.rows.length === 0 ? <div className="empty">No themes yet — code the data and put codes under themes.</div> : (
        <div className="table-wrap"><table className="grid" data-testid="qual-theme-table"><thead><tr><th>Theme</th><th>All ({table.base.sources} sources, {table.base.segments} segments)</th>{table.groups.map((g) => <th key={g}>{g} ({table.groupTotals[g].segments})</th>)}</tr></thead><tbody>
          {table.rows.map((r) => <tr key={r.id} data-testid="qual-theme-row" data-name={r.name}><td>{r.level === "subtheme" ? "↳ " : ""}{r.name}</td><td>{r.total.sources} src · {r.total.segments} seg · {r.total.excerpts} exc</td>{table.groups.map((g) => <td key={g} data-testid="qual-theme-cell" data-group={g}>{r.byGroup[g].segments} seg ({r.byGroup[g].share}%)</td>)}</tr>)}
        </tbody></table></div>
      )}
      {table.groups.length < 2 && table.rows.length > 0 && <p className="ql-muted">Assign speakers to participant segments (Transcripts → Open → speakers) to compare groups.</p>}
      {sums.map((t) => {
        const sent = themeSentiment(ws.state, t.themeId);
        return (
          <div key={t.themeId} className="card ql-section" data-testid="qual-theme-summary" data-name={t.name}>
            <div className="ql-row"><b>{t.name}</b><span className="ql-muted">{t.status}</span></div>
            <ul className="ql-list">{t.claims.map((c, i) => <li key={i} data-testid="qual-claim" data-cites={c.excerptIds.join(",")}>{c.text} <span className="ql-muted">[{c.excerptIds.join(", ")}]</span></li>)}</ul>
            {t.quotes.length > 0 && <><div className="eyebrow">Representative quotes</div>{t.quotes.map((e) => <blockquote key={e.id} data-testid="qual-quote">“{e.quote}” <span className="ql-muted">— {title(e.sourceId)}{e.speaker ? ` · ${e.speaker}` : ""}{e.start != null ? ` · ${formatTimestamp(e.start)}` : ""} [{e.id}]</span></blockquote>)}</>}
            {t.negative.length > 0 && <><div className="eyebrow">Contradictory evidence</div>{t.negative.slice(0, 4).map((e) => <blockquote key={e.id} className="ql-negative">“{e.quote}” <span className="ql-muted">[{e.id}]</span></blockquote>)}</>}
            {sent.n > 0 && <p className="ql-muted" title={sent.label}>Lexicon sentiment of the excerpts: {sent.positive} positive, {sent.neutral} neutral, {sent.negative} negative — indicative only.</p>}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ Report */

function ReportTab({ ws, api, run }: { ws: WorkspaceView; api: QualApi; run: Run }) {
  const [interpretation, setInterpretation] = React.useState("");
  const coders = codersOf(ws.state);
  const [pair, setPair] = React.useState({ a: "", b: "" });
  const rs = reviewStatus(ws.state);
  return (
    <div data-testid="qual-report">
      <p className="ql-muted">The qualitative report: objectives, coding methodology, codebook, themes and subthemes with their evidence (every claim cites excerpt ids; every quote is an exact span of its source), contradictory evidence, group differences, your interpretation, limitations and the review status.{ws.pii ? "" : " Your copy is redacted."}</p>
      {(rs.codes.ai_suggested > 0 || rs.excerpts.ai_suggested > 0) && <div className="alert warning">{rs.codes.ai_suggested} codes and {rs.excerpts.ai_suggested} excerpts are still AI suggestions; the report says so.</div>}
      <label className="f"><span>Interpretation (yours — the engine does not interpret)</span><textarea className="ta" rows={6} value={interpretation} data-testid="qual-interpretation" onChange={(e) => setInterpretation(e.target.value)} /></label>
      {coders.length >= 2 && <div className="ql-row"><span>Include agreement between</span><select className="select small" value={pair.a} onChange={(e) => setPair({ ...pair, a: e.target.value })}><option value="">—</option>{coders.map((c) => <option key={c} value={c}>{ws.people[c] ?? c}</option>)}</select><span>and</span><select className="select small" value={pair.b} onChange={(e) => setPair({ ...pair, b: e.target.value })}><option value="">—</option>{coders.map((c) => <option key={c} value={c}>{ws.people[c] ?? c}</option>)}</select></div>}
      <button type="button" className="btn primary small" data-testid="qual-export-report" disabled={!ws.can.report} title={ws.can.report ? "" : "needs Data: View and report downloads"} onClick={() => run("Exporting the report", () => api.exportDocx("report", { interpretation: interpretation || undefined, compare: pair.a && pair.b && pair.a !== pair.b ? pair : null }), (r) => save(r.blob, r.name))}>Export qualitative report (.docx)</button>
      {/* F2 2026-10-22: the qualitative deck (PowerPoint): key findings, theme summaries, groups, method — AI-written lines labelled */}
      <button type="button" className="btn small" data-testid="qual-export-deck" disabled={!ws.can.report} onClick={() => run("Exporting the deck", () => api.exportDocx("deck"), (r) => save(r.blob, r.name))}>Export qualitative deck (.pptx)</button>
    </div>
  );
}

