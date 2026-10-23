/**
 * THE HANDS-FREE CONVERSATION'S TURN-TAKING (G1 2026-10-22) — a pure state machine (`bargeIn.test.ts`);
 * the page's controller (`duplex.ts`) feeds it events and carries out the effects it returns.
 *
 *   listening ──vad start──▶ userSpeaking ──vad end──▶ processing (utterance → STT → turn)
 *        ▲                        ▲                         │ first audio of the reply
 *        │                        │ barge-in                ▼
 *        └──────audio end────── speaking ◀──────────────────┘
 *
 * BARGE-IN: speech while the moderator is speaking (after the first `ignoreMs` of playback, which belong
 * to the echo canceller) stops playback AT ONCE and opens a new utterance; the interruption is reported
 * with how much of the turn was heard. Speech while a reply is still being prepared means the reply,
 * when it comes, is not played (the participant already moved on) — it is reported as interrupted with
 * nothing heard. A new utterance waits until the reply in flight is answered (so the server always gets
 * the turns in order and a resend replays instead of answering twice).
 */

export type DuplexPhase = "idle" | "listening" | "userSpeaking" | "processing" | "speaking" | "paused" | "ended";
export interface DuplexState {
  phase: DuplexPhase;
  /** a turn request is open */
  inFlight: boolean;
  /** the reply's audio is playing */
  playing: boolean;
  audioStartedAt: number | null;
  /** the end of the participant's last utterance (its last voiced frame) — the latency budget starts here */
  speechEndAt: number | null;
  /** utterances finished and not yet sent (they wait for the reply in flight) */
  pending: number;
  /** the reply in flight is not to be played: the participant spoke again before it began */
  discardReply: boolean;
}
export type DuplexEvent =
  | { type: "start" } | { type: "pause" } | { type: "resume" } | { type: "end" }
  | { type: "vad_start"; at: number } | { type: "vad_end"; at: number }
  | { type: "sent" }
  | { type: "audio_start"; at: number } | { type: "audio_end"; at: number }
  | { type: "reply_done" } | { type: "reply_failed" };
export type DuplexEffect =
  | { type: "begin_capture" } | { type: "finish_capture" } | { type: "drop_capture" }
  | { type: "stop_playback"; reason: "barge_in" | "discard" | "pause" | "end" }
  | { type: "interrupted"; during: "speaking" | "preparing" }
  | { type: "latency"; ms: number }
  | { type: "send_next" };

export const initialDuplex = (): DuplexState => ({ phase: "idle", inFlight: false, playing: false, audioStartedAt: null, speechEndAt: null, pending: 0, discardReply: false });

export function duplexStep(s: DuplexState, e: DuplexEvent, o: { ignoreMs?: number } = {}): { state: DuplexState; effects: DuplexEffect[] } {
  const ignoreMs = o.ignoreMs ?? 300;
  const st = { ...s };
  const fx: DuplexEffect[] = [];
  const settle = () => { if (st.phase !== "userSpeaking" && st.phase !== "paused" && st.phase !== "ended") st.phase = st.playing ? "speaking" : st.inFlight || st.pending ? "processing" : "listening"; };
  switch (e.type) {
    case "start": if (st.phase === "idle") st.phase = "listening"; break;
    case "end":
      if (st.playing) fx.push({ type: "stop_playback", reason: "end" });
      if (st.phase === "userSpeaking") fx.push({ type: "drop_capture" });
      st.phase = "ended"; st.playing = false; break;
    case "pause":
      if (st.phase === "ended") break;
      if (st.playing) fx.push({ type: "stop_playback", reason: "pause" });
      if (st.phase === "userSpeaking") fx.push({ type: "drop_capture" });
      st.playing = false; st.phase = "paused"; break;
    case "resume": if (st.phase === "paused") { st.phase = "listening"; settle(); } break;
    case "vad_start": {
      if (st.phase === "paused" || st.phase === "ended" || st.phase === "idle" || st.phase === "userSpeaking") break;
      if (st.playing) {
        /* the first ms of playback belong to the echo canceller: not a barge-in */
        if (st.audioStartedAt !== null && e.at - st.audioStartedAt < ignoreMs) break;
        fx.push({ type: "stop_playback", reason: "barge_in" }, { type: "interrupted", during: "speaking" });
        st.playing = false;
      } else if (st.inFlight && !st.discardReply) {
        st.discardReply = true;
        fx.push({ type: "interrupted", during: "preparing" });
      }
      fx.push({ type: "begin_capture" });
      st.phase = "userSpeaking";
      break;
    }
    case "vad_end":
      if (st.phase !== "userSpeaking") break;
      fx.push({ type: "finish_capture" });
      st.speechEndAt = e.at; st.pending++;
      st.phase = "processing";
      if (!st.inFlight) fx.push({ type: "send_next" });
      break;
    case "sent": st.inFlight = true; st.pending = Math.max(0, st.pending - 1); st.discardReply = false; settle(); break;
    case "audio_start":
      if (st.discardReply || st.phase === "paused" || st.phase === "ended" || st.phase === "userSpeaking") { fx.push({ type: "stop_playback", reason: "discard" }); break; }
      st.playing = true; st.audioStartedAt = e.at;
      if (st.speechEndAt !== null) { fx.push({ type: "latency", ms: Math.max(0, Math.round(e.at - st.speechEndAt)) }); st.speechEndAt = null; }
      settle(); break;
    case "audio_end": st.playing = false; st.audioStartedAt = null; settle(); break;
    case "reply_done":
    case "reply_failed":
      st.inFlight = false; st.discardReply = false;
      if (st.pending > 0) fx.push({ type: "send_next" });
      settle(); break;
  }
  return { state: st, effects: fx };
}
