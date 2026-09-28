import { test } from "node:test";
import assert from "node:assert/strict";
import { extractResearchDocument, chunkResearchDocument, ResearchIndex, tokens } from "./research.js";
import { pdfFixture, docxFixture, TINY_JPEG } from "./fixtures.js";

const enc = (s: string) => new TextEncoder().encode(s);

test("a PDF paper: text by page, visual lines joined into sentences; a scanned page hands over its image for OCR", async () => {
  const pdf = await extractResearchDocument(pdfFixture([
    ["Social Media and Premium Skincare", "Abstract. We find that exposure to", "influencer content predicts purchase", "intention among 18-34 year olds."],
    ["2. Method", "A survey of 1,200 consumers measured trust in", "influencers on a 7-point scale."],
  ]), "paper.pdf");
  assert.equal(pdf.format, "pdf");
  assert.equal(pdf.pages.length, 2);
  assert.match(pdf.pages[0].text, /We find that exposure to influencer content predicts purchase intention among 18-34 year olds\./);
  assert.equal(pdf.scanned, false);
  assert.equal(pdf.images.length, 0);
  const logo = Uint8Array.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
  const scan = await extractResearchDocument(pdfFixture([["Page one has text enough to count as a text page."], []], { images: { 0: TINY_JPEG, 1: [logo, TINY_JPEG] } }), "scan.pdf");
  assert.equal(scan.scanned, true);
  assert.deepEqual(scan.images.map((i) => [i.page, i.mime, i.width, i.height]), [[2, "image/jpeg", 1700, 2200]], "only the page with no text, and its largest image (the scan, not the logo)");
  assert.deepEqual([...scan.images[0].bytes.subarray(0, 2)], [0xff, 0xd8], "the stream bytes are the JPEG itself");
  const blank = await extractResearchDocument(pdfFixture([[]]), "blank.pdf");
  assert.match(blank.warnings.join(" "), /no text and no image OCR can read/);
});

test("a Word brief: headings and tables kept; text and CSV; an unreadable file says so", async () => {
  const doc = await extractResearchDocument(docxFixture(), "brief.docx");
  assert.equal(doc.format, "docx");
  assert.ok(doc.pages[0].text.includes("## "), "headings are marked");
  assert.equal(doc.tables.length, 1);
  assert.ok(doc.tables[0].rows.length >= 2);
  const txt = await extractResearchDocument(enc("Objective\n\nUnderstand why.\fPage two"), "notes.txt");
  assert.deepEqual(txt.pages.map((p) => p.n), [1, 2], "a form feed is a page break");
  const csv = await extractResearchDocument(enc("scale,items,alpha\nTrust,5,0.88\nIntent,3,0.91\n"), "scales.csv");
  assert.equal(csv.format, "csv");
  assert.deepEqual(csv.tables[0].rows[1], ["Trust", "5", "0.88"]);
  const bin = await extractResearchDocument(Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]), "x.zip");
  assert.match(bin.warnings[0], /not a document this reader understands/);
});

test("chunks keep their page and heading; tables are their own chunks; retrieval finds the passage a request needs", () => {
  const doc = {
    pages: [
      { n: 1, text: "## Introduction\nSkincare spending among young adults has grown.\n\nSocial media is the main discovery channel." },
      { n: 2, text: "## Trust in influencers\nTrust mediates the effect of influencer exposure on purchase intention (β = .41).\n| Scale | Items | α |\n| Influencer trust | 5 | .88 |" },
      { n: 3, text: "## Demographics\nAge, gender, income and region were controls." },
    ],
    tables: [],
  };
  const chunks = chunkResearchDocument("d1", doc);
  assert.deepEqual(chunks.map((c) => [c.id, c.page, c.heading, c.kind]), [
    ["d1#1", 1, "Introduction", "text"], ["d1#2", 2, "Trust in influencers", "text"], ["d1#3", 2, "Trust in influencers", "table"], ["d1#4", 3, "Demographics", "text"],
  ]);
  const long = chunkResearchDocument("d2", { pages: [{ n: 1, text: Array.from({ length: 60 }, (_, i) => `Sentence ${i} about brand awareness and recall.`).join(" ") }], tables: [] }, { target: 400, max: 600 });
  assert.ok(long.length >= 5 && long.every((c) => c.text.length <= 600), "a wall of text is cut on sentence boundaries");
  const ix = new ResearchIndex([...chunks, ...chunkResearchDocument("d3", { pages: [{ n: 1, text: "## Brief\nThe client wants to know whether trust in influencers drives premium purchases." }], tables: [] })]);
  const top = ix.retrieve("add three questions measuring trust", 2);
  assert.equal(top[0].chunk.heading, "Trust in influencers");
  assert.ok(top.every((r) => /trust/i.test(r.chunk.text)));
  assert.equal(ix.retrieve("demographic controls", 1)[0].chunk.id, "d1#4", "stemming: demographic ≈ Demographics, controls ≈ control");
  const boosted = ix.retrieve("trust influencers", 1, { docBoost: new Map([["d3", 5]]) });
  assert.equal(boosted[0].chunk.docId, "d3", "“based on the client brief” prefers the brief");
  assert.deepEqual(ix.retrieve("quantum chromodynamics", 3), [], "nothing relevant, nothing sent");
  assert.deepEqual(tokens("The Influencers' TRUST"), ["influencer", "trust"]);
});
