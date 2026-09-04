"use client";
import React from "react";

/**
 * One survey project on the dashboard.
 *
 * Every number comes from the API's statistics payload. A statistic that
 * could not be loaded arrives as `null` and renders as "—" — never as 0,
 * which would read as "this survey has no responses" when the truth is "we
 * do not know yet" (reqs §23–§25).
 */

export interface SurveyRow {
  id: string;
  code: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  current_version_id: string | null;
  /* collaboration — present once accounts exist, absent in the sandbox */
  myRole?: string;
  /** owner | member | workspace — why this user can see this project */
  roleSource?: string;
  owner?: { userId: string; name: string | null; userCode: string | null; isMe: boolean } | null;
  collaborators?: number;
  version?: string | null;
  /** who holds the edit lock at this moment, if anyone */
  editing?: { userId: string; name: string | null; since: string | null; isMe: boolean } | null;
}

/** a stable colour per person, matching the presence avatars elsewhere */
const hueOf = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
const initials = (name: string | null | undefined) => {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts.length === 1 ? parts[0].slice(0, 2).toUpperCase() : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

export interface SurveyStats {
  questionCount: number | null;
  responseCount: number | null;
  testResponseCount: number | null;
  liveResponseCount: number | null;
  completeCount: number | null;
  lastResponseAt: string | null;
  contributorIds: string[];
  versionCount: number | null;
}

export interface Contributor {
  id: string;
  name: string;
  initials: string;
}

export const STATUS_META: Record<string, { label: string; tone: string; hint: string }> = {
  draft: { label: "Draft", tone: "draft", hint: "Being programmed — no live link" },
  testing: { label: "Testing", tone: "testing", hint: "Test link active; not collecting live data" },
  live: { label: "Live", tone: "live", hint: "Collecting live responses" },
  paused: { label: "Paused", tone: "paused", hint: "Live link temporarily refuses respondents" },
  closed: { label: "Closed", tone: "closed", hint: "Data collection finished" },
  archived: { label: "Archived", tone: "archived", hint: "Kept for reference; not available" },
};

/** "2 hours ago" for recent activity, an absolute date once that stops helping. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return "just now";
  if (secs < 90) return "a minute ago";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const num = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString();

function Stat({ label, value, title, onClick }: {
  label: string; value: React.ReactNode; title?: string; onClick?: () => void;
}) {
  return (
    <div className={`stat ${onClick ? "clickable" : ""}`} title={title}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function SurveyCard({ survey, stats, contributors, loading, onOpen, onResponses, onStatus, onDelete }: {
  survey: SurveyRow;
  stats: SurveyStats | undefined;
  contributors: Record<string, Contributor>;
  loading: boolean;
  onOpen(): void;
  onResponses(): void;
  onStatus(status: string): void;
  onDelete(): void;
}) {
  const [menu, setMenu] = React.useState(false);
  const meta = STATUS_META[survey.status] ?? { label: survey.status, tone: "draft", hint: "" };
  const people = (stats?.contributorIds ?? []).map((id) => contributors[id]).filter(Boolean);
  const shown = people.slice(0, 3);

  // "—" while the numbers are still in flight, so nothing reads as a real zero
  const v = (n: number | null | undefined) => (loading ? "—" : num(n));

  return (
    <div className="survey-card" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}>
      <div className="survey-card-head">
        <div className="survey-title">
          {survey.title}
          <span className="survey-code mono">{survey.code}</span>
        </div>
        <span className={`status-pill ${meta.tone}`} title={meta.hint}>
          <span className="dot" />{meta.label}
        </span>
      </div>

      {/* who is responsible, what I may do, and whether it is busy right now */}
      {(survey.owner || survey.myRole || survey.editing) && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 8 }} data-testid="card-collab">
          {survey.owner && (
            <span className="card-editing" title={`Owner: ${survey.owner.name ?? "unknown"}${survey.owner.userCode ? ` (${survey.owner.userCode})` : ""}`}>
              <span className="avatar sm" style={{ background: `hsl(${hueOf(survey.owner.userId)} 62% 45%)` }} aria-hidden="true">
                {initials(survey.owner.name)}
              </span>
              <span className="muted">{survey.owner.isMe ? "You own this" : survey.owner.name}</span>
            </span>
          )}
          {survey.myRole && survey.myRole !== "owner" && (
            <span className="chip card-role" data-testid="card-role">{survey.myRole.replace("_", " ")}</span>
          )}
          {survey.collaborators ? <span className="chip card-role">{survey.collaborators} shared</span> : null}
          {survey.editing && (
            <span className="card-editing" data-testid="card-editing"
              title={survey.editing.since ? `Editing since ${new Date(survey.editing.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : undefined}>
              <span className="presence-dot editing" />
              <strong>{survey.editing.isMe ? "You are editing" : `${survey.editing.name} is editing`}</strong>
            </span>
          )}
        </div>
      )}

      <div className="stat-row">
        <Stat label="Questions" value={v(stats?.questionCount)}
          title="Respondent-facing questions across every page — page breaks and hidden or calculated variables are not counted" />
        <Stat label="Responses" value={v(stats?.responseCount)}
          title="Click to open this survey's data" onClick={onResponses} />
        <Stat label="Test" value={v(stats?.testResponseCount)}
          title="Responses collected through a test link — never mixed with live data" />
        <Stat label="Live" value={v(stats?.liveResponseCount)}
          title="Responses collected through the live link" />
        <Stat label="Complete" value={v(stats?.completeCount)}
          title="Responses that reached the end of the survey" />
      </div>

      <div className="survey-card-foot">
        <div className="contributors" title={people.length ? people.map((p) => p.name).join(", ") : undefined}>
          {people.length > 0 ? (
            <>
              <span className="avatars">
                {shown.map((p) => (
                  <span key={p.id} className="avatar" title={p.name}>{p.initials}</span>
                ))}
                {people.length > shown.length && (
                  <span className="avatar more">+{people.length - shown.length}</span>
                )}
              </span>
              {people.length} contributor{people.length === 1 ? "" : "s"}
            </>
          ) : (
            <span className="muted" title="Contributors are counted from signed-in users. Studio sign-in is not enabled yet, so nobody is attributed.">
              {loading ? "—" : "Sign-in not enabled"}
            </span>
          )}
        </div>

        <span className="grow" />

        {stats?.lastResponseAt && (
          <span className="foot-meta" title={new Date(stats.lastResponseAt).toLocaleString()}>
            Last response {relativeTime(stats.lastResponseAt)}
          </span>
        )}
        <span className="foot-meta" title={new Date(survey.updated_at).toLocaleString()}>
          Updated {relativeTime(survey.updated_at)}
        </span>

        <div className="card-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn small primary" onClick={onOpen}>Open</button>
          <button className="btn small" onClick={onResponses}
            disabled={stats?.responseCount === 0}
            title={stats?.responseCount === 0 ? "No responses yet" : "Browse test and live responses"}>
            Responses
          </button>
          <div className="menu-anchor">
            <button className="btn small" aria-haspopup="menu" aria-expanded={menu}
              onClick={() => setMenu((m) => !m)} title="More actions">•••</button>
            {menu && (
              <>
                <div className="menu-scrim" onClick={() => setMenu(false)} />
                <div className="menu" role="menu">
                  <div className="menu-label">Set status</div>
                  {Object.entries(STATUS_META).map(([key, m]) => (
                    <button key={key} className={`menu-item ${survey.status === key ? "on" : ""}`}
                      title={m.hint}
                      onClick={() => { setMenu(false); onStatus(key); }}>
                      <span className={`status-pill ${m.tone} tiny`}><span className="dot" /></span>
                      {m.label}
                      {survey.status === key && <span className="grow" />}
                      {survey.status === key && <span>✓</span>}
                    </button>
                  ))}
                  <div className="menu-sep" />
                  <button className="menu-item danger" onClick={() => { setMenu(false); onDelete(); }}>
                    Delete survey…
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Skeleton shown while the first page of surveys is loading (req §24). */
export function SurveyCardSkeleton() {
  return (
    <div className="survey-card skeleton" aria-hidden>
      <div className="survey-card-head">
        <div className="sk sk-title" />
        <div className="sk sk-pill" />
      </div>
      <div className="stat-row">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="stat"><div className="sk sk-num" /><div className="sk sk-lab" /></div>
        ))}
      </div>
      <div className="survey-card-foot"><div className="sk sk-foot" /></div>
    </div>
  );
}
