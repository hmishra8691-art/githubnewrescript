import { mulberry32, subSeed } from "./random.js";

/**
 * ADAPTIVE CHOICE-BASED CONJOINT (ACBC) — the pure state machine.
 *
 * ## Why this is not a design file
 *
 * CBC, MaxDiff and menu tasks are generated before fielding: a table of rows
 * every respondent of a version sees. ACBC cannot be — the concepts a
 * respondent evaluates are built around THEIR build-your-own answer, and the
 * concepts that reach the tournament are the ones THEY kept. So the design
 * generator (`packages/designs/acbc.ts`) validates the configuration and
 * documents the stage plan, and everything adaptive happens here, at
 * interview time, deterministically from (config, respondent seed, answers).
 * The whole exercise is stored in one answer, so the analysis can replay it
 * exactly.
 *
 * ## The stages, as Sawtooth-style ACBC does them
 *
 *   1. BYO      — the respondent picks their preferred level of each attribute.
 *   2. SCREEN   — several screens of concepts NEAR the BYO (each differs in a
 *                 bounded number of attributes); each concept is "a
 *                 possibility" or "won't work". After a screen, a level that
 *                 keeps being rejected and never accepted is put to the
 *                 respondent as UNACCEPTABLE ("would you never consider…?");
 *                 a level present in every accepted concept as a MUST-HAVE.
 *                 Confirmed rules constrain the concepts that follow.
 *   3. TOURNAMENT — the accepted concepts compete in choice sets; the winner
 *                 of each set advances until one remains.
 *
 * The answer (`AcbcAnswer`) is the complete transcript: BYO, every screen
 * with its concepts and verdicts, the rules confirmed or declined, every
 * tournament round with its choice, and the final winner. Nothing is derived
 * later that was not shown.
 */

export interface AcbcAttribute { name: string; levels: string[] }
/**
 * A prohibition — the same shape the CBC generator reads (designs/conjoint.ts):
 * the pair a + b, optionally AND further levels (`also`, all of them or with
 * `alsoOp: "or"` any one), or a whole `when` condition tree. The ACBC design
 * form uses the same prohibitions editor as CBC, so a combination authored
 * there must mean the same thing here: before the conjoint audit (2026-10-17)
 * this engine read only a + b, so "never Value at $999 AND 3 years" silently
 * became "never Value at $999" (more concepts forbidden than asked), and a
 * `when`-only rule crashed on the missing pair.
 */
export interface AcbcProhibition {
  a: { attribute: string; level: string };
  b: { attribute: string; level: string };
  also?: { attribute: string; level: string }[];
  alsoOp?: "and" | "or";
  when?: AcbcLevelCondition;
}
export type AcbcLevelCondition =
  | { attribute: string; level: string }
  | { op: "and" | "or" | "not"; children: AcbcLevelCondition[] };

function acbcConditionMatches(p: Profile, c: AcbcLevelCondition, depth = 0): boolean {
  if (depth > 64 || !c) return false;
  if ("attribute" in c) return p[c.attribute] === c.level;
  if (!c.children?.length) return false;
  if (c.op === "and") return c.children.every((k) => acbcConditionMatches(p, k, depth + 1));
  if (c.op === "or") return c.children.some((k) => acbcConditionMatches(p, k, depth + 1));
  return !c.children.some((k) => acbcConditionMatches(p, k, depth + 1));
}

/** Does a concept break this prohibition? (the CBC generator's `effectiveProhibition` + `conceptMatches`) */
export function acbcProhibited(p: Profile, x: AcbcProhibition): boolean {
  if (x.when) return acbcConditionMatches(p, x.when);
  if (!x.a || !x.b) return false;
  if (p[x.a.attribute] !== x.a.level || p[x.b.attribute] !== x.b.level) return false;
  const extra = (x.also ?? []).filter((e) => e?.attribute && e.level != null);
  if (!extra.length) return true;
  return x.alsoOp === "or" ? extra.some((e) => p[e.attribute] === e.level) : extra.every((e) => p[e.attribute] === e.level);
}

