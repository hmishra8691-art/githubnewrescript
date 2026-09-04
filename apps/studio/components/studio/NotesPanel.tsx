"use client";
import React from "react";
import { useStudio, selectedQuestion } from "./store";
import { api } from "@/lib/useSession";

/**
 * INTERNAL NOTES + PROJECT ACTIVITY (§25, §26).
 *
 * Two panels in one file because they answer the same question from opposite
 * ends: "what has been discussed about this project" and "what has been done
 * to it". Researchers use them together — a note says "check the routing
 * after Q18" and the activity log says who changed it and when.
 *
 * These notes are INTERNAL. They live in their own table, the runtime never
 * reads it, and nothing that builds a questionnaire touches it — so a note
 * cannot reach a respondent by any code path, which is the guarantee §26
 * asks for rather than a promise to be careful.
 *
 * A new note is anchored to whatever the programmer is looking at. If a
 * question is selected, the note remembers it, and the thread shows "on Q18"
 * — which is how a routing discussion stays attached to the routing.
 */

interface NoteAuthor { userId: string; name: string; userCode: string; initials: string; hue: number; isMe: boolean }
interface Note {
  id: string; parentId: string | null; author: NoteAuthor; body: string;
  target: { questionId?: string; panel?: string } | Record<string, unknown>;
  resolved: boolean; resolvedAt: string | null; resolvedBy: string | null;
  createdAt: string; updatedAt: string; mine: boolean; canModerate: boolean;
  replies?: Note[];
}
interface NotesPayload { threads: Note[]; openCount: number; canComment: boolean; canResolve: boolean }

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
};

function Avatar({ a }: { a: NoteAuthor }) {
  return <span className="avatar sm" style={{ background: `hsl(${a.hue} 62% 45%)` }} title={a.name} aria-hidden="true">{a.initials}</span>;
}

function NoteBody({ n, onAction, busy }: { n: Note; onAction: (id: string, patch: Record<string, unknown>) => void; busy: string | null }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(n.body);
  return (
    <div className="note" data-testid="note" data-note={n.id}>
      <Avatar a={n.author} />
      <div className="body">
        <div className="head">
          <span className="nm">{n.author.isMe ? "You" : n.author.name}</span>
          <span className="when">{when(n.createdAt)}{n.updatedAt !== n.createdAt ? " · edited" : ""}</span>
          {n.mine && !editing && (
            <button className="btn small" style={{ padding: "0 6px" }} onClick={() => { setDraft(n.body); setEditing(true); }}>edit</button>
          )}
          {n.canModerate && (
            <button className="btn small danger" style={{ padding: "0 6px" }} data-testid="note-delete" disabled={busy === n.id} onClick={() => onAction(n.id, { delete: true })}>delete</button>
          )}
        </div>
        {editing ? (
          <div className="row" style={{ marginTop: 4 }}>
            <textarea className="ta" style={{ width: "100%", minHeight: 60 }} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <button className="btn small primary" onClick={() => { onAction(n.id, { body: draft }); setEditing(false); }}>Save</button>
            <button className="btn small" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        ) : (
          <div className="text">{n.body}</div>
        )}
      </div>
    </div>
  );
}

