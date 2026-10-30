/**
 * AUDIT 2026-10-30 D12 — a script cannot lock a respondent out of an answer (renderer src/answerLock.ts, used by
 * the host DomBridge allow-list in uxDom.ts and by rs.hide / rs.setStyle in UxLayer.tsx).
 *
 *   node --experimental-strip-types --no-warnings --test packages/renderer/test/*.test.ts
 *
 * The renderer has no DOM in node; this drives the rule through a minimal element tree that implements the four
 * calls it makes (closest, matches, querySelector(All), getAttribute) for the selectors it uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerLockReason, HIDING_STYLE } from "../src/answerLock.ts";

type Attrs = Record<string, string>;
class El {
  parent: El | null = null;
  children: El[] = [];
  tag: string;
  attrs: Attrs;
  constructor(tag: string, attrs: Attrs = {}, kids: El[] = []) { this.tag = tag; this.attrs = attrs; for (const k of kids) { k.parent = this; this.children.push(k); } }
  getAttribute(n: string) { return n in this.attrs ? this.attrs[n] : null; }
  private one(sel: string): boolean {
    let rest = sel.trim();
    const not = /:not\((.*)\)$/.exec(rest);
    if (not) { if (this.one(not[1])) return false; rest = rest.slice(0, not.index); }
    const tag = /^[a-z]+/i.exec(rest)?.[0];
    if (tag && tag.toLowerCase() !== this.tag) return false;
    for (const m of rest.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      const v = this.getAttribute(m[1]);
      if (v == null || (m[2] !== undefined && v !== m[2])) return false;
    }
    return true;
  }
  matches(sel: string) { return sel.split(",").some((s) => this.one(s)); }
  closest(sel: string): El | null { for (let e: El | null = this; e; e = e.parent) if (e.matches(sel)) return e; return null; }
  querySelectorAll(sel: string): El[] { const out: El[] = []; const walk = (e: El) => { for (const c of e.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
}
const lock = (e: El) => answerLockReason(e as unknown as Element);

function page(required: boolean) {
  const input = new El("input", { type: "radio" });
  const label = new El("span", { class: "lbl" });
  const option = new El("label", { "data-rs-el": "option", "data-rs-id": "1" }, [input, label]);
  const list = new El("div", { class: "rs-options" }, [option]);
  const title = new El("div", { class: "rs-qtext" });
  const hiddenInput = new El("input", { type: "hidden" });
  const card = new El("div", { "data-qid": "q1", "data-rs-el": "question", ...(required ? { "data-rs-required": "1" } : {}) }, [title, list, hiddenInput]);
  const text = new El("textarea");
  const card2 = new El("div", { "data-qid": "q2" }, [new El("div", {}, [text])]);
  const shell = new El("div", { id: "rs-questions" }, [card, card2]);
  return { input, label, option, list, title, hiddenInput, card, card2, text, shell };
}

test("D12: answer inputs, options, things inside an option and things holding inputs are locked", () => {
  const p = page(false);
  for (const [name, el] of Object.entries({ input: p.input, label: p.label, option: p.option, list: p.list, text: p.text })) {
    assert.match(lock(el) ?? "", /answer input/, name);
  }
});

test("D12: decoration inside a card is not locked; a hidden input is not an answer control", () => {
  const p = page(true);
  assert.equal(lock(p.title), null);
  assert.equal(lock(p.hiddenInput), null);
});

test("D12: a whole card may be hidden only when it is not required; so may a container of cards", () => {
  assert.equal(lock(page(false).card), null);
  assert.match(lock(page(true).card) ?? "", /required question/);
  assert.equal(lock(page(false).shell), null);
  assert.match(lock(page(true).shell) ?? "", /required question/);
});

test("D12: the hiding declarations", () => {
  assert.equal(HIDING_STYLE("display", "none"), true);
  assert.equal(HIDING_STYLE("display", "none !important"), true);
  assert.equal(HIDING_STYLE("visibility", "hidden"), true);
  assert.equal(HIDING_STYLE("visibility", "collapse"), true);
  assert.equal(HIDING_STYLE("pointer-events", "none"), true);
  assert.equal(HIDING_STYLE("display", "flex"), false);
  assert.equal(HIDING_STYLE("color", "none"), false);
  assert.equal(HIDING_STYLE("opacity", "0.5"), false);
});
