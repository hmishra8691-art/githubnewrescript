"use client";
import React from "react";
import { useStudio } from "./store";
import { surveyBaseUrl } from "@/lib/runtime-url";
import { sampleSourceLink, SOURCE_PARAM_ALIASES, RESPONDENT_PARAM_ALIASES } from "@rescript/engine";

type Env = "TEST" | "LIVE";

interface DeclaredSource {
  id: string;
  code: string;
  label: string;
  targetCompletes: number | null;
  costPerComplete: number | null;
  notes: string | null;
}

interface SourceStat {
  environment: Env;
  code: string;
  declared: boolean;
  label: string;
  targetCompletes: number | null;
  starts: number;
  completes: number;
  partials: number;
  screened: number;
  quotaFull: number;
  terminated: number;
  incidence: number | null;
  completionRate: number | null;
  medianSeconds: number | null;
  firstResponse: string | null;
  lastResponse: string | null;
}

/**
 * FIELDWORK (§23).
 *
 * A study is bought from several suppliers, and the only questions anyone
 * asks of the resulting data are per supplier: who is delivering, whose
 * respondents qualify, whose are dropping out, and whose are speeding. None
 * of that was answerable in this platform, because the fact was never
 * recorded — `responses.source` means "runtime | import | manual", not who
 * supplied the person.
 *
 * So this panel has two halves, and they are deliberately not the same list:
 *
 *   DECLARED   what the team contracted for — a code, a name, a completes
 *              target, a cost — plus the invitation link to hand each
 *              supplier, with their own respondent-id macro in it
 *   DELIVERED  what actually arrived, per source, computed from the responses
 *              themselves: starts, completes, incidence, completion rate,
 *              median duration
 *
 * A source that arrives but was never declared appears in the second half
 * marked UNDECLARED. That is not an error state to be tidied away: it is
 * either a typo in a live invitation link or traffic nobody expected, and
 * both are things a fieldwork manager needs to see today rather than discover
 * in the tab run.
 *
 * Nothing here edits response data. Declaring a source writes to
 * `sample_sources`; undeclaring removes the target and leaves every
 * interview's provenance exactly as collected.
 */