export interface AcbcConfig {
  attributes: AcbcAttribute[];
  prohibitions?: AcbcProhibition[];
  /** screening screens; default 6 */
  screeningTasks?: number;
  /** concepts per screen; default 4 */
  conceptsPerScreen?: number;
  /** most attributes a near concept differs from the BYO in; default 2 */
  maxAttributesVaried?: number;
  /** a level rejected this many times and never accepted → asked as unacceptable; default 3 */
  unacceptableThreshold?: number;
  /** a level in this many accepted concepts and in no rejected one → asked as must-have; default 3 */
  mustHaveThreshold?: number;
  /** concepts per tournament set; default 3 */
  tournamentAlternatives?: number;
  /** concepts to carry into the tournament when fewer were accepted (padded with near concepts); default 6 */
  minTournamentConcepts?: number;
  /*
   * SUMMED PRICE (F4 2026-10-22), Sawtooth's ACBC price: a base price plus a price increment per level
   * of the attributes that carry one ("Brand: 0, 50, 120" — one number per level, in level order), and
   * a random variation of ±priceVariation % on every screened / tournament concept so price is not
   * confounded with the levels. The BYO shows each level's increment and the running total, without
   * variation. Absent → no price is shown or stored and every concept is exactly as before.
   */
  priceBase?: number;
  priceIncrements?: string[];
  /** ± percent, 0–50; default 30 */
  priceVariation?: number;
  /** round shown prices to a multiple of this; default 1 */
  priceRound?: number;
  priceCurrency?: string;
  /** the row label; default "Price" */
  priceLabel?: string;
}

export interface AcbcSummedPrice { base: number; increments: Record<string, number[]>; variation: number; round: number; currency: string; label: string }

/** "Brand: 0, 50, 120" lines → attribute → per-level increments (numbers parsed from labels like "+₹50") */
export function parsePriceIncrements(lines: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!Array.isArray(lines)) return out;
  for (const l of lines) {
    const m = /^\s*([^:=]+?)\s*[:=]\s*(.+)$/.exec(String(l ?? ""));
    if (!m) continue;
    out[m[1].trim()] = m[2].split(/\s*[|;,]\s*/).map((x) => {
      const t = x.trim();
      const n = /\d+(?:\.\d+)?/.exec(t);
      return n ? (/^-|^[^\d+]*-/.test(t) ? -Number(n[0]) : Number(n[0])) : NaN;
    });
  }
  return out;
}

function summedPriceOf(c: AcbcConfig, attributes: AcbcAttribute[]): AcbcSummedPrice | null {
  if (c.priceBase == null && !c.priceIncrements?.length) return null;
  const raw = parsePriceIncrements(c.priceIncrements);
  const increments: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(raw)) { const a = attributes.find((x) => x.name === k || x.name.toLowerCase() === k.toLowerCase()); increments[a?.name ?? k] = v; }
  return { base: Number(c.priceBase ?? 0), increments, variation: Math.min(50, Math.max(0, Number(c.priceVariation ?? 30))) / 100, round: Math.max(0.01, Number(c.priceRound ?? 1)), currency: c.priceCurrency ?? "", label: c.priceLabel?.trim() || "Price" };
}

/** the summed price of a profile before variation */
export function acbcListPrice(sp: AcbcSummedPrice, attributes: AcbcAttribute[], p: Profile): number {
  let t = sp.base;
  for (const a of attributes) { const inc = sp.increments[a.name]; const k = a.levels.indexOf(p[a.name]); if (inc && k >= 0 && Number.isFinite(inc[k])) t += inc[k]; }
  return t;
}
/** the price a screened / tournament concept shows: list price × (1 ± variation), seeded per concept, rounded */
export function acbcConceptPrice(sp: AcbcSummedPrice, attributes: AcbcAttribute[], p: Profile, seed: number, key: string): number {
  const u = mulberry32(subSeed(seed, `acbc:price:${key}`))();
  const v = acbcListPrice(sp, attributes, p) * (1 + sp.variation * (2 * u - 1));
  return Math.round(Math.round(v / sp.round) * sp.round * 100) / 100;
}

export type Profile = Record<string, string>;
/** `price`: the summed price shown with the concept (only when the design has a summed price) */
export interface AcbcConcept { id: string; profile: Profile; price?: number }
export interface AcbcRule { attribute: string; level: string; confirmed: boolean }

export interface AcbcAnswer {
  stage: "byo" | "screen" | "rule" | "tournament" | "done";
  byo: Profile;
  screens: { concepts: AcbcConcept[]; verdicts: Record<string, "yes" | "no"> }[];
  /** a rule awaiting the respondent's confirmation */
  pending?: { kind: "unacceptable" | "musthave"; attribute: string; level: string };
  unacceptable: AcbcRule[];
  mustHave: AcbcRule[];
  tournament: { concepts: AcbcConcept[]; chosen?: string }[];
  /** concepts still in the tournament (ids) */
  remaining: string[];
  winner?: AcbcConcept;
}

