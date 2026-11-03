import type { QualityConfig, Strictness } from "@rescript/schema";

/** The catalogue's defaults are keyed by the four named levels; "custom" means "the researcher set it", so the
 *  named default to fall back on is the standard one. */
type Level = Exclude<Strictness, "custom">;
const levelOf = (s: Strictness | undefined): Level => (s && s !== "custom" ? s : "standard");
import type { FlagDraft, QualityFlag } from "./types.js";
import { finalizeFlags, riskScore } from "./score.js";
import { RULE_BY_ID } from "./catalogue.js";

/**
 * ADMISSION SCORING (0084) — the fraud question asked BEFORE a respondent enters.
 *
 * `packages/quality` already scores a FINISHED response against its peers in one survey, with fifty-odd rules
 * and a worked-out combination of evidence. None of that is available at the door: there are no answers, no
 * timings, no peers, and roughly 120 milliseconds to decide. What IS available is the network they arrived on,
 * the device they arrived with, and what this identity has done in earlier projects.
 *
 * So this is not a second engine. It emits `FlagDraft`s with rule ids from the SAME catalogue, runs them
 * through the SAME `finalizeFlags`, and combines them with the SAME `riskScore` — which already folds network
 * and device into one fact, because the same machine on the same connection is one piece of evidence and not
 * two. A reviewer reading a quarantined participation sees the vocabulary they already know.
 *
 * ## What this is not allowed to do
 *
 * It cannot refuse anybody. The highest score it can produce quarantines a participation for review and holds
 * the complete from being billed; a human decides. That is a deliberate limit, not an oversight: the
 * false-positive rate of these signals on this platform's real traffic has not been measured yet, and every
 * false positive is a real person losing a paid piece of work. Shared IP addresses in particular are the
 * brief's own §17 warning — a phone carrier's NAT puts thousands of unrelated people on one address.
 *
 * ## The ceiling
 *
 * Every rule here firing at once, at maximum intensity, reaches 74 — one point below the brief's `critical`
 * band. That is a property worth stating rather than discovering: **the critical band is not reachable before
 * entry.** It is reserved for evidence this layer does not have, namely the respondent's actual answers,
 * timings and peers, which `packages/quality`'s post-hoc rules score after the interview. Circumstantial
 * evidence about a network and a device, however much of it there is, does not amount to certainty about a
 * person. `admission.test.ts` pins the ceiling, so a future change to the weights that pushed it past 75 fails
 * loudly rather than quietly making the strongest pre-entry outcome indistinguishable from a proven fraud.
 */

/** What the gateway can actually observe before anybody answers anything. */
export interface AdmissionSignals {
  network?: {
    /** a hosting provider, anonymising proxy or Tor exit — not a consumer connection */
    datacenter?: boolean;
    tor?: boolean;
    /** a commercial VPN. Counted only at strict settings: plenty of ordinary people use one. */
    vpn?: boolean;
    /** distinct respondent identities seen on this network, across this organisation's projects */
    identities?: number;
    /** 0–100 from a configured network-intelligence provider, when one exists */
    providerRisk?: number | null;
  };
  device?: {
    /** distinct respondent identities seen on this device signature */
    identities?: number;
    /** navigator.webdriver, or an equivalent automation tell the runner reported */
    automation?: boolean;
  };
  /** what this identity has done in earlier projects for this organisation */
  history?: {
    participations?: number;
    rejections?: number;
    duplicates?: number;
  };
}

export type RiskBand = "low" | "moderate" | "high" | "critical";

/**
 * The brief's §20 bands. They are thresholds on the SAME 0–100 scale `riskScore` already produces, so a
 * quarantined arrival and a suspicious completed response are measured the same way.
 */
export function riskBand(score: number): RiskBand {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "moderate";
  return "low";
}

export interface AdmissionRisk {
  score: number;
  band: RiskBand;
  flags: QualityFlag[];
  /** rule ids, for a machine; the flags carry the sentences for a person */
  reasons: string[];
  /** true when the band says a human should look before this complete is paid for */
  quarantine: boolean;
}

function param(config: QualityConfig, ruleId: string, key: string, fallback: number): number {
  const set = config.rules?.[ruleId]?.params?.[key];
  if (typeof set === "number" && Number.isFinite(set)) return set;
  const def = RULE_BY_ID[ruleId]?.params.find((p) => p.key === key);
  const byLevel = def?.defaults?.[levelOf(config.strictness)];
  return typeof byLevel === "number" ? byLevel : fallback;
}

function enabled(config: QualityConfig, ruleId: string): boolean {
  const set = config.rules?.[ruleId]?.enabled;
  if (set === false) return false;
  const def = RULE_BY_ID[ruleId];
  return def ? def.enabledIn[levelOf(config.strictness)] !== false : true;
}

/**
 * The drafts for one arrival.
 *
 * Every rule that fires says what it SAW, in a sentence a reviewer can repeat to a vendor whose respondent was
 * held. "Eleven identities from this network" is a fact; "suspicious" is not, and never appears.
 */
