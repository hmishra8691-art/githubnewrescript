"use client";
import React from "react";

/**
 * CBC DESIGN QUALITY, IN WORDS AND NUMBERS (conjoint audit 2026-10-17).
 *
 * The generator has always returned a summary; the panel printed it as raw
 * JSON in the preview and nowhere else. A design's claims — level balance,
 * overlap, efficiency, what prohibitions cost — are now shown as measured
 * values on the preview and on every attached design, from the summary the
 * design file stores (`file.summary`). A design generated before the summary
 * had `efficiency` simply shows what it has.
 */
type Summary = Record<string, any>;

const pct = (x: unknown) => (typeof x === "number" ? `${Math.round(x * 1000) / 10}%` : "—");

export function conjointQualityLine(summary: Summary | undefined): string | null {
  const e = summary?.efficiency;
  if (!e) return null;
  const identified = !(typeof e.parameters === "number" && e.minVersionDegreesOfFreedom < e.parameters);
  const parts = [
    identified
      ? `D-efficiency ${pct(e.perVersion?.mean)} per version (worst ${pct(e.perVersion?.min)}), ${pct(e.pooled)} pooled`
      : `D-efficiency ${pct(e.pooled)} pooled (a version alone is too short to identify the model)`,
  ];
  const ratios = Object.values((summary?.balanceScores ?? {}) as Record<string, number>).filter((v) => typeof v === "number");
  if (ratios.length) parts.push(`level balance max/min ${Math.max(...ratios).toFixed(2)}`);
  if (typeof e.avoidableOverlapPct === "number") parts.push(`avoidable overlap ${e.avoidableOverlapPct}%`);
  if (summary?.method) parts.push(summary.method === "efficient" ? "efficient (swapping)" : "balanced");
  return parts.join(" · ");
}

export function ConjointDesignQuality({ summary, compact = false }: { summary: Summary; compact?: boolean }) {
  const e = summary?.efficiency;
  const warnings: string[] = Array.isArray(summary?.warnings) ? summary.warnings : [];
  if (compact) {
    const line = conjointQualityLine(summary);
    if (!line) return null;
    return (
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }} data-testid="cbc-quality-line">
        {line}{warnings.length ? ` · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}
      </div>
    );
  }
  const freq = (summary?.levelFrequencies ?? {}) as Record<string, Record<string, number>>;
  return (
    <div className="card" style={{ marginTop: 10, padding: 10 }} data-testid="cbc-quality">
      <div className="flabel">Design quality (measured on the generated design)</div>
      {e ? (
        <table className="grid" style={{ marginBottom: 8 }}>
          <tbody>
            <tr><td>D-efficiency per version</td><td data-testid="cbc-deff-version">{typeof e.parameters === "number" && e.minVersionDegreesOfFreedom < e.parameters
              ? `not identified per respondent — ${e.minVersionDegreesOfFreedom} choice d.f. for ${e.parameters} part-worths (aggregate model only)`
              : `${pct(e.perVersion?.mean)} mean · ${pct(e.perVersion?.min)} worst`} · {e.perVersion?.versions} version{e.perVersion?.versions === 1 ? "" : "s"}</td></tr>
            <tr><td>D-efficiency, all versions pooled</td><td data-testid="cbc-deff-pooled">{pct(e.pooled)}</td></tr>
            <tr><td>Overlap (a level repeated inside a task)</td><td>{e.overlapPct}% of task × attribute cells · avoidable {e.avoidableOverlapPct}%</td></tr>
            <tr><td>Tasks with a duplicate concept</td><td>{e.duplicateConceptTasks}</td></tr>
            {summary?.legalConcepts != null && (
              <tr><td>Concepts left by the prohibitions</td><td>{summary.legalConcepts} of {summary.totalConcepts} ({summary.spaceRemaining}%)</td></tr>
            )}
            {summary?.optimisation && (
              <tr><td>Optimisation</td><td>{String(summary.optimisation.algorithm)} · {summary.optimisation.swaps} swaps{summary.optimisation.versionsStoppedAtBudget ? ` · ${summary.optimisation.versionsStoppedAtBudget} version(s) stopped at the work budget` : ""}</td></tr>
            )}
          </tbody>
        </table>
      ) : (
        <p className="muted" style={{ fontSize: 12.5 }}>This design was generated before efficiency was measured — regenerate it to see D-efficiency and overlap.</p>
      )}
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        D-efficiency: main-effects multinomial logit at zero utilities, relative to the best possible design with these attributes and alternatives per task (100% = optimal). Holdouts and the None option are not counted.
      </div>
      {Object.keys(freq).length > 0 && (
        <div style={{ fontSize: 12.5 }} data-testid="cbc-level-balance">
          {Object.entries(freq).map(([attr, levels]) => {
            const v = Object.values(levels);
            return <div key={attr}><strong>{attr}</strong>: shown {Math.min(...v)}–{Math.max(...v)} times per level</div>;
          })}
        </div>
      )}
      {warnings.map((w, i) => <div key={i} className="chip warn" style={{ marginTop: 6 }}>{w}</div>)}
    </div>
  );
}
