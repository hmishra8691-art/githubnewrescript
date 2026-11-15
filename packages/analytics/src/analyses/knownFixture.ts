import { SurveyDefinition } from "@rescript/schema";
import { buildDataset, type AnalyticsRow } from "../dataset.js";

/* a small survey whose every expected value below is counted by hand */
export const kdef = SurveyDefinition.parse({
  meta: { id: "k", code: "K", title: "Known", version: "1.0" },
  questions: [
    { id: "q_gender", code: "Q6", variableName: "GENDER", type: "single_select", text: "Gender", options: [{ code: 1, label: "Male" }, { code: 2, label: "Female" }] },
    { id: "q_age", code: "Q5", variableName: "AGE", type: "numeric", text: "Age" },
    { id: "q_region", code: "Q7", variableName: "REGION", type: "single_select", text: "Region", options: [{ code: 1, label: "North" }, { code: 2, label: "South" }, { code: 3, label: "East" }] },
    { id: "q_nps", code: "Q15", variableName: "NPS", type: "nps", text: "How likely are you to recommend us?", settings: { minValue: 0, maxValue: 10 } },
    { id: "q_sat", code: "Q12", variableName: "SAT", type: "single_select", text: "Overall satisfaction", options: [1, 2, 3, 4, 5].map((c) => ({ code: c, label: `${c}` })).concat([{ code: 9, label: "Don't know" }]) },
    { id: "q_aware", code: "Q1", variableName: "AWARE", type: "multi_select", text: "Brand awareness", options: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }, { code: 3, label: "Gamma" }] },
  ],
  flow: [{ type: "page", id: "p", questionIds: ["q_gender", "q_age", "q_region", "q_nps", "q_sat", "q_aware"] }],
});

/* gender, age, region, nps, sat, aware — 12 respondents */
const RAW: [number, number | null, number, number | null, number | null, number[]][] = [
  [1, 19, 1, 10, 5, [1, 2]],
  [1, 23, 1, 9, 4, [1]],
  [1, 31, 2, 6, 2, [2]],
  [1, 45, 3, 3, 1, []],
  [1, 70, 2, 8, 3, [1, 3]],
  [1, 17, 1, 7, 9, [3]],      // age 17: under every default band
  [2, 28, 3, 10, 5, [1, 2, 3]],
  [2, 36, 3, 9, 5, [1]],
  [2, 52, 2, 10, 4, [2]],
  [2, 61, 1, 5, 2, []],
  [2, null, 2, null, null, [1]],
  [2, 40.5, 3, 8, 9, [2, 3]],  // 40.5: between integer bands 35–44 holds it; kept to test bounds
];
export const krows: AnalyticsRow[] = RAW.map(([g, a, r, n, s, aw], i) => ({
  id: `r${i}`, session_id: `s${i}`, respondent_code: `K${i}`, status: "complete", is_test: false,
  started_at: "2026-11-01T10:00:00Z", completed_at: "2026-11-01T10:10:00Z",
  answers: { q_gender: g, ...(a != null ? { q_age: a } : {}), q_region: r, ...(n != null ? { q_nps: n } : {}), ...(s != null ? { q_sat: s } : {}), q_aware: aw },
  calculated: {}, embedded: {}, flags: [],
}));
export const kds = () => buildDataset(kdef, krows, { spec: { environment: "LIVE", dataset: "all" } });
