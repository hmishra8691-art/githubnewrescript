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
  | { kind: "para"; text: string; style?: string; list?: { numId: string; level: number; index: number }; bold?: boolean; pageBreakBefore?: boolean; images?: DocImage[] }
  | { kind: "table"; rows: string[][] };

/**
 * Text Word does not show — a hidden run (`w:vanish`), white text, or text at 1pt or less. Kept in the
 * blocks as before (an importer must not lose content), and ALSO listed, so a reader that hands the text
 * to a model can say a document carries text its author could not see (prompt-injection audit, 2026-10-18).
 */
function runHidden(rpr: XmlNode | undefined): boolean {
  if (!rpr) return false;
  const on = (n: string) => kids(rpr, n).some((x) => x.attrs["w:val"] !== "0" && x.attrs["w:val"] !== "false");
  if (on("w:vanish") || on("w:specVanish") || on("w:webHidden")) return true;
  const color = kids(rpr, "w:color")[0]?.attrs["w:val"]?.toLowerCase();
  if (color && /^(?:fff|ffffff|fefefe|fdfdfd|white)$/.test(color)) return true;
  const sz = Number(kids(rpr, "w:sz")[0]?.attrs["w:val"]);
  return Number.isFinite(sz) && sz > 0 && sz <= 2;
}

/** I6: a picture embedded in the document (word/media/…), with its bytes — never fetched from anywhere */
export interface DocImage { name: string; contentType: string; bytes: Uint8Array; alt?: string }
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };

