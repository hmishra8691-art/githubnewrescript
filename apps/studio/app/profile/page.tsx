"use client";
import React from "react";
import { AccountHeader } from "@/components/AccountHeader";
import { api, useSession } from "@/lib/useSession";

/**
 * THE PROFILE (§2).
 *
 * Half of this screen is deliberately not editable, and the interesting part
 * of the design is saying so out loud. A greyed-out box with no explanation
 * reads as a bug — people retype into it, then file a ticket — so every locked
 * field carries the reason it is locked next to it. The reasons are the same
 * ones the server enforces: the User ID is how colleagues find you, the email
 * is what signs you in, the role and the account status belong to an
 * administrator.
 *
 * Which fields are open is not decided here either. The GET response says so
 * in `editable`, and this screen renders that list — so if the server ever
 * closes one of them, the input disappears instead of turning into a save
 * that quietly fails.
 */

interface ProfileData {
  name: string;
  /** the generated User ID (the user_code), NOT the internal row id */
  userCode: string;
  email: string;
  organization: string | null;
  jobTitle: string | null;
  workspace: string | null;
  accountStatus: string;
  platformRole: string;
  createdDate: string | null;
  lastLogin: string | null;
  currentSession: { sessionId: string; status: string };
  projectsOwned: number;
  projectsShared: number;
  editable: string[];
}

type EditableField = "name" | "organization" | "jobTitle";

/** Why a field cannot be changed here — shown, not implied. */
const LOCK_REASONS: Record<string, string> = {
  userId: "System identifier — colleagues use this to share projects with you.",
  email: "Used to sign in. An administrator can change it.",
  platformRole: "Set by an administrator.",
  accountStatus: "Set by an administrator.",
};

function whenLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "—" : new Date(ms).toLocaleString();
}

const ROLE_WORDS: Record<string, string> = {
  platform_admin: "Platform administrator",
  programmer: "Programmer",
  researcher: "Researcher",
  client: "Client",
  viewer: "Viewer",
};

