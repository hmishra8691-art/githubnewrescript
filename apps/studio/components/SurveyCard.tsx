"use client";
import React from "react";
import { fmtMoney, LEVEL_CLASS, LEVEL_WORD, Progress } from "@/components/billing/shared";

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
  /* §60 — the project's own facts. Absent on a database without migration 0015. */
  clientName?: string | null;
  projectManager?: string | null;
  fieldworkFrom?: string | null;
  fieldworkTo?: string | null;
  dueDate?: string | null;
  locked?: boolean;
}

/**
 * §60 — how a due date reads on a card.
 *
 * A date on its own makes a person do arithmetic; "3 days" does not, and the
 * one that is already past has to be unmissable, because an overdue project
 * nobody has noticed is the whole reason to show this at all.
 */
function dueLabel(due: string | null | undefined): { text: string; tone: string; title: string } | null {
  if (!due) return null;
  const when = Date.parse(`${due}T00:00:00`);
  if (Number.isNaN(when)) return null;
  const days = Math.round((when - Date.now()) / 86_400_000);
  const on = new Date(when).toLocaleDateString();
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, tone: "warn", title: `Was due ${on}` };
  if (days === 0) return { text: "due today", tone: "warn", title: `Due ${on}` };
  if (days <= 7) return { text: `due in ${days}d`, tone: "warn", title: `Due ${on}` };
  return { text: `due ${on}`, tone: "", title: `Due ${on}` };
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

/**
 * A project's wallet as the card shows it — the researcher's four numbers and
 * nothing else. There is deliberately no cost, margin or profit field on this
 * type: what a project costs Rescript to run is an internal figure, and the
 * way to keep it off a researcher's screen is for the screen's own data
 * structure to have nowhere to put it.
 */