export function readDocx(bytes: Uint8Array): { blocks: DocBlock[]; errors: string[]; hidden: string[] } {
  const zip = readZip(bytes);
  const xml = zipText(zip, "word/document.xml");
  if (!xml) return { blocks: [], errors: ["word/document.xml is missing"], hidden: [] };
  const doc = parseXml(xml);
  const errors = doc.errors.slice(0, 5);
  // style ids → names ("Heading1" → "heading 1")
  const styles = new Map<string, string>();
  const stylesXml = zipText(zip, "word/styles.xml");
  if (stylesXml) for (const s of parseXml(stylesXml).root?.children ?? []) if (s.name === "w:style") { const nm = kids(s, "w:name")[0]?.attrs["w:val"]; if (s.attrs["w:styleId"] && nm) styles.set(s.attrs["w:styleId"], nm.toLowerCase()); }
  const body = doc.root ? kids(doc.root, "w:body")[0] : undefined;
  /* I6: relationship id → media part, for the pictures the document embeds */
  const rels = new Map<string, string>();
  const relXml = zipText(zip, "word/_rels/document.xml.rels");
  if (relXml) for (const r of parseXml(relXml).root?.children ?? []) if (r.name === "Relationship" && /\/image$/.test(r.attrs.Type ?? "")) rels.set(r.attrs.Id, `word/${String(r.attrs.Target).replace(/^\.?\//, "").replace(/^\/word\//, "")}`);
  const imageOf = (n: XmlNode): DocImage | null => {
    let blip: XmlNode | undefined; let alt: string | undefined;
    const find = (x: XmlNode) => { for (const c of x.children) { if (c.name === "a:blip") blip = c; if (c.name === "wp:docPr") alt = c.attrs.descr || c.attrs.title || undefined; if (!blip) find(c); } };
    find(n);
    const id = blip?.attrs["r:embed"]; const part = id ? rels.get(id) : undefined;
    const entry = part ? zip.get(part) : undefined;
    const ext = part?.split(".").pop()?.toLowerCase() ?? "";
    if (!entry || !IMAGE_TYPES[ext]) return null;
    try { return { name: part!.split("/").pop()!, contentType: IMAGE_TYPES[ext], bytes: entry.data(), ...(alt ? { alt } : {}) }; } catch { return null; }
  };
  const blocks: DocBlock[] = [];
  const counters = new Map<string, number>();
  let pendingBreak = false;
  const hidden: string[] = [];
  const runText = (p: XmlNode): { text: string; bold: boolean; pageBreak: boolean; images: DocImage[] } => {
    let text = ""; let boldChars = 0; let chars = 0; let pageBreak = false;
    const images: DocImage[] = [];
    const walk = (n: XmlNode, bold: boolean) => {
      for (const c of n.children) {
        if (c.name === "w:r") {
          const rpr = kids(c, "w:rPr")[0];
          const b = bold || !!(rpr && kids(rpr, "w:b").some((x) => x.attrs["w:val"] !== "0" && x.attrs["w:val"] !== "false"));
          if (runHidden(rpr)) { const ht = c.children.filter((r) => r.name === "w:t").map((r) => r.text).join(""); if (ht.trim() && hidden.length < 200) hidden.push(ht); }
          for (const r of c.children) {
            if (r.name === "w:t") { text += r.text; chars += r.text.length; if (b) boldChars += r.text.length; }
            else if (r.name === "w:tab") text += "\t";
            else if (r.name === "w:br") { if (r.attrs["w:type"] === "page") pageBreak = true; else text += "\n"; }
            else if (r.name === "w:sym") text += "□";
            else if ((r.name === "w:drawing" || r.name === "w:pict") && images.length < 20) { const im = imageOf(r); if (im) images.push(im); }
          }
        } else if (c.name === "w:hyperlink" || c.name === "w:smartTag" || c.name === "w:ins" || c.name === "w:sdt" || c.name === "w:sdtContent" || c.name === "w:fldSimple") walk(c, bold);
        else if (c.name === "w:del") { /* tracked deletion: not the document */ }
      }
    };
    walk(p, false);
    return { text, bold: chars > 0 && boldChars / chars > 0.6, pageBreak, images };
  };
  const para = (p: XmlNode) => {
    const ppr = kids(p, "w:pPr")[0];
    const styleId = ppr ? kids(ppr, "w:pStyle")[0]?.attrs["w:val"] : undefined;
    const numPr = ppr ? kids(ppr, "w:numPr")[0] : undefined;
    const numId = numPr ? kids(numPr, "w:numId")[0]?.attrs["w:val"] : undefined;
    const level = numPr ? Number(kids(numPr, "w:ilvl")[0]?.attrs["w:val"] ?? 0) : 0;
    const { text, bold, pageBreak, images } = runText(p);
    const breakBefore = pendingBreak || !!(ppr && kids(ppr, "w:pageBreakBefore").length);
    pendingBreak = false;
    if (images.length && !text.trim()) { blocks.push({ kind: "para", text: "", images }); if (pageBreak) pendingBreak = true; return; }
    if (pageBreak && !text.trim()) { pendingBreak = true; return; }
    for (const [k, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      const block: DocBlock = { kind: "para", text: line.replace(/\s+/g, " ").trim(), ...(styleId ? { style: styles.get(styleId) ?? styleId.toLowerCase() } : {}), ...(bold ? { bold } : {}), ...(breakBefore && k === 0 ? { pageBreakBefore: true } : {}) };
      if (k === 0 && images.length) block.images = images;
      if (numId && numId !== "0" && k === 0) { const key = `${numId}:${level}`; const idx = (counters.get(key) ?? 0) + 1; counters.set(key, idx); block.list = { numId, level, index: idx }; for (const [kk] of counters) if (kk.startsWith(`${numId}:`) && Number(kk.split(":")[1]) > level) counters.delete(kk); }
      blocks.push(block);
    }
    if (pageBreak) pendingBreak = true;
  };
  const table = (t: XmlNode) => {
    const rows: string[][] = [];
    /* a cell's text, with any table nested inside it flattened to "a | b" lines (I6: nested tables are not dropped) */
    const cellText = (tc: XmlNode): string => tc.children.flatMap((x) => x.name === "w:p" ? [runText(x).text.trim()] : x.name === "w:tbl" ? kids(x, "w:tr").map((tr) => kids(tr, "w:tc").map(cellText).filter(Boolean).join(" | ")) : []).filter(Boolean).join("\n");
    for (const tr of kids(t, "w:tr")) rows.push(kids(tr, "w:tc").map(cellText));
    if (rows.length) blocks.push({ kind: "table", rows });
  };
  for (const c of body?.children ?? []) {
    if (c.name === "w:p") para(c);
    else if (c.name === "w:tbl") table(c);
    else if (c.name === "w:sdt") for (const x of kids(c, "w:sdtContent")[0]?.children ?? []) { if (x.name === "w:p") para(x); else if (x.name === "w:tbl") table(x); }
  }
  return { blocks, errors, hidden };
}
