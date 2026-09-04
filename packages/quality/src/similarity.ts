import type { SurveyDefinition } from "@rescript/schema";
import type { ClusterInfo, FlagDraft, PeerRecord, RuleContext } from "./types.js";
import { fnv1a, pct } from "./metrics.js";
import { isMatrix, isMulti, isSingle } from "./survey.js";

/**
 * Respondent-to-respondent similarity and coordinated-cluster detection.
 *
 * Similarity is computed on the closed questions both respondents answered:
 * the share of agreeing answers, but weighted by how UNLIKELY each agreement
 * is given the survey's own answer distribution — two people agreeing on a
 * 50/50 yes/no is nothing; two people agreeing on a rare option, on twenty
 * questions in a row, is something. Grids count row by row.
 *
 * A pair is LINKED when the answer similarity is high AND another signal is
 * shared (device hash, IP hash, navigation fingerprint, matrix signatures,
 * timing profile), or when similarity alone is extreme. Links are closed into
 * clusters with union-find; a cluster's risk grows with its size and with how
 * many kinds of signal its members share.
 */

export interface ComparableAnswers {
  /** key → normalised value for every comparable item (question or grid row) */
  items: Record<string, string>;
}

export function comparable(def: SurveyDefinition, answers: Record<string, unknown>): ComparableAnswers {
  const items: Record<string, string> = {};
  for (const q of def.questions) {
    const v = answers[q.id];
    if (v === undefined || v === null) continue;
    if (isSingle(q)) items[q.id] = String(v);
    else if (isMulti(q) && Array.isArray(v)) items[q.id] = [...v].map(String).sort().join("|");
    else if (isMatrix(q) && typeof v === "object" && !Array.isArray(v)) {
      for (const [row, col] of Object.entries(v as Record<string, unknown>)) if (col !== undefined && col !== null) items[`${q.id}#${row}`] = String(col);
    } else if (q.type === "numeric" || q.type === "slider" || q.type === "nps") items[q.id] = String(v);
  }
  return { items };
}

/** How common each (item, value) is among peers — for weighting agreements. */
export function valueFrequencies(peers: ComparableAnswers[]): Map<string, number> {
  const counts = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const p of peers) {
    for (const [k, v] of Object.entries(p.items)) {
      counts.set(`${k}=${v}`, (counts.get(`${k}=${v}`) ?? 0) + 1);
      totals.set(k, (totals.get(k) ?? 0) + 1);
    }
  }
  const freq = new Map<string, number>();
  for (const [kv, c] of counts) {
    const k = kv.slice(0, kv.indexOf("="));
    freq.set(kv, c / (totals.get(k) ?? 1));
  }
  return freq;
}

export interface PairSimilarity {
  /** plain agreement share */
  agreement: number;
  /** agreement weighted by rarity (0–1) */
  weighted: number;
  compared: number;
}

export function pairSimilarity(a: ComparableAnswers, b: ComparableAnswers, freq: Map<string, number>): PairSimilarity {
  let compared = 0, agree = 0, w = 0, wTotal = 0;
  for (const [k, v] of Object.entries(a.items)) {
    const bv = b.items[k];
    if (bv === undefined) continue;
    compared++;
    // rarity weight: agreeing on a value 90% of people give is worth 0.1; on a 5% value, 0.95
    const f = freq.get(`${k}=${v}`) ?? 0.5;
    const weight = 1 - Math.min(0.95, f);
    wTotal += weight;
    if (bv === v) { agree++; w += weight; }
  }
  return { agreement: compared ? agree / compared : 0, weighted: wTotal ? w / wTotal : 0, compared };
}

/** Signature of the whole closed-answer vector — exact duplicates hash equal. */
export function answerSignature(c: ComparableAnswers): string | null {
  const keys = Object.keys(c.items).sort();
  if (keys.length < 3) return null;
  return fnv1a(keys.map((k) => `${k}=${c.items[k]}`).join("|"));
}

export interface SharedSignals {
  device: boolean;
  ip: boolean;
  navigation: boolean;
  matrix: number;
  timing: boolean;
  openEnd: number;
}

