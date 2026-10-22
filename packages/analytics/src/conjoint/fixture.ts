/*
 * TEST SUPPORT — not part of @rescript/analytics' surface (excluded from the packed build by the
 * `!dist/**\/fixture.js` rule). Imported by conjoint/*.test.ts and scripts/conjoint-suite-test.mjs.
 *
 * SYNTHETIC STUDIES WITH KNOWN PARAMETERS for the conjoint suite (F4, 2026-10-22). Every respondent's
 * true utilities are kept, answers are produced the way the runtime stores them (the real design
 * generators, the version from the seed, the ACBC engine's own state machine), and the errors are
 * those the models assume (Gumbel / logistic; normal for ratings), so each estimator is the true model.
 */
import { SurveyDefinition } from "@rescript/schema";
import { conjointPlugin, cvaPlugin, menuPlugin } from "@rescript/designs";
import { answerRule, chooseInTournament, designRowsFor, designVersionFor, emptyAcbcAnswer, normalizeAcbc, submitByo, submitScreen, type AcbcAnswer, type AcbcConfig } from "@rescript/engine";
import { buildDataset, type AnalyticsRow } from "../dataset.js";
import { Rng } from "../models/rng.js";
import { acbcCoding } from "./acbc.js";

export const spec = { environment: "LIVE" as const, dataset: "all" as const };
const gumbel = (r: Rng) => -Math.log(-Math.log(r.open()));
const centre = (xs: number[]) => { const m = xs.reduce((t, v) => t + v, 0) / xs.length; return xs.map((v) => v - m); };
const row = (i: number, seed: number, answers: Record<string, unknown>): AnalyticsRow => ({ id: `r${i}`, session_id: `s${i}`, respondent_code: `R${String(i + 1).padStart(4, "0")}`, seed, status: "complete", is_test: false, started_at: "2026-10-01T10:00:00Z", completed_at: "2026-10-01T10:12:00Z", answers, calculated: {}, embedded: {}, flags: [] } as AnalyticsRow);
const survey = (designs: unknown[], questions: unknown[]) => SurveyDefinition.parse({
  meta: { id: "suite", code: "SUITE", title: "Conjoint suite", version: "1.0" }, designs,
  questions: [...questions, { id: "q_seg", code: "Q9", variableName: "SEG", type: "single_select", text: "Segment", options: [{ code: 1, label: "North" }, { code: 2, label: "South" }] }],
  flow: [{ type: "page", id: "p1", questionIds: [...(questions as { id: string }[]).map((q) => q.id), "q_seg"] }, { type: "end", id: "e1", status: "complete" }],
});

export const ATTRS = [
  { name: "Brand", levels: ["Alpha", "Beta", "Gamma"] },
  { name: "Screen", levels: ["5in", "6in", "7in"] },
  { name: "Battery", levels: ["1 day", "2 days", "3 days"] },
  { name: "Price", levels: ["$199", "$299", "$399"] },
];
export const MU: Record<string, number[]> = { Brand: [0.5, 0, -0.5], Screen: [-0.3, 0.1, 0.2], Battery: [-0.6, 0.1, 0.5], Price: [1.0, 0.1, -1.1] };

/* ------------------------------------------------------------------ CVA */

export const CVA_ATTRS = [
  { name: "Brand", levels: ["Alpha", "Beta", "Gamma"] },
  { name: "Screen", levels: ["5in", "6in", "7in"] },
  { name: "Battery", levels: ["1 day", "2 days", "3 days"] },
  { name: "Storage", levels: ["64 GB", "128 GB"] },
];
/** rating points */
export const CVA_MU: Record<string, number[]> = { Brand: [1.0, 0, -1.0], Screen: [-0.6, 0.2, 0.4], Battery: [-1.2, 0.2, 1.0], Storage: [-0.5, 0.5] };

