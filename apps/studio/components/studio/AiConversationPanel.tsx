"use client";
import React from "react";
import {
  AiConversation as AiConversationSchema,
  VOICE_GENDERS, VOICE_AGE_STYLES, VOICE_CHARACTERS, VOICE_PERSONALITIES, PROBE_STYLES,
  OPTION_READING_MODES, GRID_READING_MODES,
  type AiConversation, type SurveyDefinition, type Condition,
} from "@rescript/schema";
import { effectiveAiConversation, voiceOn, VOICE_PRESETS, applyVoicePreset, LOCALES, resolveVoiceLocale, lintAiConversation, type SpokenSegment } from "@rescript/engine";
import { speakSegments, ttsProvider, chooseVoice, type VoiceInfo } from "@rescript/renderer";
import { useStudio, uid } from "./store";
import { ConditionEditor, newConditionGroup } from "./ConditionBuilder";

/**
 * THE AI CONVERSATIONAL SURVEY — one section in Branding, replacing the old
 * Presentation section's four scattered switches (mode, read aloud, dictation,
 * voice language) with the one object the runtime reads:
 * `branding.aiConversation`.
 *
 * ## Simple and advanced
 *
 * Most studies need six decisions: is the interviewer on; text, voice or both;
 * standard, conversational or adaptive; adaptive follow-ups on or off; a
 * voice preset; a country / language. That is the simple view. Everything
 * else — the voice profile, dialect matching and language switching, what is
 * read and how large lists and grids are read, pauses and pacing,
 * pronunciations, clarification and confidence rules, transcripts, the
 * interviewer's guardrails, the research objective and programmer rules for
 * follow-ups — sits behind "Advanced", grouped as Interaction / Conversation /
 * Voice / AI, the same tree the runtime's configuration has.
 *
 * ## The older settings
 *
 * `layout.presentation` and `layout.voice` are still written, mirrored from
 * this object on every edit, so anything that reads them (older exports,
 * older test suites, a runtime not yet updated) sees the same survey. A survey
 * that has only those older fields is shown here through
 * `effectiveAiConversation`, which derives this object from them — the first
 * edit materialises it.
 *
 * ## Voices are styles, not people
 *
 * The profile controls describe HOW a voice sounds — gender presentation, an
 * age STYLE, a character style, a personality. None of them names a person, a
 * celebrity or a copyrighted character, and the runtime's provider layer only
 * ever picks among the voices the platform is licensed to use. "Youthful" is
 * a voice style suited to research with young people; it is not a claim about
 * who is speaking.
 */

const label = (s: string) => s.replace(/_/g, " ");

const SAMPLE: SpokenSegment[] = [
  { text: "This is how your survey will sound.", kind: "prompt", pauseMs: 600 },
  { text: "How satisfied are you with the service you received?", kind: "question", pauseMs: 800 },
  { text: "Very satisfied", kind: "option", pauseMs: 400 },
  { text: "Somewhat satisfied", kind: "option", pauseMs: 400 },
  { text: "Not satisfied", kind: "option", pauseMs: 0 },
];

/** Speak a sample with the survey's current voice — the "voice test panel". */
export function VoiceTestButton({ cfg, segments, testId = "ai-voice-test" }: { cfg: AiConversation; segments?: SpokenSegment[]; testId?: string }) {
  const [state, setState] = React.useState<"idle" | "speaking" | "unavailable">("idle");
  const run = React.useRef<{ cancel(): void } | null>(null);
  const [voices, setVoices] = React.useState<VoiceInfo[]>([]);
  const provider = ttsProvider(cfg.voice.provider);
  React.useEffect(() => { let alive = true; provider?.voices().then((v) => { if (alive) setVoices(v); }).catch(() => {}); return () => { alive = false; }; }, [provider]);
  React.useEffect(() => () => run.current?.cancel(), []);
  const lang = resolveVoiceLocale(cfg.voice, typeof navigator !== "undefined" ? navigator.language : null, null);
  const voice = chooseVoice(voices, { lang, voiceId: cfg.voice.profile.voiceId, fallbackVoiceId: cfg.voice.profile.fallbackVoiceId, gender: cfg.voice.profile.gender, ageStyle: cfg.voice.profile.ageStyle });
  const play = () => {
    if (!provider?.available()) { setState("unavailable"); return; }
    if (state === "speaking") { run.current?.cancel(); setState("idle"); return; }
    setState("speaking");
    const segs = (segments ?? SAMPLE).map((s) => ({ ...s, pauseMs: Math.min(s.pauseMs, 1200) }));
    const r = speakSegments(segs, { provider, lang, voiceId: voice?.id, rate: cfg.voice.audio.rate, pitch: cfg.voice.audio.pitch, volume: cfg.voice.audio.volume });
    run.current = r;
    r.done.then(() => { if (run.current === r) setState("idle"); });
  };
  return (
    <span className="row" style={{ gap: 6 }}>
      <button type="button" className="btn small" data-testid={testId} onClick={play} title={`Speaks a sample in ${lang}${voice ? ` with the voice "${voice.name}"` : ""}`}>
        {state === "speaking" ? "■ Stop" : "▶ Test voice"}
      </button>
      <span className="muted" style={{ fontSize: 12 }} data-testid={`${testId}-voice`}>
        {state === "unavailable" ? "speech synthesis is not available in this browser" : `${lang}${voice ? ` · ${voice.name}` : voices.length ? " · nearest available voice" : ""}`}
      </span>
    </span>
  );
}

