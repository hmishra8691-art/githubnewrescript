/**
 * WHEN HAS THE PARTICIPANT FINISHED? (2026-11-08 — natural turn-taking for AI interviews)
 *
 * ROOT CAUSE this answers: the hands-free voice interview ended the participant's turn after a FIXED 0.8 s of
 * silence (the voice-activity detector's hang-over) and sent it to the moderator at once — so a breath, a
 * "hmm, let me think…", or a pause between two sentences was taken as a finished answer and the AI cut in.
 *
 * Now a pause is only a PAUSE. The page keeps segmenting speech at short pauses (so each piece is transcribed
 * while the participant is still talking), but the pieces are held and joined into ONE answer; whether the
 * answer is finished is decided here, from what was actually said, and — when the words alone cannot tell —
 * by the model (`listenRequest` in aiModerator.ts, a tiny metered call). The decision combines:
 *
 *   speech activity     the detector's start / end of speech (a new start cancels any pending decision)
 *   adaptive silence    how long a silence must last before the answer is taken as finished depends on what
 *                       came before it: a "that's all" ends it at once; a trailing "and…", "because…",
 *                       "matlab…" or a thinking filler waits much longer; a complete, rich answer waits a
 *                       little; a short answer to an open question waits and asks the model
 *   context             the question that was asked (an open question expects more than a yes/no one), how
 *                       many pieces the answer already has, the study's patience setting
 *   the model           consulted only when ambiguous; it can extend the wait ("still talking") or shorten it
 *
 * Multilingual: the signals below cover the 20 built-in interview languages and their common code-mixed forms
 * (Hinglish, Spanglish…), and the model reads any language. Nothing here is a timer alone, and nothing is a
 * keyword alone: a keyword only changes how long a SILENCE must be.
 */

export type TurnPatience = "quick" | "balanced" | "patient";
export type TurnSignal = "done" | "thinking" | "incomplete" | "complete" | "short" | "empty";

export interface TurnTakingInput {
  /** everything the participant has said for this answer so far (the pieces joined) */
  answer: string;
  /** the question the moderator asked */
  question?: string;
  language?: string;
  /** how many speech pieces the answer has */
  pieces?: number;
  patience?: TurnPatience;
}
export interface TurnTakingDecision {
  /** commit = send the answer now; wait = keep listening for `waitMs` of silence first */
  action: "commit" | "wait";
  /** silence (from the end of the last speech) to wait before committing */
  waitMs: number;
  /** ask the model whether the answer is finished while waiting */
  consultAi: boolean;
  signal: TurnSignal;
  reason: string;
}

const PATIENCE: Record<TurnPatience, number> = { quick: 0.7, balanced: 1, patient: 1.5 };
/** never hold a silence longer than this: a respondent who stopped is not left waiting */
export const MAX_HOLD_MS = 15_000;

const words = (s: string) => (String(s ?? "").match(/[\p{L}\p{N}]+/gu) ?? []);
const lower = (s: string) => String(s ?? "").toLowerCase().normalize("NFC").replace(/\s+/g, " ").trim();

/*
 * "I'm done / that's all / next question / nothing more to add" — in the built-in languages and their common
 * romanised / code-mixed forms. Matched against the END of the answer (the last few words), so "the price, and
 * that's all" counts and "that's all I could think of at first, but actually…" does not.
 */
