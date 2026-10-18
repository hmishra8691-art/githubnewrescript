import { test } from "node:test";
import assert from "node:assert/strict";
import { REPORT_THEMES } from "@rescript/analytics";
import { sandboxPut, sandboxFind, sandboxLines, sandboxGet, fromBase64, toBase64, sandboxTheme, setSandboxTheme, sandboxSaveTheme, SANDBOX_ARTIFACTS_KEY } from "./sandboxStore.ts";

/* the sandbox-only store (sessionStorage): a reload finds the document, the same inputs are not stored twice, two versions kept, a full tab degrades */
class FakeStorage {
  m = new Map<string, string>(); quota: number;
  constructor(quota = 5_000_000) { this.quota = quota; }
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { if (v.length > this.quota) throw new Error("QuotaExceededError"); this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

test("a document kept in the tab survives a 'reload' (a new read), is found by its fingerprint, and is not stored twice", () => {
  const s = new FakeStorage() as unknown as Storage;
  const a = sandboxPut(s, { type: "research_plan_docx", edition: "standard", fingerprint: "fp1", name: "plan.docx", mime: "x" }, bytes(1000))!;
  assert.equal(a.version, 1);
  const again = sandboxPut(s, { type: "research_plan_docx", edition: "standard", fingerprint: "fp1", name: "plan.docx", mime: "x" }, bytes(1000, 9))!;
  assert.equal(again.id, a.id, "the same inputs are the same document");
  assert.deepEqual([...fromBase64(sandboxFind(s, "research_plan_docx", "standard", "fp1")!.base64)], [...bytes(1000)]);
  const v2 = sandboxPut(s, { type: "research_plan_docx", edition: "standard", fingerprint: "fp2", name: "plan.docx", mime: "x" }, bytes(1200))!;
  const v3 = sandboxPut(s, { type: "research_plan_docx", edition: "standard", fingerprint: "fp2", name: "plan.docx", mime: "x", regenerate: true }, bytes(1300))!;
  assert.deepEqual([v2.version, v3.version], [2, 3]);
  const lines = sandboxLines(s);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].versions.map((v) => v.version), [3, 2], "two versions kept in a tab");
  assert.equal(sandboxGet(s, a.id), null, "the oldest was dropped");
  assert.deepEqual([...fromBase64(toBase64(new Uint8Array([0, 255, 128])))], [0, 255, 128]);
});

test("a full tab drops the oldest documents instead of failing; nothing at all is stored where storage is unavailable", () => {
  const s = new FakeStorage(6_000) as unknown as Storage;
  sandboxPut(s, { type: "proposal_docx", edition: "standard", fingerprint: "a", name: "a", mime: "x" }, bytes(3000));
  const b = sandboxPut(s, { type: "sap_docx", edition: "standard", fingerprint: "b", name: "b", mime: "x" }, bytes(3000));
  assert.ok(b);
  const lines = sandboxLines(s).map((l) => l.type);
  assert.deepEqual(lines, ["sap_docx"], "the older document made room");
  assert.equal(sandboxPut(null, { type: "sap_docx", edition: "standard", fingerprint: "b", name: "b", mime: "x" }, bytes(10)), null);
  assert.ok((s as unknown as FakeStorage).m.has(SANDBOX_ARTIFACTS_KEY));
});

test("the sandbox's report theme and its named themes live in the tab, with versions by name", () => {
  const s = new FakeStorage() as unknown as Storage;
  assert.deepEqual(sandboxTheme(s), { theme: null, structure: null, saved: [] });
  setSandboxTheme(s, { theme: REPORT_THEMES[1], structure: { order: ["summary", "hypotheses"], understood: "x" } });
  assert.equal(sandboxTheme(s).theme!.name, "Healthcare Analytics");
  const one = sandboxSaveTheme(s, REPORT_THEMES[0], "Board Pack");
  const two = sandboxSaveTheme(s, REPORT_THEMES[2], "board pack");
  assert.equal(one.version, 1); assert.equal(two.version, 2); assert.equal(two.id, one.id); assert.equal(two.name, "Board Pack");
  assert.equal(sandboxTheme(s).saved.length, 1);
});
