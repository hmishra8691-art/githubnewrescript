import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareRichHtml, scopeAuthorCss, scopeSelectorList, scopeSelectorFor, unwrapDocument, hasStyleBlock } from "./scopedHtml.js";
import { sanitizeHtml, stripHtmlText, sanitizeStylesheet } from "./html.js";

/*
 * THE CHESS BOARD (October 2026 review): HTML and CSS written together in
 * the question text must draw as an 8 × 8 grid, the same as in a Text / HTML
 * block, with the CSS kept to the question.
 */
const CHESS = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Chess Board</title>
<style>
body { display: flex; justify-content: center; }
.chess-board { display: grid; grid-template-columns: repeat(8, 60px); }
.square { width: 60px; height: 60px; }
@media (max-width: 600px) { .square { width: 30px; height: 30px; } }
</style></head>
<body><div class="chess-board"><div class="square">♜</div></div></body></html>`;

test("sanitizeHtml — the author's <style> is kept when asked for; Word's never; elsewhere it is removed as before", () => {
  const kept = sanitizeHtml(CHESS, { keepStyles: true });
  assert.match(kept, /<style>[\s\S]*grid-template-columns: repeat\(8, 60px\)[\s\S]*<\/style>/, "the layout CSS survives the save");
  assert.match(kept, /class="chess-board"/);
  assert.doesNotMatch(kept, /<meta/, "meta is still blocked");
  assert.doesNotMatch(sanitizeHtml(CHESS), /<style/, "an option label or a message keeps no stylesheet");
  const word = `<style>p.MsoNormal { mso-style-parent: ""; }</style><p class="MsoNormal">Hi</p>`;
  assert.doesNotMatch(sanitizeHtml(word, { keepStyles: true }), /<style/, "Word's sheet is residue even where styles are kept");
  assert.equal(stripHtmlText(`<style>.a{color:red}</style>Board`), "Board", "a stylesheet is never read as text");
});

test("sanitizeStylesheet — executable CSS removed, layout CSS untouched", () => {
  const css = ".a { display: grid; gap: 4px; background: url(javascript:alert(1)); } @import url(x.css); .b { behavior: url(x.htc); width: 60px; }";
  const out = sanitizeStylesheet(css);
  assert.match(out, /display: grid; gap: 4px;/);
  assert.match(out, /width: 60px/);
  assert.doesNotMatch(out, /javascript|@import|behavior/);
  assert.doesNotMatch(sanitizeStylesheet(".a{}</style><script>x</script>"), /<\/style>/, "cannot close its element early");
  const html = sanitizeHtml(`<style onload="x()">.a{color:red}</style>`, { keepStyles: true });
  assert.doesNotMatch(html, /onload/);
});

test("scopeSelectorList — every selector lands inside the question", () => {
  const S = scopeSelectorFor("q1");
  assert.equal(S, '[data-rs-scope="q1"]');
  assert.equal(scopeSelectorList(".square", S), `${S} .square`);
  assert.equal(scopeSelectorList("body", S), S, "body is the question's box");
  assert.equal(scopeSelectorList("html, body", S), `${S}, ${S}`);
  assert.equal(scopeSelectorList("body > div", S), `${S} > div`);
  assert.equal(scopeSelectorList(":root .x", S), `${S} .x`);
  assert.equal(scopeSelectorList("*", S), `${S} *`);
  assert.equal(scopeSelectorList("a:is(.x, .y), th", S), `${S} a:is(.x, .y), ${S} th`, "commas inside :is() are not selector separators");
  assert.equal(scopeSelectorList("tbody td", S), `${S} tbody td`, "body inside a word is not the page body");
  assert.equal(scopeSelectorList(`${S} .x`, S), `${S} .x`, "already scoped is left alone");
});

test("scopeAuthorCss — rules, @media nesting, keyframes and strings", () => {
  const S = scopeSelectorFor("q1");
  const out = scopeAuthorCss(`.a{color:red} @media (max-width:600px){.b{width:30px}} @keyframes spin{from{transform:rotate(0)}to{transform:rotate(1turn)}} .c::before{content:"{ }"}`, S);
  assert.match(out, /\[data-rs-scope="q1"\] \.a \{color:red\}/);
  assert.match(out, /@media \(max-width:600px\) \{\[data-rs-scope="q1"\] \.b \{width:30px\}\}/);
  assert.match(out, /@keyframes spin \{from\{transform:rotate\(0\)\}to\{transform:rotate\(1turn\)\}\}/, "keyframe stops are not selectors");
  assert.match(out, /\[data-rs-scope="q1"\] \.c::before \{content:"\{ \}"\}/, "a brace in a string does not end the rule");
  assert.doesNotMatch(scopeAuthorCss("/* .x{} */ .y{a:b}", S), /\.x/, "comments go");
  const phone = scopeAuthorCss("@media (max-width: 600px) { .sq { width: 30px } }", S);
  assert.match(phone, /\.rs-viewport\.mobile \[data-rs-scope="q1"\] \.sq \{ width: 30px \}/, "the Mobile preview answers a phone media query");
  assert.doesNotMatch(phone, /tablet/, "a 600px query is not a tablet's");
  assert.match(scopeAuthorCss("@media (max-width: 1024px) { .sq { width: 40px } }", S), /\.rs-viewport\.tablet/);
});

test("prepareRichHtml — the pasted page unwrapped, its stylesheet scoped, the board intact", () => {
  const out = prepareRichHtml(sanitizeHtml(CHESS, { keepStyles: true }), "q46");
  assert.doesNotMatch(out, /<!DOCTYPE|<html|<head|<body|<title|Chess Board<\/title>/i, "the document wrapper is gone");
  assert.match(out, /\[data-rs-scope="q46"\] \.chess-board \{ display: grid; grid-template-columns: repeat\(8, 60px\); \}/);
  assert.match(out, /\[data-rs-scope="q46"\] \{ display: flex; justify-content: center; \}/, "body{} styles the question, not the page");
  assert.match(out, /<div class="chess-board"><div class="square">♜<\/div><\/div>/);
  assert.equal(prepareRichHtml("plain text", "q1"), "plain text");
  assert.ok(hasStyleBlock(CHESS) && !hasStyleBlock("<b>x</b>"));
  assert.equal(unwrapDocument("<body class='x'><p>a</p></body>"), "<p>a</p>");
});