export function cvaStudy(o: { n?: number; mode?: "single" | "paired"; profiles?: number; versions?: number; het?: number; noise?: number; flat?: number; seed?: number; holdouts?: number } = {}) {
  const n = o.n ?? 200, mode = o.mode ?? "single", het = o.het ?? 0.5, noise = o.noise ?? 0.8;
  const config = { attributes: CVA_ATTRS, mode, profiles: o.profiles ?? 16, versions: o.versions ?? 4, holdouts: o.holdouts ?? 2 };
  const design = cvaPlugin.generate(config, 11);
  const def = survey([{ id: "d_cva", kind: "cva", name: "CVA", version: 1, seed: 11, config, file: { format: "json", columns: design.columns, rows: design.rows } }],
    [{ id: "q_cva", code: "Q1", variableName: "CVA", type: "conjoint_task", variant: "conjoint.cva", text: "Rate", settings: { designRef: "d_cva" } }]);
  const q = def.questions[0];
  const rng = new Rng(o.seed ?? 5);
  const lo = mode === "paired" ? 1 : 0, hi = mode === "paired" ? 9 : 10, mid = (lo + hi) / 2;
  const rows: AnalyticsRow[] = [];
  const truth: { intercept: number; levels: Record<string, number[]> }[] = [];
  for (let i = 0; i < n; i++) {
    const seed = Math.floor(rng.next() * 2 ** 31);
    const levels = Object.fromEntries(CVA_ATTRS.map((a) => [a.name, centre(CVA_MU[a.name].map((m) => m + het * rng.normal()))]));
    const intercept = 5 + 0.8 * rng.normal();
    truth.push({ intercept, levels });
    const flat = i < (o.flat ?? 0);
    const mine = designRowsFor(q, design.rows, seed);
    const ans: Record<string, number> = {};
    const u = (r: Record<string, unknown>) => CVA_ATTRS.reduce((t, a) => t + levels[a.name][a.levels.indexOf(String(r[a.name]))], 0);
    for (const t of new Set(mine.map((r) => String(r.task)))) {
      const set = mine.filter((r) => String(r.task) === t).sort((a, b) => Number(a.alt) - Number(b.alt));
      const y = flat ? 5 : mode === "single" ? intercept + u(set[0]) + noise * rng.normal() : mid + u(set[1]) - u(set[0]) + noise * rng.normal();
      ans[t] = Math.max(lo, Math.min(hi, Math.round(y)));
    }
    rows.push(row(i, seed, { q_cva: ans, q_seg: 1 + (i % 2) }));
  }
  return { def, rows, truth, design, config, ds: buildDataset(def, rows, { spec }) };
}

/* ------------------------------------------------------------------ dual-response and brand-specific CBC */

export function cbcStudy(o: { n?: number; dual?: boolean; altSpecific?: boolean; labelled?: boolean; het?: number; none?: number; seed?: number; tasks?: number } = {}) {
  const n = o.n ?? 600, het = o.het ?? 0.2, noneU = o.none ?? -0.4;
  const attrs = o.altSpecific ? [...ATTRS, { name: "5G", levels: ["No", "Yes"] }] : ATTRS;
  const mu: Record<string, number[]> = o.altSpecific ? { ...MU, "5G": [-0.4, 0.4] } : MU;
  const config = { attributes: attrs, tasks: o.tasks ?? 12, alternativesPerTask: 3, versions: 8, method: "efficient" as const, ...(o.dual ? { dualResponseNone: true } : { noneOption: true }), ...(o.altSpecific ? { alternativeSpecific: ["5G: Alpha, Beta"] } : {}), ...(o.labelled ? { labelled: true } : {}) };
  const design = conjointPlugin.generate(config, 21);
  const def = survey([{ id: "d_cbc", kind: "conjoint", name: "CBC", version: 1, seed: 21, config, file: { format: "json", columns: design.columns, rows: design.rows } }],
    [{ id: "q_cbc", code: "Q1", variableName: "CBC", type: "conjoint_task", text: "Choose", settings: { designRef: "d_cbc" } }]);
  const q = def.questions[0];
  const rng = new Rng(o.seed ?? 8);
  const rows: AnalyticsRow[] = [];
  const truth: { levels: Record<string, number[]>; none: number }[] = [];
  for (let i = 0; i < n; i++) {
    const seed = Math.floor(rng.next() * 2 ** 31);
    const levels = Object.fromEntries(attrs.map((a) => [a.name, centre(mu[a.name].map((m) => m + het * rng.normal()))]));
    const none = noneU + 0.3 * het * rng.normal();
    truth.push({ levels, none });
    const v = designVersionFor(q, design.rows, seed);
    const ans: Record<string, string> = {};
    for (let t = 1; t <= config.tasks; t++) {
      const alts = design.rows.filter((x) => String(x.version) === v && x.task === t).sort((a, b) => Number(a.alt) - Number(b.alt));
      const det = alts.map((a) => (Number(a.none_option) === 1 ? none : attrs.reduce((s, at) => { const l = String(a[at.name] ?? ""); return s + (l === "" ? 0 : levels[at.name][at.levels.indexOf(l)]); }, 0)));
      const u = det.map((x) => x + gumbel(rng));
      const k = u.indexOf(Math.max(...u));
      ans[String(t)] = String(alts[k].alt);
      // dual response: the chosen concept against None, a binary logit (the "dual" coding is the true model)
      if (o.dual) ans[`${t}_buy`] = det[k] + gumbel(rng) > none + gumbel(rng) ? "yes" : "no";
    }
    rows.push(row(i, seed, { q_cbc: ans, q_seg: 1 + (i % 2) }));
  }
  return { def, rows, truth, design, config, attrs, mu, ds: buildDataset(def, rows, { spec }) };
}