export function normalizeAcbc(c: AcbcConfig) {
  return {
    attributes: c.attributes ?? [],
    prohibitions: c.prohibitions ?? [],
    screeningTasks: c.screeningTasks ?? 6,
    conceptsPerScreen: c.conceptsPerScreen ?? 4,
    maxAttributesVaried: Math.max(1, c.maxAttributesVaried ?? 2),
    unacceptableThreshold: Math.max(2, c.unacceptableThreshold ?? 3),
    mustHaveThreshold: Math.max(2, c.mustHaveThreshold ?? 3),
    tournamentAlternatives: Math.max(2, c.tournamentAlternatives ?? 3),
    minTournamentConcepts: Math.max(2, c.minTournamentConcepts ?? 6),
    /** F4 2026-10-22: null unless the design sets a summed price */
    summedPrice: summedPriceOf(c, c.attributes ?? []),
  };
}
export type AcbcNormalized = ReturnType<typeof normalizeAcbc>;

export function emptyAcbcAnswer(): AcbcAnswer {
  return { stage: "byo", byo: {}, screens: [], unacceptable: [], mustHave: [], tournament: [], remaining: [] };
}

export function isAcbcAnswer(v: unknown): v is AcbcAnswer {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as AcbcAnswer).stage === "string" && Array.isArray((v as AcbcAnswer).screens);
}

const violates = (p: Profile, pro: AcbcProhibition[]) => pro.some((x) => acbcProhibited(p, x));
const profileKey = (attrs: AcbcAttribute[], p: Profile) => attrs.map((a) => p[a.name]).join("");

/** Levels ruled out by confirmed unacceptables, and forced by confirmed must-haves. */
function constraints(a: AcbcAnswer) {
  const banned = new Set(a.unacceptable.filter((r) => r.confirmed).map((r) => `${r.attribute}${r.level}`));
  const forced = new Map(a.mustHave.filter((r) => r.confirmed).map((r) => [r.attribute, r.level]));
  return { banned, forced };
}

/**
 * CONCEPTS NEAR THE BYO: each differs from it in 1..maxAttributesVaried
 * attributes, level use balanced across the concepts generated so far for
 * this respondent, no duplicate of the BYO or of another concept on the same
 * screen, prohibitions and confirmed rules honoured. Deterministic from the
 * seed and the screen number.
 */
export function nearConcepts(cfg: AcbcNormalized, a: AcbcAnswer, seed: number, screenIndex: number, count: number, exclude: Set<string>): AcbcConcept[] {
  const rng = mulberry32(subSeed(seed, `acbc:screen:${screenIndex}`));
  const { banned, forced } = constraints(a);
  // level usage so far, so the screens between them show every level
  const used = new Map<string, number>();
  for (const s of a.screens) for (const c of s.concepts) for (const [k, v] of Object.entries(c.profile)) used.set(`${k}${v}`, (used.get(`${k}${v}`) ?? 0) + 1);
  const out: AcbcConcept[] = [];
  const seen = new Set<string>(exclude);
  seen.add(profileKey(cfg.attributes, a.byo));
  const variable = cfg.attributes.filter((at) => !forced.has(at.name) && at.levels.some((l) => l !== a.byo[at.name] && !banned.has(`${at.name}${l}`)));
  for (let attempt = 0; attempt < count * 60 && out.length < count; attempt++) {
    const p: Profile = { ...a.byo };
    for (const [attr, lvl] of forced) p[attr] = lvl;
    const vary = 1 + Math.floor(rng() * Math.min(cfg.maxAttributesVaried, variable.length));
    const pool = [...variable];
    for (let i = 0; i < vary && pool.length; i++) {
      const at = pool.splice(Math.floor(rng() * pool.length), 1)[0];
      const cands = at.levels.filter((l) => l !== a.byo[at.name] && !banned.has(`${at.name}${l}`));
      if (!cands.length) continue;
      let min = Infinity;
      for (const l of cands) min = Math.min(min, used.get(`${at.name}${l}`) ?? 0);
      const least = cands.filter((l) => (used.get(`${at.name}${l}`) ?? 0) === min);
      p[at.name] = least[Math.floor(rng() * least.length)];
    }
    const key = profileKey(cfg.attributes, p);
    if (seen.has(key) || violates(p, cfg.prohibitions)) continue;
    seen.add(key);
    for (const [k, v] of Object.entries(p)) used.set(`${k}${v}`, (used.get(`${k}${v}`) ?? 0) + 1);
    const cid = `s${screenIndex}c${out.length + 1}`;
    out.push(cfg.summedPrice ? { id: cid, profile: p, price: acbcConceptPrice(cfg.summedPrice, cfg.attributes, p, seed, cid) } : { id: cid, profile: p });
  }
  return out;
}

