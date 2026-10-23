"use client";
import React from "react";
import {
  applySurveyActions, coerceSurveyActions, buildModeratorPlan, estimateInterviewCostUsd, fakeModeratorReply, finishTurn, launchProblems, moderationOf, prepareTurn, startInterview,
  type ModeratorPlan, type ModeratorState,
} from "@rescript/engine";
import { AI_PROBING_DEPTHS, type AiModeration } from "@rescript/schema";
import { useStudio } from "../store";
import { transcriptText } from "@/lib/aiInterviews/view";
import { AiApiError, httpAiInterviewApi, sandboxAiInterviewApi, type AiInterviewApi, type AiView, type InterviewDetail } from "./aiInterviewApi";
import type { QualApi, WorkspaceView } from "./qualApi";
import { AiInterviewLanguages, VoiceStats } from "./AiInterviewLanguages";
import { translatePacks } from "@/lib/aiInterviews/translatePacks";
import { languagesNeedingPacks } from "@rescript/engine";
import { PanelChip, entryFor, usePanelEntries } from "./PanelChip";

/**
 * RESEARCH TOOLS → QUALITATIVE → AI INTERVIEWS (2026-10-22).
 *
 *   Setup       the interview guide run by an AI moderator: modes (text / voice / voice + camera), minutes,
 *               turns, probing depth (overall and per question), objectives to cover, languages, screener,
 *               quotas, persona, the thank-you / incentive / redirect, the AI cost cap — written to the
 *               definition through the same engine action Intelligent Mode uses (configure_ai_interviews)
 *   Simulate    talk to the moderator here, as a participant — the engine with the stand-in model, no AI
 *               cost, nothing stored or counted ("Open test link" runs the real one, not counted)
 *   Launch      a snapshot of the guide becomes a public link (refused without consent text)
 *   Live view   interviews as they arrive: status, flags (distress, abuse, manipulation, low quality,
 *               AI-written-looking, speeders), quotas, AI spend; a live transcript with the moderator's
 *               reasons; end or exclude an interview. Finished transcripts land in Transcripts / Coding.
 */

type Busy = (label: string, fn: () => Promise<unknown>) => Promise<unknown>;
const STATUS_BADGE: Record<string, string> = { in_progress: "info", completed: "success", screened_out: "neutral", abandoned: "warning", flagged: "error", ended: "neutral" };
const STATUS_WORD: Record<string, string> = { in_progress: "In progress", completed: "Completed", screened_out: "Screened out", abandoned: "Abandoned", flagged: "Flagged", ended: "Ended by you" };
const FLAG_WORD: Record<string, string> = { distress: "Distress", abuse: "Abuse", manipulation: "Tried to steer the AI", low_quality: "Low quality", ai_generated: "Looks AI-written", speeder: "Speeder", pii_shared: "Shared contact details", off_topic: "Off topic", ended_early: "Stopped early", provider_fallback: "Scripted fallback", cost_cap: "AI cap reached", turn_cap: "Turn cap", over_time: "Over time", realtime_unchecked: "Realtime words failed a check" };

