"use client";
import React from "react";
import { fmtScore } from "@/lib/portal/words";
import { when } from "./api";

/**
 * ONE SCORE OVER TIME (phase 3, 2026-11-20). The server decided everything shown: which results exist, which are
 * like-for-like, and what changed. Like results are joined by a line; a result scored differently is drawn hollow
 * and apart. The table under the chart says the same in words, for a screen reader and for print.
 */
export interface TrendPoint { at: string; wave: string; responseId: string; score: number; percent: number | null; band: string | null; comparable: boolean; groupMean: number | null; groupN: number | null }
export interface Change { fromAt: string; from: number; to: number; delta: number; direction: "better" | "worse" | "same"; text: string }
export interface Trend { id: string; label: string; min: number | null; max: number | null; higherIsBetter: boolean; points: TrendPoint[]; change: Change | null; sinceFirst: Change | null; yearOnYear: Change | null; note: string | null }

const W = 640, H = 170, L = 38, R = 18, T = 22, B = 30;
const name = (p: TrendPoint) => p.wave || when(p.at);

function Chart({ t }: { t: Trend }) {
  const values = t.points.flatMap((p) => (p.groupMean === null ? [p.score] : [p.score, p.groupMean]));
  let lo = t.min ?? Math.min(...values), hi = t.max ?? Math.max(...values);
  if (hi <= lo) { lo -= 1; hi += 1; }
  const x = (i: number) => (t.points.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (t.points.length - 1));
  const y = (v: number) => T + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (H - T - B);
  const like = t.points.map((p, i) => ({ p, i })).filter((o) => o.p.comparable);
  const every = Math.ceil(t.points.length / 8);
  const label = `${t.label} over time: ${t.points.map((p) => `${name(p)} ${fmtScore(p.score)}${p.comparable ? "" : " (scored differently)"}`).join(", ")}`;
  return (
    <svg className="pt-trend" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} data-testid={`pt-chart-${t.id}`}>
      <line x1={L} y1={y(hi)} x2={W - R} y2={y(hi)} className="pt-trend-grid" />
      <line x1={L} y1={y(lo)} x2={W - R} y2={y(lo)} className="pt-trend-grid" />
      <text x={L - 6} y={y(hi) + 4} textAnchor="end" className="pt-trend-axis">{fmtScore(hi)}</text>
      <text x={L - 6} y={y(lo) + 4} textAnchor="end" className="pt-trend-axis">{fmtScore(lo)}</text>
      {like.length > 1 && <polyline className="pt-trend-line" points={like.map((o) => `${x(o.i)},${y(o.p.score)}`).join(" ")} />}
      {t.points.map((p, i) => (
        <g key={p.responseId}>
          {p.groupMean !== null && <line x1={x(i) - 12} y1={y(p.groupMean)} x2={x(i) + 12} y2={y(p.groupMean)} className="pt-trend-group" />}
          <circle cx={x(i)} cy={y(p.score)} r={5} className={p.comparable ? "pt-trend-dot" : "pt-trend-dot is-apart"} />
          <text x={x(i)} y={(p.groupMean !== null && y(p.groupMean) < y(p.score) && y(p.score) - y(p.groupMean) < 22 ? y(p.groupMean) : y(p.score)) - 9} textAnchor="middle" className="pt-trend-value">{fmtScore(p.score)}</text>
          {(i % every === 0 || i === t.points.length - 1) && <text x={x(i)} y={H - 8} textAnchor={i === 0 && t.points.length > 1 ? "start" : i === t.points.length - 1 && t.points.length > 1 ? "end" : "middle"} className="pt-trend-axis">{name(p)}</text>}
        </g>
      ))}
    </svg>
  );
}

const since = (c: Change) => `since ${when(c.fromAt)}`;

export function TrendCard({ t }: { t: Trend }) {
  const anyGroup = t.points.some((p) => p.groupMean !== null);
  return (
    <li data-testid={`pt-trend-${t.id}`}>
      <div className="pt-score-head">
        <p className="pt-q">{t.label}</p>
        {t.change && <p className={`pt-change is-${t.change.direction}`} data-testid={`pt-change-${t.id}`}>{t.change.text}</p>}
      </div>
      {t.points.length > 1
        ? <p className="pt-why">{t.change ? `Compared with your previous result, ${since(t.change)}.` : "There is no earlier result scored the same way to compare with."}{t.higherIsBetter ? "" : " For this score, lower is better."}</p>
        : <p className="pt-why">This is your first result. A change is shown from the second one.</p>}
      <Chart t={t} />
      {(t.sinceFirst || t.yearOnYear) && (
        <ul className="pt-compare">
          {t.yearOnYear && <li><strong>A year earlier:</strong> {t.yearOnYear.text}, {since(t.yearOnYear)}.</li>}
          {t.sinceFirst && <li><strong>Since your first result:</strong> {t.sinceFirst.text}, {since(t.sinceFirst)}.</li>}
        </ul>
      )}
      {t.note && <p className="pt-why">{t.note}</p>}
      {anyGroup && <p className="pt-why pt-legend"><span className="pt-bar-mark is-key" style={{ width: 14, height: 3, marginBottom: 3 }} /> The dark line beside a result is the average of everyone who took it.</p>}
      <table className="pt-table pt-trend-table">
        <thead><tr><th>When</th><th>Score</th>{t.points.some((p) => p.band) && <th>Range</th>}{anyGroup && <th>Average of everyone</th>}</tr></thead>
        <tbody>
          {t.points.map((p) => (
            <tr key={p.responseId}>
              <td>{p.wave ? `${p.wave} · ` : ""}{when(p.at)}</td>
              <td>{fmtScore(p.score)}{t.max !== null ? ` of ${fmtScore(t.max)}` : ""}{p.comparable ? "" : " (scored differently)"}</td>
              {t.points.some((q) => q.band) && <td>{p.band ?? "—"}</td>}
              {anyGroup && <td>{p.groupMean === null ? "—" : `${fmtScore(p.groupMean)} (${p.groupN} people)`}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </li>
  );
}