/** After a screen: a level to put to the respondent as unacceptable or must-have, if any. */
export function detectRule(cfg: AcbcNormalized, a: AcbcAnswer): AcbcAnswer["pending"] | undefined {
  const asked = new Set([...a.unacceptable, ...a.mustHave].map((r) => `${r.attribute}${r.level}`));
  const accepted = new Map<string, number>(), rejected = new Map<string, number>();
  let nAccepted = 0;
  for (const s of a.screens) for (const c of s.concepts) {
    const v = s.verdicts[c.id];
    if (!v) continue;
    if (v === "yes") nAccepted++;
    for (const [k, l] of Object.entries(c.profile)) {
      const key = `${k}${l}`;
      (v === "yes" ? accepted : rejected).set(key, ((v === "yes" ? accepted : rejected).get(key) ?? 0) + 1);
    }
  }
  // unacceptable: rejected often, never accepted, and not the BYO level (they chose it)
  for (const at of cfg.attributes) for (const l of at.levels) {
    const key = `${at.name}${l}`;
    if (asked.has(key) || a.byo[at.name] === l) continue;
    if ((rejected.get(key) ?? 0) >= cfg.unacceptableThreshold && !(accepted.get(key) ?? 0)) {
      return { kind: "unacceptable", attribute: at.name, level: l };
    }
  }
  // must-have: in every accepted concept (enough of them), in no rejected one, and the attribute still varies
  if (nAccepted >= cfg.mustHaveThreshold) {
    for (const at of cfg.attributes) for (const l of at.levels) {
      const key = `${at.name}${l}`;
      if (asked.has(key)) continue;
      if ((accepted.get(key) ?? 0) === nAccepted && !(rejected.get(key) ?? 0) && at.levels.length > 1) {
        // only meaningful if some rejected concept had a DIFFERENT level of this attribute
        const otherRejected = at.levels.some((o) => o !== l && (rejected.get(`${at.name}${o}`) ?? 0) > 0);
        if (otherRejected) return { kind: "musthave", attribute: at.name, level: l };
      }
    }
  }
  return undefined;
}

/** The concepts that go into the tournament: every accepted one, padded with fresh near concepts to the minimum. */
export function tournamentPool(cfg: AcbcNormalized, a: AcbcAnswer, seed: number): AcbcConcept[] {
  const accepted = a.screens.flatMap((s) => s.concepts.filter((c) => s.verdicts[c.id] === "yes"));
  const seen = new Set(accepted.map((c) => profileKey(cfg.attributes, c.profile)));
  const pool = [...accepted];
  if (pool.length < cfg.minTournamentConcepts) {
    const extra = nearConcepts(cfg, a, seed, 900, cfg.minTournamentConcepts - pool.length, seen).map((c, i) => ({ ...c, id: `pad${i + 1}` }));
    pool.push(...extra);
  }
  // the BYO itself is always in the tournament — it is the respondent's own ideal
  pool.push(cfg.summedPrice ? { id: "byo", profile: { ...a.byo }, price: acbcByoPrice(cfg, a.byo) } : { id: "byo", profile: { ...a.byo } });
  return pool;
}

/** Start the next tournament round from the remaining concepts, or declare the winner. */
export function nextTournamentRound(cfg: AcbcNormalized, a: AcbcAnswer, seed: number): AcbcAnswer {
  const byId = new Map<string, AcbcConcept>();
  for (const r of a.tournament) for (const c of r.concepts) byId.set(c.id, c);
  for (const c of tournamentPool(cfg, a, seed)) if (!byId.has(c.id)) byId.set(c.id, c);
  const remaining = a.remaining.map((id) => byId.get(id)!).filter(Boolean);
  if (remaining.length === 1) return { ...a, stage: "done", winner: remaining[0] };
  // the next set is the front of the queue; a round's winner is re-queued at the back (chooseInTournament),
  // so it meets fresh opponents and every concept is seen before any is seen twice
  const set = remaining.slice(0, Math.min(cfg.tournamentAlternatives, remaining.length));
  return { ...a, stage: "tournament", tournament: [...a.tournament, { concepts: set }] };
}

