"use client";
import React from "react";
import { api } from "@/lib/useSession";
import { FEATURE_META, FEATURE_ORDER, modeWords, providerIndex, testWords, type Overview } from "@/lib/byok/settingsModel";
import { FeatureEditor } from "./FeatureEditor";
import { KeysSection } from "./KeysSection";
import { UsageSection } from "./UsageSection";

/**
 * SETTINGS → AI & INTEGRATIONS → AI PROVIDER CONFIGURATION.
 *
 * Seven sections, in the order a person needs them:
 *   1 Overview · 2 Intelligent Mode · 3 Other AI features · 4 Speech-to-text ·
 *   5 Translation · 6 Saved API keys · 7 Usage & cost.
 *
 * It reads and writes through the account API only (`/api/account/ai…`); the
 * rules — what may be saved, what a key may be used with, what a failure says —
 * are the server's, and this screen shows them. Nothing here ever holds a
 * secret beyond the field it is typed in.
 */

export const SECTIONS: { id: string; label: string }[] = [
  { id: "ai-overview", label: "Overview" },
  { id: "ai-intelligent", label: "Intelligent Mode" },
  { id: "ai-additional", label: "Other AI features" },
  { id: "ai-stt", label: "Speech-to-text" },
  { id: "ai-translation", label: "Translation" },
  { id: "ai-keys", label: "Saved API keys" },
  { id: "ai-usage", label: "Usage & cost" },
];

export function AiProviderConfig() {
  const [overview, setOverview] = React.useState<Overview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState<Record<string, boolean>>({});
  const [usageKey, setUsageKey] = React.useState(0);

  const load = React.useCallback(async () => {
    const r = await api<Overview>("/api/account/ai");
    if (r.ok) { setOverview(r.data); setError(null); } else if (r.status !== 401 && r.status !== 403) setError(r.error);
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const onDirty = React.useCallback((feature: string, d: boolean) => setDirty((cur) => (!!cur[feature] === d ? cur : { ...cur, [feature]: d })), []);
  const unsaved = Object.entries(dirty).filter(([, v]) => v).map(([k]) => k);

  /* leaving with unsaved work asks first */
  React.useEffect(() => {
    if (!unsaved.length) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [unsaved.length]);

  if (!overview) return <div className="ai-cfg">{error ? <div className="auth-note err" data-testid="ai-load-error">{error}</div> : <p className="muted">Loading…</p>}</div>;
  const idx = providerIndex(overview);

  return (
    <div className="ai-cfg" data-testid="ai-provider-config">
      <nav className="ai-sections" aria-label="AI provider configuration sections" data-testid="ai-sections">
        {SECTIONS.map((s, i) => (
          <a key={s.id} href={`#${s.id}`} data-testid={`ai-section-link-${s.id}`}>
            <span className="ai-sections-n">{i + 1}</span>{s.label}
            {s.id !== "ai-overview" && s.id !== "ai-keys" && s.id !== "ai-usage" && dirty[s.id.replace("ai-", "")] && <span className="ai-dot" title="Unsaved changes" />}
          </a>
        ))}
      </nav>

      {unsaved.length > 0 && (
        <div className="auth-note ai-unsaved" role="status" data-testid="ai-unsaved-banner">
          Unsaved changes in {unsaved.map((f) => FEATURE_META[f as keyof typeof FEATURE_META]?.title ?? f).join(", ")}. Save each section you changed, or discard it.
        </div>
      )}

      <section id="ai-overview" className="ai-section">
        <div className="card fe-card" data-testid="ai-overview">
          <div className="card-title">Overview</div>
          <p className="muted fe-blurb">
            Each AI feature can run on the platform's AI (provided and billed by the platform) or on <strong>your own provider</strong> with your own key. You choose per feature. Nothing changes until you save, and nothing ever switches silently: if your provider cannot answer, you are told — the platform's AI is used only if you allow it as a last resort.
          </p>
          {!overview.workspaceAllows && <div className="auth-note" data-testid="ai-overview-workspace">Your workspace administrator has turned off user-managed AI providers. Features run on the platform's AI.</div>}
          {overview.workspaceAllows && !overview.vault.ready && <div className="auth-note" data-testid="ai-overview-vault">{overview.vault.reason ?? "Saving your own API key is not enabled on this installation."}</div>}
          <div className="table-wrap">
            <table className="grid" data-testid="ai-overview-table">
              <thead><tr><th>Feature</th><th>Provided by</th><th>Configuration</th><th>Last test</th><th /></tr></thead>
              <tbody>
                {FEATURE_ORDER.map((id) => {
                  const f = overview.features.find((x) => x.feature === id)!;
                  const w = modeWords(f, idx);
                  const t = testWords(f.lastTest);
                  return (
                    <tr key={id} data-testid={`ai-overview-row-${id}`} data-mode={f.mode}>
                      <td>{FEATURE_META[id].title}</td>
                      <td><span className={`chip ${f.mode === "user" ? "on" : ""}`}>{w.headline}</span></td>
                      <td className="muted">{w.detail}{f.mode === "user" && f.fallbacks.length ? ` · ${f.fallbacks.length} fallback${f.fallbacks.length === 1 ? "" : "s"}` : ""}{f.mode === "user" && f.allowPlatformFallback ? " · platform last resort allowed" : ""}</td>
                      <td>{f.mode === "user" ? <span className={`chip ${t.tone === "ok" ? "ok" : t.tone === "bad" ? "warn" : ""}`}>{t.tone === "ok" ? "passed" : t.tone === "bad" ? "failed" : "not tested"}</span> : <span className="muted">—</span>}</td>
                      <td><a href={`#ai-${id}`}>Configure</a></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted fe-note" data-testid="ai-overview-respondent">
            What your respondents experience — probing questions, spoken answers, interview recordings and AI interviews — always runs on the platform's AI. It is not affected by these settings, and your key is never used for it.
          </p>
          <p className="muted fe-note">A project can also choose how its AI is provided. Where it chooses your own provider, the AI in that project uses <em>your</em> settings above; where it chooses the platform's, the platform's.</p>
        </div>
      </section>

      {FEATURE_ORDER.map((id) => {
        const f = overview.features.find((x) => x.feature === id)!;
        return (
          <section key={id} id={`ai-${id}`} className="ai-section">
            <FeatureEditor overview={overview} feature={f} onSaved={(o) => { setOverview(o); setUsageKey((k) => k + 1); }} onDirty={onDirty} onKeysChanged={() => void load()} />
          </section>
        );
      })}

      <section id="ai-keys" className="ai-section">
        <KeysSection overview={overview} onChanged={(o) => { if (o) setOverview(o); else void load(); }} />
      </section>

      <section id="ai-usage" className="ai-section">
        <UsageSection refreshKey={usageKey} providerLabel={(id) => idx.get(id)?.label ?? id} />
      </section>
    </div>
  );
}
