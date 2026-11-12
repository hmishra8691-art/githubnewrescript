import { applyDecisions, selectBlocks, buildReport, mapCanonical, verifyImport, type CanonicalSurvey, type Decision, type MigrationReport, type MapResult, type VerificationReport } from "@rescript/import";
import type { SurveyDefinition } from "@rescript/schema";
import type { ImportSession } from "./sessions";

/**
 * I5: re-run an import from its session with the decisions made so far — the stored canonical survey, the
 * decisions applied to a copy (checked; a decision that does not fit is rejected with its reason), then the
 * same map → report → verification as the first run. Nothing is saved to a project here; the browser gets the
 * new preview, exactly like the first one.
 */
export interface Reanalysis {
  definition: SurveyDefinition | null;
  report: MigrationReport;
  mapping: MapResult["mapping"];
  confidence: MapResult["confidence"];
  verification: VerificationReport | { error: string } | null;
  applied: string[];
  rejected: { id: string; reason: string }[];
  /** every decision kept for the session: the earlier ones, replaced by id with the new ones */
  decisions: Decision[];
}

export function mergeDecisions(earlier: Decision[], next: Decision[]): Decision[] {
  const byId = new Map(earlier.map((d) => [d.id, d]));
  for (const d of next) byId.set(d.id, d);
  return [...byId.values()];
}

export function reanalyze(s: ImportSession, newDecisions: Decision[], opts: { blocks?: string[] } = {}): Reanalysis | { error: string; status: number } {
  if (!s.canonical) return { error: "This import's reconstructed model was not kept, so it cannot be re-analysed — import the file again.", status: 410 };
  if (s.status !== "analyzed") return { error: `This import is already ${s.status.replace("_", " ")}; answer its questions on a new import.`, status: 409 };
  const decisions = mergeDecisions((s.decisions as Decision[]) ?? [], newDecisions);
  /* 2026-11-13: the session also keeps the plain answers of the intelligent import ({ type: "answer" }, see intelligent.ts) — they are not decisions */
  const decided = applyDecisions(s.canonical as CanonicalSurvey, decisions.filter((d) => (d as { type: string }).type !== "answer"));
  const { applied, rejected } = decided;
  /* I7: Import selected blocks — the decisions first (they may name questions in any block), then the selection */
  const canonical = opts.blocks?.length ? selectBlocks(decided.canonical, opts.blocks) : decided.canonical;
  const existing = s.into === "merge" ? (s.priorDefinition as SurveyDefinition | null) : null;
  if (s.into === "merge" && !existing) return { error: "The survey this import was previewed against was not kept, so it cannot be re-analysed here.", status: 410 };
  const result = mapCanonical(canonical, { surveyId: s.into === "merge" ? existing!.meta.id : "import_preview", existing, scope: s.scope });
  const detection = { format: s.format as never, platform: (s.platform ?? "unknown") as never, importType: "re-analysis", label: s.reportDigest.label ?? s.format, confidence: "high" as const, reasons: ["re-analysed from the import session with your answers"] };
  const report = buildReport(detection, canonical, result, s.scope);
  let verification: Reanalysis["verification"] = null;
  if (result.def && s.into === "new") { try { verification = verifyImport(canonical, result); } catch (e) { verification = { error: `Verification could not run: ${(e as Error).message}` }; } }
  return { definition: result.def, report, mapping: result.mapping, confidence: result.confidence, verification, applied, rejected, decisions };
}
