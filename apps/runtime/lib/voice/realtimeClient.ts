"use client";

/**
 * THE REALTIME VOICE IN THE BROWSER (G1 2026-10-22) — a WebRTC session with the provider (plain
 * RTCPeerConnection, no SDK), opened with the short-lived secret the runtime minted. The provider hears the
 * participant and transcribes them, and it speaks ONLY when this page asks (`response.create`) — with the
 * instructions the runtime returned for that turn (the rules' exact words, or the guide's turn context).
 * Both sides' transcripts and the tool call come back here and are sent to the runtime, which records and
 * checks them. Event names of both the GA and the beta protocol are read.
 */

export interface RealtimeHooks {
  /** the participant finished an utterance: their words (and whether they spoke over the moderator) */
  onUserTranscript(text: string, info: { interrupted: boolean }): void;
  /** the moderator's response finished: what it said and the tool call it made (if any) */
  onResponseDone(transcript: string, call: { name: string; arguments: string } | null): void;
  onSpeaking(on: boolean): void;
  onError(message: string): void;
}

export class RealtimeClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private transcript = "";
  private call: { name: string; arguments: string } | null = null;
  private speaking = false;
  private interruptedNext = false;
  private readonly hooks: RealtimeHooks;
  constructor(hooks: RealtimeHooks) { this.hooks = hooks; }

  static supported(): boolean { return typeof window !== "undefined" && typeof window.RTCPeerConnection === "function" && !!navigator.mediaDevices?.getUserMedia; }

  async connect(s: { clientSecret: string; callUrl: string; model: string }): Promise<void> {
    const pc = new RTCPeerConnection();
    this.pc = pc;
    this.audioEl = document.createElement("audio");
    this.audioEl.autoplay = true;
    pc.ontrack = (e) => { if (this.audioEl) this.audioEl.srcObject = e.streams[0]; };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    for (const t of this.stream.getAudioTracks()) pc.addTrack(t, this.stream);
    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.onmessage = (m) => { try { this.onEvent(JSON.parse(String(m.data))); } catch { /* not ours */ } };
    const opened = new Promise<void>((res, rej) => { dc.onopen = () => res(); setTimeout(() => rej(new Error("the realtime data channel did not open")), 15_000); });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const r = await fetch(`${s.callUrl}?model=${encodeURIComponent(s.model)}`, { method: "POST", body: offer.sdp, headers: { authorization: `Bearer ${s.clientSecret}`, "content-type": "application/sdp" } });
    if (!r.ok) throw new Error(`the realtime provider answered ${r.status}`);
    await pc.setRemoteDescription({ type: "answer", sdp: await r.text() });
    await opened;
  }

  /** ask the provider to speak: a rules turn (exact words, no tools) or a model turn (the turn's instructions, tools on) */
  respond(instructions: string, o: { verbatim: boolean }): void {
    this.transcript = ""; this.call = null;
    this.dc?.send(JSON.stringify({ type: "response.create", response: { instructions, ...(o.verbatim ? { tool_choice: "none" } : { tool_choice: "required" }) } }));
  }

  close(): void {
    try { this.dc?.close(); this.pc?.close(); } catch { /* gone */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.audioEl) this.audioEl.srcObject = null;
    this.pc = null; this.dc = null; this.stream = null;
  }

  private onEvent(e: { type?: string; transcript?: string; delta?: string; name?: string; arguments?: string; error?: { message?: string } }): void {
    switch (e.type) {
      case "input_audio_buffer.speech_started":
        /* the provider stops its own audio (interrupt_response); remember that this utterance cut it off */
        if (this.speaking) this.interruptedNext = true;
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(e.transcript ?? "").trim();
        const interrupted = this.interruptedNext; this.interruptedNext = false;
        if (text) this.hooks.onUserTranscript(text, { interrupted });
        break;
      }
      case "output_audio_buffer.started": case "response.output_audio.delta": case "response.audio.delta":
        if (!this.speaking) { this.speaking = true; this.hooks.onSpeaking(true); }
        break;
      case "output_audio_buffer.stopped": case "output_audio_buffer.cleared":
        if (this.speaking) { this.speaking = false; this.hooks.onSpeaking(false); }
        break;
      case "response.output_audio_transcript.done": case "response.audio_transcript.done":
        this.transcript = `${this.transcript} ${String(e.transcript ?? "")}`.trim();
        break;
      case "response.function_call_arguments.done":
        this.call = { name: String(e.name ?? ""), arguments: String(e.arguments ?? "{}") };
        break;
      case "response.done":
        this.hooks.onResponseDone(this.transcript, this.call);
        break;
      case "error":
        this.hooks.onError(String(e.error?.message ?? "realtime error"));
        break;
    }
  }
}