function Num({ label: l, value, onChange, min, max, step = 1, width = 110, testId, title }: { label: string; value: number; onChange(n: number): void; min: number; max: number; step?: number; width?: number; testId?: string; title?: string }) {
  return (
    <label className="f" style={{ width }} title={title}><span>{l}</span>
      <input className="input" type="number" min={min} max={max} step={step} value={value} data-testid={testId}
        onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n))); }} />
    </label>
  );
}

function Check({ label: l, checked, onChange, testId, title }: { label: string; checked: boolean; onChange(v: boolean): void; testId?: string; title?: string }) {
  return (
    <label className="row" style={{ gap: 4, fontSize: 13, alignSelf: "end" }} title={title}>
      <input type="checkbox" checked={checked} data-testid={testId} onChange={(e) => onChange(e.target.checked)} /> {l}
    </label>
  );
}

function Sel<T extends string>({ label: l, value, options, onChange, width = 170, testId, title, names }: { label: string; value: T; options: readonly T[]; onChange(v: T): void; width?: number; testId?: string; title?: string; names?: Partial<Record<T, string>> }) {
  return (
    <label className="f" style={{ width }} title={title}><span>{l}</span>
      <select className="select" value={value} data-testid={testId} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => <option key={o} value={o}>{names?.[o] ?? label(o)}</option>)}
      </select>
    </label>
  );
}

/** term → said, editable */
export function PronunciationsEditor({ value, onChange, testId = "ai-pronunciations" }: { value: Record<string, string>; onChange(v: Record<string, string>): void; testId?: string }) {
  const entries = Object.entries(value);
  const [term, setTerm] = React.useState(""); const [said, setSaid] = React.useState("");
  return (
    <div data-testid={testId}>
      {entries.map(([t, s]) => (
        <div key={t} className="row" style={{ gap: 6, marginBottom: 4, fontSize: 13 }}>
          <code>{t}</code> <span className="muted">→</span>
          <input className="input" style={{ width: 180 }} value={s} onChange={(e) => onChange({ ...value, [t]: e.target.value })} />
          <button type="button" className="btn small" onClick={() => { const n = { ...value }; delete n[t]; onChange(n); }}>remove</button>
        </div>
      ))}
      <div className="row" style={{ gap: 6 }}>
        <input className="input" style={{ width: 150 }} placeholder="written (Miures)" value={term} data-testid={`${testId}-term`} onChange={(e) => setTerm(e.target.value)} />
        <input className="input" style={{ width: 180 }} placeholder="said (Mee-yoo-res)" value={said} data-testid={`${testId}-said`} onChange={(e) => setSaid(e.target.value)} />
        <button type="button" className="btn small" data-testid={`${testId}-add`} disabled={!term.trim() || !said.trim()}
          onClick={() => { onChange({ ...value, [term.trim()]: said.trim() }); setTerm(""); setSaid(""); }}>add</button>
      </div>
    </div>
  );
}

