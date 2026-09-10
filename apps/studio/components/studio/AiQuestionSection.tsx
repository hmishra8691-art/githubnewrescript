"use client";
import React from "react";
import type { Question, SpokenScript, AiQuestionOverride } from "@rescript/schema";
import { SpokenScript as SpokenScriptSchema } from "@rescript/schema";
import { effectiveAiConversation, questionAi, voiceOn, spokenSegments, spokenText, effectiveProbe, createResponseState, fakeProbe, probeInstruction, type SpokenSegment } from "@rescript/engine";
import { useStudio } from "./store";
import { CollapsibleSection } from "./CollapsibleSection";
import { VoiceTestButton, PronunciationsEditor } from "./AiConversationPanel";
import { runtimeBaseUrl } from "@/lib/runtime-url";

/**
 * AI CONVERSATION — the per-question half, in Properties.
 *
 * Everything survey-wide lives in Branding → AI Conversational Survey. Here a
 * programmer decides what is different for THIS question:
 *
 *   · overrides — text-only for a sensitive question in a voice survey; more
 *     (or no) follow-ups here; the options read differently; a different
 *     voice for a character question;
 *   · the spoken script — the displayed text is what respondents read; the
 *     spoken text may be the same (exact), a custom wording, or an
 *     AI-proposed spoken-friendly version that a programmer approves — or
 *     the wording may be LOCKED: spoken exactly as displayed, never
 *     rephrased, whatever the survey says. Option and row spoken labels,
 *     pronunciations, a recorded audio file;
 *   · a speech preview — what the voice will say for this question, in
 *     order, and a button to hear it;
 *   · an adaptive simulator — type an answer, see the follow-up the
 *     interviewer would ask, with the survey's guardrails as its instruction.
 *
 * None of this changes the question's text, options, codes, logic or export.
 */

const script = (q: Question): SpokenScript => SpokenScriptSchema.parse(q.spoken ?? {});

