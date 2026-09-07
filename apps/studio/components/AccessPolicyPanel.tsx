"use client";
import React from "react";
import { api } from "@/lib/useSession";

/**
 * THE WORKSPACE ACCESS POLICY, EDITABLE (§7).
 *
 * `public.access_settings` has been read on every login, heartbeat and lock
 * decision since 0008, and written by nothing. Changing a session timeout or
 * a lockout threshold meant opening the SQL editor and hand-writing a jsonb
 * document — so in practice every workspace ran on the code defaults, while
 * §7 promised these were configurable and the sign-in screen quoted the
 * numbers back to people in minutes.
 *
 * THE SCREEN'S ONE IDEA: show what is IN FORCE and what it would be with no
 * settings at all, side by side, and mark the difference. An operator's real
 * question is never "what is this number" — it is "did somebody change this,
 * or is it what it has always been", and a form pre-filled with current
 * values cannot answer it. A field left empty means "use the default", which
 * is also how it is stored: only the deltas are written, so a workspace
 * inherits a future improvement to a default it never chose to override.
 *
 * Seconds are shown as seconds and explained in minutes. The stored unit is
 * seconds because that is what the policy helpers and the SQL functions take,
 * and a screen that stores minutes would be one conversion away from signing
 * everybody out sixty times sooner than intended.
 */

/* mirrors `NumericFieldSpec` in @rescript/access, which the route sends verbatim */
interface FieldSpec { min: number; max: number; label: string; unit: string }
interface Payload {
  effective: {
    session: Record<string, number | boolean>;
    throttle: Record<string, number>;
    workspace: { defaultRole: string | null };
  };
  defaults: { session: Record<string, number | boolean>; throttle: Record<string, number> };
  stored: Record<string, Record<string, unknown>>;
  platformDefault: Record<string, unknown>;
  fields: { session: Record<string, FieldSpec>; throttle: Record<string, FieldSpec> };
  grantableRoles: string[];
  workspaceId: string | null;
  migration?: string;
}

const ROLE_WORDS: Record<string, string> = {
  editor: "Editor", programmer: "Programmer", reviewer: "Reviewer",
  viewer: "Viewer", test_user: "Test user", deployment_manager: "Deployment manager",
};