export function AiInterviewsTab({ qualApi, setWs, setNote }: { qualApi: QualApi; setWs: (w: WorkspaceView) => void; setNote: (n: string) => void }) {
  const s = useStudio();
  const defRef = React.useRef(s.def);
  defRef.current = s.def;
  const api = React.useMemo<AiInterviewApi>(() => (s.surveyDbId === "sandbox" ? sandboxAiInterviewApi(() => defRef.current) : httpAiInterviewApi(s.surveyDbId)), [s.surveyDbId]);
  const [view, setView] = React.useState<AiView | null>(null);
  const [error, setError] = React.useState<{ text: string; status?: number; blocking?: string[] } | null>(null);
  const [busyLabel, setBusyLabel] = React.useState<string | null>(null);
  /* G3: an alert's link opens the interview it is about (?interview=<id>) */
  const [open, setOpen] = React.useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("interview")));
  const imported = React.useRef<Set<string>>(new Set());

  const busy: Busy = React.useCallback(async (label, fn) => {
    setBusyLabel(label); setError(null);
    try { return await fn(); }
    catch (e) { const err = e as AiApiError & { blocking?: string[] }; setError({ text: err.message, status: err.status }); return undefined; }
    finally { setBusyLabel(null); }
  }, []);

  const refresh = React.useCallback(async () => {
    try {
      const v = await api.load();
      setView(v);
      /* the sandbox's finished interviews join its in-page coding workspace (a saved project's are written to its tables by the runtime) */
      if (api.sandbox && v.transcripts?.length) {
        for (const t of v.transcripts) {
          if (imported.current.has(t.id)) continue;
          imported.current.add(t.id);
          const r = await qualApi.importText({ text: transcriptText(t.transcript.segments), title: t.title }).catch(() => null);
          if (r) { setWs(r.ws); setNote(`“${t.title}” was added to Transcripts for coding.`); }
        }
      }
    } catch (e) { const err = e as AiApiError; setError({ text: err.message, status: err.status }); }
  }, [api, qualApi, setWs, setNote]);

  React.useEffect(() => { void refresh(); }, [refresh]);
  /* the live view polls while a study is live (every 5 s; paused when the tab is hidden) */
  React.useEffect(() => {
    if (!view?.study || view.study.status === "closed") return;
    const t = setInterval(() => { if (typeof document === "undefined" || document.visibilityState === "visible") void refresh(); }, 5000);
    return () => clearInterval(t);
  }, [view?.study?.id, view?.study?.status, refresh]);

  const q = s.def.qualStudy;
  if (!q) return <div className="empty" data-testid="ai-no-guide"><p><b>No interview guide yet.</b></p><p className="ql-muted">Create one first (Guide tab, or ask Intelligent Mode: “Create a 30-minute interview guide about…”). Then ask “Run this guide as AI voice interviews with 50 people in Hindi and English, 20 minutes, deep probing” — or set it up here.</p></div>;
  if (q.kind !== "interview") return <div className="alert info" data-testid="ai-focus-group">AI-moderated interviews are one-to-one. This guide is a focus-group discussion guide — run groups with a human moderator and record them in Sessions, or make an interview guide for AI interviews.</div>;

  return (
    <div data-testid="ai-interviews" data-sandbox={api.sandbox ? "1" : "0"}>
      <p className="ql-muted">An AI moderator runs this guide with each participant, one at a time, from a link — by text, voice or voice with camera, in their language — asking follow-up questions for depth. You watch interviews arrive and code the transcripts here. It is not a video call: live human-moderated sessions and multi-party video conferencing are not part of Rescript.</p>
      {busyLabel && <span className="chip" data-testid="ai-busy">{busyLabel}…</span>}
      {error && <div className={`alert ${error.status === 403 ? "warning" : "error"}`} data-testid="ai-tab-error" data-status={error.status ?? ""}>{error.text}</div>}
      <Setup realtime={view?.realtime} />
      <AiInterviewLanguages api={api} view={view} busy={busy} onView={setView} />
      <Checks view={view} api={api} busy={busy} onView={setView} />
      <Simulator />
      {view?.study && <Live view={view} api={api} busy={busy} refresh={refresh} open={open} setOpen={setOpen} />}
    </div>
  );
}

/* ------------------------------------------------------------ setup */