/* ------------------------------------------------------------------ ACBC */

export const ACBC_ATTRS = [
  { name: "Brand", levels: ["Alpha", "Beta", "Gamma"] },
  { name: "Screen", levels: ["5in", "6in", "7in"] },
  { name: "Battery", levels: ["1 day", "2 days", "3 days"] },
  { name: "Storage", levels: ["64 GB", "128 GB"] },
];
export const ACBC_MU: Record<string, number[]> = { Brand: [0.6, 0, -0.6], Screen: [-0.4, 0.1, 0.3], Battery: [-0.7, 0.1, 0.6], Storage: [-0.35, 0.35] };
/** utility per currency unit of the summed price (negative) */
export const ACBC_PRICE = -0.012;

export function acbcStudy(o: { n?: number; het?: number; summedPrice?: boolean; seed?: number } = {}) {
  const n = o.n ?? 300, het = o.het ?? 0.8;
  const config: AcbcConfig = { attributes: ACBC_ATTRS, screeningTasks: 6, conceptsPerScreen: 4, tournamentAlternatives: 3, minTournamentConcepts: 6,
    ...(o.summedPrice !== false ? { priceBase: 300, priceIncrements: ["Brand: 0, 50, 100", "Screen: 0, 40, 80", "Battery: 0, 30, 60", "Storage: 0, 50"], priceVariation: 30, priceRound: 1 } : {}) };
  const cfg = normalizeAcbc(config);
  const coding = acbcCoding(config);
  const ref = coding.price?.reference ?? 0;
  const def = survey([{ id: "d_acbc", kind: "acbc", name: "ACBC", version: 1, config, file: { format: "json", columns: ["stage"], rows: [{ stage: "byo" }] } }],
    [{ id: "q_acbc", code: "Q1", variableName: "ACBC", type: "acbc_task", variant: "conjoint.acbc", text: "Build", settings: { designRef: "d_acbc" } }]);
  const rng = new Rng(o.seed ?? 13);
  const rows: AnalyticsRow[] = [];
  const truth: { levels: Record<string, number[]>; threshold: number; price: number }[] = [];
  for (let i = 0; i < n; i++) {
    const seed = Math.floor(rng.next() * 2 ** 31);
    const levels = Object.fromEntries(ACBC_ATTRS.map((a) => [a.name, centre(ACBC_MU[a.name].map((m) => m + het * rng.normal()))]));
    const price = cfg.summedPrice ? ACBC_PRICE * Math.exp(0.3 * rng.normal()) : 0;
    const U = (p: Record<string, string>, pr?: number) => ACBC_ATTRS.reduce((t, a) => t + levels[a.name][a.levels.indexOf(p[a.name])], 0) + (pr != null ? price * (pr - ref) : 0);
    // BYO: each attribute's level with its price increment
    const byo: Record<string, string> = {};
    for (const a of ACBC_ATTRS) {
      const inc = cfg.summedPrice?.increments[a.name] ?? a.levels.map(() => 0);
      const u = a.levels.map((_, k) => levels[a.name][k] + price * (inc[k] ?? 0) + gumbel(rng));
      byo[a.name] = a.levels[u.indexOf(Math.max(...u))];
    }
    const listPrice = (p: Record<string, string>) => (cfg.summedPrice ? cfg.summedPrice.base + ACBC_ATTRS.reduce((t, a) => t + (cfg.summedPrice!.increments[a.name]?.[a.levels.indexOf(p[a.name])] ?? 0), 0) : undefined);
    // the threshold sits a little below the BYO's own utility, so about half of the near concepts pass
    const threshold = U(byo, listPrice(byo)) - 0.9 + 0.4 * rng.normal();
    truth.push({ levels, threshold, price });
    let a: AcbcAnswer = submitByo(cfg, emptyAcbcAnswer(), seed, byo);
    for (let guard = 0; guard < 200 && a.stage !== "done"; guard++) {
      if (a.stage === "screen") {
        const s = a.screens[a.screens.length - 1];
        const verdicts = Object.fromEntries(s.concepts.map((c) => [c.id, U(c.profile, c.price) + gumbel(rng) > threshold + gumbel(rng) ? "yes" : "no"])) as Record<string, "yes" | "no">;
        a = submitScreen(cfg, { ...a, screens: [...a.screens.slice(0, -1), { ...s, verdicts }] }, seed);
      } else if (a.stage === "rule" && a.pending) {
        const r = a.pending;
        const at = ACBC_ATTRS.find((x) => x.name === r.attribute)!;
        const gap = (l: string) => U({ ...byo, [r.attribute]: l }, listPrice({ ...byo, [r.attribute]: l })) - threshold;
        const confirm = r.kind === "unacceptable" ? gap(r.level) < -2.5 : at.levels.filter((l) => l !== r.level).every((l) => gap(l) < -2.5);
        a = answerRule(cfg, a, seed, confirm);
      } else if (a.stage === "tournament") {
        const round = a.tournament[a.tournament.length - 1];
        const u = round.concepts.map((c) => U(c.profile, c.price) + gumbel(rng));
        a = chooseInTournament(cfg, a, seed, round.concepts[u.indexOf(Math.max(...u))].id);
      } else break;
    }
    rows.push(row(i, seed, { q_acbc: a, q_seg: 1 + (i % 2) }));
  }
  return { def, rows, truth, config, coding, ds: buildDataset(def, rows, { spec }) };
}

