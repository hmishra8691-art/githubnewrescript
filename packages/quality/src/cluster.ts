/**
 * THE FRAUD NETWORK GRAPH (0085) — the brief's §19.
 *
 * One arrival at a time, `admission.ts` can see that a device is shared. It cannot see that forty identities
 * are circulating through six devices, because that is a fact about a POPULATION. This builds the graph and
 * finds those rings.
 *
 * ## The one idea that makes this work
 *
 * A naive version joins identities wherever they share a signal, and immediately produces a single component
 * containing half the respondents on the platform — because a mobile carrier puts thousands of unrelated
 * people behind one address, and a university or an office does the same. The output is useless and, worse,
 * confident.
 *
 * So an edge is weighted by how RARE the shared signal is. Two identities sharing a token nobody else has is
 * strong evidence; two identities sharing a token two thousand people have is no evidence at all, and the edge
 * is dropped entirely. A signal common enough to be infrastructure tells you nothing about the people behind
 * it. That single rule is what separates "a ring" from "everyone on Vodafone".
 *
 * ## And the second
 *
 * Size is not the signal. A large family shares devices; a student house shares a router. What distinguishes a
 * click farm is the RATIO — forty identities circulating through six devices — together with how rare the
 * links are. A household of four on two tablets scores near zero here no matter how often it is seen, and that
 * is deliberate: the cost of being wrong is forty real people losing paid work at once.
 *
 * Nothing here blocks anybody. A cluster opens one case for the whole ring and waits for a human.
 */

export type SignalKind = "device" | "network" | "behaviour";

export interface ClusterIdentity {
  id: string;
  /** probabilistic tokens only — a deterministic identifier would have merged the identities already */
  signals: { kind: SignalKind; token: string }[];
  /** when this identity was first seen, for the burst check. ISO string. */
  firstSeen?: string | null;
}

export interface ClusterConfig {
  /** a component smaller than this is not a ring; it is a household or a coincidence */
  minSize: number;
  /**
   * A signal shared by more identities than this is INFRASTRUCTURE — a carrier NAT, a campus, a corporate
   * proxy — and carries no information about who is behind it. Its edges are dropped entirely.
   */
  maxIdentitiesPerSignal: number;
  /** identities-per-device at or below this is ordinary sharing: a family, a couple, a house */
  householdRatio: number;
  /** identities-per-device at or above this is circulation, not sharing */
  farmRatio: number;
  /** a cluster scoring below this is not reported at all */
  minScore: number;
  /** arrivals inside this window count as a burst */
  burstWindowMinutes: number;
}

export const DEFAULT_CLUSTER_CONFIG: ClusterConfig = Object.freeze({
  minSize: 6,
  maxIdentitiesPerSignal: 50,
  householdRatio: 3,
  farmRatio: 8,
  minScore: 45,
  burstWindowMinutes: 60,
});

/** How much a shared signal is worth as evidence, given how many identities share it. */
export const KIND_WEIGHT: Readonly<Record<SignalKind, number>> = Object.freeze({
  // a device signature is the strongest circumstantial link; a network the weakest
  device: 1, behaviour: 0.7, network: 0.45,
});

export interface Cluster {
  signature: string;
  members: string[];
  size: number;
  devices: number;
  networks: number;
  identitiesPerDevice: number | null;
  /** 0–1: how rare, on average, the links holding this group together are */
  cohesion: number;
  /** identities that first appeared inside one burst window */
  burst: number;
  score: number;
  signals: SignalKind[];
  evidence: Record<string, unknown>;
}

/**
 * Evidence weight of one shared signal.
 *
 * `1 / log2(k)` for k identities sharing it: a token held by exactly two is worth 1, by four 0.5, by sixteen
 * 0.25. Past `maxIdentitiesPerSignal` it is zero — not small, zero. There is no number of people on one
 * carrier NAT that makes them a ring, so the edge should not exist at all rather than contribute a little.
 */
export function signalWeight(kind: SignalKind, sharedBy: number, config: ClusterConfig): number {
  if (sharedBy < 2) return 0;
  if (sharedBy > config.maxIdentitiesPerSignal) return 0;
  return KIND_WEIGHT[kind] / Math.log2(sharedBy);
}