const DONE: RegExp[] = [
  /* English */
  /\b(?:that'?s (?:all|it|about it|everything)|that is (?:all|it)|i'?m (?:done|finished)|i am (?:done|finished)|nothing (?:else|more)(?: to (?:add|say))?|no(?:thing)?,? that'?s (?:all|it)|(?:you can|we can|let'?s) move on|move on|next(?: question)?|what'?s next|i (?:don'?t|do not) have anything (?:else|more)(?: to add)?|i have nothing (?:else|more)(?: to add)?|that'?s about it|that covers it|no more|done)[.!?]*$/,
  /* Hindi (Devanagari) and Hinglish */
  /(?:बस(?: इतना(?: ही)?)?(?: है)?|इतना ही|और कुछ नहीं|कुछ और नहीं|हो गया|आगे बढ़(?:िए|ो|ें|ते हैं)|अगला(?: सवाल)?|बस यही|इतना काफी है)[।.!?]*$/,
  /\b(?:bas(?: itna(?: hi)?)?(?: hai)?|itna hi|aur kuch nahi|kuch aur nahi|ho gaya|aage badho|aage badhiye|next karo|agla sawal|bas yahi)[.!?]*$/,
  /* Marathi, Bengali, Gujarati, Punjabi, Tamil, Telugu, Kannada, Malayalam */
  /(?:एवढंच|बस एवढं|झालं|पुढे चला|आणखी काही नाही|এইটুকুই|আর কিছু নেই|শেষ|পরের প্রশ্ন|બસ આટલું|બીજું કંઈ નહીં|આગળ વધો|ਬੱਸ ਇੰਨਾ ਹੀ|ਹੋਰ ਕੁਝ ਨਹੀਂ|ਅੱਗੇ ਚੱਲੋ|அவ்வளவுதான்|வேறு ஒன்றுமில்லை|அடுத்த கேள்வி|అంతే|ఇంకేమీ లేదు|తర్వాతి ప్రశ్న|ಅಷ್ಟೇ|ಬೇರೆ ಏನೂ ಇಲ್ಲ|ಮುಂದಿನ ಪ್ರಶ್ನೆ|ഇത്രയേ ഉള്ളൂ|വേറൊന്നുമില്ല|അടുത്ത ചോദ്യം)[।.!?]*$/,
  /* Urdu, Arabic */
  /(?:بس(?: اتنا ہی)?|اور کچھ نہیں|آگے بڑھیں|اگلا سوال|هذا كل شيء|هذا كل ما لدي|لا شيء آخر|انتهيت|السؤال التالي)[۔.!?؟]*$/,
  /* Spanish, Portuguese, French, German, Indonesian */
  /\b(?:eso es todo|es todo|nada más|ya está|he terminado|terminé|siguiente(?: pregunta)?|podemos seguir|é isso|é só isso|só isso|nada mais|terminei|próxima(?: pergunta)?|pode seguir|c'?est tout|rien d'?autre|j'?ai fini|question suivante|on peut passer|das (?:ist|war'?s) (?:alles|es)|nichts weiter|ich bin fertig|nächste frage|weiter|itu saja|sudah|tidak ada lagi|selesai|pertanyaan berikutnya|lanjut)[.!?]*$/,
  /* Japanese, Chinese, Korean */
  /(?:以上です|以上|それだけです|それだけ|特にありません|次の質問|次へ|就这些|就这样|没有了|说完了|下一个问题|下一题|이상입니다|이게 다예요|그게 다예요|더 없어요|다음 질문)[。.!?！？]*$/,
];
/* "um… / let me think / good question" — the participant is thinking, not finished */
const THINKING: RegExp[] = [
  /\b(?:um+|uh+|er+|erm|hmm+|mm+|well|let me (?:think|see)|give me a (?:second|moment|sec)|good question|how (?:do|should) i (?:put|say) (?:it|this)|i mean|you know)[.,…\s]*$/,
  /(?:सोचने दो|एक मिनट|रुकिए|हम्म|मतलब)[।.,…\s]*$|\b(?:sochne do|ek minute|ruko|hmm+|matlab)[.,…\s]*$/,
  /\b(?:eh+|este|pues|déjame pensar|a ver|bueno|euh+|ben|alors|laisse-moi réfléchir|äh+|ähm+|also|lass mich (?:überlegen|nachdenken)|deixa eu pensar|tipo|hmm+|eee+|sebentar|biar saya pikir)[.,…\s]*$/,
  /(?:えーと|えっと|うーん|あの|嗯+|那个|让我想想|음+|어+|글쎄요)[、。.,…\s]*$/,
];
/* a sentence that stops on a connector or an article has more coming */
const TRAILING: RegExp[] = [
  /\b(?:and|but|so|because|cause|or|then|also|which|that|who|where|when|if|like|with|to|of|for|the|a|an|my|our|is|was|were|are|actually|basically|especially|plus)[,…\s]*$/,
  /(?:और|लेकिन|पर|क्योंकि|तो|या|कि|जो|जैसे|फिर|भी)[,…\s]*$|\b(?:aur|lekin|par|kyunki|kyonki|toh|to|ya|ki|jo|jaise|phir|bhi)[,…\s]*$/,
  /\b(?:y|pero|porque|entonces|o|que|como|cuando|el|la|los|las|un|una|e|mas|então|quando|o|os|as|um|uma|et|mais|parce que|donc|ou|quand|le|les|une|und|aber|weil|oder|dass|wenn|der|die|das|ein|eine|dan|tapi|karena|jadi|atau|yang|kalau)[,…\s]*$/,
  /[,，、،;:\-–—…]\s*$|\.\.\.\s*$/,
];