export function FieldworkPanel() {
  const s = useStudio();
  const [env, setEnv] = React.useState<Env>("LIVE");
  const [sources, setSources] = React.useState<DeclaredSource[]>([]);
  const [stats, setStats] = React.useState<SourceStat[]>([]);
  const [available, setAvailable] = React.useState(true);
  const [note, setNote] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState({ code: "", label: "", target: "", cost: "" });
  const [copied, setCopied] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    fetch(`/api/surveys/${s.surveyDbId}/sample-sources?environment=${env}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setSources(d.sources ?? []);
        setStats(d.stats ?? []);
        setAvailable(d.available !== false);
        if (d.note) setNote({ text: d.note, ok: false });
      })
      .catch(() => {});
  }, [s.surveyDbId, env]);
  React.useEffect(refresh, [refresh]);

  const declare = async (body: Record<string, unknown>) => {
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/sample-sources`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) setNote({ text: j.error ?? `That could not be saved (${r.status})`, ok: false });
      else { setNote({ text: `Saved “${body.code}”.`, ok: true }); refresh(); }
      return r.ok;
    } catch (e) { setNote({ text: (e as Error).message, ok: false }); return false; }
    finally { setBusy(false); }
  };

  const undeclare = async (code: string) => {
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/sample-sources?code=${encodeURIComponent(code)}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setNote({ text: j.error ?? `That could not be removed (${r.status})`, ok: false });
      else { setNote({ text: `Stopped tracking “${code}”. The responses keep their source.`, ok: true }); refresh(); }
    } finally { setBusy(false); }
  };

  const add = async () => {
    const code = draft.code.trim();
    if (!code) { setNote({ text: "A source needs the code that arrives in its link.", ok: false }); return; }
    const ok = await declare({
      code, label: draft.label.trim() || code,
      targetCompletes: draft.target === "" ? null : Number(draft.target),
      costPerComplete: draft.cost === "" ? null : Number(draft.cost),
    });
    if (ok) setDraft({ code: "", label: "", target: "", cost: "" });
  };

  /*
   * The link a supplier is given. The source parameter is whichever the
   * survey is configured for (falling back to the conventional `src`), and
   * the respondent macro is left as literal text because the supplier
   * substitutes it on their side — encoding it would break every one of them.
   */
  const sourceParam = s.def.deployment.sample?.sourceParam || SOURCE_PARAM_ALIASES[0];
  const respondentParam = s.def.deployment.sample?.respondentParam || RESPONDENT_PARAM_ALIASES[0];
  const base = `${surveyBaseUrl(s.def.deployment.customDomain)}/s/${s.def.deployment.clientSlug}/${s.def.deployment.studySlug}`;
  const linkFor = (code: string) =>
    sampleSourceLink(base, code, { respondentPlaceholder: "[%RESPONDENT_ID%]", sourceParam, respondentParam });

  const copy = (code: string) => {
    const link = linkFor(code);
    try {
      void navigator.clipboard?.writeText(link);
      setCopied(code);
      window.setTimeout(() => setCopied((c) => (c === code ? null : c)), 1800);
    } catch { /* a browser that refuses the clipboard still shows the link */ }
  };

  /*
   * The route can answer for both environments at once; this panel asks for
   * one, and filters anyway — an environment's fieldwork numbers must never
   * be shown under the other's heading, however the response arrived.
   */
  const shown = stats.filter((r) => r.environment === env);
  const declaredCodes = new Set(sources.map((x) => x.code.toLowerCase()));
  const totals = shown.reduce(
    (a, r) => ({ starts: a.starts + r.starts, completes: a.completes + r.completes, screened: a.screened + r.screened }),
    { starts: 0, completes: 0, screened: 0 },
  );
  const targetTotal = sources.reduce((a, x) => a + (x.targetCompletes ?? 0), 0);

  const duration = (secs: number | null) => {
    if (secs == null) return "—";
    const m = Math.floor(secs / 60);
    return m >= 1 ? `${m}m ${String(Math.round(secs % 60)).padStart(2, "0")}s` : `${Math.round(secs)}s`;
  };
  const pct = (v: number | null) => (v == null ? "—" : `${v}%`);
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

  return (
    <div>
      <div className="row" style={{ marginBottom: 14, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Fieldwork</h2>
        <span className="grow" />
        <div className="row" style={{ gap: 4 }} data-testid="fw-env">
          {(["LIVE", "TEST"] as Env[]).map((e) => (
            <button key={e} className={`btn small ${env === e ? "primary" : ""}`} data-testid={`fw-env-${e}`} onClick={() => setEnv(e)}>
              {e === "TEST" ? "Test data" : "Live data"}
            </button>
          ))}
        </div>
        <button className="btn small" onClick={refresh}>↻ refresh</button>
      </div>

      <p className="muted" style={{ fontSize: 13 }}>
        Where each respondent came from, captured from the invitation link at the moment the session starts. Declare a
        source to give it a name and a completes target and to get its own link; a source that arrives without being
        declared is still recorded and still appears below, marked <strong>undeclared</strong>. Figures are{" "}
        <strong>{env === "TEST" ? "test" : "live"}</strong> only — the two environments never share a fieldwork number.
      </p>

      {!available && (
        <div className="chip warn qd-note" data-testid="fw-migration-note">
          Sample source tracking needs migration 0012. Sources can be declared once it is applied.
        </div>
      )}
      {note && <div className={`chip ${note.ok ? "on" : "warn"} qd-note`} data-testid="fw-note">{note.text}</div>}

      {/* ------------------------------------------------------- delivered */}
      <div className="card" style={{ padding: 0, overflowX: "auto" }} data-testid="fw-stats">
        <table className="grid" style={{ minWidth: 900 }}>
          <thead>
            <tr>
              <th>Source</th>
              <th style={{ textAlign: "right" }}>Target</th>
              <th style={{ textAlign: "right" }}>Completes</th>
              <th style={{ textAlign: "right" }}>Starts</th>
              <th style={{ textAlign: "right" }}>In progress</th>
              <th style={{ textAlign: "right" }}>Screened</th>
              <th style={{ textAlign: "right" }}>Quota full</th>
              <th style={{ textAlign: "right" }}>Incidence</th>
              <th style={{ textAlign: "right" }}>Completion</th>
              <th style={{ textAlign: "right" }}>Median time</th>
              <th>Last response</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={11} className="muted" style={{ padding: 14 }}>
                No {env === "TEST" ? "test" : "live"} responses yet, so there is nothing to report by source.
              </td></tr>
            )}
            {shown.map((r) => (
              <tr key={`${r.environment}:${r.code}`} data-testid={`fw-row-${r.code}`}>
                <td>
                  <strong>{r.label}</strong>
                  {r.label !== r.code && <span className="muted mono" style={{ marginLeft: 6, fontSize: 12 }}>{r.code}</span>}
                  {!r.declared && r.code !== "(none)" && (
                    <span className="chip warn" style={{ marginLeft: 6 }} data-testid={`fw-undeclared-${r.code}`}>undeclared</span>
                  )}
                  {r.code === "(none)" && (
                    <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>(link carried no source)</span>
                  )}
                </td>
                <td style={{ textAlign: "right" }}>{r.targetCompletes ?? "—"}</td>
                <td style={{ textAlign: "right" }}>
                  <strong>{r.completes}</strong>
                  {r.targetCompletes ? (
                    <span className="muted" style={{ fontSize: 12 }}> / {r.targetCompletes}</span>
                  ) : null}
                </td>
                <td style={{ textAlign: "right" }}>{r.starts}</td>
                <td style={{ textAlign: "right" }}>{r.partials}</td>
                <td style={{ textAlign: "right" }}>{r.screened}</td>
                <td style={{ textAlign: "right" }}>{r.quotaFull}</td>
                <td style={{ textAlign: "right" }}>{pct(r.incidence)}</td>
                <td style={{ textAlign: "right" }}>{pct(r.completionRate)}</td>
                <td style={{ textAlign: "right" }}>{duration(r.medianSeconds)}</td>
                <td className="muted" style={{ fontSize: 12 }}>{when(r.lastResponse)}</td>
              </tr>
            ))}
            {shown.length > 1 && (
              <tr data-testid="fw-total">
                <td><strong>All sources</strong></td>
                <td style={{ textAlign: "right" }}>{targetTotal || "—"}</td>
                <td style={{ textAlign: "right" }}><strong>{totals.completes}</strong></td>
                <td style={{ textAlign: "right" }}>{totals.starts}</td>
                <td colSpan={2} />
                <td />
                <td colSpan={4} className="muted" style={{ fontSize: 12 }}>
                  Rates are not summed — an average of incidences is not the incidence.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* -------------------------------------------------------- declared */}
      <h3 className="sec" style={{ marginTop: 18 }}>Declared sources</h3>
      <div className="card" data-testid="fw-declared">
        {sources.length === 0 && (
          <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
            None declared. A source does not have to be declared for its responses to be recorded — declaring it adds a
            name, a target and a link of its own.
          </p>
        )}
        {sources.map((x) => {
          const delivered = shown.find((r) => r.code.toLowerCase() === x.code.toLowerCase());
          const left = x.targetCompletes == null ? null : x.targetCompletes - (delivered?.completes ?? 0);
          return (
            <div key={x.id} className="row" style={{ flexWrap: "wrap", gap: 8, paddingBottom: 10, marginBottom: 10, borderBottom: "1px solid var(--line)" }} data-testid={`fw-src-${x.code}`}>
              <input className="input mono" style={{ width: 120 }} defaultValue={x.code} readOnly aria-label="source code" />
              <input className="input" style={{ width: 170 }} defaultValue={x.label}
                data-testid={`fw-label-${x.code}`}
                onBlur={(e) => { if (e.target.value.trim() !== x.label) void declare({ code: x.code, label: e.target.value, targetCompletes: x.targetCompletes, costPerComplete: x.costPerComplete, notes: x.notes }); }} />
              <label className="f" style={{ width: 130 }}>
                <span>Target</span>
                <input className="input" type="number" min={0} defaultValue={x.targetCompletes ?? ""}
                  data-testid={`fw-target-${x.code}`}
                  onBlur={(e) => { const v = e.target.value === "" ? null : Number(e.target.value); if (v !== x.targetCompletes) void declare({ code: x.code, label: x.label, targetCompletes: v, costPerComplete: x.costPerComplete, notes: x.notes }); }} />
              </label>
              <label className="f" style={{ width: 140 }}>
                <span>Cost / complete</span>
                <input className="input" type="number" min={0} step="0.01" defaultValue={x.costPerComplete ?? ""}
                  onBlur={(e) => { const v = e.target.value === "" ? null : Number(e.target.value); if (v !== x.costPerComplete) void declare({ code: x.code, label: x.label, targetCompletes: x.targetCompletes, costPerComplete: v, notes: x.notes }); }} />
              </label>
              {left != null && (
                <span className={`chip ${left <= 0 ? "on" : "warn"}`} data-testid={`fw-left-${x.code}`}>
                  {left <= 0 ? "target met" : `${left} to go`}
                </span>
              )}
              <span className="grow" />
              <button className="btn small" data-testid={`fw-copy-${x.code}`} onClick={() => copy(x.code)}>
                {copied === x.code ? "✓ copied" : "copy link"}
              </button>
              <button className="btn small danger" disabled={busy} onClick={() => void undeclare(x.code)}>remove</button>
              <div className="mono muted" style={{ fontSize: 11, flexBasis: "100%", wordBreak: "break-all" }}>
                {linkFor(x.code)}
              </div>
            </div>
          );
        })}

        <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <label className="f" style={{ width: 130 }}>
            <span>Code</span>
            <input className="input mono" placeholder="cint" value={draft.code} data-testid="fw-new-code"
              onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
          </label>
          <label className="f" style={{ width: 180 }}>
            <span>Name</span>
            <input className="input" placeholder="Cint — UK consumers" value={draft.label} data-testid="fw-new-label"
              onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          </label>
          <label className="f" style={{ width: 130 }}>
            <span>Completes target</span>
            <input className="input" type="number" min={0} placeholder="400" value={draft.target} data-testid="fw-new-target"
              onChange={(e) => setDraft({ ...draft, target: e.target.value })} />
          </label>
          <label className="f" style={{ width: 140 }}>
            <span>Cost / complete</span>
            <input className="input" type="number" min={0} step="0.01" placeholder="3.20" value={draft.cost}
              onChange={(e) => setDraft({ ...draft, cost: e.target.value })} />
          </label>
          <button className="btn primary small" disabled={busy} data-testid="fw-add" onClick={() => void add()}>
            + Declare source
          </button>
        </div>
      </div>

      <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
        Each link carries <code className="mono">{sourceParam}=</code> for the source and{" "}
        <code className="mono">{respondentParam}=</code> for the supplier&apos;s own respondent id — replace{" "}
        <code className="mono">[%RESPONDENT_ID%]</code> with whatever macro their platform uses. The source is recorded
        once, at the first page: a respondent who later resumes from a different supplier&apos;s link stays credited to
        the one who actually sent them.{" "}
        {declaredCodes.size > 0 && shown.some((r) => !r.declared && r.code !== "(none)")
          ? "One or more sources below arrived undeclared — worth checking the links you sent out."
          : ""}
      </p>
    </div>
  );
}
