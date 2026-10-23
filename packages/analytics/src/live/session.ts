import { LiveClient, LiveRecorder, recordingSupported, type Call, type RecordedChunk, type RemoteTile } from "./client.js";
import { connectLiveKit, type SfuMedia } from "./livekitAdapter.js";
import type { LiveView, LiveRole } from "./room.js";

/**
 * ONE PERSON'S LIVE SESSION IN THE BROWSER (2026-10-22, G2) — the controller both apps' pages use (the Studio's
 * moderator / observer console, the respondent app's participant and observer page): the connection client, the
 * recorder (started when the session goes live — only with this person's consent, never for an observer — and
 * stopped when it ends), and the upload queue for recorded chunks (each chunk retried until it lands; the uploader
 * itself is the app's, through the existing resumable media upload). Framework-free: a page subscribes to
 * snapshots (React's useSyncExternalStore).
 */

export interface SessionSnapshot {
  view: LiveView | null;
  extra: Record<string, unknown>;
  tiles: RemoteTile[];
  gone: string | null;
  error: string | null;
  audio: boolean;
  video: boolean;
  screen: boolean;
  recording: { supported: boolean; active: boolean; uploaded: number; pending: number; failed: number; lastError: string | null };
}

export interface LiveSessionOptions {
  call: Call;
  memberId: string;
  role: LiveRole;
  iceServers: RTCIceServer[];
  local: MediaStream | null;
  /** send one chunk through the app's uploader; throw to retry */
  upload?: (c: RecordedChunk) => Promise<void>;
}

/*
 * CHUNKS WAITING TO UPLOAD SURVIVE A RELOAD: each recorded chunk is kept in this browser's IndexedDB until the
 * server confirmed it, keyed by the member — a reloaded or reopened tab (the same link = the same member) sends
 * what the last one could not. Best effort: a private window without IndexedDB keeps them in memory only.
 */
const IDB = "rescript-live-chunks";
type Stored = RecordedChunk & { key: string };
function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((res) => { try { const r = indexedDB.open(IDB, 1); r.onupgradeneeded = () => r.result.createObjectStore("chunks"); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch { res(null); } });
}
async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((res) => { try { const r = fn(db.transaction("chunks", mode).objectStore("chunks")); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch { res(null); } });
}

