"use client";
import React from "react";

/**
 * YOUR API KEYS (audit 2026-11-17, P2-13) — on the Security page. A key acts as you, never beyond your own project
 * roles, within the scopes you tick. Shown once on creation; revoke takes effect on the next request.
 */
type Key = { id: string; name: string; prefix: string; scopes: string[]; created_at: string; expires_at: string | null; last_used_at: string | null; revoked_at: string | null };
const day = (s: string | null) => (s ? s.slice(0, 10) : "—");

export function ApiKeysCard() {
  const [keys, setKeys] = React.useState<Key[] | null>(null);
  const [scopes, setScopes] = React.useState<{ id: string; label: string }[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [picked, setPicked] = React.useState<Set<string>>(new Set(["surveys:read", "responses:read"]));
  const [days, setDays] = React.useState("90");
  const [fresh, setFresh] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const load = React.useCallback(async () => {
    const r = await fetch("/api/account/api-keys", { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setError(j.error ?? `Keys could not be listed (${r.status}).`); setKeys([]); return; }
    setKeys(j.keys); setScopes(j.scopes ?? []);
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  const create = async () => {
    setBusy(true); setError(null); setFresh(null);
    const r = await fetch("/api/account/api-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, scopes: [...picked], expiresInDays: Number(days) || 0 }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setError(j.error ?? `Failed (${r.status}).`); return; }
    setFresh(j.key); setName(""); void load();
  };
  const revoke = async (id: string) => {
    if (!window.confirm("Revoke this key? Anything using it stops working on its next request.")) return;
    const r = await fetch(`/api/account/api-keys?id=${id}`, { method: "DELETE" });
    if (!r.ok) { const j = await r.json().catch(() => ({})); setError(j.error ?? "Could not revoke."); }
    void load();
  };
  return (
    <div className="card" style={{ padding: 16, marginTop: 16 }} data-testid="api-keys">
      <h3 style={{ marginTop: 0 }}>API keys</h3>
      <p className="muted" style={{ fontSize: 13.5 }}>For scripts and integrations reading your projects through the REST API (<code>/api/v1</code>, see the developer docs, “HTTP API”). A key can do only what you can do, within the scopes you give it.</p>
      {error && <div className="auth-note err">{error}</div>}
      {fresh && (
        <div className="auth-note" data-testid="api-key-fresh">
          <strong>Copy this key now — it is not shown again.</strong>
          <div className="mono" style={{ userSelect: "all", marginTop: 6, wordBreak: "break-all" }}>{fresh}</div>
        </div>
      )}
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", margin: "8px 0" }}>
        <input className="input" style={{ width: 220 }} placeholder="Name, e.g. Power BI refresh" value={name} onChange={(e) => setName(e.target.value)} data-testid="api-key-name" />
        {scopes.map((s) => (
          <label key={s.id} className="row" style={{ gap: 4, fontSize: 13 }} title={s.label}>
            <input type="checkbox" checked={picked.has(s.id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(s.id); else n.delete(s.id); setPicked(n); }} /> {s.id}
          </label>
        ))}
        <select className="select" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 150 }}>
          <option value="30">Expires in 30 days</option><option value="90">Expires in 90 days</option><option value="365">Expires in a year</option><option value="0">Never expires</option>
        </select>
        <button className="btn primary" disabled={busy || !name.trim() || !picked.size} onClick={create} data-testid="api-key-create">Create key</button>
      </div>
      {keys && keys.length > 0 && (
        <table className="table" style={{ width: "100%", fontSize: 13 }}>
          <thead><tr><th>Name</th><th>Key</th><th>Scopes</th><th>Created</th><th>Last used</th><th>Expires</th><th /></tr></thead>
          <tbody>{keys.map((k) => (
            <tr key={k.id} style={k.revoked_at ? { opacity: 0.55 } : undefined}>
              <td>{k.name}</td><td className="mono">{k.prefix}…</td><td>{k.scopes.join(", ")}</td><td>{day(k.created_at)}</td><td>{day(k.last_used_at)}</td><td>{day(k.expires_at)}</td>
              <td>{k.revoked_at ? `revoked ${day(k.revoked_at)}` : <button className="btn small danger" onClick={() => revoke(k.id)}>Revoke</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}
