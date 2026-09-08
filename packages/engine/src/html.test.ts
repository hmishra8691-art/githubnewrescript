import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeHtml, stripHtmlText, escapeHtml } from "./html.js";

/**
 * Word/MSO paste residue (see the doc comment on `stripMsoArtifacts` in
 * html.ts): Word's compatibility/proofing-language block, normally invisible,
 * survives a naive tag-stripper as visible plain text — "Normal 0 false
 * false false EN-US X-NONE TH" being the literal values of `<w:View>`,
 * `<w:Zoom>`, `<w:SaveIfXMLInvalid>`, `<w:IgnoreMixedContent>`,
 * `<w:AlwaysShowPlaceholderText>`, `<w:LidThemeAsian>` etc. once their tags
 * are removed but their text content is not.
 */
const MSO_BLOCK =
  '<!--[if gte mso 9]><xml>\n' +
  " <w:WordDocument>\n" +
  "  <w:View>Normal</w:View>\n" +
  "  <w:Zoom>0</w:Zoom>\n" +
  "  <w:SaveIfXMLInvalid>false</w:SaveIfXMLInvalid>\n" +
  "  <w:IgnoreMixedContent>false</w:IgnoreMixedContent>\n" +
  "  <w:AlwaysShowPlaceholderText>false</w:AlwaysShowPlaceholderText>\n" +
  "  <w:LidThemeOther>EN-US</w:LidThemeOther>\n" +
  "  <w:LidThemeComplexScript>X-NONE</w:LidThemeComplexScript>\n" +
  "  <w:LidThemeAsian>TH</w:LidThemeAsian>\n" +
  " </w:WordDocument>\n" +
  "</xml><![endif]-->";

const MSO_STYLE_BLOCK =
  "<style>\n" +
  "<!--\n" +
  " /* Style Definitions */\n" +
  " p.MsoNormal, li.MsoNormal, div.MsoNormal\n" +
  "\t{mso-style-parent:\"\";\n" +
  "\tmargin:0cm;\n" +
  "\tfont-size:12.0pt;}\n" +
  "-->\n" +
  "</style>";

test("stripHtmlText drops a Word conditional-comment/xml block entirely, not just its tags", () => {
  const pasted = `<p>What is your age?</p>${MSO_BLOCK}`;
  const out = stripHtmlText(pasted);
  assert.equal(out, "What is your age?");
  assert.doesNotMatch(out, /Normal|X-NONE|EN-US/);
});

test("stripHtmlText drops an mso <style> block entirely", () => {
  const pasted = `${MSO_STYLE_BLOCK}<p>Which brands have you used?</p>`;
  const out = stripHtmlText(pasted);
  assert.equal(out, "Which brands have you used?");
});

test("stripHtmlText still removes ordinary tags and handles empty/missing input", () => {
  assert.equal(stripHtmlText("<b>Bold</b> and <i>italic</i>"), "Bold and italic");
  assert.equal(stripHtmlText(""), "");
  assert.equal(stripHtmlText(null), "");
  assert.equal(stripHtmlText(undefined), "");
});

test("sanitizeHtml strips MSO artifacts at input time while preserving legitimate formatting", () => {
  const pasted = `<p><b>How satisfied are you?</b></p>${MSO_BLOCK}`;
  const out = sanitizeHtml(pasted);
  assert.equal(out, "<p><b>How satisfied are you?</b></p>");
  assert.doesNotMatch(out, /Normal|X-NONE|EN-US/);
});

test("sanitizeHtml still blocks script vectors (unchanged behaviour)", () => {
  const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a>';
  const out = sanitizeHtml(evil);
  assert.doesNotMatch(out, /onerror/);
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /javascript:/);
});

test("escapeHtml is unaffected by the MSO changes", () => {
  assert.equal(escapeHtml("<b>&\"'"), "&lt;b&gt;&amp;&quot;&#39;");
});
