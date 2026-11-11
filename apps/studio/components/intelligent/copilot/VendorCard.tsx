"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { VENDOR_OUTCOMES, VENDOR_OUTCOME_WORDS, checkVendors, findVendor, readVendorUrls, simulateVendorExits, vendorLink, type AddVendorAction } from "@rescript/engine";
import { Icon } from "../../ui/Icon";
import { surveyBaseUrl } from "../../../lib/runtime-url";
import { useCommands, type LaunchResult } from "../../studio/CommandContext";

/**
 * A VENDOR PROPOSAL, SHOWN WHOLE (2026-11-11). The proposal card says "add the vendor Acme"; this says what that
 * is: which pasted link was read as which outcome and why, the code the vendor gets, what the vendor must add to
 * the survey link, which vendors stay as they are, the checks, and every vendor's four exits resolved for a test
 * id — the same functions the flow engine runs (vendorSetup.ts), on the definition the proposal would produce.
 *
 * Once applied: Launch study. It refuses while a check fails or the publish gate objects, and says which; when it
 * goes through, the live link and each vendor's link are shown with Copy.
 */
function Copy({ text, testid }: { text: string; testid: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <button type="button" className="iq-btn" data-testid={testid} data-copy={text} onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); window.setTimeout(() => setDone(false), 1600); }, () => {}); }}>
      <Icon name={done ? "check" : "share"} size={11} /> {done ? "Copied" : "Copy link"}
    </button>
  );
}

