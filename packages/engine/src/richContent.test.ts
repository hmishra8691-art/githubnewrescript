import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  buildVariableDictionary, createResponseState, effectiveQuestion, mediaDisplayCss, mediaDisplayFromCss, mediaDisplayStyle, mediaHtml,
  sanitizeCss, sanitizeHtml, stripHtmlText,
} from "./index.js";

/**
 * RICH ANSWER OPTIONS AND SIZED MEDIA — the safety and the consistency.
 *
 * An option label is HTML everywhere it is rendered; this file pins that it
 * is SAFE HTML at the one seam every variant reads through
 * (`effectiveQuestion`), that inline CSS keeps its formatting and loses its
 * executable constructions, that a picture-only label still has a name in
 * the exports, and that the size / fit / alignment a researcher chooses is
 * one computation from controls to CSS to markup and back.
 */

/* ============================================================ inline CSS */

test("inline style survives sanitising; executable CSS inside it does not", () => {
  const ok = '<span style="color: red; font-size: 1.25em">Big</span>';
  assert.equal(sanitizeHtml(ok), ok);
  const bad = '<span style="color:red; behavior: url(x.htc); background: url(javascript:alert(1)); width: expression(alert(1)); -moz-binding: url(a)">x</span>';
  const out = sanitizeHtml(bad);
  assert.match(out, /color: ?red/);
  assert.doesNotMatch(out, /behavior|javascript|expression\(|-moz-binding/);
  // an @import is a stylesheet construct, never a declaration
  assert.equal(sanitizeCss("@import url(evil.css); color: blue"), "color: blue");
  // a data: image is fine; data: html is not
  assert.match(sanitizeCss("background: url(data:image/png;base64,AAAA)"), /data:image/);
  assert.doesNotMatch(sanitizeCss("background: url(data:text/html,<script>)"), /data:text/);
  // a style that becomes empty is dropped altogether
  assert.equal(sanitizeHtml('<b style="behavior: url(x)">bold</b>'), "<b>bold</b>");
});

test("a picture keeps its sizing markup and loses its handlers", () => {
  const html = '<img src="/api/media/11111111-1111-4111-8111-111111111111/logo.png" alt="Acme" style="width: 300px; height: auto; max-width: 100%" onload="steal()" data-rs-media="image">';
  const out = sanitizeHtml(html);
  assert.match(out, /width: 300px/);
  assert.match(out, /alt="Acme"/);
  assert.match(out, /data-rs-media="image"/);
  assert.doesNotMatch(out, /onload/);
  const video = mediaHtml("video", "/api/media/11111111-1111-4111-8111-111111111111/clip.mp4", { width: 480, autoplay: true, loop: true }, { mimeType: "video/mp4" });
  assert.equal(sanitizeHtml(video), video, "what the dialog inserts is what the sanitiser keeps");
});

/* ============================================================ the label seam */

function survey(labels: { option?: string; row?: string; column?: string }) {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Rich", version: "1.0" },
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Pick", options: [{ code: 1, label: labels.option ?? "Plain" }, { code: 2, label: "Other" }] },
      { id: "q2", code: "Q2", variableName: "Q2", type: "matrix_single", text: "Grid",
        rows: [{ code: "r1", label: labels.row ?? "Row" }],
        columns: [{ id: "c1", label: labels.column ?? "Col", responseType: "single", variableStem: "Q2", options: [{ code: 1, label: "A" }] }] },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }],
  });
}

test("labels reach the renderer sanitised — options, rows and columns — and plain ones untouched", () => {
  const def = survey({
    option: '<b onclick="x()">Bold</b><script>alert(1)</script> brand',
    row: '<i style="color:red;behavior:url(a)">Row</i>',
    column: '<img src="x" onerror="y()">',
  });
  const state = createResponseState(def, { seed: 1 });
  const v1 = effectiveQuestion(def.questions[0], { def, state });
  assert.equal(v1.options[0].label, "<b>Bold</b> brand");
  assert.equal(v1.options[1].label, "Other", "a plain label is the same string");
  const v2 = effectiveQuestion(def.questions[1], { def, state });
  assert.equal(v2.rows[0].label, '<i style="color:red">Row</i>');
  assert.equal(v2.columns[0].label, '<img src="x">');
});

test("a picture-only option reads as its alt text in the dictionary; markup never reaches value labels", () => {
  const def = survey({ option: '<img src="/api/media/22222222-2222-4222-8222-222222222222/acme.png" alt="Acme">' });
  assert.equal(stripHtmlText(def.questions[0].options[0].label), "Acme");
  assert.equal(stripHtmlText("<b>Bold</b> brand"), "Bold brand");
  assert.equal(stripHtmlText("plain"), "plain");
  const dict = buildVariableDictionary(def);
  const q1 = dict.find((v) => v.name === "Q1");
  assert.ok(q1);
  assert.equal(q1!.valueLabels?.["1"], "Acme");
  assert.equal(q1!.valueLabels?.["2"], "Other");
});

/* ============================================================ MediaDisplay */

test("size / fit / alignment is one computation: controls → CSS → markup → controls", () => {
  const css = mediaDisplayCss({ width: 300, fit: "contain", align: "center" });
  assert.equal(css, "width: 300px; height: auto; max-width: 100%; object-fit: contain; display: block; margin-left: auto; margin-right: auto");
  assert.deepEqual(mediaDisplayStyle({ width: "60%", maxHeight: "200px", responsive: false }), { width: "60%", height: "auto", maxHeight: "200px" });
  // custom CSS is appended, sanitised
  assert.match(mediaDisplayCss({ css: "border-radius: 8px; behavior: url(x)" }), /border-radius: 8px/);
  assert.doesNotMatch(mediaDisplayCss({ css: "border-radius: 8px; behavior: url(x)" }), /behavior/);
  // round trip
  const back = mediaDisplayFromCss(css);
  assert.equal(back.width, "300px");
  assert.equal(back.fit, "contain");
  assert.equal(back.align, "center");
  assert.equal(back.responsive, undefined, "max-width: 100% means responsive, the default");
  const noResp = mediaDisplayFromCss("width: 300px; height: auto");
  assert.equal(noResp.responsive, false);
  // markup
  const img = mediaHtml("image", "/api/media/33333333-3333-4333-8333-333333333333/a.png", { width: 300, align: "center" }, { alt: 'Acme "the" logo' });
  assert.match(img, /^<img src="\/api\/media\/33333333-3333-4333-8333-333333333333\/a.png" alt="Acme &quot;the&quot; logo" style="width: 300px; height: auto; max-width: 100%; display: block; margin-left: auto; margin-right: auto" data-rs-media="image">$/);
  const audio = mediaHtml("audio", "/api/media/33333333-3333-4333-8333-333333333333/a.mp3", { autoplay: true, loop: true, controls: false });
  assert.match(audio, /^<audio src="[^"]+" autoplay loop preload="metadata"/);
  assert.doesNotMatch(audio, / controls/);
  // a script URL is never a src
  assert.match(mediaHtml("image", "javascript:alert(1)", undefined), /src="#"/);
});
