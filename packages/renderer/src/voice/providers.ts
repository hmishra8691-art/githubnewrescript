/**
 * THE VOICE PROVIDER LAYER — text-to-speech and speech-to-text behind one
 * interface, so the survey engine never knows which vendor is speaking.
 *
 *     AI Voice Layer (speaker.ts, VoiceConsole)
 *           ↓
 *     TtsProvider / SttProvider
 *           ├── browser   (Web Speech API — ships with the browser, no key)
 *           └── …         (registered by an app: a cloud TTS/STT, a recorded-audio player)
 *
 * The browser provider is the default and the only one bundled here. A
 * different provider is a registration (`registerVoiceProvider`), not a
 * redesign: the speaker asks for voices, speaks segments, cancels; the
 * console starts listening and receives transcripts with a confidence. What
 * the survey does with those is the engine's business (aiConversation.ts).
 */

export interface VoiceInfo {
  id: string;
  name: string;
  /** BCP-47 */
  lang: string;
  /** a provider's own hints, when it has them */
  gender?: "female" | "male" | "neutral";
  ageStyle?: "young_adult" | "adult" | "mature_adult" | "elderly";
  character?: string;
  /** provider-local voices are available offline */
  local?: boolean;
}

export interface SpeakOptions {
  voiceId?: string;
  lang: string;
  rate: number;
  pitch: number;
  volume: number;
}

export interface TtsHandle { cancel(): void; done: Promise<void> }

export interface TtsProvider {
  readonly key: string;
  available(): boolean;
  voices(): Promise<VoiceInfo[]>;
  /** Speak one utterance; resolves when it ends or is cancelled. */
  speak(text: string, opts: SpeakOptions): TtsHandle;
  cancel(): void;
  /** true while anything is being spoken */
  speaking(): boolean;
  /** whether pitch is honoured by this provider */
  supportsPitch: boolean;
  /** whether SSML/emphasis markup is honoured */
  supportsSsml: boolean;
}

export interface SttResult { transcript: string; confidence: number; isFinal: boolean }
export interface SttSession { stop(): void; abort(): void }

export interface SttProvider {
  readonly key: string;
  available(): boolean;
  start(opts: { lang: string; continuous?: boolean; interim?: boolean }, onResult: (r: SttResult) => void, onEnd: (reason?: string) => void): SttSession;
}

const tts = new Map<string, TtsProvider>();
const stt = new Map<string, SttProvider>();

export function registerVoiceProvider(p: { tts?: TtsProvider; stt?: SttProvider }): void {
  if (p.tts) tts.set(p.tts.key, p.tts);
  if (p.stt) stt.set(p.stt.key, p.stt);
}
export function ttsProvider(key = "browser"): TtsProvider | null { return tts.get(key) ?? tts.get("browser") ?? null; }
export function sttProvider(key = "browser"): SttProvider | null { return stt.get(key) ?? stt.get("browser") ?? null; }

/* ------------------------------------------------------------ the browser */

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof (window as any).SpeechSynthesisUtterance === "function" ? window.speechSynthesis : null;
}

/** A guess at gender / age from a browser voice's name — browsers expose no metadata, only names like "Google UK English Female", "Samantha", "Daniel". */
function guessProfile(name: string): Pick<VoiceInfo, "gender" | "ageStyle"> {
  const n = name.toLowerCase();
  const female = /female|woman|samantha|karen|moira|tessa|fiona|victoria|zira|susan|hazel|heera|veena|lekha|kate|serena|allison|ava|nicky|joana|paulina|monica|amelie|anna|alice/.test(n);
  const male = /male|man\b|daniel|alex|fred|tom|arthur|george|oliver|rishi|ravi|david|mark|james|thomas|diego|jorge|xander|reed|rocko|eddy|aaron/.test(n) && !female;
  return { gender: female ? "female" : male ? "male" : "neutral", ageStyle: "adult" };
}

