import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SurveyDefinition } from "@rescript/schema";
import { fromSource, toSource } from "@rescript/engine";
import { analyzeImport } from "@rescript/import";
import { validationSurvey } from "@rescript/quality";
import * as templates from "@rescript/templates";
import { largeSurvey } from "./perf.js";
import { pct, type CaseResult, type Suite } from "../core.js";

/**
 * THE SURVEY SOURCE FORMAT ROUND TRIP (roadmap P3: "Source format round trip on the full fixture set — no difference").
 * Every shipped template, the benchmark survey, the 501-question survey, and the ten imported corpus surveys: written
 * as source, read back, compared with the original field for field.
 */
export function sourceRoundTrip(root: string): Suite {
  return {
    id: "programming.source_round_trip", area: "programming", title: "Survey source format round trip on every fixture",
    async run() {
      const fixtures: [string, SurveyDefinition][] = [["benchmark survey", validationSurvey()], ["501-question survey", largeSurvey()]];
      for (const [k, b] of Object.entries(templates)) if (/^build.*Survey$/.test(k) && typeof b === "function") { try { fixtures.push([k, (b as () => SurveyDefinition)()]); } catch { /* a builder that needs arguments */ } }
      const dir = join(root, "packages/import/fixtures/corpus");
      if (existsSync(dir)) for (const p of readdirSync(dir)) for (const f of readdirSync(join(dir, p))) {
        const a = await analyzeImport(new Uint8Array(readFileSync(join(dir, p, f))), f, { surveyId: "bench" });
        if (a.result?.def) fixtures.push([`imported ${p}/${f}`, a.result.def]);
      }
      const cases: CaseResult[] = [];
      let same = 0, text = 0, json = 0, lines = 0;
      for (const [name, def] of fixtures) {
        let pass = false, detail = "";
        try {
          const src = toSource(def);
          lines += src.split("\n").length;
          text += (src.match(/ if (?!json )/g) ?? []).length; json += (src.match(/ if json /g) ?? []).length;
          const back = fromSource(src);
          pass = !!back.def && JSON.stringify(back.def) === JSON.stringify(SurveyDefinition.parse(def));
          detail = back.def ? (pass ? `${src.split("\n").length} lines, identical` : "read back, but different") : `did not read back: ${back.problems[0]?.message}`;
        } catch (e) { detail = `failed: ${(e as Error).message}`; }
        if (pass) same++;
        cases.push({ id: name, pass, detail });
      }
      return {
        status: "measured",
        caveat: "identity is checked after the schema's own normalisation, which is what the product stores. Readability is not measured; conditions that would not read back identically are written as JSON, and their share is reported.",
        metrics: [
          { id: "identical", label: `Fixtures identical after a round trip (${fixtures.length})`, value: pct(same, fixtures.length), unit: "%", better: "higher", target: 100, tolerance: 0 },
          { id: "conditions_as_text", label: "Conditions written as readable expressions rather than JSON", value: pct(text, text + json), unit: "%", better: "higher", target: 95, tolerance: 1 },
          { id: "lines", label: "Lines of source, all fixtures", value: lines, unit: "count", better: "lower", target: 0, informational: true },
        ],
        cases,
      };
    },
  };
}
