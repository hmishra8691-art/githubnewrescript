"use client";
import React from "react";

/**
 * Shared pieces of the metered-usage screens — the project's Usage tab, the
 * person's My Usage page and Billing Administration. One way to show money,
 * one bar chart, one usage table, one banner, so the three screens agree.
 */

export const fmtMoney = (n: number | null | undefined, currency = "USD"): string => {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  const abs = Math.abs(v);
  const digits = abs === 0 || abs >= 0.01 ? 2 : abs >= 0.001 ? 4 : 6;
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v); }
  catch { return `${v < 0 ? "-" : ""}$${abs.toFixed(digits)}`; }
};
export const fmtQty = (n: number, unit: string): string => {
  const abs = Math.abs(n);
  const num = abs >= 1000 ? Math.round(n).toLocaleString() : abs >= 1 ? (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2)) : n.toFixed(3);
  const plural = abs === 1 ? unit : unit === "GB-month" ? "GB-months" : /[A-Z]$/.test(unit) ? unit : `${unit}s`;
  return `${num} ${plural}`;
};
export const fmtWhen = (iso: string): string => { const ms = Date.parse(iso); return Number.isNaN(ms) ? "—" : new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); };

export const LEVEL_CLASS: Record<string, string> = { normal: "success", low: "warning", critical: "error", locked: "error" };
export const LEVEL_WORD: Record<string, string> = { normal: "Normal", low: "Low balance", critical: "Critical balance", locked: "Project locked" };
export const STATE_WORD: Record<string, string> = { active: "Active", read_only: "Read-only", suspended: "Suspended" };

export interface UsageRow {
  id: string; at: string; eventType: string; category: string; label: string; environment: "TEST" | "LIVE";
  provider: string | null; model: string | null; quantity: number; unit: string; inputUnits: number | null; outputUnits: number | null;
  actualCost: number; providerCost: number; infraCost: number; customerCharge: number; reversal: boolean; unbilled: boolean; operation: string | null; cached: boolean;
}

export const EVENT_WORDS: Record<string, string> = {
  AI_REQUEST: "AI request", TRANSLATION_CHARACTER: "Translation", SURVEY_RESPONSE: "Survey response", SURVEY_RESPONSE_STARTED: "Response started",
  FILE_UPLOAD: "File upload", STORAGE_GB: "File storage", BANDWIDTH_GB: "Bandwidth", TEXT_TO_SPEECH_CHARACTER: "AI voice", GEOCODE_REQUEST: "Address lookup",
  EMAIL_MESSAGE: "Email invitation", REPORT_GENERATION: "Report generated", EXPORT_GENERATION: "Data export", SURVEY_RENDER: "Page rendered",
};
export const OPERATION_WORDS: Record<string, string> = { ai_classify: "AI classification", ai_sentiment: "AI sentiment", probe: "AI follow-up", rephrase_for_speech: "AI spoken version", tts_preview: "AI voice preview", geocode: "Address lookup" };

export function describeRow(r: UsageRow): string {
  if (r.operation && OPERATION_WORDS[r.operation]) return OPERATION_WORDS[r.operation];
  if (r.operation?.startsWith("translate:")) return `Translation ${r.operation.slice(10).replace("->", " → ")}`;
  return EVENT_WORDS[r.eventType] ?? r.eventType.toLowerCase().replace(/_/g, " ");
}
export function describeQuantity(r: UsageRow): string {
  if (r.inputUnits != null || r.outputUnits != null) return `${Math.round((r.inputUnits ?? 0) + (r.outputUnits ?? 0)).toLocaleString()} tokens`;
  return fmtQty(r.quantity, r.unit);
}

