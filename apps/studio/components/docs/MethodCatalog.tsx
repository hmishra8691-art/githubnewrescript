import Link from "next/link";
import { STUDY_METHODOLOGIES, CATEGORY_NAMES, type StudyCategory } from "@rescript/engine";

/**
 * EVERY STUDY METHODOLOGY, FROM THE REGISTRY (Developer Docs, 2026-11-09): the same list Study design and Design
 * Generators offer, drawn at render time from `STUDY_METHODOLOGIES` — so a method added to the platform appears here
 * the next time the page is opened, and one removed disappears. Server component; no data read.
 */
const GUIDE: Record<string, string> = { van_westendorp: "van-westendorp", gabor_granger: "gabor-granger", sequential_monadic: "concept-testing", monadic: "concept-testing", comparative_concept: "concept-testing", maxdiff: "maxdiff", acbc: "adaptive-cbc", menu_conjoint: "menu-based-conjoint", rating_conjoint: "rating-based-conjoint", conjoint_pricing: "choice-based-conjoint", kano: "kano-model", brand_funnel: "brand-research", brand_equity: "brand-research", brand_tracking: "brand-research", brand_lift: "brand-research" };

export function MethodCatalog() {
  const cats = [...new Set(STUDY_METHODOLOGIES.map((m) => m.category))] as StudyCategory[];
  return (
    <div className="docs-catalog" data-testid="docs-catalog">
      <p className="docs-catalog-note">{STUDY_METHODOLOGIES.length} study methodologies in {cats.length} areas — generated from the platform's registry when this page is opened.</p>
      {cats.map((c) => (
        <section key={c}>
          <h3 id={`m-${c}`}>{CATEGORY_NAMES[c]}</h3>
          <table>
            <thead><tr><th>Method</th><th>Use it for</th><th>Sample</th><th>Interview</th><th>Analysis</th></tr></thead>
            <tbody>{STUDY_METHODOLOGIES.filter((m) => m.category === c).map((m) => (
              <tr key={m.id} data-testid={`docs-method-${m.id}`}>
                <td><b>{GUIDE[m.id] ? <Link href={`/docs/${GUIDE[m.id]}`}>{m.name}</Link> : m.name}</b></td>
                <td>{m.fit}</td>
                <td>{m.sample.note}</td>
                <td>{m.loi}</td>
                <td>{m.analysis.join("; ")}</td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
