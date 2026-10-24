import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openDraft, editDraft, isDirty, saveBlockedReason, requestClose, keepEditing, commitDraft, reconcileSaved, stableKey, cloneValue,
} from "./draft.ts";

const COND = { type: "group", op: "and", children: [{ type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "yes" }] };

test("opening clones the saved value — editing the draft never touches it", () => {
  const s = openDraft(COND);
  assert.deepEqual(s.draft, COND);
  assert.notEqual(s.draft, COND, "a copy, not the same object");
  const edited = editDraft(s, (d: any) => ({ ...d, op: "or" }));
  assert.equal(edited.draft.op, "or");
  assert.equal(edited.saved.op, "and", "the saved copy is untouched");
  assert.equal(COND.op, "and", "and so is the caller's object");
});

test("dirty is structural: key order and undefined members do not count", () => {
  const s = openDraft({ a: 1, b: { c: [1, 2] } });
  assert.equal(isDirty(s), false);
  assert.equal(isDirty(editDraft(s, { b: { c: [1, 2] }, a: 1 } as any)), false, "same shape, other key order");
  assert.equal(isDirty(editDraft(s, { a: 1, b: { c: [1, 2] }, when: undefined } as any)), false, "an undefined member is no member");
  assert.equal(isDirty(editDraft(s, { a: 1, b: { c: [1, 2, 3] } } as any)), true);
  assert.equal(isDirty(openDraft(undefined)), false, "an absent value opens clean");
  assert.equal(isDirty(editDraft(openDraft<unknown>(undefined), COND)), true, "and becomes dirty when something is built");
});

test("Save is blocked while clean, and by the validator while dirty", () => {
  const s = openDraft([{ id: "r1", target: { kind: "end" } }]);
  assert.equal(saveBlockedReason(s), "No changes to save");
  const dirty = editDraft(s, (d: any[]) => [...d, { id: "r2", target: { kind: "question" } }]);
  assert.equal(saveBlockedReason(dirty), null, "a valid change can be saved");
  const validate = (rules: any[]) => rules.some((r) => r.target.kind === "question" && !r.target.ref) ? "Rule 2 has no target question" : null;
  assert.equal(saveBlockedReason(dirty, validate), "Rule 2 has no target question");
  const fixed = editDraft(dirty, (d: any[]) => d.map((r) => (r.id === "r2" ? { ...r, target: { kind: "question", ref: "q9" } } : r)));
  assert.equal(saveBlockedReason(fixed, validate), null);
});

test("closing a clean dialog closes it; closing a dirty one asks first", () => {
  const clean = openDraft(COND);
  assert.equal(requestClose(clean).close, true);
  const dirty = editDraft(clean, (d: any) => ({ ...d, op: "or" }));
  const first = requestClose(dirty);
  assert.equal(first.close, false, "Escape / backdrop / Cancel on a dirty draft does not close");
  assert.equal(first.state.confirmingDiscard, true, "…it asks");
  assert.equal(requestClose(first.state).close, true, "asking again (Discard) closes");
  const kept = keepEditing(first.state);
  assert.equal(kept.confirmingDiscard, false, "Keep editing withdraws the question");
  assert.equal(isDirty(kept), true, "and the edits are still there");
  const typedAfterAsk = editDraft(first.state, (d: any) => ({ ...d, op: "not" }));
  assert.equal(typedAfterAsk.confirmingDiscard, false, "an edit also withdraws it");
});

test("Save commits the draft and the dialog reopens on what it saved", () => {
  const s = editDraft(openDraft(COND), (d: any) => ({ ...d, op: "or" }));
  const { value, state } = commitDraft(s);
  assert.equal((value as any).op, "or", "the committed value is the draft");
  assert.equal(isDirty(state), false, "after Save there is nothing unsaved");
  assert.equal((state.saved as any).op, "or", "reopening shows the saved configuration");
});

test("the saved value changing underneath: a clean dialog follows it, a dirty one keeps its edits", () => {
  const clean = openDraft(COND);
  const followed = reconcileSaved(clean, { ...COND, op: "or" });
  assert.equal((followed.draft as any).op, "or", "a clean dialog never shows a stale copy");
  const dirty = editDraft(clean, (d: any) => ({ ...d, op: "not" }));
  const kept = reconcileSaved(dirty, { ...COND, op: "or" });
  assert.equal((kept.draft as any).op, "not", "the person's edits are not thrown away");
  assert.equal((kept.saved as any).op, "or", "but Cancel now returns to the new saved value");
  assert.equal(reconcileSaved(dirty, COND), dirty, "an unchanged saved value is a no-op (same object)");
});

test("stableKey and cloneValue handle the shapes the builders produce", () => {
  assert.equal(stableKey(undefined), "undefined");
  assert.equal(stableKey({ b: [{ y: 1, x: 2 }], a: null }), '{"a":null,"b":[{"x":2,"y":1}]}');
  const rules = [{ id: "a", when: COND, target: { kind: "page", ref: "p1" } }];
  const copy = cloneValue(rules);
  assert.deepEqual(copy, rules);
  assert.notEqual(copy[0].when, rules[0].when, "deep copy");
});

test("the logic surface preference: default 'workspace' (the compact panel), 'inline' only as an explicit opt-out", async () => {
  const { parseLogicSurface, readLogicSurface, writeLogicSurface, LOGIC_SURFACE_KEY, DEFAULT_LOGIC_SURFACE } = await import("./surface.ts");
  assert.equal(DEFAULT_LOGIC_SURFACE, "workspace", "the client's requirement: the popup is the default");
  assert.equal(parseLogicSurface(null), "workspace");
  assert.equal(parseLogicSurface("inline"), "inline");
  assert.equal(parseLogicSurface("sideways"), "workspace");
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
  assert.equal(readLogicSurface(storage), "workspace");
  writeLogicSurface(storage, "inline");
  assert.equal(store.get(LOGIC_SURFACE_KEY), "inline");
  assert.equal(readLogicSurface(storage), "inline");
  writeLogicSurface(storage, "workspace");
  assert.equal(store.has(LOGIC_SURFACE_KEY), false, "the default is stored as nothing");
  assert.equal(readLogicSurface(null), "workspace", "no storage at all (SSR) is the default");
  assert.equal(readLogicSurface({ getItem() { throw new Error("blocked"); } }), "workspace", "a throwing storage is the default");
});
