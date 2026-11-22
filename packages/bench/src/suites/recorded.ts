import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assessSurvey, redTeamCorpus, type ResponseRecord, type ResponseTelemetry } from "@rescript/quality";
import { pct, type CaseResult, type Suite } from "../core.js";

/**
 * RECORDED AUTOMATION (roadmap F1b). Unlike the red-team corpus, nothing here is simulated: each response is the
 * telemetry the runtime's own collector produced while a real Chromium was driven by a script
 * (scripts/redteam-record.mjs). It is scored among the corpus's synthetic genuine respondents, twice:
 *
 *   as recorded      every session came from one machine, so they share one address and one device signature
 *   behaviour only   each is given its own address and device, as an attacker with proxies would have — what is
 *                    left is how the browser was driven
 *
 * There are no recorded PEOPLE, so this gives no false-positive rate; that still comes from synthetic respondents.
 */
interface Recorded { style: string; sessionId: string; answers: Record<string, unknown>; telemetry: ResponseTelemetry; userAgent?: string }
const FILE = (root: string) => join(root, "packages/quality/fixtures/recorded/automation-2026-11.json");
export const RECORDED_STYLES: Record<string, string> = {
  dom_script: "Answers set from page script (no real input events)", playwright_fast: "Scripted browser, as fast as it goes", playwright_stealth: "Scripted browser, automation flag hidden, short waits",
  agent_typed: "Agent mechanics: pointer moved, seconds per page, text typed at an even pace", agent_pasted: "Agent mechanics, text pasted", agent_slow_even: "Agent that reads at a person's pace and types with a fixed 180 ms delay", agent_patient: "Agent told to pass for a person: reading pace, varied typing, pauses",
};

export function recordedAutomation(root: string): Suite {
  return {
    id: "fraud.recorded_automation", area: "fraud", title: "Recorded automated browsers through the quality engine",
    run() {
      const file = FILE(root);
      if (!existsSync(file)) return { status: "blocked", reason: `no recording at ${file}. Start the runtime and run scripts/redteam-record.mjs.`, metrics: [], cases: [] };
      const rec = JSON.parse(readFileSync(file, "utf8")) as { responses: Recorded[]; recordedAt: string };
      const corpus = redTeamCorpus();
      const genuine = corpus.responses.filter((l) => l.label === "genuine").map((l) => l.response);
      const asRecord = (r: Recorded, own: boolean): ResponseRecord => ({
        sessionId: r.sessionId, status: "complete", answers: r.answers, telemetry: r.telemetry,
        startedAt: new Date(r.telemetry.startedAt).toISOString(), completedAt: new Date(r.telemetry.submittedAt ?? r.telemetry.startedAt).toISOString(),
        ipHash: own ? `rec-ip-${r.sessionId}` : "rec-ip-one-machine", deviceHash: own ? `rec-dev-${r.sessionId}` : "rec-dev-one-machine", userAgent: r.userAgent ?? null,
      });
      const score = (own: boolean) => {
        const res = assessSurvey(corpus.def, [...genuine, ...rec.responses.map((r) => asRecord(r, own))]);
        const by: Record<string, { n: number; detected: number; excluded: number; beyondText: number; rules: Record<string, number> }> = {};
        for (const r of rec.responses) {
          const a = res.bySession.get(r.sessionId);
          const b = (by[r.style] ??= { n: 0, detected: 0, excluded: 0, beyondText: 0, rules: {} });
          b.n++; if (a && a.verdict !== "PASS") b.detected++; if (a?.verdict === "FLAGGED") b.excluded++;
          /* the recorded text is canned, so the same sentences recur across sessions; a real model's would not. What fired besides that? */
          if ((a?.flags ?? []).some((f) => f.ruleId !== "openend.duplicate")) b.beyondText++;
          for (const f of a?.flags ?? []) b.rules[f.ruleId] = (b.rules[f.ruleId] ?? 0) + 1;
        }
        const gFlag = genuine.filter((g) => res.bySession.get(g.sessionId)?.verdict === "FLAGGED").length;
        return { by, gFlag };
      };
      const recorded = score(false), behaviour = score(true);
      const total = (x: ReturnType<typeof score>, k: "detected" | "excluded") => Object.values(x.by).reduce((s, b) => s + b[k], 0);
      const n = rec.responses.length;
      const cases: CaseResult[] = Object.entries(behaviour.by).map(([style, b]) => ({
        id: style, group: "behaviour only", pass: b.excluded === b.n,
        detail: `${RECORDED_STYLES[style] ?? style}: ${b.excluded} of ${b.n} excluded, ${b.beyondText} with evidence other than repeated text (as recorded: ${recorded.by[style]!.excluded} excluded). Fired: ${Object.entries(b.rules).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([r, c]) => `${r} ${c}`).join(", ") || "nothing"}`,
      }));
      const agents = Object.entries(behaviour.by).filter(([s]) => s.startsWith("agent"));
      const agentN = agents.reduce((s, [, b]) => s + b.n, 0);
      return {
        status: "measured",
        caveat: `${n} sessions recorded on ${rec.recordedAt.slice(0, 10)} from headless Chromium on one server, scripted by the same author as the benchmark. No person was recorded, no real desktop or phone, and no language model: the agent styles reproduce how an agent drives a browser, with canned text. The typing rules were written in the same sitting as the recordings they catch, from what is known about how people type; they have never been run on a recording of people.`,
        metrics: [
          { id: "excluded_behaviour", label: "Automated sessions excluded on behaviour alone (own address and device each)", value: pct(total(behaviour, "excluded"), n), unit: "%", better: "higher", target: 95 },
          { id: "detected_beyond_text", label: "Automated sessions with any evidence other than repeated (canned) text", value: pct(Object.values(behaviour.by).reduce((s, b) => s + b.beyondText, 0), n), unit: "%", better: "higher", target: 95 },
          { id: "patient_excluded", label: "The agent paced like a person: excluded", value: pct(behaviour.by.agent_patient?.excluded ?? 0, behaviour.by.agent_patient?.n ?? 0), unit: "%", better: "higher", target: 90, note: "its only flag is repeated canned text, which a real model would not repeat" },
          { id: "agents_excluded", label: "Agent-style sessions excluded on behaviour alone", value: pct(agents.reduce((s, [, b]) => s + b.excluded, 0), agentN), unit: "%", better: "higher", target: 90 },
          { id: "excluded_recorded", label: "Excluded as recorded (one address, one device)", value: pct(total(recorded, "excluded"), n), unit: "%", better: "higher", target: 95 },
          { id: "genuine_flagged", label: "Synthetic genuine respondents excluded alongside them", value: pct(behaviour.gFlag, genuine.length), unit: "%", better: "lower", target: 1, tolerance: 0.5 },
          { id: "sessions", label: "Recorded sessions", value: n, unit: "count", better: "higher", target: 200, informational: true },
        ],
        cases,
      };
    },
  };
}
