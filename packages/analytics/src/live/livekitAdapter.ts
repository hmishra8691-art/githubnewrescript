import type { RemoteTile } from "./client.js";

/**
 * THE LIVEKIT (SFU) ADAPTER — ISOLATED, AND HONEST ABOUT ITS DEPENDENCY (2026-10-22, G2).
 *
 * LiveKit's client protocol (protobuf messages over its own websocket signalling, then WebRTC to the SFU) cannot
 * reasonably be spoken without its SDK, and this repository adds no vendor SDK. So the browser side LOADS the
 * operator's own copy of `livekit-client` at run time, from LIVEKIT_CLIENT_URL (an https URL of an ESM build they
 * host and trust), only for a room scheduled on the SFU. Without it the room falls back to the built-in mesh (which
 * carries at most 6 participants) and says so.
 *
 * Written against livekit-client v2's documented API (Room, RoomEvent, Track.Source, publishTrack). It was NOT
 * exercised here: there is no LiveKit server and no client build in this environment. Token minting (the server
 * half) is tested in liveCredentials.test.ts. The room logic — waiting room, admit, stimuli, chat, notes, recording
 * — stays Rescript's; only the media goes through the SFU.
 */

export interface SfuMedia {
  tiles(): RemoteTile[];
  setAudio(on: boolean): void;
  setVideo(on: boolean): void;
  shareScreen(stream: MediaStream | null): Promise<void>;
  close(): Promise<void>;
}

/* the slice of livekit-client this adapter uses, typed loosely (the module is the operator's) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export async function connectLiveKit(o: { clientUrl: string; url: string; token: string; local: MediaStream | null; onTiles: (t: RemoteTile[]) => void }): Promise<SfuMedia> {
  if (!/^https:\/\//i.test(o.clientUrl)) throw new Error("LIVEKIT_CLIENT_URL must be an https URL of an ESM build of livekit-client");
  const lk: Any = await import(/* webpackIgnore: true */ o.clientUrl);
  const room: Any = new lk.Room({ adaptiveStream: true, dynacast: true });
  /* member id (the token's identity) → its camera and screen streams */
  const streams = new Map<string, { camera: MediaStream; screen: MediaStream }>();
  const of = (identity: string) => { let s = streams.get(identity); if (!s) { s = { camera: new MediaStream(), screen: new MediaStream() }; streams.set(identity, s); } return s; };
  const tiles = (): RemoteTile[] => [...streams.entries()].flatMap(([member, s]) => [
    ...(s.camera.getTracks().length ? [{ memberId: member, kind: "camera" as const, stream: s.camera, via: "sfu" }] : []),
    ...(s.screen.getTracks().length ? [{ memberId: member, kind: "screen" as const, stream: s.screen, via: "sfu" }] : []),
  ]);
  const emit = () => o.onTiles(tiles());
  const isScreen = (pub: Any) => pub?.source === lk.Track.Source.ScreenShare || pub?.source === lk.Track.Source.ScreenShareAudio;
  room.on(lk.RoomEvent.TrackSubscribed, (track: Any, pub: Any, participant: Any) => { const s = of(participant.identity); (isScreen(pub) ? s.screen : s.camera).addTrack(track.mediaStreamTrack); emit(); });
  room.on(lk.RoomEvent.TrackUnsubscribed, (track: Any, pub: Any, participant: Any) => { const s = of(participant.identity); (isScreen(pub) ? s.screen : s.camera).removeTrack(track.mediaStreamTrack); emit(); });
  room.on(lk.RoomEvent.ParticipantDisconnected, (participant: Any) => { streams.delete(participant.identity); emit(); });
  await room.connect(o.url, o.token);
  const published = new Map<string, Any>();
  for (const t of o.local?.getTracks() ?? []) published.set(t.id, await room.localParticipant.publishTrack(t, { source: t.kind === "audio" ? lk.Track.Source.Microphone : lk.Track.Source.Camera }));
  let screen: MediaStream | null = null;
  return {
    tiles,
    setAudio(on) { for (const t of o.local?.getAudioTracks() ?? []) t.enabled = on; },
    setVideo(on) { for (const t of o.local?.getVideoTracks() ?? []) t.enabled = on; },
    async shareScreen(stream) {
      for (const t of screen?.getTracks() ?? []) { const p = published.get(t.id); if (p?.track) await room.localParticipant.unpublishTrack(p.track); published.delete(t.id); }
      screen = stream;
      for (const t of stream?.getTracks() ?? []) published.set(t.id, await room.localParticipant.publishTrack(t, { source: t.kind === "audio" ? lk.Track.Source.ScreenShareAudio : lk.Track.Source.ScreenShare }));
    },
    async close() { await room.disconnect(); streams.clear(); emit(); },
  };
}