function Setup({ realtime }: { realtime?: { available: boolean; reason?: string } }) {
  const s = useStudio();
  const q = s.def.qualStudy!;
  const cfg = moderationOf(q);
  const questions = q.sections.flatMap((sec) => sec.questions.map((x) => ({ ...x, section: sec.title, closing: sec.kind === "closing" })));
  const [form, setForm] = React.useState(() => toForm(cfg, !!q.aiModeration));
  const [err, setErr] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);
  React.useEffect(() => { setForm(toForm(moderationOf(s.def.qualStudy!), !!s.def.qualStudy?.aiModeration)); }, [s.def.qualStudy?.aiModeration]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = () => {
    setErr(null); setSaved(null);
    const f = fromForm(form, questions.map((x) => x.id));
    if (!f.ok) { setErr(f.error); return; }
    const c = coerceSurveyActions([f.action]);
    if (c.rejected.length) { setErr(c.rejected.map((r) => r.reason).join(" ")); return; }
    const r = applySurveyActions(s.def, c.actions);
    if (r.errors.length) { setErr(r.errors.join(" ")); return; }
    s.labelNextEdit("AI interview settings");
    s.update((d) => { d.qualStudy = r.def.qualStudy; });
    setSaved(r.results[0]?.description ?? "Saved.");
  };
  const set = (k: keyof FormState, v: unknown) => setForm({ ...form, [k]: v } as FormState);
  return (
    <div className="card ql-section" data-testid="ai-setup" data-configured={q.aiModeration ? "1" : "0"}>
      <div className="eyebrow">Setup {q.aiModeration ? "" : "— not configured yet"}</div>
      <div className="ql-row">
        <span>Modes</span>
        {(["text", "voice", "video"] as const).map((m) => <label key={m} className="chip"><input type="checkbox" data-testid={`ai-setup-mode-${m}`} checked={form.modes.includes(m)} onChange={(e) => set("modes", e.target.checked ? [...form.modes, m] : form.modes.filter((x) => x !== m))} /> {m === "video" ? "voice + camera" : m}</label>)}
      </div>
      {/* G1: how a voice interview talks — participants choose among the styles ticked here */}
      {form.modes.includes("voice") && (
        <div className="ql-row" data-testid="ai-setup-voice-styles">
          <span>Voice</span>
          {([["turn_based", "tap to talk (check the words, then send)"], ["conversation", "hands-free conversation (interruptible)"], ["realtime", "realtime, low latency"]] as const).map(([v, label]) => (
            <label key={v} className="chip" title={v === "realtime" ? (realtime?.available ? "speech-to-speech through the realtime provider: its words are checked AFTER they are spoken (flagged; the scripted turn follows as a correction)" : `not available: ${realtime?.reason ?? "no realtime provider configured (AI_REALTIME_*)"}`) : undefined}>
              <input type="checkbox" data-testid={`ai-setup-voice-${v}`} disabled={v === "realtime" && !realtime?.available && !form.voiceStyles.includes("realtime")} checked={form.voiceStyles.includes(v)} onChange={(e) => set("voiceStyles", e.target.checked ? [...form.voiceStyles, v] : form.voiceStyles.filter((x) => x !== v))} /> {label}
            </label>
          ))}
          {!realtime?.available && <span className="ql-muted" data-testid="ai-setup-realtime-off">Realtime is off on this installation: {realtime?.reason ?? "no realtime provider configured (AI_REALTIME_*)"}.</span>}
        </div>
      )}
      <div className="ql-grid">
        <label className="f"><span>Minutes (target)</span><input className="input" type="number" min={3} max={120} data-testid="ai-setup-minutes" value={form.minutes} onChange={(e) => set("minutes", e.target.value)} placeholder={String(q.durationMinutes ?? 20)} /></label>
        <label className="f"><span>Max moderator turns</span><input className="input" type="number" min={4} max={200} value={form.maxTurns} onChange={(e) => set("maxTurns", e.target.value)} /></label>
        <label className="f"><span>Probing</span><select className="select" data-testid="ai-setup-probing" value={form.probing} onChange={(e) => set("probing", e.target.value)}>{AI_PROBING_DEPTHS.map((d) => <option key={d} value={d}>{d === "none" ? "none — ask and move on" : d === "light" ? "light — 1 follow-up when thin" : "deep — up to 3 follow-ups"}</option>)}</select></label>
        <label className="f"><span>Interviews wanted</span><input className="input" type="number" min={1} data-testid="ai-setup-target" value={form.target} onChange={(e) => set("target", e.target.value)} /></label>
        <label className="f"><span>Languages (blank = the participant's own)</span><input className="input" data-testid="ai-setup-languages" value={form.languages} onChange={(e) => set("languages", e.target.value)} placeholder="en, hi" /></label>
        <label className="f"><span>Moderator name</span><input className="input" value={form.persona} onChange={(e) => set("persona", e.target.value)} /></label>
        <label className="f"><span>Tone</span><select className="select" value={form.tone} onChange={(e) => set("tone", e.target.value)}>{["warm", "neutral", "professional", "casual"].map((t) => <option key={t}>{t}</option>)}</select></label>
        <label className="f"><span>AI cap per interview (USD)</span><input className="input" type="number" step="0.1" min={0.1} max={50} value={form.cap} onChange={(e) => set("cap", e.target.value)} /></label>
        <label className="f"><span>Recording (voice / video)</span><select className="select" value={form.recording} onChange={(e) => set("recording", e.target.value)}><option value="optional">optional for the participant</option><option value="required">required to take part</option></select></label>
      </div>
      <label className="f"><span>Thank-you message</span><input className="input" value={form.thanks} onChange={(e) => set("thanks", e.target.value)} /></label>
      <div className="ql-grid">
        <label className="f"><span>Incentive (shown before and after)</span><input className="input" value={form.incentive} onChange={(e) => set("incentive", e.target.value)} /></label>
        <label className="f"><span>Redirect when done (https; {"{{pid}}"} = the panel id)</span><input className="input" value={form.redirect} onChange={(e) => set("redirect", e.target.value)} placeholder="https://panel.example.com/complete?pid={{pid}}" /></label>
      </div>
      <details><summary>Probing per question</summary>
        {questions.filter((x) => !x.closing).map((x) => <div key={x.id} className="ql-row"><span className="ql-muted" style={{ minWidth: 60 }}>{x.id}</span><span style={{ flex: 1 }}>{x.text}</span><select className="select small" data-testid="ai-setup-question-probing" data-question={x.id} value={form.perQuestion[x.id] ?? ""} onChange={(e) => set("perQuestion", { ...form.perQuestion, [x.id]: e.target.value })}><option value="">default</option>{AI_PROBING_DEPTHS.map((d) => <option key={d}>{d}</option>)}</select></div>)}
      </details>
      <details><summary>Screener and quotas</summary>
        <p className="ql-muted">One question per block: the question on the first line, then one answer per line as “answer =&gt; segment”; end an answer with “ (screen out)” to turn that answer away. Quotas: “segment: number” per line.</p>
        <textarea className="ta" rows={5} data-testid="ai-setup-screener" value={form.screener} onChange={(e) => set("screener", e.target.value)} placeholder={"Who pays the household broadband bill?\nI do => Payers\nSomeone else (screen out)"} />
        <textarea className="ta" rows={2} data-testid="ai-setup-quotas" value={form.quotas} onChange={(e) => set("quotas", e.target.value)} placeholder={"Payers: 30"} />
      </details>
      <details><summary>Objectives to cover</summary>
        <p className="ql-muted">One per line; blank = the guide's objectives ({q.objectives.length}).</p>
        <textarea className="ta" rows={3} value={form.objectives} onChange={(e) => set("objectives", e.target.value)} />
      </details>
      <div className="ql-row">
        <button type="button" className="btn primary small" data-testid="ai-setup-save" onClick={save} disabled={!form.modes.length}>{q.aiModeration ? "Save AI interview settings" : "Set up AI interviews"}</button>
        <span className="ql-muted">Stimuli (images, video, concept text) and anything else can be set in Intelligent Mode: “show Concept A as this image https://… in the concept section”.</span>
      </div>
      {err && <div className="alert error" data-testid="ai-setup-error">{err}</div>}
      {saved && <div className="alert success" data-testid="ai-setup-saved">{saved}</div>}
    </div>
  );
}

interface FormState { voiceStyles: ("turn_based" | "conversation" | "realtime")[]; modes: ("text" | "voice" | "video")[]; minutes: string; maxTurns: string; probing: string; target: string; languages: string; persona: string; tone: string; cap: string; recording: string; thanks: string; incentive: string; redirect: string; perQuestion: Record<string, string>; screener: string; quotas: string; objectives: string }
function toForm(c: AiModeration, configured: boolean): FormState {
  return {
    voiceStyles: c.voiceStyles?.length ? [...c.voiceStyles] : ["turn_based", "conversation"],
    modes: configured ? c.modes : ["text"], minutes: c.targetMinutes ? String(c.targetMinutes) : "", maxTurns: String(c.maxTurns), probing: c.defaultProbing, target: c.targetCompletes ? String(c.targetCompletes) : "",
    languages: c.languages.join(", "), persona: c.persona.name, tone: c.persona.tone, cap: String(c.costCapUsd), recording: c.recordingConsent, thanks: c.thankYouMessage ?? "", incentive: c.incentive ?? "", redirect: c.redirectUrl ?? "",
    perQuestion: Object.fromEntries(c.probing.map((r) => [r.questionId, r.depth])),
    screener: c.screener.map((sq) => [sq.text, ...sq.options.map((o) => `${o.label}${o.segment ? ` => ${o.segment}` : ""}${o.qualifies ? "" : " (screen out)"}`)].join("\n")).join("\n\n"),
    quotas: c.quotas.map((x) => `${x.segment}: ${x.target}`).join("\n"), objectives: c.objectives.join("\n"),
  };
}
function fromForm(f: FormState, questionIds: string[]): { ok: true; action: Record<string, unknown> } | { ok: false; error: string } {
  const num = (v: string) => (v.trim() ? Number(v) : undefined);
  const screener = f.screener.split(/\n\s*\n/).map((b) => b.split("\n").map((l) => l.trim()).filter(Boolean)).filter((b) => b.length).map(([text, ...opts]) => ({
    text, options: opts.map((o) => { const out = /\(screen out\)\s*$/i.test(o); const [label, segment] = o.replace(/\(screen out\)\s*$/i, "").split("=>").map((x) => x.trim()); return { label, qualifies: !out, ...(segment ? { segment } : {}) }; }),
  }));
  if (screener.some((q) => q.options.length < 2)) return { ok: false, error: "Each screener question needs at least two answers, one per line." };
  const quotas = f.quotas.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const m = l.match(/^(.+?)\s*:\s*(\d+)$/); return m ? { segment: m[1], target: Number(m[2]) } : null; });
  if (quotas.some((x) => !x)) return { ok: false, error: "Quotas are “segment: number”, one per line." };
  const perQuestion = Object.entries(f.perQuestion).filter(([id, d]) => d && questionIds.includes(id)).map(([question, depth]) => ({ question, depth }));
  return { ok: true, action: {
    op: "configure_ai_interviews", enabled: true, modes: f.modes, targetMinutes: num(f.minutes) ?? null, maxTurns: num(f.maxTurns), defaultProbing: f.probing,
    resetProbing: true, ...(perQuestion.length ? { probing: perQuestion } : {}), languages: f.languages.split(/[,\s]+/).filter(Boolean), targetCompletes: num(f.target) ?? null,
    persona: { name: f.persona || "Alex", tone: f.tone }, costCapUsd: num(f.cap), recordingConsent: f.recording,
    ...(f.modes.includes("voice") && f.voiceStyles.length ? { voiceStyles: f.voiceStyles } : {}),
    thankYouMessage: f.thanks.trim() || null, incentive: f.incentive.trim() || null, redirectUrl: f.redirect.trim() || null,
    screener, quotas, objectives: f.objectives.split("\n").map((x) => x.trim()).filter(Boolean),
  } };
}