export function admissionFlags(signals: AdmissionSignals, config: QualityConfig): FlagDraft[] {
  const out: FlagDraft[] = [];
  const net = signals.network ?? {};
  const dev = signals.device ?? {};
  const hist = signals.history ?? {};

  if (enabled(config, "network.datacenter")) {
    const includeVpn = param(config, "network.datacenter", "includeVpn", 0) >= 1;
    const hit = net.tor ? "a Tor exit node" : net.datacenter ? "a datacenter or hosting provider" : (includeVpn && net.vpn) ? "a commercial VPN" : null;
    if (hit) {
      out.push({
        ruleId: "network.datacenter",
        explanation: `The respondent arrived over ${hit} rather than a consumer connection.`,
        observed: hit,
        // Tor is a far stronger signal than a VPN somebody uses for everything
        intensity: net.tor ? 1 : net.datacenter ? 0.8 : 0.4,
        ...(net.tor ? {} : { caveat: "Ordinary respondents do use VPNs; this is evidence, not a verdict." }),
      });
    }
  }

  if (enabled(config, "network.identity_density") && typeof net.identities === "number") {
    const threshold = param(config, "network.identity_density", "count", 12);
    if (net.identities > threshold) {
      out.push({
        ruleId: "network.identity_density",
        explanation: `${net.identities} distinct respondent identities have arrived from this network.`,
        observed: `${net.identities} identities`,
        expected: `at most ${threshold}`,
        // graded, and capped: 40 identities is worse than 13, but not four times worse
        intensity: Math.min(1, (net.identities - threshold) / (threshold * 2)),
        caveat: "A household, an office or a mobile carrier's shared address produces this legitimately.",
      });
    }
  }

  if (enabled(config, "device.identity_density") && typeof dev.identities === "number") {
    const threshold = param(config, "device.identity_density", "count", 5);
    if (dev.identities > threshold) {
      out.push({
        ruleId: "device.identity_density",
        explanation: `${dev.identities} distinct respondent identities have arrived from this device.`,
        observed: `${dev.identities} identities`,
        expected: `at most ${threshold}`,
        intensity: Math.min(1, (dev.identities - threshold) / (threshold * 2)),
        caveat: "A shared family device does this too, at a smaller scale.",
      });
    }
  }

  if (enabled(config, "device.webdriver") && dev.automation) {
    out.push({
      ruleId: "device.webdriver",
      explanation: "The browser reports that it is being driven by automation.",
      observed: "navigator.webdriver",
    });
  }

  if (enabled(config, "network.risk_provider") && typeof net.providerRisk === "number") {
    const min = param(config, "network.risk_provider", "minRisk", 75);
    if (net.providerRisk >= min) {
      out.push({
        ruleId: "network.risk_provider",
        explanation: `The configured network-intelligence provider rates this address ${net.providerRisk}/100 for risk.`,
        observed: `provider risk ${net.providerRisk}`,
        expected: `below ${min}`,
        intensity: Math.min(1, (net.providerRisk - min) / Math.max(100 - min, 1)),
      });
    }
  }

  if (enabled(config, "history.refused_elsewhere")) {
    const maxRejections = param(config, "history.refused_elsewhere", "rejections", 2);
    const maxDuplicates = param(config, "history.refused_elsewhere", "duplicates", 4);
    const rejections = hist.rejections ?? 0;
    const duplicates = hist.duplicates ?? 0;
    if (rejections > maxRejections || duplicates > maxDuplicates) {
      const bits: string[] = [];
      if (rejections > maxRejections) bits.push(`${rejections} rejected completes`);
      if (duplicates > maxDuplicates) bits.push(`${duplicates} duplicate attempts`);
      out.push({
        ruleId: "history.refused_elsewhere",
        explanation: `This identity has ${bits.join(" and ")} in earlier projects.`,
        observed: bits.join(", "),
        /*
         * Confidence rises with how much history there is. Three rejections out of four participations is a
         * pattern; three out of two hundred is a person having a bad run, and must not be scored the same.
         */
        confidence: Math.min(1, (hist.participations ?? rejections + duplicates) / 10),
        ...((hist.participations ?? 0) < 10
          ? { caveat: "Based on only a few prior participations." }
          : {}),
      });
    }
  }

  return out;
}

/** Score one arrival. Pure: the same signals always give the same score, which a reviewer can re-derive. */
export function admissionRisk(signals: AdmissionSignals, config: QualityConfig, now = new Date().toISOString()): AdmissionRisk {
  const flags = finalizeFlags(admissionFlags(signals, config), config, now);
  const score = riskScore(flags, config);
  const band = riskBand(score);
  return {
    score,
    band,
    flags,
    reasons: flags.map((f) => f.ruleId),
    // the brief's §20 would block at critical; this platform quarantines instead, and says so in the comment above
    quarantine: band === "high" || band === "critical",
  };
}
