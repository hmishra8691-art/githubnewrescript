import { readZip, zipText } from "../zip.js";
import { parseXml, kids, type XmlNode } from "../xml.js";

/**
 * A WORD DOCUMENT → blocks of text, with the structure Word knows about.
 *
 * Paragraphs keep their style (Heading 1, List Paragraph…), whether Word
 * numbers them (numbering id + level — an auto-numbered answer list loses
 * its "1." in the text, so the level is how we know it is a list), whether
 * they are bold, and whether a page break precedes them. Tables become rows
 * of cell text — grids are usually written as tables.
 */
export type DocBlock =
  | { kind: "para"; text: string; style?: string; list?: { numId: string; level: number; index: number }; bold?: boolean; pageBreakBefore?: boolean }
  | { kind: "table"; rows: string[][] };

export function readDocx(bytes: Uint8Array): { blocks: DocBlock[]; errors: string[] } {
  const zip = readZip(bytes);
  const xml = zipText(zip, "word/document.xml");
  if (!xml) return { blocks: [], errors: ["word/document.xml is missing"] };
  const doc = parseXml(xml);
  const errors = doc.errors.slice(0, 5);
  // style ids → names ("Heading1" → "heading 1")
  const styles = new Map<string, string>();
  const stylesXml = zipText(zip, "word/styles.xml");
  if (stylesXml) for (const s of parseXml(stylesXml).root?.children ?? []) if (s.name === "w:style") { const nm = kids(s, "w:name")[0]?.attrs["w:val"]; if (s.attrs["w:styleId"] && nm) styles.set(s.attrs["w:styleId"], nm.toLowerCase()); }
  const body = doc.root ? kids(doc.root, "w:body")[0] : undefined;
  const blocks: DocBlock[] = [];
  const counters = new Map<string, number>();
  let pendingBreak = false;
  const runText = (p: XmlNode): { text: string; bold: boolean; pageBreak: boolean } => {
    let text = ""; let boldChars = 0; let chars = 0; let pageBreak = false;
    const walk = (n: XmlNode, bold: boolean) => {
      for (const c of n.children) {
        if (c.name === "w:r") {
          const rpr = kids(c, "w:rPr")[0];
          const b = bold || !!(rpr && kids(rpr, "w:b").some((x) => x.attrs["w:val"] !== "0" && x.attrs["w:val"] !== "false"));
          for (const r of c.children) {
            if (r.name === "w:t") { text += r.text; chars += r.text.length; if (b) boldChars += r.text.length; }
            else if (r.name === "w:tab") text += "\t";
            else if (r.name === "w:br") { if (r.attrs["w:type"] === "page") pageBreak = true; else text += "\n"; }
            else if (r.name === "w:sym") text += "□";
          }
        } else if (c.name === "w:hyperlink" || c.name === "w:smartTag" || c.name === "w:ins" || c.name === "w:sdt" || c.name === "w:sdtContent" || c.name === "w:fldSimple") walk(c, bold);
        else if (c.name === "w:del") { /* tracked deletion: not the document */ }
      }
    };
    walk(p, false);
    return { text, bold: chars > 0 && boldChars / chars > 0.6, pageBreak };
  };
  const para = (p: XmlNode) => {
    const ppr = kids(p, "w:pPr")[0];
    const styleId = ppr ? kids(ppr, "w:pStyle")[0]?.attrs["w:val"] : undefined;
    const numPr = ppr ? kids(ppr, "w:numPr")[0] : undefined;
    const numId = numPr ? kids(numPr, "w:numId")[0]?.attrs["w:val"] : undefined;
    const level = numPr ? Number(kids(numPr, "w:ilvl")[0]?.attrs["w:val"] ?? 0) : 0;
    const { text, bold, pageBreak } = runText(p);
    const breakBefore = pendingBreak || !!(ppr && kids(ppr, "w:pageBreakBefore").length);
    pendingBreak = false;
    if (pageBreak && !text.trim()) { pendingBreak = true; return; }
    for (const [k, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      const block: DocBlock = { kind: "para", text: line.replace(/\s+/g, " ").trim(), ...(styleId ? { style: styles.get(styleId) ?? styleId.toLowerCase() } : {}), ...(bold ? { bold } : {}), ...(breakBefore && k === 0 ? { pageBreakBefore: true } : {}) };
      if (numId && numId !== "0" && k === 0) { const key = `${numId}:${level}`; const idx = (counters.get(key) ?? 0) + 1; counters.set(key, idx); block.list = { numId, level, index: idx }; for (const [kk] of counters) if (kk.startsWith(`${numId}:`) && Number(kk.split(":")[1]) > level) counters.delete(kk); }
      blocks.push(block);
    }
    if (pageBreak) pendingBreak = true;
  };
  const table = (t: XmlNode) => {
    const rows: string[][] = [];
    for (const tr of kids(t, "w:tr")) rows.push(kids(tr, "w:tc").map((tc) => kids(tc, "w:p").map((p) => runText(p).text.trim()).filter(Boolean).join("\n")));
    if (rows.length) blocks.push({ kind: "table", rows });
  };
  for (const c of body?.children ?? []) {
    if (c.name === "w:p") para(c);
    else if (c.name === "w:tbl") table(c);
    else if (c.name === "w:sdt") for (const x of kids(c, "w:sdtContent")[0]?.children ?? []) { if (x.name === "w:p") para(x); else if (x.name === "w:tbl") table(x); }
  }
  return { blocks, errors };
}
