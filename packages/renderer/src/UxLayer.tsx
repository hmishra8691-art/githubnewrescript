"use client";
import * as React from "react";
import type { SurveyDefinition, UxBehavior, UxEffect, UxTarget } from "@rescript/schema";
import {
  UX_PRESET_FRAMES, checkDeclarations, compileUxCss, evaluateUxTriggers, resolveUxTarget, uxAnimationNeedsRuntime,
  uxPlayToken, uxSelector, uxToken, uxAnswered, uxSelectedCodes, defaultUxLookups, validateUxScript, UX_SCRIPT_EVENT_ALIASES,
} from "@rescript/engine";

/**
 * THE UX LAYER — the runtime half of the survey's styles, animations and
 * behaviours (engine `ux.ts` is the other half).
 *
 * Mounted inside the survey shell, it
 *   · injects the compiled, scoped stylesheet;
 *   · marks answered questions (`data-rs-ux-answered`), numbers staggered
 *     elements (`--rs-ux-i`) and replays page-level animations on each page;
 *   · runs declarative behaviours: the engine decides which fire, hold or are
 *     released (`evaluateUxTriggers`), this applies their effects to the
 *     survey's own elements and reverts held ones;
 *   · runs each script behaviour in a SANDBOXED FRAME — an opaque origin
 *     (`sandbox="allow-scripts"`, no same-origin) with a CSP that forbids
 *     every network request — that can only post `rs` commands back. The
 *     frame cannot read the page, its cookies, storage, the Studio's session
 *     or any API; every command it sends is checked here (target resolved
 *     against the survey, styles through the engine's CSS gate, class names
 *     namespaced, text inserted as text) and rate-limited.
 *
 * Everything it changes is outside React's own attributes — tokens in
 * `data-rs-ux-on`, inline custom properties, appended message nodes — so a
 * re-render of the question never erases it, and it never erases a
 * re-render.
 */

export interface UxLayerProps {
  def: SurveyDefinition;
  /** the survey shell (carries data-rs-ux / data-rs-block / data-rs-page) */
  rootRef: React.RefObject<HTMLElement | null>;
  /** answers on the current page, by question id */
  values: Record<string, unknown>;
  /** every answer so far, by question id (scripts' getAnswer) */
  allValues?: Record<string, unknown>;
  /** the questions on the page, in order */
  shown: string[];
  /** changes whenever the page (or loop iteration) changes */
  pageKey: string;
  blockId?: string;
  pageId?: string;
  pageIndex?: number;
  onLog?: (line: string) => void;
}

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** the elements a target names, inside this survey's shell only */
export function uxElements(root: HTMLElement, t: UxTarget, opts: { content?: boolean } = {}): HTMLElement[] {
  const s = uxSelector(t, { content: opts.content });
  if (s.root && !root.matches(s.root.replace(/:hover|:focus-within/g, ""))) return [];
  if (!s.inner) return [root];
  try { return [...root.querySelectorAll<HTMLElement>(s.inner)]; } catch { return []; }
}