export function AiConversationSection() {
  const s = useStudio();
  const cfg = React.useMemo(() => effectiveAiConversation(s.def), [s.def]);
  const [advanced, setAdvanced] = React.useState(false);
  const lint = lintAiConversation(s.def);

  /** Edit the one object; the older layout fields follow it. */
  const setAi = (mutate: (c: AiConversation) => void) => s.update((d) => {
    const c = AiConversationSchema.parse(d.branding.aiConversation ?? effectiveAiConversation(d as SurveyDefinition));
    mutate(c);
    d.branding.aiConversation = c;
    d.branding.layout.presentation = c.enabled && c.conversation !== "standard" ? "conversational" : "pages";
    const von = c.enabled && c.interaction !== "text";
    d.branding.layout.voice = von
      ? { readAloud: c.voice.reading.question, dictation: c.voice.interaction.listen, ...(c.voice.locale.dialect && c.voice.locale.dialect !== "match" ? { lang: c.voice.locale.dialect } : {}) }
      : { readAloud: false, dictation: false };
  });

  const von = voiceOn(cfg);
  const country = LOCALES.find((l) => l.country === cfg.voice.locale.country);
  const languages = country?.languages ?? [];
  const dialects = (cfg.voice.locale.language && cfg.voice.locale.language !== "auto"
    ? LOCALES.flatMap((l) => l.languages.filter((x) => x.code === cfg.voice.locale.language).map((x) => ({ ...x, country: l.countryName })))
    : LOCALES.flatMap((l) => l.languages.map((x) => ({ ...x, country: l.countryName }))));
  const uniqueDialects = dialects.filter((d, i, arr) => arr.findIndex((x) => x.dialect === d.dialect) === i);

  return (
    <>
      <h3 className="sec" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        AI Conversational Survey
        <span className="grow" />
        <label className="row" style={{ gap: 4, fontSize: 12, fontWeight: 400 }}>
          <input type="checkbox" data-testid="ai-advanced" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} /> advanced
        </label>
      </h3>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        One interviewer for the whole survey — text, voice or both; standard, conversational or adaptive. The questions, pages,
        logic, quotas and exports do not change: the interviewer reads what the survey shows and stores what the survey stores.
      </div>

      <div className="row" style={{ flexWrap: "wrap", gap: 12 }} data-testid="ai-simple">
        <Check label="AI conversational survey on" checked={cfg.enabled} testId="ai-enabled"
          onChange={(v) => setAi((c) => { c.enabled = v; if (v && c.interaction === "text" && c.conversation === "standard") c.conversation = "conversational"; })} />
        <Sel label="Interaction mode" value={cfg.interaction} options={["text", "voice", "text_voice"] as const} testId="ai-interaction" width={190}
          names={{ text: "Text", voice: "Voice", text_voice: "Text + Voice" }}
          onChange={(v) => setAi((c) => { c.interaction = v; if (v !== "text") c.enabled = true; })} />
        <Sel label="Conversation behavior" value={cfg.conversation} options={["standard", "conversational", "adaptive"] as const} testId="presentation-mode" width={230}
          names={{ standard: "Standard — pages as programmed", conversational: "Conversational — one question at a time", adaptive: "Adaptive — conversational + AI follow-ups" }}
          onChange={(v) => setAi((c) => { c.conversation = v; if (v !== "standard") c.enabled = true; if (v === "adaptive") c.adaptive.enabled = true; })} />
        <Check label="adaptive follow-up" checked={cfg.adaptive.enabled} testId="ai-adaptive"
          title="The interviewer may ask a follow-up after an answer, within the limits under Advanced → AI. Off: no follow-ups beyond the probes programmed on questions."
          onChange={(v) => setAi((c) => { c.adaptive.enabled = v; })} />
        <Check label="AI probing" checked={cfg.adaptive.aiGenerated} testId="ai-probing"
          title="Follow-up wording written by the AI provider from the answer. Off: only follow-ups with a fixed wording are asked."
          onChange={(v) => setAi((c) => { c.adaptive.aiGenerated = v; })} />
      </div>

      {von && (
        <div className="row" style={{ flexWrap: "wrap", gap: 12, marginTop: 8 }} data-testid="ai-voice-simple">
          <label className="f" style={{ width: 230 }} title="A starting point for the voice — style and pacing, never an identity. Everything it sets can be changed under Advanced → Voice.">
            <span>Voice preset</span>
            <select className="select" data-testid="ai-voice-preset" value={cfg.voice.preset ?? ""}
              onChange={(e) => { const id = e.target.value; if (!id) return; setAi((c) => { c.voice = applyVoicePreset(c.voice, id); }); s.toast(`Voice preset "${VOICE_PRESETS.find((p) => p.id === id)?.name}" applied`); }}>
              <option value="">{cfg.voice.preset ? VOICE_PRESETS.find((p) => p.id === cfg.voice.preset)?.name ?? cfg.voice.preset : "Choose a preset…"}</option>
              {VOICE_PRESETS.map((p) => <option key={p.id} value={p.id} title={p.description}>{p.name}</option>)}
            </select>
          </label>
          <label className="f" style={{ width: 170 }}><span>Country</span>
            <select className="select" data-testid="ai-country" value={cfg.voice.locale.country ?? ""}
              onChange={(e) => setAi((c) => { c.voice.locale.country = e.target.value || undefined; const entry = LOCALES.find((l) => l.country === e.target.value); if (entry && !entry.languages.some((x) => x.code === c.voice.locale.language)) { c.voice.locale.language = entry.languages[0].code; c.voice.locale.dialect = entry.languages[0].dialect; } })}>
              <option value="">— any —</option>
              {LOCALES.map((l) => <option key={l.country} value={l.country}>{l.countryName}</option>)}
            </select></label>
          <label className="f" style={{ width: 150 }}><span>Language</span>
            <select className="select" data-testid="ai-language" value={cfg.voice.locale.language}
              onChange={(e) => setAi((c) => { c.voice.locale.language = e.target.value; const hit = LOCALES.find((l) => l.country === c.voice.locale.country)?.languages.find((x) => x.code === e.target.value); c.voice.locale.dialect = hit ? hit.dialect : "match"; })}>
              <option value="auto">auto — the respondent's</option>
              {(languages.length ? languages : LOCALES.flatMap((l) => l.languages)).filter((x, i, arr) => arr.findIndex((y) => y.code === x.code) === i).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
            </select></label>
          <label className="f" style={{ width: 210 }} title="Match Respondent Locale follows the respondent's browser when it names a region reliably; otherwise the survey's own country/language is used — never a guess.">
            <span>Dialect / accent</span>
            <select className="select" data-testid="ai-dialect" value={cfg.voice.locale.dialect}
              onChange={(e) => setAi((c) => { c.voice.locale.dialect = e.target.value; if (e.target.value !== "match") c.voice.locale.language = e.target.value.split("-")[0]; })}>
              <option value="match">Match respondent locale</option>
              {uniqueDialects.map((d) => <option key={d.dialect} value={d.dialect}>{d.dialectName} ({d.dialect})</option>)}
              {cfg.voice.locale.dialect !== "match" && !uniqueDialects.some((d) => d.dialect === cfg.voice.locale.dialect) && <option value={cfg.voice.locale.dialect}>{cfg.voice.locale.dialect}</option>}
            </select></label>
          <VoiceTestButton cfg={cfg} />
        </div>
      )}

      {lint.map((m, i) => <div key={i} className="chip warn" data-testid="ai-lint" style={{ marginTop: 6 }}>{m}</div>)}

      {advanced && (
        <div data-testid="ai-advanced-panel" style={{ marginTop: 10 }}>
          {/* ------------------------------------------------ Interaction */}
          <div className="card" style={{ padding: 10, marginBottom: 8 }}>
            <div className="flabel" style={{ marginBottom: 6 }}>Interaction</div>
            <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
              <Check label="take spoken answers (microphone)" checked={cfg.voice.interaction.listen} testId="voice-dictation"
                title="Off: the voice reads the survey and the respondent answers on screen."
                onChange={(v) => setAi((c) => { c.voice.interaction.listen = v; })} />
              <Check label="voice navigation commands" checked={cfg.voice.interaction.navigationCommands} testId="ai-nav-commands"
                title="“next”, “back”, “repeat”, “skip”, “read the options”, “select Apple”, “remove Samsung”, “none”, “other”, “help”"
                onChange={(v) => setAi((c) => { c.voice.interaction.navigationCommands = v; })} />
              <Check label="repeat on request" checked={cfg.voice.interaction.repeat} onChange={(v) => setAi((c) => { c.voice.interaction.repeat = v; })} />
              <Check label="clarification on request" checked={cfg.voice.interaction.clarification} testId="ai-clarification" onChange={(v) => setAi((c) => { c.voice.interaction.clarification = v; })} />
              <Num label="Confidence threshold" value={cfg.voice.interaction.confidenceThreshold} min={0} max={1} step={0.05} testId="ai-confidence"
                title="Below this recognition confidence the answer is read back and confirmed; it is never stored silently."
                onChange={(n) => setAi((c) => { c.voice.interaction.confidenceThreshold = n; })} />
              <Check label="clarify ambiguous answers" checked={cfg.voice.interaction.clarifyAmbiguous} title="“Apple, I think” → “Did you mean Apple?”" onChange={(v) => setAi((c) => { c.voice.interaction.clarifyAmbiguous = v; })} />
              <Check label="confirm multi-select changes" checked={cfg.voice.interaction.confirmMultiSelect} testId="ai-confirm-multi" onChange={(v) => setAi((c) => { c.voice.interaction.confirmMultiSelect = v; })} />
              <Sel label="Transcripts" value={cfg.voice.interaction.transcript} options={["store", "dont_store"] as const} testId="ai-transcript" width={200}
                names={{ store: "store beside the answer", dont_store: "don't store" }}
                title="Stored: what was said (original) exports as VAR_VOICE_TRANSCRIPT beside the normalised answer, with confidence, repeats and clarifications. The answer itself is always the survey value."
                onChange={(v) => setAi((c) => { c.voice.interaction.transcript = v; })} />
              <Check label="captions" checked={cfg.voice.interaction.captions} testId="ai-captions" title="What the voice says is shown as it is said, for accessibility." onChange={(v) => setAi((c) => { c.voice.interaction.captions = v; })} />
            </div>
          </div>

          {/* ------------------------------------------------ Conversation */}
          <div className="card" style={{ padding: 10, marginBottom: 8 }}>
            <div className="flabel" style={{ marginBottom: 6 }}>Conversation</div>
            <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
              <Sel label="Interviewer style" value={cfg.interviewer.style} options={PROBE_STYLES} testId="ai-interviewer-style" width={150}
                onChange={(v) => setAi((c) => { c.interviewer.style = v; })} />
              <Check label="acknowledge answers (“Thank you.”)" checked={cfg.interviewer.acknowledge} testId="ai-acknowledge"
                title="A brief, neutral acknowledgement before the next question in conversational modes — never praise, never judgement."
                onChange={(v) => setAi((c) => { c.interviewer.acknowledge = v; })} />
              <Check label="avoid leading language" checked={cfg.interviewer.avoidLeading} onChange={(v) => setAi((c) => { c.interviewer.avoidLeading = v; })} />
              <Check label="avoid suggestive language" checked={cfg.interviewer.avoidSuggestive} onChange={(v) => setAi((c) => { c.interviewer.avoidSuggestive = v; })} />
              <Check label="avoid approval / disapproval" checked={cfg.interviewer.avoidApproval} onChange={(v) => setAi((c) => { c.interviewer.avoidApproval = v; })} />
              <Check label="avoid persuasive language" checked={cfg.interviewer.avoidPersuasive} onChange={(v) => setAi((c) => { c.interviewer.avoidPersuasive = v; })} />
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 12, marginTop: 8 }}>
              <Check label="AI may propose spoken-friendly wording" checked={cfg.rephrase.enabled} testId="ai-rephrase"
                title="Per question, under Properties → AI conversation: an AI version of the question text for the ear. The displayed text never changes."
                onChange={(v) => setAi((c) => { c.rephrase.enabled = v; })} />
              <Check label="programmer approval required" checked={cfg.rephrase.requireApproval} onChange={(v) => setAi((c) => { c.rephrase.requireApproval = v; })} />
              <Sel label="Max variation" value={cfg.rephrase.maxVariation} options={["low", "medium", "high"] as const} width={130} onChange={(v) => setAi((c) => { c.rephrase.maxVariation = v; })} />
            </div>
          </div>

          {/* ------------------------------------------------------- Voice */}
          <div className="card" style={{ padding: 10, marginBottom: 8 }}>
            <div className="flabel" style={{ marginBottom: 6 }}>Voice</div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Styles, not identities: these describe how the voice sounds. The platform does not imitate real people, celebrities or copyrighted characters.
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
              <Sel label="Provider" value={cfg.voice.provider} options={["browser"] as const} width={120} names={{ browser: "browser (built in)" }} onChange={(v) => setAi((c) => { c.voice.provider = v; })} />
              <Sel label="Gender presentation" value={cfg.voice.profile.gender} options={VOICE_GENDERS} testId="ai-gender" width={150} onChange={(v) => setAi((c) => { c.voice.profile.gender = v; })} />
              <Sel label="Age style" value={cfg.voice.profile.ageStyle} options={VOICE_AGE_STYLES} testId="ai-age" width={150}
                names={{ young_adult: "youthful", adult: "adult", mature_adult: "mature", elderly: "elder" }} onChange={(v) => setAi((c) => { c.voice.profile.ageStyle = v; })} />
              <label className="f" style={{ width: 190 }}><span>Character voice</span>
                <select className="select" data-testid="ai-character" value={cfg.voice.profile.character ?? ""} onChange={(e) => setAi((c) => { c.voice.profile.character = (e.target.value || undefined) as never; })}>
                  <option value="">— none —</option>
                  {VOICE_CHARACTERS.map((x) => <option key={x} value={x}>{label(x)}</option>)}
                </select></label>
              <Sel label="Personality" value={cfg.voice.profile.personality} options={VOICE_PERSONALITIES} testId="ai-personality" width={150} onChange={(v) => setAi((c) => { c.voice.profile.personality = v; })} />
              <label className="f" style={{ width: 220 }}><span>Custom personality note</span>
                <input className="input" value={cfg.voice.profile.customPersonality ?? ""} placeholder="e.g. patient, unhurried" onChange={(e) => setAi((c) => { c.voice.profile.customPersonality = e.target.value || undefined; })} /></label>
              <label className="f" style={{ width: 170 }} title="A provider voice id or name; blank = the nearest voice for the locale and profile."><span>Voice id</span>
                <input className="input mono" data-testid="ai-voice-id" value={cfg.voice.profile.voiceId ?? ""} onChange={(e) => setAi((c) => { c.voice.profile.voiceId = e.target.value || undefined; })} /></label>
              <label className="f" style={{ width: 170 }} title="Used when the preferred voice is not available on the respondent's device."><span>Fallback voice id</span>
                <input className="input mono" value={cfg.voice.profile.fallbackVoiceId ?? ""} onChange={(e) => setAi((c) => { c.voice.profile.fallbackVoiceId = e.target.value || undefined; })} /></label>
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 12, marginTop: 8 }}>
              <label className="f" style={{ width: 160 }} title="Any BCP-47 tag (en-IN, en-GB, hi-IN…); overrides the dialect choice above."><span>Dialect tag (BCP-47)</span>
                <input className="input mono" data-testid="voice-lang" value={cfg.voice.locale.dialect === "match" ? "" : cfg.voice.locale.dialect} placeholder="match respondent"
                  onChange={(e) => setAi((c) => { const v = e.target.value.trim(); c.voice.locale.dialect = v || "match"; if (v) c.voice.locale.language = v.split("-")[0]; })} /></label>
              <label className="f" style={{ width: 150 }}><span>Secondary language</span>
                <input className="input mono" data-testid="ai-secondary-language" value={cfg.voice.locale.secondaryLanguage ?? ""} placeholder="e.g. hi"
                  onChange={(e) => setAi((c) => { c.voice.locale.secondaryLanguage = e.target.value.trim() || undefined; })} /></label>
              <Sel label="Language switching" value={cfg.voice.locale.switching} options={["single", "auto", "respondent"] as const} testId="ai-switching" width={230}
                names={{ single: "keep one language", auto: "auto-switch to the respondent's", respondent: "respondent may change" }}
                title="The survey's logic and variables are the same in every language; only the voice changes."
                onChange={(v) => setAi((c) => { c.voice.locale.switching = v; })} />
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 12, marginTop: 8 }}>
              <Num label="Speech rate" value={cfg.voice.audio.rate} min={0.5} max={2} step={0.05} testId="ai-rate" onChange={(n) => setAi((c) => { c.voice.audio.rate = n; })} />
              <Num label="Pitch" value={cfg.voice.audio.pitch} min={0} max={2} step={0.1} testId="ai-pitch" onChange={(n) => setAi((c) => { c.voice.audio.pitch = n; })} />
              <Num label="Volume (0–1)" value={cfg.voice.audio.volume} min={0} max={1} step={0.05} testId="ai-volume" title="Never amplified beyond the device's own level." onChange={(n) => setAi((c) => { c.voice.audio.volume = n; })} />
              <Sel label="Emphasis" value={cfg.voice.audio.emphasis} options={["none", "light", "moderate"] as const} width={120} onChange={(v) => setAi((c) => { c.voice.audio.emphasis = v; })} />
              <VoiceTestButton cfg={cfg} testId="ai-voice-test-advanced" />
            </div>
            <div className="flabel" style={{ margin: "10px 0 4px" }}>Pauses (ms)</div>
            <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
              <Num label="After question" value={cfg.voice.pauses.afterQuestionMs} min={0} max={5000} step={100} testId="ai-pause-question" onChange={(n) => setAi((c) => { c.voice.pauses.afterQuestionMs = n; })} />
              <Num label="Before options" value={cfg.voice.pauses.beforeOptionsMs} min={0} max={5000} step={100} onChange={(n) => setAi((c) => { c.voice.pauses.beforeOptionsMs = n; })} />
              <Num label="Between options" value={cfg.voice.pauses.betweenOptionsMs} min={0} max={5000} step={100} testId="ai-pause-options" onChange={(n) => setAi((c) => { c.voice.pauses.betweenOptionsMs = n; })} />
              <Num label="After answer" value={cfg.voice.pauses.afterAnswerMs} min={0} max={5000} step={100} onChange={(n) => setAi((c) => { c.voice.pauses.afterAnswerMs = n; })} />
              <Num label="Between rows" value={cfg.voice.pauses.betweenRowsMs} min={0} max={5000} step={100} onChange={(n) => setAi((c) => { c.voice.pauses.betweenRowsMs = n; })} />
              <Num label="Between columns" value={cfg.voice.pauses.betweenColumnsMs} min={0} max={5000} step={100} onChange={(n) => setAi((c) => { c.voice.pauses.betweenColumnsMs = n; })} />
            </div>
            <div className="flabel" style={{ margin: "10px 0 4px" }}>What is read</div>
            <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
              <Check label="question text" checked={cfg.voice.reading.question} testId="voice-read-aloud" onChange={(v) => setAi((c) => { c.voice.reading.question = v; })} />
              <Check label="answer options" checked={cfg.voice.reading.options} testId="ai-read-options" onChange={(v) => setAi((c) => { c.voice.reading.options = v; })} />
              <Check label="instructions" checked={cfg.voice.reading.instructions} onChange={(v) => setAi((c) => { c.voice.reading.instructions = v; })} />
              <Check label="validation errors" checked={cfg.voice.reading.validationErrors} onChange={(v) => setAi((c) => { c.voice.reading.validationErrors = v; })} />
              <Check label="help text" checked={cfg.voice.reading.helpText} onChange={(v) => setAi((c) => { c.voice.reading.helpText = v; })} />
              <Check label="piped values" checked={cfg.voice.reading.piped} title="Piped text is always resolved before it is spoken; off hides nothing — it is informational for reviewers." onChange={(v) => setAi((c) => { c.voice.reading.piped = v; })} />
              <Check label="calculated values" checked={cfg.voice.reading.calculated} onChange={(v) => setAi((c) => { c.voice.reading.calculated = v; })} />
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 12, marginTop: 8 }}>
              <Sel label="Option reading" value={cfg.voice.reading.optionMode} options={OPTION_READING_MODES} testId="ai-option-mode" width={200}
                names={{ all: "read all, one by one", first_n: "read the first N", grouped: "grouped, with pauses", on_request: "only on request", none: "don't read options" }}
                onChange={(v) => setAi((c) => { c.voice.reading.optionMode = v; })} />
              {cfg.voice.reading.optionMode === "first_n" && <Num label="First N" value={cfg.voice.reading.firstN} min={1} max={50} testId="ai-first-n" onChange={(n) => setAi((c) => { c.voice.reading.firstN = n; })} />}
              {cfg.voice.reading.optionMode === "grouped" && <Num label="Group size" value={cfg.voice.reading.groupSize} min={2} max={20} onChange={(n) => setAi((c) => { c.voice.reading.groupSize = n; })} />}
              <Check label="read “Other”" checked={cfg.voice.reading.speakOther} onChange={(v) => setAi((c) => { c.voice.reading.speakOther = v; })} />
              <Check label="read “None”" checked={cfg.voice.reading.speakNone} onChange={(v) => setAi((c) => { c.voice.reading.speakNone = v; })} />
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 12, marginTop: 8 }}>
              <Sel label="Grid reading" value={cfg.voice.reading.gridMode} options={GRID_READING_MODES} testId="ai-grid-mode" width={230}
                names={{ question_first: "question, rows, then the columns once", row_by_row: "each row with its columns", respondent_driven: "respondent chooses the row" }}
                onChange={(v) => setAi((c) => { c.voice.reading.gridMode = v; })} />
              <Check label="read rows" checked={cfg.voice.reading.gridRows} onChange={(v) => setAi((c) => { c.voice.reading.gridRows = v; })} />
              <Check label="read columns" checked={cfg.voice.reading.gridColumns} onChange={(v) => setAi((c) => { c.voice.reading.gridColumns = v; })} />
              <Check label="respondent may choose a row" checked={cfg.voice.reading.allowChooseRow} onChange={(v) => setAi((c) => { c.voice.reading.allowChooseRow = v; })} />
            </div>
            <div className="flabel" style={{ margin: "10px 0 4px" }}>Pronunciations (survey-wide)</div>
            <PronunciationsEditor value={cfg.voice.pronunciations} onChange={(v) => setAi((c) => { c.voice.pronunciations = v; })} />
          </div>

          {/* ---------------------------------------------------------- AI */}
          <div className="card" style={{ padding: 10, marginBottom: 8 }}>
            <div className="flabel" style={{ marginBottom: 6 }}>AI — adaptive follow-ups and guardrails</div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Follow-ups are asked AFTER the page is valid and never change the programmed flow: display and skip logic, masking, auto punch,
              validation, list fill, loops, piping, calculations and quotas stay authoritative. A question&apos;s own Follow-up probe (Properties) wins over these defaults.
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
              <Num label="Min follow-ups" value={cfg.adaptive.minFollowUps} min={0} max={5} testId="ai-min-followups" onChange={(n) => setAi((c) => { c.adaptive.minFollowUps = n; })} />
              <Num label="Max follow-ups" value={cfg.adaptive.maxFollowUps} min={0} max={5} testId="ai-max-followups" onChange={(n) => setAi((c) => { c.adaptive.maxFollowUps = n; })} />
              <Num label="Max depth" value={cfg.adaptive.maxDepth} min={1} max={5} testId="ai-max-depth" title="A ceiling no rule can exceed." onChange={(n) => setAi((c) => { c.adaptive.maxDepth = n; })} />
              <Sel label="Probe style" value={cfg.adaptive.probeStyle} options={PROBE_STYLES} width={140} onChange={(v) => setAi((c) => { c.adaptive.probeStyle = v; })} />
              <Sel label="Applies to" value={cfg.adaptive.applyTo} options={["open_ends", "all"] as const} testId="ai-apply-to" width={220}
                names={{ open_ends: "open ends only", all: "open ends and closed questions" }} onChange={(v) => setAi((c) => { c.adaptive.applyTo = v; })} />
              <Check label="stay within the research objective" checked={cfg.adaptive.stayWithinObjective} testId="ai-stay-objective" onChange={(v) => setAi((c) => { c.adaptive.stayWithinObjective = v; })} />
            </div>
            <label className="f" style={{ marginTop: 8 }}><span>Research objective</span>
              <textarea className="ta" style={{ minHeight: 48 }} data-testid="ai-objective" value={cfg.adaptive.researchObjective ?? ""}
                placeholder="What this study needs to learn — the follow-ups stay within it."
                onChange={(e) => setAi((c) => { c.adaptive.researchObjective = e.target.value || undefined; })} /></label>
            <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
              <label className="f grow"><span>Allowed topics (comma-separated)</span>
                <input className="input" data-testid="ai-allowed" value={cfg.adaptive.allowedTopics.join(", ")}
                  onChange={(e) => setAi((c) => { c.adaptive.allowedTopics = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); })} /></label>
              <label className="f grow"><span>Restricted topics (never asked about)</span>
                <input className="input" data-testid="ai-restricted" value={cfg.adaptive.restrictedTopics.join(", ")}
                  onChange={(e) => setAi((c) => { c.adaptive.restrictedTopics = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); })} /></label>
            </div>
            <div className="flabel" style={{ margin: "10px 0 4px" }}>Programmer rules — how many follow-ups when…</div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              The first rule whose condition holds sets the maximum for that question (IF Q10 = Dissatisfied THEN allow up to 2). The Universal Logic Engine evaluates them against the whole response.
            </div>
            {cfg.adaptive.rules.map((rule, i) => (
              <div key={rule.id ?? i} className="logic-rule" data-testid="ai-rule" style={{ marginBottom: 8 }}>
                <div className="row" style={{ gap: 8, marginBottom: 4 }}>
                  <div className="logic-if">IF</div>
                  <input className="input" style={{ width: 200 }} placeholder="label (optional)" value={rule.label ?? ""} data-testid="ai-rule-label"
                    onChange={(e) => setAi((c) => { c.adaptive.rules[i].label = e.target.value || undefined; })} />
                  <span className="grow" />
                  <span style={{ fontSize: 13 }}>THEN allow up to</span>
                  <input className="input" type="number" min={0} max={5} style={{ width: 60 }} value={rule.maxFollowUps} data-testid="ai-rule-max"
                    onChange={(e) => setAi((c) => { c.adaptive.rules[i].maxFollowUps = Math.min(5, Math.max(0, Number(e.target.value) || 0)); })} />
                  <button type="button" className="btn small" onClick={() => setAi((c) => { c.adaptive.rules.splice(i, 1); })}>remove</button>
                </div>
                <ConditionEditor value={rule.when as Condition} onChange={(when) => setAi((c) => { c.adaptive.rules[i].when = when; })} />
              </div>
            ))}
            <button type="button" className="btn small" data-testid="ai-rule-add"
              onClick={() => setAi((c) => { c.adaptive.rules.push({ id: uid("air"), when: newConditionGroup(), maxFollowUps: Math.min(5, c.adaptive.maxFollowUps + 1) }); })}>+ rule</button>
          </div>

          <div className="muted" style={{ fontSize: 12 }}>
            <strong>Brand profiles:</strong> the voice and interviewer settings are part of the survey&apos;s branding, so &quot;Save as workspace theme&quot; (above) keeps them with the colours and fonts,
            and applying a theme applies its voice. <strong>JSON:</strong> <code>branding.aiConversation</code> — versioned with the survey like everything else.
          </div>
        </div>
      )}
    </>
  );
}