export function sharedSignals(me: { deviceHash?: string | null; ipHash?: string | null; system?: Partial<Record<string, any>> | null }, peer: PeerRecord): SharedSignals {
  const ms = me.system ?? {}; const ps = peer.system ?? {};
  let matrix = 0;
  for (const [qid, sig] of Object.entries((ms.SYSTEM_MATRIX_SIGNATURE ?? {}) as Record<string, string>)) if (sig && ps.SYSTEM_MATRIX_SIGNATURE?.[qid] === sig) matrix++;
  let openEnd = 0;
  for (const [qid, h] of Object.entries((ms.SYSTEM_OPENEND_HASHES ?? {}) as Record<string, string>)) if (h && ps.SYSTEM_OPENEND_HASHES?.[qid] === h) openEnd++;
  let timing = false;
  const mt = ms.SYSTEM_PAGE_TIME as Record<string, number> | undefined, pt = ps.SYSTEM_PAGE_TIME;
  if (mt && pt) {
    const common = Object.keys(mt).filter((k) => pt[k] !== undefined && mt[k] > 0);
    if (common.length >= 5) timing = common.every((k) => Math.abs(mt[k] - pt[k]) / Math.max(mt[k], 0.5) <= 0.1);
  }
  return {
    device: !!me.deviceHash && me.deviceHash === peer.deviceHash,
    ip: !!me.ipHash && me.ipHash === peer.ipHash,
    navigation: !!ms.SYSTEM_NAV_FINGERPRINT && ms.SYSTEM_NAV_FINGERPRINT === ps.SYSTEM_NAV_FINGERPRINT && ((ms.SYSTEM_BACK_COUNT as number) ?? 0) >= 1,
    matrix, timing, openEnd,
  };
}

export const signalNames = (s: SharedSignals): string[] => [
  ...(s.device ? ["device signature"] : []),
  ...(s.ip ? ["IP address"] : []),
  ...(s.navigation ? ["navigation path"] : []),
  ...(s.matrix ? [`${s.matrix} identical grid${s.matrix === 1 ? "" : "s"}`] : []),
  ...(s.timing ? ["timing profile"] : []),
  ...(s.openEnd ? [`${s.openEnd} identical open end${s.openEnd === 1 ? "" : "s"}`] : []),
];

/* ============================================================ union-find */

export class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) { p = this.find(p); this.parent.set(x, p); }
    return p;
  }
  union(a: string, b: string) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/* ============================================================ per-response */

export interface SimilarityResult {
  flags: FlagDraft[];
  cluster: ClusterInfo;
  similarityScore: number;
  similarIds: string[];
  answerSignature: string | null;
}

/**
 * Similarity of ONE response against its peers: duplicate flags, the
 * multi-signal duplicate flag, and a provisional cluster (this response plus
 * the peers it links to, plus the clusters those peers already belong to).
 * The survey-wide recompute (`clusterSurvey`) assigns final cluster ids.
 */
