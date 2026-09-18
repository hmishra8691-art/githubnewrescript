import React from "react";

/**
 * One loading state for every panel: skeleton rows in the shape of what is
 * coming, with the label for screen readers (and for anyone who prefers the
 * word). `rows` says how much is expected; `inline` fits inside a sentence.
 */
export function Loading({ label = "Loading…", rows = 3, inline, testId }: { label?: string; rows?: number; inline?: boolean; testId?: string }) {
  if (inline) return <span className="sk" role="status" aria-label={label} style={{ display: "inline-block", width: 72, height: 12, verticalAlign: "middle" }} data-testid={testId} />;
  return (
    <div className="loading" role="status" aria-live="polite" aria-label={label} data-testid={testId}>
      {Array.from({ length: rows }).map((_, i) => <span key={i} className="sk" style={{ width: `${88 - (i % 3) * 16}%`, height: 12 }} />)}
      <span className="loading-label">{label}</span>
    </div>
  );
}

/** An empty state in the design system's voice: what is missing, why it matters, what to do. */
export function EmptyState({ title, children, action, icon, testId }: { title: string; children?: React.ReactNode; action?: React.ReactNode; icon?: React.ReactNode; testId?: string }) {
  return (
    <div className="empty" data-testid={testId}>
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
