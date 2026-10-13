import test from "node:test";
import assert from "node:assert/strict";
import { planStory } from "./fixture.js";
import { formatValue, displayDecimals, storyPlayerHtml, sceneTier, chartAlt, checkStoryForPublish, EVIDENCE_WORDS, type StoryReport } from "./index.js";

/**
 * THE STORY PLAYER AND ITS PUBLISH CHECK (audit Phase 4: "one link opens a
 * story with evidence and 'how was this calculated'; reduced motion honoured").
 */
const story = (): StoryReport => planStory();
const decode = (h: string) => h.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

test("every scene is on the page, with its headline as a heading and a way to jump to it", () => {
  const s = story();
  const html = storyPlayerHtml(s);
  assert.equal((html.match(/<section class="scene"/g) ?? []).length, s.scenes.length);
  for (const sc of s.scenes) assert.ok(html.includes(`>${sc.title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</h2>`) || decode(html).includes(sc.title), `headline of “${sc.title}”`);
  assert.equal((html.match(/data-go="/g) ?? []).length, s.scenes.length, "the outline lists every scene");
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<a class="skip"/);
});

test("the page is self-contained: no network, no external fonts, a policy that forbids both", () => {
  const html = storyPlayerHtml(story());
  assert.doesNotMatch(html, /(src|href)=["']https?:/i, "no external resource");
  assert.doesNotMatch(html, /url\(["']?https?:/i, "no external stylesheet resource");
  assert.doesNotMatch(html, /report-fonts/, "the fonts are not fetched from a path a shared link cannot reach");
  assert.match(html, /@font-face\{font-family:"Inter"/, "the fonts are inlined");
  assert.match(html, /font\/woff2?;base64,/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.ok(html.length < 450_000, `the page is a reasonable size (${html.length} bytes)`);
});

test("every figure on the page is a number the document holds — drawn values equal frozen values", () => {
  const s = story();
  const html = storyPlayerHtml(s);
  const chart = s.scenes.find((x) => x.visual.type === "chart")!;
  assert.equal(chart.visual.type, "chart");
  if (chart.visual.type !== "chart") return;
  const d = chart.visual.data;
  const table = /<table class="data">[\s\S]*?<\/table>/.exec(html.slice(html.indexOf(`>${chart.title}<`)))![0];
  const dec = displayDecimals(d, s.design.dataLabels.decimals);
  for (const ser of d.series) ser.values.forEach((v, i) => { if (v != null) assert.ok(table.includes(`<td>${formatValue(v, d, dec)}`), `the table carries ${v} as ${formatValue(v, d, dec)} (${d.categories[i]} / ${ser.name})`); });
  assert.ok(table.includes(`<th scope="row">${d.categories[0].replace(/&/g, "&amp;")}</th>`), "row headers are the categories");
  assert.ok(table.includes(ser0Name(d)), "column headers are the series");
});
const ser0Name = (d: { series: { name: string }[] }) => d.series[0].name.replace(/&/g, "&amp;").replace(/</g, "&lt;");

test("every chart or table scene answers “How was this calculated?” from the document", () => {
  const s = story();
  const html = storyPlayerHtml(s);
  const evidenced = s.scenes.filter((x) => x.visual.type === "chart" || x.visual.type === "table");
  assert.ok(evidenced.length > 2);
  assert.equal((html.match(/<details class="how">/g) ?? []).length >= evidenced.length, true);
  const src = evidenced[0].notes.sources[0];
  assert.ok(src, "a source");
  assert.ok(decode(html).includes(src.name), "the analysis is named");
  if (src.definitionHash) assert.ok(html.includes(src.definitionHash.slice(0, 10)), "the definition hash is shown");
  assert.match(html, /computed 2026-10-01/);
  assert.match(html, /Figures are frozen/);
});

test("a chart has a text alternative that states what it shows, and a table view of the same figures", () => {
  const s = story();
  const html = storyPlayerHtml(s);
  const sc = s.scenes.find((x) => x.visual.type === "chart")!;
  if (sc.visual.type !== "chart") return;
  const alt = chartAlt(sc.visual.data, sc.visual.chart, sc.title);
  assert.match(alt, /Base: \d+ respondents/);
  assert.ok(alt.length > 40);
  assert.ok(html.includes(`aria-label="${alt.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`) || decode(html).includes(alt), "the alternative is on the figure");
  assert.match(html, /data-toggle-view/);
  assert.match(html, /<svg [^>]*aria-hidden="true"/, "the drawing itself is hidden from a screen reader in favour of the sentence");
});

test("what the evidence supports is said in words, with a label for each level — not colour alone", () => {
  const html = storyPlayerHtml(story());
  for (const lvl of ["significant", "not_significant", "descriptive", "mixed", "exploratory"] as const) assert.ok(EVIDENCE_WORDS[lvl].label.length > 3 && EVIDENCE_WORDS[lvl].means.length > 20);
  assert.match(html, /class="badge" data-level="[a-z_]+"><span aria-hidden="true">[^<]*<\/span> [A-Z]/);
  const withCaveat = story();
  withCaveat.scenes[2].notes.caveats = ["Only 12 people answered this question."];
  assert.match(storyPlayerHtml(withCaveat), /<b>Read with care<\/b><ul><li>Only 12 people answered this question\.<\/li>/, "caveats are shown with the scene");
});

test("motion is a reveal only, and it is off when the reader's system asks for reduced motion — or the design says none", () => {
  const s = story();
  const html = storyPlayerHtml(s);
  assert.match(html, /@media \(prefers-reduced-motion:no-preference\)\{/, "motion exists only inside the no-preference query");
  assert.match(html, /@media \(prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{animation:none!important;transition:none!important/);
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  const guardStart = css.indexOf("@media (prefers-reduced-motion:no-preference){"), guardEnd = css.indexOf("@media (prefers-reduced-motion:reduce)");
  assert.ok(guardStart > 0 && guardEnd > guardStart);
  for (const m of css.matchAll(/animation:\s*(?!none)[a-z]/g)) assert.ok(m.index! > guardStart && m.index! < guardEnd, `an animation at ${m.index} is outside the no-preference block`);
  const none = structuredClone(s); none.design.motion.style = "none";
  assert.doesNotMatch(storyPlayerHtml(none), /@keyframes/, "a design with no motion carries none");
});

test("print and PDF show every scene, with no motion and no controls", () => {
  const html = storyPlayerHtml(story());
  assert.match(html, /@media print\{[^}]*button[^}]*display:none!important/);
  assert.match(html, /\.js \.scene,\.js \.scene\.filtered\{display:block!important/);
});

test("key points is a subset: the answer, the findings that carry evidence, what to do — and appendix and method stay for the researcher", () => {
  const s = story();
  const key = s.scenes.filter((x) => sceneTier(x) === "key"), detail = s.scenes.filter((x) => sceneTier(x) === "detail");
  assert.ok(key.length >= 3 && detail.length >= 2, `${key.length} key, ${detail.length} detail`);
  assert.ok(s.scenes.filter((x) => x.section === "appendix").every((x) => sceneTier(x) === "detail"));
  assert.ok(key.some((x) => x.kind === "summary") && key.every((x) => x.kind !== "method"));
  assert.match(storyPlayerHtml(s, { audience: "key" }), /data-tier-btn="key" aria-pressed="true"/);
  assert.match(storyPlayerHtml(s), /data-tier-btn="all" aria-pressed="true"/);
});

test("data newer than the story shows a banner and changes no figure", () => {
  const s = story();
  const plain = storyPlayerHtml(s), newer = storyPlayerHtml(s, { newerData: { since: "2026-10-05T00:00:00Z", responses: 37 } });
  assert.match(newer, /data-testid="newer-data"[^>]*>This story shows the data frozen on 2026-10-01\. 37 more responses have arrived since 2026-10-05/);
  assert.doesNotMatch(plain, /data-testid="newer-data"/);
  const strip = (h: string) => h.replace(/<p class="banner"[\s\S]*?<\/p>/, "");
  assert.equal(strip(newer), plain, "everything else is identical");
});

test("everything a person or model wrote is escaped; a hostile colour or logo cannot break out", () => {
  const s = story();
  s.title = `<script>alert(1)</script>"><img src=x onerror=alert(2)>`;
  s.scenes[1].title = `<b onmouseover=x>Headline</b>`;
  s.scenes[1].body = `</p><script>alert(3)</script>`;
  s.design.colors.primary = `red;}</style><script>alert(4)</script>`;
  s.design.logo = { dataUri: `javascript:alert(5)`, width: 10, height: 10, placement: "top_right" };
  const html = storyPlayerHtml(s);
  const bodyOnly = html.slice(html.indexOf("<body>"));
  const markup = bodyOnly.replace(/<script>\(function\(\)\{[\s\S]*?\}\)\(\);<\/script>/, "");
  assert.doesNotMatch(markup, /<script>alert|<img src=x|<b onmouseover|javascript:/, "no injected element or URL");
  assert.doesNotMatch(markup, /<[a-z][^>]*\son[a-z]+=/i, "no event-handler attribute anywhere");
  assert.doesNotMatch(html, /alert\(4\)/);
});

test("publish check: the planned story passes; a broken one is stopped with the scene named", () => {
  const ok = checkStoryForPublish(story());
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  const bad = story();
  const i = bad.scenes.findIndex((x) => x.visual.type === "chart");
  const sc = bad.scenes[i];
  if (sc.visual.type !== "chart") return;
  sc.title = " ";
  sc.visual.data.series[0].values.push(5);
  sc.visual.data.significanceTested = false; sc.visual.data.series[0].sig = ["a"];
  sc.notes.sources = []; sc.visual.source = { name: "" };
  bad.design.colors.textMuted = "#cccccc";
  const r = checkStoryForPublish(bad);
  assert.equal(r.ok, false);
  const codes = r.problems.map((p) => p.code);
  for (const c of ["no_headline", "chart_shape", "untested_letters", "no_source", "contrast"]) assert.ok(codes.includes(c), `${c} in ${codes.join(",")}`);
  assert.ok(r.problems.filter((p) => p.code !== "contrast").every((p) => p.sceneId === sc.id), "the scene is named");
  assert.equal(checkStoryForPublish({ ...story(), scenes: [] }).ok, false);
});