export function VendorCard({ action, def, state, readOnly }: { action: AddVendorAction; def: SurveyDefinition; state: "open" | "applied" | "cancelled" | "superseded" | undefined; readOnly?: boolean }) {
  const reading = React.useMemo(() => readVendorUrls(action.urls, { idParam: action.idParam }), [action]);
  /* the vendor as the definition has it: after the proposal while it is open, the survey itself once applied */
  const panel = React.useMemo(() => findVendor(def, { key: action.mode === "update" ? action.key : undefined, redirects: reading.redirects }) ?? findVendor(def, { key: action.key, name: action.name ?? reading.hostName }), [def, action, reading]);
  const [pid, setPid] = React.useState("TEST12345");
  const [showTest, setShowTest] = React.useState(false);
  const [launch, setLaunch] = React.useState<{ busy: boolean; result: LaunchResult | null }>({ busy: false, result: null });
  const commands = useCommands();
  if (!panel || (state !== "open" && state !== "applied")) return null;
  const others = (def.panels ?? []).filter((p) => p.key !== panel.key);
  const check = checkVendors(def, { only: panel.key });
  const all = checkVendors(def);
  /*
   * What stops a launch: this vendor failing a check, two vendors sharing a code, or anybody's respondent being
   * sent to another vendor's link. A vendor configured earlier that has fewer than four links was live like that
   * before today — it is said, and it does not block.
   */
  const blocking = [...check.checks.filter((c) => !c.ok).map((c) => c.detail), ...all.checks.filter((c) => c.id === "codes" && !c.ok).map((c) => c.detail), ...all.simulations.filter((x) => x.vendor !== panel.key && x.problem && /goes to|recognised as/.test(x.problem)).map((x) => `${x.label}, ${VENDOR_OUTCOME_WORDS[x.outcome].toLowerCase()}: ${x.problem}`)];
  const elsewhere = all.checks.filter((c) => !c.ok && c.id !== "codes").map((c) => c.detail).filter((d) => !check.checks.some((c) => !c.ok && c.detail === d));
  const sims = showTest ? simulateVendorExits(def, { pid: pid.trim() || "TEST12345" }) : [];
  const base = `${surveyBaseUrl(def.deployment.customDomain)}/s/${def.deployment.clientSlug || "client"}/${def.deployment.studySlug || "study-001"}`;
  const doLaunch = async () => {
    const fn = commands?.context.shell?.launch;
    if (!fn) { setLaunch({ busy: false, result: { ok: false, error: "Launch is not available here — publish from the Studio's top bar." } }); return; }
    setLaunch({ busy: true, result: null });
    try { setLaunch({ busy: false, result: await fn() }); } catch (e) { setLaunch({ busy: false, result: { ok: false, error: e instanceof Error ? e.message : String(e) } }); }
  };
  return (
    <div className="vendor-card" data-testid="vendor-card" data-vendor={panel.key} data-state={state} data-checks={check.ok ? "pass" : "fail"}>
      <div className="vendor-head">
        <span className="iq-label">{action.mode === "update" ? "Vendor update" : "New vendor"}</span>
        <b data-testid="vendor-name">{panel.label}</b>
        <span className="vendor-code" data-testid="vendor-code" title="Travels on the vendor's link as rp=<code>; recorded as the response's source">code {panel.key}</span>
        {action.mode !== "update" && <span className="vendor-pill" data-testid="vendor-independent">independent of other vendors</span>}
      </div>
      <table className="vendor-table" data-testid="vendor-links">
        <thead><tr><th>Outcome</th><th>Redirect</th><th>Recognised by</th></tr></thead>
        <tbody>
          {VENDOR_OUTCOMES.map((o) => {
            const u = reading.urls.find((x) => x.outcome === o);
            return (
              <tr key={o} data-testid={`vendor-link-${o}`} data-confidence={u?.confidence ?? ""}>
                <td>{VENDOR_OUTCOME_WORDS[o]}</td>
                <td className="mono">{panel.redirects[o] ?? "—"}</td>
                <td>{u ? <>{u.evidence}{u.confidence === "inferred" ? <span className="iq-warning"> · worked out — please check</span> : null}</> : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <dl className="vendor-facts">
        <div><dt>Respondent id</dt><dd data-testid="vendor-id">{panel.idParam}{reading.urls.some((u) => u.fixed.length) ? <span className="iqi-dim"> · sent as written: {[...new Set(reading.urls.flatMap((u) => u.fixed.map((f) => f.param)))].join(", ")}</span> : null}{panel.params.length ? <span className="iqi-dim"> · kept: {panel.params.map((p) => p.param).join(", ")}</span> : null}</dd></div>
        <div><dt>Link for {panel.label}</dt><dd><span className="mono" data-testid="vendor-entry-link">{vendorLink(base, panel)}</span></dd></div>
        <div><dt>Other vendors</dt><dd data-testid="vendor-others">{others.length ? `${others.map((p) => `${p.label} (${p.key})`).join(", ")} — not changed` : "none on this study yet"}</dd></div>
      </dl>
      {reading.notes.map((n, i) => <p key={i} className="iq-warning" data-testid="vendor-note"><Icon name="info" size={12} /> {n}</p>)}
      <ul className="vendor-checks" data-testid="vendor-checks">
        {check.checks.map((c) => <li key={c.id} data-testid={`vendor-check-${c.id}`} data-ok={c.ok ? "1" : "0"}><Icon name={c.ok ? "check" : "warning"} size={12} /> <b>{c.label}</b><span className="iqi-dim"> — {c.detail}</span></li>)}
      </ul>
      <div className="vendor-test">
        <button type="button" className="iq-btn" data-testid="vendor-test-toggle" onClick={() => setShowTest((v) => !v)}>{showTest ? "Hide the redirect test" : "Test the redirects"}</button>
        {showTest && (
          <>
            <label className="iqi-dim">Test respondent id <input className="input mono" data-testid="vendor-test-pid" value={pid} onChange={(e) => setPid(e.target.value)} style={{ width: 140 }} /></label>
            <table className="vendor-table" data-testid="vendor-sim">
              <thead><tr><th>Vendor</th><th>Outcome</th><th>Respondent is sent to</th></tr></thead>
              <tbody>
                {sims.map((x) => (
                  <tr key={`${x.vendor}-${x.outcome}`} data-testid={`vendor-sim-${x.vendor}-${x.outcome}`} data-ok={x.ok ? "1" : "0"}>
                    <td>{x.label}</td><td>{VENDOR_OUTCOME_WORDS[x.outcome]}</td>
                    <td className="mono">{x.url ?? "—"}{x.problem ? <span className="iq-warning"> · {x.problem}</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
      {state === "applied" && (
        <div className="vendor-launch" data-testid="vendor-launch">
          {!launch.result?.ok && (
            <button type="button" className="iq-btn primary" data-testid="vendor-launch-btn" disabled={launch.busy || readOnly || blocking.length > 0} title={blocking.length ? "A vendor check is failing — fix it before launching" : readOnly ? "Read-only" : "Save a version, publish it to the live link and show the links to share"} onClick={() => void doLaunch()}>
              {launch.busy ? "Launching…" : "Launch study"}
            </button>
          )}
          {blocking.length > 0 && <p className="iq-warning" data-testid="vendor-launch-blocked"><Icon name="warning" size={12} /> Not ready to launch: {blocking.join("; ")}</p>}
          {!blocking.length && elsewhere.length > 0 && !launch.result?.ok && <p className="iqi-dim" data-testid="vendor-launch-note"><Icon name="info" size={11} /> Other vendors, as they were configured before: {elsewhere.join("; ")}</p>}
          {launch.result && !launch.result.ok && (
            <div className="cp-refused" role="alert" data-testid="vendor-launch-error">
              <span className="iq-label">Not launched</span>
              <p style={{ margin: "2px 0" }}>{launch.result.error}</p>
              {launch.result.problems?.length ? <ul>{launch.result.problems.map((p, i) => <li key={i}>{p.area}: {p.message}</li>)}</ul> : null}
            </div>
          )}
          {launch.result?.ok && (
            <div className="vendor-live" data-testid="vendor-live">
              <p className="cp-applied-note"><Icon name="check" size={12} /> Live{launch.result.version ? ` on version ${launch.result.version}` : ""} — {panel.label} is active{others.length ? `, with ${others.map((p) => p.label).join(", ")}` : ""}.</p>
              {(def.panels ?? []).filter((p) => p.targets.includes("survey")).map((p) => (
                <p key={p.key} className="vendor-live-row" data-testid={`vendor-live-${p.key}`}><span>Link for {p.label}</span><span className="mono">{vendorLink(launch.result!.url!, p)}</span><Copy text={vendorLink(launch.result!.url!, p)} testid={`vendor-copy-${p.key}`} /></p>
              ))}
              <p className="vendor-live-row" data-testid="vendor-live-plain"><span>Survey link</span><span className="mono">{launch.result.url}</span><Copy text={launch.result.url!} testid="vendor-copy-plain" /></p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
