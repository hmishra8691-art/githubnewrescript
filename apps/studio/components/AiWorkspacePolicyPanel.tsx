"use client";
import React from "react";
import { api } from "@/lib/useSession";

/**
 * USER-MANAGED AI BY WORKSPACE (administrators). One switch per workspace: may its
 * members use their own AI provider? Off keeps the organisation's survey content off
 * personal providers; nothing a member saved is deleted, and nobody is moved to the
 * platform's AI behind their back — their features say why they cannot run.
 */
interface Row { id: string; name: string; slug: string; allowed: boolean }

export function AiWorkspacePolicyPanel() {
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const r = await api<{ workspaces: Row[] }>("/api/admin/ai-policy");
    if (r.ok) { setRows(r.data.workspaces); setError(null); } else setError(r.error);
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const set = async (row: Row, allowed: boolean) => {
    setBusy(row.id);
    const r = await api<{ ok: true }>("/api/admin/ai-policy", { method: "PATCH", json: { customerId: row.id, allowed } });
    setBusy(null);
    if (!r.ok) { setError(r.error); return; }
    setRows((cur) => cur?.map((x) => (x.id === row.id ? { ...x, allowed } : x)) ?? cur);
  };

  return (
    <div style={{ marginTop: 22 }} data-testid="ai-workspace-policy">
      <strong>User-managed AI by workspace</strong>
      <p className="iqi-dim" style={{ margin: "6px 0 10px" }}>
        Members can connect their own AI provider (Settings → AI &amp; Integrations). Turn it off for a workspace whose survey content must not go to personal providers. Nothing a member saved is deleted, and their AI is not moved to the platform's — the feature says why it cannot run.
      </p>
      {error && <div className="auth-note err">{error}</div>}
      {!rows && !error && <p className="muted">Loading…</p>}
      {rows && rows.length === 0 && <p className="muted">No workspaces yet.</p>}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table className="grid">
            <thead><tr><th>Workspace</th><th>Members may use their own AI provider</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid="ai-workspace-row" data-allowed={r.allowed ? "1" : "0"}>
                  <td>{r.name} <span className="muted mono">{r.slug}</span></td>
                  <td>
                    <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                      <input type="checkbox" checked={r.allowed} disabled={busy === r.id} onChange={(e) => void set(r, e.target.checked)} data-testid="ai-workspace-toggle" />
                      {r.allowed ? "Allowed" : "Off"}
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
