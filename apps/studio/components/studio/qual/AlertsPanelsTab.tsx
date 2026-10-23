"use client";
import React from "react";
import type { AlertSettings, PanelConfig, PanelOutcome, PanelPresetId, PanelTarget } from "@rescript/schema";
import { AlertSettings as AlertSettingsSchema, PANEL_OUTCOMES } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, PANEL_PRESETS, PANEL_OUTCOME_LABELS, panelEntryLink, NOTIFY_EVENTS, CHANNEL_KIND_LABELS } from "@rescript/engine";
import { useStudio } from "../store";
import { runtimeBaseUrl } from "@/lib/runtime-url";
import { ChannelsBox, loadChannels, type ChannelsInfo } from "../../notify/ChannelsBox";

/**
 * ALERTS & PANELS (2026-10-22, G3) — Research Tools → Qualitative → Alerts & panels.
 *
 *   Alerts      the study's rules (on the definition): which events go to which channels, immediate or as a digest;
 *               quiet hours; the hourly cap. "Try the rules" sends a labelled sample through them now. The delivery
 *               log shows every message: sent, failed, retrying, held for a digest, skipped as a duplicate, or not
 *               configured (and why). The organisation's channels (Slack / Teams / webhook / e-mail) are managed in
 *               the box below and in Settings → Alerts.
 *   Panels      the study's panels (on the definition): add from a preset (Prolific, Cint / Lucid, PureSpectrum,
 *               Dynata, Toluna, CloudResearch Connect, MTurk-style codes, custom), set a signing secret (stored
 *               encrypted, never shown), test links per outcome, the entry link to give the panel, signed exits for
 *               the survey link, entries by outcome, and the reconciliation CSV.
 *
 * Everything that changes the definition goes through the engine's gate (configure_alerts / connect_panel), as in
 * Intelligent Mode. In the sandbox the tab hands the dispatcher the rules and panels (the definition is in the browser).
 */
type Delivery = { id: string; eventType: string; channel: string; destination: string; status: string; reason: string | null; attempts: number; nextAttemptAt: string | null; responseStatus: number | null; error: string | null; test: boolean; createdAt: string };
type PanelInfo = { key: string; label: string; signing: string; secret: { set: boolean; hint: string | null } | null; problems: string[]; counts: Record<string, number>; completesTarget: number | null };
type Entry = { id: string; panel: string; pid: string; target: string; outcome: string | null; status: string | null; signed: boolean | null; test: boolean; startedAt: string; session: string | null };

async function j<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const b = await r.json().catch(() => null);
  if (!r.ok) throw new Error(b?.error ?? `request failed (${r.status})`);
  return b as T;
}

