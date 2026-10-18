import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { SurveyDefinition } from "@rescript/schema";
import { def as baseDef, synthRows, spec } from "./analyses/fixture.js";
import { buildDataset } from "./dataset.js";
import { runPlan } from "./findings.js";
import { deckFromRun } from "./deck.js";
import {
  REPORT_THEMES, DEFAULT_REPORT_THEME, interpretThemeRequest, findReportTheme, enforceTheme, mergeTheme, sanitizeThemePatch, readThemeSpec,
  themeToReportTheme, docStyleOf, reportThemeHash, describeReportTheme, type ThemeSpec,
} from "./reportThemes.js";
import { buildProposalDocx, buildResearchPlanDocx, buildFindingsDocx, logoFromBytes } from "./export/docx.js";
import { buildSapDocx } from "./export/sap.js";
import { buildDeckPptx } from "./export/deck.js";
import { unzipEntries, checkDocx } from "./export/docxCheck.js";
import { checkPptx, checkOfficeFile } from "./export/officeCheck.js";

/*
 * NATURAL-LANGUAGE REPORT THEMES (2026-10-18): the five example sentences read into a structured theme (or a
 * structure request), named themes resolved, the rules every theme obeys, and the look actually carried by the
 * Word documents (styles.xml + runs), the PowerPoint deck (slide XML) and a PDF converted from the Word file —
 * while the CONTENT (every word and number of the body) stays byte-identical.
 */

const H = (h: string) => h.replace("#", "").toUpperCase();

/* ------------------------------------------------------------ the five sentences */

