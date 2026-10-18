import { inflateRawSync } from "node:zlib";

/**
 * IS THIS A WORD DOCUMENT WORD WILL OPEN? (2026-10-17)
 *
 * The research documents are checked before a download link is offered: an
 * empty, truncated or malformed file is refused at the route with what is
 * wrong, instead of reaching the researcher as "Word found unreadable
 * content". The check reads the ZIP's central directory (not a scan for
 * local headers), inflates every XML part, requires the parts a .docx cannot
 * open without, checks every relationship of the main document points at a
 * part that exists, and parses every XML part for well-formedness. It also
 * returns the body's text, paragraphs and tables, so a test can read what the
 * document says.
 */
export interface DocxCheck {
  ok: boolean;
  problems: string[];
  parts: string[];
  /** the text of word/document.xml, entities decoded, one space between runs */
  text: string;
  paragraphs: number;
  tables: number;
  headings: number;
  /** header/footer parts present */
  headers: number;
  footers: number;
}

const REQUIRED = ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/_rels/document.xml.rels", "word/styles.xml"];
const MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

/** every entry of a ZIP, from its central directory */
export function unzipEntries(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a ZIP archive (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`the central directory is damaged at entry ${k + 1}`);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: its local header is missing`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (raw.length !== csize) throw new Error(`${name}: the archive is truncated`);
    out.set(name, method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : (() => { throw new Error(`${name}: unsupported compression ${method}`); })());
  }
  return out;
}

/** a small, strict well-formedness check: balanced, properly nested elements, quoted attributes, one root */
export function xmlProblem(xml: string): string | null {
  const stack: string[] = [];
  let roots = 0;
  let i = 0;
  const name = /^[A-Za-z_][\w.:-]*/;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    if (xml.startsWith("<?", lt)) { const e = xml.indexOf("?>", lt); if (e < 0) return "unterminated processing instruction"; i = e + 2; continue; }
    if (xml.startsWith("<!--", lt)) { const e = xml.indexOf("-->", lt); if (e < 0) return "unterminated comment"; i = e + 3; continue; }
    if (xml.startsWith("<![CDATA[", lt)) { const e = xml.indexOf("]]>", lt); if (e < 0) return "unterminated CDATA"; i = e + 3; continue; }
    if (xml.startsWith("<!", lt)) { const e = xml.indexOf(">", lt); if (e < 0) return "unterminated declaration"; i = e + 1; continue; }
    /* find the tag's end outside quoted attribute values */
    let j = lt + 1, quote = "";
    for (; j < xml.length; j++) { const c = xml[j]; if (quote) { if (c === quote) quote = ""; } else if (c === "\"" || c === "'") quote = c; else if (c === ">") break; else if (c === "<") return `“<” inside a tag at ${j}`; }
    if (j >= xml.length) return "unterminated tag";
    const inner = xml.slice(lt + 1, j);
    if (inner.startsWith("/")) {
      const n = inner.slice(1).trim();
      const top = stack.pop();
      if (top !== n) return `</${n}> closes <${top ?? "nothing"}>`;
    } else {
      const m = name.exec(inner);
      if (!m) return `a tag with no name at ${lt}`;
      const attrs = inner.slice(m[0].length).replace(/\/\s*$/, "");
      if (!/^(\s+[A-Za-z_][\w.:-]*\s*=\s*("[^"]*"|'[^']*'))*\s*$/.test(attrs)) return `<${m[0]}> has a malformed attribute`;
      if (!stack.length) roots++;
      if (!inner.endsWith("/")) stack.push(m[0]);
    }
    i = j + 1;
  }
  if (stack.length) return `<${stack[stack.length - 1]}> is never closed`;
  if (roots !== 1) return `${roots} root elements`;
  return null;
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");

export function checkDocx(buf: Buffer | Uint8Array): DocxCheck {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const empty: DocxCheck = { ok: false, problems: [], parts: [], text: "", paragraphs: 0, tables: 0, headings: 0, headers: 0, footers: 0 };
  if (b.length < 100) return { ...empty, problems: [`the file is ${b.length} bytes — too small to be a document`] };
  if (b.readUInt32LE(0) !== 0x04034b50) return { ...empty, problems: ["the file does not start as a ZIP package (a .docx is one)"] };
  let entries: Map<string, Buffer>;
  try { entries = unzipEntries(b); } catch (e) { return { ...empty, problems: [(e as Error).message] }; }
  const parts = [...entries.keys()];
  const problems: string[] = [];
  for (const r of REQUIRED) if (!entries.has(r)) problems.push(`the part ${r} is missing`);
  for (const [n, data] of entries) if (/\.(xml|rels)$/.test(n)) { const p = xmlProblem(data.toString("utf8")); if (p) problems.push(`${n} is not well-formed XML: ${p}`); }
  const types = entries.get("[Content_Types].xml")?.toString("utf8") ?? "";
  if (types && !(types.includes(MAIN) && /PartName="\/word\/document\.xml"/.test(types))) problems.push("[Content_Types].xml does not declare word/document.xml as the main document");
  const rels = entries.get("word/_rels/document.xml.rels")?.toString("utf8") ?? "";
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0];
    if (/TargetMode="External"/.test(tag)) continue;
    const target = /Target="([^"]+)"/.exec(tag)?.[1];
    if (!target) continue;
    const path = target.startsWith("/") ? target.slice(1) : `word/${target}`.replace(/\/\.\//g, "/");
    if (!entries.has(path)) problems.push(`word/document.xml refers to ${path}, which is not in the package`);
  }
  const doc = entries.get("word/document.xml")?.toString("utf8") ?? "";
  if (doc && !/<w:body>/.test(doc)) problems.push("word/document.xml has no body");
  const paragraphs = (doc.match(/<w:p[ >]/g) ?? []).length;
  if (doc && !paragraphs) problems.push("the document has no paragraphs");
  if (/<w:numPr>/.test(doc) && !entries.has("word/numbering.xml")) problems.push("the document uses numbering but has no numbering part");
  const text = decode(doc.replace(/<w:tab\/>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return {
    ok: !problems.length, problems, parts, text, paragraphs,
    tables: (doc.match(/<w:tbl>/g) ?? []).length,
    headings: (doc.match(/<w:pStyle w:val="Heading\d"\/>/g) ?? []).length,
    headers: parts.filter((p) => /^word\/header\d*\.xml$/.test(p)).length,
    footers: parts.filter((p) => /^word\/footer\d*\.xml$/.test(p)).length,
  };
}
