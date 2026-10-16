/**
 * THE SANDBOXED FRAME'S OWN PROGRAM.
 *
 * Survey scripts run here, in an iframe with `sandbox="allow-scripts"` (an
 * opaque origin: no cookies, no storage, no page, no session) and a CSP that
 * forbids every network request. This file is what runs INSIDE it, as a
 * string, because the frame is built from `srcdoc`. It is the only script
 * engine in the product; there is no second one to keep in step with it.
 *
 * ## What a script sees
 *
 *   · `rs` — the survey api (`rs.listen`, `rs.getAnswer`, `rs.addClass`…).
 *   · `document` — a MIRROR of the survey page, built from a sanitised
 *     snapshot the host sends. It is a real DOM, so `querySelector`,
 *     `closest`, `classList`, `dataset`, `getAttribute`, `textContent`,
 *     `value`, `MutationObserver` and `addEventListener` behave exactly as a
 *     programmer expects, and reads are synchronous.
 *
 * ## How the mirror reaches the real page
 *
 * Nothing a script does touches the survey directly. A MutationObserver on
 * the mirror turns each change into a small, typed OPERATION — add/remove a
 * class, set a style property, set an allowed attribute, create/replace/
 * remove an element the script itself made — and posts the batch to the host,
 * which checks every operation against an allow-list before applying it, to
 * the real element it corresponds to. Events go the other way: the host
 * forwards the real click / input / change / focus / keydown / mouseover to
 * the frame, which dispatches a real event on the mirror node, so a handler
 * registered with `addEventListener` runs, once, with the target it expects.
 *
 * ## What a script cannot do (and is told when it tries)
 *
 * It cannot change an answer (`value`, `checked`, `.click()` on an option have
 * no effect on the survey), cancel an event (`preventDefault` is a no-op —
 * the real event has already happened), replace the text of an element the
 * survey drew (React owns it; create an element of your own instead), or
 * reach the network, storage or the parent page.
 *
 * ## Lifecycle
 *
 * One frame per script per page. Leaving the page disposes the frame and the
 * host undoes whatever the script added, so a handler can never be attached
 * twice and nothing outlives the page it was written for. When the survey
 * re-renders the page the host sends a fresh snapshot and the mirror is
 * brought up to date IN PLACE — nodes keep their identity, so a listener on
 * an element survives a re-render of everything around it.
 */

/** the events the host will forward, when a script has said it listens for them */
export const UX_FORWARDED_EVENTS = ["click", "input", "change", "focusin", "focusout", "focus", "blur", "keydown", "keyup", "mouseover", "mouseout", "mouseenter", "mouseleave", "pointerdown", "pointerup", "dblclick", "submit"] as const;

/** how many iterations one entry (the script, an event, a timer) may run before it is stopped */
export const UX_LOOP_LIMIT = 100_000;

export function uxSandboxDoc(config: { aliases: Record<string, string> }): string {
  const cfg = JSON.stringify({ aliases: config.aliases, loopLimit: UX_LOOP_LIMIT, forwarded: UX_FORWARDED_EVENTS });
  return SANDBOX_HTML.replace("__CFG__", () => cfg.replace(/</g, "\\u003c"));
}