test("1 · “premium corporate theme with navy headings, subtle cyan accents, clean white backgrounds” → a new theme on Executive Research", () => {
  const r = interpretThemeRequest("Apply our premium corporate theme with navy headings, subtle cyan accents, and clean white backgrounds");
  assert.equal(r.intent, "create");
  assert.equal(r.base, "builtin:executive_research");
  assert.equal(r.proposedName, "Premium Corporate");
  assert.deepEqual(r.named, { name: "Premium Corporate", found: false });
  const p = r.preview!;
  assert.equal(p.colors.heading, "#1B2A4A", "navy headings");
  assert.equal(p.colors.background, "#FFFFFF", "white backgrounds");
  assert.equal(p.colors.tableHeaderBg, "#1B2A4A", "the dark table header follows the new primary");
  /* cyan on white is under 3:1 — the accent keeps its hue and is darkened, and the preview says so */
  assert.ok(r.adjustments.some((a) => a.token === "accent" && /3:1/.test(a.why)), JSON.stringify(r.adjustments));
  assert.ok(p.chartPalette.includes(p.colors.accent), "the accent is the second series");
  assert.ok(r.understood.some((u) => /navy headings/.test(u)) && r.understood.some((u) => /cyan accents \(used sparingly/.test(u)));
  assert.equal(r.needsModel, false);
  assert.equal(r.structure, undefined, "a look is not a structure");
});

test("2 · “executive consulting-style layout” → Arial, ruled titles, minimal tables, airy spacing", () => {
  const r = interpretThemeRequest("Executive consulting-style layout with clean tables");
  assert.equal(r.intent, "create");
  assert.equal(r.preview!.typography.heading, "Arial");
  assert.equal(r.preview!.typography.body, "Arial");
  assert.equal(r.preview!.table.style, "minimal");
  assert.equal(r.preview!.layout.titleRule, true);
  assert.equal(r.preview!.layout.density, "airy");
});

test("3 · “healthcare research presentation, restrained colors, clear statistical annotations” → Healthcare Analytics, eased palette, clear annotations", () => {
  const r = interpretThemeRequest("Healthcare research presentation, restrained colors, clear statistical annotations");
  assert.equal(r.base, "builtin:healthcare_analytics");
  const hc = findReportTheme("Healthcare Analytics")!;
  assert.equal(r.preview!.annotations.emphasis, "clear");
  assert.notDeepEqual(r.preview!.chartPalette, hc.chartPalette, "the palette is eased toward grey");
  assert.equal(r.preview!.colors.heading, hc.colors.heading, "the headings keep the healthcare blue");
  assert.equal(r.needsModel, false);
});

test("4 · “use our uploaded logo and brand colors” → the brand on file; without one, a clear answer and no model call", () => {
  const withBrand = interpretThemeRequest("Use our uploaded logo and brand colors", { brand: { colors: ["#C8102E", "#003087"], logoUrl: "data:image/png;base64,AAAA" } });
  assert.equal(withBrand.intent, "create");
  assert.equal(withBrand.preview!.colors.primary, "#C8102E");
  assert.equal(withBrand.preview!.colors.accent, "#003087");
  assert.equal(withBrand.preview!.branding.logo.placement, "header");
  assert.deepEqual(withBrand.brand, { requested: true, colors: true, logo: true });
  const without = interpretThemeRequest("Use our uploaded logo and brand colors", { brand: null });
  assert.equal(without.intent, "none");
  assert.match(without.question!, /No brand colours or logo are on file/);
  assert.equal(without.needsModel, false, "nothing for a model to guess");
});

test("5 · “keep the content but reorganize around the main hypotheses and recommendations” → structure only, no look", () => {
  const r = interpretThemeRequest("Keep the content but reorganize around the main hypotheses and recommendations");
  assert.equal(r.intent, "structure");
  assert.deepEqual(r.structure!.order, ["summary", "hypotheses", "recommendations"]);
  assert.match(r.structure!.understood, /content kept exactly/);
  assert.equal(r.preview, null);
  assert.deepEqual(r.patch, {});
});

/* ------------------------------------------------------------ names */

test("a theme by name: built-in, saved (shadowing a built-in), unknown → asked to describe it; a name is not a description", () => {
  const hc = interpretThemeRequest("Apply the Healthcare Analytics theme");
  assert.equal(hc.intent, "apply_named");
  assert.equal(hc.named!.id, "builtin:healthcare_analytics");
  assert.deepEqual(hc.preview!.colors, findReportTheme("healthcare-analytics")!.colors);
  const mine: ThemeSpec = { ...structuredClone(REPORT_THEMES[0]), id: "11111111-1111-4111-8111-111111111111", name: "Healthcare Analytics", version: 3 };
  const shadow = interpretThemeRequest("apply the healthcare analytics theme", { saved: [mine] });
  assert.equal(shadow.named!.id, mine.id, "the organisation's own theme of that name wins");
  const unknown = interpretThemeRequest("Apply the Board Pack theme");
  assert.equal(unknown.intent, "unknown_name");
  assert.match(unknown.question!, /no theme called “Board Pack”/);
  assert.equal(unknown.base, undefined, "“board” in a name does not pick the executive look");
  const named = interpretThemeRequest("Apply the Board Pack theme with navy headings");
  assert.equal(named.intent, "create");
  assert.equal(named.proposedName, "Board Pack");
  const modify = interpretThemeRequest("Apply the Consumer Insights theme with Georgia headings");
  assert.equal(modify.intent, "modify");
  assert.equal(modify.preview!.typography.heading, "Georgia");
  assert.equal(modify.preview!.colors.primary, findReportTheme("Consumer Insights")!.colors.primary);
  const save = interpretThemeRequest("save this theme as Board Pack", { current: REPORT_THEMES[1] });
  assert.equal(save.intent, "save_as");
  assert.equal(save.saveAs, "Board Pack");
  assert.equal(save.preview!.colors.primary, REPORT_THEMES[1].colors.primary);
});

test("every built-in obeys the rules as shipped; a hostile patch is moved back inside them and the moves are reported", () => {
  assert.equal(REPORT_THEMES.length, 5);
  assert.deepEqual(REPORT_THEMES.map((t) => t.name), ["Executive Research", "Healthcare Analytics", "Brand Performance", "Consumer Insights", "Academic Research"]);
  for (const t of [...REPORT_THEMES, DEFAULT_REPORT_THEME]) assert.deepEqual(enforceTheme(t).adjustments, [], t.name);
  const bad = enforceTheme(mergeTheme(REPORT_THEMES[0], { colors: { text: "#EEEEEE", heading: "#FAFAFA", tableHeaderBg: "#FFFFFF", tableHeaderText: "#F0F0F0" }, chartPalette: ["#FFFFFF", "#FEFEFE"], typography: { heading: "<script>", baseSizePt: 99 } }));
  assert.ok(bad.adjustments.length >= 4);
  assert.equal(bad.theme.typography.heading, "Calibri", "a font name that is not a font name is dropped");
  assert.equal(bad.theme.typography.baseSizePt, 14);
});

test("a model's patch is kept to the vocabulary; a stored theme is read defensively", () => {
  const p = sanitizeThemePatch({ colors: { heading: "#123456", text: "red", evil: "#000000" }, chartPalette: ["#111111", "nope", "#222222"], typography: { heading: "Georgia", body: "x; rm -rf", h1Pt: 200 }, table: { style: "fancy" }, content: "rewrite the findings", sections: ["x"] });
  assert.deepEqual(p, { colors: { heading: "#123456" }, chartPalette: ["#111111", "#222222"], typography: { heading: "Georgia" } });
  assert.equal(readThemeSpec({ nope: 1 }), null);
  const back = readThemeSpec(JSON.parse(JSON.stringify(REPORT_THEMES[4])))!;
  assert.deepEqual(back.colors, REPORT_THEMES[4].colors);
  assert.equal(back.table.style, "minimal");
  assert.equal(reportThemeHash(back), reportThemeHash(REPORT_THEMES[4]), "the look survives a round trip");
  assert.equal(reportThemeHash({ ...back, name: "Other name", version: 9 }), reportThemeHash(back), "the hash is the look, not the name or version");
  assert.notEqual(reportThemeHash(mergeTheme(back, { colors: { heading: "#000000" } })), reportThemeHash(back));
  assert.match(describeReportTheme(REPORT_THEMES[1]), /Healthcare Analytics · #1D4E6B headings/);
});

test("one look, every format: the in-app/PowerPoint theme and the Word style tokens come from the same theme", () => {
  const t = REPORT_THEMES[0];
  const rt = themeToReportTheme(t);
  assert.equal(rt.colors.primary, t.colors.primary);
  assert.equal(rt.colors.subtle, t.colors.muted);
  assert.deepEqual(rt.colors.palette, t.chartPalette);
  assert.match(rt.fontFamily, /^Calibri/);
  const ds = docStyleOf(t);
  assert.equal(ds.heading, "1B2A4A"); assert.equal(ds.headFill, "1B2A4A"); assert.equal(ds.themed, true);
  const none = docStyleOf(null);
  assert.equal(none.ink, "16202E"); assert.equal(none.themed, false, "no theme = the documents' standard look");
});

/* ------------------------------------------------------------ the look in the files; the content untouched */

function survey() {
  const d = structuredClone(baseDef) as Record<string, unknown>;
  d.research = {
    objective: "Understand what drives satisfaction", population: "Adults", methodology: "Online panel", hypotheses: ["Women are more satisfied than men", "Satisfaction differs by region"], hypothesisDetails: [], researchQuestions: [], kpis: [], constructs: [], analysis: [], assumptions: [], sources: [],
    analysisPlan: { crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"] }], tests: [{ id: "t1", method: "t_test", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] }, { id: "t2", method: "anova", outcome: "SAT", variables: ["SAT"], groupBy: "REGION", priority: 2, hypotheses: ["H2"] }], derived: [], segments: [] },
  };
  return SurveyDefinition.parse(d);
}
const def = survey();
const run = runPlan(def, buildDataset(def, synthRows(300), { spec }), { trigger: "manual", now: "2026-10-01T10:00:00Z" });
const parts = (buf: Buffer) => unzipEntries(buf);
const xml = (buf: Buffer, name: string) => parts(buf).get(name)?.toString("utf8") ?? "";
/** the body's words and numbers, in order: every <w:t> of word/document.xml */
const bodyText = (buf: Buffer) => [...xml(buf, "word/document.xml").matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]);
const THEMES = [REPORT_THEMES[0], REPORT_THEMES[1], REPORT_THEMES[4], interpretThemeRequest("Apply our premium corporate theme with navy headings, subtle cyan accents, and clean white backgrounds").preview!];

test("Word: a theme changes styles.xml and the runs' colours and fonts — and not one word or number of the body (proposal, plan, SAP, findings)", async () => {
  const date = "2026-10-18";
  const builders: [string, (theme?: ThemeSpec) => Promise<Buffer>][] = [
    ["proposal", (theme) => buildProposalDocx(def, { date, theme })],
    ["research plan", (theme) => buildResearchPlanDocx(def, { date, theme })],
    ["SAP", (theme) => buildSapDocx(def, { date, theme })],
    ["findings", (theme) => buildFindingsDocx(def, run, { date, theme })],
  ];
  for (const [name, build] of builders) {
    const plain = await build();
    assert.ok(checkDocx(plain).ok, name);
    const plainText = bodyText(plain);
    assert.ok(plainText.length > 50, name);
    /* no theme: the standard look exactly as before — Calibri, ink 16202E, no declared heading styles */
    assert.match(xml(plain, "word/styles.xml"), /w:ascii="Calibri"/);
    assert.ok(xml(plain, "word/document.xml").includes('w:val="16202E"'), `${name}: the standard ink`);
    for (const theme of THEMES) {
      const themed = await build(theme);
      const c = checkDocx(themed);
      assert.deepEqual(c.problems, [], `${name} / ${theme.name}: a valid Word package`);
      assert.deepEqual(bodyText(themed), plainText, `${name} / ${theme.name}: the content is byte-identical`);
      const styles = xml(themed, "word/styles.xml");
      const doc = xml(themed, "word/document.xml");
      /* Heading 1 is declared with the theme's font and colour */
      const h1 = /<w:style[^>]*w:styleId="Heading1"[\s\S]*?<\/w:style>/.exec(styles)?.[0] ?? "";
      assert.ok(h1.includes(`w:val="${H(theme.colors.heading)}"`), `${name} / ${theme.name}: Heading 1 colour in styles.xml`);
      assert.ok(h1.includes(`w:ascii="${theme.typography.heading}"`), `${name} / ${theme.name}: Heading 1 font in styles.xml`);
      assert.ok(styles.includes(`w:ascii="${theme.typography.body}"`), `${name} / ${theme.name}: the body font is the document default`);
      assert.ok(doc.includes(`w:color w:val="${H(theme.colors.heading)}"`), `${name} / ${theme.name}: heading runs coloured`);
      assert.ok(doc.includes(`w:fill="${H(theme.colors.tableHeaderBg)}"`) || (theme.table.style === "minimal" && H(theme.colors.tableHeaderBg) === "FFFFFF"), `${name} / ${theme.name}: table header fill`);
      assert.ok(!doc.includes('w:val="16202E"') || H(theme.colors.text) === "16202E", `${name} / ${theme.name}: no standard ink left`);
    }
  }
});

test("Word: table formatting follows the theme — striped rows, minimal rules, grid", async () => {
  const striped = xml(await buildFindingsDocx(def, run, { theme: REPORT_THEMES[1] }), "word/document.xml");
  assert.ok(striped.includes(`w:fill="${H(REPORT_THEMES[1].colors.tableStripe)}"`), "striped rows are tinted");
  const minimal = xml(await buildFindingsDocx(def, run, { theme: REPORT_THEMES[4] }), "word/document.xml");
  assert.match(minimal, /<w:tcBorders>[\s\S]*?w:val="none"/, "minimal tables drop the cell rules");
  const clear = xml(await buildFindingsDocx(def, run, { theme: REPORT_THEMES[1] }), "word/document.xml");
  const subtle = xml(await buildFindingsDocx(def, run, {}), "word/document.xml");
  assert.ok((subtle.match(/<w:i\/>/g) ?? []).length > (clear.match(/<w:i\/>/g) ?? []).length, "clear annotations are upright, not italic");
});

test("Word: header/footer words and the logo come from the theme's branding; a PNG and a JPEG logo are sized from their headers", async () => {
  const png = Buffer.from("89504E470D0A1A0A0000000D49484452000000C8000000320806000000", "hex");
  const pngFull = Buffer.concat([png, Buffer.alloc(40)]);
  const logo = logoFromBytes(pngFull)!;
  assert.deepEqual([logo.type, logo.width, logo.height], ["png", 200, 50]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x01, 0x00, 0x03, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(((l) => [l.type, l.width, l.height])(logoFromBytes(jpg)!), ["jpg", 256, 64]);
  assert.equal(logoFromBytes(Buffer.from("GIF89a")), null);
  const theme = mergeTheme(REPORT_THEMES[0], { branding: { footer: "Confidential", header: "Acme Research", logo: { placement: "header", url: "data:image/png;base64,x" } } });
  const buf = await buildProposalDocx(def, { date: "2026-10-18", theme, logo });
  const all = [...parts(buf).entries()];
  const header = all.filter(([k]) => /word\/header\d*\.xml/.test(k)).map(([, v]) => v.toString("utf8")).join("");
  const footer = all.filter(([k]) => /word\/footer\d*\.xml/.test(k)).map(([, v]) => v.toString("utf8")).join("");
  assert.match(header, /Acme Research · /);
  assert.match(header, /<w:drawing>/, "the logo is in the header");
  assert.match(footer, /Confidential · 2026-10-18/);
  assert.ok(all.some(([k]) => k.startsWith("word/media/")), "the logo bytes are in the package");
  assert.ok(checkDocx(buf).ok);
});

test("structure, asked for in words: whole sections reordered around the hypotheses and recommendations — the same blocks, nothing added or lost", async () => {
  const order = interpretThemeRequest("Keep the content but reorganize around the main hypotheses and recommendations").structure!;
  const plain = await buildFindingsDocx(def, run, { date: "2026-10-18" });
  const moved = await buildFindingsDocx(def, run, { date: "2026-10-18", structure: order });
  const a = bodyText(plain), b = bodyText(moved);
  assert.deepEqual([...b].sort(), [...a].sort(), "the same words and numbers");
  assert.notDeepEqual(b, a, "in another order");
  const h1s = (buf: Buffer) => [...xml(buf, "word/document.xml").matchAll(/<w:pStyle w:val="Heading1"\/>[\s\S]*?<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]);
  const heads = h1s(moved);
  assert.equal(heads[0], "Executive summary");
  assert.equal(heads[1], "The hypotheses");
  if (h1s(plain).includes("What to do next")) assert.equal(heads[2], "What to do next");
  assert.deepEqual([...heads].sort(), [...h1s(plain)].sort());
  assert.equal(b.at(-1), a.at(-1), "the closing line stays last");
});

test("PowerPoint: the findings deck carries the theme in its slides (fills, text colours, fonts) with the same words", async () => {
  const deck = deckFromRun(def, run, {});
  const slideXml = (buf: Buffer) => [...parts(buf).entries()].filter(([k]) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort(([x], [y]) => Number(/\d+/.exec(x)![0]) - Number(/\d+/.exec(y)![0])).map(([, v]) => v.toString("utf8"));
  const words = (buf: Buffer) => slideXml(buf).map((x) => [...x.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join("|"));
  const plain = await buildDeckPptx({ deck, results: {} });
  for (const theme of [REPORT_THEMES[0], REPORT_THEMES[2]]) {
    const themed = await buildDeckPptx({ deck, results: {}, theme: themeToReportTheme(theme) });
    assert.ok(checkPptx(themed).ok, JSON.stringify(checkPptx(themed).problems));
    assert.deepEqual(words(themed), words(plain), `${theme.name}: the same words on every slide`);
    const all = slideXml(themed).join("");
    assert.ok(all.includes(`srgbClr val="${H(theme.colors.primary)}"`), `${theme.name}: the primary colour is on the slides`);
    assert.ok(all.includes(`typeface="${theme.typography.heading}"`), `${theme.name}: the heading font is on the slides`);
  }
});

test("stored files are checked again on retrieval: a truncated or replaced file is refused with what is wrong", async () => {
  const docx = await buildProposalDocx(def, { date: "2026-10-18" });
  assert.equal(checkOfficeFile(docx, "docx").ok, true);
  assert.equal(checkOfficeFile(docx.subarray(0, docx.length - 200), "docx").ok, false);
  assert.match(checkOfficeFile(Buffer.from("<html>error</html>"), "docx").problems[0], /not a ZIP/);
  assert.match(checkOfficeFile(Buffer.alloc(0), "pptx").problems[0], /empty/);
  const pptx = await buildDeckPptx({ deck: deckFromRun(def, run, {}), results: {} });
  assert.equal(checkOfficeFile(pptx, "application/vnd.openxmlformats-officedocument.presentationml.presentation").ok, true);
  assert.equal(checkOfficeFile(docx, "pptx").ok, false, "a Word file is not a deck");
});

/* ------------------------------------------------------------ PDF, through LibreOffice (only where it is installed) */

const soffice = ["/usr/bin/soffice", "/usr/bin/libreoffice", "/usr/local/bin/soffice"].find((p) => existsSync(p));
test("PDF (LibreOffice conversion of the themed Word file): the heading colour and font reach the PDF", { skip: soffice ? false : "LibreOffice is not installed here", timeout: 120_000 }, async () => {
  const theme = REPORT_THEMES[0];
  const dir = mkdtempSync(join(tmpdir(), "rs-theme-pdf-"));
  try {
    writeFileSync(join(dir, "plan.docx"), await buildResearchPlanDocx(def, { date: "2026-10-18", theme }));
    execFileSync(soffice!, ["--headless", `-env:UserInstallation=file://${join(dir, "profile")}`, "--convert-to", "pdf", "--outdir", dir, join(dir, "plan.docx")], { stdio: "ignore", timeout: 110_000 });
    const pdf = readFileSync(join(dir, "plan.pdf"));
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    /* the page streams, inflated: navy (#1B2A4A = 0.106 0.165 0.290) is set as a fill colour for the heading text */
    const raw = pdf.toString("latin1");
    let streams = "";
    for (const m of raw.matchAll(/stream\r?\n/g)) {
      const start = m.index! + m[0].length;
      const end = raw.indexOf("endstream", start);
      try { streams += inflateSync(pdf.subarray(start, end)).toString("latin1"); } catch { /* not a flate stream */ }
    }
    const [r, g, b] = [0x1b, 0x2a, 0x4a].map((v) => v / 255);
    const near = [...streams.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)].some((m) => Math.abs(Number(m[1]) - r) < 0.01 && Math.abs(Number(m[2]) - g) < 0.01 && Math.abs(Number(m[3]) - b) < 0.01);
    assert.ok(near, "the navy heading colour is in the PDF");
    assert.match(raw, /Calibri|Carlito/, "the theme's font (or LibreOffice's metric-compatible Carlito) is embedded");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
