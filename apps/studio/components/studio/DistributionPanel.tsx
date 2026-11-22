"use client";
import React from "react";
import { useStudio } from "./store";
import { PortalAccessPanel } from "./PortalAccessPanel";
import { AddPeople } from "./people/AddPeople";

type Env = "TEST" | "LIVE";
type Field = "email" | "external_id" | "name" | "embedded";

interface Row {
  id: string;
  token: string;
  name: string | null;
  email: string | null;
  externalId: string | null;
  status: string;
  listName: string | null;
  sentAt: string | null;
  invitedAt: string | null;
  embeddedCount: number;
}

interface Stat {
  listName: string;
  total: number; sent: number; notSent: number; waiting: number;
  started: number; completed: number; screened: number; quotaFull: number; terminated: number;
  lastInvited: string | null;
}

interface Preview {
  headers: string[];
  mapping: Record<string, Field>;
  sheetName?: string;
  sheetNames?: string[];
  summary: {
    read: number; people: number; dropped: number; duplicatesInFile: number;
    withEmail: number; withExternalId: number; embeddedFields: string[];
  };
  issues: string[];
  duplicates: string[];
  sample: { email: string | null; external_id: string | null; name: string | null; embedded: Record<string, unknown> }[];
  rows: Record<string, unknown>[];
  blocking: string | null;
  listName: string | null;
}

const STATUS_CHIP: Record<string, string> = {
  invited: "", started: "warn", in_progress: "warn",
  complete: "on", screened: "warn", quota_full: "warn", terminated: "warn",
};

/**
 * DISTRIBUTION (§24).
 *
 * `access.mode` has offered `unique_links` and `invitation` since the first
 * release, and until this panel neither worked: nothing could put a row in
 * `respondents`, so the live link refused everyone. The Studio admitted it in
 * a warning chip on the access-mode setting. This is what that chip pointed
 * at.
 *
 * Four things, which are the four steps of actually fielding an invited
 * study:
 *
 *   UPLOAD    a list — paste it or choose a file — previewed before anything
 *             is written, because inviting the wrong file cannot be undone
 *             once the links are out
 *   WATCH     progress per wave: sent, still waiting on an unopened link,
 *             started, finished. The "waiting" column is the one this screen
 *             exists for — it is the answer to "who do we chase"
 *   HAND OUT  the links, as a spreadsheet or CSV, optionally only the ones
 *             that have not been sent, plus a QR code for the open link
 *   SEND      each person their own link by email (migration 0016), only ever
 *             to those who have not had one — a second link is a second
 *             possible interview — or RECORD that you sent them yourself,
 *             which is what this step was before the platform could send
 *
 * A token is never chosen here. `respondents.token` is generated inside the
 * database, and the first time this code sees one is when it reads it back to
 * build a link.
 */