export function AlertsPanelsTab() {
  const s = useStudio();
  const id = s.surveyDbId;
  const [channels, setChannels] = React.useState<ChannelsInfo | null>(null);
  const [deliveries, setDeliveries] = React.useState<Delivery[]>([]);
  const [me, setMe] = React.useState<string | null>(null);
  const [panels, setPanels] = React.useState<{ panels: PanelInfo[]; entries: Entry[]; secretsReady: boolean } | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const refresh = React.useCallback(async () => {
    try { setChannels(await loadChannels()); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    try { const a = await j<{ deliveries: Delivery[]; me: string }>(`/api/surveys/${id}/alerts`); setDeliveries(a.deliveries); setMe(a.me); } catch { /* a member without data access sees no log */ }
    try { setPanels(await j(`/api/surveys/${id}/panels`)); } catch { /* idem */ }
  }, [id]);
  React.useEffect(() => { void refresh(); const t = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 6000); return () => clearInterval(t); }, [refresh]);

  /* the sandbox: hand the dispatcher and the runtime the definition's rules and panels */
  const alertsJson = JSON.stringify(s.def.alerts ?? null), panelsJson = JSON.stringify(s.def.panels ?? []);
  React.useEffect(() => {
    if (id !== "sandbox") return;
    void j(`/api/surveys/sandbox/alerts`, { action: "sync", alerts: s.def.alerts ?? null, title: s.def.meta.title }).catch(() => null);
    void j(`/api/surveys/sandbox/panels`, { action: "sync", panels: s.def.panels ?? [] }).then(() => refresh()).catch(() => null);
  }, [id, alertsJson, panelsJson]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = (actions: unknown[], label: string): boolean => {
    const c = coerceSurveyActions(actions as never);
    if (c.rejected.length) { setMsg({ ok: false, text: c.rejected.map((r) => r.reason).join(" ") }); return false; }
    const r = applySurveyActions(s.def, c.actions);
    if (r.errors.length) { setMsg({ ok: false, text: r.errors.join(" ") }); return false; }
    s.labelNextEdit(label);
    s.update((d) => { d.alerts = r.def.alerts; d.panels = r.def.panels; d.flow = r.def.flow; d.deployment = r.def.deployment; });
    setMsg({ ok: true, text: [r.results.map((x) => x.description).join(" "), ...r.warnings.slice(0, 3)].join(" — ") });
    return true;
  };

  return (
    <div data-testid="ap-tab">
      <div className="ql-row" style={{ justifyContent: "space-between" }}>
        <p className="ql-muted" style={{ margin: 0 }}>Alerts tell the team when something needs attention — a participant in distress first. Panels bring participants from a sample provider and send them back with the right outcome.</p>
      </div>
      {msg && <div className={`alert ${msg.ok ? "success" : "error"}`} data-testid="ap-msg">{msg.text}</div>}
      <Rules settings={s.def.alerts} channels={channels} me={me} act={act} update={(fn) => { s.labelNextEdit("Alert rules"); s.update((d) => { fn(d); }); }} onTry={async (type) => { try { const r = await j<{ deliveries: { channel: string; destination: string; status: string; reason?: string; error?: string }[] }>(`/api/surveys/${id}/alerts`, { action: "try", type }); setMsg({ ok: true, text: r.deliveries.length ? `Sample sent: ${r.deliveries.map((d) => `${d.destination} ${d.status}${d.reason || d.error ? ` (${d.reason ?? d.error})` : ""}`).join("; ")}` : "No rule sends this event anywhere." }); void refresh(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } }} />
      <ChannelsBox info={channels} onChange={refresh} surveyId={id} />
      <Deliveries rows={deliveries} />
      <Panels def={s.def.panels ?? []} info={panels} surveyId={id} act={act} refresh={refresh} setMsg={setMsg} setEnds={(url) => { s.labelNextEdit("Signed panel exits"); s.update((d) => { const walk = (ns: unknown[]) => { for (const n of ns as { type: string; redirectUrl?: string; children?: unknown[]; branches?: { children: unknown[] }[]; otherwise?: unknown[] }[]) { if (n.type === "end") n.redirectUrl = url; if (n.children) walk(n.children); if (n.branches) for (const b of n.branches) walk(b.children); if (n.otherwise) walk(n.otherwise); } }; walk(d.flow); }); setMsg({ ok: true, text: "Every survey end now goes through the signed exit. Save and deploy the survey for the change to reach the link." }); }} />
    </div>
  );
}

/* ------------------------------------------------------------ rules */

const EVENT_TYPES = (Object.keys(NOTIFY_EVENTS) as (keyof typeof NOTIFY_EVENTS)[]).filter((t) => t !== "notify.test");

function Rules({ settings, channels, me, act, update, onTry }: { settings: AlertSettings | undefined; channels: ChannelsInfo | null; me: string | null; act: (a: unknown[], label: string) => boolean; update: (fn: (d: { alerts?: AlertSettings }) => void) => void; onTry: (type: string) => void }) {
  const cur = AlertSettingsSchema.parse(settings ?? {});
  const [events, setEvents] = React.useState<string[]>(["ai_interview.distress"]);
  const [kind, setKind] = React.useState<"in_app" | "email" | "slack" | "teams" | "webhook">("in_app");
  const [to, setTo] = React.useState("@me");
  const [digest, setDigest] = React.useState<"immediate" | "hourly" | "daily">("immediate");
  const [qs, setQs] = React.useState(cur.quietHours?.start ?? ""), [qe, setQe] = React.useState(cur.quietHours?.end ?? ""), [tz, setTz] = React.useState(cur.quietHours?.timeZone ?? "");
  const [cap, setCap] = React.useState(String(cur.maxPerHour));
  const options = kind === "in_app" ? ["@me", "@team"] : kind === "email" ? ["@me", "@team", ...(channels?.channels.filter((c) => c.kind === "email").map((c) => c.name) ?? [])] : (channels?.channels.filter((c) => c.kind === kind).map((c) => c.name) ?? []);
  React.useEffect(() => { if (!options.includes(to) && kind !== "email") setTo(options[0] ?? ""); }, [kind, channels]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = () => { if (act([{ op: "configure_alerts", events, channels: [{ kind, to }], digest }], "Alert rule")) setEvents(["ai_interview.distress"]); };
  return (
    <div className="card ql-section" data-testid="al-rules">
      <div className="eyebrow">Alerts for this study</div>
      {!cur.rules.length && <p className="ql-muted" data-testid="al-default">No rule yet: high-priority events (distress, abuse, injection attempts, the cost cap, quotas and targets) go to the project team's bell.</p>}
      {cur.rules.map((r) => (
        <div key={r.id} className="ql-row" data-testid="al-rule" data-id={r.id} style={{ borderTop: "1px solid var(--line, #eee)", padding: "6px 0", flexWrap: "wrap" }}>
          <span><b>{r.events.map((e) => (e === "*" ? "every event" : NOTIFY_EVENTS[e as keyof typeof NOTIFY_EVENTS]?.label ?? e)).join(", ")}</b> → {r.channels.map((c) => `${CHANNEL_KIND_LABELS[c.kind]} ${c.to === "@me" ? `(you${r.claimedBy ? "" : " — the owner until claimed"})` : c.to === "@team" ? "(the team)" : c.to}`).join(", ")}{r.digest !== "immediate" ? ` · ${r.digest} digest` : ""}{!r.enabled ? " · off" : ""}</span>
          <span className="grow" />
          {r.channels.some((c) => c.to === "@me") && me && r.claimedBy !== me && <button type="button" className="btn small" data-testid="al-claim" onClick={() => update((d) => { const x = d.alerts?.rules.find((y) => y.id === r.id); if (x) x.claimedBy = me; })}>“me” is me</button>}
          <button type="button" className="btn small" onClick={() => update((d) => { const x = d.alerts?.rules.find((y) => y.id === r.id); if (x) x.enabled = !x.enabled; })}>{r.enabled ? "Turn off" : "Turn on"}</button>
          <button type="button" className="btn small" data-testid="al-remove" onClick={() => update((d) => { if (d.alerts) d.alerts.rules = d.alerts.rules.filter((y) => y.id !== r.id); })}>Remove</button>
        </div>
      ))}
      <details style={{ marginTop: 8 }} open={!cur.rules.length}>
        <summary>Add a rule</summary>
        <div className="ql-row" style={{ flexWrap: "wrap", gap: 6 }}>
          {EVENT_TYPES.map((t) => <label key={t} className="chip"><input type="checkbox" data-testid={`al-ev-${t}`} checked={events.includes(t)} onChange={(e) => setEvents(e.target.checked ? [...events, t] : events.filter((x) => x !== t))} /> {NOTIFY_EVENTS[t].label}</label>)}
        </div>
        <div className="ql-row" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: 8 }}>
          <label className="f"><span>Send to</span><select className="input" data-testid="al-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>{(["in_app", "email", "slack", "teams", "webhook"] as const).map((k) => <option key={k} value={k}>{CHANNEL_KIND_LABELS[k]}</option>)}</select></label>
          <label className="f"><span>Who / which channel</span>
            {kind === "email" ? <input className="input" data-testid="al-to" list="al-to-list" value={to} onChange={(e) => setTo(e.target.value)} placeholder="@me, @team, an address or a list" /> : <select className="input" data-testid="al-to" value={to} onChange={(e) => setTo(e.target.value)}>{options.length ? options.map((o) => <option key={o} value={o}>{o === "@me" ? "me" : o === "@team" ? "the project team" : o}</option>) : <option value="">— add a {CHANNEL_KIND_LABELS[kind]} channel below —</option>}</select>}
            <datalist id="al-to-list">{options.map((o) => <option key={o} value={o} />)}</datalist>
          </label>
          <label className="f"><span>When</span><select className="input" data-testid="al-digest" value={digest} onChange={(e) => setDigest(e.target.value as typeof digest)}><option value="immediate">immediately</option><option value="hourly">hourly digest</option><option value="daily">daily digest</option></select></label>
          <button type="button" className="btn primary" data-testid="al-add" disabled={!events.length || !to} onClick={add}>Add rule</button>
        </div>
      </details>
      <div className="ql-row" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: 8, marginTop: 8 }}>
        <label className="f"><span>Quiet hours from</span><input className="input" data-testid="al-quiet-start" placeholder="22:00" value={qs} onChange={(e) => setQs(e.target.value)} style={{ width: 80 }} /></label>
        <label className="f"><span>to</span><input className="input" data-testid="al-quiet-end" placeholder="07:00" value={qe} onChange={(e) => setQe(e.target.value)} style={{ width: 80 }} /></label>
        <label className="f"><span>time zone</span><input className="input" data-testid="al-quiet-tz" placeholder="Asia/Kolkata" value={tz} onChange={(e) => setTz(e.target.value)} style={{ width: 140 }} /></label>
        <label className="f"><span>At most per hour per channel</span><input className="input" type="number" min={1} max={500} data-testid="al-cap" value={cap} onChange={(e) => setCap(e.target.value)} style={{ width: 90 }} /></label>
        <button type="button" className="btn" data-testid="al-save-settings" onClick={() => act([{ op: "configure_alerts", quietHours: qs && qe ? { start: qs, end: qe, ...(tz ? { timeZone: tz } : {}) } : null, maxPerHour: Number(cap) || 30 }], "Alert settings")}>Save</button>
        <span className="grow" />
        <button type="button" className="btn" data-testid="al-try" onClick={() => onTry(events[0] ?? "ai_interview.distress")}>Try the rules (sample)</button>
      </div>
      <p className="ql-muted" style={{ fontSize: 12 }}>Distress alerts always go out immediately, even in quiet hours. A channel receives the study, the participant's pseudonymous id (P3), a short redacted excerpt and a link — never their full words or identity.</p>
    </div>
  );
}

