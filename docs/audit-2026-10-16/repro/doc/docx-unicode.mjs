// Audit repro (DOC): does the questionnaire .docx keep non-Latin text? (docx is XML/UTF-8, expected yes)
import { exportSurveyDocx, EXPORT_PRESETS } from "/home/claude/rescript/packages/exporters/dist/index.js";
import { buildProposalDocx } from "/home/claude/rescript/packages/analytics/dist/export/docx.js";
import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import { inflateRawSync } from "node:zlib";
function docText(buf) { // minimal zip reader: find word/document.xml
  let p = 0, out = "";
  while (p < buf.length - 4) {
    if (buf.readUInt32LE(p) !== 0x04034b50) break;
    const method = buf.readUInt16LE(p + 8), csize = buf.readUInt32LE(p + 18), nlen = buf.readUInt16LE(p + 26), xlen = buf.readUInt16LE(p + 28);
    const name = buf.toString("utf8", p + 30, p + 30 + nlen); const start = p + 30 + nlen + xlen; const raw = buf.subarray(start, start + csize);
    if (name === "word/document.xml") out = (method === 0 ? raw : inflateRawSync(raw)).toString("utf8");
    p = start + csize;
  }
  return out;
}
const def = SurveyDefinition.parse({
  meta: { id: "u", code: "यूनी", title: "Étude — 调查 (परीक्षण)", version: "1.0" },
  research: { objective: "Понять, почему клиенты уходят", hypotheses: ["H1: الرضا يزيد الولاء"], analysisPlan: undefined },
  questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "आप कितने संतुष्ट हैं? «très» ‹bien›", options: [{ code: 1, label: "बहुत संतुष्ट" }, { code: 2, label: "असंतुष्ट 😀" }] }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
});
const spec = docText(await exportSurveyDocx(def, EXPORT_PRESETS.full ?? EXPORT_PRESETS.basic, { version: "1.0" }));
for (const s of ["आप कितने संतुष्ट हैं", "बहुत संतुष्ट", "😀", "调查", "«très»"]) console.log(`questionnaire docx contains "${s}": ${spec.includes(s)}`);
const prop = docText(await buildProposalDocx(def, { client: "Société Générale" }));
for (const s of ["Понять, почему клиенты уходят", "الرضا يزيد الولاء", "Société Générale", "आप कितने"]) console.log(`proposal docx contains "${s}": ${prop.includes(s)}`);
console.log(`proposal stamps: version=${/v1\.0/.test(prop)} date=${/\d{4}-\d{2}-\d{2}/.test(prop)}`);
console.log(`questionnaire stamps: ${/version 1\.0/.test(spec)} exported-date=${/exported \d{4}-\d{2}-\d{2}/.test(spec)}`);
