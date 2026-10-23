import type { LiveView, PeerView, LiveRole } from "./room.js";

/**
 * THE BROWSER SIDE OF A LIVE SESSION (2026-10-22, G2) — built-in mesh WebRTC with the browser's own
 * RTCPeerConnection: no SDK, no media server.
 *
 *   SIGNALLING   HTTP long-poll: `poll` returns the room (who is in it, the stage) and the connection messages
 *                addressed to this tab; `signal` sends ours (batched every ~100 ms). Every message carries this
 *                connection's random id (`cid`): when a peer reloads (or reopens its side) its new connection id
 *                makes the other side replace its connection rather than renegotiate it (new DTLS keys).
 *   NEGOTIATION  "perfect negotiation" (the W3C pattern): either side may (re)negotiate at any time — a camera
 *                turned on, a screen shared, an ICE restart — and a collision is resolved by the polite side
 *                (decided by member id, so both sides agree) rolling back. Candidates that arrive before the
 *                description are queued.
 *   TOPOLOGY     the moderator ↔ everyone; participant ↔ participant; observers ↔ the moderator ONLY. The
 *                moderator's browser RELAYS the room to observers (its own camera and every participant's stream
 *                re-sent on the observer connection, at reduced bitrate), so a participant's browser never learns
 *                an observer exists. A `meta` message names whose stream is whose.
 *   RECONNECTION a failed or long-disconnected connection restarts ICE; a reloaded tab rejoins with its link
 *                and gets the same place; a failed poll backs off and retries.
 *
 * The negotiation core (`Negotiator`) takes any RTCPeerConnection-like object, so it is unit-tested with a fake.
 */

export type Call = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
export interface RemoteTile { memberId: string; kind: "camera" | "screen"; stream: MediaStream; via: string }
export interface OutSignal { to: string; type: "offer" | "answer" | "candidate" | "meta" | "bye"; payload: Record<string, unknown>; queuedAt?: number }

/* ------------------------------------------------------------ perfect negotiation, testable */

export interface PcLike {
  signalingState: string;
  remoteDescription: { type: string; sdp?: string } | null;
  setLocalDescription(d?: unknown): Promise<void>;
  setRemoteDescription(d: { type: string; sdp?: string }): Promise<void>;
  addIceCandidate(c: unknown): Promise<void>;
  localDescription: { type: string; sdp?: string } | null;
}

export class Negotiator {
  makingOffer = false;
  ignoreOffer = false;
  private settingAnswer = false;
  private queued: unknown[] = [];
  constructor(readonly pc: PcLike, readonly polite: boolean, private readonly send: (type: "offer" | "answer" | "candidate", payload: Record<string, unknown>) => void) {}

  /** negotiationneeded */
  async offer(): Promise<void> {
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      const d = this.pc.localDescription;
      if (d) this.send(d.type === "answer" ? "answer" : "offer", { description: { type: d.type, sdp: d.sdp } });
    } finally { this.makingOffer = false; }
  }

  /** an offer or answer from the peer */
  async description(desc: { type: string; sdp?: string }): Promise<"ignored" | "applied"> {
    const readyForOffer = !this.makingOffer && (this.pc.signalingState === "stable" || this.settingAnswer);
    const collision = desc.type === "offer" && !readyForOffer;
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) return "ignored";
    this.settingAnswer = desc.type === "answer";
    try { await this.pc.setRemoteDescription(desc); } finally { this.settingAnswer = false; }
    for (const c of this.queued.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
    if (desc.type === "offer") {
      await this.pc.setLocalDescription();
      const d = this.pc.localDescription;
      if (d) this.send("answer", { description: { type: d.type, sdp: d.sdp } });
    }
    return "applied";
  }

  /** an ICE candidate from the peer (queued until a remote description exists) */
  async candidate(c: unknown): Promise<void> {
    if (!this.pc.remoteDescription) { this.queued.push(c); return; }
    try { await this.pc.addIceCandidate(c); } catch (e) { if (!this.ignoreOffer) throw e; }
  }
}

/* ------------------------------------------------------------ the client */

interface Peer {
  /* cid: this connection's own random id, sent with every message on it; remoteCid: the other side's */
  id: string; role: string; pc: RTCPeerConnection; neg: Negotiator; cid: string; remoteCid: string | null;
  inbound: Map<string, MediaStream>; senders: Map<string, RTCRtpSender>; created: number; disconnectedAt: number | null; lastRestart?: number;
}

