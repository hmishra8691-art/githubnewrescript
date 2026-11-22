import { test } from "node:test";
import assert from "node:assert/strict";

import JSZip from "jszip";
import { applyClientTheme, masterTheme, readClientMaster } from "./clientTemplate.js";
import { buildPptx, PptxCtor as PptxGenJS } from "./pptx.js";
import { unzipEntries } from "./docxCheck.js";
import { checkPptx } from "./officeCheck.js";
import { synthDataset, D } from "../analyses/fixture.js";
import { runAnalysis } from "../analyses/index.js";
import { DEFAULT_THEME, type ReportDefinition } from "../types.js";

/* R4 — a client's master in, a deck built on it out: their background, logo where they put it, their theme, native charts */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const EMU = 914400;

/** a template the way PowerPoint saves one: a 13.33 × 7.5 in master with a dark-blue background, a logo top right, a title placeholder, and a theme of its own */
async function clientTemplate(): Promise<Buffer> {
  const p = new PptxGenJS(); p.addSlide();
  const z = await JSZip.loadAsync((await p.write({ outputType: "nodebuffer" })) as Buffer);
  z.file("ppt/presentation.xml", (await z.file("ppt/presentation.xml")!.async("string")).replace(/<p:sldSz[^>]*\/>/, '<p:sldSz cx="12192000" cy="6858000"/>'));
  const theme = (await z.file("ppt/theme/theme1.xml")!.async("string"))
    .replace(/<a:accent1>[\s\S]*?<\/a:accent1>/, '<a:accent1><a:srgbClr val="E4002B"/></a:accent1>')
    .replace(/<a:accent2>[\s\S]*?<\/a:accent2>/, '<a:accent2><a:srgbClr val="00A3E0"/></a:accent2>')
    .replace(/<a:dk1>[\s\S]*?<\/a:dk1>/, '<a:dk1><a:srgbClr val="1A1A1A"/></a:dk1>')
    .replace(/<a:majorFont>\s*<a:latin typeface="[^"]*"/, '<a:majorFont><a:latin typeface="Georgia"')
    .replace(/<a:minorFont>\s*<a:latin typeface="[^"]*"/, '<a:minorFont><a:latin typeface="Verdana"');
  z.file("ppt/theme/theme1.xml", theme);
  z.file("ppt/media/clientlogo.png", PNG);
  const rels = await z.file("ppt/slideMasters/_rels/slideMaster1.xml.rels")!.async("string");
  z.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", rels.replace("</Relationships>", '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/clientlogo.png"/></Relationships>'));
  const pic = `<p:pic><p:nvPicPr><p:cNvPr id="5" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId99"/></p:blipFill><p:spPr><a:xfrm><a:off x="${Math.round(11.5 * EMU)}" y="${Math.round(0.3 * EMU)}"/><a:ext cx="${Math.round(1.33 * EMU)}" cy="${Math.round(0.5 * EMU)}"/></a:xfrm></p:spPr></p:pic>`;
  const title = `<p:sp><p:nvSpPr><p:cNvPr id="6" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(0.8 * EMU)}" y="${Math.round(0.4 * EMU)}"/><a:ext cx="${Math.round(10 * EMU)}" cy="${Math.round(0.9 * EMU)}"/></a:xfrm></p:spPr></p:sp>`;
  const line = `<p:sp><p:nvSpPr><p:cNvPr id="7" name="Rule"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>`;
  const master = (await z.file("ppt/slideMasters/slideMaster1.xml")!.async("string"))
    .replace("<p:cSld>", '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="0B1F3A"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>')
    .replace("</p:spTree>", `${pic}${title}${line}</p:spTree>`);
  z.file("ppt/slideMasters/slideMaster1.xml", master);
  const types = await z.file("[Content_Types].xml")!.async("string");
  if (!/Extension="png"/.test(types)) z.file("[Content_Types].xml", types.replace("<Default ", '<Default Extension="png" ContentType="image/png"/><Default '));
  return z.generateAsync({ type: "nodebuffer" });
}

