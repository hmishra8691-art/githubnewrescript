import type { FlagDraft, RuleContext, ResponseTelemetry } from "../types.js";
import { fnv1a, pct } from "../metrics.js";
import { isOpen, screenerQuestionIds } from "../survey.js";

/**
 * Interaction, navigation, device, network, screener and history rules — the
 * behavioural side, all reading telemetry or the hashed identifiers.
 */

/** "p1>p2>p3<p2>p3>" — pages in order with the direction that reached them. */
export function navigationFingerprint(t: ResponseTelemetry | null): string | null {
  if (!t || !t.pages.length) return null;
  const seq = [...t.pages].sort((a, b) => a.enteredAt - b.enteredAt)
    .map((v) => `${v.pageId}${v.via === "back" ? "<" : v.via === "reload" ? "~" : v.via === "jump" ? "^" : ">"}`);
  return fnv1a(seq.join(""));
}

export function behaviourRules(ctx: RuleContext): FlagDraft[] {
  const out: FlagDraft[] = [];
  const t = ctx.telemetry;
  const { def } = ctx;
  const others = ctx.peers.filter((p) => p.sessionId !== ctx.response.sessionId);
  const completes = others.filter((p) => p.status === "complete");

  /* -------------------------------------------------------- clipboard */
  if (t && !ctx.disabledTelemetry.has("clipboard")) {
    const textQs = def.questions.filter((q) => isOpen(q) && ctx.response.answers[q.id] !== undefined && String(ctx.response.answers[q.id]).trim());
    if (ctx.enabled("interaction.paste_ratio") && textQs.length) {
      const ratio = ctx.param<number>("interaction.paste_ratio", "ratio");
      const minPastes = ctx.param<number>("interaction.paste_ratio", "minPastes");
      const pasted = textQs.filter((q) => (t.questions[q.id]?.pastes ?? 0) > 0);
      if (t.clipboard.pastes >= minPastes && pasted.length / textQs.length >= ratio) {
        out.push({
          ruleId: "interaction.paste_ratio",
          observed: `${pasted.length} of ${textQs.length} text answers involved a paste (${t.clipboard.pastes} pastes, ${t.clipboard.pasteChars} characters)`,
          expected: `< ${pct(ratio)} of text answers`,
          explanation: "Text answers were filled mostly by pasting rather than typing.",
          questionIds: pasted.map((q) => q.id),
        });
      }
    }
    if (ctx.enabled("interaction.rapid_paste_submit") && t.clipboard.pastes > 0) {
      const within = ctx.param<number>("interaction.rapid_paste_submit", "withinMs");
      const hits = t.pages.filter((v) => v.leftAt !== undefined && v.questionIds.some((qid) => {
        const qt = t.questions[qid];
        return qt && qt.pastes > 0 && qt.lastChangeAt !== undefined && v.leftAt! - qt.lastChangeAt <= within && qt.lastChangeAt >= v.enteredAt;
      }));
      if (hits.length) {
        out.push({
          ruleId: "interaction.rapid_paste_submit",
          observed: `${hits.length} page${hits.length === 1 ? "" : "s"} submitted within ${within} ms of a paste`,
          explanation: "A paste was followed almost immediately by Next — no reading back.",
          questionIds: hits.flatMap((v) => v.questionIds),
        });
      }
    }
  }

  /* ------------------------------------------------------------ focus */
  if (t && !ctx.disabledTelemetry.has("focus") && ctx.enabled("interaction.out_of_focus") && t.submittedAt) {
    const total = t.submittedAt - t.startedAt;
    const share = ctx.param<number>("interaction.out_of_focus", "share");
    if (total > 60_000 && t.focus.totalOutOfFocusMs / total > share) {
      out.push({
        ruleId: "interaction.out_of_focus",
        observed: `${pct(t.focus.totalOutOfFocusMs / total)} of the session out of focus (${t.focus.blurs} tab switches)`,
        expected: `< ${pct(share)}`,
        explanation: "The survey tab was hidden for most of the session.",
      });
    }
  }

  /* ------------------------------------------------------- navigation */
  if (t && !ctx.disabledTelemetry.has("navigation")) {
    if (ctx.enabled("navigation.cycling")) {
      const backs = ctx.param<number>("navigation.cycling", "backs");
      const within = ctx.param<number>("navigation.cycling", "withinSec") * 1000;
      const visits = [...t.pages].sort((a, b) => a.enteredAt - b.enteredAt);
      let rapid = 0;
      for (let i = 1; i < visits.length; i++) {
        if (visits[i].via === "back" && visits[i].enteredAt - visits[i - 1].enteredAt <= within) rapid++;
      }
      if (rapid > backs) {
        out.push({
          ruleId: "navigation.cycling",
          observed: `${rapid} rapid back moves (each within ${within / 1000}s of the previous move), ${t.navigation.back} back moves in total`,
          expected: `≤ ${backs}`,
          explanation: "Many quick back-and-forth moves — consistent with probing the logic or hunting for a qualifying path.",
        });
      }
    }
    if (ctx.enabled("navigation.reloads")) {
      const n = ctx.param<number>("navigation.reloads", "count");
      if (t.navigation.reloads > n) {
        out.push({ ruleId: "navigation.reloads", observed: `${t.navigation.reloads} page reloads`, expected: `≤ ${n}`, explanation: "The survey page was reloaded repeatedly during the session." });
      }
    }
    if (ctx.enabled("navigation.fingerprint_match") && completes.length) {
      const minBacks = ctx.param<number>("navigation.fingerprint_match", "minBacks");
      const fp = navigationFingerprint(t);
      const hasBranching = (def.flow as any[]).some((n) => n?.type === "branch" || n?.type === "randomizer") || def.questions.some((q) => q.skipLogic?.length || q.displayLogic);
      if (fp && t.navigation.back >= minBacks && hasBranching) {
        const same = completes.filter((p) => p.system?.SYSTEM_NAV_FINGERPRINT === fp).map((p) => p.sessionId);
        if (same.length) {
          out.push({
            ruleId: "navigation.fingerprint_match",
            observed: `identical page sequence (including ${t.navigation.back} back moves) to ${same.length} other respondent${same.length === 1 ? "" : "s"}`,
            explanation: "Exactly the same navigation path, back moves included, as another respondent on a branching survey.",
            relatedSessionIds: same.slice(0, 10),
          });
        }
      }
    }
  }

  /* ----------------------------------------------------------- device */
  const dev = t?.device;
  if (!ctx.disabledTelemetry.has("device")) {
    if (ctx.enabled("device.webdriver") && dev?.webdriver) {
      out.push({ ruleId: "device.webdriver", observed: "navigator.webdriver = true", explanation: "The browser reports that it is being driven by automation software." });
    }
    if (ctx.enabled("device.duplicate") && ctx.response.deviceHash && completes.length) {
      const n = ctx.param<number>("device.duplicate", "count");
      const same = completes.filter((p) => p.deviceHash && p.deviceHash === ctx.response.deviceHash).map((p) => p.sessionId);
      if (same.length >= n) {
        out.push({
          ruleId: "device.duplicate",
          observed: `${same.length} other complete response${same.length === 1 ? "" : "s"} share this device signature`,
          expected: `< ${n}`,
          explanation: "The same browser family, platform, screen, timezone and language produced other responses — the same device, or the same automated setup.",
          relatedSessionIds: same.slice(0, 10),
          intensity: Math.min(1, 0.5 + same.length * 0.15),
        });
      }
    }
    if (ctx.enabled("device.locale_timezone") && dev) {
      const prefix = String(ctx.param<string>("device.locale_timezone", "expectedTimezonePrefix") ?? "");
      if (prefix && dev.timezone && !dev.timezone.startsWith(prefix)) {
        out.push({ ruleId: "device.locale_timezone", observed: `timezone ${dev.timezone}, language ${dev.language}`, expected: `timezone in ${prefix}…`, explanation: "The browser's timezone is outside the region this survey expects." });
      }
    }
  }

  /* ---------------------------------------------------------- network */
  if (!ctx.disabledTelemetry.has("network")) {
    const ip = ctx.response.ipHash;
    if (ip && completes.length) {
      const same = completes.filter((p) => p.ipHash === ip).map((p) => p.sessionId);
      if (ctx.enabled("network.duplicate_ip")) {
        const n = ctx.param<number>("network.duplicate_ip", "count");
        if (same.length >= n) {
          out.push({
            ruleId: "network.duplicate_ip",
            observed: `${same.length} other complete response${same.length === 1 ? "" : "s"} from the same IP address`,
            expected: `< ${n}`,
            explanation: "Other responses came from the same network address. Households, offices and mobile carriers share addresses — a signal, not a verdict.",
            relatedSessionIds: same.slice(0, 10),
            intensity: Math.min(1, 0.4 + same.length * 0.1),
          });
        }
      }
      if (ctx.enabled("network.ip_density")) {
        const share = ctx.param<number>("network.ip_density", "share");
        const minCount = ctx.param<number>("network.ip_density", "minCount");
        const total = completes.length + 1;
        if (same.length + 1 >= minCount && (same.length + 1) / total >= share) {
          out.push({
            ruleId: "network.ip_density",
            observed: `${same.length + 1} of ${total} completes (${pct((same.length + 1) / total)}) from one IP`,
            expected: `< ${pct(share)}`,
            explanation: "A single network address accounts for an unusual share of all completes.",
            relatedSessionIds: same.slice(0, 10),
          });
        }
      }
    }
    if (ctx.enabled("network.risk_provider")) {
      const risk = (ctx.response.calculated as any)?.SYSTEM_NETWORK_RISK;
      const min = ctx.param<number>("network.risk_provider", "minRisk");
      if (typeof risk === "number" && risk >= min) {
        out.push({ ruleId: "network.risk_provider", observed: `network risk ${risk}/100 from the provider`, expected: `< ${min}`, explanation: "The configured network-intelligence provider rates this connection as a VPN, proxy or datacenter address.", intensity: Math.min(1, risk / 100) });
      }
    }
  }

  /* -------------------------------------------------------------- bot */
  if (t && !ctx.disabledTelemetry.has("interaction") && ctx.enabled("bot.no_interaction")) {
    const share = ctx.param<number>("bot.no_interaction", "share");
    const answered = t.pages.filter((v) => v.questionIds.some((q) => ctx.response.answers[q] !== undefined && ctx.response.answers[q] !== null));
    const dead = answered.filter((v) => v.pointerEvents + v.keyEvents + v.scrollEvents === 0);
    if (answered.length >= 3 && dead.length / answered.length >= share) {
      out.push({
        ruleId: "bot.no_interaction",
        observed: `${dead.length} of ${answered.length} answered pages with no pointer, key or scroll events`,
        expected: `< ${pct(share)}`,
        explanation: "Answers were recorded on pages without any human interaction events.",
        questionIds: dead.flatMap((v) => v.questionIds),
        intensity: Math.min(1, dead.length / answered.length),
      });
    }
  }

  /* --------------------------------------------------------- screener */
  const scr = screenerQuestionIds(def);
  if (scr.size && others.length) {
    const sibling = (p: typeof others[number]) =>
      (ctx.response.deviceHash && p.deviceHash === ctx.response.deviceHash) || (ctx.response.ipHash && p.ipHash === ctx.response.ipHash && ctx.response.deviceHash && p.deviceHash === ctx.response.deviceHash);
    const siblings = others.filter(sibling);
    if (ctx.enabled("screener.repeat_attempts") && ctx.response.status === "complete") {
      const n = ctx.param<number>("screener.repeat_attempts", "count");
      const before = new Date(ctx.response.startedAt ?? 0).getTime();
      const screened = siblings.filter((p) => (p.status === "screened" || p.status === "terminated") && new Date(p.startedAt ?? 0).getTime() <= before);
      if (screened.length >= n) {
        out.push({
          ruleId: "screener.repeat_attempts",
          observed: `${screened.length} earlier session${screened.length === 1 ? "" : "s"} from this device were screened out before this one qualified`,
          expected: `< ${n}`,
          explanation: "The same device tried the screener before, was screened out, and then qualified — consistent with changing answers to get in.",
          relatedSessionIds: screened.map((p) => p.sessionId).slice(0, 10),
          intensity: Math.min(1, 0.6 + screened.length * 0.2),
        });
      }
    }
    if (ctx.enabled("screener.inconsistent") && siblings.length) {
      const diffs: { qid: string; peer: string }[] = [];
      for (const p of siblings) {
        for (const qid of scr) {
          const mine = ctx.response.answers[qid], theirs = p.answers[qid];
          if (mine === undefined || theirs === undefined) continue;
          if (JSON.stringify(mine) !== JSON.stringify(theirs)) diffs.push({ qid, peer: p.sessionId });
        }
      }
      if (diffs.length) {
        out.push({
          ruleId: "screener.inconsistent",
          observed: `${new Set(diffs.map((d) => d.qid)).size} screening answer${diffs.length === 1 ? "" : "s"} differ from a sibling session on the same device`,
          explanation: "Demographic / screening answers changed between sessions from the same device.",
          questionIds: [...new Set(diffs.map((d) => d.qid))],
          relatedSessionIds: [...new Set(diffs.map((d) => d.peer))].slice(0, 10),
        });
      }
    }
  }

  /* ---------------------------------------------------------- history */
  if (ctx.enabled("history.poor_record") && ctx.history.length) {
    const n = ctx.param<number>("history.poor_record", "count");
    const bad = ctx.history.filter((h) => ["SUSPICIOUS", "HIGHLY_SUSPICIOUS", "CRITICAL"].includes(h.classification));
    if (bad.length >= n) {
      out.push({
        ruleId: "history.poor_record",
        observed: `${bad.length} of ${ctx.history.length} earlier studies classified this respondent SUSPICIOUS or worse`,
        expected: `< ${n}`,
        explanation: "This external respondent id has a record of poor-quality responses in earlier studies.",
        intensity: Math.min(1, 0.5 + bad.length * 0.15),
      });
    }
  }

  return out;
}