export interface LiveClientOptions {
  call: Call;
  memberId: string;
  role: LiveRole;
  iceServers: RTCIceServer[];
  /** this person's camera + microphone (null: receive-only — an observer, or no devices) */
  local: MediaStream | null;
  onView(view: LiveView, extra: Record<string, unknown>): void;
  onTiles(tiles: RemoteTile[]): void;
  onGone(reason: string): void;
  onError?(message: string): void;
  /** observers' relayed video is sent at most at this bitrate (the moderator's uplink) */
  relayMaxBitrate?: number;
}

const rid = () => Math.random().toString(36).slice(2, 12);

export class LiveClient {
  readonly sid = rid();
  private peers = new Map<string, Peer>();
  private owners = new Map<string, { member: string; kind: "camera" | "screen" }>();
  private outbox: OutSignal[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private cursor = 0;
  private rev = -1;
  private view: LiveView | null = null;
  private screen: MediaStream | null = null;
  /** server clock − local clock (ms), from the polls */
  offset = 0;
  constructor(private readonly o: LiveClientOptions) {}

  get serverNow(): number { return Date.now() + this.offset; }
  get localStream(): MediaStream | null { return this.o.local; }
  get screenStream(): MediaStream | null { return this.screen; }

  start(): void { if (this.running) return; this.running = true; void this.loop(); }

  async stop(sendBye = true): Promise<void> {
    this.running = false;
    if (sendBye) { for (const p of this.peers.values()) this.queue({ to: p.id, type: "bye", payload: {} }); await this.flush(); }
    for (const p of this.peers.values()) p.pc.close();
    this.peers.clear();
    this.emitTiles();
  }

  /* -------------------------------------------- polling */

  private async loop(): Promise<void> {
    let backoff = 500;
    while (this.running) {
      const t0 = Date.now();
      try {
        const r = await this.o.call({ action: "poll", after: this.cursor, rev: this.rev, wait: 6000 });
        const t1 = Date.now();
        if (typeof r.serverNow === "string") { const s = Date.parse(r.serverNow); if (Number.isFinite(s)) this.offset = Math.round(s - (t0 + t1) / 2); }
        backoff = 500;
        if (r.gone) { this.o.onGone(String(r.gone)); if (r.view) this.o.onView(r.view as LiveView, r); await this.stop(false); return; }
        this.cursor = Number(r.cursor) || this.cursor;
        this.rev = Number(r.rev);
        this.view = r.view as LiveView;
        this.o.onView(this.view, r);
        await this.syncPeers(this.view);
        for (const s of (r.signals ?? []) as { from: string; type: string; payload: Record<string, unknown> }[]) await this.onSignal(s).catch((e) => this.o.onError?.(`connection: ${(e as Error).message}`));
        this.watchdog();
        if (this.view.room.status === "ended" || this.view.room.status === "cancelled" || this.view.me.state === "removed" || this.view.me.state === "denied") { this.o.onGone(this.view.me.state === "removed" ? "removed" : this.view.room.status); await this.stop(false); return; }
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "not_joined") { this.o.onGone("replaced"); await this.stop(false); return; }
        this.o.onError?.((e as Error).message);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(8000, backoff * 2);
      }
    }
  }

  /* -------------------------------------------- peers */

  /** an SFU carries the media (LiveKit adapter connected): no mesh connections */
  private sfu = false;
  useSfu(on: boolean): void { this.sfu = on; if (on) for (const p of [...this.peers.values()]) this.closePeer(p); }

  private async syncPeers(view: LiveView): Promise<void> {
    if (this.sfu) { if (view.me.mutedByModerator) for (const t of this.o.local?.getAudioTracks() ?? []) t.enabled = false; return; }
    /* a peer not heard from for 45 s (a closed tab) is dropped; it gets a fresh connection when it comes back */
    const live = view.peers.filter((p) => p.online);
    const want = new Map(live.map((p) => [p.id, p]));
    for (const [id, p] of this.peers) if (!want.has(id)) this.closePeer(p);
    for (const p of live) if (!this.peers.has(p.id)) this.openPeer(p);
    /* enforce the moderator's mute */
    if (view.me.mutedByModerator) for (const t of this.o.local?.getAudioTracks() ?? []) t.enabled = false;
    this.updateRelay();
  }

