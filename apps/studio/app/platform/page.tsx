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
  mail?: {
    configured: boolean;
    from: string | null;
    fromBulk: string | null;
    replyTo: string | null;
    redirectTo: string | null;
    canReachRealRecipients: boolean;
  };
  viewer: { isPlatformAdmin: boolean; signedIn: boolean; email?: string | null };
}

const LABELS: Record<string, string> = {
  database: "Database (SUPABASE_URL)",
  serviceKey: "Service role key",
  anonKey: "Anon key",
  runtimeUrl: "Respondent runtime URL",
  studioUrl: "Public Studio URL (for emailed links)",
  authSalt: "Auth hash salt",
  qualitySalt: "Quality hash salt",
  mail: "Mail (Resend)",
};

export default function PlatformPage() {
  const [info, setInfo] = React.useState<Info | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; text: string } | null>(null);

  const sendTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const r = await fetch("/api/platform", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "test_mail" }),
      });
      const j = await r.json().catch(() => ({}));
      setTestResult({ ok: r.ok, text: r.ok ? j.message ?? "Sent." : j.error ?? `That failed (${r.status}).` });
    } catch (e) {
      setTestResult({ ok: false, text: (e as Error).message });
    } finally { setTesting(false); }
  };

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
                  <span className={`chip ${v ? "on" : "warn"}`}>{v ? "set" : "not set"}</span>
                  {k === "mail" && !v && <span className="muted" style={{ fontSize: 12.5, marginLeft: 8 }}>
                    Password resets cannot be delivered; invitations hand back a link to send by hand.
                  </span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        * MAIL. Configuration cannot tell you whether a message actually
        * leaves, so this section ends with the one button that can — sending
        * to the signed-in caller's own address, never to one typed into a
        * box, because that would make this page a way to send mail from a
        * verified domain to anybody.
        */}
      <h3 className="sec">Mail</h3>
      <div className="card" data-testid="platform-mail">
        {!info.mail?.configured ? (
          <>
            <div className="chip warn" data-testid="platform-mail-off">Not configured</div>
            <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
              Password resets, project invitations and respondent invitations all fall back to handing you a link to
              send by hand. Set <span className="mono">RESEND_API_KEY</span> and <span className="mono">MAIL_FROM</span>{" "}
              to change that.
            </p>
          </>
        ) : (
          <>
            <table className="grid">
              <tbody>
                <tr><td>Transactional from</td><td className="mono">{info.mail.from}</td></tr>
                <tr>
                  <td>Invitations from</td>
                  <td className="mono">
                    {info.mail.fromBulk}
                    {info.mail.fromBulk === info.mail.from && (
                      <span className="muted" style={{ fontSize: 12.5, marginLeft: 8 }}>
                        — same address as transactional. Set MAIL_FROM_INVITATIONS to a separate subdomain so a bad
                        survey send cannot stop your password resets arriving.
                      </span>
                    )}
                  </td>
                </tr>
                {info.mail.replyTo && <tr><td>Reply-to</td><td className="mono">{info.mail.replyTo}</td></tr>}
                <tr>
                  <td>Reaches real recipients</td>
                  <td>
                    {info.mail.canReachRealRecipients
                      ? <span className="chip on">yes — this is production</span>
                      : info.mail.redirectTo
                        ? <span className="chip warn">no — everything goes to <span className="mono">{info.mail.redirectTo}</span></span>
                        : <span className="chip warn">no — suppressed, and no redirect address is set</span>}
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button className="btn small primary" disabled={testing} data-testid="platform-mail-test" onClick={() => void sendTest()}>
                {testing ? "Sending…" : `Send a test to ${info.viewer.email ?? "my address"}`}
              </button>
              {testResult && (
                <span className={`chip ${testResult.ok ? "on" : "warn"}`} data-testid="platform-mail-result">{testResult.text}</span>
              )}
            </div>
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 0, marginTop: 8 }}>
              A test that arrives proves the key and the address. It does <strong>not</strong> prove your DNS — until
              SPF and DKIM are verified for the sending domain, mail to anyone outside your own organisation is likely
              to be filtered. Check the domain in your provider&apos;s dashboard.
            </p>
          </>
        )}
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
