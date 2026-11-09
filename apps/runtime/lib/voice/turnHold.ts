import { adjustForModel, endOfTurn, MAX_HOLD_MS, type TurnPatience, type TurnTakingDecision } from "@rescript/engine";

/**
 * HOLDING A PAUSE (2026-11-08) — the hands-free interview's answer-in-progress. The voice-activity detector still
 * cuts speech at short pauses (each piece is transcribed while the participant goes on talking), but a piece is no
 * longer a turn. Pieces are joined here into one answer, and the answer is sent only when the turn-taking engine
 * (`endOfTurn`, packages/engine) — and, when the words alone cannot tell, the model (`/api/ai-interview/listen`) —
 * says the participant has finished AND the silence has lasted that long. Speech starting again cancels the wait
 * at once. "I'm done" (a button, or saying it) sends straight away. Nothing waits past MAX_HOLD_MS of silence.
 *
 * Framework-free and clock-injected so it is tested without a browser (`turnHold.test.ts`).
 */
export type Verdict = "complete" | "continuing" | "unclear";
export interface HoldView { holding: boolean; text: string; signal: TurnTakingDecision["signal"] | null; waitMs: number; consulting: boolean }
export interface TurnHoldOptions {
  patience?: TurnPatience;
  question: () => string;
  /** send the answer (all pieces joined) */
  commit: (text: string, info: { durationMs: number; pieces: number; reason: string }) => void;
  /** ask the model whether the answer is finished (optional) */
  consult?: (text: string) => Promise<Verdict>;
  onView?: (v: HoldView) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class TurnHold {
  private text = "";
  private pieces = 0;
  private durationMs = 0;
  private lastEnd = 0;
  private timer: unknown = null;
  private gen = 0;
  private speaking = false;
  private decision: TurnTakingDecision | null = null;
  private consulting = false;
  private readonly o: Required<Omit<TurnHoldOptions, "consult" | "onView" | "patience">> & Pick<TurnHoldOptions, "consult" | "onView" | "patience">;

  constructor(o: TurnHoldOptions) {
    this.o = { now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>), ...o };
  }

  get holding(): boolean { return this.pieces > 0; }
  get answer(): string { return this.text; }

  /** the participant started speaking again: whatever was pending waits for them */
  speechStart(): void {
    this.speaking = true;
    this.gen++;
    this.cancel();
    this.view();
  }

  /** a transcribed piece (possibly empty: noise, or speech the service could not read) ended at `endAt` */
  piece(text: string, durationMs: number, endAt: number = this.o.now()): void {
    this.speaking = false;
    const t = String(text ?? "").trim();
    if (t) { this.text = this.text ? `${this.text} ${t}` : t; this.pieces++; this.durationMs += Math.max(0, durationMs); }
    this.lastEnd = endAt;
    if (!this.pieces) { this.view(); return; }
    const d = endOfTurn({ answer: this.text, question: this.o.question(), pieces: this.pieces, patience: this.o.patience });
    this.decision = d;
    if (d.action === "commit") { this.commit(d.reason); return; }
    this.schedule();
    if (d.consultAi && this.o.consult) {
      const gen = ++this.gen;
      this.consulting = true; this.view();
      void this.o.consult(this.text).then((v) => {
        if (gen !== this.gen || this.speaking || !this.decision) return;
        this.consulting = false;
        this.decision = adjustForModel(this.decision, v, this.o.patience);
        this.schedule();
      }).catch(() => { if (gen === this.gen) { this.consulting = false; this.view(); } });
    }
  }

  /** "I'm done": send what was said now */
  commitNow(): void { if (this.pieces) this.commit("the participant said they were done"); }

  /** forget everything (pause, a typed answer took over, the interview ended) */
  reset(): string { const t = this.text; this.cancel(); this.gen++; this.text = ""; this.pieces = 0; this.durationMs = 0; this.decision = null; this.consulting = false; this.speaking = false; this.view(); return t; }

  private schedule(): void {
    this.cancel();
    if (!this.decision || this.speaking) return;
    const elapsed = Math.max(0, this.o.now() - this.lastEnd);
    const left = Math.max(0, Math.min(MAX_HOLD_MS, this.decision.waitMs) - elapsed);
    const reason = this.decision.reason;
    this.timer = this.o.setTimer(() => { this.timer = null; if (!this.speaking && this.pieces) this.commit(reason); }, left);
    this.view();
  }

  private cancel(): void { if (this.timer !== null) { this.o.clearTimer(this.timer); this.timer = null; } }

  private commit(reason: string): void {
    const text = this.text, pieces = this.pieces, durationMs = this.durationMs;
    this.reset();
    if (text) this.o.commit(text, { durationMs, pieces, reason });
  }

  private view(): void {
    this.o.onView?.({ holding: this.pieces > 0, text: this.text, signal: this.decision?.signal ?? null, waitMs: this.decision?.waitMs ?? 0, consulting: this.consulting });
  }
}
