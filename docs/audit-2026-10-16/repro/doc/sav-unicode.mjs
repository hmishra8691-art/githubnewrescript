// Audit repro (DOC): what a .sav / SAS / Stata / CSV export does with non-ASCII text.
import { buildSav, spssName } from "/home/claude/rescript/packages/exporters/dist/spss.js";
import { csvRow } from "/home/claude/rescript/packages/exporters/dist/csvCell.js";

const samples = { hi: "मुझे यह कार पसंद है", zh: "我喜欢这辆车", ar: "أحب هذه السيارة", ru: "Мне нравится машина", fr: "J'aime la voiture — très bien… «oui»", de: "Straße Größe" };
const vars = [
  { name: "Q6", label: "क्यों? (Why?)", type: "string", stringWidth: 120 },
  { name: "Q1", label: "Marque", type: "numeric", valueLabels: { "1": "Citroën", "2": "Škoda", "3": "丰田" } },
];
const rows = Object.entries(samples).map(([k, v]) => ({ Q6: v, Q1: 1 }));
const buf = buildSav({ variables: vars, rows, fileLabel: "Étude" });
const text = buf.toString("latin1");
console.log("== .sav (bytes read back as latin1; the writer declares no code page) ==");
for (const [k, v] of Object.entries(samples)) {
  const survived = [...v].filter((ch) => ch.charCodeAt(0) > 0x7e).some((ch) => text.includes(ch));
  console.log(`${k.padEnd(3)} input="${v}"  non-ASCII chars present in file: ${survived}`);
}
console.log(`value label "Citroën" -> ${text.includes("Citroen") ? "Citroen (diacritic stripped)" : "?"}; "Škoda" -> ${text.includes("Skoda") ? "Skoda" : "?"}; "丰田" -> ${/\x20\x20/.test(text) ? "spaces" : "?"}`);
console.log(`spssName("Größe") = ${spssName("Größe", new Set())}`);
// show the exact bytes written for the Hindi answer: find the Q6 case data by looking for a run of spaces
const hindiCase = buf.subarray(buf.length - rows.length * (120 + 8), buf.length - (rows.length - 1) * (120 + 8));
console.log(`Hindi case cell (first 24 bytes, hex): ${hindiCase.subarray(0, 24).toString("hex")}`);
console.log("\n== CSV (utf-8) ==");
const csv = csvRow(Object.values(samples));
console.log(csv);
console.log(`starts with BOM: ${csv.charCodeAt(0) === 0xfeff}`);
