"use client";
import React from "react";
import {
  applySurveyActions, briefFromPlan, coerceSurveyActions, DEFAULT_CONSENT, DEFAULT_RECORDING_DISCLOSURE, interviewShape, planToActions, probingFromPlan,
  type InterviewPlan, type PlanTheme, type ThemeDepth,
} from "@rescript/engine";
import { useStudio } from "../store";
import { VoiceButton } from "../../intelligent/VoiceButton";

/**
 * RESEARCH CONTEXT & INTERVIEW PLANNING (2026-11-08) — Research Tools → Qualitative → Plan.
 *
 *   1 CONTEXT   the researcher explains, in their own words (typed or spoken, any language), what they want to learn,
 *               why, from whom and how deeply — no form to fill
 *   2 QUESTIONS the planner asks what a good brief has and this one lacks; answers refine the plan
 *   3 THE PLAN  objectives, themes with a depth each, questions and probes, the format and why, expected insights,
 *               what respondents are told — every part editable; the length, question count and follow-ups are
 *               DERIVED from the depths and the format (interviewShape) and the researcher may still adjust the minutes
 *   4 PREVIEW   the respondent's first screen and first question, as the interview link will show them
 *   5 APPROVE   only now is anything written: the guide and the AI interview settings, through the same actions and
 *               gate Intelligent Mode uses, as ONE undoable edit, with the brief and its approval time kept on the
 *               guide. The link is created by Launch in AI interviews (test it there first).
 *
 * The draft (context, answers, plan) is kept in this browser until approved, so a reload loses nothing.
 */
interface Draft { context: string; format: "" | "voice" | "chat" | "hybrid"; answers: Record<string, string>; plan: InterviewPlan | null; minutes: number | null; note: string | null; consent: string; recording: string }
const empty = (context = "", consent = DEFAULT_CONSENT, recording = DEFAULT_RECORDING_DISCLOSURE): Draft => ({ context, format: "", answers: {}, plan: null, minutes: null, note: null, consent, recording });
const draftKey = (id: string) => `rescript.qualPlan.${id}`;
const load = (id: string): Draft | null => { try { const v = window.localStorage.getItem(draftKey(id)); return v ? { ...empty(), ...JSON.parse(v) } : null; } catch { return null; } };
const store = (id: string, d: Draft | null) => { try { if (d) window.localStorage.setItem(draftKey(id), JSON.stringify(d)); else window.localStorage.removeItem(draftKey(id)); } catch { /* private window */ } };
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const DEPTH_WORD: Record<ThemeDepth, string> = { deep: "deep — explore thoroughly", medium: "medium", brief: "brief — cover quickly" };

const PROMPTS = [
  "The background: what is happening, and why now",
  "Why you are doing these interviews — the problem, opportunity or hypothesis",
  "What you want to learn, and what you will decide with it",
  "Topics to explore — behaviours, experiences, attitudes, motivations — and which matter most",
  "Who you want to hear from (and who not)",
];

