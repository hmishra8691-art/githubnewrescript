"use client";
import React from "react";
import { useStudio } from "./store";

/**
 * THE DIAGNOSTICS PANEL (§27).
 *
 * Every P0 in this round was diagnosed by hand against the production
 * database, and three of them turned out to have nothing to do with what the
 * symptom looked like. "My projects disappeared" was an access rule, not
 * deleted data. "I cannot save" was a lost lock reported as a version
 * conflict. This panel is that investigation, run by whoever is actually
 * having the problem, so the next one takes a minute rather than an evening.
 *
 * It leads with the only question anybody asks — CAN I SAVE RIGHT NOW, and if
 * not, which of the three conditions is false — and then shows the state
 * behind it. It contains no secrets (see the route), and it does not appear at
 * all on a deployment where diagnostics are switched off.
 */

interface Diagnostics {
  generatedAt: string;
  canSaveRightNow: {
    result: boolean;
    roleAllowsEditing: boolean;
    thisSessionHoldsTheLock: boolean;
    projectFrozenByOwner: boolean;
  };
  session: Record<string, unknown> & { effectiveStatus?: string; endedReason?: string | null };
  myRecentSessions: {
    id: string; isThisOne: boolean; status: string; device: string | null;
    startedAt: string; lastHeartbeatAt: string; endedAt: string | null; endedReason: string | null;
  }[];
  access: Record<string, unknown> & { role?: string | null; roleSource?: string; why?: string | null };
  lock: Record<string, unknown> & { status?: string; mine?: boolean; heldByName?: string | null };
  persistence: Record<string, unknown> & { serverRevision?: number | null };
}

const shortTime = (iso: unknown) =>
  typeof iso === "string" && !Number.isNaN(Date.parse(iso))
    ? new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

/** Renders whatever the server sent, so a new field needs no client change. */
function Rows({ data }: { data: Record<string, unknown> }) {
  return (
    <table className="diag-table">
      <tbody>
        {Object.entries(data).map(([k, v]) => (
          <tr key={k}>
            <th>{k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())}</th>
            <td>
              {v === null || v === undefined
                ? <span className="diag-null">—</span>
                : typeof v === "boolean"
                  ? <span className={v ? "diag-yes" : "diag-no"}>{v ? "yes" : "no"}</span>
                  : /At$/.test(k) && typeof v === "string"
                    ? <span title={v}>{shortTime(v)}</span>
                    : String(v)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DiagnosticsPanel() {
  const s = useStudio();
  const [data, setData] = React.useState<Diagnostics | null>(null);
  const [state, setState] = React.useState<"loading" | "ready" | "off" | "error">("loading");
  const [open, setOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    if (s.surveyDbId === "sandbox") { setState("off"); return; }
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/diagnostics`, { cache: "no-store" });
      if (r.status === 404) { setState("off"); return; }
      if (!r.ok) { setState("error"); return; }
      setData((await r.json()) as Diagnostics);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [s.surveyDbId]);

  React.useEffect(() => { void load(); }, [load]);

  // diagnostics are switched off, or this is the fixture: render nothing at
  // all rather than an empty box inviting a click that does nothing
  if (state === "off") return null;
  if (state === "error") return null;

  const verdict = data?.canSaveRightNow;

  return (
    <section className="diag" data-testid="diagnostics">
      <header className="diag-head">
        <button className="btn small" data-testid="diagnostics-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} Session &amp; save diagnostics
        </button>
        {verdict && (
          <span
            className={verdict.result ? "diag-badge ok" : "diag-badge warn"}
            data-testid="diagnostics-verdict"
            data-can-save={verdict.result ? "1" : "0"}
          >
            {verdict.result
              ? "Saving is working"
              : !verdict.roleAllowsEditing
                ? "Cannot save — your role does not allow editing"
                : verdict.projectFrozenByOwner
                  ? "Cannot save — the owner has frozen this project"
                  : "Cannot save — this session does not hold the edit lock"}
          </span>
        )}
        <button className="btn small" style={{ marginLeft: "auto" }} onClick={() => void load()}>Refresh</button>
      </header>

      {open && data && (
        <div className="diag-body">
          <p className="diag-note">
            Read as of {shortTime(data.generatedAt)}. Your work is stored on the server, in the
            project row shown under <strong>Persistence</strong> — never only in this browser.
            Nothing here is a secret, so it is safe to screenshot for support.
          </p>

          <h4>Can I save right now?</h4>
          <Rows data={verdict as unknown as Record<string, unknown>} />

          <h4>This editor</h4>
          <Rows
            data={{
              editorRevision: s.revision,
              serverRevision: data.persistence.serverRevision ?? null,
              /* the stale-write condition, spelled out rather than implied */
              editorIsBehindTheServer:
                typeof s.revision === "number" && typeof data.persistence.serverRevision === "number"
                  ? s.revision < data.persistence.serverRevision
                  : false,
              saveState: s.saveState.kind,
              unsavedChanges: s.dirty,
              readOnly: s.readOnly,
              readOnlyReason: s.readOnlyReason,
              revisionGuardActive: !s.unguarded,
            }}
          />

          <h4>Session</h4>
          <Rows data={data.session} />

          <h4>Access</h4>
          <Rows data={data.access} />

          <h4>Edit lock</h4>
          <Rows data={data.lock} />

          <h4>Persistence</h4>
          <Rows data={data.persistence} />

          <h4>My recent sessions on this account</h4>
          <table className="diag-table">
            <thead>
              <tr><th>Device</th><th>Status</th><th>Started</th><th>Last seen</th><th>Ended because</th></tr>
            </thead>
            <tbody>
              {data.myRecentSessions.map((r) => (
                <tr key={r.id} className={r.isThisOne ? "diag-me" : undefined}>
                  <td>{r.device ?? "—"}{r.isThisOne ? " (this one)" : ""}</td>
                  <td>{r.status}</td>
                  <td>{shortTime(r.startedAt)}</td>
                  <td>{shortTime(r.lastHeartbeatAt)}</td>
                  {/* `taken_over` is the row that explains "I signed in on my
                      laptop and my desktop stopped saving" */}
                  <td>{r.endedReason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
