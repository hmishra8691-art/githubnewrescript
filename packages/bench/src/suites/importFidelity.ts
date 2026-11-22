import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { analyzeImport, runScenarios } from "@rescript/import";
import { pct, type CaseResult, type Suite } from "../core.js";

/**
 * IMPORT FIDELITY — every corpus file through the real import pipeline (roadmap I1).
 *
 * The score is the importer's own inventory: of the items it DETECTED in the source (questions, logic, loops,
 * quotas, piping …), how many it imported whole, in part, or not at all. A partial counts as half. That is an
 * honest measure of what it knows it could not convert and a blind one for what it never noticed, which is why the
 * roadmap asks for files with the expected behaviour written down. Until those exist this is a floor on the gap,
 * not the gap.
 */
const CORPUS = (root: string) => join(root, "packages/import/fixtures/corpus");

export function importFidelity(root: string): Suite {
  return {
    id: "import.fidelity", area: "import", title: "Import fidelity on the corpus",
    async run() {
      const dir = CORPUS(root);
      if (!existsSync(dir)) return { status: "blocked", reason: `the corpus is not at ${dir}`, metrics: [], cases: [] };
      const files = readdirSync(dir).flatMap((platform) => readdirSync(join(dir, platform)).map((f) => ({ platform, f, path: join(dir, platform, f) }))).sort((a, b) => a.path.localeCompare(b.path));
      const byFeature = new Map<string, { label: string; detected: number; imported: number; partial: number; unsupported: number }>();
      const cases: CaseResult[] = [];
      let scenarios = 0, passed = 0, failed = 0, notRun = 0, unread = 0, ms = 0, deployable = 0;
      for (const file of files) {
        const t = Date.now();
        const a = await analyzeImport(new Uint8Array(readFileSync(file.path)), file.f, { surveyId: "bench" });
        ms += Date.now() - t;
        if (!a.report || !a.canonical || !a.result) { cases.push({ id: `${file.platform}/${file.f}`, group: file.platform, pass: false, detail: "could not be read" }); continue; }
        const fid = a.report.fidelity;
        for (const x of fid.features) {
          const at = byFeature.get(x.feature) ?? { label: x.label, detected: 0, imported: 0, partial: 0, unsupported: 0 };
          at.detected += x.detected; at.imported += x.imported; at.partial += x.partial; at.unsupported += x.unsupported;
          byFeature.set(x.feature, at);
        }
        /* no time limit to speak of: a benchmark that stops at a clock gives a different number on every run (the product itself allows 8 seconds per file and reports the rest as not run) */
        const beh = runScenarios(a.canonical, a.result, { max: 300, budgetMs: 600_000 });
        scenarios += beh.scenarios.length; passed += beh.passed; failed += beh.failed; notRun += beh.notRun;
        unread += fid.unresolved.length;
        /* the engine's own publish check: no error means the survey could be published as imported */
        if (a.result.def && (a.result.quality?.errors.length ?? 1) === 0) deployable++;
        const whole = fid.totals.detected ? (fid.totals.imported + fid.totals.partial / 2) / fid.totals.detected : 1;
        cases.push({ id: `${file.platform}/${file.f}`, group: file.platform, pass: whole >= 0.98 && beh.failed === 0, detail: `${Math.round(whole * 1000) / 10}% of ${fid.totals.detected} items; ${beh.passed}/${beh.passed + beh.failed} behaviours` });
      }
      const tot = [...byFeature.values()].reduce((s, x) => ({ detected: s.detected + x.detected, imported: s.imported + x.imported, partial: s.partial + x.partial }), { detected: 0, imported: 0, partial: 0 });
      const score = (x: { detected: number; imported: number; partial: number }) => (x.detected ? Math.round(((x.imported + x.partial / 2) / x.detected) * 1000) / 10 : 100);
      /* a class with a handful of items swings wildly: the weakest class is taken among those with at least 5 items */
      const classes = [...byFeature.entries()].filter(([, x]) => x.detected >= 5).map(([id, x]) => ({ id, label: x.label, n: x.detected, score: score(x) })).sort((a, b) => a.score - b.score);
      for (const c of classes) cases.push({ id: `class:${c.id}`, group: "construct class", pass: c.score >= 95, detail: `${c.label}: ${c.score}% of ${c.n}` });
      return {
        status: "measured",
        caveat: "fidelity is counted over what the importer detected, so a construct it never noticed is not in the denominator. The corpus is ten files (five Qualtrics, five Decipher), not the 300 the roadmap sets, and has no Word, PDF or Excel sources.",
        metrics: [
          { id: "fidelity", label: "Items imported, a partial counting half", value: score(tot), unit: "%", better: "higher", target: 98 },
          { id: "weakest_class", label: `Weakest construct class${classes[0] ? ` (${classes[0].label})` : ""}`, value: classes[0]?.score ?? 100, unit: "%", better: "higher", target: 95 },
          { id: "behaviour", label: "Behaviour scenarios identical to the source", value: pct(passed, passed + failed), unit: "%", better: "higher", target: 99, note: `${scenarios} built, ${notRun} not run` },
          { id: "deployable", label: "Files importing to a survey that passes the publish check", value: pct(deployable, files.length), unit: "%", better: "higher", target: 100 },
          { id: "unresolved", label: "References the importer could not resolve", value: unread, unit: "count", better: "lower", target: 0, tolerance: 0 },
          { id: "ms_per_file", label: "Import time per file", value: files.length ? Math.round(ms / files.length) : 0, unit: "ms", better: "lower", target: 120000, machineDependent: true },
          { id: "files", label: "Files in the corpus", value: files.length, unit: "count", better: "higher", target: 300, tolerance: 0 },
        ],
        cases,
      };
    },
  };
}
