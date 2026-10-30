"use client";
import React from "react";
import { scriptHealthChipText, type ScriptHealthScript, type ScriptHealthSummary } from "@rescript/engine";
import { useStudio } from "./store";

/**
 * S1c (audit D11 / SE-30) — SCRIPT HEALTH IN THE STUDIO. Where scripts are managed (Survey Settings → Scripts, and
 * every "Styles, animations & scripts" editor) each script carries a chip: "no errors in N sessions" or "failed in
 * K of N sessions", with a popover of what failed (kinds, top messages, pages, browsers, last seen). The numbers come
 * from `GET /api/surveys/[id]/script-health?env=live|test` (the respondents' sessions; runtime telemetry
 * `scriptHealth`). In the editor sandbox the test survey is named by `?health=<token>` on the sandbox URL.
 *
 * One request per survey and environment, shared by every chip on screen and kept for 30 s.
 */
type Env = "live" | "test";
type Health = ScriptHealthSummary & { env: Env; sandbox?: boolean; truncated?: boolean };
type State = { status: "idle" | "loading" | "ready" | "off" | "error"; data?: Health; error?: string };

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; p: Promise<State> }>();
const listeners = new Set<() => void>();
let envChoice: Env = "live";

function sandboxToken(): string | null {
  if (typeof window === "undefined") return null;
  const t = new URLSearchParams(window.location.search).get("health");
  return t && /^[0-9a-f]{24}$/.test(t) ? t : null;
}

function load(surveyDbId: string | null | undefined, env: Env, force = false): Promise<State> {
  if (!surveyDbId) return Promise.resolve({ status: "off" });
  const sandbox = surveyDbId === "sandbox";
  const token = sandbox ? sandboxToken() : null;
  if (sandbox && !token) return Promise.resolve({ status: "off" });
  const key = `${surveyDbId}|${sandbox ? "test" : env}|${token ?? ""}`;
  const hit = cache.get(key);
  if (hit && !force && Date.now() - hit.at < TTL_MS) return hit.p;
  const url = sandbox ? `/api/surveys/sandbox/script-health?token=${token}` : `/api/surveys/${encodeURIComponent(surveyDbId)}/script-health?env=${env}`;
  const p = fetch(url, { cache: "no-store" }).then(async (r) => {
    const body = await r.json().catch(() => null);
    if (!r.ok || !body?.ok) return { status: "error", error: body?.error ?? `HTTP ${r.status}` } as State;
    return { status: "ready", data: body as Health } as State;
  }).catch((e) => ({ status: "error", error: (e as Error).message }) as State);
  cache.set(key, { at: Date.now(), p });
  return p;
}

/** S2a D10: the summary for one request (Intelligent Mode's "debug / explain the script"), from the same cache; null when there is none */
export async function loadScriptHealthSummary(surveyDbId: string | null | undefined, timeoutMs = 2500): Promise<Health | null> {
  const st = await Promise.race([load(surveyDbId, "live"), new Promise<State>((r) => setTimeout(() => r({ status: "off" }), timeoutMs))]);
  return st.status === "ready" && st.data ? st.data : null;
}

export function useScriptHealth(): State & { env: Env; setEnv(e: Env): void; refresh(): void } {
  const s = useStudio();
  const [env, setEnvState] = React.useState<Env>(envChoice);
  const [st, setSt] = React.useState<State>({ status: "idle" });
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => { const f = () => { setEnvState(envChoice); setTick((t) => t + 1); }; listeners.add(f); return () => { listeners.delete(f); }; }, []);
  React.useEffect(() => {
    let live = true;
    setSt((x) => (x.status === "ready" ? x : { status: "loading" }));
    void load(s.surveyDbId, env).then((v) => { if (live) setSt(v); });
    return () => { live = false; };
  }, [s.surveyDbId, env, tick]);
  return {
    ...st, env,
    setEnv: (e) => { envChoice = e; for (const f of listeners) f(); },
    refresh: () => { void load(s.surveyDbId, env, true).then(() => { for (const f of listeners) f(); }); },
  };
}

const KIND_WORDS: Record<string, string> = {
  ux_error: "script error", logic_error: "script error", logic_timeout: "did not finish in time", lifecycle_timeout: "validate / submit did not answer in time",
  component_not_run: "component could not run", gate_refused: "refused by the code check", write_refused: "write refused", navigation_refused: "navigation refused", watchdog: "stopped by the watchdog",
};

/** the chip for one script (UX behaviour id, Scripts-panel script id, or `uxb_component_<question id>`) */
export function ScriptHealthChip({ scriptId }: { scriptId: string }) {
  const h = useScriptHealth();
  const [open, setOpen] = React.useState(false);
  if (h.status === "off" || h.status === "idle") return null;
  if (h.status === "loading") return <span className="chip muted" data-testid="script-health-chip" data-state="loading" style={chipStyle("muted")}>script health…</span>;
  if (h.status === "error" || !h.data) return <span className="chip" data-testid="script-health-chip" data-state="error" title={h.error} style={chipStyle("muted")}>script health unavailable</span>;
  const row = h.data.scripts.find((x) => x.script === scriptId);
  const failed = !!row?.sessions;
  const text = scriptHealthChipText(h.data, row);
  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button type="button" className="chip" data-testid="script-health-chip" data-state={failed ? "failed" : h.data.sessions ? "ok" : "none"} data-script={scriptId}
        aria-expanded={open} onClick={() => setOpen((o) => !o)} style={chipStyle(failed ? "bad" : h.data.sessions ? "good" : "muted")}
        title={`${h.env === "test" ? "Test" : "Live"} sessions — click for details`}>
        {failed ? "⚠ " : ""}{text}{h.env === "test" ? " (test)" : ""}
      </button>
      {open && <ScriptHealthPopover row={row} sessions={h.data.sessions} env={h.env} onClose={() => setOpen(false)} />}
    </span>
  );
}