const SANDBOX_HTML = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'"></head><body><script>
(function () {
  var CFG = __CFG__;
  var host = window.parent;
  var handlers = [], answers = {}, meta = { questions: {} };
  var loops = 0;
  var ready = false;
  function slice() { loops = 0; }
  window.__g = function () { if (++loops > CFG.loopLimit) throw new Error("a loop ran more than " + CFG.loopLimit + " times in one go, so the script was stopped (is it endless?)"); };
  function send(cmd, args) { host.postMessage({ __rsux: 1, cmd: cmd, args: args }, "*"); }
  function fail(e) { send("error", [String(e && e.message || e)]); }
  var told = {};
  function note(key, text) { if (told[key]) return; told[key] = 1; send("log", [text]); }
  function guard(fn) { return function () { slice(); try { return fn.apply(this, arguments); } catch (e) { fail(e); } }; }

  /* ---------------------------------------------------------------- rs api */
  var rs = {
    listen: function (ev, target, fn) { if (typeof target === "function") { fn = target; target = "self"; } ev = CFG.aliases[ev] || ev; handlers.push({ ev: ev, target: target, fn: fn }); send("listen", [ev, target]); },
    getAnswer: function (code) { return answers[code]; },
    getQuestion: function (code) { return meta.questions[code] || null; },
    getBlock: function () { return meta.block || null; },
    getPage: function () { return meta.page || null; },
    after: function (ms, fn) { setTimeout(fn, Math.max(0, Math.min(60000, Number(ms) || 0))); },
    log: function () { send("log", Array.prototype.map.call(arguments, String)); }
  };
  ["addClass","removeClass","toggleClass","animate","setStyle","clearStyle","show","hide","showMessage","hideMessage","scrollTo","focus"].forEach(function (n) { rs[n] = function () { send(n, Array.prototype.slice.call(arguments, 0, 3)); }; });

  /* --------------------------------------------------------------- timers */
  var nativeTimeout = window.setTimeout.bind(window);
  window.setTimeout = function (fn) {
    if (typeof fn !== "function") { note("timeout-string", "setTimeout needs a function, not a string"); return 0; }
    var rest = Array.prototype.slice.call(arguments, 1);
    var ms = Math.max(0, Math.min(60000, Number(rest[0]) || 0));
    return nativeTimeout(function () { slice(); try { fn.apply(null, rest.slice(1)); } catch (e) { fail(e); } }, ms);
  };
  window.setInterval = function () { note("interval", "setInterval is not available to survey scripts — use setTimeout or rs.after"); return 0; };
  window.addEventListener("error", function (e) { fail(e.error || e.message); e.preventDefault(); });
  window.addEventListener("unhandledrejection", function (e) { fail(e.reason); e.preventDefault(); });

  /* ------------------------------------------------------- the survey mirror */
  var byId = new Map();      // host id -> mirror node (nodes that came from the survey)
  var byC = new Map();       // script-created id -> mirror node
  var nextC = 1;
  var syncing = false;       // true while the mirror is brought up to date from the host
  var known = new WeakMap(); // node -> what the host and the script last agreed the node looks like
  var owned = new WeakMap(); // node -> what the script itself changed (a re-sync leaves these alone)
  var wanted = {};           // event types a script listens for
  var observer = null;
  var FORWARD = {}; CFG.forwarded.forEach(function (t) { FORWARD[t] = 1; });

  function own(n) { var o = owned.get(n); if (!o) { o = { attrs: {}, add: {}, rem: {}, style: {} }; owned.set(n, o); } return o; }
  function kn(n) { var k = known.get(n); if (!k) { k = { attrs: {}, host: [], cur: [], sty: {} }; known.set(n, k); } return k; }
  function tokens(n) { return (n.getAttribute("class") || "").split(/\s+/).filter(Boolean); }
  function styleMap(n) { var m = {}, s = n.style; for (var i = 0; i < s.length; i++) m[s[i]] = s.getPropertyValue(s[i]) + (s.getPropertyPriority(s[i]) ? " !important" : ""); return m; }
  function parseStyle(text) { var d = document.createElement("div"); d.setAttribute("style", text || ""); return styleMap(d); }

  function make(spec) {
    var n = spec.x != null ? document.createTextNode(spec.x) : document.createElement(spec.t);
    n.__i = spec.i; byId.set(spec.i, n); return n;
  }
  function forget(n) {
    if (n.__i != null) byId.delete(n.__i);
    for (var c = n.firstChild; c; c = c.nextSibling) forget(c);
  }
  function detach(n) { if (n.parentNode) n.parentNode.removeChild(n); forget(n); }

  function applyAttrs(n, spec) {
    var k = kn(n), o = owned.get(n), a = spec.a || {}, name;
    for (name in a) {
      if (name === "class" || name === "style") continue;
      if (o && o.attrs[name]) continue;
      if (n.getAttribute(name) !== a[name]) n.setAttribute(name, a[name]);
      k.attrs[name] = a[name];
    }
    for (name in k.attrs) if (!(name in a) && !(o && o.attrs[name])) { n.removeAttribute(name); delete k.attrs[name]; }
    // class: the host's tokens, plus what the script added, minus what it removed
    var host = (a["class"] || "").split(/\s+/).filter(Boolean), want = host.filter(function (t) { return !(o && o.rem[t]); });
    if (o) for (var t in o.add) if (want.indexOf(t) < 0) want.push(t);
    k.host = host;
    var next = want.join(" ");
    if ((n.getAttribute("class") || "") !== next) { if (next) n.setAttribute("class", next); else n.removeAttribute("class"); }
    k.cur = want.slice();
    // style: the host's inline style, then the script's own properties over it
    if (n.getAttribute("style") !== (a["style"] || "")) { if (a["style"]) n.setAttribute("style", a["style"]); else n.removeAttribute("style"); }
    if (o) for (var p in o.style) n.style.setProperty(p, o.style[p].replace(/\s*!important$/, ""), /!important$/.test(o.style[p]) ? "important" : "");
    k.sty = styleMap(n);
  }
  function applyProps(n, spec) {
    var tag = n.nodeName;
    if (tag === "INPUT" || tag === "TEXTAREA") { if (spec.v != null && n.value !== spec.v) n.value = spec.v; if (spec.c != null) n.checked = !!spec.c; }
    else if (tag === "SELECT" && spec.v != null) n.value = spec.v;
  }
  function reconcileKids(parent, kids) {
    var desired = [];
    kids.forEach(function (s) {
      var n = byId.get(s.i);
      if (n && ((s.x != null) !== (n.nodeType === 3) || (s.t && n.nodeName.toLowerCase() !== s.t))) { detach(n); n = null; }
      if (!n) n = make(s);
      if (s.x != null) { if (n.data !== s.x) n.data = s.x; }
      else { applyAttrs(n, s); reconcileKids(n, s.k || []); applyProps(n, s); }
      desired.push(n);
    });
    var want = new Set(desired);
    Array.prototype.slice.call(parent.childNodes).forEach(function (c) { if (c.__i != null && !want.has(c)) detach(c); });
    var cursor = parent.firstChild;
    desired.forEach(function (n) {
      while (cursor && cursor !== n && cursor.__c != null) cursor = cursor.nextSibling; // the script's own nodes stay where they are
      if (cursor === n) cursor = cursor.nextSibling; else parent.insertBefore(n, cursor);
    });
  }
  function applyTree(tree) {
    syncing = true;
    try {
      byId.set(tree.html.i, document.documentElement); document.documentElement.__i = tree.html.i;
      byId.set(tree.body.i, document.body); document.body.__i = tree.body.i;
      applyAttrs(document.documentElement, tree.html);
      applyAttrs(document.body, tree.body);
      reconcileKids(document.body, [tree.shell]);
    } finally {
      if (observer) observer.takeRecords();
      syncing = false;
    }
  }

  /* ------------------------------------- mirror changes -> operations for the host */
  function createdRoot(n) { for (var c = n; c; c = c.parentNode) if (c.__c != null && c.__root) return c; return null; }
  function ser(n, root) {
    if (n.nodeType === 3) { var t = { x: n.data.slice(0, 2000) }; if (root) { n.__c = "c" + nextC++; n.__root = true; byC.set(n.__c, n); t.c = n.__c; } return t; }
    if (n.nodeType !== 1) return null;
    if (n.__c == null) { n.__c = "c" + nextC++; byC.set(n.__c, n); }
    if (root) n.__root = true;
    var a = {}, i;
    for (i = 0; i < n.attributes.length; i++) a[n.attributes[i].name] = n.attributes[i].value;
    var out = { c: n.__c, t: n.nodeName.toLowerCase(), a: a, k: [] };
    for (var ch = n.firstChild; ch; ch = ch.nextSibling) { var s = ser(ch, false); if (s) out.k.push(s); }
    return out;
  }
  function unregister(n) { if (n.__c != null) byC.delete(n.__c); for (var c = n.firstChild; c; c = c.nextSibling) unregister(c); }
  function nid(n) { return n.__i != null ? n.__i : n.__c; }

  function diffAttributes(n, ops) {
    var k = kn(n), o = own(n), i, t;
    var cur = tokens(n), add = cur.filter(function (x) { return k.cur.indexOf(x) < 0; }), rem = k.cur.filter(function (x) { return cur.indexOf(x) < 0; });
    if (add.length || rem.length) {
      ops.push({ o: "class", n: n.__i, add: add, rem: rem });
      add.forEach(function (x) { o.add[x] = 1; delete o.rem[x]; });
      rem.forEach(function (x) { if (k.host.indexOf(x) >= 0) o.rem[x] = 1; delete o.add[x]; });
      k.cur = cur;
    }
    var sty = styleMap(n), set = {}, gone = [], changed = false, p;
    for (p in sty) if (k.sty[p] !== sty[p]) { set[p] = sty[p]; o.style[p] = sty[p]; changed = true; }
    for (p in k.sty) if (!(p in sty)) { gone.push(p); delete o.style[p]; changed = true; }
    if (changed) { ops.push({ o: "style", n: n.__i, set: set, rem: gone }); k.sty = sty; }
    var seen = {};
    for (i = 0; i < n.attributes.length; i++) {
      var name = n.attributes[i].name, val = n.attributes[i].value;
      if (name === "class" || name === "style") continue;
      seen[name] = 1;
      if (k.attrs[name] !== val) { ops.push({ o: "attr", n: n.__i, name: name, value: val }); k.attrs[name] = val; o.attrs[name] = 1; }
    }
    for (t in k.attrs) if (!seen[t]) { ops.push({ o: "attr", n: n.__i, name: t, value: null }); delete k.attrs[t]; o.attrs[t] = 1; }
  }

  function onMutations(records) {
    if (syncing) return;
    slice();
    var ops = [], attrNodes = new Set(), parents = new Set(), replaced = new Set(), refused = false, removedCreated = [];
    records.forEach(function (r) {
      var t = r.target;
      if (r.type === "attributes") { attrNodes.add(t); return; }
      if (r.type === "characterData") {
        var cr = createdRoot(t);
        if (cr) replaced.add(cr); else if (t.__i != null) refused = true;
        return;
      }
      parents.add(t);
      r.removedNodes.forEach(function (x) {
        if (x.isConnected) return;
        if (x.__i != null) refused = true;
        else if (x.__c != null && x.__root) removedCreated.push(x);
      });
    });
    removedCreated.forEach(function (x) { ops.push({ o: "remove", c: x.__c }); unregister(x); });
    parents.forEach(function (p) {
      if (!p.isConnected && p !== document) return;
      var cr = createdRoot(p);
      if (cr) { replaced.add(cr); return; }
      for (var c = p.firstChild; c; c = c.nextSibling) {
        // the frame's own bootstrap <script> lives in <body>: never something a survey script added
        if (c.__i == null && c.__c == null && c.nodeName !== "SCRIPT") {
          var before = null; for (var s = c.nextSibling; s; s = s.nextSibling) if (s.__i != null) { before = s.__i; break; }
          var tree = ser(c, true);
          if (tree && p.__i != null) ops.push({ o: "create", c: c.__c, p: p.__i, b: before, tree: tree });
        }
      }
    });
    attrNodes.forEach(function (n) {
      var cr = createdRoot(n);
      if (cr) { replaced.add(cr); return; }
      if (n.__i != null) diffAttributes(n, ops);
    });
    replaced.forEach(function (rt) { if (!rt.isConnected) return; var tree = ser(rt, true); if (tree) ops.push({ o: "replace", c: rt.__c, tree: tree }); });
    if (ops.length) send("ops", [ops]);
    if (refused) { note("refused", "a script removed or rewrote text the survey itself drew — that is ignored (the survey owns it). Create your own element instead, or use rs.showMessage."); send("resync", []); }
  }

  /* -------------------------------------------- the standard APIs, made to say why */
  var nativeAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if ((type === "DOMContentLoaded" || type === "load") && (this === document || this === window)) {
      if (typeof fn === "function") nativeTimeout(function () { slice(); try { fn.call(this, new Event(type)); } catch (e) { fail(e); } }, 0);
      return;
    }
    if (FORWARD[type] && !wanted[type]) { wanted[type] = 1; send("want", [type]); }
    return nativeAdd.call(this, type, fn, opts);
  };
  /*
   * Code is not something a script may make out of text: a <script> element or an on* attribute would
   * run its text inside this frame — eval by another name, past the check that bans eval. The frame is
   * sandboxed either way; this keeps the rule one rule.
   */
  var nativeCreate = Document.prototype.createElement, nativeCreateNS = Document.prototype.createElementNS;
  document.createElement = function (tag, o) {
    if (/^(script|iframe|frame|object|embed|link|meta|base|style)$/i.test(String(tag))) { note("tag:" + tag, "a script cannot create a <" + String(tag).toLowerCase() + "> element"); return nativeCreate.call(document, "template"); }
    return nativeCreate.call(document, tag, o);
  };
  document.createElementNS = function (ns, tag, o) {
    if (/^(script|iframe|frame|object|embed|link|meta|base|style|foreignobject)$/i.test(String(tag))) { note("tag:" + tag, "a script cannot create a <" + String(tag).toLowerCase() + "> element"); return nativeCreate.call(document, "template"); }
    return nativeCreateNS.call(document, ns, tag, o);
  };
  var nativeSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (/^on/i.test(String(name))) { note("on:" + name, "a script cannot set an event-handler attribute (" + String(name).toLowerCase() + ") — use addEventListener"); return; }
    return nativeSetAttr.call(this, name, value);
  };
  var nativePD = Event.prototype.preventDefault;
  Event.prototype.preventDefault = function () {
    note("prevent", "preventDefault has no effect in a survey script: the click or keypress has already happened. Scripts observe the survey; to stop a page being left, use validation.");
    return nativePD.call(this);
  };
  var nativeQS = Document.prototype.querySelector, nativeQSA = Document.prototype.querySelectorAll;
  document.querySelector = function (s) { var r = nativeQS.call(document, s); if (!r) note("qs:" + s, "document.querySelector(" + JSON.stringify(String(s)) + ") matched nothing on this page"); return r; };
  document.querySelectorAll = function (s) { var r = nativeQSA.call(document, s); if (!r.length) note("qsa:" + s, "document.querySelectorAll(" + JSON.stringify(String(s)) + ") matched nothing on this page"); return r; };

  /* ---------------------------------------- real events, from the host, onto the mirror */
  function eventFor(type, d) {
    d = d || {};
    if (type === "keydown" || type === "keyup") return new KeyboardEvent(type, { key: d.key, code: d.code, bubbles: true, cancelable: true });
    if (type === "click" || type === "dblclick" || type === "mouseover" || type === "mouseout" || type === "pointerdown" || type === "pointerup") return new MouseEvent(type === "pointerdown" ? "mousedown" : type === "pointerup" ? "mouseup" : type, { bubbles: true, cancelable: true });
    if (type === "focusin" || type === "focusout") return new FocusEvent(type, { bubbles: true });
    return new Event(type, { bubbles: true, cancelable: true });
  }
  function nodeFor(id) { return id == null ? null : (typeof id === "string" ? byC.get(id) : byId.get(id)) || null; }
  function deliver(m) {
    var node = nodeFor(m.n);
    if (!node || !node.isConnected) return;
    var d = m.d || {};
    if (node.nodeType === 1) { if ("value" in d && "value" in node) node.value = d.value; if ("checked" in d && "checked" in node) node.checked = !!d.checked; }
    slice();
    node.dispatchEvent(eventFor(m.ev, d));
    // events that do not bubble, derived from the ones that do
    if (m.ev === "focusin") node.dispatchEvent(new FocusEvent("focus"));
    else if (m.ev === "focusout") node.dispatchEvent(new FocusEvent("blur"));
    else if (m.ev === "mouseover" || m.ev === "mouseout") {
      var rel = nodeFor(m.rn), enter = m.ev === "mouseover";
      for (var c = node; c && c.nodeType === 1; c = c.parentNode) {
        if (rel && c.contains(rel)) break;
        c.dispatchEvent(new MouseEvent(enter ? "mouseenter" : "mouseleave"));
      }
    }
  }

  /* ----------------------------------------------------------- the host's messages */
  window.addEventListener("message", function (e) {
    if (e.source !== host) return;
    var m = e.data; if (!m || m.__rsux !== 1) return;
    if (m.type === "init") {
      answers = m.answers || {}; meta = m.meta || meta;
      applyTree(m.tree);
      observer = new MutationObserver(onMutations);
      observer.observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
      ready = true;
      slice();
      try { (new Function("rs", m.code))(Object.freeze(rs)); } catch (err) { fail(err); }
    }
    else if (m.type === "sync") { if (ready) applyTree(m.tree); }
    else if (m.type === "answers") { answers = m.answers || {}; }
    else if (m.type === "dom") { if (ready) deliver(m); }
    else if (m.type === "event") { handlers.forEach(function (h) { if (h.ev === m.ev && (h.target === m.target || (h.target === "self" && m.self))) { slice(); try { h.fn(m.payload); } catch (err) { fail(err); } } }); }
  });
  send("ready", []);
})();
</script></body></html>`;
