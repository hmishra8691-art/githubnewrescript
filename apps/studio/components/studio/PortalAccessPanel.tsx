"use client";
import React from "react";
import { PORTAL_TEMPLATES, applyPortalTemplate, portalTemplate, templateRules } from "@rescript/engine";
import { PortalSettings } from "@rescript/schema";
import { PortalPersonResults } from "./PortalPersonResults";
import { PortalRequestsPanel } from "./PortalRequestsPanel";
import { PortalScorecardPanel } from "./PortalScorecardPanel";
import { useStudio } from "./store";

/**
 * RESPONDENT PORTAL (Respondent Intelligence Engine, phase 1, 2026-11-20) — on the Distribution tab.
 *
 * Two parts. The SETTINGS are part of the survey (saved with it, in force once published): whether signed-in
 * respondents may see their answers, and whether and until when they may change them. The LIST is live: who has a
 * portal account, their access window and attempts, and the pause / lock / reopen switches for each person.
 *
 * A link or first password is shown here only for a person with no email address, once, to hand over; for anyone
 * with an address the invitation is emailed and never displayed (lib/portalAdminCore.ts says why).
 */
interface Row {
  id: string; email: string | null; name: string | null; externalId: string | null; list: string | null; status: string;
  accessFrom: string | null; accessUntil: string | null; maxAttempts: number | null; suspended: boolean; lockedAt: string | null; reopenedUntil: string | null;
  account: { respondentId: string; status: string; scope: string; hasPassword: boolean; invitePending: boolean } | null;
}
interface HandOver { id: string; respondentId: string; name: string | null; link?: string; password?: string }
type Editing = PortalSettings["editing"];