export function PlanTab({ onDone }: { onDone: () => void }) {
  const s = useStudio();
  const existing = s.def.qualStudy;
  const [d, setD] = React.useState<Draft>(() => (typeof window !== "undefined" && load(s.surveyDbId)) || empty(existing?.brief?.context ?? "", existing?.consent?.statement || DEFAULT_CONSENT, existing?.consent?.recordingDisclosure || DEFAULT_RECORDING_DISCLOSURE));
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const set = (p: Partial<Draft>) => setD((x) => { const n = { ...x, ...p }; store(s.surveyDbId, n); return n; });
  const setPlan = (p: Partial<InterviewPlan>) => d.plan && set({ plan: { ...d.plan, ...p } });
  const setTheme = (i: number, p: Partial<PlanTheme>) => d.plan && setPlan({ themes: d.plan.themes.map((t, k) => (k === i ? { ...t, ...p } : t)) });
  const shape = d.plan ? interviewShape(d.plan) : null;
  const minutes = d.minutes ?? shape?.minutes ?? 20;

  const draft = async () => {
    setBusy(true); setErr(null); setDone(null);
    try {
      const answers = (d.plan?.clarifications ?? []).map((c) => ({ question: c.question, answer: d.answers[c.question] ?? "" })).filter((a) => a.answer.trim());
      const r = await fetch(`/api/surveys/${encodeURIComponent(s.surveyDbId)}/qual/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ context: d.context, answers, ...(d.format ? { format: d.format } : {}) }) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.plan) { setErr(String(j?.error ?? `The plan could not be drafted (${r.status}).`)); return; }
      const answered = Object.fromEntries(answers.map((a) => [a.question, a.answer]));
      set({ plan: j.plan as InterviewPlan, minutes: null, note: j.note ?? null, answers: { ...answered } });
    } catch { setErr("The plan could not be drafted — check your connection and try again."); } finally { setBusy(false); }
  };

  const approve = () => {
    if (!d.plan) return;
    setErr(null);
    if (existing?.sections.length && !window.confirm("This replaces the current interview guide and its AI interview settings with the approved plan. You can undo it. Continue?")) return;
    const c = coerceSurveyActions(planToActions(d.plan, { minutes, consentStatement: d.consent, recordingDisclosure: d.recording }));
    if (c.rejected.length) { setErr(c.rejected.map((x) => x.reason).join(" ")); return; }
    const r = applySurveyActions(s.def, c.actions);
    if (r.errors.length) { setErr(r.errors.join(" ")); return; }
    const guideQs = (r.def.qualStudy?.sections ?? []).flatMap((sec) => sec.questions.map((q) => ({ id: q.id, text: q.text })));
    const c2 = coerceSurveyActions([{ op: "configure_ai_interviews", probing: probingFromPlan(d.plan, guideQs) }]);
    const r2 = c2.actions.length ? applySurveyActions(r.def, c2.actions) : r;
    if (r2.errors.length) { setErr(r2.errors.join(" ")); return; }
    const brief = briefFromPlan(d.plan, { context: d.context, answers: Object.entries(d.answers).map(([question, answer]) => ({ question, answer })) }, { minutes, approvedAt: new Date().toISOString() });
    s.labelNextEdit("Approved research plan");
    s.update((def) => { def.qualStudy = { ...r2.def.qualStudy!, brief }; });
    store(s.surveyDbId, null);
    setDone(`Approved: “${d.plan.title}” — ${d.plan.themes.length} themes, about ${minutes} minutes, ${d.plan.format} interviews. Test it and create the respondent link in AI interviews.`);
  };

  return (
    <div className="card ql-section qp" data-testid="qual-plan">
      <div className="eyebrow">Plan the study</div>
      <p className="ql-muted">Explain what you want to learn and why, in your own words. The planner turns it into objectives, themes, questions and probes, recommends the format, length and depth, and asks about anything missing. Nothing is created until you approve it.</p>

      <section aria-labelledby="qp-context-h">
        <h4 id="qp-context-h">1. Your research, in your own words</h4>
        <ul className="qp-prompts">{PROMPTS.map((p) => <li key={p}>{p}</li>)}</ul>
        <textarea className="ta" rows={8} data-testid="qp-context" value={d.context} onChange={(e) => set({ context: e.target.value })} aria-label="Describe your research"
          placeholder="We're a mid-size bank. Young professionals aged 25–35 are leaving us for app-only banks. We want to understand why they switch, how they choose a new bank, how they feel about our app and what needs nobody meets — to decide what to fix first in the next release." />
        <div className="ql-row">
          <VoiceButton surveyId={s.surveyDbId} label="Speak instead" onHeard={(h) => set({ context: `${d.context.trim()}${d.context.trim() ? "\n" : ""}${h.text.trim()}` })} />
          <label className="f" style={{ minWidth: 220 }}><span>Interview format</span>
            <select className="select" data-testid="qp-format" value={d.format} onChange={(e) => set({ format: e.target.value as Draft["format"] })}>
              <option value="">let the planner recommend</option><option value="voice">voice</option><option value="chat">chat</option><option value="hybrid">hybrid (voice + text)</option>
            </select>
          </label>
          <span className="grow" />
          <button type="button" className="btn primary small" data-testid="qp-draft" disabled={busy || d.context.trim().length < 20} onClick={() => void draft()}>{busy ? "Planning…" : d.plan ? "Draft again" : "Draft the plan"}</button>
        </div>
      </section>

      {err && <div className="alert error" data-testid="qp-error">{err}</div>}
      {d.note && d.plan && <div className="alert info" data-testid="qp-note">{d.note}</div>}

      {d.plan && d.plan.clarifications.length > 0 && (
        <section aria-labelledby="qp-q-h" data-testid="qp-clarify">
          <h4 id="qp-q-h">2. A few questions before the plan is final</h4>
          {d.plan.clarifications.map((c) => (
            <label key={c.question} className="f qp-clarify"><span>{c.question}{c.why ? <em className="ql-muted"> — {c.why}</em> : null}</span>
              <input className="input" data-testid="qp-answer" value={d.answers[c.question] ?? ""} onChange={(e) => set({ answers: { ...d.answers, [c.question]: e.target.value } })} />
            </label>
          ))}
          <button type="button" className="btn small" data-testid="qp-refine" disabled={busy || !Object.values(d.answers).some((v) => v.trim())} onClick={() => void draft()}>{busy ? "Planning…" : "Refine the plan with these answers"}</button>
        </section>
      )}

      {d.plan && shape && (
        <>
          <section aria-labelledby="qp-plan-h" data-testid="qp-plan" data-source={d.plan.source}>
            <h4 id="qp-plan-h">{d.plan.clarifications.length ? "3" : "2"}. The plan</h4>
            <label className="f"><span>Title</span><input className="input" data-testid="qp-title" value={d.plan.title} onChange={(e) => setPlan({ title: e.target.value })} /></label>
            <div className="ql-grid">
              <label className="f"><span>Objectives (one per line)</span><textarea className="ta" rows={4} data-testid="qp-objectives" value={d.plan.objectives.join("\n")} onChange={(e) => setPlan({ objectives: lines(e.target.value) })} /></label>
              <label className="f"><span>Who to interview</span><textarea className="ta" rows={4} value={d.plan.audience} onChange={(e) => setPlan({ audience: e.target.value })} /></label>
            </div>
            {d.plan.themes.map((t, i) => (
              <div key={i} className="qp-theme" data-testid="qp-theme" data-depth={t.depth}>
                <div className="ql-row">
                  <input className="input" aria-label="Theme" value={t.name} onChange={(e) => setTheme(i, { name: e.target.value })} style={{ flex: 1, fontWeight: 600 }} />
                  <select className="select small" aria-label={`Depth of ${t.name}`} data-testid="qp-depth" value={t.depth} onChange={(e) => setTheme(i, { depth: e.target.value as ThemeDepth })}>{(["deep", "medium", "brief"] as const).map((x) => <option key={x} value={x}>{DEPTH_WORD[x]}</option>)}</select>
                  <span className="ql-muted">{shape.perTheme[i]?.minutes ?? 0} min · up to {shape.perTheme[i]?.followUps ?? 0} follow-ups</span>
                  <button type="button" className="btn tiny ghost" aria-label={`Remove ${t.name}`} onClick={() => d.plan && setPlan({ themes: d.plan.themes.filter((_, k) => k !== i) })}>×</button>
                </div>
                {t.why && <p className="ql-muted qp-why">{t.why}</p>}
                {t.questions.map((q, j) => (
                  <div key={j} className="qp-q">
                    <textarea className="ta" rows={2} aria-label="Question" data-testid="qp-question" value={q.text} onChange={(e) => setTheme(i, { questions: t.questions.map((x, k) => (k === j ? { ...x, text: e.target.value } : x)) })} />
                    <textarea className="ta qp-probes" rows={2} aria-label="Probes, one per line" placeholder="Probes, one per line" value={q.probes.join("\n")} onChange={(e) => setTheme(i, { questions: t.questions.map((x, k) => (k === j ? { ...x, probes: lines(e.target.value) } : x)) })} />
                    <button type="button" className="btn tiny ghost" aria-label="Remove question" onClick={() => setTheme(i, { questions: t.questions.filter((_, k) => k !== j) })}>×</button>
                  </div>
                ))}
                <button type="button" className="btn tiny" onClick={() => setTheme(i, { questions: [...t.questions, { text: "", probes: [] }] })}>+ Question</button>
              </div>
            ))}
            <button type="button" className="btn small" data-testid="qp-add-theme" onClick={() => d.plan && setPlan({ themes: [...d.plan.themes, { name: "New theme", depth: "medium", questions: [{ text: "", probes: [] }] }] })}>+ Theme</button>
            <div className="ql-grid">
              <label className="f"><span>Warm-up (one per line)</span><textarea className="ta" rows={2} value={d.plan.warmUp.join("\n")} onChange={(e) => setPlan({ warmUp: lines(e.target.value) })} /></label>
              <label className="f"><span>Closing question</span><input className="input" value={d.plan.closing} onChange={(e) => setPlan({ closing: e.target.value })} /></label>
            </div>
            <label className="f"><span>Expected insights (one per line)</span><textarea className="ta" rows={3} value={d.plan.expectedInsights.join("\n")} onChange={(e) => setPlan({ expectedInsights: lines(e.target.value) })} /></label>
          </section>

          <section className="qp-shape" aria-labelledby="qp-shape-h" data-testid="qp-shape">
            <h4 id="qp-shape-h">Length and depth</h4>
            <p><b data-testid="qp-minutes-rec">About {shape.minutes} minutes</b> · {shape.primaryQuestions} main questions · up to {shape.followUpsMax} follow-ups{shape.deep.length ? ` · explored deeply: ${shape.deep.join(", ")}` : ""}{shape.brief.length ? ` · covered briefly: ${shape.brief.join(", ")}` : ""}</p>
            <p className="ql-muted">Worked out from each theme's depth and the format — change a depth above and it updates.</p>
            {shape.warnings.map((w) => <div key={w} className="alert warning" data-testid="qp-warning">{w}</div>)}
            <div className="ql-grid">
              <label className="f"><span>Interview length (minutes)</span><input className="input" type="number" min={5} max={120} data-testid="qp-minutes" value={minutes} onChange={(e) => set({ minutes: Math.max(5, Math.min(120, Number(e.target.value) || shape.minutes)) })} /></label>
              <label className="f"><span>Format</span><select className="select" data-testid="qp-plan-format" value={d.plan.format} onChange={(e) => setPlan({ format: e.target.value as InterviewPlan["format"] })}><option value="voice">voice</option><option value="chat">chat</option><option value="hybrid">hybrid (voice + text)</option></select></label>
            </div>
            {d.plan.formatWhy && <p className="ql-muted">Why: {d.plan.formatWhy}</p>}
          </section>

          <section className="qp-preview" aria-labelledby="qp-preview-h" data-testid="qp-preview">
            <h4 id="qp-preview-h">What respondents see first</h4>
            <div className="ql-grid">
              <label className="f"><span>Why we are doing this research (to respondents)</span><textarea className="ta" rows={2} data-testid="qp-purpose" value={d.plan.purpose} onChange={(e) => setPlan({ purpose: e.target.value })} /></label>
              <label className="f"><span>Why they were invited (to respondents)</span><textarea className="ta" rows={2} value={d.plan.invitedBecause} onChange={(e) => setPlan({ invitedBecause: e.target.value })} /></label>
            </div>
            <div className="ql-grid">
              <label className="f"><span>Consent statement (respondents must agree)</span><textarea className="ta" rows={3} data-testid="qp-consent" value={d.consent} onChange={(e) => set({ consent: e.target.value })} /></label>
              {d.plan.format !== "chat" && <label className="f"><span>Recording disclosure (voice: recording is a separate, optional tick)</span><textarea className="ta" rows={3} data-testid="qp-recording" value={d.recording} onChange={(e) => set({ recording: e.target.value })} /></label>}
            </div>
            <div className="qp-phone" aria-label="Preview of the respondent's first screen">
              <b>{d.plan.title}</b>
              <p>{d.plan.purpose}</p>
              {d.plan.invitedBecause && <p className="ql-muted">{d.plan.invitedBecause}</p>}
              <p className="ql-muted">About {minutes} minutes · {d.plan.format === "chat" ? "type or dictate your answers" : d.plan.format === "voice" ? "a spoken conversation" : "speak or type, switch any time"} · an AI interviewer · you can stop at any time</p>
              <p className="qp-consent-line">{d.consent}</p>
              <div className="qp-privacy"><b>Your privacy</b><ul><li>Contact details you mention are masked before the AI reads your answers.</li><li>{d.plan.format === "chat" ? "Nothing is recorded — only the words you send are kept." : "Your voice or video is stored only if you tick the recording box."}</li><li>Your answers are kept as a written transcript for the research team.</li></ul></div>
              <div className="qp-bubble">{d.plan.warmUp[0] ?? d.plan.themes[0]?.questions[0]?.text}</div>
            </div>
          </section>

          <div className="ql-row">
            <button type="button" className="btn primary" data-testid="qp-approve" disabled={!d.plan.themes.some((t) => t.questions.some((q) => q.text.trim())) || !d.consent.trim()} onClick={approve}>Approve and create the study</button>
            <span className="ql-muted">Writes the guide and the AI interview settings as one undoable change. The respondent link is created when you launch in AI interviews.</span>
          </div>
        </>
      )}
      {done && <div className="alert success" data-testid="qp-done">{done} <button type="button" className="btn tiny" data-testid="qp-go-ai" onClick={onDone}>Open AI interviews</button></div>}
    </div>
  );
}