test("the client's master is read: size, theme colours and fonts, background, logo position, title placeholder", async () => {
  const { master, problems } = readClientMaster(await clientTemplate(), "Client master.potx");
  assert.deepEqual(problems, []);
  assert.ok(master);
  assert.equal(master!.name, "Client master");
  assert.ok(Math.abs(master!.size.w - 13.333) < 0.01 && Math.abs(master!.size.h - 7.5) < 0.01);
  assert.deepEqual(master!.colors.accents.slice(0, 2), ["#E4002B", "#00A3E0"]);
  assert.equal(master!.colors.dk1, "#1A1A1A");
  assert.deepEqual(master!.fonts, { heading: "Georgia", body: "Verdana" });
  assert.equal(master!.background.color, "#0B1F3A");
  assert.equal(master!.pictures.length, 1);
  assert.ok(Math.abs(master!.pictures[0].x - 11.5) < 0.01 && master!.pictures[0].dataUri.startsWith("data:image/png;base64,"));
  assert.ok(Math.abs(master!.title!.y - 0.4) < 0.01);
  assert.ok(master!.notes.some((n) => /1 drawn shape .* not carried over/.test(n)), master!.notes.join(" | "));
  assert.ok(master!.themeXml?.includes("E4002B"));
  const t = masterTheme(master!, DEFAULT_THEME);
  assert.equal(t.colors.primary, "#E4002B");
  assert.equal(t.fontFamily, "Verdana");
  assert.equal(t.headingFontFamily, "Georgia");
  assert.equal(t.colors.palette[0], "#E4002B");
  assert.equal(t.colors.text, "#FFFFFF", "on the dark-blue master, text is light (the theme's light colour)");
});

test("a deck built on the master: the client's theme part, their background and logo on the slide master, native charts in their colours", async () => {
  const { master } = readClientMaster(await clientTemplate(), "Client master.pptx");
  const ds = synthDataset();
  const results = { a1: runAnalysis(D("crosstab", [], { rows: ["SAT"], columns: ["GENDER"] }), ds) };
  const report: ReportDefinition = { title: "Brand health", mode: "snapshot", blocks: [{ id: "c", type: "chart", title: "Satisfaction by gender", analysisId: "a1", chart: { type: "bar_grouped", options: {} } }] };
  const deck = await buildPptx({ report, results, theme: masterTheme(master!, DEFAULT_THEME) });
  const check = checkPptx(deck);
  assert.ok(check.ok, check.problems.join("; "));
  const zip = unzipEntries(deck);
  assert.equal(zip.get("ppt/theme/theme1.xml")!.toString("utf8"), master!.themeXml, "the client's own theme part");
  const layouts = [...zip.keys()].filter((k) => /slideLayouts\/slideLayout\d+\.xml$/.test(k)).map((k) => zip.get(k)!.toString("utf8"));
  const clientLayout = layouts.find((x) => /CLIENT_MASTER/.test(x));
  assert.ok(clientLayout, "a master built from the client's file");
  assert.match(clientLayout!, /0B1F3A/i, "their background");
  assert.match(clientLayout!, /<p:pic>/, "their logo");
  const charts = [...zip.keys()].filter((k) => /^ppt\/charts\/chart\d+\.xml$/.test(k));
  assert.ok(charts.length >= 1, "a native, editable chart");
  assert.match(zip.get(charts[0])!.toString("utf8"), /E4002B/i, "in the client's first accent");
  const slide = [...zip.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).map((k) => zip.get(k)!.toString("utf8")).join("");
  assert.match(slide, /Georgia/, "titles in the client's heading font");
  assert.ok(!/<p:bg>/.test(zip.get("ppt/slides/slide2.xml")!.toString("utf8")), "content slides do not override the master's background");
});

test("files that are not templates are refused in a sentence; a theme without a client part is left alone", async () => {
  assert.match(readClientMaster(new Uint8Array([1, 2, 3]), "x.pptx").problems[0], /not a PowerPoint file/);
  const p = new PptxGenJS(); p.addSlide();
  const plain = (await p.write({ outputType: "nodebuffer" })) as Buffer;
  assert.equal(await applyClientTheme(plain, undefined), plain);
});
