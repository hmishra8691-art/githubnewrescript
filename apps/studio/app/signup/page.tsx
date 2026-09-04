"use client";
import React from "react";
import { api } from "@/lib/useSession";

/**
 * CREATE AN ACCOUNT.
 *
 * The screen does not redirect on success, which is the one thing about it
 * worth arguing over. Signing up mints a User ID that the person did not
 * choose and cannot change, and it is the string a colleague will type to
 * share a project with them. Dropping them straight onto the dashboard would
 * mean the only time it is shown prominently is a frame they never see.
 */

interface SignedUp {
  user: {
    userId: string;
    userCode: string;
    name: string;
    email: string;
    organization?: string | null;
  };
  invitationsClaimed?: number;
  signedIn?: boolean;
}

type Problems = Record<string, string>;

export default function SignupPage() {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [organization, setOrganization] = React.useState("");
  const [jobTitle, setJobTitle] = React.useState("");
  const [problems, setProblems] = React.useState<Problems>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<SignedUp | null>(null);
  const [invited, setInvited] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  /*
   * The invitation token is read only to explain what is about to happen. It
   * is deliberately not sent with the form: the server matches waiting
   * invitations by email address, so a token pasted in by hand cannot grant
   * access to a project that was never offered to this address.
   */
  React.useEffect(() => {
    setInvited(Boolean(new URLSearchParams(window.location.search).get("invite")));
  }, []);

  React.useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);

  /** Editing a field retracts the complaint about it; leave the others. */
  const clearProblem = (field: string) =>
    setProblems((p) => (p[field] ? { ...p, [field]: "" } : p));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setProblems({});
    const res = await api<SignedUp>("/api/auth/signup", {
      method: "POST",
      json: { name, email, password, confirmPassword, organization, jobTitle },
    });
    setBusy(false);
    if (res.ok) {
      setDone(res.data);
      return;
    }
    // 400 and the duplicate-email 409 both answer with `problems`, keyed by
    // field name; anything else only has a sentence
    const found = (res.data?.problems ?? null) as Problems | null;
    if (found && Object.keys(found).length) setProblems(found);
    setError(res.error);
  };

  const copy = async () => {
    if (!done) return;
    try {
      await navigator.clipboard.writeText(done.user.userCode);
      setCopied(true);
    } catch {
      // clipboard access is refused outside a secure context; the code is on
      // screen and selectable, so there is nothing to recover from
      setError("Could not copy automatically — select the User ID and copy it.");
    }
  };

  if (done) {
    const claimed = Number(done.invitationsClaimed ?? 0);
    return (
      <div className="auth-shell">
        <div className="auth-card wide">
          <div className="auth-brand">SURVEY PROGRAMMING PLATFORM</div>
          <h1 className="auth-title">Account created</h1>
          <p className="auth-sub">
            Welcome, {done.user.name} — your account is set up for {done.user.email}.
          </p>

          <div className="usercode-badge" data-testid="signup-usercode">
            {done.user.userCode}
            <small>YOUR USER ID</small>
          </div>
          <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 8 }}>
            This is the ID colleagues use to share projects with you. Keep it somewhere handy —
            you can sign in with it or with your email address.
          </p>

          {claimed > 0 && (
            <div className="auth-note ok">
              You have been added to {claimed} project{claimed === 1 ? "" : "s"} you were invited to.
            </div>
          )}
          {done.signedIn === false && (
            <div className="auth-note info">
              Your account exists, but a session could not be started automatically. Sign in to
              continue.
            </div>
          )}
          {error && <div className="auth-note err">{error}</div>}

          <div className="auth-actions">
            <button className="btn" type="button" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy User ID"}
            </button>
            <button
              className="btn primary"
              type="button"
              data-testid="signup-continue"
              onClick={() => (window.location.href = "/")}
            >
              Continue to my projects
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-card wide">
        <div className="auth-brand">SURVEY PROGRAMMING PLATFORM</div>
        <h1 className="auth-title">Create account</h1>
        <p className="auth-sub">You will be given a User ID that colleagues can share projects with.</p>

        {invited && (
          <div className="auth-note info">
            You have been invited to a project. Create your account with the email address the
            invitation was sent to and you will get access straight away.
          </div>
        )}
        {error && <div className="auth-note err">{error}</div>}

        <form onSubmit={submit} noValidate>
          <div className={`auth-field${problems.name ? " bad" : ""}`}>
            <label htmlFor="signup-name">Name</label>
            <input
              id="signup-name"
              data-testid="signup-name"
              className="input"
              autoComplete="name"
              autoFocus
              value={name}
              onChange={(e) => { setName(e.target.value); clearProblem("name"); }}
            />
            {problems.name && <div className="err">{problems.name}</div>}
          </div>

          <div className={`auth-field${problems.email ? " bad" : ""}`}>
            <label htmlFor="signup-email">Email address</label>
            <input
              id="signup-email"
              data-testid="signup-email"
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); clearProblem("email"); }}
            />
            {problems.email && <div className="err">{problems.email}</div>}
          </div>

          <div className={`auth-field${problems.password ? " bad" : ""}`}>
            <label htmlFor="signup-password">Password</label>
            <input
              id="signup-password"
              data-testid="signup-password"
              className="input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); clearProblem("password"); }}
            />
            {problems.password
              ? <div className="err">{problems.password}</div>
              : <div className="hint">At least 10 characters.</div>}
          </div>

          <div className={`auth-field${problems.confirmPassword ? " bad" : ""}`}>
            <label htmlFor="signup-confirm">Confirm password</label>
            <input
              id="signup-confirm"
              data-testid="signup-confirm"
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => { setConfirmPassword(e.target.value); clearProblem("confirmPassword"); }}
            />
            {problems.confirmPassword && <div className="err">{problems.confirmPassword}</div>}
          </div>

          <div className={`auth-field${problems.organization ? " bad" : ""}`}>
            <label htmlFor="signup-organization">Organization <span className="muted">(optional)</span></label>
            <input
              id="signup-organization"
              data-testid="signup-organization"
              className="input"
              autoComplete="organization"
              value={organization}
              onChange={(e) => { setOrganization(e.target.value); clearProblem("organization"); }}
            />
            {problems.organization && <div className="err">{problems.organization}</div>}
          </div>

          <div className={`auth-field${problems.jobTitle ? " bad" : ""}`}>
            <label htmlFor="signup-jobtitle">Job title <span className="muted">(optional)</span></label>
            <input
              id="signup-jobtitle"
              data-testid="signup-jobtitle"
              className="input"
              autoComplete="organization-title"
              value={jobTitle}
              onChange={(e) => { setJobTitle(e.target.value); clearProblem("jobTitle"); }}
            />
            {problems.jobTitle && <div className="err">{problems.jobTitle}</div>}
          </div>

          <div className="auth-actions">
            <button className="btn primary" type="submit" data-testid="signup-submit" disabled={busy}>
              {busy ? "Creating account…" : "Create account"}
            </button>
          </div>
        </form>

        <div className="auth-alt">
          <span>Already have an account?</span>
          <a href="/login">Sign in</a>
        </div>
      </div>
    </div>
  );
}
