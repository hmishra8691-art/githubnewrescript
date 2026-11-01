"use client";
import React from "react";
import type { TimerInput } from "@rescript/schema";
import { lintTimers, resolveTimer } from "@rescript/engine";

/**
 * S4b (GA-05) — THE TIMER of a question or of a flow page: one Runner clock per page (engine timers.ts).
 * Off = no `timer` at all. The fields map 1:1 onto the schema (timer.ts) and onto IM's set_timer.
 */
export function TimerEditor({ value, onChange, testId, what }: { value: TimerInput | undefined; onChange(t: TimerInput | undefined): void; testId: string; what: "question" | "page" }) {
  const on = !!value;
  const t: TimerInput = value ?? {};
  const set = (p: Partial<TimerInput>) => {
    const next = { ...t, ...p } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "") delete next[k];
    onChange(next as TimerInput);
  };
  const num = (v: string) => (v.trim() === "" ? undefined : Math.max(1, Math.min(3600, Math.round(Number(v)) || 1)));
  const problems = on ? lintTimers({ questions: [{ id: "x", code: what === "page" ? "This page" : "This question", timer: t } as never], flow: [] } as never).map((i) => i.message.replace(/^This (?:page|question):?\s*/, "")) : [];
  return (
    <div className="card" style={{ padding: 10 }} data-testid={testId}>
      <label className="row" style={{ gap: 6 }}>
        <input type="checkbox" checked={on} data-testid={`${testId}-on`}
          onChange={(e) => onChange(e.target.checked ? { limitSeconds: 30, show: "countdown", onTimeout: "advance" } : undefined)} />
        A timer on this {what}
      </label>
      {on && (
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 10px", alignItems: "center", marginTop: 8 }}>
          <span className="flabel">Time limit (seconds)</span>
          <input className="input" type="number" min={1} max={3600} style={{ width: 100 }} data-testid={`${testId}-limit`}
            value={t.limitSeconds ?? ""} placeholder="none" onChange={(e) => set({ limitSeconds: num(e.target.value) })} />
          <span className="flabel">Respondents see</span>
          <select className="select" data-testid={`${testId}-show`} value={t.show ?? "countdown"} onChange={(e) => set({ show: e.target.value as TimerInput["show"] })}>
            <option value="countdown">a countdown</option>
            <option value="hidden">nothing (the clock is hidden)</option>
          </select>
          <span className="flabel">When time runs out</span>
          <select className="select" data-testid={`${testId}-on-timeout`} value={t.onTimeout ?? "advance"} onChange={(e) => set({ onTimeout: e.target.value as TimerInput["onTimeout"] })}>
            <option value="advance">move on (unanswered questions are skipped)</option>
            <option value="lock">lock the answers</option>
            <option value="message">show a message</option>
          </select>
          {t.onTimeout === "message" && (<>
            <span className="flabel">Message</span>
            <input className="input" data-testid={`${testId}-message`} value={t.message ?? ""} placeholder="Time is up for this question. You can still continue."
              onChange={(e) => set({ message: e.target.value || undefined })} />
          </>)}
          <span className="flabel">Warn at (seconds left)</span>
          <input className="input" type="number" min={1} max={3600} style={{ width: 100 }} data-testid={`${testId}-warn`}
            value={t.warnAtSeconds ?? ""} placeholder="no warning" onChange={(e) => set({ warnAtSeconds: num(e.target.value) })} />
          <span className="flabel">Minimum time before Next (seconds)</span>
          <input className="input" type="number" min={1} max={3600} style={{ width: 100 }} data-testid={`${testId}-min`}
            value={t.minSeconds ?? ""} placeholder="none" onChange={(e) => set({ minSeconds: num(e.target.value) })} />
        </div>
      )}
      {on && !resolveTimer(t) && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Give a time limit or a minimum time — a timer with neither does nothing.</div>}
      {problems.map((m, i) => <div key={i} className="chip warn" data-testid={`${testId}-lint`} style={{ marginTop: 6, display: "inline-block" }}>{m}</div>)}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        One clock per page, counting from the page&apos;s arrival (it keeps counting in a hidden tab). Recorded as TIMER_&lt;{what === "page" ? "PAGE ID" : "CODE"}&gt;_ELAPSED and _TIMED_OUT.
      </div>
    </div>
  );
}
