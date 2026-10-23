"use client";
import React from "react";
import { AccountHeader } from "@/components/AccountHeader";
import { ChannelsBox, loadChannels, type ChannelsInfo } from "@/components/notify/ChannelsBox";
import { useSession } from "@/lib/useSession";

/**
 * SETTINGS → ALERTS (2026-10-22, G3) — the organisation's alert channels (Slack, Microsoft Teams, signed webhooks,
 * e-mail lists) and its own rules, which apply to every study on top of the study's rules (Research Tools →
 * Qualitative → Alerts & panels). Changing them: programmers, researchers and administrators of the organisation.
 */
type Rule = { id: string; events: string[]; channels: { kind: string; to: string }[]; digest: "immediate" | "hourly" | "daily"; enabled: boolean };
type Settings = { rules: Rule[]; quietHours?: { start: string; end: string; timeZone?: string; bypassCritical: boolean }; maxPerHour: number; dedupeMinutes: number };
type Delivery = { id: string; eventType: string; channel: string; destination: string; status: string; reason: string | null; error: string | null; attempts: number; createdAt: string };

export default function AlertSettingsPage() {
  const { state, signOut } = useSession({ redirectOnSignOut: true });
  const user = state.kind === "signed_in" ? state.user : null;
  const [channels, setChannels] = React.useState<ChannelsInfo | null>(null);
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [events, setEvents] = React.useState<{ type: string; label: string; severity: string }[]>([]);
  const [canManage, setCanManage] = React.useState(false);
  const [log, setLog] = React.useState<Delivery[]>([]);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [draft, setDraft] = React.useState<{ events: string[]; kind: string; to: string; digest: Rule["digest"] }>({ events: ["ai_interview.distress"], kind: "email", to: "", digest: "immediate" });

  const refresh = React.useCallback(async () => {
    try { setChannels(await loadChannels()); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    const r = await fetch("/api/notify/rules", { cache: "no-store" }).then((x) => x.json()).catch(() => null);
    if (r?.ok) { setSettings(r.settings); setEvents(r.events); setCanManage(!!r.canManage); }
    const d = await fetch("/api/notify/deliveries?limit=50", { cache: "no-store" }).then((x) => x.json()).catch(() => null);
    if (d?.ok) setLog(d.deliveries);
  }, []);
  React.useEffect(() => { if (user) void refresh(); }, [user, refresh]);

  const save = async (next: Settings) => {
    const r = await fetch("/api/notify/rules", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: next }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg({ ok: false, text: b.error ?? "not saved" }); return; }
    setSettings(b.settings); setMsg({ ok: true, text: "Saved." });
  };
  const addRule = () => {
    if (!settings || !draft.events.length || !draft.to.trim()) return;
    let n = 1; while (settings.rules.some((r) => r.id === `o${n}`)) n++;
    void save({ ...settings, rules: [...settings.rules, { id: `o${n}`, events: draft.events, channels: [{ kind: draft.kind, to: draft.to.trim() }], digest: draft.digest, enabled: true }] });
  };

  return (
    <div className="acct-shell">
      <AccountHeader active="ai" user={user} onSignOut={signOut} />
      <p className="muted" style={{ fontSize: 14, lineHeight: 1.55, maxWidth: 760 }}>Settings · <strong>Alerts</strong> — where your organisation hears about distress flags, abuse, quotas, targets, the AI budget and provider trouble. A study adds its own rules under Research Tools → Qualitative → Alerts &amp; panels.</p>
      {msg && <div className={`alert ${msg.ok ? "success" : "error"}`}>{msg.text}</div>}
      <ChannelsBox info={channels} onChange={refresh} />
      {settings && (
        <div className="card ql-section" data-testid="org-rules">
          <div className="eyebrow">Organisation rules (every study)</div>
          {!settings.rules.length && <p className="muted">None: a study's own rules apply, and without any rule high-priority events go to each project team's bell.</p>}
          {settings.rules.map((r) => (
            <div key={r.id} className="row" style={{ gap: 8, borderTop: "1px solid #eee", padding: "6px 0" }}>
              <span><b>{r.events.map((e) => events.find((x) => x.type === e)?.label ?? e).join(", ")}</b> → {r.channels.map((c) => `${c.kind} ${c.to}`).join(", ")}{r.digest !== "immediate" ? ` (${r.digest})` : ""}</span>
              <span style={{ flex: 1 }} />
              {canManage && <button type="button" className="btn small" onClick={() => save({ ...settings, rules: settings.rules.filter((x) => x.id !== r.id) })}>Remove</button>}
            </div>
          ))}
          {canManage && (
            <div style={{ marginTop: 8 }}>
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>{events.map((e) => <label key={e.type} className="chip"><input type="checkbox" checked={draft.events.includes(e.type)} onChange={(x) => setDraft({ ...draft, events: x.target.checked ? [...draft.events, e.type] : draft.events.filter((y) => y !== e.type) })} /> {e.label}</label>)}</div>
              <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                <select className="input" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>{["email", "slack", "teams", "webhook", "in_app"].map((k) => <option key={k} value={k}>{k}</option>)}</select>
                <input className="input" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} placeholder={draft.kind === "email" ? "ops@example.com or a list name" : draft.kind === "in_app" ? "@team" : "the channel's name"} list="org-channel-names" />
                <datalist id="org-channel-names">{(channels?.channels ?? []).filter((c) => c.kind === draft.kind).map((c) => <option key={c.id} value={c.name} />)}</datalist>
                <select className="input" value={draft.digest} onChange={(e) => setDraft({ ...draft, digest: e.target.value as Rule["digest"] })}><option value="immediate">immediately</option><option value="hourly">hourly digest</option><option value="daily">daily digest</option></select>
                <button type="button" className="btn primary" onClick={addRule}>Add rule</button>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="card ql-section">
        <div className="eyebrow">Recent deliveries</div>
        {!log.length ? <p className="muted">Nothing sent yet.</p> : <table className="grid"><thead><tr><th>When</th><th>Event</th><th>Channel</th><th>To</th><th>Status</th></tr></thead><tbody>{log.map((d) => <tr key={d.id}><td>{new Date(d.createdAt).toLocaleString()}</td><td>{d.eventType}</td><td>{d.channel}</td><td className="mono">{d.destination}</td><td title={d.error ?? d.reason ?? ""}>{d.status}{d.attempts > 1 ? ` (${d.attempts})` : ""}</td></tr>)}</tbody></table>}
      </div>
    </div>
  );
}
