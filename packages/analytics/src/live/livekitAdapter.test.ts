import { test } from "node:test";
import assert from "node:assert/strict";
import { connectLiveKit, loadLiveKitClient } from "./livekitAdapter.js";
import { readScheduleInput } from "./room.js";

/*
 * THE LIVEKIT ADAPTER (bundled browser client, 2026-11-23). The real client needs a browser and a LiveKit server;
 * here the module is a stand-in with livekit-client v2's shape (Room, RoomEvent, Track.Source), so what is checked
 * is the adapter's own work: which module is loaded, the URL and token it connects with, what it publishes and how
 * remote tracks become tiles. scripts/livekit-bundled-browser.mjs loads the real bundled chunk in Chromium.
 */

class FakeStream { tracks: { id: string; kind: string }[] = []; addTrack(t: { id: string; kind: string }) { this.tracks.push(t); } removeTrack(t: { id: string }) { this.tracks = this.tracks.filter((x) => x.id !== t.id); } getTracks() { return this.tracks; } getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); } getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); } }
(globalThis as Record<string, unknown>).MediaStream = FakeStream;

function fakeModule() {
  const log: unknown[][] = [];
  const handlers = new Map<string, (...a: unknown[]) => void>();
  class Room {
    constructor(public opts: unknown) { log.push(["new Room", opts]); }
    on(ev: string, fn: (...a: unknown[]) => void) { handlers.set(ev, fn); return this; }
    async connect(url: string, token: string) { log.push(["connect", url, token]); }
    async disconnect() { log.push(["disconnect"]); }
    localParticipant = {
      publishTrack: async (t: { id: string }, o: { source: string }) => { log.push(["publish", t.id, o.source]); return { track: t }; },
      unpublishTrack: async (t: { id: string }) => { log.push(["unpublish", t.id]); },
    };
  }
  const mod = { Room, RoomEvent: { TrackSubscribed: "ts", TrackUnsubscribed: "tu", ParticipantDisconnected: "pd" }, Track: { Source: { Microphone: "mic", Camera: "cam", ScreenShare: "screen", ScreenShareAudio: "screen_audio" } } };
  return { mod, log, fire: (ev: string, ...a: unknown[]) => handlers.get(ev)!(...a) };
}

test("the bundled client is used unless LIVEKIT_CLIENT_URL names an operator's copy; a non-https copy is refused", async () => {
  const f = fakeModule();
  const asked: (string | null)[] = [];
  await connectLiveKit({ url: "wss://p.livekit.cloud", token: "T", local: null, onTiles: () => {}, load: async (u) => { asked.push(u); return f.mod; } });
  await connectLiveKit({ clientUrl: "https://cdn.example.org/livekit-client.esm.mjs", url: "wss://p.livekit.cloud", token: "T", local: null, onTiles: () => {}, load: async (u) => { asked.push(u); return f.mod; } });
  assert.deepEqual(asked, [null, "https://cdn.example.org/livekit-client.esm.mjs"]);
  await assert.rejects(loadLiveKitClient("http://cdn.example.org/lk.mjs"), /must be an https URL/);
});

test("connects with the room's URL and token, publishes camera and microphone with their sources, turns remote tracks into tiles", async () => {
  const f = fakeModule();
  const local = new FakeStream(); local.addTrack({ id: "a1", kind: "audio" }); local.addTrack({ id: "v1", kind: "video" });
  let tiles: { memberId: string; kind: string; via: string }[] = [];
  const m = await connectLiveKit({ url: "wss://p.livekit.cloud", token: "JWT", local: local as unknown as MediaStream, onTiles: (t) => { tiles = t as typeof tiles; }, load: async () => f.mod });
  assert.deepEqual(f.log.find((l) => l[0] === "connect"), ["connect", "wss://p.livekit.cloud", "JWT"]);
  assert.deepEqual(f.log.filter((l) => l[0] === "publish"), [["publish", "a1", "mic"], ["publish", "v1", "cam"]]);
  f.fire("ts", { mediaStreamTrack: { id: "r1", kind: "video" } }, { source: "cam" }, { identity: "member-2" });
  f.fire("ts", { mediaStreamTrack: { id: "r2", kind: "video" } }, { source: "screen" }, { identity: "member-2" });
  assert.deepEqual(tiles.map((t) => [t.memberId, t.kind, t.via]), [["member-2", "camera", "sfu"], ["member-2", "screen", "sfu"]]);
  f.fire("pd", { identity: "member-2" });
  assert.deepEqual(tiles, []);
  /* screen share: published as a screen source, replaced cleanly */
  const scr = new FakeStream(); scr.addTrack({ id: "s1", kind: "video" });
  await m.shareScreen(scr as unknown as MediaStream);
  await m.shareScreen(null);
  assert.deepEqual(f.log.filter((l) => l[0] === "publish" || l[0] === "unpublish").slice(2), [["publish", "s1", "screen"], ["unpublish", "s1"]]);
  await m.close();
  assert.ok(f.log.some((l) => l[0] === "disconnect"));
});

test("an observer publishes nothing", async () => {
  const f = fakeModule();
  await connectLiveKit({ url: "wss://p.livekit.cloud", token: "JWT", local: null, onTiles: () => {}, load: async () => f.mod });
  assert.equal(f.log.filter((l) => l[0] === "publish").length, 0);
});

test("scheduling: LiveKit by default once it is configured; the built-in connection when asked for", () => {
  const d = readScheduleInput({ title: "Group", settings: { maxParticipants: 10 } }, { sfuAvailable: true });
  assert.ok(d.ok && d.value.settings.transport === "sfu");
  const mesh = readScheduleInput({ title: "Small", settings: { maxParticipants: 4, transport: "mesh" } }, { sfuAvailable: true });
  assert.ok(mesh.ok && mesh.value.settings.transport === "mesh");
  const tooBig = readScheduleInput({ title: "Big", settings: { maxParticipants: 10, transport: "mesh" } }, { sfuAvailable: true });
  assert.ok(!tooBig.ok && /at most 6 participants/.test(tooBig.error));
  const none = readScheduleInput({ title: "Group", settings: { maxParticipants: 4 } });
  assert.ok(none.ok && none.value.settings.transport === "mesh");
});
