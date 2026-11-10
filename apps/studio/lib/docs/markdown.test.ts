import { test } from "node:test";
import assert from "node:assert/strict";
import { inline, renderMarkdown, slug } from "./markdown.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { docsDir, listDocs, readDoc, renderDoc } from "./pages.ts";
import { DOC_NAV } from "./nav.ts";
import { screenById } from "./screens.ts";
import { DOC_EXAMPLES } from "./examples.ts";

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
  assert.ok(r.html.includes('<pre data-lang="json"><code class="language-json">{ <span class="tk-k">&quot;a&quot;</span>: <span class="tk-s">&quot;&lt;b&gt;&quot;</span> }</code></pre>'), r.html);
  assert.ok(r.html.includes("<th>a</th><th>b</th>"));
  assert.ok(r.html.includes("<td><code>x|y</code></td><td><strong>z</strong></td>"), r.html);
  assert.ok(r.html.includes("<ul><li>one</li><li>two continued</li></ul>"));
  assert.ok(r.html.includes("<ol><li>first</li><li>second</li></ol>"));
  assert.ok(r.html.includes("<blockquote><p>quoted</p></blockquote>"));
  assert.ok(r.html.includes("<hr>"));
  assert.ok(!r.html.includes("generated"), "comments are dropped");
  assert.equal(renderMarkdown("# First\n\n# Second").title, "First", "the title is the first H1");
});

test("the pages: every page in the navigation exists, has a title and renders; a bad slug is null; links resolve", () => {
  assert.ok(docsDir().endsWith("docs"));
  const pages = listDocs();
  const navSlugs = [...new Set(DOC_NAV.flatMap((c) => c.groups.flatMap((g) => g.slugs)))];
  assert.equal(pages.length, navSlugs.length, `every page in the navigation is on disk: missing ${navSlugs.filter((s) => !pages.some((p) => p.slug === s)).join(", ")}`);
  for (const p of pages) {
    const doc = renderDoc(p.slug)!;
    assert.ok(doc.title.length > 3, p.slug);
    assert.ok(doc.html.length > 500, p.slug);
    assert.ok(!doc.html.includes("<!-- ") && !doc.html.includes("<script"), p.slug);
    assert.ok(p.description.length > 10, `${p.slug} has a one-line description`);
  }
  assert.equal(pages.filter((p) => p.generated).map((p) => p.slug).sort().join(","), "actions-reference,capabilities,logic-reference,question-types");
  // a page in the navigation that is not on disk is not listed (a deploy missing a file must not 404 from its own navigation)
  DOC_NAV[0].groups[0].slugs.push("zzz-not-on-disk");
  try { assert.ok(!listDocs().some((p) => p.slug === "zzz-not-on-disk")); } finally { DOC_NAV[0].groups[0].slugs.pop(); }
  assert.equal(readDoc("../secret"), null);
  assert.equal(readDoc("index/../index"), null, "a slug is one path segment");
  assert.equal(readDoc("index.md"), null);
  assert.equal(readDoc("nope"), null);
  assert.equal(renderDoc("nope"), null);
  // every relative link on a page points at a page that exists
  for (const p of pages) {
    const md = readDoc(p.slug)!;
    for (const m of md.matchAll(/\]\(([a-z0-9-]+)\)/g)) assert.ok(pages.some((x) => x.slug === m[1]), `${p.slug} links to ${m[1]}`);
  }
});

test("Developer Docs: every guide (A–G) has its live example, steps, and the sections a reader needs; related pages exist", () => {
  const pages = listDocs();
  const GUIDED = ["fundamentals", "advanced", "intelligent", "actions", "designs", "branding", "platform"];
  const reference = new Set(DOC_NAV.filter((c) => c.key === "reference").flatMap((c) => c.groups.flatMap((g) => g.slugs)));
  const guides = pages.filter((p) => GUIDED.includes(p.category) && !reference.has(p.slug) && p.group !== "Reference");
  assert.ok(guides.length >= 36 + 24 + 17 + 5, `${guides.length} guides`);
  const ids = new Set(DOC_EXAMPLES.map((e) => e.id));
  const used = new Set<string>();
  for (const g of guides) {
    const doc = renderDoc(g.slug)!;
    if (doc.meta.example !== "none") assert.ok(doc.examples.length >= 1, `${g.slug} has a live example`);
    /* a platform page without a live survey shows the tool itself (a captured screen) or a catalog generated from the code */
    if (doc.meta.example === "none" && ["branding", "platform"].includes(g.category)) assert.ok(/rs-example:(screen|catalog)-/.test(doc.html), `${g.slug} shows a screen or a catalog`);
    for (const m of doc.html.matchAll(/rs-example:screen-([a-z0-9-]+?)-->/g)) assert.ok(screenById(m[1]), `${g.slug}: screen ${m[1]} is defined`);
    for (const e of doc.examples) { assert.ok(ids.has(e), `${g.slug}: example ${e} exists`); used.add(e); }
    assert.ok(doc.html.includes("docs-steps"), `${g.slug} has step-by-step instructions`);
    for (const h of ["Common mistakes", "Troubleshooting"]) assert.ok(doc.headings.some((x) => x.text === h), `${g.slug}: ${h}`);
    assert.ok(doc.headings.some((x) => /^When (?:and why )?to use it$|^The flow elements$|^Two kinds of method$|^How to use one$|^When something does not go as expected$|^What is checked$|^Available action types$|^Action types$|^Supported presets$|^Channels and events$|^Available triggers and effects$|^The review in four places$/.test(x.text)), `${g.slug}: when to use it`);
    for (const r of (doc.meta.related ?? "").split(",").map((x) => x.trim()).filter(Boolean)) assert.ok(pages.some((p) => p.slug === r), `${g.slug} relates to ${r}`);
  }
  assert.deepEqual(DOC_EXAMPLES.map((e) => e.id).filter((e) => !used.has(e)), [], "every example is placed on a page");
});

