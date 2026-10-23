"use client";
import React from "react";

/**
 * AN ORGANISATION'S ALERT CHANNELS (2026-10-22, G3) — Slack, Microsoft Teams, a signed webhook, an e-mail list.
 * Used by Settings → Alerts and by Research Tools → Qualitative → Alerts & panels. A webhook address is typed once
 * and never shown again (the server seals it; this lists the masked hint); a webhook's signing secret is shown
 * once, right after it is created. "Send test" posts a test alert now and shows what the endpoint answered.
 */
export interface ChannelView { id: string; kind: "slack" | "teams" | "webhook" | "email"; name: string; hint: string | null; to?: string[]; enabled: boolean; lastTestAt: string | null; lastStatus: string | null }
export interface ChannelsInfo { channels: ChannelView[]; secrets: { ready: boolean; reason?: string }; mail: { configured: boolean }; canManage: boolean; sandbox?: boolean }

const KIND_WORD = { slack: "Slack", teams: "Microsoft Teams", webhook: "Webhook", email: "E-mail list" } as const;

export async function loadChannels(): Promise<ChannelsInfo> {
  const r = await fetch("/api/notify/channels", { cache: "no-store" });
  const b = await r.json().catch(() => null);
  if (!r.ok) throw new Error(b?.error ?? `could not load the channels (${r.status})`);
  return b as ChannelsInfo;
}

export function ChannelsBox({ info, onChange, surveyId }: { info: ChannelsInfo | null; onChange: () => void; surveyId?: string }) {
  const [kind, setKind] = React.useState<ChannelView["kind"]>("slack");
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [to, setTo] = React.useState("");
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const send = async (method: string, body?: unknown, query = "") => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/notify/channels${query}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok && !("status" in b)) throw new Error(b.error ?? `failed (${r.status})`);
      return b as Record<string, unknown>;
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); return null; } finally { setBusy(false); }
  };
  const add = async () => {
    const b = await send("POST", kind === "email" ? { kind, name, to } : { kind, name, url });
    if (!b) return;
    setName(""); setUrl(""); setTo("");
    if (b.signingSecret) setSecret(String(b.signingSecret));
    setMsg({ ok: true, text: `Added ${KIND_WORD[kind]} “${(b.channel as ChannelView).name}”.` });
    onChange();
  };
  const test = async (c: ChannelView) => {
    const b = await send("POST", { action: "test", id: c.id, ...(surveyId ? { surveyId } : {}) });
    if (!b) return;
    setMsg({ ok: b.status === "sent", text: b.status === "sent" ? `Test sent to ${c.name}.` : `Test to ${c.name}: ${String(b.error ?? b.status)}` });
    onChange();
  };
  if (!info) return <div className="sk" style={{ height: 60 }} />;
  return (
    <div className="card ql-section" data-testid="ch-box">
      <div className="eyebrow">Channels of your organisation</div>
      {!info.secrets.ready && <div className="alert warning" data-testid="ch-secrets-off">Slack, Teams and webhook channels need INTEGRATIONS_SECRET_KEY on the server (their addresses are secrets and are never stored unencrypted). {info.secrets.reason ?? ""}</div>}
      {!info.mail.configured && <p className="ql-muted" data-testid="ch-mail-off">E-mail alerts are logged as “not configured” until RESEND_API_KEY and MAIL_FROM are set.</p>}
      {info.channels.length === 0 ? <p className="ql-muted">No channels yet. In-app alerts (the bell) always work.</p> : (
        <div className="table-wrap"><table className="grid"><thead><tr><th>Channel</th><th>Kind</th><th>Address</th><th>Last test</th><th /></tr></thead><tbody>
          {info.channels.map((c) => (
            <tr key={c.id} data-testid="ch-row" data-kind={c.kind} data-name={c.name}>
              <td><b>{c.name}</b>{!c.enabled && <span className="badge neutral">off</span>}</td><td>{KIND_WORD[c.kind]}</td>
              <td className="mono" style={{ fontSize: 12 }}>{c.kind === "email" ? (c.to ?? []).join(", ") : c.hint}</td>
              <td data-testid="ch-status">{c.lastStatus ? <span className={`badge ${c.lastStatus === "ok" ? "success" : "error"}`} title={c.lastTestAt ?? ""}>{c.lastStatus === "ok" ? "ok" : c.lastStatus.slice(0, 80)}</span> : <span className="ql-muted">—</span>}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                <button type="button" className="btn small" disabled={busy} data-testid="ch-test" onClick={() => test(c)}>Send test</button>
                {info.canManage && <button type="button" className="btn small" disabled={busy} onClick={async () => { if (await send("PATCH", { id: c.id, enabled: !c.enabled })) onChange(); }}>{c.enabled ? "Turn off" : "Turn on"}</button>}
                {info.canManage && <button type="button" className="btn small" disabled={busy} data-testid="ch-remove" onClick={async () => { if (window.confirm(`Remove ${c.name}? Rules that name it will log “not connected”.`) && (await send("DELETE", undefined, `?id=${encodeURIComponent(c.id)}`))) onChange(); }}>Remove</button>}
              </td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      {info.canManage && (
        <div className="ql-row" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: 8, marginTop: 8 }}>
          <label className="f"><span>Kind</span><select className="input" data-testid="ch-kind" value={kind} onChange={(e) => setKind(e.target.value as ChannelView["kind"])}>{(Object.keys(KIND_WORD) as ChannelView["kind"][]).map((k) => <option key={k} value={k}>{KIND_WORD[k]}</option>)}</select></label>
          <label className="f"><span>Name</span><input className="input" data-testid="ch-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "slack" ? "#research-ops" : kind === "email" ? "Ops list" : "Ops webhook"} /></label>
          {kind === "email"
            ? <label className="f" style={{ flex: 2 }}><span>Addresses</span><input className="input" data-testid="ch-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="ops@example.com, lead@example.com" /></label>
            : <label className="f" style={{ flex: 3 }}><span>{kind === "slack" ? "Incoming-webhook URL (Slack → Apps → Incoming Webhooks)" : kind === "teams" ? "Teams incoming webhook / Workflows URL" : "Endpoint (https)"}</span><input className="input" type="password" autoComplete="off" data-testid="ch-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></label>}
          <button type="button" className="btn primary" disabled={busy || !name.trim() || (kind === "email" ? !to.trim() : !url.trim())} data-testid="ch-add" onClick={add}>Add channel</button>
        </div>
      )}
      {secret && <div className="alert info" data-testid="ch-signing-secret">Signing secret (shown once — copy it now): <code className="mono">{secret}</code>. Each POST carries <code>X-Rescript-Signature: t=…,v1=…</code> — HMAC-SHA256 of “t.body” with this secret — plus <code>Idempotency-Key</code>. <button type="button" className="btn small" onClick={() => setSecret(null)}>Done</button></div>}
      {msg && <div className={`alert ${msg.ok ? "success" : "error"}`} data-testid="ch-msg">{msg.text}</div>}
    </div>
  );
}