export function DistributionPanel() {
  const s = useStudio();
  const [env, setEnv] = React.useState<Env>("LIVE");
  const [rows, setRows] = React.useState<Row[]>([]);
  const [total, setTotal] = React.useState(0);
  const [stats, setStats] = React.useState<Stat[]>([]);
  const [available, setAvailable] = React.useState(true);
  const [note, setNote] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [listFilter, setListFilter] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [qr, setQr] = React.useState<{ svg: string; url: string } | null>(null);
  /*
   * Whether this instance can send at all, and whether it can reach real
   * people. Read once from /api/mail-status rather than assumed: the button has
   * to say what it will actually do, and on a staging instance what it will
   * actually do is send everything to one address.
   */
  const [mail, setMail] = React.useState<{ configured: boolean; canReachRealRecipients: boolean; redirectTo: string | null } | null>(null);

  // the upload draft

  const say = (text: string, ok = true) => { setNote({ text, ok }); setTimeout(() => setNote(null), 8000); };

  const refresh = React.useCallback(() => {
    const qs = new URLSearchParams({ environment: env, limit: "100" });
    if (listFilter) qs.set("list", listFilter);
    if (search.trim()) qs.set("search", search.trim());
    fetch(`/api/surveys/${s.surveyDbId}/respondents?${qs}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setRows(d.rows ?? []);
        setTotal(d.total ?? 0);
        setStats(d.stats ?? []);
        setAvailable(d.available !== false);
        if (d.note) setNote({ text: d.note, ok: false });
      })
      .catch(() => {});
  }, [s.surveyDbId, env, listFilter, search]);
  React.useEffect(refresh, [refresh]);

  React.useEffect(() => {
    fetch("/api/mail-status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.mail) setMail(d.mail); })
      .catch(() => {});
  }, []);

  /* the environment is a different list entirely: nothing carries over */
  React.useEffect(() => { setListFilter(""); setQr(null); }, [env]);

  /*
   * §24 — email the links.
   *
   * `onlyUnsent` is true, always, from this button: "send this wave" means
   * "send it to the people who have not had it". Re-sending to somebody who
   * already has a link gives them a second one, and a second possible
   * interview — so a deliberate re-send is a separate, confirmed action
   * below rather than the same button pressed twice.
   */
  const sendInvitations = async (list: string | null, opts: { again?: boolean } = {}) => {
    if (!mail?.configured) {
      say("No mail is configured on this instance — download the links and send them yourself.", false);
      return;
    }
    const wave = list ? `“${list}”` : "this list";
    if (opts.again) {
      if (!confirm(`Re-send to everybody in ${wave}, including people who already have their link?

Anybody who has already been emailed will get a SECOND link. Both work, so they could answer twice.`)) return;
    } else if (!mail.canReachRealRecipients) {
      if (!confirm(`This is not the production platform.

${mail.redirectTo ? `Every email will go to ${mail.redirectTo} instead of to the respondents.` : "Nothing will actually be delivered."}

Send anyway?`)) return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/respondents/send`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ environment: env, list: list ?? undefined, onlyUnsent: !opts.again }),
      });
      const j = await r.json();
      if (!r.ok) { say(j.error ?? `That failed (${r.status})`, false); return; }
      const su = j.summary ?? {};
      const bits = [`Emailed ${su.sent ?? 0} of ${su.total ?? 0}.`];
      if (su.duplicate) bits.push(`${su.duplicate} already had theirs.`);
      if (su.invalid) bits.push(`${su.invalid} had an address that is not valid.`);
      if (su.failed) bits.push(`${su.failed} failed — they stay marked unsent, so sending again will pick them up.`);
      if (j.note) bits.push(j.note);
      say(bits.join(" "), (su.failed ?? 0) === 0);
      refresh();
    } catch (e) { say((e as Error).message, false); }
    finally { setBusy(false); }
  };

  const markSent = async (list: string | null, ids?: string[]) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/respondents`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ environment: env, action: "mark_sent", ...(ids ? { ids } : { list }) }),
      });
      const j = await r.json();
      if (!r.ok) say(j.error ?? "That failed", false);
      else { say(`Marked ${j.affected} invitation${j.affected === 1 ? "" : "s"} as sent.`); refresh(); }
    } finally { setBusy(false); }
  };

  const renameList = async (list: string) => {
    const to = window.prompt(`A new name for “${list}”`, list)?.trim();
    if (!to || to === list) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/respondents`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ environment: env, action: "rename_list", list, to }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { say(j.error ?? `That failed (${r.status})`, false); return; }
      say(`“${list}” is now “${to}”.`);
      if (listFilter === list) setListFilter(to);
      refresh();
    } finally { setBusy(false); }
  };

  const removeUnused = async (list: string) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/respondents?environment=${env}&list=${encodeURIComponent(list)}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok) say(j.error ?? "That failed", false);
      else { say(`Removed ${j.removed} unopened invitation${j.removed === 1 ? "" : "s"}. ${j.note ?? ""}`); refresh(); }
    } finally { setBusy(false); }
  };

  const download = (format: "xlsx" | "csv", opts: { list?: string; onlyUnsent?: boolean } = {}) => {
    const qs = new URLSearchParams({ environment: env, format });
    if (opts.list) qs.set("list", opts.list);
    if (opts.onlyUnsent) qs.set("onlyUnsent", "1");
    window.open(`/api/surveys/${s.surveyDbId}/respondents/links?${qs}`, "_blank");
  };

  const loadQr = async () => {
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/qr?environment=${env}`, { cache: "no-store" });
      if (!r.ok) { const j = await r.json().catch(() => ({})); say(j.error ?? "No QR code yet", false); setQr(null); return; }
      setQr({ svg: await r.text(), url: r.headers.get("x-rescript-url") ?? "" });
    } catch (e) { say((e as Error).message, false); }
  };

  const mode = s.def.deployment.access.mode;
  const personal = mode === "unique_links" || mode === "invitation";
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
  const lists = stats.map((x) => x.listName);

  return (
    <div>
      <div className="row" style={{ marginBottom: 14, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Distribution</h2>
        <span className="grow" />
        <div className="row" style={{ gap: 4 }} data-testid="ds-env">
          {(["LIVE", "TEST"] as Env[]).map((e) => (
            <button key={e} className={`btn small ${env === e ? "primary" : ""}`} data-testid={`ds-env-${e}`} onClick={() => setEnv(e)}>
              {e === "TEST" ? "Test list" : "Live list"}
            </button>
          ))}
        </div>
        <button className="btn small" onClick={refresh}>↻ refresh</button>
        <button className={`btn small ${uploadOpen ? "primary" : ""}`} data-testid="ds-upload-open" onClick={() => setUploadOpen((o) => !o)}>
          + Add people
        </button>
      </div>

      <p className="muted" style={{ fontSize: 13 }}>
        One personal link per respondent. Each link&apos;s token is generated inside the database, so nobody — including
        this application — can guess or reconstruct another respondent&apos;s link. The two lists are separate:{" "}
        <strong>{env === "TEST" ? "test" : "live"}</strong> tokens only open the {env === "TEST" ? "test" : "live"} link,
        which is what lets you rehearse with a few rows of the client&apos;s own file without burning their real
        invitations.
      </p>

      {!personal && (
        <div className="chip warn qd-note" data-testid="ds-mode-note">
          This survey&apos;s access mode is <strong>{mode}</strong>, so respondents do not need a personal link and this
          list is not consulted. Set the access mode to “unique links” or “invitation” under Survey Settings to use it.
        </div>
      )}
      {!available && (
        <div className="chip warn qd-note" data-testid="ds-migration-note">
          Respondent lists need migration 0013. A list can be uploaded once it is applied.
        </div>
      )}
      {note && <div className={`chip ${note.ok ? "on" : "warn"} qd-note`} data-testid="ds-note">{note.text}</div>}

      <ol className="muted" style={{ display: "flex", gap: 18, flexWrap: "wrap", listStyle: "none", padding: 0, margin: "0 0 12px", fontSize: 12.5 }} data-testid="ds-guide">
        <li><strong>1. Add people</strong>: type them in or upload a file.</li>
        <li><strong>2. Check your lists</strong>: who is on each, and how far they have got.</li>
        <li><strong>3. Send invitations</strong>: {mail?.configured ? "by email from here, or download the links." : "download each person's link and send it yourself."}</li>
      </ol>
      {available && stats.length === 0 && !uploadOpen && (
        <div className="card" style={{ textAlign: "center", padding: 22 }} data-testid="ds-empty">
          <p style={{ margin: "0 0 10px" }}>Nobody is on the {env === "TEST" ? "test" : "live"} list yet.</p>
          <button className="btn primary" onClick={() => setUploadOpen(true)} data-testid="ds-empty-add">Add people</button>
        </div>
      )}

      {/* ---------------------------------------------------------- add people */}
      {uploadOpen && (
        <AddPeople surveyId={s.surveyDbId!} env={env} lists={lists.filter((x): x is string => !!x)} defaultList={listFilter || undefined} onClose={() => setUploadOpen(false)}
          onAdded={(r) => { say(`Added ${r.inserted} ${r.inserted === 1 ? "person" : "people"}${r.listName ? ` to “${r.listName}”` : ""}.${r.leftOut ? ` ${r.leftOut} already on the list ${r.leftOut === 1 ? "was" : "were"} left as ${r.leftOut === 1 ? "it was" : "they were"}.` : ""} Next: send their invitations from “Your lists” below.`); refresh(); }} />
      )}

      <h3 className="sec">Your lists</h3>
      <div className="card" style={{ padding: 0, overflowX: "auto" }} data-testid="ds-stats">
        <table className="grid" style={{ minWidth: 860 }}>
          <thead>
            <tr>
              <th>List</th>
              <th style={{ textAlign: "right" }}>People</th>
              <th style={{ textAlign: "right" }}>Links sent</th>
              <th style={{ textAlign: "right" }}>Not sent</th>
              <th style={{ textAlign: "right" }}>Still waiting</th>
              <th style={{ textAlign: "right" }}>Started</th>
              <th style={{ textAlign: "right" }}>Completed</th>
              <th style={{ width: 260 }}>Links</th>
            </tr>
          </thead>
          <tbody>
            {stats.length === 0 && (
              <tr><td colSpan={8} className="muted" style={{ padding: 14 }}>
                Nobody on the {env === "TEST" ? "test" : "live"} list yet. Add people, and each one gets their own link.
              </td></tr>
            )}
            {stats.map((x) => (
              <tr key={x.listName} data-testid={`ds-list-${x.listName}`}>
                <td>
                  <button className="rm-code" onClick={() => setListFilter(x.listName === "(no list)" ? "" : x.listName)}>
                    {x.listName}
                  </button>
                </td>
                <td style={{ textAlign: "right" }}><strong>{x.total}</strong></td>
                <td style={{ textAlign: "right" }}>{x.sent}</td>
                <td style={{ textAlign: "right" }}>{x.notSent || "—"}</td>
                <td style={{ textAlign: "right" }} title="Invited, and has not opened their link">
                  {x.waiting ? <span className="chip warn">{x.waiting}</span> : "—"}
                </td>
                <td style={{ textAlign: "right" }}>{x.started}</td>
                <td style={{ textAlign: "right" }}><strong>{x.completed}</strong></td>
                <td>
                  <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                    <button className="btn small" data-testid={`ds-xlsx-${x.listName}`}
                      onClick={() => download("xlsx", { list: x.listName === "(no list)" ? undefined : x.listName })}>
                      Download links (Excel)
                    </button>
                    <button className="btn small"
                      onClick={() => download("csv", { list: x.listName === "(no list)" ? undefined : x.listName })}>
                      CSV
                    </button>
                    {x.notSent > 0 && (
                      <button className="btn small" title="Only the links that have not gone out yet"
                        onClick={() => download("xlsx", { list: x.listName === "(no list)" ? undefined : x.listName, onlyUnsent: true })}>
                        Unsent only
                      </button>
                    )}
                    {x.notSent > 0 && mail?.configured && (
                      <button className="btn small primary" disabled={busy} data-testid={`ds-email-${x.listName}`}
                        title={mail.canReachRealRecipients
                          ? `Email their link to the ${x.notSent} who have not had one`
                          : "This is not the production platform — see what happens before you send"}
                        onClick={() => void sendInvitations(x.listName === "(no list)" ? null : x.listName)}>
                        Email {x.notSent} invitation{x.notSent === 1 ? "" : "s"}
                      </button>
                    )}
                    {x.notSent === 0 && x.total > 0 && mail?.configured && (
                      <button className="btn small ghost" disabled={busy} data-testid={`ds-again-${x.listName}`}
                        title="Everybody here has had a link. Sending again gives them a second one."
                        onClick={() => void sendInvitations(x.listName === "(no list)" ? null : x.listName, { again: true })}>
                        Send again
                      </button>
                    )}
                    {x.notSent > 0 && (
                      <button className="btn small ghost" disabled={busy} data-testid={`ds-sent-${x.listName}`}
                        title="Record that you sent these yourself, without emailing anything"
                        onClick={() => void markSent(x.listName === "(no list)" ? null : x.listName)}>
                        I sent these myself
                      </button>
                    )}
                    {x.waiting > 0 && x.listName !== "(no list)" && (
                      <button className="btn small ghost danger" disabled={busy}
                        title="Removes only the invitations nobody has opened"
                        onClick={() => void removeUnused(x.listName)}>
                        Remove unopened
                      </button>
                    )}
                    {x.listName !== "(no list)" && (
                      <button className="btn small ghost" disabled={busy} data-testid={`ds-rename-${x.listName}`} title="Give this list another name"
                        onClick={() => void renameList(x.listName)}>
                        Rename
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        “Still waiting” is the number this screen exists for: invited, link sent, and they have not opened it.{" "}
        {mail?.configured
          ? <>“Email” sends each person their own link and stamps them sent — only to those who have not had one, because a second link is a second possible interview. <strong>Mark sent</strong> is still there for links you sent yourself.</>
          : <>No mail is configured on this instance, so the links come out as a file and <strong>mark sent</strong> is how you record that they went.</>}
      </p>

      {/* ----------------------------------------------------------- the QR */}
      <h3 className="sec">QR code</h3>
      <div className="card" data-testid="ds-qr">
        <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <button className="btn small" data-testid="ds-qr-load" onClick={() => void loadQr()}>
              {qr ? "↻ rebuild" : "Show the QR code"}
            </button>
            <p className="muted" style={{ fontSize: 12, maxWidth: 420, marginBottom: 0 }}>
              For a link that cannot be clicked — a poster, a card at a till, the last slide of a session. It encodes the{" "}
              <strong>open</strong> {env === "TEST" ? "test" : "live"} link and carries no token, because a code shown to
              a room is not personal. It is SVG, so it stays sharp at poster size.
            </p>
          </div>
          {qr && (
            <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
              <div style={{ width: 160, height: 160, background: "#fff", padding: 6, borderRadius: 6 }}
                data-testid="ds-qr-img"
                dangerouslySetInnerHTML={{ __html: qr.svg }} />
              <div>
                <div className="mono muted" style={{ fontSize: 11, wordBreak: "break-all", maxWidth: 320 }}>{qr.url}</div>
                <div className="row" style={{ gap: 4, marginTop: 6 }}>
                  <a className="btn small" href={`/api/surveys/${s.surveyDbId}/qr?environment=${env}&format=svg&download=1`}>svg</a>
                  <a className="btn small" href={`/api/surveys/${s.surveyDbId}/qr?environment=${env}&format=png&width=1024&download=1`}>png</a>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* -------------------------------------------------------- the people */}
      <h3 className="sec">
        People {listFilter ? <span className="muted">— {listFilter}</span> : null}
      </h3>
      <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <input className="input" style={{ width: 240 }} placeholder="Search name, email or id…"
          data-testid="ds-search" value={search} onChange={(e) => setSearch(e.target.value)} />
        {lists.length > 1 && (
          <select className="select" style={{ width: 190 }} value={listFilter} data-testid="ds-list-filter"
            onChange={(e) => setListFilter(e.target.value)}>
            <option value="">Every list</option>
            {lists.filter((l) => l !== "(no list)").map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        )}
        <span className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>
          {rows.length} of {total} shown
        </span>
      </div>
      <div className="card" style={{ padding: 0, overflowX: "auto" }} data-testid="ds-people">
        <table className="grid" style={{ minWidth: 760 }}>
          <thead>
            <tr>
              <th>Name</th><th>Email</th><th>Their id</th><th>List</th>
              <th>Status</th><th>Link sent</th><th>Added</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="muted" style={{ padding: 14 }}>Nobody matches.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} data-testid="ds-person">
                <td>
                  {r.name ?? <span className="muted">—</span>}
                  {r.embeddedCount > 0 && (
                    <span className="chip" style={{ marginLeft: 6 }} title="Fields from the uploaded list travel with this respondent">
                      +{r.embeddedCount}
                    </span>
                  )}
                </td>
                <td className="mono">{r.email ?? "—"}</td>
                <td className="mono">{r.externalId ?? "—"}</td>
                <td>{r.listName ?? <span className="muted">—</span>}</td>
                <td><span className={`chip ${STATUS_CHIP[r.status] ?? ""}`}>{r.status.replace("_", " ")}</span></td>
                <td className="rm-when">{r.sentAt ? when(r.sentAt) : <span className="muted">not sent</span>}</td>
                <td className="rm-when">{when(r.invitedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        A respondent&apos;s own link is deliberately not shown on screen and not copyable from here: it is a working
        credential for one person, and a screen that displays 4 000 of them is a screenshot away from being a leak.
        Download the list to distribute it.
      </p>
      <PortalAccessPanel />
    </div>
  );
}