  private openPeer(v: Pick<PeerView, "id" | "role" | "polite">, remoteCid: string | null = null): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.o.iceServers });
    const peer: Peer = { id: v.id, role: v.role, pc, cid: rid(), remoteCid, inbound: new Map(), senders: new Map(), created: Date.now(), disconnectedAt: null, neg: null as unknown as Negotiator };
    peer.neg = new Negotiator(pc as unknown as PcLike, v.polite, (type, payload) => this.queue({ to: v.id, type, payload }));
    pc.onnegotiationneeded = () => { void peer.neg.offer().catch((e) => this.o.onError?.(`offer: ${(e as Error).message}`)); };
    pc.onicecandidate = (e) => { if (e.candidate) this.queue({ to: v.id, type: "candidate", payload: { candidate: e.candidate.toJSON() } }); };
    pc.ontrack = (e) => {
      for (const s of e.streams) {
        peer.inbound.set(s.id, s);
        s.onremovetrack = () => { if (!s.getTracks().length) peer.inbound.delete(s.id); this.emitTiles(); this.updateRelay(); };
      }
      e.track.onended = () => { this.emitTiles(); };
      this.emitTiles();
      this.updateRelay();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") { peer.disconnectedAt = null; this.sendMeta(peer); }
      if (pc.connectionState === "disconnected") peer.disconnectedAt ??= Date.now();
      if (pc.connectionState === "failed") { try { pc.restartIce(); } catch { /* older browsers */ } }
      this.emitTiles();
    };
    this.peers.set(v.id, peer);
    /* what this side sends on it */
    if (this.o.local && this.o.role !== "observer" && v.role !== "observer") for (const t of this.o.local.getTracks()) peer.senders.set(t.id, pc.addTrack(t, this.o.local));
    if (this.screen && v.role !== "observer") for (const t of this.screen.getTracks()) peer.senders.set(t.id, pc.addTrack(t, this.screen));
    /* a receive-only side (an observer, someone without devices) sends nothing: the sending side's tracks start the negotiation */
    this.sendMeta(peer);
    return peer;
  }

  private closePeer(p: Peer): void {
    p.pc.onnegotiationneeded = null; p.pc.onicecandidate = null; p.pc.ontrack = null; p.pc.onconnectionstatechange = null;
    p.pc.close();
    this.peers.delete(p.id);
    this.emitTiles();
    this.updateRelay();
  }

  private watchdog(): void {
    const now = Date.now();
    for (const p of this.peers.values()) {
      if (p.disconnectedAt && now - p.disconnectedAt > 10_000) { p.disconnectedAt = now; try { p.pc.restartIce(); } catch { /* */ } }
      /* never connected (an offer or the candidates were lost — a server restarting mid-handshake): ask again with fresh
         candidates every 15 s; the other side answers on the connection it has, or opens one for this offer */
      else if (p.pc.connectionState !== "connected" && p.pc.connectionState !== "closed" && now - (p.lastRestart ?? p.created) > 15_000) {
        p.lastRestart = now;
        const d = p.pc.localDescription;
        /* our offer was never answered: send it again; settled but not connecting: fresh candidates (an ICE restart) */
        if (p.pc.signalingState === "have-local-offer" && d) this.queue({ to: p.id, type: "offer", payload: { description: { type: d.type, sdp: d.sdp } } });
        else if (p.pc.signalingState === "stable" && (p.pc.localDescription || p.pc.remoteDescription)) { try { p.pc.restartIce(); } catch { /* */ } }
      }
    }
  }

  /* -------------------------------------------- signals */

  private queue(s: OutSignal): void {
    const p = this.peers.get(s.to);
    this.outbox.push({ ...s, queuedAt: Date.now(), payload: { ...s.payload, sid: this.sid, ...(p ? { cid: p.cid } : {}), ...(p?.remoteCid ? { rcid: p.remoteCid } : {}) } });
    if (!this.flushTimer) this.flushTimer = setTimeout(() => { void this.flush(); }, 100);
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const batch = this.outbox.splice(0);
    if (!batch.length) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { await this.o.call({ action: "signal", signals: batch }); this.flushBackoff = 0; return; } catch (e) {
        if ((e as { code?: string }).code === "not_in_room" || (e as { code?: string }).code === "not_joined") return;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    /* the server is away (restarting): keep the messages, in order, and try again — a lost offer or candidate leaves a
       connection checking for ever; messages older than the server's two-minute life are not worth sending */
    if (!this.running) return;
    const fresh = batch.filter((m) => Date.now() - (m.queuedAt ?? Date.now()) < 110_000);
    this.outbox.unshift(...fresh);
    this.flushBackoff = Math.min(8000, (this.flushBackoff || 500) * 2);
    if (!this.flushTimer && this.outbox.length) this.flushTimer = setTimeout(() => { void this.flush(); }, this.flushBackoff);
  }
  private flushBackoff = 0;

  private async onSignal(s: { from: string; type: string; payload: Record<string, unknown> }): Promise<void> {
    /*
     * Every message names the CONNECTION it comes from (cid) and the one it is meant for (rcid, once known). A
     * connection is never renegotiated onto a new one (new DTLS keys): an offer from a connection we are not paired
     * with — the peer reloaded, or dropped and reopened its side — replaces ours; an answer or a candidate meant for
     * an older connection of ours is stale and dropped; a meta (each connection's hello) from a new connection makes
     * us start afresh too, unless it is already paired with ours. Pairing by both ids means two fresh sides settle
     * instead of replacing each other in turn.
     */
    const cid = typeof s.payload?.cid === "string" ? s.payload.cid : null;
    const rcid = typeof s.payload?.rcid === "string" ? s.payload.rcid : null;
    const v = this.view?.peers.find((p) => p.id === s.from);
    let peer = this.peers.get(s.from);
    if (s.type === "meta") {
      /* whose stream is whose — kept even before the connection exists (stream ids are unique) */
      const streams = (s.payload?.streams ?? {}) as Record<string, { member?: string; kind?: string }>;
      for (const [streamId, m] of Object.entries(streams)) if (m && typeof m.member === "string") this.owners.set(streamId, { member: m.member, kind: m.kind === "screen" ? "screen" : "camera" });
      if (peer && cid) {
        if (!peer.remoteCid || rcid === peer.cid) peer.remoteCid = cid;
        else if (cid !== peer.remoteCid && v) { this.closePeer(peer); this.openPeer(v, cid); }
      }
      this.emitTiles();
      this.updateRelay();
      return;
    }
    if (s.type === "bye") { if (peer && (!cid || cid === peer.remoteCid)) this.closePeer(peer); return; }
    if (!v) return;
    if (peer) {
      const meantForOld = !!rcid && rcid !== peer.cid;
      const fromNew = !!cid && !!peer.remoteCid && cid !== peer.remoteCid && rcid !== peer.cid;
      if (meantForOld || fromNew) {
        if (s.type !== "offer") return;
        this.closePeer(peer); peer = undefined;
      }
    }
    if (!peer) { if (s.type !== "offer") return; peer = this.openPeer(v, cid); }
    if (cid && (!peer.remoteCid || rcid === peer.cid)) peer.remoteCid = cid;
    if (s.type === "offer" || s.type === "answer") {
      const d = s.payload.description as { type: string; sdp?: string } | undefined;
      if (d && (d.type === "offer" || d.type === "answer")) await peer.neg.description(d);
    } else if (s.type === "candidate") {
      if (s.payload.candidate) await peer.neg.candidate(s.payload.candidate);
    }
  }

  /** whose stream is whose, told to one peer (relayed streams included for observers) */
  private sendMeta(peer: Peer): void {
    const streams: Record<string, { member: string; kind: string }> = {};
    if (this.o.local && this.o.role !== "observer") streams[this.o.local.id] = { member: this.o.memberId, kind: "camera" };
    if (this.screen) streams[this.screen.id] = { member: this.o.memberId, kind: "screen" };
    if (this.o.role === "moderator" && peer.role === "observer") for (const src of this.relaySources()) streams[src.stream.id] = { member: src.member, kind: src.kind };
    this.queue({ to: peer.id, type: "meta", payload: { streams } });
  }

  /* -------------------------------------------- the moderator relays the room to observers */

  private relaySources(): { stream: MediaStream; member: string; kind: "camera" | "screen" }[] {
    const out: { stream: MediaStream; member: string; kind: "camera" | "screen" }[] = [];
    if (this.o.local) out.push({ stream: this.o.local, member: this.o.memberId, kind: "camera" });
    if (this.screen) out.push({ stream: this.screen, member: this.o.memberId, kind: "screen" });
    for (const p of this.peers.values()) {
      if (p.role === "observer") continue;
      for (const s of p.inbound.values()) out.push({ stream: s, member: this.owners.get(s.id)?.member ?? p.id, kind: this.owners.get(s.id)?.kind ?? "camera" });
    }
    return out;
  }

  private updateRelay(): void {
    if (this.o.role !== "moderator") return;
    const sources = this.relaySources();
    for (const p of this.peers.values()) {
      if (p.role !== "observer") continue;
      const want = new Map<string, { track: MediaStreamTrack; stream: MediaStream }>();
      for (const src of sources) for (const t of src.stream.getTracks()) if (t.readyState === "live") want.set(t.id, { track: t, stream: src.stream });
      let changed = false;
      for (const [tid, sender] of p.senders) if (!want.has(tid)) { try { p.pc.removeTrack(sender); } catch { /* closed */ } p.senders.delete(tid); changed = true; }
      for (const [tid, w] of want) if (!p.senders.has(tid)) {
        const sender = p.pc.addTrack(w.track, w.stream);
        p.senders.set(tid, sender);
        changed = true;
        if (w.track.kind === "video") {
          const params = sender.getParameters();
          if (params.encodings?.length) { params.encodings[0].maxBitrate = this.o.relayMaxBitrate ?? 350_000; void sender.setParameters(params).catch(() => {}); }
        }
      }
      if (changed) this.sendMeta(p);
    }
  }

  /* -------------------------------------------- what the page shows */

  tiles(): RemoteTile[] {
    const out: RemoteTile[] = [];
    const seen = new Set<string>();
    for (const p of this.peers.values()) {
      for (const s of p.inbound.values()) {
        if (seen.has(s.id) || !s.getTracks().length) continue;
        seen.add(s.id);
        const o = this.owners.get(s.id);
        out.push({ memberId: o?.member ?? p.id, kind: o?.kind ?? "camera", stream: s, via: p.id });
      }
    }
    return out;
  }
  private emitTiles(): void { this.o.onTiles(this.tiles()); }

  /* -------------------------------------------- this person's controls */

  setAudio(on: boolean): Promise<unknown> {
    for (const t of this.o.local?.getAudioTracks() ?? []) t.enabled = on;
    return this.o.call({ action: "op", op: { op: "media", audio: on } }).catch(() => null);
  }
  setVideo(on: boolean): Promise<unknown> {
    for (const t of this.o.local?.getVideoTracks() ?? []) t.enabled = on;
    return this.o.call({ action: "op", op: { op: "media", video: on } }).catch(() => null);
  }

  /** share the screen (a stimulus, a website): sent to every peer as a second video; the moderator also relays it */
  async shareScreen(stream: MediaStream | null): Promise<void> {
    if (this.screen) {
      for (const p of this.peers.values()) for (const t of this.screen.getTracks()) { const s = p.senders.get(t.id); if (s) { try { p.pc.removeTrack(s); } catch { /* */ } p.senders.delete(t.id); } }
      for (const t of this.screen.getTracks()) t.stop();
      this.screen = null;
    }
    if (stream) {
      this.screen = stream;
      for (const t of stream.getTracks()) t.onended = () => { void this.shareScreen(null); };
      for (const p of this.peers.values()) {
        if (p.role === "observer") continue;
        for (const t of stream.getTracks()) p.senders.set(t.id, p.pc.addTrack(t, stream));
        this.sendMeta(p);
      }
    }
    this.updateRelay();
    for (const p of this.peers.values()) if (p.role !== "observer") this.sendMeta(p);
    await this.o.call({ action: "op", op: { op: "media", screen: !!stream } }).catch(() => null);
  }

  /** connection health, for the page and the browser suite (getStats: state, bytes received per kind) */
  async stats(): Promise<{ peer: string; role: string; state: string; ice: string; inboundAudioBytes: number; inboundVideoBytes: number; outboundBytes: number }[]> {
    const out = [];
    for (const p of this.peers.values()) {
      let a = 0, v = 0, o = 0;
      try {
        const r = await p.pc.getStats();
        r.forEach((x: Record<string, unknown>) => {
          if (x.type === "inbound-rtp") { if (x.kind === "audio") a += Number(x.bytesReceived) || 0; else if (x.kind === "video") v += Number(x.bytesReceived) || 0; }
          if (x.type === "outbound-rtp") o += Number(x.bytesSent) || 0;
        });
      } catch { /* closed */ }
      out.push({ peer: p.id, role: p.role, state: p.pc.connectionState, ice: p.pc.iceConnectionState, inboundAudioBytes: a, inboundVideoBytes: v, outboundBytes: o });
    }
    return out;
  }
}

