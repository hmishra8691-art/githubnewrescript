// Conjoint audit 2026-10-17: measures the CBC generator (packages/designs/dist).
// usage: node docs/conjoint-audit-2026-10-17/measure-designs.mjs [balanced|efficient]   (no argument = the default for a stored config without `method`, i.e. balanced)
import { conjointPlugin } from "../../packages/designs/dist/index.js";

const method = process.argv[2];
const A = (n, levels) => ({ name: n, levels });
const base4 = [A("Brand", ["Alpha", "Beta", "Gamma"]), A("Screen", ["5in", "6in", "7in"]), A("Battery", ["1 day", "2 days", "3 days"]), A("Colour", ["Black", "White", "Blue"])];
const price4 = [A("Brand", ["Alpha", "Beta", "Gamma"]), A("Screen", ["5in", "6in", "7in"]), A("Battery", ["1 day", "2 days", "3 days"]), A("Price", ["$199", "$299", "$399"])];

function helmert(l) {
  const C = Array.from({ length: l }, () => new Array(l - 1).fill(0));
  for (let k = 1; k < l; k++) {
    const d = Math.sqrt(k * (k + 1));
    for (let i = 0; i < k; i++) C[i][k - 1] = 1 / d;
    C[k][k - 1] = -k / d;
  }
  return C;
}
function det(M) {
  const n = M.length, a = M.map((r) => [...r]);
  let d = 1;
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(a[r][i]) > Math.abs(a[piv][i])) piv = r;
    if (Math.abs(a[piv][i]) < 1e-14) return 0;
    if (piv !== i) { [a[i], a[piv]] = [a[piv], a[i]]; d = -d; }
    d *= a[i][i];
    for (let r = i + 1; r < n; r++) { const f = a[r][i] / a[i][i]; for (let c = i; c < n; c++) a[r][c] -= f * a[i][c]; }
  }
  return d;
}
function deff(attrs, sets) {
  const codes = attrs.map((a) => helmert(a.levels.length));
  const p = attrs.reduce((t, a) => t + a.levels.length - 1, 0);
  const enc = (prof) => attrs.flatMap((a, q) => codes[q][a.levels.indexOf(prof[a.name])]);
  const I = Array.from({ length: p }, () => new Array(p).fill(0));
  let m = 0;
  for (const s of sets) {
    m = s.length;
    const X = s.map(enc);
    const xb = new Array(p).fill(0);
    for (const x of X) for (let i = 0; i < p; i++) xb[i] += x[i] / m;
    for (const x of X) for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) I[i][j] += ((x[i] - xb[i]) * (x[j] - xb[j])) / m / sets.length;
  }
  let bound = 1;
  for (const a of attrs) {
    const l = a.levels.length, x = Math.floor(m / l), y = m % l;
    const S = (m * m - (l * x * x + 2 * x * y + y)) / 2;
    bound *= Math.pow((2 * S) / (m * m * (l - 1)), l - 1);
  }
  return Math.pow(Math.max(det(I), 0) / bound, 1 / p);
}