/* ------------------------------------------------------------------ menu */

export const MENU_ITEMS = [
  { name: "Base plan", levels: ["$10", "$12", "$14"] },
  { name: "Data", levels: ["$2", "$4", "$6"] },
  { name: "Cloud", levels: ["$3", "$5", "$7"] },
  { name: "Music", levels: ["$4", "$6", "$8"] },
  { name: "Insurance", levels: ["$2", "$3", "$4"] },
  { name: "Support Std", levels: ["$1", "$2"] },
  { name: "Support Pro", levels: ["$3", "$5"] },
];
/** true parameters on the standardised price scale (x = (price − mid) / half-range) */
export const MENU_TRUE = {
  buy: { constant: 2.0, base: -0.8, other: -0.1 },
  items: { Data: { constant: 0.3, own: -1.0 }, Cloud: { constant: -0.2, own: -0.8, crossMusic: 0.6 }, Music: { constant: 0.1, own: -0.9 }, Insurance: { constant: -0.6, own: -0.5 } } as Record<string, { constant: number; own: number; crossMusic?: number }>,
  support: { "Support Std": { constant: 0.2, own: -0.6 }, "Support Pro": { constant: -0.4, own: -0.7 } } as Record<string, { constant: number; own: number }>,
};

export function menuStudy(o: { n?: number; het?: number; seed?: number; tasks?: number } = {}) {
  const n = o.n ?? 800, het = o.het ?? 0.3;
  const config = { items: MENU_ITEMS, requiredItems: ["Base plan"], exclusiveGroups: ["Support: Support Std | Support Pro"], tasks: o.tasks ?? 10, versions: 6 };
  const design = menuPlugin.generate(config, 31);
  const def = survey([{ id: "d_menu", kind: "menu", name: "Menu", version: 1, seed: 31, config, file: { format: "json", columns: design.columns, rows: design.rows } }],
    [{ id: "q_menu", code: "Q1", variableName: "MENU", type: "conjoint_task", variant: "conjoint.pricing_configurator", text: "Build your plan", settings: { designRef: "d_menu" } }]);
  const q = def.questions[0];
  const stdOf = (name: string, p: number) => { const ps = MENU_ITEMS.find((i) => i.name === name)!.levels.map((l) => Number(l.replace("$", ""))); const lo = Math.min(...ps), hi = Math.max(...ps); return (p - (lo + hi) / 2) / ((hi - lo) / 2 || 1); };
  const logistic = (r: Rng) => { const u = r.open(); return Math.log(u / (1 - u)); };
  const rng = new Rng(o.seed ?? 17);
  const rows: AnalyticsRow[] = [];
  const truth: { items: Record<string, { constant: number; own: number }>; buy: number }[] = [];
  for (let i = 0; i < n; i++) {
    const seed = Math.floor(rng.next() * 2 ** 31);
    const items = Object.fromEntries(Object.entries(MENU_TRUE.items).map(([k, v]) => [k, { constant: v.constant + het * rng.normal(), own: v.own + 0.6 * het * rng.normal() }]));
    const sup = Object.fromEntries(Object.entries(MENU_TRUE.support).map(([k, v]) => [k, { constant: v.constant + het * rng.normal(), own: v.own + 0.6 * het * rng.normal() }]));
    const buyC = MENU_TRUE.buy.constant + het * rng.normal();
    truth.push({ items, buy: buyC });
    const mine = designRowsFor(q, design.rows, seed);
    const ans: Record<string, string[]> = {};
    for (const t of new Set(mine.map((r) => String(r.task)))) {
      const shown = mine.filter((r) => String(r.task) === t);
      const price = (name: string) => Number(shown.find((r) => r.item_label === name)!.price_value);
      const id = (name: string) => String(shown.find((r) => r.item_label === name)!.item);
      const vb = buyC + MENU_TRUE.buy.base * stdOf("Base plan", price("Base plan")) + MENU_ITEMS.slice(1).reduce((s, it) => s + MENU_TRUE.buy.other * stdOf(it.name, price(it.name)), 0);
      if (vb + logistic(rng) < 0) { ans[t] = ["none"]; continue; }
      const picked: string[] = [];
      for (const [k, v] of Object.entries(items)) {
        const cross = k === "Cloud" ? (MENU_TRUE.items.Cloud.crossMusic ?? 0) * stdOf("Music", price("Music")) : 0;
        if (v.constant + v.own * stdOf(k, price(k)) + cross + logistic(rng) > 0) picked.push(id(k));
      }
      const su = Object.entries(sup).map(([k, v]) => ({ k, u: v.constant + v.own * stdOf(k, price(k)) + gumbel(rng) }));
      const best = su.reduce((b, x) => (x.u > b.u ? x : b), { k: "", u: gumbel(rng) });
      if (best.k) picked.push(id(best.k));
      ans[t] = picked.sort((a, b) => Number(a) - Number(b));
    }
    rows.push(row(i, seed, { q_menu: ans, q_seg: 1 + (i % 2) }));
  }
  return { def, rows, truth, design, config, ds: buildDataset(def, rows, { spec }) };
}

export const corr = (a: number[], b: number[]) => { const n = a.length, ma = a.reduce((t, v) => t + v, 0) / n, mb = b.reduce((t, v) => t + v, 0) / n; let ab = 0, aa = 0, bb = 0; for (let i = 0; i < n; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; } return ab / Math.sqrt(aa * bb); };