/** A stable fingerprint of a member set, so re-running the pass updates a cluster instead of duplicating it. */
export function clusterSignature(members: readonly string[]): string {
  // FNV-1a over the sorted ids. Deterministic, dependency-free, and browser-safe — this is a fingerprint, not a secret.
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (const m of [...members].sort()) {
    for (let i = 0; i < m.length; i++) {
      h1 ^= m.charCodeAt(i); h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = (h2 + m.charCodeAt(i)) >>> 0; h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    }
    h1 = Math.imul(h1 ^ 0x5f, 0x01000193) >>> 0;
  }
  return `cl_${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** 0 below `lo`, 1 at or above `hi`, straight line between. */
function ramp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value) || hi <= lo) return 0;
  return Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    const p = this.parent.get(x);
    if (p === undefined) { this.parent.set(x, x); return x; }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function detectClusters(
  identities: readonly ClusterIdentity[],
  config: ClusterConfig = DEFAULT_CLUSTER_CONFIG,
): Cluster[] {
  // how many identities hold each token — the frequency that decides whether a link is evidence
  const holders = new Map<string, Set<string>>();
  for (const id of identities) {
    for (const s of id.signals) {
      const key = `${s.kind}:${s.token}`;
      (holders.get(key) ?? holders.set(key, new Set()).get(key)!).add(id.id);
    }
  }

  const uf = new UnionFind();
  for (const id of identities) uf.find(id.id);

  // every token that is evidence links the identities holding it; the rest are not edges at all
  const edgeWeights = new Map<string, number>();
  for (const [key, set] of holders) {
    const kind = key.slice(0, key.indexOf(":")) as SignalKind;
    const weight = signalWeight(kind, set.size, config);
    if (weight <= 0) continue;
    edgeWeights.set(key, weight);
    const list = [...set].sort();
    for (let i = 1; i < list.length; i++) uf.union(list[0]!, list[i]!);
  }

  const components = new Map<string, ClusterIdentity[]>();
  for (const id of identities) {
    const root = uf.find(id.id);
    (components.get(root) ?? components.set(root, []).get(root)!).push(id);
  }

  const out: Cluster[] = [];
  for (const group of components.values()) {
    if (group.length < config.minSize) continue;

    const ids = new Set(group.map((g) => g.id));
    const devices = new Set<string>(), networks = new Set<string>();
    const kinds = new Set<SignalKind>();
    let weightSum = 0, weightCount = 0;

    for (const [key, weight] of edgeWeights) {
      const set = holders.get(key)!;
      // only the links actually inside this component
      if (![...set].some((m) => ids.has(m))) continue;
      const kind = key.slice(0, key.indexOf(":")) as SignalKind;
      kinds.add(kind);
      if (kind === "device") devices.add(key);
      if (kind === "network") networks.add(key);
      weightSum += weight; weightCount += 1;
    }

    const ratio = devices.size > 0 ? group.length / devices.size : null;
    const cohesion = weightCount > 0 ? weightSum / weightCount : 0;

    // identities that first appeared inside one window
    const seen = group.map((g) => (g.firstSeen ? Date.parse(g.firstSeen) : NaN)).filter(Number.isFinite).sort((a, b) => a - b);
    let burst = 0;
    if (seen.length > 1) {
      const window = config.burstWindowMinutes * 60_000;
      let start = 0;
      for (let i = 1; i < seen.length; i++) {
        while (seen[i]! - seen[start]! > window) start++;
        burst = Math.max(burst, i - start + 1);
      }
    }

    /*
     * The score. Ratio dominates, because it is the thing that actually separates circulation from sharing;
     * size and cohesion modulate it. A household of four on two tablets has ratio 2, which ramps to 0, so no
     * amount of size or cohesion can carry it over the reporting threshold.
     */
    const ratioScore = ratio === null ? 0 : ramp(ratio, config.householdRatio, config.farmRatio);
    const sizeScore = ramp(group.length, config.minSize, 30);
    const burstScore = ramp(burst, 3, 10);
    const score = Math.round(100 * (0.55 * ratioScore + 0.2 * sizeScore + 0.15 * cohesion + 0.1 * burstScore));

    if (score < config.minScore) continue;

    const members = group.map((g) => g.id).sort();
    out.push({
      signature: clusterSignature(members),
      members, size: members.length,
      devices: devices.size, networks: networks.size,
      identitiesPerDevice: ratio === null ? null : Math.round(ratio * 100) / 100,
      cohesion: Math.round(cohesion * 1000) / 1000,
      burst, score,
      signals: [...kinds].sort(),
      evidence: {
        identitiesPerDevice: ratio === null ? null : Math.round(ratio * 100) / 100,
        householdRatio: config.householdRatio,
        farmRatio: config.farmRatio,
        cohesion: Math.round(cohesion * 1000) / 1000,
        burstWithinWindow: burst,
        burstWindowMinutes: config.burstWindowMinutes,
        note: "Signals shared by more than " + config.maxIdentitiesPerSignal +
          " identities were ignored as infrastructure rather than treated as links.",
      },
    });
  }

  // strongest first, then by signature so the order is stable
  return out.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.signature.localeCompare(b.signature)));
}