interface Undo { run(): void }
/** the inline properties the UX layer set on each element — so clearing them never touches React's own */
const setByUx = new WeakMap<HTMLElement, Set<string>>();
/** apply one effect; returns how to revert it (for held conditions) */
function applyEffect(root: HTMLElement, def: SurveyDefinition, owner: UxTarget, e: UxEffect, ownerId: string): Undo[] {
  const t = e.target ?? owner;
  const content = e.do === "animate" && ["survey", "block", "page"].includes(t.kind);
  const els = uxElements(root, t, { content });
  const undo: Undo[] = [];
  for (const el of els) {
    switch (e.do) {
      case "add_class": case "remove_class": case "toggle_class": {
        const tok = uxToken(e.className ?? "on");
        const has = (el.getAttribute("data-rs-ux-on") ?? "").split(/\s+/).filter(Boolean);
        const on = e.do === "add_class" ? true : e.do === "remove_class" ? false : !has.includes(tok);
        const next = on ? [...new Set([...has, tok])] : has.filter((x) => x !== tok);
        el.setAttribute("data-rs-ux-on", next.join(" "));
        if (on !== has.includes(tok)) undo.push({ run: () => { const cur = (el.getAttribute("data-rs-ux-on") ?? "").split(/\s+/).filter(Boolean); el.setAttribute("data-rs-ux-on", (on ? cur.filter((x) => x !== tok) : [...cur, tok]).join(" ")); } });
        break;
      }
      case "animate": {
        if (reducedMotion() || typeof el.animate !== "function") break;
        const frames = UX_PRESET_FRAMES[e.preset ?? "pulse"];
        if (frames) el.animate(frames as Keyframe[], { duration: e.durationMs ?? 450, easing: "ease-out" });
        break;
      }
      case "set_style": {
        const c = checkDeclarations(e.style ?? {}, { target: t });
        const prev: [string, string, string][] = [];
        for (const [k, v] of Object.entries(c.ok)) {
          prev.push([k, el.style.getPropertyValue(k), el.style.getPropertyPriority(k)]);
          const important = /!important\s*$/i.test(v);
          el.style.setProperty(k, v.replace(/!important\s*$/i, "").trim(), important ? "important" : "");
          const mine = setByUx.get(el) ?? new Set<string>(); mine.add(k); setByUx.set(el, mine);
        }
        undo.push({ run: () => { for (const [k, v, p] of prev) if (v) el.style.setProperty(k, v, p); else el.style.removeProperty(k); } });
        break;
      }
      case "show": if (el.hasAttribute("data-rs-ux-hidden")) { el.removeAttribute("data-rs-ux-hidden"); undo.push({ run: () => el.setAttribute("data-rs-ux-hidden", "") }); } break;
      case "hide": if (!el.hasAttribute("data-rs-ux-hidden")) { el.setAttribute("data-rs-ux-hidden", ""); undo.push({ run: () => el.removeAttribute("data-rs-ux-hidden") }); } break;
      case "show_message": {
        const key = `${ownerId}`;
        let m = el.querySelector<HTMLElement>(`:scope > [data-rs-ux-msg="${CSS.escape(key)}"]`);
        if (!m) {
          m = document.createElement("div");
          m.className = "rs-ux-message";
          m.setAttribute("data-rs-ux-msg", key);
          m.setAttribute("role", "status");
          m.setAttribute("aria-live", "polite");
          el.appendChild(m);
        }
        m.textContent = e.text ?? "";
        if (!reducedMotion() && typeof m.animate === "function") m.animate((UX_PRESET_FRAMES[e.preset ?? "fade-up"] ?? UX_PRESET_FRAMES["fade-up"]) as Keyframe[], { duration: e.durationMs ?? 320, easing: "ease-out" });
        const node = m;
        undo.push({ run: () => node.remove() });
        break;
      }
      case "hide_message": for (const m of el.querySelectorAll(":scope > [data-rs-ux-msg]")) m.remove(); break;
      case "scroll_into_view": el.scrollIntoView?.({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" }); break;
      case "focus": { const f = el.matches("input,select,textarea,button,[tabindex]") ? el : el.querySelector<HTMLElement>("input,select,textarea,button,[tabindex]"); f?.focus({ preventScroll: false }); break; }
    }
  }
  return undo;
}

/* ------------------------------------------------------------ the sandbox */

const SANDBOX_DOC = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'"></head><body><script>
(function () {
  var handlers = [], answers = {}, meta = { questions: {} }, host = window.parent, ALIASES = ${JSON.stringify(UX_SCRIPT_EVENT_ALIASES)};
  function send(cmd, args) { host.postMessage({ __rsux: 1, cmd: cmd, args: args }, "*"); }
  var rs = {
    listen: function (ev, target, fn) { if (typeof target === "function") { fn = target; target = "self"; } ev = ALIASES[ev] || ev; handlers.push({ ev: ev, target: target, fn: fn }); send("listen", [ev, target]); },
    getAnswer: function (code) { return answers[code]; },
    getQuestion: function (code) { return meta.questions[code] || null; },
    getBlock: function () { return meta.block || null; },
    getPage: function () { return meta.page || null; },
    after: function (ms, fn) { setTimeout(function () { try { fn(); } catch (e) { send("error", [String(e && e.message || e)]); } }, Math.max(0, Math.min(60000, Number(ms) || 0))); },
    log: function () { send("log", Array.prototype.map.call(arguments, String)); }
  };
  ["addClass","removeClass","toggleClass","animate","setStyle","clearStyle","show","hide","showMessage","hideMessage","scrollTo","focus"].forEach(function (n) { rs[n] = function () { send(n, Array.prototype.slice.call(arguments, 0, 3)); }; });
  window.addEventListener("message", function (e) {
    if (e.source !== host) return;
    var m = e.data; if (!m || m.__rsux !== 1) return;
    if (m.type === "init") { answers = m.answers || {}; meta = m.meta || meta; try { (new Function("rs", m.code))(Object.freeze(rs)); } catch (err) { send("error", [String(err && err.message || err)]); } }
    else if (m.type === "answers") { answers = m.answers || {}; }
    else if (m.type === "event") { handlers.forEach(function (h) { if (h.ev === m.ev && (h.target === m.target || (h.target === "self" && m.self))) { try { h.fn(m.payload); } catch (err) { send("error", [String(err && err.message || err)]); } } }); }
  });
  send("ready", []);
})();
</script></body></html>`;
const COMMANDS_PER_SECOND = 200;

interface ScriptHost { frame: HTMLIFrameElement; behavior: UxBehavior; listens: { ev: string; target: string }[]; undo: Undo[]; dispose(): void }

function plainText(s: string) { return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }

/* ------------------------------------------------------------ the component */

export function UxLayer(p: UxLayerProps) {
  const { def } = p;
  /* the definition object may be rebuilt on every render; what matters is whether its UX changed */
  const uxSig = `${def.meta.id}|${JSON.stringify(def.ux ?? null)}`;
  const css = React.useMemo(() => compileUxCss(def), [uxSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const defRef = React.useRef(def);
  defRef.current = def;
  const prevValues = React.useRef<Record<string, unknown> | null>(null);
  const lastPage = React.useRef<string | null>(null);
  const active = React.useRef(new Map<string, Undo[]>());
  const fired = React.useRef(new Set<string>());
  const scripts = React.useRef<ScriptHost[]>([]);
  const log = React.useRef(p.onLog);
  log.current = p.onLog;
  const behaviors = def.ux?.behaviors ?? [];
  const animations = def.ux?.animations ?? [];

  const byCode = React.useMemo(() => new Map(def.questions.map((q) => [q.id, String(q.code)])), [def.questions]);
  const answersByCode = React.useCallback(() => {
    const out: Record<string, unknown> = {};
    const all = { ...(p.allValues ?? {}), ...p.values };
    for (const [id, v] of Object.entries(all)) { const c = byCode.get(id); if (c) out[c] = v; }
    return out;
  }, [p.allValues, p.values, byCode]);

  /* every render: answered marks, triggers */
  React.useEffect(() => {
    const root = p.rootRef.current;
    if (!root) return;
    const pageChanged = lastPage.current !== p.pageKey;
    if (pageChanged) {
      // a new page: held effects of the old one go with it
      for (const undo of active.current.values()) for (const u of undo) u.run();
      active.current.clear();
      prevValues.current = null;
      lastPage.current = p.pageKey;
    }
    for (const card of root.querySelectorAll<HTMLElement>('[data-rs-el="question"][data-rs-id]')) {
      const id = card.getAttribute("data-rs-id")!;
      if (uxAnswered(p.values[id])) card.setAttribute("data-rs-ux-answered", ""); else card.removeAttribute("data-rs-ux-answered");
    }
    if (pageChanged) {
      for (const a of animations) {
        if (a.staggerMs) uxElements(root, a.target).forEach((el, i) => el.style.setProperty("--rs-ux-i", String(i)));
        if (uxAnimationNeedsRuntime(a)) {
          const tok = uxPlayToken(a.id);
          const content = ["survey", "block", "page"].includes(a.target.kind);
          for (const el of uxElements(root, a.target, { content })) {
            const cur = (el.getAttribute("data-rs-ux-play") ?? "").split(/\s+/).filter((x) => x && x !== tok);
            el.setAttribute("data-rs-ux-play", cur.join(" "));
            void el.offsetWidth; // restart the animation
            el.setAttribute("data-rs-ux-play", [...cur, tok].join(" "));
          }
        }
      }
    }
    if (behaviors.length) {
      const r = evaluateUxTriggers({ def, prev: prevValues.current, now: p.values, shown: p.shown, blockId: p.blockId, active: new Set(active.current.keys()), fired: fired.current });
      for (const b of r.release) { for (const u of active.current.get(b.id) ?? []) u.run(); active.current.delete(b.id); }
      for (const b of r.hold) { active.current.set(b.id, b.effects.flatMap((e) => applyEffect(root, def, b.target, e, b.id))); if (b.once) fired.current.add(b.id); }
      for (const b of r.fire) { for (const e of b.effects) applyEffect(root, def, b.target, e, b.id); if (b.once) fired.current.add(b.id); }
    }
    // scripts hear about answers
    const prev = prevValues.current;
    for (const s of scripts.current) {
      s.frame.contentWindow?.postMessage({ __rsux: 1, type: "answers", answers: answersByCode() }, "*");
      if (!prev) continue;
      for (const qid of p.shown) {
        if (JSON.stringify(prev[qid] ?? null) === JSON.stringify(p.values[qid] ?? null)) continue;
        const code = byCode.get(qid)!;
        const before = uxSelectedCodes(prev[qid]), now = uxSelectedCodes(p.values[qid]);
        const self = s.behavior.target.questionId === qid;
        const post = (ev: string, payload: unknown) => s.frame.contentWindow?.postMessage({ __rsux: 1, type: "event", ev, target: code, self, payload }, "*");
        post("change", { question: code, value: p.values[qid] });
        if (uxAnswered(p.values[qid])) post("answer", { question: code, value: p.values[qid] });
        for (const c of now) if (!before.has(c)) post("select", { question: code, value: p.values[qid], option: c });
        for (const c of before) if (!now.has(c)) post("deselect", { question: code, value: p.values[qid], option: c });
      }
    }
    prevValues.current = { ...p.values };
  });

  /* click / hover behaviours: delegated on the shell */
  React.useEffect(() => {
    const root = p.rootRef.current;
    const pointer = behaviors.filter((b) => !b.script && (b.on === "click" || b.on === "hover"));
    if (!root || !pointer.length) return;
    const within = (b: UxBehavior, node: EventTarget | null) => {
      if (!(node instanceof Element)) return null;
      const s = uxSelector(b.target);
      if (s.root && !root.matches(s.root)) return null;
      return s.inner ? node.closest(s.inner) : root;
    };
    const onClick = (ev: Event) => { for (const b of pointer.filter((x) => x.on === "click")) { if (b.once && fired.current.has(b.id)) continue; if (within(b, ev.target)) { for (const e of b.effects) applyEffect(root, def, b.target, e, b.id); if (b.once) fired.current.add(b.id); } } };
    const onOver = (ev: Event) => { for (const b of pointer.filter((x) => x.on === "hover")) if (within(b, ev.target) && !active.current.has(b.id)) active.current.set(b.id, b.effects.flatMap((e) => applyEffect(root, def, b.target, e, b.id))); };
    const onOut = (ev: MouseEvent) => { for (const b of pointer.filter((x) => x.on === "hover")) { if (!active.current.has(b.id)) continue; const from = within(b, ev.target), to = within(b, ev.relatedTarget); if (from && from !== to) { for (const u of active.current.get(b.id)!) u.run(); active.current.delete(b.id); } } };
    root.addEventListener("click", onClick);
    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseout", onOut as EventListener);
    return () => { root.removeEventListener("click", onClick); root.removeEventListener("mouseover", onOver); root.removeEventListener("mouseout", onOut as EventListener); };
  }, [p.pageKey, uxSig]); // eslint-disable-line react-hooks/exhaustive-deps

  /* script behaviours: one sandboxed frame each, per page */
  React.useEffect(() => {
    const maybeRoot = p.rootRef.current;
    // a script belongs to what it is attached to: it runs on the pages that show it
    const withScript = behaviors.filter((b) => b.script && (!b.target.questionId || p.shown.includes(b.target.questionId)) && (!b.target.blockId || b.target.blockId === p.blockId) && (!b.target.pageId || b.target.pageId === p.pageId));
    if (!maybeRoot || !withScript.length || typeof document === "undefined") return;
    const root: HTMLElement = maybeRoot;
    const look = defaultUxLookups(def);
    const hosts: ScriptHost[] = [];
    for (const b of withScript) {
      /*
       * Validated again here, not only when it was proposed: a definition can
       * be edited by hand or arrive from an import. A loop could hang the
       * frame — and a sandboxed frame may share the page's thread — so a
       * script that does not pass the gate never runs.
       */
      const check = validateUxScript(b.script!, def);
      if (check.errors.length) { log.current?.(`[ux script “${b.label}”] not run: ${check.errors.join("; ")}`); continue; }
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("tabindex", "-1");
      frame.setAttribute("data-rs-ux-sandbox", b.id);
      frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
      frame.srcdoc = SANDBOX_DOC;
      const host: ScriptHost = { frame, behavior: b, listens: [], undo: [], dispose: () => { window.removeEventListener("message", onMessage); root.removeEventListener("click", onDom); root.removeEventListener("mouseover", onDom); frame.remove(); } };
      let windowStart = Date.now(), count = 0;
      const resolve = (spec: unknown): UxTarget | null => {
        if (spec === "self" || spec == null) return b.target;
        const t = resolveUxTarget(def, spec, look);
        if (typeof t === "string") { log.current?.(`[ux script “${b.label}”] ${t}`); return null; }
        return t;
      };
      const effect = (e: UxEffect, t: UxTarget | null) => { if (t) host.undo.push(...applyEffect(root, def, t, { ...e, target: t }, b.id)); };
      function onMessage(ev: MessageEvent) {
        if (ev.source !== frame.contentWindow) return;
        const m = ev.data as { __rsux?: number; cmd?: string; args?: unknown[] };
        if (!m || m.__rsux !== 1 || typeof m.cmd !== "string") return;
        const now = Date.now();
        if (now - windowStart > 1000) { windowStart = now; count = 0; }
        if (++count > COMMANDS_PER_SECOND) { log.current?.(`[ux script “${b.label}”] stopped: more than ${COMMANDS_PER_SECOND} commands a second`); host.dispose(); return; }
        const a = Array.isArray(m.args) ? m.args : [];
        const str = (x: unknown) => (typeof x === "string" ? x : x == null ? "" : String(x)).slice(0, 600);
        switch (m.cmd) {
          case "ready": {
            const questions: Record<string, unknown> = {};
            for (const q of def.questions) questions[String(q.code)] = { code: String(q.code), type: q.type, text: plainText(q.text ?? ""), options: (q.options ?? []).map((o) => ({ code: String(o.code), label: plainText(o.label) })) };
            frame.contentWindow?.postMessage({ __rsux: 1, type: "init", code: b.script, answers: answersByCode(), meta: { questions, block: p.blockId ? { id: p.blockId } : null, page: p.pageId ? { id: p.pageId, index: p.pageIndex ?? null } : null } }, "*");
            frame.contentWindow?.postMessage({ __rsux: 1, type: "event", ev: "page", target: "self", self: true, payload: {} }, "*");
            break;
          }
          case "listen": host.listens.push({ ev: str(a[0]), target: str(a[1]) || "self" }); break;
          case "addClass": effect({ do: "add_class", className: str(a[1]) }, resolve(a[0])); break;
          case "removeClass": effect({ do: "remove_class", className: str(a[1]) }, resolve(a[0])); break;
          case "toggleClass": effect({ do: "toggle_class", className: str(a[1]) }, resolve(a[0])); break;
          case "animate": { const preset = str(a[1]); const opts = (a[2] && typeof a[2] === "object" ? a[2] : {}) as { duration?: number }; if (UX_PRESET_FRAMES[preset as keyof typeof UX_PRESET_FRAMES]) effect({ do: "animate", preset: preset as never, durationMs: Math.max(50, Math.min(10000, Number(opts.duration) || 450)) }, resolve(a[0])); else log.current?.(`[ux script “${b.label}”] “${preset}” is not a preset`); break; }
          case "setStyle": { const style = a[1] && typeof a[1] === "object" ? Object.fromEntries(Object.entries(a[1] as Record<string, unknown>).map(([k, v]) => [k, str(v)])) : {}; const c = checkDeclarations(style); if (c.errors.length) log.current?.(`[ux script “${b.label}”] ${c.errors.join("; ")}`); effect({ do: "set_style", style: c.ok }, resolve(a[0])); break; }
          case "clearStyle": { const t = resolve(a[0]); if (t) for (const el of uxElements(root, t)) { for (const k of setByUx.get(el) ?? []) el.style.removeProperty(k); setByUx.delete(el); } break; }
          case "show": effect({ do: "show" }, resolve(a[0])); break;
          case "hide": effect({ do: "hide" }, resolve(a[0])); break;
          case "showMessage": effect({ do: "show_message", text: str(a[1]) }, resolve(a[0])); break;
          case "hideMessage": effect({ do: "hide_message" }, resolve(a[0])); break;
          case "scrollTo": effect({ do: "scroll_into_view" }, resolve(a[0])); break;
          case "focus": effect({ do: "focus" }, resolve(a[0])); break;
          case "log": log.current?.(`[ux script “${b.label}”] ${a.map(str).join(" ")}`); break;
          case "error": log.current?.(`[ux script “${b.label}”] ERROR: ${str(a[0])}`); break;
          default: break;
        }
      }
      // clicks and hovers reach the script only for the targets it listens to
      function onDom(ev: Event) {
        const kind = ev.type === "click" ? "click" : "hover";
        for (const l of host.listens.filter((x) => x.ev === kind)) {
          const t = resolve(l.target);
          if (!t) continue;
          const s = uxSelector(t);
          if (s.root && !root.matches(s.root)) continue;
          const hit = s.inner ? (ev.target instanceof Element ? ev.target.closest(s.inner) : null) : root;
          if (hit) frame.contentWindow?.postMessage({ __rsux: 1, type: "event", ev: kind, target: l.target, self: l.target === "self", payload: { target: l.target } }, "*");
        }
      }
      window.addEventListener("message", onMessage);
      root.addEventListener("click", onDom);
      root.addEventListener("mouseover", onDom);
      root.appendChild(frame);
      hosts.push(host);
    }
    scripts.current = hosts;
    return () => { for (const h of hosts) { h.dispose(); for (const u of h.undo) u.run(); } scripts.current = []; };
  }, [p.pageKey, uxSig]); // eslint-disable-line react-hooks/exhaustive-deps

  /* the page-complete event for scripts */
  const complete = p.shown.length > 0 && p.shown.every((id) => { const q = def.questions.find((x) => x.id === id); return !q || q.type === "html" || q.type === "calculated" || q.settings?.hidden || uxAnswered(p.values[id]); });
  React.useEffect(() => {
    if (!complete) return;
    for (const s of scripts.current) s.frame.contentWindow?.postMessage({ __rsux: 1, type: "event", ev: "complete", target: "self", self: true, payload: {} }, "*");
  }, [complete, p.pageKey]);

  return css ? <style data-rs-ux-css="" dangerouslySetInnerHTML={{ __html: css }} /> : null;
}
