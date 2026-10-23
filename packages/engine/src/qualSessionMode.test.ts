import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceQualAction, sessionMode } from "./qualActions.js";

/* Production 2026-10-23: "Create a 20-minute interview guide about why customers switch broadband providers" — the
 * model wrote sessionPlan.mode "video" and the whole guide was refused ($0.16, nothing created). */

const GUIDE = { kind: "interview", title: "Broadband switching", durationMinutes: 20, sections: [{ title: "Opening", kind: "opening", questions: ["Tell me about your broadband."] }, { title: "Closing", kind: "closing", questions: ["Anything else?"] }] };

test("mode words a model uses map to the four modes", () => {
  for (const [w, m] of [["video", "remote"], ["Video call", "remote"], ["online", "remote"], ["Zoom", "remote"], ["MS Teams", "remote"], ["telephone", "phone"], ["phone call", "phone"], ["face-to-face", "in_person"], ["In person", "in_person"], ["hybrid", "mixed"], ["remote", "remote"], ["mixed", "mixed"]] as const) assert.equal(sessionMode(w), m, w);
  assert.equal(sessionMode("carrier pigeon"), undefined);
});

test("the production guide (mode video) is accepted, as remote", () => {
  const a = coerceQualAction("create_qual_guide", { ...GUIDE, sessionPlan: { sessions: 12, mode: "video" } });
  assert.equal(typeof a, "object", String(a));
  assert.equal((a as { sessionPlan?: { mode?: string } }).sessionPlan?.mode, "remote");
});

test("an unknown mode drops the mode, never the guide", () => {
  const a = coerceQualAction("create_qual_guide", { ...GUIDE, sessionPlan: { sessions: 12, mode: "carrier pigeon" } }) as { sessionPlan?: { sessions?: number; mode?: string } };
  assert.equal(typeof a, "object");
  assert.equal(a.sessionPlan?.sessions, 12);
  assert.equal(a.sessionPlan?.mode, undefined);
});
