import { unzipEntries, xmlProblem, checkDocx } from "./docxCheck.js";

/**
 * IS THIS FILE STILL THE FILE THAT WAS MADE? (2026-10-18)
 *
 * A stored research document is checked again when it is fetched for download
 * (docs/ARTIFACTS-AND-REPORT-THEMES-2026-10-18.md): a Word file with
 * `checkDocx`, a PowerPoint file by its package — the ZIP's central directory,
 * the parts a deck cannot open without, every XML part well-formed. An object
 * that was truncated, replaced or corrupted in storage is refused with what is
 * wrong instead of being offered.
 */
export interface OfficeCheck { ok: boolean; kind: "docx" | "pptx" | "unknown"; problems: string[] }

const PPTX_REQUIRED = ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels"];

export function checkPptx(buf: Buffer): OfficeCheck {
  const problems: string[] = [];
  let parts: Map<string, Buffer>;
  try { parts = unzipEntries(buf); } catch (e) { return { ok: false, kind: "pptx", problems: [(e as Error).message] }; }
  for (const r of PPTX_REQUIRED) if (!parts.has(r)) problems.push(`${r} is missing`);
  if (![...parts.keys()].some((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))) problems.push("the deck has no slides");
  for (const [name, data] of parts) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    const p = xmlProblem(data.toString("utf8"));
    if (p) problems.push(`${name}: ${p}`);
  }
  return { ok: problems.length === 0, kind: "pptx", problems };
}

/** a stored document checked by its kind (from its MIME type or file name) */
export function checkOfficeFile(buf: Buffer, kind: "docx" | "pptx" | string): OfficeCheck {
  if (!buf.length) return { ok: false, kind: "unknown", problems: ["the file is empty"] };
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) return { ok: false, kind: "unknown", problems: ["the file is not a ZIP package (Word / PowerPoint)"] };
  if (/pptx|presentation/.test(kind)) return checkPptx(buf);
  const c = checkDocx(buf);
  return { ok: c.ok, kind: "docx", problems: c.problems };
}