export default function ProfilePage() {
  const { state, signOut } = useSession({ redirectOnSignOut: true });
  const [data, setData] = React.useState<ProfileData | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<EditableField, string>>({ name: "", organization: "", jobTitle: "" });
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveNote, setSaveNote] = React.useState<string | null>(null);
  const [problems, setProblems] = React.useState<Record<string, string>>({});

  const [pw, setPw] = React.useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [pwBusy, setPwBusy] = React.useState(false);
  const [pwError, setPwError] = React.useState<string | null>(null);
  const [pwOk, setPwOk] = React.useState(false);
  const [pwProblems, setPwProblems] = React.useState<Record<string, string>>({});

  const load = React.useCallback(async () => {
    const r = await api<ProfileData>("/api/profile");
    if (!r.ok) {
      // a 401 is the session hook's business, not an error banner's — it is
      // already sending the browser to /login
      if (r.status !== 401 && r.status !== 403) setLoadError(r.error);
      return;
    }
    setLoadError(null);
    setData(r.data);
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const canEdit = (f: EditableField) => data?.editable?.includes(f) ?? false;

  const startEdit = () => {
    if (!data) return;
    setDraft({
      name: data.name ?? "",
      organization: data.organization ?? "",
      jobTitle: data.jobTitle ?? "",
    });
    setProblems({});
    setSaveError(null);
    setSaveNote(null);
    setEditing(true);
  };

  const save = async () => {
    if (!data || saving) return;
    setSaving(true);
    setSaveError(null);
    setSaveNote(null);
    setProblems({});
    try {
      // only the fields the server said were open are sent; anything else
      // would land in its `ignored` list and confuse the person who never
      // asked to change it
      const body: Record<string, string> = {};
      for (const f of ["name", "organization", "jobTitle"] as EditableField[]) {
        if (canEdit(f)) body[f] = draft[f];
      }
      const r = await api<{ ok: true; ignored?: { fields: string[]; reason: string } }>("/api/profile", {
        method: "PATCH",
        json: body,
      });
      if (!r.ok) {
        setProblems((r.data?.problems ?? {}) as Record<string, string>);
        setSaveError(r.error);
        return;
      }
      if (r.data.ignored) {
        setSaveNote(`${r.data.ignored.reason} (${r.data.ignored.fields.join(", ")})`);
      }
      setEditing(false);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pwBusy) return;
    setPwBusy(true);
    setPwError(null);
    setPwOk(false);
    setPwProblems({});
    try {
      const r = await api<{ ok: true }>("/api/profile", { method: "PUT", json: pw });
      if (!r.ok) {
        setPwProblems((r.data?.problems ?? {}) as Record<string, string>);
        setPwError(r.error);
        return;
      }
      // cleared on success so a shared screen is not left holding the new
      // password in three boxes
      setPw({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setPwOk(true);
    } finally {
      setPwBusy(false);
    }
  };

  const user = state.kind === "signed_in" ? state.user : null;

  /** A read-only identity field: the value, and why it is read-only. */
  const locked = (field: string, value: React.ReactNode, testId?: string) => (
    <span className="locked-field" data-testid={testId}>
      {value}
      {LOCK_REASONS[field] && <span className="why">{LOCK_REASONS[field]}</span>}
    </span>
  );

  /**
   * An editable field: an input while editing, otherwise just the text. The
   * test id stays on the wrapper in both states so it survives the switch.
   */
  const editableCell = (field: EditableField, value: string | null, testId: string, placeholder?: string) => {
    if (!canEdit(field)) {
      // the server closed this one; say so rather than showing a dead input
      return (
        <span className="locked-field" data-testid={testId}>
          <span>{value || "—"}</span>
          <span className="why">Not editable on this account.</span>
        </span>
      );
    }
    if (!editing) {
      return <span data-testid={testId}>{value || <span className="muted">Not set</span>}</span>;
    }
    return (
      <span data-testid={testId}>
        <input
          className="input"
          data-testid={`${testId}-input`}
          value={draft[field]}
          placeholder={placeholder}
          onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
        />
        {problems[field] && (
          <span style={{ display: "block", fontSize: 11.5, color: "var(--red)", marginTop: 3 }}>
            {problems[field]}
          </span>
        )}
      </span>
    );
  };

  return (
    <div className="acct-shell">
      <AccountHeader active="profile" user={user} onSignOut={signOut} />

      {loadError && <div className="auth-note err">{loadError}</div>}
      {!data && !loadError && <p className="muted">Loading…</p>}

      {data && (
        <>
          <div className="card">
            <div className="row" style={{ marginBottom: 12 }}>
              <strong className="grow">Identity</strong>
              {!editing ? (
                <button className="btn small" data-testid="profile-edit" onClick={startEdit}>Edit</button>
              ) : (
                <>
                  <button className="btn small" disabled={saving} onClick={() => { setEditing(false); setProblems({}); setSaveError(null); }}>
                    Cancel
                  </button>
                  <button className="btn small primary" data-testid="profile-save" disabled={saving} onClick={save}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                </>
              )}
            </div>

            {saveError && <div className="auth-note err">{saveError}</div>}
            {saveNote && <div className="auth-note info">{saveNote}</div>}

            <dl className="kv">
              <dt>Name</dt>
              <dd>{editableCell("name", data.name, "profile-name", "Your full name")}</dd>

              <dt>User ID</dt>
              <dd className="mono">
                {locked("userId", <span data-testid="profile-usercode">{data.userCode || "—"}</span>, "profile-locked-userid")}
              </dd>

              <dt>Email</dt>
              <dd>{locked("email", <span data-testid="profile-email">{data.email || "—"}</span>)}</dd>

              <dt>Organization</dt>
              <dd>{editableCell("organization", data.organization, "profile-organization", data.workspace ?? "Your company")}</dd>

              <dt>Job title</dt>
              <dd>{editableCell("jobTitle", data.jobTitle, "profile-jobtitle", "e.g. Survey Programmer")}</dd>

              <dt>Account status</dt>
              <dd>
                {locked(
                  "accountStatus",
                  <span className={data.accountStatus === "active" ? "chip on" : "chip warn"}>{data.accountStatus}</span>,
                )}
              </dd>

              <dt>Platform role</dt>
              <dd>{locked("platformRole", <span>{ROLE_WORDS[data.platformRole] ?? data.platformRole}</span>)}</dd>

              <dt>Created date</dt>
              <dd>{whenLabel(data.createdDate)}</dd>

              <dt>Last login</dt>
              <dd>{whenLabel(data.lastLogin)}</dd>

              <dt>Current session status</dt>
              <dd>
                <span className="chip on">{data.currentSession?.status ?? "unknown"}</span>{" "}
                <a href="/security" style={{ fontSize: 12 }}>Manage sessions</a>
              </dd>
            </dl>
          </div>

          <div className="card">
            <strong>Projects</strong>
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>Projects owned</dt>
              <dd>{data.projectsOwned}</dd>
              <dt>Shared with me</dt>
              <dd>{data.projectsShared}</dd>
            </dl>
          </div>

          <div className="card">
            <strong>Change password</strong>
            <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 12px" }}>
              Your current password is required — so a session left open on someone else&rsquo;s
              machine cannot be used to lock you out of your own account.
            </p>

            {pwError && <div className="auth-note err">{pwError}</div>}
            {pwOk && <div className="auth-note ok">Your password has been changed.</div>}

            <form onSubmit={changePassword} noValidate style={{ maxWidth: 380 }}>
              <div className={`auth-field${pwProblems.currentPassword ? " bad" : ""}`}>
                <label htmlFor="pw-current">Current password</label>
                <input
                  id="pw-current"
                  data-testid="password-current"
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={pw.currentPassword}
                  onChange={(e) => setPw((p) => ({ ...p, currentPassword: e.target.value }))}
                />
                {pwProblems.currentPassword && <div className="err">{pwProblems.currentPassword}</div>}
              </div>

              <div className={`auth-field${pwProblems.newPassword ? " bad" : ""}`}>
                <label htmlFor="pw-new">New password</label>
                <input
                  id="pw-new"
                  data-testid="password-new"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={pw.newPassword}
                  onChange={(e) => setPw((p) => ({ ...p, newPassword: e.target.value }))}
                />
                <div className="hint">At least 10 characters.</div>
                {pwProblems.newPassword && <div className="err">{pwProblems.newPassword}</div>}
              </div>

              <div className={`auth-field${pwProblems.confirmPassword ? " bad" : ""}`}>
                <label htmlFor="pw-confirm">Confirm new password</label>
                <input
                  id="pw-confirm"
                  data-testid="password-confirm"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={pw.confirmPassword}
                  onChange={(e) => setPw((p) => ({ ...p, confirmPassword: e.target.value }))}
                />
                {pwProblems.confirmPassword && <div className="err">{pwProblems.confirmPassword}</div>}
              </div>

              <div className="row">
                <button className="btn primary" type="submit" data-testid="password-submit" disabled={pwBusy}>
                  {pwBusy ? "Changing…" : "Change password"}
                </button>
              </div>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