function measure(label, cfg, seed = 7) {
  const t0 = Date.now();
  let f;
  try { f = conjointPlugin.generate({ ...cfg, ...(method ? { method } : {}) }, seed); } catch (e) { console.log(`${label}: THROWS ${e.message}`); return; }
  const ms = Date.now() - t0;
  const attrs = cfg.attributes;
  const real = f.rows.filter((r) => Number(r.none_option) !== 1);
  const byTask = new Map();
  for (const r of real) { const k = `${r.version}|${r.task}`; (byTask.get(k) ?? byTask.set(k, []).get(k)).push(r); }
  let dupTasks = 0, overlapCells = 0, cells = 0, prohibited = 0;
  for (const alts of byTask.values()) {
    const keys = alts.map((r) => attrs.map((a) => r[a.name]).join("|"));
    if (new Set(keys).size !== keys.length) dupTasks++;
    for (const a of attrs) { cells++; if (new Set(alts.map((r) => r[a.name])).size < alts.length) overlapCells++; }
  }
  for (const r of real) for (const p of cfg.prohibitions ?? []) if (r[p.a.attribute] === p.a.level && r[p.b.attribute] === p.b.level) prohibited++;
  const bal = attrs.map((a) => { const c = a.levels.map((l) => real.filter((r) => r[a.name] === l).length); return `${a.name} ${Math.min(...c)}..${Math.max(...c)}`; });
  // per-version worst one-way spread
  let worstVerSpread = 0;
  const versions = [...new Set(real.map((r) => r.version))];
  const perVerDeff = [];
  for (const v of versions) {
    const vr = real.filter((r) => r.version === v);
    for (const a of attrs) { const c = a.levels.map((l) => vr.filter((r) => r[a.name] === l).length); worstVerSpread = Math.max(worstVerSpread, Math.max(...c) - Math.min(...c)); }
    const sets = [...new Set(vr.map((r) => r.task))].map((t) => vr.filter((r) => r.task === t));
    perVerDeff.push(deff(attrs, sets));
  }
  const pooled = deff(attrs, [...byTask.values()]);
  const twoWay = f.summary?.diagnostics?.worst;
  const again = conjointPlugin.generate({ ...cfg, ...(method ? { method } : {}) }, seed);
  const repro = JSON.stringify(again.rows) === JSON.stringify(f.rows);
  const noneRows = f.rows.filter((r) => Number(r.none_option) === 1).length;
  const mean = perVerDeff.reduce((t, x) => t + x, 0) / perVerDeff.length;
  console.log(`${label}\n  rows=${f.rows.length} none rows=${noneRows} ms=${ms} reproducible=${repro}\n  one-way pooled: ${bal.join("; ")}; worst per-version spread=${worstVerSpread}\n  tasks with duplicate concept=${dupTasks}/${byTask.size}; task×attribute cells with overlap=${overlapCells}/${cells} (${((100 * overlapCells) / cells).toFixed(1)}%); prohibited concepts=${prohibited}\n  D-eff pooled=${(100 * pooled).toFixed(1)}%  per-version mean=${(100 * mean).toFixed(1)}% min=${(100 * Math.min(...perVerDeff)).toFixed(1)}%  two-way worst=${JSON.stringify(twoWay)}`);
}

// random baseline (for reference): legal, no dup within task
function randomDeff(attrs, versions, tasks, m, seed) {
  let s = seed >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const per = [];
  for (let v = 0; v < versions; v++) {
    const sets = [];
    for (let t = 0; t < tasks; t++) {
      const set = []; const seen = new Set();
      while (set.length < m) { const p = Object.fromEntries(attrs.map((a) => [a.name, a.levels[Math.floor(rnd() * a.levels.length)]])); const k = JSON.stringify(p); if (!seen.has(k)) { seen.add(k); set.push(p); } }
      sets.push(set);
    }
    per.push(deff(attrs, sets));
  }
  return per.reduce((t, x) => t + x, 0) / per.length;
}

console.log(`method=${method ?? "(default)"}`);
const common = { alternativesPerTask: 3, tasks: 12 };
measure("A1 4x3, 3 alts, 12 tasks, 10 versions", { attributes: base4, ...common, versions: 10 });
measure("A2 4x3, 3 alts, 12 tasks, 300 versions", { attributes: base4, ...common, versions: 300 });
measure("B  + prohibition Brand=Gamma x Battery=3 days, 10 versions", { attributes: base4, ...common, versions: 10, prohibitions: [{ a: { attribute: "Brand", level: "Gamma" }, b: { attribute: "Battery", level: "3 days" } }] });
measure("C  price attribute, 10 versions", { attributes: price4, ...common, versions: 10 });
measure("D  none option, 10 versions", { attributes: base4, ...common, versions: 10, noneOption: true });
measure("E  mixed 3x4x2x5, 4 alts, 10 tasks, 20 versions", { attributes: [A("Brand", ["A", "B", "C"]), A("Size", ["S", "M", "L", "XL"]), A("Eco", ["yes", "no"]), A("Price", ["$1", "$2", "$3", "$4", "$5"])], alternativesPerTask: 4, tasks: 10, versions: 20 });
console.log(`random baseline (legal, no dup) per-version mean D-eff 4x3/3alts/12 tasks: ${(100 * randomDeff(base4, 50, 12, 3, 1)).toFixed(1)}%`);
