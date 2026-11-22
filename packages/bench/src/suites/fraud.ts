import { ATTACKS, evaluateQuality, redTeamCorpus } from "@rescript/quality";
import { pct, type Suite } from "../core.js";

/**
 * FRAUD DEFENCE — the red-team corpus through the real quality engine (roadmap F1).
 * "Detected" = not PASS (it reaches a reviewer). "Excluded" = FLAGGED (what automatic removal would act on).
 */
export const fraudRedTeam: Suite = {
  id: "fraud.red_team", area: "fraud", title: "Red-team corpus through the quality engine",
  run() {
    const { def, responses } = redTeamCorpus();
    const t = Date.now();
    const r = evaluateQuality(def, responses);
    const ms = Date.now() - t;
    const attacks = ATTACKS.map((a) => ({ ...a, ...r.byPersona[a.id]! }));
    const n = attacks.reduce((s, a) => s + a.n, 0);
    const detected = attacks.reduce((s, a) => s + a.n - a.PASS, 0), excluded = attacks.reduce((s, a) => s + a.FLAGGED, 0);
    const llm = attacks.filter((a) => a.id.startsWith("llm_agent"));
    const llmN = llm.reduce((s, a) => s + a.n, 0), llmDetected = llm.reduce((s, a) => s + a.n - a.PASS, 0);
    return {
      status: "measured",
      caveat: "the attacks are simulated from a description of how each behaves, not recorded from real attackers, and the people are synthetic. No device or network signal exists yet, so nothing here tests one.",
      metrics: [
        { id: "detected", label: "Attacks detected (sent to review or excluded)", value: pct(detected, n), unit: "%", better: "higher", target: 95 },
        { id: "excluded", label: "Attacks excluded outright", value: pct(excluded, n), unit: "%", better: "higher", target: 95, note: "the roadmap's threshold is on detection; this is the stricter reading" },
        { id: "llm_detected", label: "Language-model agents detected", value: pct(llmDetected, llmN), unit: "%", better: "higher", target: 90 },
        { id: "genuine_flagged", label: "Real people wrongly excluded", value: pct(r.flagged.genuineFalsePositive.hits, r.flagged.genuineFalsePositive.n), unit: "%", better: "lower", target: 1, tolerance: 0.5 },
        { id: "genuine_reviewed", label: "Real people sent to review", value: pct(r.detected.genuineFalsePositive.hits, r.detected.genuineFalsePositive.n), unit: "%", better: "lower", target: 5, tolerance: 1 },
        { id: "per_response_ms", label: "Scoring time per response", value: Math.round((ms / responses.length) * 10) / 10, unit: "ms", better: "lower", target: 150, machineDependent: true, note: "after the fact; the roadmap's 150 ms is for the entry decision" },
      ],
      cases: attacks.map((a) => ({ id: a.id, group: "attack", pass: a.PASS === 0, detail: `${a.name}: ${a.n - a.PASS} of ${a.n} detected, ${a.FLAGGED} excluded` })),
    };
  },
};
