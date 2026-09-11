"use client";
import React from "react";
import type { AudioAsset, Localization } from "@rescript/schema";
import { translatableElements, audioAssets, audioFor, audioStale, currentTextFor, textHash, languageName, languageLocale, lintLanguage, type TranslatableElement } from "@rescript/engine";
import { useLocalization, useEditorName, fmtDate } from "./shared";
import { uid } from "../store";

/**
 * VOICE / AUDIO LOCALIZATION — a recording for every respondent-facing
 * element, per language.
 *
 * Three ways in, all landing on the same `AudioAsset` addressed by element
 * key + language (never by the text): 🎙 RECORD in the browser (MediaRecorder
 * — no third-party app), GENERATE AI VOICE (the platform's speech provider;
 * previewed, then approved — never presented as a human recording), or an
 * EXTERNAL URL for audio hosted elsewhere. The survey's audio priority decides
 * which one plays when several exist. When the translation changes after a
 * recording was made, the asset is flagged outdated with the three honest
 * choices: re-record, regenerate, keep.
 *
 * Storage: a real survey uploads to the platform's private audio bucket and
 * stores a signed URL; the sandbox keeps the bytes as a data URL in the
 * definition so the whole flow works with nothing behind it.
 */

const KIND_LABEL: Record<string, string> = { human: "Human recorded", ai: "AI generated", url: "External URL" };

