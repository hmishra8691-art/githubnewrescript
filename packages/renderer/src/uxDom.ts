import { checkDeclarations } from "@rescript/engine";
import type { UxTarget } from "@rescript/schema";

/**
 * THE HOST HALF OF THE SURVEY DOCUMENT A SCRIPT SEES.
 *
 * `uxSandbox.ts` is the frame; this is the page it is a mirror OF. It does
 * three things and refuses everything else:
 *
 *   1. SNAPSHOT — turns the survey shell into a small, sanitised tree the
 *      frame rebuilds as a real DOM. No scripts, styles, frames, links or
 *      image/media sources; no password values; ids are stable per element
 *      (a WeakMap), so a re-render of the page updates the mirror in place.
 *   2. APPLY — takes the operations the frame derived from the script's own
 *      changes and applies each to the matching real element, after checking
 *      it against an allow-list (class tokens, CSS through the engine's
 *      declaration gate, a short list of attributes, a short list of tags a
 *      script may create). Everything it changes is recorded so it can be put
 *      back when the page is left.
 *   3. FORWARD — hands the page's real events (click, input, change, focus,
 *      keydown, mouseover…) to the frame, but only the kinds a script has said
 *      it listens for.
 *
 * It never lets a script change an answer: `value`, `checked` and `id`-like
 * attributes are not in the allow-list, and there is no operation for them.
 */

type Id = number | string;
export interface TextSpec { i: number; x: string }
export interface ElSpec { i: number; t: string; a: Record<string, string>; k: Spec[]; v?: string; c?: boolean }
export type Spec = TextSpec | ElSpec;
export interface DomTree { html: ElSpec; body: ElSpec; shell: ElSpec }
interface CTree { c?: string; t?: string; a?: Record<string, string>; k?: CTree[]; x?: string }
export type DomOp =
  | { o: "class"; n: Id; add?: string[]; rem?: string[] }
  | { o: "style"; n: Id; set?: Record<string, string>; rem?: string[] }
  | { o: "attr"; n: Id; name: string; value: string | null }
  | { o: "create"; c: string; p: Id; b: Id | null; tree: CTree }
  | { o: "replace"; c: string; tree: CTree }
  | { o: "remove"; c: string };

const ids = new WeakMap<Node, number>();
let nextId = 1;
const idOf = (n: Node): number => { let i = ids.get(n); if (i == null) { i = nextId++; ids.set(n, i); } return i; };

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "TEMPLATE", "BASE"]);
const FLAT_TAGS = new Set(["SVG", "CANVAS", "VIDEO", "AUDIO", "PICTURE", "MAP"]); // present, but their insides are not mirrored
const DROP_ATTR = /^(on|src|srcset|href|xlink|action|formaction|srcdoc|poster|nonce|integrity|ping|data$|manifest|background|codebase|content$)/i;
const MAX_NODES = 6000, MAX_TEXT = 2000, MAX_DEPTH = 60, MAX_OPS = 2000;

/** the tags a script may create, and the attributes each may carry */
const CREATE_TAGS = new Set(["div", "span", "p", "b", "i", "u", "em", "strong", "small", "sub", "sup", "br", "hr", "ul", "ol", "li", "a", "button", "label", "h1", "h2", "h3", "h4", "h5", "h6", "code", "pre", "blockquote", "section", "header", "footer", "nav", "aside", "mark", "kbd", "abbr"]);
const TOKEN = /^[A-Za-z_][\w:-]{0,63}$/;

/**
 * RUNTIME-08: the respondent's way forward is not a script's to take away. An
 * element that IS the Next button or the navigation bar, sits inside it, or
 * holds it (the page shell) may not be hidden or disabled — a script that did
 * so left the respondent on a page with no way off it. Classes and inline
 * styles stay allowed: restyling the button is the point of a UX script.
 */
export const isNavTarget = (el: Element): boolean =>
  !!el.closest('[data-testid="rs-next"], .rs-nav')
  || !!el.querySelector('[data-testid="rs-next"], .rs-nav');

export const attrAllowed = (name: string, el?: Element | null): boolean =>
  ((name !== "hidden" && name !== "disabled") || !el || !isNavTarget(el)) && (
  name === "hidden" || name === "disabled" || name === "title" || name === "role" || name === "tabindex"
  || /^aria-[a-z-]{1,40}$/.test(name)
  || (/^data-[a-z0-9_.:-]{1,60}$/.test(name) && !/^data-(rs-|qid$|testid$)/.test(name)));

