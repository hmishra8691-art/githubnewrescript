import { ANALYSIS_KINDS } from "@rescript/analytics";
import { RULES } from "@rescript/quality";

/**
 * CATALOGS GENERATED FROM THE ENGINES (Developer Docs phase 4): every analysis Data Analytics offers (`ANALYSIS_KINDS`)
 * and every response-quality rule (`RULES`), drawn at render time from the packages that run them — a kind or a rule
 * added to the platform appears here the next time the page is opened, and one removed disappears.
 */
export function AnalysisCatalog() {
  const groups = [...new Set(ANALYSIS_KINDS.map((k) => k.group))];
  return (
    <div className="docs-catalog" data-testid="docs-analyses">
      <p className="docs-catalog-note">{ANALYSIS_KINDS.length} kinds of analysis in {groups.length} groups — generated from the analytics engine when this page is opened.</p>
      {groups.map((g) => (
        <section key={g}>
          <h3 id={`a-${g.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{g}</h3>
          <table>
            <thead><tr><th>Analysis</th><th>What it does</th></tr></thead>
            <tbody>{ANALYSIS_KINDS.filter((k) => k.group === g).map((k) => (
              <tr key={k.kind} data-testid={`docs-analysis-${k.kind}`}><td><b>{k.label}</b> <code>{k.kind}</code></td><td>{k.description}</td></tr>
            ))}</tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

const STRICT = ["relaxed", "standard", "strict", "very_strict"] as const;
const STRICT_LABEL: Record<(typeof STRICT)[number], string> = { relaxed: "Relaxed", standard: "Standard", strict: "Strict", very_strict: "Very strict" };
const CATEGORY_LABEL: Record<string, string> = {
  timing: "Timing", matrix: "Grids", consistency: "Consistency", pattern: "Answer patterns", attention: "Attention checks", open_end: "Open ends",
  interaction: "Interaction", navigation: "Navigation", device: "Device", network: "Network", bot: "Automation (bots)", duplicate: "Duplicates", cluster: "Clusters", screener: "Screener", custom: "Custom",
};

export function QualityRulesCatalog() {
  const cats = [...new Set(RULES.map((r) => r.category))];
  return (
    <div className="docs-catalog" data-testid="docs-quality-rules">
      <p className="docs-catalog-note">{RULES.length} quality rules in {cats.length} categories — generated from the quality engine when this page is opened. “On in” lists the strictness levels that switch a rule on by default.</p>
      {cats.map((c) => (
        <section key={c}>
          <h3 id={`q-${c}`}>{CATEGORY_LABEL[c] ?? c}</h3>
          <table>
            <thead><tr><th>Rule</th><th>What it flags</th><th>Severity</th><th>On in</th></tr></thead>
            <tbody>{RULES.filter((r) => r.category === c).map((r) => (
              <tr key={r.id} data-testid={`docs-qrule-${r.id}`}>
                <td><b>{r.title}</b>{r.role === "informational" ? <> <span className="muted">(informational)</span></> : null}</td>
                <td>{r.description}</td>
                <td>{r.defaultSeverity}</td>
                <td>{STRICT.filter((s) => r.enabledIn[s]).map((s) => STRICT_LABEL[s]).join(", ") || "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