export interface CardMeter {
  currency: string;
  /** what THIS project has spent */
  used: number;
  /** its own budget, or null when it spends freely from the wallet */
  limit: number | null;
  mode: "shared" | "budget" | "priority";
  /** what it may still spend: its own headroom, or what the wallet has left */
  allowance: number;
  /** the wallet behind it — the same figure on every project that shares it */
  walletRemaining: number;
  reserved: number;
  usedPct: number;
  level: "normal" | "low" | "critical" | "locked";
  state: "active" | "frozen" | "read_only" | "suspended";
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

export function SurveyCard({
  survey, stats, contributors, loading, onOpen, onResponses, onStatus, onDelete, canDelete = true,
  meter, meterLoading = false, canBudget = false, onBudget, onClone,
}: {
  survey: SurveyRow;
  stats: SurveyStats | undefined;
  contributors: Record<string, Contributor>;
  loading: boolean;
  onOpen(): void;
  onResponses(): void;
  onStatus(status: string): void;
  onDelete(): void;
  /** This project's spend and policy. `null` = nothing to show; `undefined` = not loaded (or billing is off). */
  meter?: CardMeter | null;
  meterLoading?: boolean;
  /** whether this viewer may change the project's limit (the owner) */
  canBudget?: boolean;
  onBudget?(): void;
  onClone?(): void;
  /**
   * Whether this viewer's role permits permanently deleting the survey.
   * Defaults to `true` (unchanged behavior) when the caller doesn't know the
   * role yet — the server is the actual authority on this (`project.delete`
   * is owner-only, enforced in the DELETE route), so hiding the option here
   * is only a courtesy to stop a user who can never succeed from opening the
   * confirm dialog just to hit a permission error.
   */
  canDelete?: boolean;
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

      {/*
        * §60 — who it is for and when it is due, on the card.
        *
        * These are the two questions asked of a project list ("which of these
        * is ACME's", "what is due this week") and until the project fields
        * existed they could only be answered by reading titles. Rendered only
        * when set, so a workspace that does not use them sees the card it
        * always had.
        */}
      {(survey.clientName || survey.dueDate || survey.fieldworkTo) && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 8 }} data-testid="card-project">
          {survey.clientName && (
            <span className="chip" data-testid="card-client" title="The client this project is for">{survey.clientName}</span>
          )}
          {(() => {
            const due = dueLabel(survey.dueDate);
            return due ? <span className={`chip ${due.tone}`} data-testid="card-due" title={due.title}>{due.text}</span> : null;
          })()}
          {survey.fieldworkTo && !survey.dueDate && (
            <span className="chip muted" title={`Fieldwork closes ${new Date(`${survey.fieldworkTo}T00:00:00`).toLocaleDateString()}`}>
              in field to {new Date(`${survey.fieldworkTo}T00:00:00`).toLocaleDateString()}
            </span>
          )}
        </div>
      )}

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
          {survey.locked && (
            <span className="chip warn" data-testid="card-frozen" title="Frozen by its owner: nobody else can change anything on this project">
              frozen
            </span>
          )}
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

      {/*
        * WHAT THIS PROJECT IS SPENDING, AND OUT OF WHAT.
        *
        * A project holds no money — it spends from the wallet of the person
        * who owns it, under a policy of its own. So the card answers the two
        * questions a researcher actually has when scanning a list: what has
        * this study cost me, and can it keep running. "Spent" is its own
        * figure; "Remaining" is whichever limit will stop it first, which is
        * its budget when it has one and the wallet when it does not — and the
        * label says which, because $12 left of a budget and $12 left in a
        * wallet call for different actions.
        *
        * Every figure is a CUSTOMER CHARGE; nothing here is an internal cost.
        */}
      {meter ? (
        <div className={`card-wallet ${meter.state === "frozen" || meter.state === "read_only" ? "exhausted" : ""}`}
          data-testid="card-wallet" data-level={meter.level} data-state={meter.state}
          data-mode={meter.mode} data-remaining={meter.allowance}>
          <div className="cw-head">
            <span className="cw-title">{meter.mode === "budget" ? "Project budget" : "Project spend"}</span>
            <span className={`badge ${meter.state === "suspended" ? "error" : LEVEL_CLASS[meter.level]}`} data-testid="card-wallet-level">
              {meter.state === "suspended" ? "Suspended"
                : meter.state === "frozen" ? "Limit reached"
                : meter.state === "read_only" ? "Wallet empty"
                : LEVEL_WORD[meter.level]}
            </span>
            {meter.mode === "priority" && (
              <span className="chip" data-testid="card-wallet-priority" title="The study this wallet is mainly for">Priority</span>
            )}
            <span className="grow" />
            {canBudget && onBudget && (
              <button className="btn small cw-refill" data-testid="card-budget"
                onClick={(e) => { e.stopPropagation(); onBudget(); }}
                title={meter.state === "frozen"
                  ? "This project has reached its own limit: raise it to start it again"
                  : "Set how much of your wallet this project may spend"}>
                {meter.state === "frozen" ? "Raise limit" : "Set limit"}
              </button>
            )}
          </div>
          <div className="cw-figures">
            <div className="cw-fig"><div className="cw-v" data-testid="cw-used">{fmtMoney(meter.used, meter.currency)}</div><div className="cw-l">Spent</div></div>
            <div className="cw-fig">
              <div className="cw-v" data-testid="cw-limit">{meter.limit == null ? "No limit" : fmtMoney(meter.limit, meter.currency)}</div>
              <div className="cw-l">{meter.limit == null ? "Own budget" : "Budget"}</div>
            </div>
            <div className="cw-fig">
              <div className="cw-v strong" data-testid="cw-remaining">{fmtMoney(meter.allowance, meter.currency)}</div>
              <div className="cw-l">{meter.limit == null ? "Wallet left" : "Left of it"}</div>
            </div>
            <div className="cw-fig"><div className="cw-v" data-testid="cw-pct">{meter.usedPct}%</div><div className="cw-l">Meter used</div></div>
          </div>
          <Progress used={meter.used} total={meter.used + meter.allowance} level={meter.level}
            testid="card-wallet-bar"
            label={meter.limit == null
              ? `${meter.usedPct}% of what this project can spend from your wallet`
              : `${meter.usedPct}% of this project's budget used`} />
          {meter.reserved > 0 && (
            <div className="cw-note muted" title="Held by this project's operations in flight — not spent yet, and not available to spend">
              {fmtMoney(meter.reserved, meter.currency)} held by work in progress
            </div>
          )}
          {meter.state === "frozen" && (
            <div className="cw-note warn" data-testid="card-wallet-frozen">
              Stopped at its own limit of {fmtMoney(meter.limit ?? 0, meter.currency)}. Your wallet still has
              {" "}{fmtMoney(meter.walletRemaining, meter.currency)} for other projects.
            </div>
          )}
          {meter.state === "read_only" && (
            <div className="cw-note warn" data-testid="card-wallet-readonly">
              Read-only: your wallet is empty, so no project can run billable work until you add funds.
            </div>
          )}
        </div>
      ) : meterLoading ? (
        <div className="card-wallet" data-testid="card-wallet-loading"><span className="sk sk-lab" /></div>
      ) : null}

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
                  {/*
                    * Clone lives in the menu rather than as a fourth button:
                    * it is a deliberate, occasional act, and the card's own
                    * job is to be readable. The spending limit repeats here
                    * so that on a narrow screen, where the card's buttons
                    * wrap, every action is still reachable from one place.
                    */}
                  <div className="menu-label">Project</div>
                  {onClone && (
                    <button className="menu-item" data-testid="clone-project-menu-item"
                      onClick={() => { setMenu(false); onClone(); }}
                      title="Make an independent copy of this project's questions, logic and settings">
                      Clone project…
                    </button>
                  )}
                  {canBudget && onBudget && (
                    <button className="menu-item" data-testid="budget-menu-item"
                      onClick={() => { setMenu(false); onBudget(); }}>
                      Spending limit…
                    </button>
                  )}
                  <div className="menu-sep" />
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
                  <button className="menu-item danger" disabled={!canDelete} data-testid="delete-survey-menu-item"
                    title={canDelete ? undefined : "Only the project owner can permanently delete this survey."}
                    onClick={() => { setMenu(false); onDelete(); }}>
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