export function AiQuestionSection({ q, patch }: { q: Question; patch(p: Partial<Question>): void }) {
  const s = useStudio();
  const survey = effectiveAiConversation(s.def);
  const cfg = questionAi(s.def, q);
  const sp = script(q);
  const o: AiQuestionOverride = q.ai ?? {};
  const setAi = (p: Partial<AiQuestionOverride>) => {
    const next = { ...o, ...p };
    for (const k of Object.keys(next) as (keyof AiQuestionOverride)[]) if (next[k] === undefined) delete next[k];
    patch({ ai: Object.keys(next).length ? next : undefined });
  };
  const setSpoken = (p: Partial<SpokenScript>) => patch({ spoken: { ...sp, ...p } });
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);
  const [sample, setSample] = React.useState("");
  const [simulated, setSimulated] = React.useState<string | null>(null);

  const ctx = React.useMemo(() => ({ def: s.def, state: createResponseState(s.def), loop: null }), [s.def]);
  const segments: SpokenSegment[] = React.useMemo(() => {
    const isGrid = /^matrix_/.test(q.type);
    const cols = isGrid ? ((q.columns?.[0] as { options?: Question["options"] } | undefined)?.options?.length ? (q.columns[0] as { options: Question["options"] }).options : q.options) : q.options;
    return spokenSegments(s.def, q, ctx, cfg, { options: cols, rows: isGrid ? q.rows.map((r) => ({ code: r.code, label: r.label })) : undefined, columns: isGrid ? cols.map((c) => ({ code: c.code, label: c.label })) : undefined });
  }, [s.def, q, ctx, cfg]);

  const generate = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await fetch("/api/ai/rephrase", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: q.text, instruction: q.instruction, variation: survey.rephrase.maxVariation, style: survey.interviewer.style }) });
      const j = await r.json().catch(() => ({})) as { question?: string | null; error?: string };
      if (r.status === 501) { setNote("AI is not configured on this Studio — write the spoken version by hand."); return; }
      if (!r.ok) { setNote(j.error ?? `Could not generate (${r.status})`); return; }
      if (!j.question) { setNote("The AI had no usable rewording; the displayed text will be read."); return; }
      setSpoken({ mode: "ai", aiVersion: j.question, aiApproved: !survey.rephrase.requireApproval, locked: false });
      setNote(survey.rephrase.requireApproval ? "Proposed. Approve it before it is spoken." : "Applied.");
    } catch { setNote("Could not reach the Studio."); }
    finally { setBusy(false); }
  };

  const probe = effectiveProbe(s.def, q, ctx, cfg);
  const simulate = async () => {
    if (!probe || !sample.trim()) return;
    setBusy(true); setSimulated(null);
    try {
      const r = await fetch(`${runtimeBaseUrl()}/api/session/probe`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "preview", definition: s.def, questionId: q.id, n: 1, answers: { [q.id]: q.options.length ? (q.options.find((x) => x.label.toLowerCase() === sample.trim().toLowerCase())?.code ?? sample) : sample } }),
      });
      const j = await r.json().catch(() => ({})) as { prompt?: string | null; error?: string };
      if (r.status === 403 || r.status === 501) {
        // a real provider is not spent on previews; show what the deterministic writer would ask, labelled as such
        setSimulated(`(offline preview) ${fakeProbe(sample, 1, probe.instruction)}`);
      } else if (!r.ok) setSimulated(`Could not simulate: ${j.error ?? r.status}`);
      else setSimulated(j.prompt ? j.prompt : "The interviewer would not follow up on this answer.");
    } catch { setSimulated(`(offline preview) ${fakeProbe(sample, 1, probe.instruction)}`); }
    finally { setBusy(false); }
  };

  const active = !!q.ai || !!q.spoken;
  return (
    <CollapsibleSection id="ai-conversation" title="AI conversation" active={active}>
      {!survey.enabled && (
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }} data-testid="ai-q-off">
          The AI conversational survey is off (Branding → AI Conversational Survey). Settings here take effect when it is on.
        </div>
      )}
      <div className="flabel" style={{ marginBottom: 4 }}>This question</div>
      <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
        <label className="f" style={{ width: 170 }}><span>Interaction</span>
          <select className="select" data-testid="ai-q-interaction" value={o.interaction ?? ""} onChange={(e) => setAi({ interaction: (e.target.value || undefined) as never })}>
            <option value="">inherit ({survey.interaction.replace("_", " + ")})</option>
            <option value="text">text only</option><option value="voice">voice</option><option value="text_voice">text + voice</option>
          </select></label>
        <label className="f" style={{ width: 170 }}><span>Conversation</span>
          <select className="select" data-testid="ai-q-conversation" value={o.conversation ?? ""} onChange={(e) => setAi({ conversation: (e.target.value || undefined) as never })}>
            <option value="">inherit ({survey.conversation})</option>
            <option value="standard">standard</option><option value="conversational">conversational</option><option value="adaptive">adaptive</option>
          </select></label>
        <label className="f" style={{ width: 150 }} title="Adaptive follow-ups for this question; blank inherits the survey's maximum. 0 = never follow up here."><span>Max follow-ups</span>
          <input className="input" type="number" min={0} max={5} data-testid="ai-q-max-followups" value={o.adaptive?.maxFollowUps ?? ""} placeholder={`inherit (${survey.adaptive.maxFollowUps})`}
            onChange={(e) => { const v = e.target.value; setAi({ adaptive: v === "" ? undefined : { ...(o.adaptive ?? {}), maxFollowUps: Math.min(5, Math.max(0, Number(v) || 0)) } }); }} /></label>
        <label className="f" style={{ width: 170 }}><span>Read options</span>
          <select className="select" data-testid="ai-q-read-options" value={o.reading?.options === undefined ? "" : o.reading.options ? "on" : "off"}
            onChange={(e) => { const v = e.target.value; const reading = { ...(o.reading ?? {}) }; if (v === "") delete reading.options; else reading.options = v === "on"; setAi({ reading: Object.keys(reading).length ? reading : undefined }); }}>
            <option value="">inherit ({survey.voice.reading.options ? "on" : "off"})</option><option value="on">question + options</option><option value="off">question only</option>
          </select></label>
        <label className="f" style={{ width: 170 }}><span>Option reading</span>
          <select className="select" data-testid="ai-q-option-mode" value={o.reading?.optionMode ?? ""}
            onChange={(e) => { const v = e.target.value; const reading = { ...(o.reading ?? {}) }; if (v === "") delete reading.optionMode; else reading.optionMode = v as never; setAi({ reading: Object.keys(reading).length ? reading : undefined }); }}>
            <option value="">inherit ({survey.voice.reading.optionMode.replace("_", " ")})</option>
            <option value="all">all, one by one</option><option value="first_n">first N</option><option value="grouped">grouped</option><option value="on_request">on request</option><option value="none">none</option>
          </select></label>
        {/^matrix_/.test(q.type) && (
          <label className="f" style={{ width: 200 }}><span>Grid reading</span>
            <select className="select" data-testid="ai-q-grid-mode" value={o.reading?.gridMode ?? ""}
              onChange={(e) => { const v = e.target.value; const reading = { ...(o.reading ?? {}) }; if (v === "") delete reading.gridMode; else reading.gridMode = v as never; setAi({ reading: Object.keys(reading).length ? reading : undefined }); }}>
              <option value="">inherit ({survey.voice.reading.gridMode.replace(/_/g, " ")})</option>
              <option value="question_first">question, rows, columns once</option><option value="row_by_row">row by row</option><option value="respondent_driven">respondent chooses the row</option>
            </select></label>
        )}
        <label className="f" style={{ width: 130 }} title="A different voice for this question (a character, a second interviewer)."><span>Voice gender</span>
          <select className="select" data-testid="ai-q-gender" value={o.profile?.gender ?? ""} onChange={(e) => { const v = e.target.value; const profile = { ...(o.profile ?? {}) }; if (v === "") delete profile.gender; else profile.gender = v as never; setAi({ profile: Object.keys(profile).length ? profile : undefined }); }}>
            <option value="">inherit</option><option value="female">female</option><option value="male">male</option><option value="neutral">neutral</option>
          </select></label>
        <label className="f" style={{ width: 110 }}><span>Rate</span>
          <input className="input" type="number" min={0.5} max={2} step={0.05} data-testid="ai-q-rate" value={o.audio?.rate ?? ""} placeholder={`${survey.voice.audio.rate}`}
            onChange={(e) => { const v = e.target.value; const audio = { ...(o.audio ?? {}) }; if (v === "") delete audio.rate; else audio.rate = Math.min(2, Math.max(0.5, Number(v) || 1)); setAi({ audio: Object.keys(audio).length ? audio : undefined }); }} /></label>
      </div>

      <div className="flabel" style={{ margin: "10px 0 4px" }}>Spoken text</div>
      <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
        <label className="f" style={{ width: 230 }}><span>What the voice says</span>
          <select className="select" data-testid="ai-spoken-mode" value={sp.mode} onChange={(e) => setSpoken({ mode: e.target.value as SpokenScript["mode"] })}>
            <option value="exact">exactly the displayed text</option>
            <option value="ai">AI spoken-friendly version (approved)</option>
            <option value="custom">custom spoken wording</option>
          </select></label>
        {sp.mode === "ai" && (
          <>
            <button type="button" className="btn small" data-testid="ai-spoken-generate" disabled={busy || !survey.rephrase.enabled || sp.locked} onClick={generate}
              title={sp.locked ? "The wording is locked." : survey.rephrase.enabled ? "Ask the AI for a version worded for the ear; the displayed text does not change." : "Turn on “AI may propose spoken-friendly wording” under Branding → AI Conversational Survey → Advanced → Conversation."}>
              {busy ? "…" : "Generate with AI"}
            </button>
            <label className="row" style={{ gap: 4, fontSize: 13, alignSelf: "end" }}>
              <input type="checkbox" data-testid="ai-spoken-approve" checked={sp.aiApproved} disabled={!sp.aiVersion} onChange={(e) => setSpoken({ aiApproved: e.target.checked })} /> approved
            </label>
            <label className="row" style={{ gap: 4, fontSize: 13, alignSelf: "end" }} title="Locked: this question is spoken exactly as displayed and the AI may not rephrase it — whatever the survey-wide setting says.">
              <input type="checkbox" data-testid="ai-spoken-lock" checked={sp.locked} onChange={(e) => setSpoken({ locked: e.target.checked })} /> lock displayed wording
            </label>
          </>
        )}
      </div>
      {sp.mode === "ai" && (
        <label className="f"><span>AI version {sp.locked ? "(locked — the displayed text is spoken)" : sp.aiApproved ? "(approved — this is what is spoken)" : "(not approved — the displayed text is spoken until it is)"}</span>
          <textarea className="ta" style={{ minHeight: 48 }} data-testid="ai-spoken-ai-version" value={sp.aiVersion ?? ""} disabled={sp.locked}
            placeholder="Generate, or write the spoken version here and approve it"
            onChange={(e) => setSpoken({ aiVersion: e.target.value || undefined, aiApproved: false })} /></label>
      )}
      {sp.mode === "custom" && (
        <label className="f"><span>Custom spoken wording</span>
          <textarea className="ta" style={{ minHeight: 48 }} data-testid="ai-spoken-custom" value={sp.question ?? ""} placeholder="What the voice says instead of the displayed text — same meaning, worded for the ear"
            onChange={(e) => setSpoken({ question: e.target.value || undefined })} /></label>
      )}
      {note && <div className="muted" style={{ fontSize: 12.5 }} data-testid="ai-spoken-note">{note}</div>}
      <div className="row" style={{ flexWrap: "wrap", gap: 12, marginTop: 6 }}>
        <label className="f grow"><span>Spoken instruction (blank = the instruction as shown)</span>
          <input className="input" data-testid="ai-spoken-instruction" value={sp.instruction ?? ""} onChange={(e) => setSpoken({ instruction: e.target.value || undefined })} /></label>
        <label className="f" style={{ width: 260 }} title="A recording played instead of synthesised speech for the question text; the text is synthesised if the file fails."><span>Recorded audio URL</span>
          <input className="input mono" data-testid="ai-spoken-audio" value={sp.audioUrl ?? ""} placeholder="https://…/q1.mp3" onChange={(e) => setSpoken({ audioUrl: e.target.value || undefined })} /></label>
      </div>
      {q.options.length > 0 && (
        <details style={{ marginTop: 6 }} data-testid="ai-spoken-options">
          <summary style={{ fontSize: 13, cursor: "pointer" }}>Option spoken labels ({q.options.filter((x) => x.spoken?.trim()).length} of {q.options.length} set)</summary>
          <div className="muted" style={{ fontSize: 12, margin: "4px 0" }}>What the voice says for an option; the stored label and code do not change. Blank = the label.</div>
          {q.options.map((opt) => (
            <div key={String(opt.code)} className="row" style={{ gap: 6, marginBottom: 4, fontSize: 13 }}>
              <span style={{ width: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} dangerouslySetInnerHTML={{ __html: opt.label }} />
              <input className="input" style={{ width: 240 }} data-testid={`ai-option-spoken-${opt.code}`} value={opt.spoken ?? ""} placeholder="spoken as…"
                onChange={(e) => patch({ options: q.options.map((x) => (x.code === opt.code ? { ...x, spoken: e.target.value || undefined } : x)) })} />
            </div>
          ))}
        </details>
      )}
      {q.rows.length > 0 && (
        <details style={{ marginTop: 6 }} data-testid="ai-spoken-rows">
          <summary style={{ fontSize: 13, cursor: "pointer" }}>Row spoken labels</summary>
          {q.rows.map((row) => (
            <div key={String(row.code)} className="row" style={{ gap: 6, marginBottom: 4, fontSize: 13 }}>
              <span style={{ width: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} dangerouslySetInnerHTML={{ __html: row.label }} />
              <input className="input" style={{ width: 240 }} value={sp.rows[String(row.code)] ?? ""} placeholder="spoken as…"
                onChange={(e) => { const rows = { ...sp.rows }; if (e.target.value) rows[String(row.code)] = e.target.value; else delete rows[String(row.code)]; setSpoken({ rows }); }} />
            </div>
          ))}
        </details>
      )}
      <details style={{ marginTop: 6 }}>
        <summary style={{ fontSize: 13, cursor: "pointer" }}>Pronunciations for this question ({Object.keys(sp.pronunciations).length})</summary>
        <PronunciationsEditor testId="ai-q-pronunciations" value={sp.pronunciations} onChange={(v) => setSpoken({ pronunciations: v })} />
      </details>

      <div className="flabel" style={{ margin: "10px 0 4px" }}>Speech preview</div>
      <div className="card" style={{ padding: 8 }} data-testid="ai-speech-preview">
        <div className="row" style={{ gap: 8, marginBottom: 4 }}>
          <VoiceTestButton cfg={cfg} segments={segments} testId="ai-q-voice-test" />
          {!voiceOn(cfg) && <span className="muted" style={{ fontSize: 12 }}>(voice is off for this question — the script shows what would be read)</span>}
        </div>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }} data-testid="ai-speech-script">
          {segments.map((seg, i) => (
            <li key={i} data-kind={seg.kind}><span className="muted">{seg.kind}{seg.code ? ` ${seg.code}` : ""}:</span> {seg.text} <span className="muted">· {seg.pauseMs} ms</span></li>
          ))}
          {segments.length === 0 && <li className="muted">nothing would be read for this question</li>}
        </ol>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }} data-testid="ai-speech-text">{spokenText(segments)}</div>
      </div>

      <div className="flabel" style={{ margin: "10px 0 4px" }}>Adaptive follow-up simulator</div>
      {probe ? (
        <div className="card" style={{ padding: 8 }} data-testid="ai-simulator">
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            Up to {probe.maxProbes} follow-up{probe.maxProbes === 1 ? "" : "s"}{q.probe ? " (this question's own probe)" : " (from the survey's adaptive settings)"}.
            {!q.probe && <> Instruction the writer receives: <em>{probeInstruction(cfg)}</em></>}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <input className="input grow" data-testid="ai-sim-answer" placeholder={q.options.length ? "an option label, e.g. Poor" : "a sample answer"} value={sample} onChange={(e) => setSample(e.target.value)} />
            <button type="button" className="btn small" data-testid="ai-sim-run" disabled={busy || !sample.trim()} onClick={simulate}>{busy ? "…" : "Simulate"}</button>
          </div>
          {simulated && <div style={{ fontSize: 13, marginTop: 6 }} data-testid="ai-sim-result">→ {simulated}</div>}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12.5 }} data-testid="ai-simulator-none">
          No follow-up would be asked here{survey.adaptive.enabled ? " — this question type is outside “Applies to”, or its maximum is 0." : " — adaptive follow-up is off for the survey and this question has no probe of its own."}
        </div>
      )}
    </CollapsibleSection>
  );
}
