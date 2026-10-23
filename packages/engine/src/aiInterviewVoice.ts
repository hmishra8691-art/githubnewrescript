import { probeProblems } from "./untrusted.js";
import { inLanguage } from "./aiInterviewSafety.js";
import { MODERATOR_LEAK } from "./aiModerator.js";

/**
 * VOICE CONVERSATION: SPEAKING A REPLY BEFORE IT IS FINISHED, SAFELY (G1 2026-10-22).
 *
 * The moderator's reply streams from the model; to start speaking before the whole reply exists it is cut
 * into sentences, and each sentence is spoken only after it passed the per-sentence checks of the output
 * gate — no link, e-mail or phone, no request for contact or identity details, nothing about the AI's
 * instructions, the participant's language — and only while the reply's intent (the model writes it
 * first) is one the rules allow. A sentence that fails closes the gate: nothing more of that reply is
 * spoken, and the whole-reply check (`finishTurn`) replaces it with the guide's scripted turn, which is
 * spoken after what was already said. Rules replies (safety, caps, conditional probes, fallbacks) are
 * final before they are spoken, so they are cut into sentences and spoken whole.
 *
 *   SentenceChunker   streamed text → speakable chunks (sentence ends in many scripts; very short
 *                     sentences merged with the next; very long ones split at a comma or space)
 *   SpeechGate        chunks → the ones cleared to speak; the remainder to speak when the reply is final
 */

/** a sentence end: . ! ? … । ۔ ؟ and the CJK full-width marks (which need no space after) */
const END = /([.!?…।۔؟]+["'”’»)\]]*)(\s+)|([。！？]+["'”’」』)]*)/g;
/** "e.g." / "Mr." / "No. 5" are not sentence ends */
const ABBR = /(?:\b(?:e\.g|i\.e|etc|mr|mrs|ms|dr|prof|st|no|vs|approx)\.|\b[A-Z]\.)$/i;

export interface ChunkerOptions { minChars?: number; maxChars?: number }

export class SentenceChunker {
  private buf = "";
  private readonly min: number;
  private readonly max: number;
  constructor(o: ChunkerOptions = {}) { this.min = o.minChars ?? 18; this.max = o.maxChars ?? 240; }

  /** more text → the chunks now complete (possibly none) */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.nextCut();
      if (cut < 0) break;
      const piece = this.buf.slice(0, cut).trim();
      if (piece.length < this.min) {
        /* a short sentence ("Thank you.") waits to be spoken with the next one, unless nothing follows yet */
        const after = this.buf.slice(cut);
        const nextCut = this.nextCut(cut);
        if (nextCut < 0) break;
        void after;
        const joined = this.buf.slice(0, nextCut).trim();
        this.buf = this.buf.slice(nextCut);
        out.push(joined);
        continue;
      }
      this.buf = this.buf.slice(cut);
      out.push(piece);
    }
    /* a very long run without a sentence end is split at the last comma, else the last space */
    while (this.buf.length > this.max) {
      const head = this.buf.slice(0, this.max);
      const at = Math.max(head.lastIndexOf(", "), head.lastIndexOf("، "), head.lastIndexOf("、"), head.lastIndexOf("，"));
      const sp = at > this.max / 3 ? at + 1 : head.lastIndexOf(" ") > this.max / 3 ? head.lastIndexOf(" ") : this.max;
      out.push(this.buf.slice(0, sp).trim());
      this.buf = this.buf.slice(sp);
    }
    return out.filter(Boolean);
  }

  /** the end of the text: whatever is left */
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = "";
    return rest ? [rest] : [];
  }

  /** index just after the first sentence end at or after `from`, or -1 */
  private nextCut(from = 0): number {
    END.lastIndex = from;
    let m: RegExpExecArray | null;
    while ((m = END.exec(this.buf))) {
      const end = m.index + m[0].length;
      const before = this.buf.slice(0, m.index + (m[1] ?? m[3] ?? "").length);
      if (m[1] && /\.$/.test(m[1]) && ABBR.test(before)) continue;
      return end;
    }
    return -1;
  }
}

/** split a finished text into speakable chunks */
export function speechChunks(text: string, o: ChunkerOptions = {}): string[] {
  const c = new SentenceChunker(o);
  return [...c.push(String(text ?? "")), ...c.flush()];
}

export interface SpeechGateContext { allowed: readonly string[]; language: string; questionText: string; answer: string; nextText?: string }

/** what is wrong with ONE sentence of a reply, by the checks that can be judged on a sentence */
export function sentenceProblems(sentence: string, ctx: SpeechGateContext): string[] {
  const s = String(sentence ?? "").trim();
  if (!s) return [];
  const out = probeProblems(s, { questionText: `${ctx.questionText} ${ctx.nextText ?? ""}`, answer: ctx.answer }).filter((p) => p !== "too long" && p !== "off the question's topic" && p !== "empty");
  if (MODERATOR_LEAK.test(s)) out.push("talks about its instructions");
  const letters = [...s].filter((ch) => /\p{L}/u.test(ch)).length;
  if (letters >= 15 && !inLanguage(s, ctx.language)) out.push("not in the participant's language");
  return [...new Set(out)];
}

export interface GateFinish {
  /** what is still to be spoken now the reply is final */
  remainder: string;
  /** what was spoken before the reply was final */
  spoken: string;
  /** the final reply is not the model's draft (it failed a check): the remainder is the scripted turn */
  replaced: boolean;
}

export class SpeechGate {
  private chunker = new SentenceChunker();
  private said = "";
  private intent: string | null = null;
  private closedBy: string | null = null;
  private total = 0;
  constructor(private readonly ctx: SpeechGateContext, private readonly maxChars = 700) {}

  /** the reply's intent, as soon as the stream shows it */
  setIntent(intent: string): void {
    const i = intent.trim().toLowerCase();
    if (!i) return;
    this.intent = i;
    if (!this.ctx.allowed.includes(i)) this.closedBy ??= `intent “${i}” is not allowed now`;
  }

  /** more of the reply's "say" → the chunks cleared to be spoken now */
  pushSay(delta: string): string[] { return this.clear(this.chunker.push(delta)); }

  /** why the gate closed (nothing more of this reply is spoken), or null */
  get blocked(): string | null { return this.closedBy; }
  get spoken(): string { return this.said.trim(); }

  private clear(chunks: string[]): string[] {
    const out: string[] = [];
    for (const c of chunks) {
      if (this.closedBy) break;
      const problems = sentenceProblems(c, this.ctx);
      if (problems.length) { this.closedBy = problems.join("; "); break; }
      if (this.total + c.length > this.maxChars) { this.closedBy = "too long"; break; }
      this.total += c.length;
      this.said += `${c} `;
      out.push(c);
    }
    return out;
  }

  /**
   * The reply is final (`finalSay`, after the whole-reply checks). If it begins with what was spoken, the
   * rest is spoken; otherwise (the scripted turn replaced the draft) the whole final text follows what was
   * already said. Nothing the gate refused is ever returned.
   */
  finish(finalSay: string): GateFinish {
    const spoken = this.spoken;
    const final = String(finalSay ?? "").replace(/\s+/g, " ").trim();
    if (!spoken) return { remainder: final, spoken: "", replaced: false };
    const norm = (x: string) => x.replace(/\s+/g, " ").trim();
    if (norm(final).startsWith(norm(spoken))) return { remainder: norm(final).slice(norm(spoken).length).trim(), spoken, replaced: false };
    return { remainder: final, spoken, replaced: true };
  }
}