interface Touched {
  /** whether each class token was present before the script first touched it */
  orig: Map<string, boolean>;
  add: Set<string>;
  rem: Set<string>;
  /** the attribute before the script first touched it, and the value the script wants */
  attrPrev: Map<string, string | null>;
  attrWant: Map<string, string | null>;
  /** the inline property before the script first touched it: [value, priority] */
  stylePrev: Map<string, [string, string]>;
}

export interface DomBridgeOptions {
  root: HTMLElement;
  /** the behaviour this belongs to — marks what it creates, so its own snapshot leaves it out */
  id: string;
  owner: UxTarget;
  log: (line: string) => void;
  post: (message: Record<string, unknown>) => void;
  /**
   * The survey is drawn inside another page (the Studio's preview). What a script adds to
   * document.body — a popup, an overlay — then goes into the survey's shell instead, so it can never
   * cover or block the page around it. In the respondent's survey the body IS the survey page.
   */
  contain?: boolean;
}

export class DomBridge {
  private byId = new Map<number, Node>();
  private created = new Map<string, Node>();
  private createdIds = new WeakMap<Node, string>();
  private tops = new Set<Node>();
  private touched = new Map<Element, Touched>();
  private listeners = new Map<string, EventListener>();
  private mo: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = "";
  private disposed = false;
  constructor(private o: DomBridgeOptions) {}