function ScriptHealthPopover({ row, sessions, env, onClose }: { row?: ScriptHealthScript; sessions: number; env: Env; onClose(): void }) {
  return (
    <div role="dialog" aria-label="Script health" data-testid="script-health-popover"
      style={{ position: "absolute", zIndex: 30, top: "100%", left: 0, marginTop: 4, width: 340, maxWidth: "80vw", background: "var(--panel, #fff)", border: "1px solid var(--border, #ddd)", borderRadius: 8, padding: 10, boxShadow: "0 6px 20px rgba(0,0,0,.12)", fontSize: 12.5 }}>
      <div className="row" style={{ marginBottom: 6 }}><strong>Script health — {env === "test" ? "test" : "live"} sessions</strong><span className="grow" /><button type="button" className="btn small ghost" onClick={onClose}>×</button></div>
      {!row || !row.sessions ? <p className="muted" style={{ margin: 0 }}>No failures recorded in {sessions.toLocaleString("en-US")} session{sessions === 1 ? "" : "s"}.</p> : (
        <>
          <p style={{ margin: "0 0 6px" }}>Failed in <b>{row.sessions}</b> of {sessions} sessions ({row.failures} failure{row.failures === 1 ? "" : "s"}){row.lastSeen ? <> — last seen {new Date(row.lastSeen).toLocaleString()}</> : null}.</p>
          <div className="muted" style={{ marginBottom: 4 }}>{Object.entries(row.kinds).map(([k, n]) => `${KIND_WORDS[k] ?? k} ×${n}`).join(" · ")}</div>
          <ul style={{ margin: "0 0 6px 16px", padding: 0 }} data-testid="script-health-messages">
            {row.messages.map((m, i) => <li key={i}><code style={{ whiteSpace: "pre-wrap" }}>{m.message || "(no message)"}</code> <span className="muted">×{m.count}</span></li>)}
          </ul>
          {row.pages.length > 0 && <div className="muted">Pages: {row.pages.join(", ")}</div>}
          {row.browsers.length > 0 && <div className="muted">Browsers: {row.browsers.join(", ")}</div>}
        </>
      )}
      <p className="muted" style={{ margin: "6px 0 0", fontSize: 11.5 }}>Counted in respondents&apos; browsers and saved with their answers (never their answer text). Kept whatever the survey&apos;s telemetry switches say: it is about the survey&apos;s code.</p>
    </div>
  );
}

function chipStyle(tone: "good" | "bad" | "muted"): React.CSSProperties {
  const c = tone === "good" ? "#067647" : tone === "bad" ? "#b42318" : "#667085";
  return { fontSize: 11.5, padding: "1px 8px", borderRadius: 999, border: `1px solid ${c}`, color: c, background: "transparent", cursor: "pointer", lineHeight: 1.6 };
}

/** the panel header: which sessions, how many affected, every failing script (also ones without a chip on screen) */
export function ScriptHealthSummaryBar() {
  const h = useScriptHealth();
  const s = useStudio();
  if (h.status === "off" || h.status === "idle") return null;
  return (
    <div className="card" data-testid="script-health-summary" style={{ padding: 10, marginBottom: 12 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>Script health in the field</strong>
        {s.surveyDbId !== "sandbox" && (
          <select className="select" value={h.env} onChange={(e) => h.setEnv(e.target.value as Env)} aria-label="Sessions" data-testid="script-health-env" style={{ fontSize: 12 }}>
            <option value="live">live sessions</option><option value="test">test sessions</option>
          </select>
        )}
        <button type="button" className="btn small ghost" onClick={h.refresh} data-testid="script-health-refresh">Refresh</button>
        <span className="grow" />
        {h.status === "ready" && h.data && <span className="muted" style={{ fontSize: 12 }} data-testid="script-health-totals">{h.data.affected ? `${h.data.affected} of ${h.data.sessions} sessions had a script failure` : `no script failures in ${h.data.sessions} session${h.data.sessions === 1 ? "" : "s"}`}{h.data.truncated ? " (latest 5,000)" : ""}</span>}
        {h.status === "loading" && <span className="muted" style={{ fontSize: 12 }}>loading…</span>}
        {h.status === "error" && <span className="muted" style={{ fontSize: 12 }}>unavailable: {h.error}</span>}
      </div>
      {h.status === "ready" && h.data && h.data.scripts.length > 0 && (
        <ul style={{ margin: "6px 0 0 16px", padding: 0, fontSize: 12.5 }} data-testid="script-health-list">
          {h.data.scripts.slice(0, 12).map((x) => (
            <li key={x.script}><b>{x.name}</b> — {scriptHealthChipText(h.data!, x)}: <code>{x.messages[0]?.message ?? ""}</code></li>
          ))}
        </ul>
      )}
    </div>
  );
}