export const browserTts: TtsProvider = {
  key: "browser",
  supportsPitch: true,
  supportsSsml: false,
  available: () => !!synth(),
  async voices() {
    const s = synth();
    if (!s) return [];
    let list = s.getVoices();
    if (!list.length) {
      // Chrome loads voices asynchronously
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, 300); s.addEventListener?.("voiceschanged", () => { clearTimeout(t); resolve(); }, { once: true } as any); });
      list = s.getVoices();
    }
    return list.map((v) => ({ id: v.voiceURI || v.name, name: v.name, lang: v.lang, local: v.localService, ...guessProfile(v.name) }));
  },
  speak(text, opts) {
    const s = synth();
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => { resolveDone = r; });
    if (!s || !text.trim()) { resolveDone(); return { cancel() {}, done }; }
    const u = new (window as any).SpeechSynthesisUtterance(text) as SpeechSynthesisUtterance;
    u.lang = opts.lang;
    u.rate = Math.max(0.5, Math.min(2, opts.rate));
    u.pitch = Math.max(0, Math.min(2, opts.pitch));
    u.volume = Math.max(0, Math.min(1, opts.volume)); // never above the device's own level
    if (opts.voiceId) {
      const v = s.getVoices().find((x) => x.voiceURI === opts.voiceId || x.name === opts.voiceId);
      if (v) u.voice = v;
    }
    u.onend = () => resolveDone();
    u.onerror = () => resolveDone();
    s.speak(u);
    return { cancel() { s.cancel(); resolveDone(); }, done };
  },
  cancel() { synth()?.cancel(); },
  speaking() { return !!synth()?.speaking; },
};

export const browserStt: SttProvider = {
  key: "browser",
  available() {
    return typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  },
  start(opts, onResult, onEnd) {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const r = new Ctor();
    r.lang = opts.lang;
    r.continuous = !!opts.continuous;
    r.interimResults = opts.interim ?? true;
    r.maxAlternatives = 1;
    r.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const alt = res[0];
        onResult({ transcript: String(alt?.transcript ?? "").trim(), confidence: typeof alt?.confidence === "number" && alt.confidence > 0 ? alt.confidence : 0.8, isFinal: !!res.isFinal });
      }
    };
    r.onerror = (e: any) => onEnd(e?.error ?? "error");
    r.onend = () => onEnd();
    try { r.start(); } catch { onEnd("service-not-allowed"); }
    return { stop() { try { r.stop(); } catch { /* already stopped */ } }, abort() { try { r.abort(); } catch { /* already stopped */ } } };
  },
};

registerVoiceProvider({ tts: browserTts, stt: browserStt });

/* ----------------------------------------------------------- choose a voice */

/**
 * THE VOICE FOR THIS SURVEY: an explicit id if the provider has it; else the
 * best match for locale and profile; else the fallback id; else any voice for
 * the language; else the provider's default (undefined). The survey never
 * fails for want of a voice — it degrades to the nearest one.
 */
export function chooseVoice(voices: VoiceInfo[], want: { lang: string; voiceId?: string; fallbackVoiceId?: string; gender?: string; ageStyle?: string }): VoiceInfo | undefined {
  if (!voices.length) return undefined;
  const byId = (id?: string) => (id ? voices.find((v) => v.id === id || v.name === id) : undefined);
  const explicit = byId(want.voiceId);
  if (explicit) return explicit;
  const lang = want.lang.toLowerCase();
  const base = lang.split("-")[0];
  const exact = voices.filter((v) => v.lang.toLowerCase() === lang);
  const sameLang = voices.filter((v) => v.lang.toLowerCase().split("-")[0] === base);
  const pick = (pool: VoiceInfo[]) => {
    if (!pool.length) return undefined;
    const g = want.gender && want.gender !== "neutral" ? pool.filter((v) => v.gender === want.gender) : [];
    return (g.length ? g : pool).find((v) => v.local) ?? (g.length ? g : pool)[0];
  };
  return pick(exact) ?? byId(want.fallbackVoiceId) ?? pick(sameLang) ?? undefined;
}
