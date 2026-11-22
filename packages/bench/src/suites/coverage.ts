import { applySurveyActions, type SurveyAction } from "@rescript/engine";
import { validationSurvey } from "@rescript/quality";
import { buildAdvB2bSurvey, buildAdvSegmentationSurvey, buildBrandFunnelSurvey, coverSurvey } from "@rescript/templates";
import { pct, type CaseResult, type Suite } from "../core.js";

/**
 * PATH COVERAGE ON SHIPPED SURVEYS (roadmap P2: "100% of reachable branches"). Four surveys, simulated respondents
 * through the real engine. A goal not met is either unreachable or needs answers the generator never drew; this
 * does not tell them apart, which is why every unmet goal is listed with its reason.
 */
export const pathCoverage: Suite = {
  id: "programming.path_coverage", area: "programming", title: "Path coverage on shipped surveys",
  run() {
    const withLogic = applySurveyActions(validationSurvey(), [{ op: "set_display_logic", target: "Q4", expression: "Q2 = Daily" }, { op: "add_skip", from: "S1", when: "S1 = No", to: "screened" }] as unknown as SurveyAction[]).def;
    const surveys = [["Benchmark survey with a condition and a screen-out", withLogic], ["Brand funnel template", buildBrandFunnelSurvey()], ["Segmentation template", buildAdvSegmentationSurvey()], ["B2B template", buildAdvB2bSurvey()]] as const;
    const cases: CaseResult[] = [];
    let goals = 0, met = 0, scripts = 0, ms = 0;
    for (const [name, def] of surveys) {
      const t = performance.now();
      const r = coverSurvey(def, { seed: 7 });
      ms += performance.now() - t;
      goals += r.goals.length; met += r.met.length; scripts += r.script.length;
      cases.push({ id: name, pass: r.unmet.length === 0, detail: `${r.met.length} of ${r.goals.length} goals met by a script of ${r.script.length}${r.unmet.length ? `; not met: ${r.unmet.slice(0, 3).map((u) => `${u.goal.label} (${u.why.split(". ").slice(-2).join(". ").slice(0, 140)})`).join("; ")}` : ""}` });
    }
    return {
      status: "measured",
      caveat: "four surveys of 6 to 17 questions. A goal not met may be unreachable (a real finding about the survey) or need an answer combination the generator never drew; the benchmark counts both as not met. The 160-question demo survey takes over a minute and is left out.",
      metrics: [
        { id: "goals_met", label: "Coverage goals met (pages, both sides of conditions, branches, skips, endings, quota cells)", value: pct(met, goals), unit: "%", better: "higher", target: 100, tolerance: 2 },
        { id: "script_size", label: "Test respondents in the smallest covering scripts, all four surveys", value: scripts, unit: "count", better: "lower", target: 40, informational: true },
        { id: "cover_ms", label: "Time to cover one small survey", value: Math.round(ms / surveys.length), unit: "ms", better: "lower", target: 30000, machineDependent: true },
      ],
      cases,
    };
  },
};