/* ------------------------------------------------------------ launch checks and the link */

function Checks({ view, api, busy, onView }: { view: AiView | null; api: AiInterviewApi; busy: Busy; onView: (v: AiView) => void }) {
  const s = useStudio();
  const q = s.def.qualStudy!;
  const check = launchProblems(q, { guideLanguage: s.def.localization?.sourceLanguage });
  const est = q.aiModeration ? estimateInterviewCostUsd(buildModeratorPlan(q)) : null;
  const st = view?.study;
  const canManage = view?.can?.manage !== false;
  const launch = (relaunch: boolean) => busy(relaunch ? "Relaunching" : "Launching", async () => {
    /* G1: at launch, the study languages' wording (fallback questions, consent, page labels) is translated first and travels with the snapshot */
    const guideLanguage = (s.def.localization?.sourceLanguage ?? "en").toLowerCase().split("-")[0];
    const need = languagesNeedingPacks(q, guideLanguage);
    let translations: Awaited<ReturnType<typeof translatePacks>>["packs"] | undefined;
    if (need.length) {
      const r = await translatePacks(q, need, { guideLanguage, surveyId: s.surveyDbId, title: q.title });
      if (Object.keys(r.packs).length) {
        translations = r.packs;
        s.labelNextEdit("AI interview wording");
        s.update((d) => { if (d.qualStudy?.aiModeration) d.qualStudy.aiModeration.translations = { ...(d.qualStudy.aiModeration.translations ?? {}), ...r.packs }; });
      }
    }
    const v = await api.launch({ relaunch, ...(translations ? { translations } : {}) }); onView(v);
  });
  return (
    <div className="card ql-section" data-testid="ai-launch">
      <div className="eyebrow">Launch</div>
      {check.blocking.length > 0 && <div className="alert warning" data-testid="ai-blocking"><b>Before launch</b><ul className="ql-list">{check.blocking.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}
      {check.warnings.length > 0 && <div className="alert info" data-testid="ai-warnings"><ul className="ql-list">{check.warnings.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}
      {est !== null && <p className="ql-muted" data-testid="ai-estimate">Estimated AI cost: about ${est.toFixed(2)} per interview (one model call per answer, the guide cached), charged to this project; capped at ${moderationOf(q).costCapUsd} per interview.</p>}
      {view && !view.available && <div className="alert warning" data-testid="ai-unavailable">{view.note}</div>}
      {!st && <button type="button" className="btn primary small" data-testid="ai-launch-btn" disabled={!!check.blocking.length || !canManage || (view ? !view.available : true)} onClick={() => launch(false)}>Launch — create the participant link</button>}
      {st && (
        <div data-testid="ai-study" data-status={st.status}>
          <div className="ql-row"><b>{st.title}</b><span className={`badge ${st.status === "live" ? "success" : st.status === "paused" ? "warning" : "neutral"}`}>{st.status}</span><span className="ql-muted">AI spend ${st.spentUsd.toFixed(2)}{st.budgetUsd ? ` of $${st.budgetUsd}` : ""}</span></div>
          <div className="ql-row"><span>Participant link</span><input className="input" readOnly value={st.link} data-testid="ai-link" onFocus={(e) => e.currentTarget.select()} style={{ flex: 1 }} /><button type="button" className="btn small" onClick={() => void navigator.clipboard?.writeText(st.link)}>Copy</button></div>
          <div className="ql-row"><span>Test as respondent</span><a className="btn small" href={st.testLink} target="_blank" rel="noopener noreferrer" data-testid="ai-test-link">Open test link</a><span className="ql-muted">uses the real AI provider; test interviews are labelled, never counted and never coded</span></div>
          {canManage && <div className="ql-row">
            {st.status === "live" && <button type="button" className="btn small" data-testid="ai-pause" onClick={() => busy("Pausing", async () => onView(await api.status("pause")))}>Pause</button>}
            {st.status === "paused" && <button type="button" className="btn small" data-testid="ai-resume" onClick={() => busy("Resuming", async () => onView(await api.status("resume")))}>Resume</button>}
            {st.status !== "closed" && <button type="button" className="btn small danger" data-testid="ai-close" onClick={() => { if (window.confirm("Close the study? The link stops taking participants; interviews in progress can finish.")) void busy("Closing", async () => onView(await api.status("close"))); }}>Close</button>}
            {!check.blocking.length && <button type="button" className="btn small" data-testid="ai-relaunch" onClick={() => { if (window.confirm("Relaunch with the current guide? A new link is made; the running study is closed (its interviews are kept).")) void launch(true); }}>Relaunch with the current guide</button>}
          </div>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ the in-page simulator */

function Simulator() {
  const s = useStudio();
  const q = s.def.qualStudy!;
  const plan = React.useMemo<ModeratorPlan | null>(() => (q.aiModeration ? buildModeratorPlan(q, { guideLanguage: s.def.localization?.sourceLanguage }) : null), [q, s.def.localization?.sourceLanguage]);
  const [state, setState] = React.useState<ModeratorState | null>(null);
  const [turns, setTurns] = React.useState<{ who: "moderator" | "you"; text: string; why?: string }[]>([]);
  const [text, setText] = React.useState("");
  if (!plan) return null;
  const run = (p: ReturnType<typeof prepareTurn>) => {
    const now = Date.now();
    const out = p.kind === "final" ? { state: p.state, reply: p.reply } : finishTurn(plan, p, fakeModeratorReply(plan, p), { now });
    setState(out.state);
    setTurns((cur) => [...cur, { who: "moderator", text: out.reply.say, why: `${out.reply.decision.intent} · ${out.reply.decision.source} · ${out.reply.decision.reason}` }]);
  };
  const begin = () => { setTurns([]); run(startInterview(plan, { now: Date.now(), language: plan.guideLanguage })); };
  const answer = (kind: "answer" | "stop") => {
    if (!state) return;
    if (kind === "answer") setTurns((cur) => [...cur, { who: "you", text }]);
    run(prepareTurn(plan, state, kind === "answer" ? { kind, text } : { kind }, { now: Date.now() }));
    setText("");
  };
  return (
    <div className="card ql-section" data-testid="ai-sim">
      <div className="eyebrow">Simulate — talk to the moderator as a participant (stand-in AI, no cost, nothing stored)</div>
      {!state ? <button type="button" className="btn small" data-testid="ai-sim-start" onClick={begin}>Start a simulated interview</button> : (
        <>
          <div className="ai-sim-log">{turns.map((t, i) => <div key={i} className="ql-row" data-testid={`ai-sim-${t.who}`}><b style={{ minWidth: 80 }}>{t.who === "moderator" ? plan.persona.name : "You"}</b><span style={{ flex: 1 }}>{t.text}{t.why && <span className="ql-muted" title="why the moderator said this"> — {t.why}</span>}</span></div>)}</div>
          {state.phase !== "done" ? <div className="ql-row"><input className="input" style={{ flex: 1 }} data-testid="ai-sim-input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) answer("answer"); }} placeholder="Answer as a participant would…" /><button type="button" className="btn small primary" data-testid="ai-sim-send" disabled={!text.trim()} onClick={() => answer("answer")}>Send</button><button type="button" className="btn small" onClick={() => answer("stop")}>Stop</button></div>
            : <div className="ql-row"><span className="badge success" data-testid="ai-sim-done">Finished</span><span className="ql-muted">covered {state.covered.length} of {plan.objectives.length} objectives · {state.turns} moderator turns{state.flags.length ? ` · flags: ${state.flags.map((f) => f.kind).join(", ")}` : ""}</span><button type="button" className="btn small" onClick={begin}>Again</button></div>}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ the live view */

function Live({ view, api, busy, refresh, open, setOpen }: { view: AiView; api: AiInterviewApi; busy: Busy; refresh: () => Promise<void>; open: string | null; setOpen: (id: string | null) => void }) {
  const c = view.counts;
  /* G3: the panel each participant came from, their panel id and the outcome sent back */
  const panelEntries = usePanelEntries();
  const real = view.interviews.filter((x) => !x.isTest);
  const tests = view.interviews.filter((x) => x.isTest);
  return (
    <div className="card ql-section" data-testid="ai-live">
      <div className="eyebrow">Interviews</div>
      {c && <div className="ql-row" data-testid="ai-counts">
        <span className="badge success" data-testid="ai-count-completed">{c.completed}{view.target ? ` of ${view.target}` : ""} completed</span>
        <span className="badge info" data-testid="ai-count-progress">{c.inProgress} in progress</span>
        <span className="badge neutral">{c.screenedOut} screened out</span>
        <span className="badge warning">{c.abandoned} abandoned</span>
        {c.flagged > 0 && <span className="badge error" data-testid="ai-count-flagged">{c.flagged} flagged</span>}
        {c.alerts > 0 && <span className="badge error" data-testid="ai-alerts">⚠ {c.alerts} need attention</span>}
        {c.excluded > 0 && <span className="badge neutral">{c.excluded} excluded</span>}
        {c.tests > 0 && <span className="chip">{c.tests} test</span>}
      </div>}
      {view.quotas.length > 0 && <div className="ql-row" data-testid="ai-quotas">{view.quotas.map((q) => <span key={q.segment} className="chip" data-testid="ai-quota" data-segment={q.segment}>{q.segment}: {q.completed}/{q.target}{q.inProgress ? ` (+${q.inProgress} in progress)` : ""}</span>)}</div>}
      {!view.interviews.length && <div className="empty">No interviews yet — share the link.</div>}
      {view.interviews.length > 0 && (
        <div className="table-wrap"><table className="grid" data-testid="ai-table"><thead><tr><th>Participant</th><th>Segment</th><th>Mode</th><th>Status</th><th>Flags</th><th>Turns</th><th>Minutes</th><th>AI $</th><th /></tr></thead><tbody>
          {[...real, ...tests].map((x) => (
            <tr key={x.id} data-testid="ai-row" data-status={x.status} data-participant={x.participant} data-test={x.isTest ? "1" : "0"} data-excluded={x.excluded ? "1" : "0"}>
              <td>{x.participant}{x.isTest ? " (test)" : ""}<PanelChip e={entryFor(panelEntries, x.id)} /></td><td>{x.segment ?? ""}</td><td>{x.mode}{x.language ? ` · ${x.language}` : ""} <VoiceStats v={x.voice} /></td>
              <td><span className={`badge ${STATUS_BADGE[x.status] ?? "neutral"}`}>{STATUS_WORD[x.status] ?? x.status}</span>{x.excluded && <span className="badge neutral">Excluded</span>}</td>
              <td>{x.flags.filter((f) => f.kind !== "provider_fallback").map((f, i) => <span key={i} className={`badge ${f.severity === "alert" ? "error" : f.severity === "warning" ? "warning" : "neutral"}`} title={f.note} data-testid="ai-flag" data-kind={f.kind}>{FLAG_WORD[f.kind] ?? f.kind}</span>)}</td>
              <td>{x.turns}</td><td>{x.minutes}</td><td>{x.costUsd.toFixed(3)}</td>
              <td><button type="button" className="btn small" data-testid="ai-open" onClick={() => setOpen(open === x.id ? null : x.id)}>{open === x.id ? "Close" : "Open"}</button></td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      {open && <Transcript id={open} row={view.interviews.find((x) => x.id === open) ?? null} api={api} busy={busy} refresh={refresh} canManage={view.can?.manage !== false} />}
    </div>
  );
}

function Transcript({ id, row, api, busy, refresh, canManage }: { id: string; row: AiView["interviews"][number] | null; api: AiInterviewApi; busy: Busy; refresh: () => Promise<void>; canManage: boolean }) {
  const [d, setD] = React.useState<InterviewDetail | null>(null);
  const live = row?.status === "in_progress";
  React.useEffect(() => {
    let gone = false;
    const load = () => api.interview(id).then((x) => { if (!gone) setD(x); }).catch(() => {});
    void load();
    if (!live) return () => { gone = true; };
    const t = setInterval(load, 3000);
    return () => { gone = true; clearInterval(t); };
  }, [api, id, live]);
  return (
    <div className="card ql-section" data-testid="ai-transcript" data-live={live ? "1" : "0"}>
      <div className="ql-row"><b>{row?.participant ?? "Interview"}</b>{live && <span className="badge info">live — updates every few seconds</span>}<span className="grow" />
        {canManage && live && <button type="button" className="btn small danger" data-testid="ai-end" onClick={() => { if (window.confirm("End this interview now? The participant is told the research team ended it; what was said is kept.")) void busy("Ending", async () => { await api.act(id, "end"); await refresh(); }); }}>End interview</button>}
        {canManage && row && !row.isTest && (row.excluded
          ? <button type="button" className="btn small" data-testid="ai-include" onClick={() => void busy("Including", async () => { await api.act(id, "include"); await refresh(); })}>Include again</button>
          : <button type="button" className="btn small" data-testid="ai-exclude" onClick={() => { const reason = window.prompt("Why exclude this interview? (e.g. speeder, not genuine)") ?? undefined; void busy("Excluding", async () => { const r = await api.act(id, "exclude", reason); if (r.transcriptKept) window.alert(`Excluded. Its transcript stays in Coding because ${r.citations} coded excerpt(s) cite it.`); await refresh(); }); }}>Exclude</button>)}
      </div>
      {row?.flags.filter((f) => f.severity !== "info").map((f, i) => <div key={i} className={`alert ${f.severity === "alert" ? "error" : "warning"}`} data-testid="ai-flag-note">{FLAG_WORD[f.kind] ?? f.kind}: {f.note}</div>)}
      {!d ? <div className="sk" style={{ height: 80 }} /> : (
        <div className="table-wrap"><table className="grid ql-segments"><tbody>
          {d.turns.map((t, ti) => {
            /* G1: a participant's turn that cut the moderator short marks that turn; their voice bookkeeping is shown */
            const cut = (d.turns[ti + 1]?.decision as { voice?: { interrupted?: { seq?: number; heardChars?: number } } } | null)?.voice?.interrupted;
            const cutHere = t.speaker === "moderator" && cut && cut.seq === t.seq ? Math.max(0, Number(cut.heardChars ?? 0)) : null;
            const pv = t.speaker === "participant" ? (t.decision as { voice?: { interrupted?: unknown; previousReplyLatencyMs?: number } } | null)?.voice : null;
            return (
            <tr key={t.seq} data-testid="ai-transcript-turn" data-speaker={t.speaker} data-interrupted={cutHere !== null ? "1" : "0"}>
              <td style={{ whiteSpace: "nowrap" }}>{fmt(t.at)}</td>
              <td><b>{t.speaker === "moderator" ? "Moderator" : row?.participant ?? "Participant"}</b></td>
              <td>{cutHere !== null ? <>{t.text.slice(0, cutHere)}<s className="ql-muted" title="not heard: the participant spoke over it">{t.text.slice(cutHere)}</s> <span className="badge warning" data-testid="ai-interrupted">interrupted</span></> : t.text}
                {t.originalText && <div className="ql-muted">speech-to-text heard: “{t.originalText}”</div>}
                {t.translation && <div className="ql-muted">translation: {t.translation}</div>}
                {pv && <div className="ql-muted" data-testid="ai-voice-turn">{pv.interrupted ? "spoke over the moderator" : ""}{pv.interrupted && pv.previousReplyLatencyMs !== undefined ? " · " : ""}{pv.previousReplyLatencyMs !== undefined ? `the reply before this answer started ${(pv.previousReplyLatencyMs / 1000).toFixed(1)} s after they stopped speaking` : ""}</div>}
                {t.decision && t.decision.intent !== undefined && <div className="ql-muted" data-testid="ai-decision">{String(t.decision.intent ?? "")} · {String(t.decision.source ?? "")} · {String(t.decision.reason ?? "")}{Array.isArray(t.decision.problems) && t.decision.problems.length ? ` · replaced: ${(t.decision.problems as string[]).join("; ")}` : ""}{t.decision.interrupted ? " · after an interruption" : ""}</div>}
              </td>
            </tr>
            );
          })}
        </tbody></table></div>
      )}
    </div>
  );
}
const fmt = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