export function AudioStudio({ focusKey, onFocused }: { focusKey?: string | null; onFocused?(): void }) {
  const { s, loc, setLoc } = useLocalization();
  const editor = useEditorName();
  const languages = [loc.sourceLanguage, ...loc.languages.map((l) => l.code).filter((c) => c !== loc.sourceLanguage)];
  const [lang, setLang] = React.useState(languages[0]);
  const [view, setView] = React.useState<"elements" | "library">("elements");
  const [question, setQuestion] = React.useState("");
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const elements = React.useMemo(() => translatableElements(s.def).filter((e) => ["question_text", "question_instruction", "option", "row", "column", "end_message", "page_title", "survey_title"].includes(e.kind)), [s.def]);
  const questions = React.useMemo(() => [...new Map(elements.filter((e) => e.questionId).map((e) => [e.questionId!, e.questionCode!])).entries()], [elements]);
  const shown = elements.filter((e) => !question || e.questionId === question || (question === "__other" && !e.questionId));
  const report = React.useMemo(() => lintLanguage(s.def, lang), [s.def, lang]);

  React.useEffect(() => { if (focusKey) { setSelectedKey(focusKey); setView("elements"); const el = elements.find((e) => e.key === focusKey); if (el?.questionId) setQuestion(el.questionId); onFocused?.(); } }, [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (!languages.includes(lang)) setLang(languages[0]); }, [languages.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const setPriority = (order: Localization["audioPriority"]) => setLoc((cur) => ({ ...cur, audioPriority: order }));
  const removeAsset = (id: string) => setLoc((cur) => ({ ...cur, audio: cur.audio.filter((a) => a.id !== id) }));
  const patchAsset = (id: string, p: Partial<AudioAsset>) => setLoc((cur) => ({ ...cur, audio: cur.audio.map((a) => (a.id === id ? { ...a, ...p, updatedAt: new Date().toISOString() } : a)) }));

  /** Store audio bytes for an element in a language — upload for a real survey, data URL in the sandbox — and register the asset. */
  const attach = async (el: TranslatableElement, blob: Blob, kind: "human" | "ai", extra: Partial<AudioAsset> = {}) => {
    const text = currentTextFor(s.def, el.key, lang) ?? el.source;
    let url: string; let fileName: string | undefined;
    if (s.surveyDbId === "sandbox") {
      url = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
    } else {
      const form = new FormData();
      const ext = /wav/.test(blob.type) ? "wav" : /webm/.test(blob.type) ? "webm" : /ogg/.test(blob.type) ? "ogg" : "mp3";
      form.append("file", new File([blob], `${el.key.replace(/[^A-Za-z0-9]+/g, "_")}.${lang}.${ext}`, { type: blob.type || "audio/webm" }));
      form.append("elementKey", el.key); form.append("language", lang); form.append("kind", kind);
      const r = await fetch(`/api/surveys/${s.surveyDbId}/audio`, { method: "POST", body: form });
      const j = await r.json().catch(() => ({})) as { url?: string; fileName?: string; error?: string };
      if (!r.ok || !j.url) throw new Error(j.error ?? `upload failed (${r.status})`);
      url = j.url; fileName = j.fileName;
    }
    const prev = audioAssets(s.def, el.key, lang).filter((a) => a.kind === kind);
    const asset: AudioAsset = {
      id: uid("au"), elementKey: el.key, language: lang, locale: languageLocale(lang, loc.languages.find((l) => l.code === lang)), kind, url, fileName, mimeType: blob.type || undefined, bytes: blob.size,
      version: (prev[0]?.version ?? 0) + 1, createdAt: new Date().toISOString(), createdBy: editor, textHash: textHash(text), approved: kind === "human", ...extra,
    };
    setLoc((cur) => ({ ...cur, audio: [...cur.audio.filter((a) => !(a.elementKey === el.key && a.language === lang && a.kind === kind)), asset] }));
  };
  const attachUrl = (el: TranslatableElement, url: string) => {
    const text = currentTextFor(s.def, el.key, lang) ?? el.source;
    const asset: AudioAsset = { id: uid("au"), elementKey: el.key, language: lang, kind: "url", url: url.trim(), version: 1, createdAt: new Date().toISOString(), createdBy: editor, textHash: textHash(text), approved: true };
    setLoc((cur) => ({ ...cur, audio: [...cur.audio.filter((a) => !(a.elementKey === el.key && a.language === lang && a.kind === "url")), asset] }));
  };

  return (
    <div data-testid="loc-audio">
      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <div className="row" style={{ gap: 4 }} data-testid="au-languages">
          {languages.map((l) => <button key={l} type="button" className={`chip ${lang === l ? "on" : ""}`} data-testid={`au-lang-${l}`} onClick={() => setLang(l)} style={{ cursor: "pointer" }}>{languageName(l, loc.languages.find((x) => x.code === l))}</button>)}
        </div>
        <span className="grow" />
        <button type="button" className={`btn small ${view === "elements" ? "primary" : ""}`} onClick={() => setView("elements")}>By element</button>
        <button type="button" className={`btn small ${view === "library" ? "primary" : ""}`} data-testid="au-library-tab" onClick={() => setView("library")}>Audio library ({loc.audio.length})</button>
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 8, fontSize: 12.5 }} data-testid="au-priority">
        <span className="flabel" style={{ margin: 0 }}>Plays first</span>
        {loc.audioPriority.map((k, i) => (
          <span key={k} className="chip">{i + 1}. {k === "human" ? "Human recorded" : k === "ai" ? "Approved AI audio" : k === "url" ? "External URL" : "No audio"}
            {i > 0 && <button type="button" className="btn small" style={{ marginLeft: 4 }} data-testid={`au-priority-up-${k}`} onClick={() => { const o = [...loc.audioPriority]; [o[i - 1], o[i]] = [o[i], o[i - 1]]; setPriority(o); }} title="move up">↑</button>}
          </span>
        ))}
        {!loc.audioPriority.includes("none") && <span className="muted">— then synthesis (AI voice) or nothing</span>}
        <span className="grow" />
        <span className="muted">{report.audio.withAudio} of {report.audio.elements} spoken elements have audio · {report.audio.stale} outdated · {report.audio.unapproved} awaiting approval</span>
      </div>

      {view === "library" ? (
        <div style={{ overflowX: "auto" }}>
          <table className="loc-table" data-testid="au-library">
            <thead><tr><th>File</th><th>Element</th><th>Language</th><th>Type</th><th>Version</th><th>Created</th><th>Duration</th><th>Status</th><th /></tr></thead>
            <tbody>
              {loc.audio.length === 0 && <tr><td colSpan={9} className="muted">No audio yet.</td></tr>}
              {loc.audio.map((a) => {
                const el = elements.find((e) => e.key === a.elementKey);
                const stale = audioStale(s.def, a);
                return (
                  <tr key={a.id} data-testid="au-asset" data-kind={a.kind}>
                    <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{a.fileName ?? (a.kind === "url" ? a.url : `${a.kind}-${a.id}`)}</td>
                    <td>{el?.label ?? a.elementKey}</td>
                    <td>{languageName(a.language)}{a.locale ? ` (${a.locale})` : ""}</td>
                    <td><span className={`chip ${a.kind === "ai" ? "ai" : ""}`}>{KIND_LABEL[a.kind]}</span></td>
                    <td>v{a.version}</td>
                    <td>{fmtDate(a.createdAt)}{a.createdBy ? ` · ${a.createdBy}` : ""}</td>
                    <td>{a.durationMs ? `${(a.durationMs / 1000).toFixed(1)} s` : "—"}</td>
                    <td>{stale ? <span className="chip warn">outdated</span> : a.kind === "ai" && !a.approved ? <span className="chip warn">awaiting approval</span> : <span className="chip">in use</span>}</td>
                    <td className="row" style={{ gap: 4 }}>
                      <audio controls preload="none" src={a.url} style={{ height: 28, width: 160 }} />
                      {a.kind === "ai" && !a.approved && <button type="button" className="btn small" onClick={() => patchAsset(a.id, { approved: true })}>approve</button>}
                      <button type="button" className="btn small" onClick={() => { setLang(a.language); setSelectedKey(a.elementKey); setView("elements"); if (el?.questionId) setQuestion(el.questionId); }}>replace</button>
                      <button type="button" className="btn small" onClick={() => removeAsset(a.id)}>delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 14 }}>
          <div>
            <select className="select" style={{ width: "100%", marginBottom: 6 }} value={question} data-testid="au-filter-question" onChange={(e) => setQuestion(e.target.value)}>
              <option value="">All questions</option>
              {questions.map(([id, code]) => <option key={id} value={id}>{code}</option>)}
              <option value="__other">Survey, pages &amp; end screens</option>
            </select>
            <div className="loc-elements" data-testid="au-elements">
              {shown.map((el) => {
                const a = audioFor(s.def, el.key, lang);
                const stale = audioAssets(s.def, el.key, lang).some((x) => audioStale(s.def, x));
                return (
                  <button key={el.key} type="button" className={`loc-element${selectedKey === el.key ? " on" : ""}`} data-testid={`au-el-${el.key}`} data-has-audio={a ? "1" : "0"} onClick={() => setSelectedKey(el.key)}>
                    <span className="loc-element-label">{el.label}</span>
                    <span className="loc-element-text">{(currentTextFor(s.def, el.key, lang) ?? el.source).replace(/<[^>]*>/g, "").slice(0, 60)}</span>
                    <span className="loc-element-badges">{a ? <span className={`chip ${a.kind === "ai" ? "ai" : ""}`}>{a.kind === "human" ? "🎙" : a.kind === "ai" ? "AI" : "URL"}</span> : <span className="muted">no audio</span>}{stale && <span className="chip warn">outdated</span>}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            {selectedKey && elements.find((e) => e.key === selectedKey)
              ? <ElementAudio key={`${selectedKey}|${lang}`} el={elements.find((e) => e.key === selectedKey)!} lang={lang} onRecord={(blob, extra) => attach(elements.find((e) => e.key === selectedKey)!, blob, "human", extra)} onAi={(blob, extra) => attach(elements.find((e) => e.key === selectedKey)!, blob, "ai", extra)} onUrl={(u) => attachUrl(elements.find((e) => e.key === selectedKey)!, u)} onApprove={(id) => patchAsset(id, { approved: true })} onDelete={removeAsset} onKeep={(id) => patchAsset(id, { textHash: textHash(currentTextFor(s.def, selectedKey, lang) ?? "") })} />
              : <div className="muted" data-testid="au-pick">Pick an element on the left to record, generate or link its audio in {languageName(lang, loc.languages.find((x) => x.code === lang))}.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------- one element */

function ElementAudio({ el, lang, onRecord, onAi, onUrl, onApprove, onDelete, onKeep }: {
  el: TranslatableElement; lang: string;
  onRecord(blob: Blob, extra?: Partial<AudioAsset>): Promise<void>;
  onAi(blob: Blob, extra?: Partial<AudioAsset>): Promise<void>;
  onUrl(url: string): void; onApprove(id: string): void; onDelete(id: string): void; onKeep(id: string): void;
}) {
  const { s, loc } = useLocalization();
  const text = currentTextFor(s.def, el.key, lang) ?? el.source;
  const assets = audioAssets(s.def, el.key, lang);
  const playing = audioFor(s.def, el.key, lang);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  /* --- recorder */
  const [recState, setRecState] = React.useState<"idle" | "recording" | "recorded">("idle");
  const [take, setTake] = React.useState<{ blob: Blob; url: string; durationMs: number } | null>(null);
  const rec = React.useRef<MediaRecorder | null>(null);
  const chunks = React.useRef<Blob[]>([]);
  const t0 = React.useRef(0);
  const canRecord = typeof window !== "undefined" && typeof (window as unknown as { MediaRecorder?: unknown }).MediaRecorder === "function" && !!navigator.mediaDevices?.getUserMedia;
  const startRec = async () => {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      chunks.current = [];
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        const blob = new Blob(chunks.current, { type: r.mimeType || "audio/webm" });
        if (take) URL.revokeObjectURL(take.url);
        setTake({ blob, url: URL.createObjectURL(blob), durationMs: Date.now() - t0.current });
        setRecState("recorded");
      };
      rec.current = r; t0.current = Date.now(); r.start(); setRecState("recording");
    } catch (e) { setErr(`Microphone not available: ${(e as Error).message}`); }
  };
  const stopRec = () => rec.current?.stop();
  const saveTake = async () => {
    if (!take) return;
    setBusy(true); setErr(null);
    try { await onRecord(take.blob, { durationMs: take.durationMs }); setTake(null); setRecState("idle"); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  /* --- ai voice */
  const [gender, setGender] = React.useState("neutral");
  const [speed, setSpeed] = React.useState(1);
  const [style, setStyle] = React.useState("");
  const [voiceId, setVoiceId] = React.useState("");
  const [gen, setGen] = React.useState<{ dataUrl: string; mimeType: string; durationMs: number } | null>(null);
  const generate = async () => {
    setBusy(true); setErr(null); setGen(null);
    try {
      const r = await fetch("/api/ai/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: s.surveyDbId, text, language: languageLocale(lang, loc.languages.find((l) => l.code === lang)), gender, speed, style: style || undefined, voiceId: voiceId || undefined }) });
      if (r.status === 501) { setErr("AI is not configured on this Studio — record a voice or link a file instead."); return; }
      const j = await r.json().catch(() => ({})) as { dataUrl?: string | null; mimeType?: string; durationMs?: number; error?: string };
      if (!r.ok) { setErr(j.error ?? `Could not generate (${r.status})`); return; }
      if (!j.dataUrl) { setErr("The provider returned no audio."); return; }
      setGen({ dataUrl: j.dataUrl, mimeType: j.mimeType ?? "audio/mpeg", durationMs: j.durationMs ?? 0 });
    } catch { setErr("Could not reach the Studio."); }
    finally { setBusy(false); }
  };
  const attachGen = async (approve: boolean) => {
    if (!gen) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(gen.dataUrl); const blob = await res.blob();
      await onAi(blob, { durationMs: gen.durationMs, approved: approve, voice: { gender, speed, style: style || undefined, voiceId: voiceId || undefined, provider: "ai" } });
      setGen(null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  /* --- url */
  const [url, setUrl] = React.useState("");

  return (
    <div className="card" style={{ padding: 12 }} data-testid="au-element" data-key={el.key} data-lang={lang}>
      <div className="flabel">{el.label} · {languageName(lang, loc.languages.find((x) => x.code === lang))}</div>
      <div className="loc-text" data-testid="au-text" dangerouslySetInnerHTML={{ __html: text }} />
      {assets.length > 0 && (
        <div style={{ margin: "8px 0" }} data-testid="au-current">
          {assets.map((a) => {
            const stale = audioStale(s.def, a);
            return (
              <div key={a.id} className="row" style={{ gap: 8, flexWrap: "wrap", fontSize: 12.5, padding: "4px 0", borderTop: "1px solid var(--border)" }} data-testid="au-asset-row" data-kind={a.kind} data-stale={stale ? "1" : "0"} data-plays={playing?.id === a.id ? "1" : "0"}>
                <span className={`chip ${a.kind === "ai" ? "ai" : ""}`} data-testid="au-asset-kind">{KIND_LABEL[a.kind]}</span>
                <span className="muted">v{a.version} · {fmtDate(a.createdAt)}{a.createdBy ? ` · ${a.createdBy}` : ""}{a.durationMs ? ` · ${(a.durationMs / 1000).toFixed(1)} s` : ""}</span>
                {playing?.id === a.id && <span className="chip" title="This is what respondents hear, by the audio priority">plays</span>}
                {a.kind === "ai" && !a.approved && <><span className="chip warn">not approved</span><button type="button" className="btn small" data-testid="au-approve" onClick={() => onApprove(a.id)}>approve</button></>}
                <audio controls preload="none" src={a.url} style={{ height: 28, width: 180 }} data-testid="au-player" />
                <span className="grow" />
                <button type="button" className="btn small" onClick={() => onDelete(a.id)}>delete</button>
                {stale && (
                  <div className="row" style={{ gap: 6, width: "100%" }} data-testid="au-stale">
                    <span className="chip warn">⚠ Translation changed — this {a.kind === "human" ? "recording" : a.kind === "ai" ? "AI audio" : "audio"} may be outdated.</span>
                    {a.kind === "human" && <button type="button" className="btn small" onClick={startRec} disabled={!canRecord}>Re-record</button>}
                    {a.kind === "ai" && <button type="button" className="btn small" onClick={generate} disabled={busy}>Regenerate</button>}
                    <button type="button" className="btn small" data-testid="au-keep" onClick={() => onKeep(a.id)}>Keep existing</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {err && <div className="chip warn" style={{ marginBottom: 6 }} data-testid="au-error">{err}</div>}

      <div className="loc-audio-sources">
        <div className="card" style={{ padding: 10 }} data-testid="au-record">
          <div className="flabel">🎙 Record voice</div>
          {!canRecord ? <div className="muted" style={{ fontSize: 12 }}>Recording needs a browser with microphone access (Chrome, Edge, Safari, Firefox over HTTPS).</div> : (
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {recState !== "recording" && <button type="button" className="btn small primary" data-testid="au-rec-start" onClick={startRec}>{recState === "recorded" ? "Re-record" : "Record"}</button>}
              {recState === "recording" && <button type="button" className="btn small" data-testid="au-rec-stop" onClick={stopRec}>■ Stop</button>}
              {recState === "recording" && <span className="chip warn">● recording…</span>}
              {take && <audio controls src={take.url} style={{ height: 28, width: 180 }} data-testid="au-rec-preview" />}
              {take && <span className="muted" style={{ fontSize: 12 }}>{(take.durationMs / 1000).toFixed(1)} s</span>}
              {take && <button type="button" className="btn small primary" data-testid="au-rec-save" disabled={busy} onClick={saveTake}>Save as {languageName(lang)} voice</button>}
            </div>
          )}
        </div>
        <div className="card" style={{ padding: 10 }} data-testid="au-ai">
          <div className="flabel">Generate AI voice <span className="chip ai" style={{ marginLeft: 6 }}>AI generated</span></div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <label className="f" style={{ width: 110 }}><span>Gender</span><select className="select" value={gender} data-testid="au-ai-gender" onChange={(e) => setGender(e.target.value)}><option value="neutral">neutral</option><option value="female">female</option><option value="male">male</option></select></label>
            <label className="f" style={{ width: 90 }}><span>Speed</span><input className="input" type="number" min={0.5} max={2} step={0.05} value={speed} data-testid="au-ai-speed" onChange={(e) => setSpeed(Math.min(2, Math.max(0.5, Number(e.target.value) || 1)))} /></label>
            <label className="f" style={{ width: 150 }}><span>Tone / style</span><input className="input" value={style} placeholder="e.g. warm, unhurried" onChange={(e) => setStyle(e.target.value)} /></label>
            <label className="f" style={{ width: 130 }}><span>Voice id (optional)</span><input className="input mono" value={voiceId} placeholder="provider voice" onChange={(e) => setVoiceId(e.target.value)} /></label>
            <button type="button" className="btn small primary" data-testid="au-ai-generate" disabled={busy} onClick={generate} style={{ alignSelf: "end" }}>{busy ? "…" : "Generate"}</button>
          </div>
          {gen && (
            <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }} data-testid="au-ai-preview">
              <audio controls src={gen.dataUrl} style={{ height: 28, width: 180 }} />
              <span className="muted" style={{ fontSize: 12 }}>{(gen.durationMs / 1000).toFixed(1)} s · {gen.mimeType}</span>
              <button type="button" className="btn small primary" data-testid="au-ai-approve" disabled={busy} onClick={() => attachGen(true)}>Approve &amp; attach</button>
              <button type="button" className="btn small" data-testid="au-ai-attach" disabled={busy} onClick={() => attachGen(false)}>Attach for later approval</button>
              <button type="button" className="btn small" onClick={() => setGen(null)}>Discard</button>
            </div>
          )}
        </div>
        <div className="card" style={{ padding: 10 }} data-testid="au-url">
          <div className="flabel">External audio URL</div>
          <div className="row" style={{ gap: 6 }}>
            <input className="input mono grow" placeholder="https://…/q1_hi.mp3" value={url} data-testid="au-url-input" onChange={(e) => setUrl(e.target.value)} />
            <button type="button" className="btn small" data-testid="au-url-save" disabled={!/^https?:\/\//i.test(url.trim())} onClick={() => { onUrl(url); setUrl(""); }}>Use this file</button>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>MP3 or WAV, reachable by respondents' browsers. Linked to {el.questionCode ?? "this element"} · {languageName(lang)} — not to the text.</div>
        </div>
      </div>
    </div>
  );
}