/* JavaScript's \b only knows ASCII letters: "é isso", "ça", "über" need a Unicode word boundary */
const unicode = (r: RegExp) => new RegExp(r.source.replace(/\\b/g, "(?<![\\p{L}\\p{N}])"), "u");
const DONE_U = DONE.map(unicode), THINKING_U = THINKING.map(unicode), TRAILING_U = TRAILING.map(unicode);
const matches = (list: RegExp[], text: string) => list.some((r) => r.test(text));
/** the last few words, where a done / thinking / trailing signal lives */
const tail = (text: string, n = 9) => { const t = lower(text); const parts = t.split(" "); return parts.slice(-n).join(" "); };

/** the participant said, in any of the built-in languages, that they have nothing more to add on this question */
export function signalsDone(text: string): boolean {
  const t = tail(text);
  return !!t && matches(DONE_U, t);
}
/** the answer ends on a thinking filler ("hmm, let me think") */
export function signalsThinking(text: string): boolean { const t = tail(text, 6); return !!t && matches(THINKING_U, t); }
/** the answer stops mid-sentence (a connector, an article, a comma, an ellipsis) */
export function endsUnfinished(text: string): boolean { const t = tail(text, 4); return !!t && matches(TRAILING_U, t); }

/** a yes/no or factual question expects a short answer; an open one ("why", "tell me about", "how") expects more */
export function expectsOpenAnswer(question: string | undefined): boolean {
  const q = lower(question ?? "");
  if (!q) return true;
  if (/^(?:do|does|did|is|are|was|were|have|has|had|can|could|will|would|should)\b/.test(q) && !/\b(?:why|how|what|tell me|describe|explain|walk me)\b/.test(q)) return false;
  if (/\b(?:how many|how much|how old|which one|what year|what age)\b/.test(q)) return false;
  return true;
}

/**
 * How long to keep listening after the participant's last word. Pure and deterministic; the caller adds speech
 * activity (a new start cancels the wait) and, when `consultAi`, the model's view.
 */
export function endOfTurn(input: TurnTakingInput): TurnTakingDecision {
  const k = PATIENCE[input.patience ?? "balanced"];
  const answer = String(input.answer ?? "").trim();
  const n = words(answer).length;
  const ms = (x: number) => Math.min(MAX_HOLD_MS, Math.round(x * k));
  if (!n) return { action: "wait", waitMs: ms(6000), consultAi: false, signal: "empty", reason: "nothing said yet" };
  if (signalsDone(answer)) return { action: "commit", waitMs: 350, consultAi: false, signal: "done", reason: "the participant said they have nothing more to add" };
  if (signalsThinking(answer)) return { action: "wait", waitMs: ms(7000), consultAi: false, signal: "thinking", reason: "the answer ends on a thinking filler" };
  if (endsUnfinished(answer)) return { action: "wait", waitMs: ms(5000), consultAi: false, signal: "incomplete", reason: "the sentence stops mid-way" };
  const open = expectsOpenAnswer(input.question);
  if (open && n < 8) return { action: "wait", waitMs: ms(3500), consultAi: true, signal: "short", reason: "a short answer to an open question — they may go on" };
  if (!open && n <= 6) return { action: "wait", waitMs: ms(1600), consultAi: false, signal: "complete", reason: "a short answer to a closed question" };
  /* a complete sentence: a rich answer waits a little; a mid-length one a little longer and asks the model */
  if (n >= 40) return { action: "wait", waitMs: ms(1900), consultAi: false, signal: "complete", reason: "a full answer that ended on a complete sentence" };
  return { action: "wait", waitMs: ms(2600), consultAi: (input.pieces ?? 1) <= 1, signal: "complete", reason: "a complete sentence" };
}

/** the model's view of an answer in progress → how the wait changes */
export function adjustForModel(d: TurnTakingDecision, verdict: "complete" | "continuing" | "unclear", patience: TurnPatience = "balanced"): TurnTakingDecision {
  if (verdict === "complete") return { ...d, waitMs: Math.min(d.waitMs, 1100), consultAi: false, reason: `${d.reason}; the model reads it as finished` };
  if (verdict === "continuing") return { ...d, waitMs: Math.min(MAX_HOLD_MS, Math.round(d.waitMs + 4000 * PATIENCE[patience])), consultAi: false, reason: `${d.reason}; the model expects more` };
  return { ...d, consultAi: false };
}
