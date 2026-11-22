"use client";
import React from "react";
import { useStudio } from "../store";

/**
 * INTERVIEW BOOKING (Level 5 roadmap Q6) — Research Tools → Qualitative → Booking.
 *
 *   Times        add bookable times from availability windows (a day, from–to, length, buffer, capacity), in the
 *                researcher's own time zone; withdraw one (the people who held it are listed to contact)
 *   Invite       people from the survey's respondent list (by their ids) or typed addresses; each gets a personal
 *                link by email to pick, move or cancel a time
 *   Bookings     who was invited, who booked which time, reminders sent; after a session: attended / no-show, and
 *                the incentive owed under the study's policy (recorded, not paid); cancel on someone's behalf
 *   Target       how many more people to invite to reach a number of interviews
 *
 * Everything goes through /api/surveys/[id]/qual/scheduling (migration 0107). The sandbox has no database, so the tab
 * says so instead of pretending.
 */
type Row = Record<string, unknown>;
interface View { slots: Row[]; bookings: Row[]; counts: Record<string, number>; invitesNeeded?: { invite: number; basis: string; booked: number; attended: number }; mail: { configured: boolean } }

const offsetMinutes = () => -new Date().getTimezoneOffset();
const local = (iso: unknown) => (iso ? new Date(String(iso)).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const STATUS: Record<string, string> = { invited: "Invited", booked: "Booked", cancelled: "Cancelled", late_cancel: "Late cancel", attended: "Attended", no_show: "No-show" };

export function BookingTab() {
  const s = useStudio();
  const id = s.surveyDbId;
  const base = `/api/surveys/${id}/qual/scheduling`;
  const [view, setView] = React.useState<View | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [target, setTarget] = React.useState(12);
  const [win, setWin] = React.useState({ date: new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10), from: "10:00", to: "17:00", minutes: 45, buffer: 15, capacity: 1, moderator: "" });
  const [invite, setInvite] = React.useState({ emails: "", respondentIds: "", minutes: 45, incentive: "", senderName: "" });
  const [policy, setPolicy] = React.useState({ amount: 0, currency: "USD", lateCancelShare: 0, noShowShare: 0 });
  const [marks, setMarks] = React.useState<Record<string, "attended" | "no_show">>({});

  const load = React.useCallback(async () => {
    if (id === "sandbox") return;
    try {
      const r = await fetch(`${base}?target=${target}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `(${r.status})`);
      setView(j); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [base, id, target]);
  React.useEffect(() => { void load(); }, [load]);

  const post = async (label: string, body: Record<string, unknown>, done?: (j: Row) => string | null) => {
    setBusy(label); setError(null); setNote(null);
    try {
      const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `(${r.status})`);
      setNote(done?.(j) ?? null);
      await load();
      return j as Row;
    } catch (e) { setError((e as Error).message); return null; } finally { setBusy(null); }
  };

  if (id === "sandbox") return <div className="empty" data-testid="booking-sandbox"><p><b>Booking needs a saved project.</b></p><p className="ql-muted">Invitations, bookings and reminders are kept in the project's database, which the sandbox does not have.</p></div>;

  const slotOf = (sid: unknown) => view?.slots.find((x) => x.id === sid);
  const booked = (view?.bookings ?? []).filter((b) => b.status === "booked");

  return (
    <div data-testid="booking-tab">
      <p className="ql-muted">Offer times, invite people, and let each pick a time from their own link. Reminders go out 24 hours and 1 hour before each session.</p>
      {error && <div className="alert error" data-testid="booking-error">{error}</div>}
      {note && <div className="alert success" data-testid="booking-note">{note}</div>}
      {view && !view.mail.configured && <div className="alert warning">Email is not configured on this Studio, so invitations and reminders cannot be sent.</div>}

      <h3>Times</h3>
      <div className="ql-row" data-testid="booking-window">
        <input className="input small" type="date" value={win.date} onChange={(e) => setWin({ ...win, date: e.target.value })} aria-label="Day" />
        <input className="input small" type="time" value={win.from} onChange={(e) => setWin({ ...win, from: e.target.value })} aria-label="From" />
        <span className="ql-muted">to</span>
        <input className="input small" type="time" value={win.to} onChange={(e) => setWin({ ...win, to: e.target.value })} aria-label="To" />
        <label className="ql-muted">Length <input className="input small" type="number" min={10} max={240} style={{ width: 64 }} value={win.minutes} onChange={(e) => setWin({ ...win, minutes: Number(e.target.value) })} /> min</label>
        <label className="ql-muted">Gap <input className="input small" type="number" min={0} max={120} style={{ width: 56 }} value={win.buffer} onChange={(e) => setWin({ ...win, buffer: Number(e.target.value) })} /> min</label>
        <label className="ql-muted">Places <input className="input small" type="number" min={1} max={30} style={{ width: 52 }} value={win.capacity} onChange={(e) => setWin({ ...win, capacity: Number(e.target.value) })} /></label>
        <input className="input small" placeholder="Moderator (optional)" value={win.moderator} onChange={(e) => setWin({ ...win, moderator: e.target.value })} />
        <button className="btn primary small" disabled={!!busy} data-testid="booking-add-times" onClick={() => void post("Adding times", { action: "slots", spec: { windows: [{ date: win.date, from: win.from, to: win.to }], minutes: win.minutes, bufferMinutes: win.buffer, capacity: win.capacity, timezoneOffsetMinutes: offsetMinutes(), ...(win.moderator.trim() ? { moderator: win.moderator.trim() } : {}) } }, (j) => `Added ${j.added} time${j.added === 1 ? "" : "s"}.`)}>Add times</button>
      </div>
      <p className="ql-muted">Times are in your time zone; invitees see them in theirs.</p>
      <table className="ax-table dense" data-testid="booking-slots">
        <thead><tr><th>When</th><th>Moderator</th><th className="num">Booked</th><th className="num">Places left</th><th /></tr></thead>
        <tbody>
          {(view?.slots ?? []).map((sl) => (
            <tr key={String(sl.id)} data-status={String(sl.status)}>
              <td>{local(sl.starts_at)}{sl.status === "cancelled" ? <span className="ql-muted"> · withdrawn</span> : null}</td>
              <td>{String(sl.moderator ?? "")}</td>
              <td className="num">{String(sl.booked ?? 0)}</td>
              <td className="num">{sl.status === "cancelled" ? "—" : String(sl.left ?? 0)}</td>
              <td>{sl.status !== "cancelled" && <button className="btn small" disabled={!!busy} onClick={() => void post("Withdrawing", { action: "cancel_slot", slotId: sl.id }, (j) => { const c = (j.contact as Row[] | undefined) ?? []; return c.length ? `Withdrawn. Tell these people the time was withdrawn: ${c.map((x) => String(x.name ?? x.email)).join(", ")}.` : "Withdrawn."; })}>Withdraw</button>}</td>
            </tr>
          ))}
          {view && !view.slots.length && <tr><td colSpan={5} className="ql-muted">No times yet.</td></tr>}
        </tbody>
      </table>

      <h3>Invite</h3>
      <div className="ql-grid">
        <label className="ax-field"><span>Email addresses (one per line, or “Name &lt;email&gt;”)</span><textarea className="ta" rows={4} value={invite.emails} onChange={(e) => setInvite({ ...invite, emails: e.target.value })} data-testid="booking-emails" /></label>
        <label className="ax-field"><span>Or respondent ids from the list (one per line)</span><textarea className="ta" rows={4} value={invite.respondentIds} onChange={(e) => setInvite({ ...invite, respondentIds: e.target.value })} /></label>
      </div>
      <div className="ql-row">
        <label className="ql-muted">About <input className="input small" type="number" min={10} max={240} style={{ width: 64 }} value={invite.minutes} onChange={(e) => setInvite({ ...invite, minutes: Number(e.target.value) })} /> minutes</label>
        <input className="input small" placeholder="Thank-you, e.g. a ₹500 voucher" value={invite.incentive} onChange={(e) => setInvite({ ...invite, incentive: e.target.value })} />
        <input className="input small" placeholder="From (your name or team)" value={invite.senderName} onChange={(e) => setInvite({ ...invite, senderName: e.target.value })} />
        <button className="btn primary small" disabled={!!busy || !view?.mail.configured} data-testid="booking-send" onClick={() => {
          const emails = invite.emails.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const m = /^(.*?)\s*<([^>]+)>$/.exec(l); return m ? { name: m[1].trim(), email: m[2].trim() } : { email: l }; });
          const respondentIds = invite.respondentIds.split(/[\s,]+/).filter(Boolean);
          void post("Sending invitations", { action: "invite", emails, respondentIds, minutes: invite.minutes, ...(invite.incentive.trim() ? { incentive: invite.incentive.trim() } : {}), ...(invite.senderName.trim() ? { senderName: invite.senderName.trim() } : {}) }, (j) => {
            const sk = (j.skipped as Row[]) ?? [], fl = (j.failed as Row[]) ?? [];
            return `${j.sent} invitation${j.sent === 1 ? "" : "s"} sent.${sk.length ? ` Skipped ${sk.length}: ${sk.slice(0, 4).map((x) => `${x.who} (${x.why})`).join("; ")}.` : ""}${fl.length ? ` Not sent ${fl.length}: ${fl.slice(0, 4).map((x) => `${x.who} (${x.why})`).join("; ")}.` : ""}`;
          }).then((ok) => { if (ok) setInvite({ ...invite, emails: "", respondentIds: "" }); });
        }}>Send invitations</button>
      </div>

      <h3>Bookings</h3>
      <div className="ql-row ql-muted" data-testid="booking-counts">{Object.entries(view?.counts ?? {}).filter(([, n]) => n).map(([k, n]) => `${STATUS[k] ?? k}: ${n}`).join(" · ") || "No invitations yet."}</div>
      <table className="ax-table dense" data-testid="booking-list">
        <thead><tr><th>Who</th><th>Status</th><th>Time</th><th>Reminders</th><th>Incentive</th><th>After the session</th></tr></thead>
        <tbody>
          {(view?.bookings ?? []).map((b) => {
            const sl = slotOf(b.slot_id);
            const inc = b.incentive as Row | null;
            return (
              <tr key={String(b.id)} data-status={String(b.status)}>
                <td>{String(b.name ?? "")} <span className="ql-muted">{String(b.email ?? "")}</span></td>
                <td>{STATUS[String(b.status)] ?? String(b.status)}</td>
                <td>{sl ? local(sl.starts_at) : "—"}</td>
                <td className="ql-muted">{((b.reminders_sent as string[]) ?? []).join(", ") || "—"}</td>
                <td>{inc ? `${inc.amount} ${inc.currency}` : "—"}</td>
                <td>{b.status === "booked" ? (
                  <span className="ql-row" style={{ margin: 0 }}>
                    <select className="select small" value={marks[String(b.id)] ?? ""} onChange={(e) => { const next = { ...marks }; if (e.target.value) next[String(b.id)] = e.target.value as "attended" | "no_show"; else delete next[String(b.id)]; setMarks(next); }} aria-label="Attendance"><option value="">—</option><option value="attended">Attended</option><option value="no_show">No-show</option></select>
                    <button className="btn small" disabled={!!busy} onClick={() => void post("Cancelling", { action: "cancel", bookingId: b.id }, (j) => `Cancelled (${STATUS[String(j.status)] ?? j.status}).`)}>Cancel</button>
                  </span>
                ) : null}</td>
              </tr>
            );
          })}
          {view && !view.bookings.length && <tr><td colSpan={6} className="ql-muted">Nobody invited yet.</td></tr>}
        </tbody>
      </table>
      {booked.length > 0 && (
        <div className="ql-row" data-testid="booking-settle">
          <span className="ql-muted">Incentive</span>
          <input className="input small" type="number" min={0} style={{ width: 90 }} value={policy.amount} onChange={(e) => setPolicy({ ...policy, amount: Number(e.target.value) })} aria-label="Amount" />
          <input className="input small" style={{ width: 64 }} value={policy.currency} onChange={(e) => setPolicy({ ...policy, currency: e.target.value.toUpperCase().slice(0, 3) })} aria-label="Currency" />
          <label className="ql-muted">late cancel pays <input className="input small" type="number" min={0} max={100} style={{ width: 56 }} value={Math.round(policy.lateCancelShare * 100)} onChange={(e) => setPolicy({ ...policy, lateCancelShare: Number(e.target.value) / 100 })} />%</label>
          <label className="ql-muted">no-show pays <input className="input small" type="number" min={0} max={100} style={{ width: 56 }} value={Math.round(policy.noShowShare * 100)} onChange={(e) => setPolicy({ ...policy, noShowShare: Number(e.target.value) / 100 })} />%</label>
          <button className="btn primary small" disabled={!!busy || !Object.keys(marks).length} data-testid="booking-mark" onClick={() => void post("Recording attendance", { action: "mark", marks, incentive: policy }, (j) => { setMarks({}); const st = (j.settlements as Row[]) ?? []; return `Recorded ${st.length}: ${st.slice(0, 6).map((x) => `${STATUS[String(x.status)] ?? x.status} ${x.incentive} ${x.currency}`).join("; ")}. Incentives are recorded, not paid.`; })}>Record attendance</button>
        </div>
      )}

      <h3>Target</h3>
      <div className="ql-row" data-testid="booking-target">
        <label className="ql-muted">Interviews wanted <input className="input small" type="number" min={1} max={500} style={{ width: 70 }} value={target} onChange={(e) => setTarget(Math.max(1, Number(e.target.value) || 1))} /></label>
        {view?.invitesNeeded && <span>{view.invitesNeeded.invite ? <>Invite about <b>{view.invitesNeeded.invite}</b> more.</> : <>Enough people are invited or booked.</>} <span className="ql-muted">({view.invitesNeeded.basis})</span></span>}
      </div>
    </div>
  );
}
