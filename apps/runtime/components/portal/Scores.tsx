"use client";
import React from "react";

/**
 * ONE ATTEMPT'S SCORES (phase 2, 2026-11-20). Everything drawn here was decided on the server: which scores the
 * person may see, whether a range name is shown, and which comparisons exist. A comparison is always with a GROUP
 * (everyone, or the person's own group) of at least ten people; when there is none, the reason is said instead.
 */
export interface Dimension { id: string; label: string; description?: string; score: number | null; min: number | null; max: number | null; percent: number | null; band: { label: string; note?: string } | null; higherIsBetter: boolean; reason?: string }
export interface Standing { n: number; mean: number; median: number; below: number; above: number }
export interface Comparison { dimension: string; everyone: Standing | null; groups: (Standing & { grouping: string; group: string })[]; note: string | null }
export interface Scorecard { dimensions: Dimension[]; overall: { label: string; percent: number } | null }

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) < 10 ? 2 : 1).replace(/0+$/, "").replace(/\.$/, ""));
const place = (v: number, min: number | null, max: number | null) => (min !== null && max !== null && max > min ? Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100)) : null);

/** "Higher than 62% of 143 people" — worded from the good end for a score where less is better */
export function standingText(s: Standing, higherIsBetter: boolean): string {
  const share = higherIsBetter ? s.below : s.above;
  if (s.below === 0 && s.above === 0) return `The same as the ${s.n} people compared`;
  return `${higherIsBetter ? "Higher" : "Lower"} than ${share}% of ${s.n} people`;
}

function Bar({ percent, mark, label }: { percent: number; mark: number | null; label: string }) {
  return (
    <div className="pt-bar" role="img" aria-label={label}>
      <div className="pt-bar-fill" style={{ width: `${percent}%` }} />
      {mark !== null && <div className="pt-bar-mark" style={{ left: `${mark}%` }} title="Average of everyone compared" />}
    </div>
  );
}

function Row({ d, c }: { d: Dimension; c: Comparison | undefined }) {
  const mark = c?.everyone ? place(c.everyone.mean, d.min, d.max) : null;
  return (
    <li data-testid={`pt-score-${d.id}`}>
      <div className="pt-score-head">
        <p className="pt-q">{d.label}</p>
        {d.score !== null && <p className="pt-score-value">{fmt(d.score)}{d.max !== null && <small> of {fmt(d.max)}</small>}</p>}
      </div>
      {d.description && <p className="pt-why">{d.description}</p>}
      {d.score === null && <p className="pt-why">{d.reason ?? "This score could not be worked out."}</p>}
      {d.percent !== null && <Bar percent={d.percent} mark={mark} label={`${d.label}: ${fmt(d.score!)}${d.max !== null ? ` of ${fmt(d.max)}` : ""}${mark !== null ? `; average of everyone ${fmt(c!.everyone!.mean)}` : ""}`} />}
      {d.band && <p className="pt-band"><span className="pt-chip">{d.band.label}</span>{d.band.note ? ` ${d.band.note}` : ""}</p>}
      {c && d.score !== null && (
        <ul className="pt-compare" data-testid={`pt-compare-${d.id}`}>
          {c.everyone && <li><strong>Everyone:</strong> {standingText(c.everyone, d.higherIsBetter)}. Average {fmt(c.everyone.mean)}.</li>}
          {c.groups.map((g) => (<li key={`${g.grouping}:${g.group}`}><strong>{g.grouping}: {g.group}.</strong> {standingText(g, d.higherIsBetter)}. Average {fmt(g.mean)}.</li>))}
          {c.note && <li>{c.note}</li>}
        </ul>
      )}
    </li>
  );
}

export function Scores({ scores, comparison, scoredTest }: { scores: Scorecard; comparison: Comparison[] | null; scoredTest: boolean }) {
  const of = (id: string) => comparison?.find((c) => c.dimension === id);
  const overall = of("__overall");
  const anyMark = !!comparison?.some((c) => c.everyone);
  return (
    <div className="pt-card" data-testid="pt-scores">
      {scores.overall && (
        <div className="pt-overall" data-testid="pt-overall">
          <p className="pt-q">{scores.overall.label}</p>
          <p className="pt-score-value is-big">{fmt(scores.overall.percent)}<small> of 100</small></p>
          <Bar percent={scores.overall.percent} mark={overall?.everyone ? overall.everyone.mean : null} label={`${scores.overall.label}: ${fmt(scores.overall.percent)} of 100`} />
          {overall?.everyone && <p className="pt-why">{standingText(overall.everyone, true)}. Average {fmt(overall.everyone.mean)}.</p>}
        </div>
      )}
      <ul className="pt-answers pt-scores">{scores.dimensions.map((d) => <Row key={d.id} d={d} c={of(d.id)} />)}</ul>
      {anyMark && <p className="pt-why pt-legend"><span className="pt-bar-mark is-key" /> The line on a bar is the average of everyone compared.</p>}
      {comparison && <p className="pt-why">Comparisons are with groups of at least ten people. Nobody's individual result is shown to anyone else.</p>}
      {!scoredTest && <p className="pt-why">Scores describe the answers you gave. They are not a diagnosis or professional advice.</p>}
    </div>
  );
}