export class LiveSession {
  readonly client: LiveClient;
  private recorder: LiveRecorder | null = null;
  private listeners = new Set<() => void>();
  private snap: SessionSnapshot;
  private queue: { chunk: RecordedChunk; tries: number; key: string }[] = [];
  private sending = false;
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: LiveSessionOptions) {
    const hasAudio = !!o.local?.getAudioTracks().length, hasVideo = !!o.local?.getVideoTracks().length;
    this.snap = { view: null, extra: {}, tiles: [], gone: null, error: null, audio: hasAudio, video: hasVideo, screen: false, recording: { supported: recordingSupported(), active: false, uploaded: 0, pending: 0, failed: 0, lastError: null } };
    this.client = new LiveClient({
      call: o.call, memberId: o.memberId, role: o.role, iceServers: o.iceServers, local: o.role === "observer" ? null : o.local,
      onView: (view, extra) => { this.set({ view, extra, ...(this.sfuNote ? {} : { error: null }) }); this.syncRecording(view); this.syncSfu(view, extra); if (view.me.mutedByModerator && this.snap.audio) this.set({ audio: false }); },
      onTiles: (tiles) => { if (!this.sfu) this.set({ tiles }); },
      onGone: (reason) => { this.set({ gone: reason }); this.stopRecording(); },
      onError: (message) => this.set({ error: message }),
    });
  }

  get snapshot(): SessionSnapshot { return this.snap; }
  /** this person's own camera + microphone (null for an observer) and the screen they share */
  get localStream(): MediaStream | null { return this.o.role === "observer" ? null : this.o.local; }
  get screenStream(): MediaStream | null { return this.client.screenStream; }
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  private set(p: Partial<SessionSnapshot>) { this.snap = { ...this.snap, ...p }; for (const l of this.listeners) l(); }

  start(): void {
    this.client.start();
    /* what a previous tab of this member recorded but could not upload */
    if (this.o.upload) void idb<Stored[]>("readonly", (st) => st.getAll() as IDBRequest<Stored[]>).then((rows) => { for (const c of rows ?? []) { if (c.startMs < Date.now() - 86_400_000) { void idb("readwrite", (st) => st.delete(c.key)); continue; } if (c.key.startsWith(`${this.o.memberId}:`) && !this.queue.some((q) => q.key === c.key)) this.queue.push({ chunk: c, tries: 0, key: c.key }); } if (this.queue.length) { this.set({ recording: { ...this.snap.recording, pending: this.queue.length } }); void this.drain(); } });
    /* a chunk that would not upload is tried again every 20 s while the page is open */
    this.retryTimer = setInterval(() => { if (this.queue.length) void this.drain(); }, 20_000);
  }

  async stop(): Promise<void> {
    this.stopRecording();
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
    await this.client.stop();
    await this.sfu?.close().catch(() => {});
    for (const t of this.o.local?.getTracks() ?? []) t.stop();
  }

  /* -------------------------------------------- the SFU (LiveKit), when the room is scheduled on it */

  private sfu: SfuMedia | null = null;
  private sfuTried = false;
  private sfuNote: string | null = null;
  private syncSfu(view: LiveView, extra: Record<string, unknown>): void {
    if (view.room.transport !== "sfu" || view.me.state !== "admitted" || this.sfuTried) return;
    const lk = (extra.connection as { livekit?: { url: string; token: string; clientUrl: string | null } } | undefined)?.livekit;
    if (!lk) return;
    this.sfuTried = true;
    if (!lk.clientUrl) { this.sfuNote = "This session is set up for LiveKit, but its browser client is not configured (LIVEKIT_CLIENT_URL): using the built-in connection instead."; this.set({ error: this.sfuNote }); return; }
    connectLiveKit({ clientUrl: lk.clientUrl, url: lk.url, token: lk.token, local: this.o.role === "observer" ? null : this.o.local, onTiles: (tiles) => this.set({ tiles }) })
      .then((m) => { this.sfu = m; this.client.useSfu(true); this.set({ tiles: m.tiles() }); })
      .catch((e) => { this.sfuNote = `LiveKit could not be reached (${(e as Error).message}): using the built-in connection instead.`; this.set({ error: this.sfuNote }); });
  }

  /* -------------------------------------------- controls */

  async setAudio(on: boolean): Promise<void> { this.set({ audio: on }); this.sfu?.setAudio(on); await this.client.setAudio(on); }
  async setVideo(on: boolean): Promise<void> { this.set({ video: on }); this.sfu?.setVideo(on); await this.client.setVideo(on); }
  async shareScreen(stream: MediaStream | null): Promise<void> {
    if (this.sfu) { await this.sfu.shareScreen(stream); this.set({ screen: !!stream }); await this.o.call({ action: "op", op: { op: "media", screen: !!stream } }).catch(() => null); return; }
    await this.client.shareScreen(stream);
    this.set({ screen: !!stream });
    if (stream) for (const t of stream.getTracks()) t.addEventListener("ended", () => this.set({ screen: false }));
  }
  op(op: Record<string, unknown>): Promise<Record<string, unknown>> { return this.o.call({ action: "op", op }); }
  chat(text: string): Promise<Record<string, unknown>> { return this.o.call({ action: "chat", text }); }
  note(text: string): Promise<Record<string, unknown>> { return this.o.call({ action: "note", text }); }
  async leave(): Promise<void> { await this.o.call({ action: "op", op: { op: "leave" } }).catch(() => null); await this.stop(); this.set({ gone: "left" }); }

  /* -------------------------------------------- recording */

  private syncRecording(view: LiveView): void {
    const should = view.room.status === "live" && view.room.record && view.me.recordingConsent && this.o.role !== "observer" && view.me.state === "admitted" && !!this.o.local?.getAudioTracks().length && !!this.o.upload;
    if (should && !this.recorder) {
      const audio = new MediaStream(this.o.local!.getAudioTracks());
      const video = view.room.recordVideo && this.o.local!.getVideoTracks().length ? this.o.local : null;
      /* a chunk's number is the second of the session it started at: unique per person, and a reloaded tab never reuses one */
      const origin = Date.parse(view.room.startedAt ?? "") || this.client.serverNow;
      this.recorder = new LiveRecorder({ audio, video, chunkSeconds: view.room.chunkSeconds, clock: () => this.client.serverNow, onChunk: (c) => this.enqueue(c), seqOf: (startMs) => Math.max(0, Math.floor((startMs - origin) / 1000)) });
      this.recorder.start();
      this.set({ recording: { ...this.snap.recording, active: this.recorder.active } });
    } else if (!should && this.recorder && (view.room.status !== "live" || view.me.state !== "admitted")) {
      this.stopRecording();
    }
  }

  private stopRecording(): void {
    if (!this.recorder) return;
    this.recorder.stop();
    this.recorder = null;
    this.set({ recording: { ...this.snap.recording, active: false } });
  }

  private enqueue(chunk: RecordedChunk): void {
    const key = `${this.o.memberId}:${chunk.track}:${chunk.seq}`;
    void idb("readwrite", (st) => st.put({ ...chunk, key }, key));
    this.queue.push({ chunk, tries: 0, key });
    this.set({ recording: { ...this.snap.recording, pending: this.queue.length } });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.sending || !this.o.upload) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const item = this.queue[0];
        try {
          await this.o.upload(item.chunk);
          this.queue.shift();
          void idb("readwrite", (st) => st.delete(item.key));
          this.set({ recording: { ...this.snap.recording, uploaded: this.snap.recording.uploaded + 1, pending: this.queue.length, failed: this.snap.recording.failed, lastError: null } });
        } catch (e) {
          item.tries++;
          this.set({ recording: { ...this.snap.recording, pending: this.queue.length, lastError: (e as Error).message } });
          if (item.tries >= 3) { this.queue.push(this.queue.shift()!); if (this.queue.every((q) => q.tries >= 3)) { this.set({ recording: { ...this.snap.recording, failed: this.queue.length } }); break; } }
          else await new Promise((r) => setTimeout(r, 1500 * item.tries));
        }
      }
    } finally { this.sending = false; }
  }
}