function Deliveries({ rows }: { rows: Delivery[] }) {
  const BADGE: Record<string, string> = { sent: "success", digested: "success", failed: "error", retrying: "warning", digest_pending: "info", skipped: "neutral", not_configured: "warning", queued: "neutral" };
  return (
    <div className="card ql-section" data-testid="dl-box">
      <div className="eyebrow">Delivery log</div>
      {!rows.length ? <p className="ql-muted">Nothing sent yet.</p> : (
        <div className="table-wrap"><table className="grid"><thead><tr><th>When</th><th>Event</th><th>Channel</th><th>To</th><th>Status</th><th>Attempts</th></tr></thead><tbody>
          {rows.map((d) => (
            <tr key={d.id} data-testid="dl-row" data-status={d.status} data-channel={d.channel} data-event={d.eventType}>
              <td>{new Date(d.createdAt).toLocaleString()}</td><td>{NOTIFY_EVENTS[d.eventType as keyof typeof NOTIFY_EVENTS]?.label ?? d.eventType}{d.test ? " (test)" : ""}</td><td>{d.channel}</td><td className="mono" style={{ fontSize: 12 }}>{d.destination}</td>
              <td><span className={`badge ${BADGE[d.status] ?? "neutral"}`} title={d.error ?? d.reason ?? ""}>{d.status.replace("_", " ")}</span>{(d.error || d.reason) && <div className="ql-muted" style={{ fontSize: 11 }}>{d.error ?? d.reason}</div>}{d.nextAttemptAt && <div className="ql-muted" style={{ fontSize: 11 }}>next: {new Date(d.nextAttemptAt).toLocaleTimeString()}</div>}</td>
              <td>{d.attempts}{d.responseStatus ? ` · ${d.responseStatus}` : ""}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ panels */

function Panels({ def, info, surveyId, act, refresh, setMsg, setEnds }: { def: PanelConfig[]; info: { panels: PanelInfo[]; entries: Entry[]; secretsReady: boolean } | null; surveyId: string; act: (a: unknown[], label: string) => boolean; refresh: () => Promise<void>; setMsg: (m: { ok: boolean; text: string } | null) => void; setEnds: (url: string) => void }) {
  const [preset, setPreset] = React.useState<PanelPresetId>("prolific");
  const [code, setCode] = React.useState("");
  const [scode, setScode] = React.useState("");
  const [targets, setTargets] = React.useState<PanelTarget[]>(["ai_interview", "group_session", "live_session", "survey"]);
  const [target, setTarget] = React.useState("");
  const add = () => { if (act([{ op: "connect_panel", panel: preset, ...(code ? { completionCode: code } : {}), ...(scode ? { codes: { screenout: scode } } : {}), targets, ...(target ? { completesTarget: Number(target) } : {}) }], "Panel")) { setCode(""); setScode(""); } };
  return (
    <div className="card ql-section" data-testid="pn-box">
      <div className="eyebrow">Panels</div>
      {!def.length && <p className="ql-muted">No panel connected: participants are let in by the link alone (an AI interview link still passes a <code>?pid=</code> to its redirect).</p>}
      {def.map((p) => <PanelCard key={p.key} p={p} info={info?.panels.find((x) => x.key === p.key) ?? null} many={def.length > 1} surveyId={surveyId} secretsReady={info?.secretsReady ?? false} act={act} refresh={refresh} setMsg={setMsg} setEnds={setEnds} />)}
      <details style={{ marginTop: 8 }} open={!def.length}>
        <summary>Connect a panel</summary>
        <div className="ql-row" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: 8 }}>
          <label className="f"><span>Panel</span><select className="input" data-testid="pn-preset" value={preset} onChange={(e) => setPreset(e.target.value as PanelPresetId)}>{Object.values(PANEL_PRESETS).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
          <label className="f"><span>Completion code</span><input className="input" data-testid="pn-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABC123" /></label>
          <label className="f"><span>Screen-out code</span><input className="input" data-testid="pn-screenout-code" value={scode} onChange={(e) => setScode(e.target.value)} placeholder="optional" /></label>
          <label className="f"><span>Completes bought</span><input className="input" type="number" min={1} data-testid="pn-target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="optional" style={{ width: 110 }} /></label>
          <button type="button" className="btn primary" data-testid="pn-add" onClick={add}>Connect</button>
        </div>
        <div className="ql-row" style={{ flexWrap: "wrap", gap: 6 }}>
          {(["ai_interview", "group_session", "live_session", "survey"] as const).map((t) => <label key={t} className="chip"><input type="checkbox" checked={targets.includes(t)} onChange={(e) => setTargets(e.target.checked ? [...targets, t] : targets.filter((x) => x !== t))} /> {t.replace("_", " ")}</label>)}
        </div>
        <p className="ql-muted" style={{ fontSize: 12 }}>{PANEL_PRESETS[preset].how} {PANEL_PRESETS[preset].verify}</p>
      </details>
      {(info?.entries.length ?? 0) > 0 && (
        <>
          <div className="ql-row" style={{ marginTop: 8 }}><b>Entries</b><span className="grow" /><a className="btn small" data-testid="pn-csv" href={`/api/surveys/${surveyId}/panels?export=reconciliation`}>Reconciliation CSV</a></div>
          <div className="table-wrap"><table className="grid"><thead><tr><th>Panel</th><th>Panel id</th><th>Link</th><th>Outcome</th><th>Started</th></tr></thead><tbody>
            {info!.entries.map((e) => <tr key={e.id} data-testid="pn-entry" data-pid={e.pid} data-outcome={e.outcome ?? ""}><td>{e.panel}</td><td className="mono">{e.pid}{e.test ? " (test)" : ""}</td><td>{e.target.replace("_", " ")}</td><td>{e.outcome ? <span className={`badge ${e.outcome === "complete" ? "success" : "neutral"}`}>{PANEL_OUTCOME_LABELS[e.outcome as PanelOutcome] ?? e.outcome}</span> : <span className="ql-muted">in progress</span>}{e.signed ? " · signed" : ""}</td><td>{new Date(e.startedAt).toLocaleString()}</td></tr>)}
          </tbody></table></div>
        </>
      )}
    </div>
  );
}

function PanelCard({ p, info, many, surveyId, secretsReady, act, refresh, setMsg, setEnds }: { p: PanelConfig; info: PanelInfo | null; many: boolean; surveyId: string; secretsReady: boolean; act: (a: unknown[], label: string) => boolean; refresh: () => Promise<void>; setMsg: (m: { ok: boolean; text: string } | null) => void; setEnds: (url: string) => void }) {
  const [secret, setSecret] = React.useState("");
  const [outcome, setOutcome] = React.useState<PanelOutcome>("complete");
  const [pid, setPid] = React.useState("TEST_PID");
  const [testUrl, setTestUrl] = React.useState<{ url: string | null; code: string | null; signed: boolean; problems: string[] } | null>(null);
  const saveSecret = async (clear = false) => {
    try { await j(`/api/surveys/${surveyId}/panels`, clear ? { action: "clear-secret", key: p.key } : { action: "secret", key: p.key, secret }); setSecret(""); setMsg({ ok: true, text: clear ? "Secret cleared." : "Secret stored, encrypted." }); await refresh(); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  const tryLink = async () => { try { setTestUrl(await j(`/api/surveys/${surveyId}/panels`, { action: "test-link", key: p.key, outcome, pid })); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } };
  const counts = info?.counts ?? {};
  return (
    <div className="card" style={{ margin: "8px 0", padding: 10 }} data-testid="pn-card" data-key={p.key}>
      <div className="ql-row" style={{ flexWrap: "wrap" }}>
        <b>{p.label}</b><span className="chip">{p.key}</span><span className="chip">id: {p.idParam}</span>
        {p.codes.complete && <span className="chip">code {p.codes.complete}</span>}
        {p.completesTarget && <span className="chip">{counts.complete ?? 0}/{p.completesTarget} completes</span>}
        {!p.enabled && <span className="badge neutral">paused</span>}
        <span className="grow" />
        {(["complete", "screenout", "quota_full", "terminate", "over_quota", "in_progress"] as const).filter((k) => counts[k]).map((k) => <span key={k} className="badge neutral" data-testid="pn-count" data-outcome={k}>{k === "in_progress" ? "in progress" : PANEL_OUTCOME_LABELS[k]}: {counts[k]}</span>)}
        <button type="button" className="btn small" data-testid="pn-remove" onClick={() => { if (window.confirm(`Disconnect ${p.label}?`)) act([{ op: "disconnect_panel", key: p.key }], "Panel"); }}>Disconnect</button>
      </div>
      {(info?.problems.length ?? 0) > 0 && <div className="alert warning" data-testid="pn-problems">{info!.problems.join(" · ")}</div>}
      <div className="ql-muted" style={{ fontSize: 12 }}>Give the panel your link with: <code data-testid="pn-entry-link">{panelEntryLink("<your link>", p, { many })}</code></div>
      <div className="ql-row" style={{ flexWrap: "wrap", gap: 6, fontSize: 12 }}>{PANEL_OUTCOMES.filter((o) => p.redirects[o]).map((o) => <span key={o} className="mono" title={p.redirects[o]}>{PANEL_OUTCOME_LABELS[o]}: {p.redirects[o]!.slice(0, 70)}{p.redirects[o]!.length > 70 ? "…" : ""}</span>)}{p.showCode && <span>· the code is shown on the thank-you page</span>}</div>
      {p.signing.algorithm !== "none" && (
        <div className="ql-row" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: 8 }}>
          <span>Signed ({p.signing.algorithm}, {p.signing.scope}, {p.signing.encoding}, as <code>{p.signing.param}</code>):</span>
          <span data-testid="pn-secret-state" data-set={info?.secret?.set ? "1" : "0"}>{info?.secret?.set ? `secret set (${info.secret.hint ?? "••••"})` : "no secret yet — end links go unsigned"}</span>
          {secretsReady ? <><input className="input" type="password" autoComplete="off" data-testid="pn-secret" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="the panel's hashing key" /><button type="button" className="btn small" data-testid="pn-secret-save" disabled={secret.length < 4} onClick={() => saveSecret()}>Save secret</button>{info?.secret?.set && <button type="button" className="btn small" onClick={() => saveSecret(true)}>Clear</button>}</> : <span className="ql-muted">(the server has no INTEGRATIONS_SECRET_KEY)</span>}
        </div>
      )}
      <div className="ql-row" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: 8 }}>
        <span>Test link:</span>
        <select className="input" data-testid="pn-test-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as PanelOutcome)}>{PANEL_OUTCOMES.map((o) => <option key={o} value={o}>{PANEL_OUTCOME_LABELS[o]}</option>)}</select>
        <input className="input" data-testid="pn-test-pid" value={pid} onChange={(e) => setPid(e.target.value)} style={{ width: 140 }} />
        <button type="button" className="btn small" data-testid="pn-test-go" onClick={tryLink}>Show</button>
        {p.targets.includes("survey") && <button type="button" className="btn small" data-testid="pn-signed-exits" title="Every survey end goes through the runtime's exit, which reads the response's real outcome and signs the panel's link on the server" onClick={() => setEnds(`${runtimeBaseUrl()}/api/panel/exit?r={{response.id}}`)}>Use signed exits on the survey's ends</button>}
      </div>
      {testUrl && <div className="mono" style={{ fontSize: 12, wordBreak: "break-all" }} data-testid="pn-test-url" data-signed={testUrl.signed ? "1" : "0"}>{testUrl.url ?? `(no link${testUrl.code ? ` — code ${testUrl.code} shown` : ""})`}{testUrl.problems.length ? ` · ${testUrl.problems.join("; ")}` : ""}</div>}
    </div>
  );
}
