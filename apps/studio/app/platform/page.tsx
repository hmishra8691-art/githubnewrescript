"use client";
import React from "react";

/**
 * /platform — WHAT THIS INSTANCE IS (§45).
 *
 * One page that answers the questions nobody could answer without shell
 * access to the host: which deployment of the platform is this, which
 * database is it pointed at, what is configured, how far have the migrations
 * got, and what is going to bite. Everything on it comes from
 * `/api/platform`, which is readable outside production and admin-only in it.
 *
 * The page is written to be SCREENSHOTTED and pasted into a support thread,
 * which is why nothing on it is a secret: a tier, a Supabase project
 * reference (the public part of a URL every respondent's browser already
 * sees), and presence flags. No keys, no tokens, no connection strings, no
 * user data.
 */

interface Info {
  tier: "development" | "staging" | "production";
  tierDeclared: boolean;
  database: string | null;
  runtimeUrl: string;
  studioUrl: string | null;
  release: string | null;
  node: string;
  configured: Record<string, boolean>;
  migrations: { applied: string[]; missing: { migration: string; what: string }[]; level: string | null; complete: boolean; probed?: boolean };
  warnings: string[];
  viewer: { isPlatformAdmin: boolean; signedIn: boolean };
}

const LABELS: Record<string, string> = {
  database: "Database (SUPABASE_URL)",
  serviceKey: "Service role key",
  anonKey: "Anon key",
  runtimeUrl: "Respondent runtime URL",
  studioUrl: "Public Studio URL (for emailed links)",
  authSalt: "Auth hash salt",
  qualitySalt: "Quality hash salt",
  mail: "Mail transport",
};

export default function PlatformPage() {
  const [info, setInfo] = React.useState<Info | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch("/api/platform", { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { setError(j.error ?? `This is not available here (${r.status}).`); return; }
        setInfo(j as Info);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  if (error) {
    return (
      <div className="ax-share-page">
        <h1 style={{ fontSize: 20 }}>Platform</h1>
        <div className="card" style={{ borderColor: "var(--red)" }} data-testid="platform-denied">
          <strong style={{ color: "var(--red)" }}>{error}</strong>
          <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
            On a production instance this page is for platform administrators only. Elsewhere it is open, so that an
            instance can be checked while it is being set up.
          </p>
        </div>
      </div>
    );
  }
  if (!info) return <div className="ax-share-page"><div className="muted" style={{ padding: 40 }}>Reading this instance…</div></div>;

  const tone = info.tier === "production" ? "on" : info.tier === "staging" ? "warn" : "";

  return (
    <div className="ax-share-page" data-testid="platform-page">
      <div className="row" style={{ alignItems: "baseline", marginBottom: 4 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Platform</h1>
        <span className={`chip ${tone}`} data-testid="platform-tier">{info.tier}</span>
        {!info.tierDeclared && <span className="chip warn" title="RESCRIPT_ENV is not set, so this was inferred">inferred</span>}
        <span className="grow" />
        <a className="btn small" href="/">← Projects</a>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        What this deployment is and what it is pointed at. Nothing here is a secret — it is meant to be pasted into a
        support conversation.
      </p>

      {info.warnings.length > 0 && (
        <div className="card" style={{ borderColor: "var(--amber)" }} data-testid="platform-warnings">
          <div className="flabel">Worth knowing</div>
          <ul className="muted" style={{ fontSize: 13, margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
            {info.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      <h3 className="sec">This instance</h3>
      <div className="card" data-testid="platform-instance">
        <table className="grid">
          <tbody>
            <tr><td>Tier</td><td><strong>{info.tier}</strong>{info.tierDeclared ? "" : " (inferred from NODE_ENV — set RESCRIPT_ENV)"}</td></tr>
            <tr><td>Database</td><td className="mono">{info.database ?? <span className="muted">not configured</span>}</td></tr>
            <tr><td>Respondent runtime</td><td className="mono">{info.runtimeUrl}</td></tr>
            <tr><td>Public Studio URL</td><td className="mono">{info.studioUrl ?? <span className="muted">not set — emailed links will be relative</span>}</td></tr>
            <tr><td>Release</td><td className="mono">{info.release ?? <span className="muted">unknown</span>}</td></tr>
            <tr><td>Node</td><td className="mono">{info.node}</td></tr>
          </tbody>
        </table>
      </div>

      <h3 className="sec">Configuration</h3>
      <div className="card" data-testid="platform-config">
        <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
          Presence only. No value on this page is ever the value of a variable.
        </p>
        <table className="grid">
          <tbody>
            {Object.entries(info.configured).map(([k, v]) => (
              <tr key={k}>
                <td>{LABELS[k] ?? k}</td>
                <td>
                  <span className={`chip ${v ? "on" : k === "mail" ? "" : "warn"}`}>{v ? "set" : "not set"}</span>
                  {k === "mail" && !v && <span className="muted" style={{ fontSize: 12.5, marginLeft: 8 }}>
                    The platform has none: invitations and password resets hand back a link to send by hand.
                  </span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="sec">Database migrations</h3>
      <div className="card" data-testid="platform-migrations">
        {info.migrations.probed === false ? (
          <div className="chip warn" data-testid="platform-migration-unknown">
            Not checked — there is no database configured to ask.
          </div>
        ) : info.migrations.complete ? (
          <div className="chip on">Up to date as far as this build knows — through {info.migrations.level}</div>
        ) : (
          <>
            <div className="chip warn" data-testid="platform-migration-gap">
              {info.migrations.missing.length} not applied — the first is {info.migrations.missing[0]?.migration}
            </div>
            <ul className="muted" style={{ fontSize: 13, marginTop: 8, paddingLeft: 18, lineHeight: 1.6 }}>
              {info.migrations.missing.map((m) => (
                <li key={m.migration}>
                  <span className="mono">{m.migration}</span> — {m.what} will not work until it is applied.
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
          Probed by asking the database what it has, feature by feature: there is no migrations table, and each panel in
          the platform detects its own gap. A database <em>ahead</em> of this build reads as complete, which is the right
          answer to “can this build work against that database”.
        </p>
      </div>
    </div>
  );
}