/* ------------------------------------------------------------ recording, in standalone chunks */

export interface RecordedChunk { blob: Blob; track: "audio" | "video"; seq: number; startMs: number; durationMs: number; mimeType: string }

const pick = (cands: string[]) => (typeof MediaRecorder !== "undefined" ? cands.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) ?? "" : "");
export const recordingSupported = () => typeof MediaRecorder !== "undefined";

/**
 * Records this person's OWN microphone (and, optionally, camera) in standalone chunks: the recorder is stopped
 * and restarted every `chunkSeconds`, so each chunk is a complete, playable file — uploaded as soon as it ends,
 * transcribed on its own, attributed to exactly one speaker. Chunk times are on the SERVER's clock (`clock`).
 */
export class LiveRecorder {
  private running = false;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: { recorders: { rec: MediaRecorder; track: "audio" | "video"; parts: Blob[]; mime: string }[]; startMs: number; seq: number } | null = null;
  constructor(private readonly o: { audio: MediaStream; video?: MediaStream | null; chunkSeconds: number; clock: () => number; onChunk: (c: RecordedChunk) => void; firstSeq?: number; seqOf?: (startMs: number) => number }) { this.seq = o.firstSeq ?? 0; }

  get active(): boolean { return this.running; }
  get nextSeq(): number { return this.seq; }

