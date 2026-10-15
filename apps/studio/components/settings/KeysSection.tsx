"use client";
import React from "react";
import { api } from "@/lib/useSession";
import { FEATURE_META, providerIndex, testWords, type CredentialView, type Overview } from "@/lib/byok/settingsModel";

/**
 * SAVED API KEYS — what the vault holds for this person, as masks.
 *
 * A key can be added, replaced or removed here, and each row says which
 * features use it. The secret itself is never shown: not after saving, not on
 * reload, not to the person who typed it. Removing a key returns every feature
 * that used it to the platform's AI (explicitly, and this section says so
 * before it happens); a fallback that named it is dropped from its list.
 */

interface Props { overview: Overview; onChanged: (o?: Overview) => void }

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

/** the features (and fallback slots) a key is in use for */
export function usedBy(o: Overview, credentialId: string): string[] {
  const out: string[] = [];
  for (const f of o.features) {
    const title = FEATURE_META[f.feature].title;
    if (f.mode === "user" && f.credential?.id === credentialId) out.push(title);
    else if (f.mode === "user" && f.fallbacks.some((x) => x.credential?.id === credentialId)) out.push(`${title} (fallback)`);
  }
  return out;
}

export function KeysSection({ overview, onChanged }: Props) {
  const idx = React.useMemo(() => providerIndex(overview), [overview]);
  const all = [...overview.catalog, ...overview.sttCatalog, ...overview.translateCatalog].filter((p) => !(p.kind === "translate" && p.id === "llm"));
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [armed, setArmed] = React.useState<string | null>(null);
  const [replacing, setReplacing] = React.useState<string | null>(null);
  const [replacement, setReplacement] = React.useState("");
  const [adding, setAdding] = React.useState({ provider: "", label: "", key: "" });

  React.useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(null), 5000); return () => clearTimeout(t); }, [armed]);

  const add = async () => {
    setBusy("add"); setError(null); setNote(null);
    const r = await api<{ ok: true; credential: CredentialView; created: boolean }>("/api/account/ai/credentials", { method: "POST", json: { provider: adding.provider, apiKey: adding.key, label: adding.label || undefined } });
    setBusy(null);
    if (!r.ok) { setError(r.error); return; }
    setAdding({ provider: "", label: "", key: "" });
    setNote("Key saved. It will only be shown as a mask from now on.");
    onChanged();
  };

  const replace = async (c: CredentialView) => {
    setBusy(c.id); setError(null); setNote(null);
    const r = await api<{ ok: true }>("/api/account/ai/credentials", { method: "POST", json: { provider: c.provider, apiKey: replacement, credentialId: c.id } });
    setBusy(null);
    if (!r.ok) { setError(r.error); return; }
    setReplacing(null); setReplacement("");
    setNote("Key replaced. Run Test connection on the features that use it.");
    onChanged();
  };

  const remove = async (c: CredentialView) => {
    setBusy(c.id); setError(null); setNote(null);
    const r = await api<Overview & { ok: true }>(`/api/account/ai/credentials/${encodeURIComponent(c.id)}`, { method: "DELETE" });
    setBusy(null); setArmed(null);
    if (!r.ok) { setError(r.error); return; }
    setNote("Key removed. Features that used it are back on the platform's AI.");
    onChanged(r.data);
  };

  return (
    <div className="card fe-card" data-testid="ai-keys">
      <div className="card-title">Saved API keys</div>
      <p className="muted fe-blurb">Your keys are stored encrypted and shown only as a mask. One key can serve several features when the provider is the same (a Google Cloud key serves both speech and translation).</p>
      {!overview.vault.ready && <div className="auth-note" data-testid="ai-keys-vault">{overview.vault.reason ?? "Saving your own API key is not enabled on this installation."}</div>}
      {error && <div className="auth-note err" role="alert" data-testid="ai-keys-error">{error}</div>}
      {note && !error && <div className="auth-note ok" role="status" data-testid="ai-keys-note">{note}</div>}

      {overview.credentials.length === 0 ? (
        <p className="muted" data-testid="ai-keys-empty">No keys saved yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="grid" data-testid="ai-keys-table">
            <thead><tr><th>Provider</th><th>Key</th><th>Used by</th><th>Last test</th><th>Added</th><th /></tr></thead>
            <tbody>
              {overview.credentials.map((c) => {
                const uses = usedBy(overview, c.id);
                const t = testWords(c.lastTest);
                return (
                  <React.Fragment key={c.id}>
                    <tr data-testid="ai-key-row" data-id={c.id} data-provider={c.provider}>
                      <td>{idx.get(c.provider)?.label ?? c.provider}{c.label ? <div className="muted" style={{ fontSize: 12.5 }}>{c.label}</div> : null}</td>
                      <td className="mono" data-testid="ai-key-mask">{c.mask}</td>
                      <td>{uses.length ? uses.join(", ") : <span className="muted">Not in use</span>}</td>
                      <td><span className={`chip ${t.tone === "ok" ? "ok" : t.tone === "bad" ? "warn" : ""}`}>{t.tone === "ok" ? "passed" : t.tone === "bad" ? "failed" : "not tested"}</span></td>
                      <td className="muted" style={{ fontSize: 12.5 }}>{when(c.createdAt)}{c.rotatedAt ? <div>Replaced {when(c.rotatedAt)}</div> : null}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button type="button" className="btn small" onClick={() => { setReplacing(replacing === c.id ? null : c.id); setReplacement(""); }} data-testid="ai-key-replace">Replace</button>{" "}
                        <button type="button" className="btn small danger" disabled={busy !== null} onClick={() => (armed === c.id ? void remove(c) : setArmed(c.id))} data-testid="ai-key-remove">{busy === c.id ? "Removing…" : armed === c.id ? "Confirm?" : "Remove"}</button>
                      </td>
                    </tr>
                    {armed === c.id && uses.length > 0 && (
                      <tr><td colSpan={6} className="fe-warnrow" data-testid="ai-key-remove-warning">Removing this key returns {uses.join(", ")} to the platform's AI.</td></tr>
                    )}
                    {replacing === c.id && (
                      <tr>
                        <td colSpan={6}>
                          <div className="row" style={{ gap: 8 }}>
                            <input className="input grow" type="password" value={replacement} onChange={(e) => setReplacement(e.target.value)} placeholder={`New ${idx.get(c.provider)?.label ?? ""} API key`} autoComplete="new-password" spellCheck={false} data-testid="ai-key-replace-input" />
                            <button type="button" className="btn primary" disabled={busy !== null || !replacement.trim()} onClick={() => void replace(c)} data-testid="ai-key-replace-save">{busy === c.id ? "Saving…" : "Save new key"}</button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card-title" style={{ marginTop: 16, fontSize: 14 }}>Add a key</div>
      <div className="row fe-add" style={{ gap: 8, flexWrap: "wrap" }}>
        <select className="input" value={adding.provider} onChange={(e) => setAdding({ ...adding, provider: e.target.value })} data-testid="ai-key-add-provider">
          <option value="">Provider…</option>
          {all.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <input className="input" value={adding.label} onChange={(e) => setAdding({ ...adding, label: e.target.value })} placeholder="Label (optional)" maxLength={60} data-testid="ai-key-add-label" />
        <input className="input grow" type="password" value={adding.key} onChange={(e) => setAdding({ ...adding, key: e.target.value })} placeholder="API key" autoComplete="new-password" spellCheck={false} data-testid="ai-key-add-key" />
        <button type="button" className="btn primary" disabled={busy !== null || !overview.vault.ready || !adding.provider || !adding.key.trim()} onClick={() => void add()} data-testid="ai-key-add-save">{busy === "add" ? "Saving…" : "Save key"}</button>
      </div>
    </div>
  );
}
