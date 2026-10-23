"use client";
import React from "react";
import { BUILTIN_INTERVIEW_LANGUAGES, EN_MESSAGES, EN_WORDS, languagePackStatus, moderationOf, nativeLanguageName, packSourceItems, packSourceHash, type InterviewSummary } from "@rescript/engine";
import type { AiLanguagePack } from "@rescript/schema";
import { useStudio } from "../store";
import { translatePacks } from "@/lib/aiInterviews/translatePacks";
import type { AiInterviewApi, AiView } from "./aiInterviewApi";

/**
 * RESEARCH TOOLS → QUALITATIVE → AI INTERVIEWS → LANGUAGES (G1 2026-10-22). For each study language: does the
 * participant page speak it built in, does the scripted fallback have the guide's wording in it (a language
 * pack — made by machine translation at launch, or now with "Translate now"), is that wording out of date
 * (the guide changed), and the wording itself to review and edit. Saving writes it to the guide; "Apply to
 * the running study" updates the launched snapshot too (its questions and logic are untouched).
 */

type Busy = (label: string, fn: () => Promise<unknown>) => Promise<unknown>;

export function AiInterviewLanguages({ api, view, busy, onView }: { api: AiInterviewApi; view: AiView | null; busy: Busy; onView: (v: AiView) => void }) {
  const s = useStudio();
  const q = s.def.qualStudy;
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [note, setNote] = React.useState<string | null>(null);
  if (!q?.aiModeration) return null;
  const guideLanguage = (s.def.localization?.sourceLanguage ?? "en").toLowerCase().split("-")[0];
  const cfg = moderationOf(q);
  const langs = cfg.languages.map((l) => l.toLowerCase().split(/[-_]/)[0]).filter((l, i, a) => l && a.indexOf(l) === i && l !== guideLanguage);
  const translate = (only?: string) => busy("Translating", async () => {
    setNote(null);
    const r = await translatePacks(q, only ? [only] : langs, { guideLanguage, surveyId: s.surveyDbId, title: q.title, force: !!only });
    if (Object.keys(r.packs).length) {
      s.labelNextEdit("AI interview wording");
      s.update((d) => { if (d.qualStudy?.aiModeration) d.qualStudy.aiModeration.translations = { ...(d.qualStudy.aiModeration.translations ?? {}), ...r.packs }; });
    }
    setNote(r.errors.length ? `Some wording could not be translated: ${r.errors.map((e) => `${e.language}: ${e.message}`).join("; ")}` : `Translated: ${Object.keys(r.packs).join(", ") || "nothing needed"}.`);
  });
  const open = (lang: string) => {
    const p = cfg.translations?.[lang];
    const d: Record<string, string> = {};
    for (const it of packSourceItems(q, lang)) d[it.key] = (it.key.startsWith("w:") ? p?.words?.[it.key.slice(2)] : it.key.startsWith("ui:") ? p?.ui?.[it.key.slice(3)] : p?.texts?.[it.key]) ?? "";
    setDraft(d); setEditing(editing === lang ? null : lang);
  };
  const save = (lang: string, apply: boolean) => busy("Saving the wording", async () => {
    const texts: Record<string, string> = {}, words: Record<string, string> = {}, ui: Record<string, string> = {};
    for (const [k, v] of Object.entries(draft)) { const t = v.trim(); if (!t) continue; if (k.startsWith("w:")) words[k.slice(2)] = t; else if (k.startsWith("ui:")) ui[k.slice(3)] = t; else texts[k] = t; }
    const pack: AiLanguagePack = { language: lang, source: "edited", translatedAt: new Date().toISOString(), sourceHash: packSourceHash(q), texts, words, ui, ...(cfg.translations?.[lang]?.provider ? { provider: cfg.translations[lang].provider } : {}) };
    s.labelNextEdit("AI interview wording");
    s.update((d) => { if (d.qualStudy?.aiModeration) d.qualStudy.aiModeration.translations = { ...(d.qualStudy.aiModeration.translations ?? {}), [lang]: pack }; });
    if (apply && view?.study && view.study.status !== "closed") onView(await api.translations({ [lang]: pack }));
    setNote(apply ? `The ${nativeLanguageName(lang)} wording is saved and applied to the running study.` : `The ${nativeLanguageName(lang)} wording is saved (it goes with the next launch).`);
  });
  const sourceOf = (key: string) => key.startsWith("w:") ? EN_WORDS[key.slice(2) as keyof typeof EN_WORDS] : key.startsWith("ui:") ? EN_MESSAGES[key.slice(3) as keyof typeof EN_MESSAGES] : packSourceItems(q, guideLanguage).find((i) => i.key === key)?.text ?? "";
  return (
    <div className="card ql-section" data-testid="ai-languages">
      <div className="eyebrow">Languages</div>
      <p className="ql-muted">The participant page speaks {BUILTIN_INTERVIEW_LANGUAGES.length} languages built in (right-to-left for Urdu and Arabic). For every study language the guide's wording — questions, probes, consent, screener, closing — is translated at launch, so if the AI is unavailable the interview carries on in the participant's language. Review and edit it here.</p>
      {!langs.length ? <p className="ql-muted" data-testid="ai-languages-none">No study languages besides the guide's ({guideLanguage}). With none set, participants may use any language: the AI answers in it, and the scripted fallback uses the guide's wording.</p> : (
        <table className="grid" data-testid="ai-languages-table"><tbody>
          {langs.map((l) => {
            const st = languagePackStatus(q, l, guideLanguage);
            const word = st.stale ? "out of date — the guide changed" : !st.hasPack ? "not translated yet (done at launch)" : st.missing.length ? `${st.missing.length} missing` : st.source === "edited" ? "reviewed" : "machine-translated";
            return (
              <tr key={l} data-testid="ai-lang-row" data-lang={l} data-state={st.stale ? "stale" : !st.hasPack ? "none" : st.missing.length ? "partial" : "ready"}>
                <td><b>{nativeLanguageName(l)}</b></td>
                <td>{st.builtinUi ? <span className="badge success">page built in</span> : <span className="badge neutral">page labels translated</span>}</td>
                <td><span className={`badge ${st.stale || !st.hasPack ? "warning" : "success"}`}>fallback wording: {word}</span></td>
                <td><button type="button" className="btn small" data-testid="ai-lang-translate" onClick={() => void translate(l)}>Translate {st.hasPack ? "again" : "now"}</button> <button type="button" className="btn small" data-testid="ai-lang-review" onClick={() => open(l)} disabled={!st.hasPack}>{editing === l ? "Close" : "Review"}</button></td>
              </tr>
            );
          })}
        </tbody></table>
      )}
      {langs.length > 0 && <div className="ql-row"><button type="button" className="btn small" data-testid="ai-lang-translate-all" onClick={() => void translate()}>Translate missing wording now</button></div>}
      {editing && (
        <div data-testid="ai-lang-editor" data-lang={editing}>
          <table className="grid ql-segments"><tbody>
            {Object.keys(draft).map((k) => (
              <tr key={k}><td className="ql-muted" style={{ width: "40%" }} title={k}>{sourceOf(k)}</td><td><textarea className="ta" rows={1} dir="auto" data-testid="ai-lang-text" data-key={k} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} /></td></tr>
            ))}
          </tbody></table>
          <div className="ql-row">
            <button type="button" className="btn small primary" data-testid="ai-lang-save" onClick={() => void save(editing, false)}>Save wording</button>
            {view?.study && view.study.status !== "closed" && <button type="button" className="btn small" data-testid="ai-lang-apply" onClick={() => void save(editing, true)}>Save and apply to the running study</button>}
          </div>
        </div>
      )}
      {note && <div className="alert info" data-testid="ai-lang-note">{note}</div>}
    </div>
  );
}

/** the live view's voice cell: style, interruptions, latency (G1) */
export function VoiceStats({ v }: { v: InterviewSummary["voice"] }) {
  if (!v) return null;
  const sec = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);
  return <span className="chip" data-testid="ai-voice-stats" data-style={v.style} data-interruptions={v.interruptions} data-latency={v.medianLatencyMs ?? ""} title={`${v.turnsMeasured} replies measured (end of speech → first audio)${v.fallback ? `; fell back: ${v.fallback}` : ""}`}>{v.style === "conversation" ? "conversation" : v.style === "realtime" ? "realtime" : "tap-to-talk"}{v.style !== "turn_based" ? ` · ${v.interruptions} interruption${v.interruptions === 1 ? "" : "s"} · ⏱ ${sec(v.medianLatencyMs)}` : ""}{v.fallback ? " · fell back" : ""}</span>;
}