  start(): void { if (this.running || !recordingSupported()) return; this.running = true; this.begin(); }

  private begin(): void {
    if (!this.running) return;
    const audioMime = pick(["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]);
    const videoMime = pick(["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]);
    const recs: { rec: MediaRecorder; track: "audio" | "video"; parts: Blob[]; mime: string }[] = [];
    const add = (stream: MediaStream, track: "audio" | "video", mime: string, bps: number) => {
      try {
        const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), ...(track === "audio" ? { audioBitsPerSecond: bps } : { videoBitsPerSecond: bps }) });
        const entry = { rec, track, parts: [] as Blob[], mime: mime || rec.mimeType || (track === "audio" ? "audio/webm" : "video/webm") };
        rec.ondataavailable = (e) => { if (e.data && e.data.size) entry.parts.push(e.data); };
        recs.push(entry);
      } catch { /* this browser cannot record this stream */ }
    };
    add(this.o.audio, "audio", audioMime, 32_000);
    if (this.o.video) add(this.o.video, "video", videoMime, 600_000);
    if (!recs.length) { this.running = false; return; }
    const startMs = this.o.clock();
    const seq = this.o.seqOf ? this.o.seqOf(startMs) : this.seq++;
    this.current = { recorders: recs, startMs, seq };
    for (const r of recs) r.rec.start();
    this.timer = setTimeout(() => this.rotate(), this.o.chunkSeconds * 1000);
  }

  private rotate(): void {
    const cur = this.current;
    this.current = null;
    if (cur) this.finish(cur);
    this.begin();
  }

  private finish(cur: NonNullable<LiveRecorder["current"]>): void {
    const endMs = this.o.clock();
    for (const r of cur.recorders) {
      r.rec.onstop = () => {
        const blob = new Blob(r.parts, { type: r.mime.split(";")[0] });
        if (blob.size > 0) this.o.onChunk({ blob, track: r.track, seq: cur.seq, startMs: cur.startMs, durationMs: Math.max(0, endMs - cur.startMs), mimeType: r.mime.split(";")[0] });
      };
      try { r.rec.stop(); } catch { /* already stopped */ }
    }
  }

  /** stop recording; the last (partial) chunk is still delivered */
  stop(): void {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const cur = this.current;
    this.current = null;
    if (cur) this.finish(cur);
  }
}
