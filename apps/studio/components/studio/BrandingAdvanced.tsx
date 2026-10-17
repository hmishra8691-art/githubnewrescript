"use client";
import React from "react";
import type { Branding } from "@rescript/schema";
import { applySurveyActions, appendSpoken, type SurveyAction } from "@rescript/engine";
import { useStudio } from "./store";
import { MediaUrlInput } from "./MediaUrlInput";
import { prepareThemeImage, type ThemeImage } from "@/lib/copilot/themeImage";
import { themePreviewStore } from "@/lib/themePreview";
import { useVoiceInput } from "@/lib/useVoiceInput";
import { refuseThemeReference, THEME_REFERENCE_ACCEPT, THEME_REFERENCE_MAX, THEME_REFERENCE_MAX_BYTES } from "@/lib/copilot/themeReferences";

/**
 * THE REST OF THE THEME — everything the renderer used to hard-code and the
 * Branding panel could not reach: typography refinements, the page
 * background (image, overlay, gradient), cards / options / radios /
 * checkboxes / inputs, and per-device sizes. Every control writes the same
 * `branding` the runtime renders and the Intelligent copilot's `set_theme`
 * writes — one theme, three ways to change it.
 */
type Set = (fn: (b: Branding) => void) => void;

const Field = ({ label, width = 120, children, title }: { label: string; width?: number; children: React.ReactNode; title?: string }) => (
  <label className="f" style={{ width }} title={title}><span>{label}</span>{children}</label>
);
function Text({ value, onChange, placeholder, testId, mono }: { value: string | undefined; onChange(v: string | undefined): void; placeholder?: string; testId?: string; mono?: boolean }) {
  return <input className={`input${mono ? " mono" : ""}`} value={value ?? ""} placeholder={placeholder} data-testid={testId} onChange={(e) => onChange(e.target.value.trim() ? e.target.value : undefined)} />;
}
function Pick<T extends string>({ value, options, onChange, testId, dflt }: { value: T | undefined; options: readonly T[]; onChange(v: T | undefined): void; testId?: string; dflt?: string }) {
  return (
    <select className="select" value={value ?? ""} data-testid={testId} onChange={(e) => onChange((e.target.value || undefined) as T | undefined)}>
      <option value="">{dflt ?? "default"}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

export function TypographyMore({ b, set }: { b: Branding; set: Set }) {
  const t = b.typography;
  return (
    <div className="row" style={{ flexWrap: "wrap", marginTop: 6 }} data-testid="branding-typography-more">
      <Field label="Heading font" width={220}><Text value={t.headingFont} placeholder="same as the font" testId="branding-heading-font" onChange={(v) => set((x) => { x.typography.headingFont = v; })} /></Field>
      <Field label="Heading weight" width={110}>
        <select className="select" value={String(t.headingWeight)} data-testid="branding-heading-weight" onChange={(e) => set((x) => { x.typography.headingWeight = Number(e.target.value); })}>
          {[400, 500, 600, 650, 700, 800].map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      </Field>
      <Field label="Question size" width={110}><Text value={t.questionSize} placeholder="1.08em" testId="branding-question-size" onChange={(v) => set((x) => { x.typography.questionSize = v; })} /></Field>
      <Field label="Line height" width={100}><Text value={t.lineHeight} placeholder="1.5" onChange={(v) => set((x) => { x.typography.lineHeight = v; })} /></Field>
      <Field label="Letter spacing" width={110}><Text value={t.letterSpacing} placeholder="normal" onChange={(v) => set((x) => { x.typography.letterSpacing = v; })} /></Field>
      <Field label="Progress" width={110}>
        <select className="select" value={b.layout.progressStyle} onChange={(e) => set((x) => { x.layout.progressStyle = e.target.value as never; })}>
          <option value="bar">bar</option><option value="percent">percent</option><option value="steps">steps</option>
        </select>
      </Field>
    </div>
  );
}

export function BackgroundSection({ b, set }: { b: Branding; set: Set }) {
  const bg = b.background;
  const patch = (fn: (x: NonNullable<Branding["background"]>) => void) => set((x) => { x.background = x.background ?? { size: "cover", position: "center", repeat: false, attachment: "fixed" }; fn(x.background); if (!x.background.image && !x.background.overlay && !x.background.gradient) delete x.background; });
  return (
    <div data-testid="branding-background">
      <MediaUrlInput label="Background image" testId="branding-bg-image" accept={["image"]} placeholder="Image URL — or choose / upload from Assets"
        value={bg?.image} onChange={(v) => patch((x) => { x.image = v || undefined; })} />
      <div className="row" style={{ flexWrap: "wrap", marginTop: 6 }}>
        <Field label="Fit" width={110}><select className="select" value={bg?.size ?? "cover"} onChange={(e) => patch((x) => { x.size = e.target.value as never; })}><option value="cover">cover</option><option value="contain">contain</option><option value="auto">actual size</option></select></Field>
        <Field label="Position" width={120}><Text value={bg?.position} placeholder="center" onChange={(v) => patch((x) => { x.position = v ?? "center"; })} /></Field>
        <Field label="Scrolls with page" width={130}><select className="select" value={bg?.attachment ?? "fixed"} onChange={(e) => patch((x) => { x.attachment = e.target.value as never; })}><option value="fixed">fixed</option><option value="scroll">scrolls</option></select></Field>
        <label className="row" style={{ gap: 4, alignSelf: "flex-end", marginBottom: 8 }}><input type="checkbox" checked={!!bg?.repeat} onChange={(e) => patch((x) => { x.repeat = e.target.checked; })} /> repeat</label>
        <Field label="Overlay (keeps text readable)" width={200}><Text value={bg?.overlay} mono placeholder="rgba(0,0,0,.5)" testId="branding-bg-overlay" onChange={(v) => patch((x) => { x.overlay = v; })} /></Field>
        <Field label="Gradient" width={280}><Text value={bg?.gradient} mono placeholder="linear-gradient(160deg, #0b0b0f, #1c1c24)" testId="branding-bg-gradient" onChange={(v) => patch((x) => { x.gradient = v; })} /></Field>
        {bg && <button type="button" className="btn small" style={{ alignSelf: "flex-end", marginBottom: 8 }} onClick={() => set((x) => { delete x.background; })} data-testid="branding-bg-clear">Remove background</button>}
      </div>
    </div>
  );
}

export function AppearanceSection({ b, set }: { b: Branding; set: Set }) {
  const a = b.appearance ?? {};
  const patch = (fn: (x: NonNullable<Branding["appearance"]>) => void) => set((x) => { x.appearance = x.appearance ?? {}; fn(x.appearance); if (!Object.values(x.appearance).some((v) => v !== undefined)) delete x.appearance; });
  return (
    <div className="row" style={{ flexWrap: "wrap" }} data-testid="branding-appearance">
      <Field label="Options look like" width={130}><Pick value={a.optionStyle} options={["cards", "pills", "minimal"] as const} dflt="bordered rows" testId="branding-option-style" onChange={(v) => patch((x) => { x.optionStyle = v; })} /></Field>
      <Field label="Radio buttons & checkboxes" width={170}><Pick value={a.controlStyle} options={["custom"] as const} dflt="browser's own" testId="branding-control-style" onChange={(v) => patch((x) => { x.controlStyle = v; })} /></Field>
      <Field label="Inputs" width={120}><Pick value={a.inputStyle} options={["filled", "underline"] as const} dflt="outlined" testId="branding-input-style" onChange={(v) => patch((x) => { x.inputStyle = v; })} /></Field>
      <Field label="Shadow" width={110}><Pick value={a.shadow} options={["none", "soft", "medium", "strong"] as const} dflt="none" testId="branding-shadow" onChange={(v) => patch((x) => { x.shadow = v; })} /></Field>
      <Field label="Card padding" width={110}><Text value={a.cardPadding} placeholder="24px" testId="branding-card-padding" onChange={(v) => patch((x) => { x.cardPadding = v; })} /></Field>
      <Field label="Border width" width={100}><Text value={a.borderWidth} placeholder="1px" onChange={(v) => patch((x) => { x.borderWidth = v; })} /></Field>
      <Field label="Gap between options" width={140}><Text value={a.optionGap} placeholder="8px" onChange={(v) => patch((x) => { x.optionGap = v; })} /></Field>
      <Field label={`Selected tint ${a.selectedTint ?? 7}%`} width={150}>
        <input type="range" min={0} max={40} value={a.selectedTint ?? 7} data-testid="branding-selected-tint" onChange={(e) => patch((x) => { x.selectedTint = Number(e.target.value); })} />
      </Field>
      <Field label="Focus colour" width={130}><Text value={a.focusColor} mono placeholder="primary" onChange={(v) => patch((x) => { x.focusColor = v; })} /></Field>
      <Field label="Button radius" width={110}><Text value={a.buttonRadius} placeholder="radius − 2px" onChange={(v) => patch((x) => { x.buttonRadius = v; })} /></Field>
      <Field label="Progress height" width={120}><Text value={a.progressHeight} placeholder="6px" onChange={(v) => patch((x) => { x.progressHeight = v; })} /></Field>
      <Field label="Logo height" width={110}><Text value={a.logoMaxHeight} placeholder="44px" onChange={(v) => patch((x) => { x.logoMaxHeight = v; })} /></Field>
    </div>
  );
}

export function ResponsiveSection({ b, set }: { b: Branding; set: Set }) {
  const r = b.responsive ?? {};
  const row = (device: "tablet" | "mobile", label: string) => {
    const o = r[device] ?? {};
    const patch = (fn: (x: NonNullable<NonNullable<Branding["responsive"]>["mobile"]>) => void) => set((x) => {
      x.responsive = x.responsive ?? {};
      const cur = x.responsive[device] ?? {};
      fn(cur);
      if (Object.values(cur).some((v) => v !== undefined && v !== false)) x.responsive[device] = cur; else delete x.responsive[device];
      if (!x.responsive.tablet && !x.responsive.mobile) delete x.responsive;
    });
    return (
      <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }} data-testid={`branding-responsive-${device}`}>
        <span style={{ width: 70, fontWeight: 600, fontSize: 12.5, marginBottom: 12 }}>{label}</span>
        <Field label="Base size" width={90}><Text value={o.baseSize} placeholder="as desktop" testId={`branding-${device}-base-size`} onChange={(v) => patch((x) => { x.baseSize = v; })} /></Field>
        <Field label="Card padding" width={100}><Text value={o.cardPadding} placeholder="as desktop" onChange={(v) => patch((x) => { x.cardPadding = v; })} /></Field>
        <Field label="Option gap" width={90}><Text value={o.optionGap} placeholder="as desktop" onChange={(v) => patch((x) => { x.optionGap = v; })} /></Field>
        <Field label="Radius" width={80}><Text value={o.radius} placeholder="as desktop" onChange={(v) => patch((x) => { x.radius = v; })} /></Field>
        <Field label="Question size" width={100}><Text value={o.questionSize} placeholder="as desktop" onChange={(v) => patch((x) => { x.questionSize = v; })} /></Field>
        {device === "tablet" && <Field label="Max width" width={90}><Text value={o.maxWidth} placeholder="as desktop" onChange={(v) => patch((x) => { x.maxWidth = v; })} /></Field>}
        <label className="row" style={{ gap: 4, marginBottom: 12 }}><input type="checkbox" checked={!!o.hideBackgroundImage} onChange={(e) => patch((x) => { x.hideBackgroundImage = e.target.checked || undefined; })} /> no background image</label>
      </div>
    );
  };
  return <div data-testid="branding-responsive">{row("tablet", "Tablet")}{row("mobile", "Phone")}</div>;
}

/**
 * THE THEME ASSISTANT — "Design with AI": Intelligent mode's theme skill, in
 * Branding. "Make it look like this", "a premium dark theme around these",
 * typed or SPOKEN (the Studio's shared microphone — the same recorder and
 * /api/ai/transcribe path as Intelligent mode; the transcript is appended to
 * what is typed, never replacing it, and stays editable before sending), with
 * up to four reference images to build the theme from. The copilot answers
 * with `set_theme`, checked by the engine exactly as in Intelligent mode,
 * previewed here field by field, and applied as one undoable edit INTO these
 * settings — so everything it chose is then in the controls above to adjust
 * by hand.
 */
type ThemeRef = { id: string; name: string; size: number; preview: string; image: ThemeImage | null };
const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
let refSeq = 0;

export function ThemeAssistant() {
  const s = useStudio();
  const [text, setText] = React.useState("");
  const [refs, setRefs] = React.useState<ThemeRef[]>([]);
  const [refErrors, setRefErrors] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [proposal, setProposal] = React.useState<{ actions: SurveyAction[]; reply: string; lines: string[]; errors: string[] } | null>(null);
  const file = React.useRef<HTMLInputElement>(null);
  const fakeRef = React.useRef<unknown[]>([]);
  React.useEffect(() => {
    const w = window as unknown as { __rescriptThemeFake?: (r: unknown) => void };
    w.__rescriptThemeFake = (r) => { fakeRef.current.push(r); };
    return () => { delete w.__rescriptThemeFake; };
  }, []);
  /* the microphone: what was heard is APPENDED to the prompt (as spoken — the model reads any language), then editable before sending */
  const voice = useVoiceInput({
    surveyId: s.surveyDbId,
    fileName: "theme.webm",
    refusedMessage: "Microphone access was refused — allow it in the browser to describe the look by voice.",
    onTranscript: (heard) => { setText((t) => appendSpoken(t, heard.text || heard.english || "")); },
  });
  const recording = voice.state === "recording" || voice.state === "paused";
  const ready = refs.filter((r) => r.image).map((r) => r.image!);
  const reading = refs.some((r) => !r.image);

  const addFiles = async (files: File[]) => {
    const errs: string[] = [];
    const accepted: { ref: ThemeRef; file: File }[] = [];
    for (const f of files) {
      const why = refuseThemeReference(f, refs.length + accepted.length);
      if (why) { errs.push(why); continue; }
      accepted.push({ ref: { id: `ref${++refSeq}`, name: f.name, size: f.size, preview: URL.createObjectURL(f), image: null }, file: f });
    }
    setRefErrors(errs);
    if (!accepted.length) return;
    setRefs((rs) => [...rs, ...accepted.map((a) => a.ref)]);
    for (const { ref, file: f } of accepted) {
      try {
        const image = await prepareThemeImage(f, s.surveyDbId);
        setRefs((rs) => rs.map((r) => (r.id === ref.id ? { ...r, image } : r)));
      } catch (x) {
        setRefs((rs) => rs.filter((r) => r.id !== ref.id));
        setRefErrors((es) => [...es, `“${f.name}” could not be read: ${(x as Error).message}`]);
      } finally { URL.revokeObjectURL(ref.preview); }
    }
  };
  const removeRef = (id: string) => { setRefs((rs) => rs.filter((r) => r.id !== id)); setRefErrors([]); };

  const ask = async () => {
    if ((!text.trim() && !ready.length) || reading) return;
    setBusy("Designing the theme…"); setError(null); setProposal(null);
    try {
      const fake = fakeRef.current.shift();
      const fallback = ready.length > 1 ? "Build the survey theme from these references." : "Build the survey theme from this image.";
      const r = await fetch("/api/copilot/turn", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ surveyId: s.surveyDbId, message: text.trim() || fallback, definition: s.def, scope: "theme", ...(ready.length ? { themeImages: ready } : {}), ...(fake ? { fake } : {}) }),
      });
      const d = await r.json().catch(() => null) as { ok?: boolean; error?: string; reply?: { reply: string; actions: SurveyAction[] } | null; message?: string } | null;
      if (r.status === 501) { setError("No language model is configured on this Studio — the controls below still set every part of the theme."); return; }
      if (!r.ok || !d || d.ok === false) { setError(d?.error ?? `The assistant could not answer (${r.status}).`); return; }
      if (!d.reply || !d.reply.actions.length) { setError(d?.reply?.reply ?? d?.message ?? "The assistant proposed no theme change."); return; }
      const out = applySurveyActions(s.def, d.reply.actions as never, { uxOnly: true });
      const lines = out.results.filter((x) => x.ok).map((x) => x.description);
      setProposal({ actions: d.reply.actions, reply: d.reply.reply, lines, errors: out.errors });
      if (out.valid) themePreviewStore.set(out.def.branding);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const apply = () => {
    if (!proposal) return;
    const out = applySurveyActions(s.def, proposal.actions as never, { uxOnly: true });
    if (!out.valid || !out.results.some((x) => x.ok)) { setError(out.errors.join(" ") || "Nothing to apply."); return; }
    s.labelNextEdit(`AI theme: ${text.trim().slice(0, 50) || (refs.length > 1 ? "from references" : "from an image")}`);
    s.replace(out.def);
    s.toast("Theme applied — every setting is below to adjust by hand. Undo with ⌘Z.");
    setProposal(null); setText(""); setRefs([]); setRefErrors([]);
    themePreviewStore.set(null);
  };
  React.useEffect(() => () => themePreviewStore.set(null), []);
  const micLabel = voice.state === "transcribing" ? "Transcribing…" : recording ? "Stop and transcribe" : "Describe the look by voice";
  return (
    <div className="theme-assistant" data-testid="theme-assistant">
      <div className="row" style={{ gap: 6, alignItems: "flex-start" }}>
        <textarea className="ta grow" rows={2} value={text} aria-label="Describe the look"
          placeholder={recording ? "Listening… press the microphone again when you have finished." : voice.state === "transcribing" ? "Transcribing…" : "Describe the look — “a premium dark theme”, “make it look like our website”, “use this image as the background” — type, or press the microphone"}
          onChange={(e) => setText(e.target.value)} data-testid="theme-assistant-input" />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="row" style={{ gap: 4 }}>
            <button type="button" className={`btn small${recording ? " primary" : ""}`} data-testid="theme-assistant-mic" data-state={voice.state}
              onClick={voice.toggle} disabled={!!busy || voice.state === "transcribing" || voice.available === false || s.readOnly}
              aria-pressed={recording} aria-label={micLabel}
              title={voice.available === false ? "No transcription provider is configured on this Studio" : recording ? "Stop — what you said is added to the text, to edit before sending" : "Speak — what you say is transcribed and added to the text (any language)"}>
              {voice.state === "transcribing" ? "…" : recording ? "■" : "🎤"}
            </button>
            {/* pause / resume, where the recorder has them (MediaRecorder.pause / resume); elsewhere stop and record again */}
            {recording && voice.canPause && (
              <button type="button" className="btn small" data-testid="theme-assistant-mic-pause" aria-pressed={voice.state === "paused"}
                aria-label={voice.state === "paused" ? "Resume recording" : "Pause recording"}
                onClick={voice.state === "paused" ? voice.resume : voice.pause}>
                {voice.state === "paused" ? "▶" : "❚❚"}
              </button>
            )}
          </div>
          <input ref={file} type="file" accept={THEME_REFERENCE_ACCEPT} multiple hidden data-testid="theme-assistant-file"
            onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; if (fs.length) void addFiles(fs); }} />
          <button type="button" className="btn small" onClick={() => file.current?.click()} disabled={!!busy || refs.length >= THEME_REFERENCE_MAX} data-testid="theme-assistant-image"
            title={`Up to ${THEME_REFERENCE_MAX} reference images — PNG, JPG or WebP, ${Math.round(THEME_REFERENCE_MAX_BYTES / 1024 / 1024)} MB each`}>Images…</button>
          <button type="button" className="btn small primary" onClick={() => void ask()} disabled={!!busy || reading || recording || voice.state === "transcribing" || (!text.trim() && !ready.length) || s.readOnly} data-testid="theme-assistant-ask">Design theme</button>
        </div>
      </div>
      {voice.state !== "idle" && (
        <p className="muted" style={{ fontSize: 12, margin: "4px 0" }} data-testid="theme-assistant-voice-status" aria-live="polite">
          {voice.state === "recording" ? "● Recording — press ■ to stop" : voice.state === "paused" ? "Paused — ▶ to continue, ■ to finish" : "Transcribing what you said…"}
        </p>
      )}
      {voice.error && <p className="muted" style={{ fontSize: 12.5, color: "var(--danger, #b91c1c)" }} role="alert" data-testid="theme-assistant-voice-error">⚠ {voice.error}</p>}
      {refs.length > 0 && (
        <ul className="row" style={{ gap: 8, marginTop: 6, flexWrap: "wrap", listStyle: "none", padding: 0 }} aria-label="Reference images" data-testid="theme-assistant-refs">
          {refs.map((r) => (
            <li key={r.id} className="row" style={{ gap: 6 }} data-testid="theme-assistant-image-chip" data-name={r.name} data-state={r.image ? "ready" : "reading"}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={r.image?.url ?? r.preview} alt={`Reference: ${r.name}`} style={{ width: 54, height: 36, objectFit: "cover", borderRadius: 4 }} />
              {r.image && <span className="row" style={{ gap: 3 }}>{r.image.dominant.slice(0, 5).map((c) => <span key={c} title={c} style={{ width: 14, height: 14, borderRadius: 3, background: c, border: "1px solid var(--border)" }} />)}</span>}
              <span className="muted" style={{ fontSize: 12 }}>{r.name} · {fmtSize(r.size)}{r.image ? ` · ${r.image.dark ? "dark" : "light"}${r.image.uploaded ? "" : " · kept inline (the asset library is not set up)"}` : " · reading…"}</span>
              <button type="button" className="btn small ghost" aria-label={`Remove ${r.name}`} data-testid="theme-assistant-ref-remove" onClick={() => removeRef(r.id)}>×</button>
            </li>
          ))}
        </ul>
      )}
      {refErrors.length > 0 && (
        <ul className="muted" style={{ fontSize: 12.5, color: "var(--danger, #b91c1c)", margin: "4px 0", paddingLeft: 16 }} role="alert" data-testid="theme-assistant-ref-errors">
          {refErrors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      {busy && <p className="muted" style={{ fontSize: 12 }}>{busy}</p>}
      {error && <p className="muted" style={{ fontSize: 12.5, color: "var(--danger, #b91c1c)" }} data-testid="theme-assistant-error">⚠ {error}</p>}
      {proposal && (
        <div className="theme-proposal" data-testid="theme-assistant-proposal">
          <p style={{ margin: "6px 0" }}>{proposal.reply}</p>
          <p className="muted" style={{ fontSize: 11.5, margin: "0 0 4px" }}>The preview beside this panel shows the proposed theme. Nothing is saved until you apply it.</p>
          <ul className="theme-lines" data-testid="theme-assistant-lines">{proposal.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          {proposal.errors.length > 0 && <ul className="theme-lines muted" data-testid="theme-assistant-refused">{proposal.errors.map((l, i) => <li key={i}>Not applied: {l}</li>)}</ul>}
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn small primary" onClick={apply} disabled={s.readOnly} data-testid="theme-assistant-apply">Apply to this survey</button>
            <button type="button" className="btn small" onClick={() => { setProposal(null); themePreviewStore.set(null); }} data-testid="theme-assistant-cancel">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