const DEFAULTS: PortalSettings = PortalSettings.parse({ enabled: true });
const local = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");
const toInput = (iso: string | null | undefined) => { if (!iso) return ""; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
const fromInput = (v: string) => (v ? new Date(v).toISOString() : null);

export function PortalAccessPanel() {
  const s = useStudio();
  const portal = s.def.portal;
  const on = !!portal?.enabled;
  const set = (f: (p: PortalSettings) => void) => s.update((d) => { d.portal = d.portal ?? structuredClone(DEFAULTS); f(d.portal); });
  const editing: Editing = portal?.editing ?? DEFAULTS.editing;

  const [rows, setRows] = React.useState<Row[]>([]);
  const [total, setTotal] = React.useState(0);
  const [state, setState] = React.useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [canManage, setCanManage] = React.useState(false);
  const [canIndividual, setCanIndividual] = React.useState(false);
  const [viewing, setViewing] = React.useState<string | null>(null);
  const [mail, setMail] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [handOver, setHandOver] = React.useState<HandOver[]>([]);
  const [until, setUntil] = React.useState("");
  const [win, setWin] = React.useState({ from: "", until: "", attempts: "" });

  const load = React.useCallback(async () => {
    if (!s.surveyDbId) return;
    const qs = new URLSearchParams({ limit: "200" });
    if (search.trim()) qs.set("search", search.trim());
    const r = await fetch(`/api/surveys/${s.surveyDbId}/portal?${qs}`, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setState("error"); setNote({ text: j.error ?? `Could not load (${r.status})`, ok: false }); return; }
    if (!j.available) { setState("unavailable"); return; }
    setRows(j.rows ?? []); setTotal(j.total ?? 0); setCanManage(!!j.canManage); setCanIndividual(!!j.canIndividual); setMail(!!j.mail); setState("ready");
  }, [s.surveyDbId, search]);
  React.useEffect(() => { if (on) void load(); }, [on, load]);

  const act = async (action: string, extra: Record<string, unknown> = {}, ids: string[] = [...picked]) => {
    if (!ids.length) { setNote({ text: "Choose at least one respondent.", ok: false }); return; }
    setBusy(true); setNote(null);
    const r = await fetch(`/api/surveys/${s.surveyDbId}/portal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ids, ...extra }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setNote({ text: j.error ?? `That did not work (${r.status}).`, ok: false }); return; }
    const parts = [
      j.created ? `${j.created} account${j.created === 1 ? "" : "s"} created` : "", j.linked ? `${j.linked} joined an existing account` : "", j.emailed ? `${j.emailed} invitation${j.emailed === 1 ? "" : "s"} emailed` : "",
      !j.created && !j.linked && !j.emailed && j.changed ? `${j.changed} updated` : "", j.skipped?.length ? `${j.skipped.length} skipped: ${[...new Set((j.skipped as { why: string }[]).map((x) => x.why))].slice(0, 3).join("; ")}` : "",
    ].filter(Boolean);
    setNote({ text: parts.join(" · ") || "Nothing needed changing.", ok: !j.skipped?.length || !!j.changed });
    if (j.handOver?.length) setHandOver(j.handOver);
    setPicked(new Set());
    await load();
  };

  const all = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const one = picked.size === 1 ? rows.find((r) => picked.has(r.id)) : null;

  return (
    <div className="card" style={{ padding: 14, marginTop: 18 }} data-testid="portal-panel">
      <div className="row" style={{ gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 15.5 }}>Respondent portal</h3>
        <span className="muted" style={{ fontSize: 12.5 }}>A signed-in page for the people on this list: their assessments, their answers, their account.</span>
        <label className="row" style={{ gap: 6, marginLeft: "auto", fontSize: 13 }}>
          <input type="checkbox" checked={on} onChange={(e) => set((p) => { p.enabled = e.target.checked; })} data-testid="portal-enabled" /> On for this survey
        </label>
      </div>

      {on && (
        <>
          <PortalTemplatePicker current={portal?.template ?? null} onApply={(id) => s.update((d) => { const next = applyPortalTemplate(d.portal, id); if (next) d.portal = next; })} onClear={() => set((p) => { delete p.template; })} />
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", marginTop: 12 }}>
            <label style={{ fontSize: 13 }}>Identity
              <select className="select" value={portal?.identity ?? "persistent"} onChange={(e) => set((p) => { p.identity = e.target.value as PortalSettings["identity"]; })} data-testid="portal-identity">
                <option value="persistent">One account per person, across their assessments</option>
                <option value="assessment">An account for this assessment only</option>
              </select>
            </label>
            <label style={{ fontSize: 13 }}>After submitting, answers can be changed
              <select className="select" value={editing.mode} onChange={(e) => set((p) => { p.editing.mode = e.target.value as Editing["mode"]; })} data-testid="portal-editing">
                <option value="none">Never</option>
                <option value="until_deadline">Until a date</option>
                <option value="window">For a number of hours</option>
                <option value="until_locked">Until I lock them</option>
              </select>
            </label>
            {editing.mode === "until_deadline" && (
              <label style={{ fontSize: 13 }}>Until
                <input className="input" type="datetime-local" value={toInput(editing.deadline)} onChange={(e) => set((p) => { p.editing.deadline = fromInput(e.target.value) ?? undefined; })} data-testid="portal-deadline" />
              </label>
            )}
            {editing.mode === "window" && (
              <label style={{ fontSize: 13 }}>Hours after submitting
                <input className="input" type="number" min={1} max={8760} value={editing.windowHours ?? ""} onChange={(e) => set((p) => { p.editing.windowHours = Number(e.target.value) > 0 ? Number(e.target.value) : undefined; })} data-testid="portal-window" />
              </label>
            )}
            <label style={{ fontSize: 13 }}>Attempts per person
              <input className="input" type="number" min={1} max={1000} placeholder="The survey's own rule" value={portal?.maxAttempts ?? ""} onChange={(e) => set((p) => { p.maxAttempts = Number(e.target.value) >= 1 ? Math.floor(Number(e.target.value)) : undefined; })} data-testid="portal-attempts" />
            </label>
          </div>
          <div className="row" style={{ gap: 16, marginTop: 10, flexWrap: "wrap", fontSize: 13 }}>
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={!!portal?.show.answers} onChange={(e) => set((p) => { p.show.answers = e.target.checked; })} data-testid="portal-show-answers" /> Respondents can see the answers they submitted</label>
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={!!portal?.show.history} disabled={!portal?.show.answers} onChange={(e) => set((p) => { p.show.history = e.target.checked; })} data-testid="portal-show-history" /> …and their earlier attempts</label>
          </div>
          <div className="row" style={{ gap: 16, marginTop: 6, flexWrap: "wrap", fontSize: 13 }}>
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={!!portal?.show.rewards} onChange={(e) => set((p) => { p.show.rewards = e.target.checked; })} data-testid="portal-show-rewards" /> Respondents can see what they have earned: this survey's points, level and badges, and their run of on-time completions</label>
          </div>
          {editing.mode !== "none" && !portal?.show.answers && <div className="chip warn qd-note" style={{ marginTop: 8 }}>Answers can only be changed when respondents can see them. Turn that on too.</div>}
          {s.def.assessment?.enabled && editing.mode !== "none" && <div className="chip warn qd-note" style={{ marginTop: 8 }}>This is a scored test: answers are final once submitted, whatever is chosen here.</div>}
          <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>These settings are saved with the survey and apply once it is published. The switches in the list below apply immediately.</p>

          <PortalScorecardPanel />
          <PortalRequestsPanel />

          <div className="row" style={{ gap: 8, margin: "16px 0 8px", flexWrap: "wrap" }}>
            <strong style={{ fontSize: 13.5 }}>People</strong>
            <span className="muted" style={{ fontSize: 12.5 }}>{state === "ready" ? `${total} on the live list` : ""}</span>
            <input className="input" style={{ marginLeft: "auto", maxWidth: 220 }} placeholder="Search name, email, ID" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="portal-search" />
          </div>
          {state === "unavailable" && <div className="chip warn qd-note" data-testid="portal-unavailable">The portal's tables are not on this database yet. Apply migration 0103, then reload.</div>}
          {note && <div className={`chip ${note.ok ? "on" : "warn"} qd-note`} style={{ marginBottom: 8 }} data-testid="portal-note">{note.text}</div>}
          {handOver.length > 0 && (
            <div className="card" style={{ padding: 10, marginBottom: 10, borderColor: "var(--c-warning-fg)" }} data-testid="portal-handover">
              <strong style={{ fontSize: 13 }}>Hand these over now. They are shown once and are not stored readable.</strong>
              <table style={{ width: "100%", fontSize: 12.5, marginTop: 6 }}>
                <tbody>{handOver.map((h) => (<tr key={h.id}><td>{h.name ?? "—"}</td><td className="mono">{h.respondentId}</td><td className="mono" style={{ wordBreak: "break-all" }}>{h.password ? `Password: ${h.password}` : h.link}</td></tr>))}</tbody>
              </table>
              <button type="button" className="btn small" style={{ marginTop: 6 }} onClick={() => setHandOver([])}>I have noted them</button>
            </div>
          )}

          {state === "ready" && canManage && (
            <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              <button type="button" className="btn small" disabled={busy || !picked.size} onClick={() => act("create_accounts", { identity: portal?.identity ?? "persistent", sendEmail: mail })} data-testid="portal-create">Create accounts{mail ? " and invite" : ""}</button>
              <button type="button" className="btn small" disabled={busy || !picked.size} onClick={() => act("invite")} data-testid="portal-invite">Send invitation</button>
              <button type="button" className="btn small" disabled={busy || !one?.account} onClick={() => act("initial_password")} title="Only for a person with no email address" data-testid="portal-password">First password</button>
              <button type="button" className="btn small" disabled={busy || !picked.size} onClick={() => act("suspend")} data-testid="portal-suspend">Pause</button>
              <button type="button" className="btn small" disabled={busy || !picked.size} onClick={() => act("reactivate")}>Restore</button>
              <button type="button" className="btn small" disabled={busy || !picked.size} onClick={() => act("lock")} data-testid="portal-lock">Lock answers</button>
              <button type="button" className="btn small" disabled={busy || !picked.size} onClick={() => act("unlock")}>Unlock</button>
              <span className="row" style={{ gap: 4 }}>
                <input className="input" type="datetime-local" style={{ maxWidth: 190 }} value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Reopen until" data-testid="portal-reopen-until" />
                <button type="button" className="btn small" disabled={busy || !picked.size || !until} onClick={() => act("reopen", { until: fromInput(until) })} data-testid="portal-reopen">Reopen until</button>
              </span>
              <button type="button" className="btn small" disabled={busy || !one?.account} onClick={() => act("sign_out")}>Sign out</button>
              <button type="button" className="btn small" disabled={busy || !picked.size} onClick={() => { if (window.confirm("Remove this survey from the selected people's portal? Their accounts stay.")) void act("unlink"); }}>Remove from portal</button>
            </div>
          )}
          {state === "ready" && canManage && (
            <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8, fontSize: 12.5 }}>
              <span className="muted">Access for the selected:</span>
              <input className="input" type="datetime-local" style={{ maxWidth: 190 }} value={win.from} onChange={(e) => setWin({ ...win, from: e.target.value })} aria-label="Opens" />
              <span className="muted">to</span>
              <input className="input" type="datetime-local" style={{ maxWidth: 190 }} value={win.until} onChange={(e) => setWin({ ...win, until: e.target.value })} aria-label="Closes" data-testid="portal-access-until" />
              <input className="input" type="number" min={1} max={1000} style={{ maxWidth: 110 }} placeholder="Attempts" value={win.attempts} onChange={(e) => setWin({ ...win, attempts: e.target.value })} aria-label="Attempts" />
              <button type="button" className="btn small" disabled={busy || !picked.size} onClick={() => act("access", { from: fromInput(win.from), until: fromInput(win.until), maxAttempts: Number(win.attempts) >= 1 ? Math.floor(Number(win.attempts)) : null })} data-testid="portal-access">Set</button>
            </div>
          )}

          {state === "ready" && canIndividual && (
            <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: "wrap", fontSize: 12.5 }}>
              <button type="button" className="btn small" disabled={!one} onClick={() => setViewing(one!.id)} data-testid="portal-person-open">Open this person's results</button>
              <span className="muted">Choose one person. Each opening is recorded in the audit log.</span>
            </div>
          )}
          {viewing && <PortalPersonResults surveyId={s.surveyDbId!} respondent={viewing} onClose={() => setViewing(null)} />}
          {state === "ready" && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse" }} data-testid="portal-table">
                <thead>
                  <tr style={{ textAlign: "left" }}>
                    <th style={{ width: 28 }}><input type="checkbox" aria-label="Select all" checked={all} onChange={() => setPicked(all ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
                    <th>Person</th><th>Respondent ID</th><th>Account</th><th>Access</th><th>Answers</th><th>Survey</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} style={{ borderTop: "1px solid var(--c-border, #e5e7eb)" }} data-testid="portal-row">
                      <td><input type="checkbox" aria-label={`Select ${r.name ?? r.email ?? r.id}`} checked={picked.has(r.id)} onChange={() => toggle(r.id)} /></td>
                      <td>{r.name ?? "—"}<div className="muted">{r.email ?? r.externalId ?? ""}</div></td>
                      <td className="mono">{r.account?.respondentId ?? "—"}</td>
                      <td>{!r.account ? <span className="muted">No account</span> : r.account.status === "unavailable" ? <span className="chip warn">Unavailable</span> : r.account.hasPassword ? <span className="chip on">Active</span> : r.account.invitePending ? <span className="chip">Invited</span> : <span className="chip warn">Not invited</span>}{r.account?.scope === "assessment" ? <div className="muted">this assessment only</div> : null}</td>
                      <td>{r.suspended ? <span className="chip warn">Paused</span> : null}{r.accessFrom || r.accessUntil ? <div>{local(r.accessFrom) || "now"} → {local(r.accessUntil) || "no end"}</div> : !r.suspended ? <span className="muted">Open</span> : null}{r.maxAttempts ? <div className="muted">{r.maxAttempts} attempt{r.maxAttempts === 1 ? "" : "s"}</div> : null}</td>
                      <td>{r.reopenedUntil && Date.parse(r.reopenedUntil) > Date.now() ? <span className="chip on">Reopened until {local(r.reopenedUntil)}</span> : r.lockedAt ? <span className="chip warn">Locked</span> : <span className="muted">By the setting above</span>}</td>
                      <td>{r.status.replace("_", " ")}</td>
                    </tr>
                  ))}
                  {!rows.length && <tr><td colSpan={7} className="muted" style={{ padding: 12 }}>Nobody is on the live respondent list yet. Upload a list above first.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}


/**
 * THE PORTAL TEMPLATE (phase 4, 2026-11-20). A template is a starting point — its words, its note under the results
 * and its colour for respondents, and a set of switches the researcher can still change — plus a few rules that
 * kind of study must not loosen, which the engine applies wherever the settings are read. Applying one keeps the
 * scores, groups, series and locked questions already built.
 */
function PortalTemplatePicker({ current, onApply, onClear }: { current: string | null; onApply: (id: string) => void; onClear: () => void }) {
  const [picked, setPicked] = React.useState<string>(current ?? "");
  React.useEffect(() => { setPicked(current ?? ""); }, [current]);
  const t = portalTemplate(picked);
  const inUse = portalTemplate(current);
  const rules = t ? templateRules(t) : [];
  return (
    <div style={{ marginTop: 12, padding: 10, border: "1px solid var(--c-border, #e5e7eb)", borderRadius: 10 }} data-testid="portal-template">
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13.5 }}>Template</strong>
        <select className="select" style={{ maxWidth: 320 }} value={picked} onChange={(e) => setPicked(e.target.value)} aria-label="Portal template" data-testid="portal-template-select">
          <option value="">Standard portal (no template)</option>
          <optgroup label="Industry portals">{PORTAL_TEMPLATES.filter((x) => x.featured).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>
          <optgroup label="More">{PORTAL_TEMPLATES.filter((x) => !x.featured).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>
        </select>
        {t && <button type="button" className="btn small" onClick={() => onApply(t.id)} data-testid="portal-template-apply">{current === t.id ? "Reset to this template's settings" : "Use this template"}</button>}
        {!t && current && <button type="button" className="btn small" onClick={onClear} data-testid="portal-template-clear">Remove the template</button>}
        {inUse && <span className="chip on">In use: {inUse.name}</span>}
      </div>
      {t && (
        <div style={{ fontSize: 12.5, marginTop: 8 }}>
          <p style={{ margin: 0 }}>{t.summary}</p>
          <p className="muted" style={{ margin: "6px 0 0" }}>Respondents see: "{t.words.one}", "{t.words.organiser}", "{t.words.results}".{t.note ? ` Under their results: "${t.note}"` : ""}</p>
          {t.suggests.length > 0 && <p className="muted" style={{ margin: "4px 0 0" }}>Scores usually defined: {t.suggests.join(", ")}.</p>}
          {rules.length > 0 && <div className="chip warn qd-note" style={{ marginTop: 6 }}>This template always applies: {rules.join(" ")}</div>}
          {current !== t.id && <p className="muted" style={{ margin: "6px 0 0" }}>Using it sets the switches below to its starting values. Your scores, groups, series and locked questions are kept.</p>}
        </div>
      )}
      {!t && <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>A template names things for your respondents and starts you from settings that suit the kind of study. Every template runs on the same portal.</p>}
    </div>
  );
}
