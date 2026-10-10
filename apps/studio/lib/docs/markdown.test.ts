import { test } from "node:test";
import assert from "node:assert/strict";
import { inline, renderMarkdown, slug } from "./markdown.ts";
import { DOC_ORDER, docsDir, listDocs, llmsFull, llmsIndex, readDoc, renderDoc } from "./pages.ts";

/* THE DOCS RENDERER (Phase 7): every construct the pages use is drawn, everything is escaped, nothing else passes through. */
test("inline: code first, then links, bold and italic; everything escaped", () => {
  assert.equal(inline("use `a < b` and **bold** and *it* and [logic](logic) and [out](https://x.y/z)"), 'use <code>a &lt; b</code> and <strong>bold</strong> and <em>it</em> and <a href="logic">logic</a> and <a href="https://x.y/z" rel="noopener">out</a>');
  assert.equal(inline("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(inline("`**not bold**`"), "<code>**not bold**</code>");
  assert.equal(inline("2 * 3 * 4"), "2 * 3 * 4", "stray asterisks are not italics");
  assert.equal(slug("Conditions in text"), "conditions-in-text");
  assert.equal(slug("`set_research` & co."), "set-research-co");
});

test("blocks: headings with ids, paragraphs, fences, tables with escaped pipes, lists, quotes, rules, comments dropped", () => {
  const md = "<!-- generated -->\n# Title `x`\n\nA para\nover two lines.\n\n## Section one\n\n```json\n{ \"a\": \"<b>\" }\n```\n\n| a | b |\n|---|---|\n| `x\\|y` | **z** |\n\n- one\n- two\n  continued\n\n1. first\n2. second\n\n> quoted\n\n---\n\n### Sub";
  const r = renderMarkdown(md);
  assert.equal(r.title, "Title x");
  assert.deepEqual(r.headings.map((h) => [h.level, h.id]), [[1, "title-x"], [2, "section-one"], [3, "sub"]]);
  assert.ok(r.html.includes('<h1 id="title-x">Title <code>x</code></h1>'));
  assert.ok(r.html.includes("<p>A para over two lines.</p>"));
  assert.ok(r.html.includes('<pre><code class="language-json">{ &quot;a&quot;: &quot;&lt;b&gt;&quot; }</code></pre>'));
  assert.ok(r.html.includes("<th>a</th><th>b</th>"));
  assert.ok(r.html.includes("<td><code>x|y</code></td><td><strong>z</strong></td>"), r.html);
  assert.ok(r.html.includes("<ul><li>one</li><li>two continued</li></ul>"));
  assert.ok(r.html.includes("<ol><li>first</li><li>second</li></ol>"));
  assert.ok(r.html.includes("<blockquote><p>quoted</p></blockquote>"));
  assert.ok(r.html.includes("<hr>"));
  assert.ok(!r.html.includes("generated"), "comments are dropped");
  assert.equal(renderMarkdown("# First\n\n# Second").title, "First", "the title is the first H1");
});

test("the pages: every page in the order exists, has a title and renders; a bad slug is null; llms.txt lists every page", () => {
  assert.ok(docsDir().endsWith("docs"));
  const pages = listDocs();
  assert.equal(pages.length, DOC_ORDER.length, `every page in the order is on disk: ${pages.map((p) => p.slug).join(", ")}`);
  for (const p of pages) {
    const doc = renderDoc(p.slug)!;
    assert.ok(doc.title.length > 3, p.slug);
    assert.ok(doc.html.length > 500, p.slug);
    assert.ok(!doc.html.includes("<!--"), p.slug);
  }
  assert.equal(pages.filter((p) => p.generated).map((p) => p.slug).join(","), "question-types,logic-reference,actions-reference");
  // a page in the order that is not on disk is not listed (a deploy missing a file must not 404 from its own navigation)
  DOC_ORDER.push({ slug: "zzz-not-on-disk", description: "x" });
  try { assert.ok(!listDocs().some((p) => p.slug === "zzz-not-on-disk")); } finally { DOC_ORDER.pop(); }
  assert.equal(readDoc("../secret"), null);
  assert.equal(readDoc("index/../index"), null, "a slug is one path segment");
  assert.equal(readDoc("index.md"), null);
  assert.equal(readDoc("nope"), null);
  assert.equal(renderDoc("nope"), null);
  const idx = llmsIndex("https://x.test");
  assert.ok(idx.startsWith("# ReScript Studio\n"));
  for (const p of pages) assert.ok(idx.includes(`](https://x.test/docs/${p.slug}.md): ${p.description}`), p.slug);
  assert.ok(idx.includes("https://x.test/llms-full.txt"));
  const full = llmsFull();
  for (const p of pages) assert.ok(full.includes(`<!-- page: ${p.slug} -->`), p.slug);
  // every relative link on a page points at a page that exists
  for (const p of pages) {
    const md = readDoc(p.slug)!;
    for (const m of md.matchAll(/\]\(([a-z0-9-]+)\)/g)) assert.ok(pages.some((x) => x.slug === m[1]), `${p.slug} links to ${m[1]}`);
  }
});