export function similarityRules(ctx: RuleContext, mySystem: Partial<Record<string, any>>): SimilarityResult {
  const flags: FlagDraft[] = [];
  const me = comparable(ctx.def, ctx.response.answers);
  const sig = answerSignature(me);
  const others = ctx.peers.filter((p) => p.sessionId !== ctx.response.sessionId && p.status === "complete");
  const empty: ClusterInfo = { clusterId: null, similarityScore: 0, similarSessionIds: [], clusterRisk: 0, size: 1, sharedSignals: [] };
  if (!others.length) return { flags, cluster: empty, similarityScore: 0, similarIds: [], answerSignature: sig };

  const peerComparables = others.map((p) => ({ p, c: comparable(ctx.def, p.answers) }));
  const freq = valueFrequencies([me, ...peerComparables.map((x) => x.c)]);
  const minQ = ctx.param<number>("duplicate.answers", "minQuestions");
  const dupThr = ctx.param<number>("duplicate.answers", "similarity");
  const multiThr = ctx.param<number>("duplicate.multi_signal", "similarity");
  const linkThr = ctx.param<number>("cluster.coordinated", "linkSimilarity");

  const scored = peerComparables.map(({ p, c }) => {
    const s = pairSimilarity(me, c, freq);
    const shared = sharedSignals({ deviceHash: ctx.response.deviceHash, ipHash: ctx.response.ipHash, system: mySystem }, p);
    const sharedCount = signalNames(shared).length;
    // blended similarity: weighted agreement, lifted by shared signals
    const blended = Math.min(1, s.weighted * 0.75 + s.agreement * 0.25 + sharedCount * 0.05);
    return { p, s, shared, sharedCount, blended };
  }).filter((x) => x.s.compared >= Math.min(minQ, Object.keys(me.items).length) || x.sharedCount >= 2);

  scored.sort((a, b) => b.blended - a.blended);
  const top = scored[0];
  const similarityScore = top ? Math.round(top.blended * 100) : 0;

  /* duplicate answers */
  const dups = scored.filter((x) => x.s.weighted >= dupThr && x.s.compared >= minQ);
  if (ctx.enabled("duplicate.answers") && dups.length) {
    const d = dups[0];
    flags.push({
      ruleId: "duplicate.answers",
      observed: `${pct(d.s.agreement)} of ${d.s.compared} comparable answers agree with respondent ${d.p.sessionId.slice(0, 8)} (rarity-weighted ${pct(d.s.weighted)})${dups.length > 1 ? `; ${dups.length - 1} more near-identical` : ""}`,
      expected: `weighted agreement < ${pct(dupThr)}`,
      explanation: "Closed-question answers agree with another respondent far beyond what the survey's answer distribution predicts.",
      relatedSessionIds: dups.map((x) => x.p.sessionId).slice(0, 10),
      intensity: Math.min(1, 0.6 + (d.s.weighted - dupThr) * 4 + dups.length * 0.1),
    });
  }

  /* multi-signal duplicate */
  const multi = scored.filter((x) => x.s.weighted >= multiThr && x.sharedCount >= 1 && x.s.compared >= Math.min(minQ, 6));
  if (ctx.enabled("duplicate.multi_signal") && multi.length) {
    const m = multi[0];
    flags.push({
      ruleId: "duplicate.multi_signal",
      observed: `${pct(m.s.agreement)} answer agreement with ${m.p.sessionId.slice(0, 8)} plus shared ${signalNames(m.shared).join(", ")}`,
      explanation: "Similar answers AND a shared device, network, timing or navigation signature — the same person or the same script.",
      relatedSessionIds: multi.map((x) => x.p.sessionId).slice(0, 10),
      intensity: Math.min(1, 0.7 + multi.length * 0.1),
    });
  }

  /* links → provisional cluster */
  // few comparable answers (a short survey) → answer similarity says little, shared signals carry the link
  const fewItems = Object.keys(me.items).length < 3;
  const linked = scored.filter((x) =>
    (x.s.weighted >= linkThr && x.sharedCount >= 1 && !fewItems)
    || (x.s.weighted >= Math.min(0.99, linkThr + 0.1) && !fewItems)
    || (x.sharedCount >= 2 && x.s.weighted >= linkThr - 0.15)
    || x.sharedCount >= 3);
  const similarIds = linked.map((x) => x.p.sessionId);
  let cluster = empty;
  if (linked.length) {
    const kinds = new Set<string>();
    for (const l of linked) for (const n of signalNames(l.shared)) kinds.add(n.replace(/^\d+ /, "").replace(/s$/, ""));
    const size = linked.length + 1;
    const minSize = ctx.param<number>("cluster.coordinated", "minSize");
    const clusterRisk = Math.min(100, Math.round(30 + Math.min(40, (size - 2) * 8) + kinds.size * 10 + (linked[0].s.weighted - linkThr) * 50));
    cluster = {
      clusterId: `c_${fnv1a([ctx.response.sessionId, ...similarIds].sort().join(","))}`,
      similarityScore, similarSessionIds: similarIds.slice(0, 50), clusterRisk, size,
      sharedSignals: [...kinds],
    };
    if (ctx.enabled("cluster.coordinated") && size >= minSize) {
      flags.push({
        ruleId: "cluster.coordinated",
        observed: `${size} linked responses sharing ${[...kinds].join(", ") || "highly similar answers"}`,
        expected: `clusters < ${minSize}`,
        explanation: "This response belongs to a group of respondents linked by similar answers and shared behavioural or device signals — a potential coordinated response cluster.",
        relatedSessionIds: similarIds.slice(0, 10),
        intensity: Math.min(1, clusterRisk / 100),
      });
    }
    /* burst */
    if (ctx.enabled("cluster.burst") && ctx.response.completedAt) {
      const win = ctx.param<number>("cluster.burst", "windowSec") * 1000;
      const need = ctx.param<number>("cluster.burst", "count");
      const mine = new Date(ctx.response.completedAt).getTime();
      const inWindow = linked.filter((x) => x.p.completedAt && Math.abs(new Date(x.p.completedAt).getTime() - mine) <= win);
      if (inWindow.length + 1 >= need) {
        flags.push({
          ruleId: "cluster.burst",
          observed: `${inWindow.length + 1} linked completes within ${win / 60000} minutes`,
          expected: `< ${need}`,
          explanation: "Many linked responses completed within a short window.",
          relatedSessionIds: inWindow.map((x) => x.p.sessionId).slice(0, 10),
        });
      }
    }
  }

  return { flags, cluster, similarityScore, similarIds, answerSignature: sig };
}

/* ============================================================ survey-wide */

export interface ClusterAssignment { sessionId: string; clusterId: string; size: number; members: string[] }

/**
 * Close the provisional pairwise links across a whole survey into final
 * clusters. Input: every response's similar ids (from its assessment).
 * Output: for each response in a cluster of ≥ 2, its cluster id and members.
 */
export function clusterSurvey(links: { sessionId: string; similarIds: string[] }[]): Map<string, ClusterAssignment> {
  const uf = new UnionFind();
  for (const l of links) for (const s of l.similarIds) uf.union(l.sessionId, s);
  const groups = new Map<string, string[]>();
  for (const l of links) {
    const root = uf.find(l.sessionId);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(l.sessionId);
  }
  const out = new Map<string, ClusterAssignment>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const sorted = [...new Set(members)].sort();
    const clusterId = `c_${fnv1a(sorted.join(","))}`;
    for (const m of sorted) out.set(m, { sessionId: m, clusterId, size: sorted.length, members: sorted });
  }
  return out;
}