test("no llms.txt anywhere: the routes, the header link and the helpers are gone", () => {
  for (const f of ["app/llms.txt/route.ts", "app/llms-full.txt/route.ts", "app/api/docs/[slug]/route.ts"]) assert.equal(existsSync(join(process.cwd(), f)), false, f);
  for (const f of ["app/docs/DocShell.tsx", "lib/docs/pages.ts", "middleware.ts", "app/robots.ts", "next.config.mjs"]) assert.ok(!readFileSync(join(process.cwd(), f), "utf8").includes("llms"), f);
});

test("Developer Docs markdown: front matter, examples, steps, callouts and highlighting — still escaping everything", () => {
  const r = renderMarkdown("---\nsummary: S <x>\nrelated: a, b\n---\n# T\n\n::: example display-logic\n\n::: steps Do it\n1. **One** — the <b>first</b>\n2. Two\n:::\n\n::: warning Careful\nNo `<script>` here.\n:::\n\n```js\nconst a = \"<i>\"; // c\n```\n\n```logic\nQ1 = 2 AND NOT Q5.3 -- note\n```");
  assert.deepEqual(r.meta, { summary: "S <x>", related: "a, b" });
  assert.deepEqual(r.examples, ["display-logic"]);
  assert.ok(r.html.includes("<!--rs-example:display-logic-->"));
  assert.ok(r.html.includes('<ol class="docs-steps"') && r.html.includes("<summary><span class=\"docs-step-n\">1</span><strong>One</strong></summary><div class=\"docs-step-body\">the &lt;b&gt;first&lt;/b&gt;</div>"), r.html);
  assert.ok(r.html.includes('docs-callout-warning') && r.html.includes("<code>&lt;script&gt;</code>"));
  assert.ok(r.html.includes('<span class="tk-k">const</span>') && r.html.includes('<span class="tk-s">&quot;&lt;i&gt;&quot;</span>') && r.html.includes('<span class="tk-c">// c</span>'));
  assert.ok(r.html.includes('<span class="tk-k">AND</span>') && r.html.includes('<span class="tk-c">-- note</span>'));
  assert.ok(!/<(?:b|i|script)>/.test(r.html), "no author tag survives");
});

test("Developer Docs markdown: a ::: flow is a row of steps joined by arrows, escaped", () => {
  const r = renderMarkdown("::: flow How a change is made\n1. **You** — type <b>a sentence</b>\n2. Engine — reads it\n3. Approve\n:::");
  assert.ok(r.html.includes('data-testid="docs-flow"') && r.html.includes('aria-label="How a change is made"'));
  assert.equal((r.html.match(/docs-flow-step/g) ?? []).length, 3);
  assert.equal((r.html.match(/docs-flow-arrow/g) ?? []).length, 2);
  assert.ok(r.html.includes("type &lt;b&gt;a sentence&lt;/b&gt;"));
});

test("Developer Docs: the Branding group names the examples show are the Branding workspace's own", () => {
  const panel = readFileSync(join(process.cwd(), "components", "studio", "BrandingPanel.tsx"), "utf8");
  const live = readFileSync(join(process.cwd(), "components", "docs", "LiveExample.tsx"), "utf8");
  const map = /const BRANDING_GROUP[^=]*= (\{[^}]+\})/.exec(live)![1];
  for (const [, id, label] of map.matchAll(/(\w+): "([^"]+)"/g)) {
    if (id === "start") { assert.match(panel, /<b>Start from<\/b>/); continue; }
    assert.ok(panel.includes(`{ id: "${id}", label: "${label.replace(/&/g, "&")}"`), `${id} → ${label}`);
  }
  for (const e of DOC_EXAMPLES.filter((x) => x.builder.tab === "Branding")) assert.ok(map.includes(`${e.builder.group}:`), `${e.id}: group ${e.builder.group}`);
});