export function UsageTable({ rows, currency, showCost = true, onReverse, testid = "usage-rows" }: { rows: UsageRow[]; currency: string; showCost?: boolean; onReverse?: (row: UsageRow) => void; testid?: string }) {
  if (!rows.length) return <p className="muted" style={{ fontSize: 13 }} data-testid={`${testid}-empty`}>No usage yet.</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="grid bl-table" data-testid={testid}>
        <thead><tr><th>When</th><th>What</th><th>Quantity</th><th>Env</th>{showCost && <th>Actual cost</th>}<th>Charge</th>{onReverse && <th />}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-testid="usage-row" data-event={r.eventType} data-env={r.environment} className={r.reversal ? "bl-reversal" : ""}>
              <td className="muted">{fmtWhen(r.at)}</td>
              <td>{describeRow(r)}{r.model && r.model !== "fake" ? <span className="muted"> · {r.model}</span> : null}{r.reversal && <span className="badge neutral" style={{ marginLeft: 6 }}>reversal</span>}{r.unbilled && <span className="badge warning" style={{ marginLeft: 6 }} title="Recorded but not charged — the wallet could not cover it">unbilled</span>}</td>
              <td>{describeQuantity(r)}</td>
              <td><span className={`badge ${r.environment === "TEST" ? "neutral" : ""}`}>{r.environment}</span></td>
              {showCost && <td className="muted">{fmtMoney(r.actualCost, currency)}</td>}
              <td data-testid="usage-charge"><strong>{fmtMoney(r.customerCharge, currency)}</strong></td>
              {onReverse && <td>{!r.reversal && r.customerCharge > 0 && <button className="btn small" onClick={() => onReverse(r)}>Reverse</button>}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UsageBars({ points, currency, height = 120 }: { points: { day: string; charge: number; events: number }[]; currency: string; height?: number }) {
  const max = Math.max(0.000001, ...points.map((p) => p.charge));
  const w = 12, gap = 4, pad = 28;
  const width = points.length * (w + gap) + pad;
  return (
    <svg className="bl-chart" viewBox={`0 0 ${width} ${height + 24}`} width="100%" height={height + 24} role="img" aria-label="Usage per day" data-testid="usage-chart">
      <line x1={pad} x2={width} y1={height} y2={height} stroke="var(--c-border)" />
      <text x={0} y={10} fontSize="9" fill="var(--c-text-3)">{fmtMoney(max, currency)}</text>
      <text x={0} y={height} fontSize="9" fill="var(--c-text-3)">$0</text>
      {points.map((p, i) => {
        const h = Math.max(p.charge > 0 ? 2 : 0, Math.round((p.charge / max) * (height - 12)));
        const x = pad + i * (w + gap);
        return (
          <g key={p.day}>
            <rect x={x} y={height - h} width={w} height={h} rx={2} fill={p.charge > 0 ? "var(--c-primary)" : "var(--c-border)"} data-day={p.day} data-charge={p.charge}>
              <title>{p.day}: {fmtMoney(p.charge, currency)} · {p.events} events</title>
            </rect>
            {(i === 0 || i === points.length - 1 || i % 7 === 0) && <text x={x} y={height + 14} fontSize="8" fill="var(--c-text-3)">{p.day.slice(5)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export function Progress({ used, total, level }: { used: number; total: number; level: string }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : used > 0 ? 100 : 0;
  return (
    <div className="bl-progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} data-testid="usage-progress" data-pct={Math.round(pct)}>
      <div className={`bl-progress-fill ${level}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function LevelBanner({ level, message, state }: { level: string; message: string; state: string }) {
  if (state === "suspended") return <div className="alert error" data-testid="wallet-banner" data-level="suspended">This project&apos;s wallet is suspended. Please contact your administrator.</div>;
  if (level === "normal" || !message) return null;
  return <div className={`alert ${LEVEL_CLASS[level]}`} data-testid="wallet-banner" data-level={level}>{message}</div>;
}

export function Stat({ label, value, sub, testid }: { label: string; value: React.ReactNode; sub?: React.ReactNode; testid?: string }) {
  return (
    <div className="bl-stat" data-testid={testid}>
      <div className="bl-stat-label">{label}</div>
      <div className="bl-stat-value">{value}</div>
      {sub && <div className="bl-stat-sub muted">{sub}</div>}
    </div>
  );
}

export const PRESET_AMOUNTS = [10, 50, 100, 500, 1000];