/** "900 seconds" is a number; "15 minutes" is the thing being decided. */
function inWords(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3600) {
    const m = seconds / 60;
    return `${Number.isInteger(m) ? m : m.toFixed(1)} minute${m === 1 ? "" : "s"}`;
  }
  const h = seconds / 3600;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? "" : "s"}`;
}

export function AccessPolicyPanel() {
  const [data, setData] = React.useState<Payload | null>(null);
  const [draft, setDraft] = React.useState<Record<string, Record<string, string>>>({ session: {}, throttle: {} });
  const [role, setRole] = React.useState<string>("");
  const [takeover, setTakeover] = React.useState<boolean | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const res = await api<Payload>("/api/admin/access");
    if (!res.ok) {
      /* a loader that swallows its error leaves a panel spinning for ever */
      setLoadError(res.error ?? "The access policy could not be read.");
      return;
    }
    setData(res.data);
    setLoadError(null);
    /*
     * The draft starts EMPTY, not pre-filled. An empty field means "inherit",
     * which is the state most of these should be in — pre-filling would make
     * every save pin every value at whatever it happens to be today.
     */
    const stored = res.data.stored ?? {};
    const asText = (section: string) =>
      Object.fromEntries(Object.entries(stored[section] ?? {})
        .filter(([, v]) => typeof v === "number")
        .map(([k, v]) => [k, String(v)]));
    setDraft({ session: asText("session"), throttle: asText("throttle") });
    setRole(typeof stored.workspace?.defaultRole === "string" ? stored.workspace.defaultRole : "");
    setTakeover(typeof stored.session?.allowForceTakeover === "boolean" ? stored.session.allowForceTakeover : null);
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  if (loadError) {
    return (
      <div className="auth-note err" data-testid="access-policy-error">
        <strong>The access policy could not be read.</strong>
        <div style={{ marginTop: 4 }}>{loadError}</div>
      </div>
    );
  }
  if (!data) return <p className="muted">Reading the workspace policy…</p>;

  if (data.migration) {
    return (
      <div className="auth-note err" data-testid="access-policy-migration">
        Access settings need migration {data.migration}. Until it is applied, every workspace runs on the
        platform defaults shown below.
      </div>
    );
  }

  const save = async () => {
    setBusy(true); setError(null); setNote(null);
    const numbers = (section: "session" | "throttle") =>
      Object.fromEntries(Object.entries(draft[section] ?? {}).filter(([, v]) => v.trim() !== ""));
    const res = await api<{ note?: string }>("/api/admin/access", {
      method: "PUT",
      json: {
        session: { ...numbers("session"), ...(takeover === null ? {} : { allowForceTakeover: takeover }) },
        throttle: numbers("throttle"),
        ...(role ? { workspace: { defaultRole: role } } : {}),
      },
    });
    setBusy(false);
    if (!res.ok) { setError(res.error ?? "That did not save."); return; }
    setNote(res.data.note ?? "Saved.");
    await load();
  };

  const section = (name: "session" | "throttle", title: string, blurb: string) => (
    <div className="card" style={{ padding: 12, marginBottom: 10 }} data-testid={`access-${name}`}>
      <div className="flabel">{title}</div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{blurb}</p>
      <table className="rs-table" style={{ width: "100%", fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Setting</th>
            <th style={{ textAlign: "left" }}>In force</th>
            <th style={{ textAlign: "left" }}>Platform default</th>
            <th style={{ textAlign: "left" }}>This workspace</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(data.fields[name]).map(([key, spec]) => {
            const live = Number(data.effective[name][key]);
            const def = Number(data.defaults[name][key]);
            const overridden = Object.prototype.hasOwnProperty.call(data.stored[name] ?? {}, key);
            return (
              <tr key={key} data-field={key}>
                <td>
                  {spec.label}
                  {spec.unit ? <span className="muted"> ({spec.unit})</span> : null}
                </td>
                <td>
                  <strong>{live}</strong>
                  {spec.unit === "seconds" && <span className="muted"> · {inWords(live)}</span>}
                  {overridden && <span className="chip" style={{ marginLeft: 6 }} data-testid={`overridden-${key}`}>set here</span>}
                </td>
                <td className="muted">{def}{spec.unit === "seconds" ? ` · ${inWords(def)}` : ""}</td>
                <td>
                  <input
                    className="input" style={{ width: 110 }} type="number"
                    min={spec.min} max={spec.max}
                    placeholder="inherit"
                    data-testid={`access-input-${key}`}
                    value={draft[name]?.[key] ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, [name]: { ...d[name], [key]: e.target.value } }))}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div data-testid="access-policy">
      <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
        These decide how long a session lasts, when it goes stale, how many failed sign-ins are tolerated, and
        what access a colleague in this workspace has to a project nobody has shared with them. They are read
        on every sign-in. <strong>Leave a field empty to inherit the platform default</strong> — only the values
        you set are stored, so a default improved in a later release reaches you.
      </p>

      {error && <div className="auth-note err" role="alert" data-testid="access-error">{error}</div>}
      {note && !error && <div className="auth-note ok" data-testid="access-note">{note}</div>}

      {section(
        "session", "SESSIONS",
        "One account, one active session. “Stale after” is the timeout that guarantees nobody is locked out of their own account by a laptop that died — it must not come before “idle after”, and is raised to match if it does.",
      )}

      <div className="card" style={{ padding: 12, marginBottom: 10 }}>
        <label className="qs-check" style={{ margin: 0 }}>
          <input
            type="checkbox"
            data-testid="access-takeover"
            checked={takeover ?? Boolean(data.effective.session.allowForceTakeover)}
            onChange={(e) => setTakeover(e.target.checked)}
          />
          <span>
            The newest sign-in wins
            {takeover === null && <span className="muted"> (inherited)</span>}
          </span>
        </label>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
          On by default, and deliberately: the loser of the one-session rule should be the browser nobody is
          looking at, not the person standing at the keyboard. Turning it off makes a stale session refuse the
          new one until it times out.
        </p>
      </div>

      {section(
        "throttle", "FAILED SIGN-INS",
        "Counted per account and per source, because the two attacks differ: many guesses at one account, and one guess at many accounts. A lockout is always temporary — a permanent one is a denial of service anybody can trigger against a colleague.",
      )}

      <div className="card" style={{ padding: 12, marginBottom: 10 }} data-testid="access-workspace">
        <div className="flabel">WORKSPACE BASELINE ROLE</div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
          What a colleague in this workspace can do with a project nobody has shared with them. “No baseline”
          means a project is invisible until it is shared — the safest setting, and the default.
        </p>
        <select
          className="select" style={{ maxWidth: 260 }} data-testid="access-baseline-role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="">Inherit ({data.effective.workspace.defaultRole
            ? ROLE_WORDS[data.effective.workspace.defaultRole] ?? data.effective.workspace.defaultRole
            : "no baseline"})</option>
          <option value="none">No baseline — shared projects only</option>
          {data.grantableRoles.map((r) => (
            <option key={r} value={r}>{ROLE_WORDS[r] ?? r}</option>
          ))}
        </select>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={busy} data-testid="access-save" onClick={() => void save()}>
          {busy ? "Saving…" : "Save policy"}
        </button>
        <button
          className="btn" disabled={busy} data-testid="access-reset"
          onClick={() => { setDraft({ session: {}, throttle: {} }); setRole(""); setTakeover(null); }}
        >
          Clear all overrides
        </button>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Clearing does not save on its own — press “Save policy” to return this workspace to the defaults.
        </span>
      </div>
    </div>
  );
}