  /* -------------------------------------------------------------- snapshot */
  tree(): DomTree {
    this.byId = new Map();
    const budget = { n: 0 };
    const html = this.shallow(document.documentElement);
    const body = this.shallow(document.body);
    const shell = this.spec(this.o.root, budget, 0) as ElSpec;
    return { html, body, shell };
  }
  private attrs(el: Element): Record<string, string> {
    const a: Record<string, string> = {};
    for (const at of Array.from(el.attributes)) {
      if (DROP_ATTR.test(at.name)) continue;
      // a text box's `value` attribute is its starting value, not what was typed; a radio's or checkbox's IS the option's code
      if (at.name === "value" && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !/^(radio|checkbox|submit|button|reset|hidden)$/.test((el as HTMLInputElement).type)))) continue;
      a[at.name] = at.value.slice(0, 600);
    }
    return a;
  }
  private shallow(el: Element): ElSpec {
    const i = idOf(el); this.byId.set(i, el);
    return { i, t: el.tagName.toLowerCase(), a: this.attrs(el), k: [] };
  }
  private spec(n: Node, budget: { n: number }, depth: number): Spec | null {
    if (budget.n++ > MAX_NODES) return null;
    if (n.nodeType === 3) { const i = idOf(n); this.byId.set(i, n); return { i, x: (n.nodeValue ?? "").slice(0, MAX_TEXT) }; }
    if (n.nodeType !== 1) return null;
    const el = n as Element;
    if (SKIP_TAGS.has(el.tagName) || el.hasAttribute("data-rs-ux-sandbox") || el.getAttribute("data-rs-ux-created") === this.o.id) return null;
    const out = this.shallow(el);
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      const input = el as HTMLInputElement;
      if (!(tag === "INPUT" && (input.type === "password" || input.type === "hidden"))) out.v = String(input.value ?? "").slice(0, MAX_TEXT);
      if (tag === "INPUT" && (input.type === "checkbox" || input.type === "radio")) out.c = input.checked;
    }
    if (FLAT_TAGS.has(tag.toUpperCase()) || depth >= MAX_DEPTH) return out;
    for (const c of Array.from(el.childNodes)) { const s = this.spec(c, budget, depth + 1); if (s) out.k.push(s); }
    return out;
  }

  /* ---------------------------------------------------------------- resolve */
  private node(id: Id | null | undefined): Node | null {
    if (id == null) return null;
    return (typeof id === "string" ? this.created.get(id) : this.byId.get(id)) ?? null;
  }
  private inside(el: Element): boolean {
    return this.o.root.contains(el) || el === document.body || el === document.documentElement;
  }
  private isMine(el: Element): boolean { return !!el.closest(`[data-rs-ux-created="${CSS.escape(this.o.id)}"]`); }
  private say(text: string) { this.o.log(text); }

  /* ------------------------------------------------------------------ apply */
  apply(ops: unknown): void {
    if (this.disposed || !Array.isArray(ops)) return;
    if (ops.length > MAX_OPS) this.say(`a script changed the page more than ${MAX_OPS} times at once — the rest was ignored`);
    for (const raw of ops.slice(0, MAX_OPS)) {
      const op = raw as DomOp;
      try {
        switch (op?.o) {
          case "class": this.cls(op); break;
          case "style": this.sty(op); break;
          case "attr": this.att(op); break;
          case "create": this.create(op); break;
          case "replace": this.replace(op); break;
          case "remove": this.remove(op); break;
          default: break;
        }
      } catch (e) {
        this.say(`a change a script asked for could not be applied: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.mo?.takeRecords(); // what this changed is not news
  }
  private rec(el: Element): Touched {
    let r = this.touched.get(el);
    if (!r) { r = { orig: new Map(), add: new Set(), rem: new Set(), attrPrev: new Map(), attrWant: new Map(), stylePrev: new Map() }; this.touched.set(el, r); }
    return r;
  }
  private element(n: Id): Element | null {
    const x = this.node(n);
    if (!(x instanceof Element) || !this.inside(x)) return null;
    return x;
  }
  private cls(op: Extract<DomOp, { o: "class" }>) {
    const el = this.element(op.n); if (!el) return;
    const r = this.rec(el), mine = this.isMine(el);
    for (const t of (op.add ?? []).slice(0, 40)) {
      if (typeof t !== "string" || !TOKEN.test(t)) { this.say(`“${String(t).slice(0, 40)}” is not a class name a script can add`); continue; }
      if (/^rs-/.test(t) && !mine) { this.say(`“${t}” is one of the survey's own classes — a script can add its own class names, not the survey's`); continue; }
      if (!r.orig.has(t)) r.orig.set(t, el.classList.contains(t));
      r.add.add(t); r.rem.delete(t); el.classList.add(t);
    }
    for (const t of (op.rem ?? []).slice(0, 40)) {
      if (typeof t !== "string" || !TOKEN.test(t)) continue;
      if (/^rs-/.test(t) && !mine) { this.say(`“${t}” is one of the survey's own classes — a script cannot remove it`); continue; }
      if (!r.orig.has(t)) r.orig.set(t, el.classList.contains(t));
      r.rem.add(t); r.add.delete(t); el.classList.remove(t);
    }
  }
  private sty(op: Extract<DomOp, { o: "style" }>) {
    const el = this.element(op.n) as HTMLElement | null; if (!el || !el.style) return;
    const r = this.rec(el);
    const remember = (k: string) => { if (!r.stylePrev.has(k)) r.stylePrev.set(k, [el.style.getPropertyValue(k), el.style.getPropertyPriority(k)]); };
    const c = checkDeclarations(op.set ?? {}, { target: this.o.owner });
    if (c.errors.length) this.say(c.errors.join("; "));
    for (const [k, v] of Object.entries(c.ok)) {
      remember(k);
      const important = /!important\s*$/i.test(v);
      el.style.setProperty(k, v.replace(/!important\s*$/i, "").trim(), important ? "important" : "");
    }
    for (const k of (op.rem ?? []).slice(0, 60)) if (typeof k === "string" && /^-{0,2}[a-z][a-z0-9-]*$/.test(k)) { remember(k); el.style.removeProperty(k); }
  }
  private att(op: Extract<DomOp, { o: "attr" }>) {
    const el = this.element(op.n); if (!el) return;
    const name = String(op.name).toLowerCase();
    if ((name === "hidden" || name === "disabled") && isNavTarget(el)) { this.say(`a script cannot ${name === "hidden" ? "hide" : "disable"} the Next / Back buttons or the navigation bar — the respondent needs them (it may still change their classes and styles)`); return; }
    if (!attrAllowed(name, el)) { this.say(`a script cannot change “${name}” — it may set hidden, disabled, title, role, tabindex, aria-* and data-* (the answer, links and the survey's own hooks are not its to change)`); return; }
    const r = this.rec(el);
    if (!r.attrPrev.has(name)) r.attrPrev.set(name, el.getAttribute(name));
    const value = op.value == null ? null : String(op.value).slice(0, 600);
    r.attrWant.set(name, value);
    if (value == null) el.removeAttribute(name); else el.setAttribute(name, value);
  }

  /* ------------------------------------------------- elements a script creates */
  private build(t: CTree, top: boolean): Node | null {
    if (t.x != null) { const n = document.createTextNode(String(t.x).slice(0, MAX_TEXT)); if (t.c) this.register(t.c, n); return n; }
    const tag = String(t.t ?? "").toLowerCase();
    if (!CREATE_TAGS.has(tag)) { this.say(`a script cannot create a <${tag}> element (it may create ${[...CREATE_TAGS].slice(0, 12).join(", ")}…)`); return null; }
    const el = document.createElement(tag);
    for (const [name, raw] of Object.entries(t.a ?? {})) {
      const n = name.toLowerCase(), v = String(raw).slice(0, 600);
      if (n === "class") { for (const tok of v.split(/\s+/).filter(Boolean)) if (TOKEN.test(tok)) el.classList.add(tok); }
      else if (n === "style") {
        const probe = document.createElement("div"); probe.setAttribute("style", v);
        const decls: Record<string, string> = {};
        for (let i = 0; i < probe.style.length; i++) { const k = probe.style[i]; decls[k] = probe.style.getPropertyValue(k); }
        const c = checkDeclarations(decls, { target: this.o.owner });
        for (const [k, val] of Object.entries(c.ok)) el.style.setProperty(k, val);
      }
      else if (n === "id" && /^[\w-]{1,60}$/.test(v)) el.setAttribute("id", v);
      else if (n === "type" && tag === "button") el.setAttribute("type", "button");
      else if (n === "for" && tag === "label" && /^[\w-]{1,60}$/.test(v)) el.setAttribute("for", v);
      else if (attrAllowed(n)) el.setAttribute(n, v);
    }
    if (tag === "button" && !el.hasAttribute("type")) el.setAttribute("type", "button");
    for (const k of t.k ?? []) { const c = this.build(k, false); if (c) el.appendChild(c); }
    if (t.c) this.register(t.c, el);
    if (top) { el.setAttribute("data-rs-ux-created", this.o.id); this.tops.add(el); }
    return el;
  }
  private register(c: string, n: Node) { this.created.set(c, n); this.createdIds.set(n, c); }
  private unregister(n: Node) {
    const c = this.createdIds.get(n); if (c) { this.created.delete(c); this.createdIds.delete(n); }
    n.childNodes.forEach((k) => this.unregister(k));
  }
  private create(op: Extract<DomOp, { o: "create" }>) {
    let parent = this.node(op.p);
    if (this.o.contain && parent === document.body) parent = this.o.root;
    if (!(parent instanceof Element) || !this.inside(parent) || parent === document.documentElement) return;
    if (this.tops.size >= 200) { this.say("a script created more than 200 elements — the rest were ignored"); return; }
    const n = this.build(op.tree, true); if (!n) return;
    const before = this.node(op.b);
    parent.insertBefore(n, before && before.parentNode === parent ? before : null);
  }
  private replace(op: Extract<DomOp, { o: "replace" }>) {
    const n = this.created.get(op.c); if (!n) return;
    if (n.nodeType === 3) { (n as Text).data = String(op.tree.x ?? "").slice(0, MAX_TEXT); return; }
    const el = n as Element;
    // the old children's ids go first: the frame reuses an id for a node it kept, and the new tree registers them again
    el.childNodes.forEach((k) => this.unregister(k));
    const fresh = this.build({ ...op.tree, c: undefined }, false) as Element | null; if (!fresh) return;
    for (const a of Array.from(el.attributes)) if (a.name !== "data-rs-ux-created") el.removeAttribute(a.name);
    for (const a of Array.from(fresh.attributes)) el.setAttribute(a.name, a.value);
    el.replaceChildren(...Array.from(fresh.childNodes));
  }
  private remove(op: Extract<DomOp, { o: "remove" }>) {
    const n = this.created.get(op.c); if (!n) return;
    this.tops.delete(n);
    this.unregister(n);
    (n as ChildNode).remove();
  }

  /* ------------------------------------------------------------------ events */
  private deliver(ev: Event) {
    if (this.disposed) return;
    const target = ev.target as Node | null; if (!target) return;
    const locate = (start: Node | null): Id | null => {
      for (let n: Node | null = start; n; n = n.parentNode) {
        const c = this.createdIds.get(n); if (c) return c;
        const i = ids.get(n); if (i != null && this.byId.get(i) === n) return i;
      }
      return null;
    };
    const n = locate(target); if (n == null) return;
    const d: Record<string, unknown> = {};
    const t = target as HTMLInputElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName ?? "") && !(t.tagName === "INPUT" && (t.type === "password" || t.type === "hidden"))) { d.value = String(t.value ?? "").slice(0, MAX_TEXT); if (t.tagName === "INPUT" && (t.type === "checkbox" || t.type === "radio")) d.checked = t.checked; }
    if (ev instanceof KeyboardEvent) { d.key = ev.key; d.code = ev.code; }
    const rn = ev instanceof MouseEvent ? locate(ev.relatedTarget as Node | null) : null;
    this.o.post({ type: "dom", ev: ev.type, n, rn, d });
  }
  /** a script said it listens for this kind of event — start forwarding it */
  want(type: string) {
    const real: string[] = type === "focus" ? ["focusin"] : type === "blur" ? ["focusout"] : type === "mouseenter" || type === "mouseleave" ? ["mouseover", "mouseout"] : [type];
    for (const r of real) {
      if (this.listeners.has(r)) continue;
      const h: EventListener = (ev) => this.deliver(ev);
      this.listeners.set(r, h);
      this.o.root.addEventListener(r, h, true);
    }
  }

  /* ------------------------------------------- keep the mirror current, keep changes */
  private reassert(el: Element) {
    const r = this.touched.get(el); if (!r) return;
    for (const t of r.add) if (!el.classList.contains(t)) el.classList.add(t);
    for (const t of r.rem) if (el.classList.contains(t)) el.classList.remove(t);
    for (const [k, v] of r.attrWant) { if (v == null) { if (el.hasAttribute(k)) el.removeAttribute(k); } else if (el.getAttribute(k) !== v) el.setAttribute(k, v); }
  }
  /** call `onSync` (debounced) whenever the survey page changes, and hold the script's own changes in place */
  watch(sync: (tree: DomTree) => void) {
    this.mo = new MutationObserver((records) => {
      if (this.disposed) return;
      let changed = false;
      for (const rec of records) {
        const t = rec.target;
        if (t instanceof Element && t.closest("[data-rs-ux-sandbox]")) continue;
        changed = true;
        if (rec.type === "attributes" && t instanceof Element && this.touched.has(t)) this.reassert(t);
      }
      this.mo?.takeRecords();
      if (!changed) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; this.resync(sync); }, 40);
    });
    this.mo.observe(this.o.root, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  resync(sync: (tree: DomTree) => void, force = false) {
    if (this.disposed) return;
    const t = this.tree(), s = JSON.stringify(t);
    if (s === this.last && !force) return;
    this.last = s; sync(t);
  }
  /** the snapshot the frame was started from, so the first change is measured against it */
  primed(tree: DomTree) { this.last = JSON.stringify(tree); }

  /* ------------------------------------------------------------------ undo */
  /**
   * The page is being left. Stop watching and forwarding — but keep applying
   * what the frame says for a moment: a click on Next was handed to the frame
   * before the page changed, and its handler changes should land, once,
   * instead of being cut off because the frame was removed first.
   */
  freeze() {
    this.mo?.disconnect(); this.mo = null;
    if (this.timer) clearTimeout(this.timer);
    for (const [type, h] of this.listeners) this.o.root.removeEventListener(type, h, true);
    this.listeners.clear();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.mo?.disconnect();
    if (this.timer) clearTimeout(this.timer);
    for (const [type, h] of this.listeners) this.o.root.removeEventListener(type, h, true);
    this.listeners.clear();
    for (const n of this.tops) (n as ChildNode).remove();
    this.tops.clear();
    for (const [el, r] of this.touched) {
      for (const [t, had] of r.orig) { if (had) el.classList.add(t); else el.classList.remove(t); }
      for (const [k, v] of r.attrPrev) { if (v == null) el.removeAttribute(k); else el.setAttribute(k, v); }
      const he = el as HTMLElement;
      if (he.style) for (const [k, [v, p]] of r.stylePrev) { if (v) he.style.setProperty(k, v, p); else he.style.removeProperty(k); }
    }
    this.touched.clear();
    this.created.clear();
  }
}
