import { test } from "node:test";
import assert from "node:assert/strict";
import { typedMarkup, decodeTypedMarkup } from "./typedMarkup.ts";

test("HTML typed into the Visual tab is recognised and turned back into markup", () => {
  const typed = "&lt;b&gt;Welcome to our survey&lt;/b&gt;";
  assert.ok(typedMarkup(typed));
  assert.equal(decodeTypedMarkup(typed), "<b>Welcome to our survey</b>");
  const attrs = '&lt;p style=&quot;color: red&quot; class=&quot;x&quot;&gt;Hi&lt;/p&gt;&lt;br/&gt;';
  assert.equal(decodeTypedMarkup(attrs), '<p style="color: red" class="x">Hi</p><br/>');
  assert.equal(decodeTypedMarkup("<div>&lt;h2&gt;Title&lt;/h2&gt;</div>"), "<div><h2>Title</h2></div>", "inside the editor's own paragraph");
});

test("escaped text that is not a tag is left alone", () => {
  assert.ok(!typedMarkup("5 &lt; 7 and 9 &gt; 3"));
  assert.ok(!typedMarkup("<b>real markup</b>"));
  assert.ok(!typedMarkup(""));
  assert.equal(decodeTypedMarkup("5 &lt; 7 &lt;b&gt;x&lt;/b&gt;"), "5 &lt; 7 <b>x</b>");
});