/* --------------------------------------------------------- transitions */

/** BYO complete → the first screen. */
export function submitByo(cfg: AcbcNormalized, a: AcbcAnswer, seed: number, byo: Profile): AcbcAnswer {
  const next: AcbcAnswer = { ...a, byo: { ...byo }, screens: [], unacceptable: [], mustHave: [], tournament: [], remaining: [], winner: undefined, pending: undefined, stage: "screen" };
  next.screens = [{ concepts: nearConcepts(cfg, next, seed, 1, cfg.conceptsPerScreen, new Set()), verdicts: {} }];
  return next;
}

/** All concepts on the current screen judged → a rule to confirm, the next screen, or the tournament. */
export function submitScreen(cfg: AcbcNormalized, a: AcbcAnswer, seed: number): AcbcAnswer {
  const pending = detectRule(cfg, a);
  if (pending) return { ...a, stage: "rule", pending };
  return advanceScreens(cfg, a, seed);
}

function advanceScreens(cfg: AcbcNormalized, a: AcbcAnswer, seed: number): AcbcAnswer {
  if (a.screens.length < cfg.screeningTasks) {
    const idx = a.screens.length + 1;
    const exclude = new Set(a.screens.flatMap((s) => s.concepts.map((c) => profileKey(cfg.attributes, c.profile))));
    const concepts = nearConcepts(cfg, a, seed, idx, cfg.conceptsPerScreen, exclude);
    if (concepts.length) return { ...a, stage: "screen", pending: undefined, screens: [...a.screens, { concepts, verdicts: {} }] };
  }
  const pool = tournamentPool(cfg, a, seed);
  const started: AcbcAnswer = { ...a, stage: "tournament", pending: undefined, remaining: pool.map((c) => c.id), tournament: [] };
  return nextTournamentRound(cfg, started, seed);
}

/** The respondent answered the pending rule. */
export function answerRule(cfg: AcbcNormalized, a: AcbcAnswer, seed: number, confirmed: boolean): AcbcAnswer {
  if (!a.pending) return a;
  const rule: AcbcRule = { attribute: a.pending.attribute, level: a.pending.level, confirmed };
  const next: AcbcAnswer = a.pending.kind === "unacceptable"
    ? { ...a, unacceptable: [...a.unacceptable, rule], pending: undefined }
    : { ...a, mustHave: [...a.mustHave, rule], pending: undefined };
  // another rule may already be evident from the same screens
  const more = detectRule(cfg, next);
  if (more) return { ...next, stage: "rule", pending: more };
  return advanceScreens(cfg, next, seed);
}

/** A tournament choice: the chosen concept advances, the others are out. */
export function chooseInTournament(cfg: AcbcNormalized, a: AcbcAnswer, seed: number, conceptId: string): AcbcAnswer {
  const round = a.tournament[a.tournament.length - 1];
  if (!round || round.chosen) return a;
  const losers = round.concepts.filter((c) => c.id !== conceptId).map((c) => c.id);
  const remaining = a.remaining.filter((id) => !losers.includes(id));
  const next: AcbcAnswer = { ...a, tournament: [...a.tournament.slice(0, -1), { ...round, chosen: conceptId }], remaining };
  // move the chosen concept to the back so it meets fresh opponents next
  next.remaining = [...next.remaining.filter((id) => id !== conceptId), conceptId];
  return nextTournamentRound(cfg, next, seed);
}

/** the BYO's summed price (no variation), rounded as the concepts are */
export function acbcByoPrice(cfg: AcbcNormalized, byo: Profile): number | undefined {
  if (!cfg.summedPrice) return undefined;
  return Math.round(Math.round(acbcListPrice(cfg.summedPrice, cfg.attributes, byo) / cfg.summedPrice.round) * cfg.summedPrice.round * 100) / 100;
}

/** Is the exercise complete? */
export function acbcDone(v: unknown): boolean { return isAcbcAnswer(v) && v.stage === "done" && !!v.winner; }