export function NotesPanel({ canComment, canResolve }: { canComment: boolean; canResolve: boolean }) {
  const s = useStudio();
  const [data, setData] = React.useState<NotesPayload | null>(null);
  const [body, setBody] = React.useState("");
  const [replyTo, setReplyTo] = React.useState<string | null>(null);
  const [replyBody, setReplyBody] = React.useState("");
  const [showResolved, setShowResolved] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const q = selectedQuestion(s);

  const load = React.useCallback(async () => {
    const r = await api<NotesPayload>(`/api/surveys/${s.surveyDbId}/comments?resolved=${showResolved ? 1 : 0}`);
    if (r.ok) setData(r.data); else setErr(r.error);
  }, [s.surveyDbId, showResolved]);
  React.useEffect(() => { void load(); }, [load]);

  const post = async (text: string, parentId: string | null) => {
    if (!text.trim()) return;
    setBusy(parentId ?? "new"); setErr(null);
    const r = await api(`/api/surveys/${s.surveyDbId}/comments`, {
      method: "POST",
      // the anchor is whatever the programmer had open, so the note lands
      // beside the thing it is about rather than in a general pile
      json: { body: text, parentId, target: !parentId && q ? { questionId: q.id, questionCode: q.code } : {} },
    });
    setBusy(null);
    if (!r.ok) { setErr(r.error); return; }
    if (parentId) { setReplyTo(null); setReplyBody(""); } else setBody("");
    void load();
  };

  const act = async (commentId: string, patch: Record<string, unknown>) => {
    setBusy(commentId); setErr(null);
    const r = await api(`/api/surveys/${s.surveyDbId}/comments`, { method: "PATCH", json: { commentId, ...patch } });
    setBusy(null);
    if (!r.ok) { setErr(r.error); return; }
    void load();
  };

  if (!data) return <div className="muted">Loading notes…</div>;

  return (
    <div data-testid="notes-panel">
      <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Internal notes</h2>
        {data.openCount > 0 && <span className="chip warn">{data.openCount} open</span>}
        <span className="grow" />
        <label className="row" style={{ gap: 5, fontSize: 12 }}>
          <input type="checkbox" checked={showResolved} data-testid="notes-show-resolved" onChange={(e) => setShowResolved(e.target.checked)} />
          show resolved
        </label>
        <button className="btn small" onClick={() => void load()}>↻ refresh</button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        These notes are for the project team only. They are never shown to respondents and never appear in the survey.
      </p>

      {err && <div className="auth-note err" data-testid="notes-error">{err}</div>}

      {canComment ? (
        <div className="card" data-testid="note-compose">
          <textarea
            className="ta" style={{ width: "100%", minHeight: 66 }}
            placeholder={q ? `Add a note about ${q.code}…` : "Add a note for the project team…"}
            value={body} data-testid="note-body"
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="row" style={{ marginTop: 6 }}>
            {q && <span className="chip note-anchor" data-testid="note-anchor">on {q.code}</span>}
            <span className="grow" />
            <button className="btn small primary" data-testid="note-submit" disabled={!body.trim() || busy === "new"} onClick={() => void post(body, null)}>
              {busy === "new" ? "Posting…" : "Add note"}
            </button>
          </div>
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 12 }}>Your role on this project cannot add notes.</p>
      )}

      {data.threads.length === 0 && (
        <p className="muted" style={{ fontSize: 12 }} data-testid="notes-empty">
          No notes yet. {canComment ? "Anything the team should know about this project goes here." : ""}
        </p>
      )}

      {data.threads.map((t) => {
        const anchor = (t.target as { questionCode?: string; questionId?: string }).questionCode
          ?? (t.target as { questionId?: string }).questionId;
        return (
          <div className={`note-thread ${t.resolved ? "resolved" : ""}`} key={t.id} data-testid="note-thread" data-resolved={t.resolved ? "1" : "0"}>
            {anchor && <div className="chip note-anchor" style={{ marginBottom: 6 }}>on {anchor}</div>}
            <NoteBody n={t} onAction={act} busy={busy} />
            {t.replies && t.replies.length > 0 && (
              <div className="note-replies">
                {t.replies.map((r) => <NoteBody key={r.id} n={r} onAction={act} busy={busy} />)}
              </div>
            )}
            <div className="row" style={{ marginTop: 6 }}>
              {canComment && (replyTo === t.id ? (
                <>
                  <input
                    className="input" style={{ flex: "1 1 auto" }} value={replyBody} autoFocus
                    placeholder="Reply…" data-testid="note-reply-body"
                    onChange={(e) => setReplyBody(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && replyBody.trim()) void post(replyBody, t.id); }}
                  />
                  <button className="btn small primary" data-testid="note-reply-submit" disabled={!replyBody.trim()} onClick={() => void post(replyBody, t.id)}>Reply</button>
                  <button className="btn small" onClick={() => { setReplyTo(null); setReplyBody(""); }}>Cancel</button>
                </>
              ) : (
                <button className="btn small" data-testid="note-reply" onClick={() => setReplyTo(t.id)}>Reply</button>
              ))}
              <span className="grow" />
              {t.resolved ? (
                <>
                  <span className="chip on">resolved{t.resolvedBy ? ` by ${t.resolvedBy}` : ""}</span>
                  {canResolve && (
                    <button className="btn small" data-testid="note-reopen" disabled={busy === t.id} onClick={() => void act(t.id, { resolved: false })}>Reopen</button>
                  )}
                </>
              ) : (
                canResolve && (
                  <button className="btn small" data-testid="note-resolve" disabled={busy === t.id} onClick={() => void act(t.id, { resolved: true })}>
                    Mark resolved
                  </button>
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ activity */

interface ActivityEvent {
  id: number | string; action: string; text: string; category: string;
  at: string; actorName: string | null; actorUserCode: string | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  identity: "Accounts", session: "Sessions", access: "Access", editing: "Editing",
  survey: "Survey", data: "Response data", collaboration: "Notes",
};

/**
 * THE PROJECT ACTIVITY LOG (§25).
 *
 * Newest first, grouped by day, with a category filter — because the question
 * being asked is almost always "what happened on Tuesday" or "who touched the
 * routing", and an undifferentiated stream answers neither.
 *
 * The sentences come from the server, produced by the shared `describeEvent`,
 * so the wording is identical here and in the notification list. Rewording
 * events in the UI is how two screens end up disagreeing about what happened.
 */
export function ActivityPanel() {
  const s = useStudio();
  const [events, setEvents] = React.useState<ActivityEvent[] | null>(null);
  const [categories, setCategories] = React.useState<string[]>([]);
  const [filter, setFilter] = React.useState<string>("all");
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const r = await api<{ events: ActivityEvent[]; categories: string[] }>(`/api/surveys/${s.surveyDbId}/activity?limit=200`);
    if (r.ok) { setEvents(r.data.events); setCategories(r.data.categories); }
    else setErr(r.error);
  }, [s.surveyDbId]);
  React.useEffect(() => { void load(); }, [load]);

  if (err) return <div className="auth-note err" data-testid="activity-error">{err}</div>;
  if (!events) return <div className="muted">Loading activity…</div>;

  const shown = filter === "all" ? events : events.filter((e) => e.category === filter);
  const byDay = new Map<string, ActivityEvent[]>();
  for (const e of shown) {
    const day = new Date(e.at).toLocaleDateString([], { dateStyle: "full" });
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(e);
  }

  return (
    <div data-testid="activity-panel">
      <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Project activity</h2>
        <span className="grow" />
        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
          <button className={`btn small ${filter === "all" ? "primary" : ""}`} onClick={() => setFilter("all")}>All</button>
          {categories.map((c) => (
            <button key={c} className={`btn small ${filter === c ? "primary" : ""}`} data-testid={`activity-filter-${c}`} onClick={() => setFilter(c)}>
              {CATEGORY_LABEL[c] ?? c}
            </button>
          ))}
        </div>
        <button className="btn small" onClick={() => void load()}>↻ refresh</button>
      </div>

      {shown.length === 0 && <p className="muted" style={{ fontSize: 12 }} data-testid="activity-empty">Nothing recorded yet.</p>}

      {[...byDay.entries()].map(([day, list]) => (
        <div key={day} style={{ marginBottom: 14 }}>
          <div className="flabel">{day}</div>
          <div className="activity-list">
            {list.map((e) => (
              <div className="activity-row" key={String(e.id)} data-testid="activity-row" data-action={e.action}>
                <span className="at">{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                <span className="what">{e.text}</span>
                <span className="cat chip" style={{ fontSize: 10 }}>{CATEGORY_LABEL[e.category] ?? e.category}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
