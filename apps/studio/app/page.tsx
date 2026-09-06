"use client";
import React from "react";
import { THEME_PRESETS } from "@/lib/defaults";
import { SURVEY_TEMPLATES, findSurveyTemplate } from "@rescript/templates";
import {
  SurveyCard, SurveyCardSkeleton, STATUS_META, relativeTime,
  type SurveyRow, type SurveyStats, type Contributor,
} from "@/components/SurveyCard";
import { useSession } from "@/lib/useSession";
import { AppHeader, greeting } from "@/components/ui/AppHeader";
import { Icon } from "@/components/ui/Icon";

type SortKey =
  | "updated" | "created" | "name_az" | "name_za"
  | "responses_desc" | "responses_asc" | "questions_desc";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "updated", label: "Recently updated" },
  { key: "created", label: "Recently created" },
  { key: "name_az", label: "Name A–Z" },
  { key: "name_za", label: "Name Z–A" },
  { key: "responses_desc", label: "Most responses" },
  { key: "responses_asc", label: "Fewest responses" },
  { key: "questions_desc", label: "Most questions" },
];

/**
 * MY PROJECTS (§36, §37).
 *
 * Split by RELATIONSHIP, because a flat list hides the fact a researcher
 * checks first. Every other control — search, status filter, sort — applies
 * across all of them, so the split is presentational and nothing goes missing
 * from it.
 *
 * There are three relationships, not two, and the third is the visible half of
 * the P0-1 fix. "Shared with me" now means somebody deliberately added me;
 * projects I can reach because I am in the workspace that owns them are their
 * own group. Before workspace access existed, a colleague's project was simply
 * invisible — which is what "my saved projects disappeared" turned out to
 * mean — and merging them into the shared list would make that list useless
 * the moment a team has more than a handful of projects.
 */
type Ownership = "all" | "mine" | "shared" | "workspace";

/*
 * Read from `roleSource`, with a fallback for a server that predates it: an
 * older API sends no source, and treating that as "shared" keeps the old
 * two-way split working rather than emptying the lists. The failure being
 * fixed here is projects going missing; reintroducing it in the bucketing
 * would be a poor joke.
 */
const relationshipOf = (s: SurveyRow): Ownership =>
  s.roleSource === "owner" || (!s.roleSource && s.myRole === "owner")
    ? "mine"
    : s.roleSource === "workspace"
      ? "workspace"
      : "shared";

export default function Dashboard() {
  const session = useSession({ redirectOnSignOut: true });
  const [ownership, setOwnership] = React.useState<Ownership>("all");
  const [surveys, setSurveys] = React.useState<SurveyRow[] | null>(null);
  const [stats, setStats] = React.useState<Record<string, SurveyStats>>({});
  const [contributors, setContributors] = React.useState<Record<string, Contributor>>({});
  const [warnings, setWarnings] = React.useState<string[]>([]);
  const [statsLoading, setStatsLoading] = React.useState(true);
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<string>("all");
  const [responseFilter, setResponseFilter] = React.useState<"any" | "has" | "none">("any");
  const [sort, setSort] = React.useState<SortKey>("updated");
  const [creating, setCreating] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [code, setCode] = React.useState("");
  const [theme, setTheme] = React.useState<string>("");
  const [template, setTemplate] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<SurveyRow | null>(null);
  const [confirmText, setConfirmText] = React.useState("");
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const ENV_HINT =
      "Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in THIS Vercel project's environment variables, then redeploy.";
    setError(null);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch("/api/surveys", { signal: ctrl.signal });
      const raw = await r.text();
      let d: {
        surveys?: SurveyRow[]; error?: string;
        stats?: Record<string, SurveyStats>;
        contributors?: Record<string, Contributor>;
        warnings?: string[];
      } = {};
      try {
        d = raw ? JSON.parse(raw) : {};
      } catch {
        setError(`Server returned ${r.status} (not JSON). ${ENV_HINT}`);
        return;
      }
      if (!r.ok) {
        setError(`${d.error ?? `Server returned ${r.status}`}. ${ENV_HINT}`);
        return;
      }
      setSurveys(d.surveys ?? []);
      // statistics are additive — the listing renders even if they failed
      setStats(d.stats ?? {});
      setContributors(d.contributors ?? {});
      setWarnings(d.warnings ?? []);
      setStatsLoading(false);
    } catch (e) {
      setError(
        (e as Error)?.name === "AbortError"
          ? `Timed out after 15s — the server could not reach Supabase. ${ENV_HINT}`
          : `Could not reach the API. ${ENV_HINT}`,
      );
    } finally {
      clearTimeout(timer);
      setStatsLoading(false);
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setError(null);
    const preset = THEME_PRESETS.find((t) => t.name === theme);
    const tpl = findSurveyTemplate(template);
    const body: Record<string, unknown> = { title: title || tpl?.name || "Untitled survey", code: code || undefined };
    if (tpl) {
      /*
       * A survey template is a complete, programmed definition (questions,
       * flow, loops, List Fills, designs, scripts…). The server re-stamps
       * meta.id / code / title, so only the content travels.
       */
      const built = tpl.build("tmp");
      body.definition = { ...built, branding: preset ? { ...built.branding, ...preset.branding } : built.branding };
    } else if (preset) {
      body.definition = {
        meta: { id: "tmp", code: code || "SURVEY", title: title || "Untitled survey", version: "1.0" },
        branding: preset.branding,
        flow: [
          { type: "page", id: "page_1", title: "Welcome", questionIds: [] },
          { type: "end", id: "end_complete", status: "complete" },
        ],
      };
    }
    const r = await fetch("/api/surveys", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.id) window.location.href = `/studio/${d.id}`;
    else setError(d.error ?? "create failed");
  };

  const setStatus = async (id: string, status: string) => {
    // optimistic: the pill flips immediately, and reverts if the server says no
    const before = surveys?.find((x) => x.id === id)?.status;
    setSurveys((rows) => rows?.map((x) => (x.id === id ? { ...x, status } : x)) ?? rows);
    const r = await fetch(`/api/surveys/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setError(d.error ?? "could not change status");
      setSurveys((rows) => rows?.map((x) => (x.id === id ? { ...x, status: before ?? x.status } : x)) ?? rows);
    }
  };

  /** Search, filter and sort all run on the loaded metadata — no extra calls. */
  const visible = React.useMemo(() => {
    if (!surveys) return null;
    const q = search.trim().toLowerCase();
    let rows = surveys.filter((s2) => {
      if (ownership !== "all" && relationshipOf(s2) !== ownership) return false;
      return true;
    }).filter((s2) => {
      if (statusFilter !== "all" && s2.status !== statusFilter) return false;
      const n = stats[s2.id]?.responseCount ?? 0;
      if (responseFilter === "has" && n === 0) return false;
      if (responseFilter === "none" && n > 0) return false;
      if (!q) return true;
      return (
        s2.title.toLowerCase().includes(q) ||
        s2.code.toLowerCase().includes(q) ||
        s2.status.toLowerCase().includes(q)
      );
    });
    const n = (id: string, k: keyof SurveyStats) => Number(stats[id]?.[k] ?? 0);
    rows = [...rows].sort((a, b) => {
      switch (sort) {
        case "created": return b.created_at.localeCompare(a.created_at);
        case "name_az": return a.title.localeCompare(b.title);
        case "name_za": return b.title.localeCompare(a.title);
        case "responses_desc": return n(b.id, "responseCount") - n(a.id, "responseCount");
        case "responses_asc": return n(a.id, "responseCount") - n(b.id, "responseCount");
        case "questions_desc": return n(b.id, "questionCount") - n(a.id, "questionCount");
        case "updated":
        default: return b.updated_at.localeCompare(a.updated_at);
      }
    });
    return rows;
  }, [surveys, stats, search, statusFilter, responseFilter, sort]);

  const totals = React.useMemo(() => {
    const list = Object.values(stats);
    const sum = (k: keyof SurveyStats) => list.reduce((a, b) => a + (Number(b[k] ?? 0) || 0), 0);
    return {
      surveys: surveys?.length ?? 0,
      live: surveys?.filter((x) => x.status === "live").length ?? 0,
      responses: sum("liveResponseCount"),
      test: sum("testResponseCount"),
      completes: sum("completeCount"),
      questions: sum("questionCount"),
    };
  }, [surveys, stats, ownership]);

  /**
   * THE RIGHT-HAND RAIL: the same facts the cards below already carry, read
   * across the whole workspace instead of one project at a time. Everything
   * here is derived from the rows and statistics the dashboard has already
   * loaded — there is no second request and no number that is not also true
   * on a card.
   */

  /** the project a "take me to the data" shortcut should open: most recently touched */
  const latest = React.useMemo(
    () => (surveys?.length ? [...surveys].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] : null),
    [surveys],
  );

  /** what actually happened last, across every project — edits and responses interleaved */
  const activity = React.useMemo(() => {
    if (!surveys) return null;
    const events: { id: string; at: string; kind: "response" | "edit"; survey: SurveyRow }[] = [];
    for (const s2 of surveys) {
      events.push({ id: `${s2.id}-edit`, at: s2.updated_at, kind: "edit", survey: s2 });
      const last = stats[s2.id]?.lastResponseAt;
      if (last) events.push({ id: `${s2.id}-resp`, at: last, kind: "response", survey: s2 });
    }
    return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
  }, [surveys, stats]);

  /** the portfolio at a glance: how many projects sit in each lifecycle status */
  const byStatus = React.useMemo(() => {
    if (!surveys?.length) return [];
    return Object.keys(STATUS_META)
      .map((key) => ({ key, meta: STATUS_META[key], n: surveys.filter((x) => x.status === key).length }))
      .filter((r) => r.n > 0);
  }, [surveys]);

  return (
    <div className="dash">
      <AppHeader active="dashboard" user={session.state.kind === "signed_in" ? session.state.user : null} onSignOut={() => void session.signOut()} />

      <section className="hero" data-testid="dash-hero">
        <div>
          <div className="eyebrow">{session.state.kind === "signed_in" ? <>{greeting(session.state.user.name)} · <span className="mono">{session.state.user.userCode}</span></> : "Professional survey programming & runtime platform"}</div>
          <h1>Your research workspace</h1>
          <p className="sub">Program surveys, collect and clean responses, analyse results and publish reports — in one place.</p>
        </div>
      </section>

      {/* the workspace in six numbers, all summed from the statistics the cards
          below show per project — a band rather than a corner, so the first
          screen answers "how much is going on here" before any scrolling */}
      <div className="hero-metrics" aria-label="Workspace summary" data-testid="dash-metrics">
        <div className="metric"><span className="metric-v">{surveys ? totals.surveys : <span className="sk sk-num" />}</span><span className="metric-l">Projects</span></div>
        <div className="metric"><span className="metric-v">{surveys ? totals.live : <span className="sk sk-num" />}</span><span className="metric-l">Live</span></div>
        <div className="metric"><span className="metric-v">{surveys ? totals.responses.toLocaleString() : <span className="sk sk-num" />}</span><span className="metric-l">Live responses</span></div>
        <div className="metric"><span className="metric-v">{surveys ? totals.test.toLocaleString() : <span className="sk sk-num" />}</span><span className="metric-l">Test responses</span></div>
        <div className="metric"><span className="metric-v">{surveys ? totals.completes.toLocaleString() : <span className="sk sk-num" />}</span><span className="metric-l">Completes</span></div>
        <div className="metric"><span className="metric-v">{surveys ? totals.questions.toLocaleString() : <span className="sk sk-num" />}</span><span className="metric-l">Questions</span></div>
      </div>

      <div className="dash-body">
      <div className="dash-main">

      <div className="dash-toolbar">
        <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> New survey</button>
        <input className="input dash-search" placeholder="Search surveys…"
          aria-label="Search surveys" value={search}
          onChange={(e) => setSearch(e.target.value)} />
        <select className="select" aria-label="Sort surveys" value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}>
          {SORTS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <select className="select" aria-label="Filter by responses" value={responseFilter}
          onChange={(e) => setResponseFilter(e.target.value as any)}>
          <option value="any">Any responses</option>
          <option value="has">Has responses</option>
          <option value="none">No responses</option>
        </select>
      </div>

      <div className="dash-filters" data-testid="dash-ownership">
        {([
          ["all", "All projects"],
          ["mine", "My projects"],
          ["shared", "Shared with me"],
          ["workspace", "My team\u2019s projects"],
        ] as [Ownership, string][]).map(([key, label]) => {
          const n = key === "all"
            ? surveys?.length ?? 0
            : surveys?.filter((x) => relationshipOf(x) === key).length ?? 0;
          // the two secondary tabs are hidden until something is actually in
          // them, so a solo user never sees an empty tab asking to be clicked
          if ((key === "shared" || key === "workspace") && n === 0 && ownership !== key) return null;
          return (
            <button key={key} className={`own-pill ${ownership === key ? "on" : ""}`}
              data-testid={`dash-own-${key}`} onClick={() => setOwnership(key)}>
              {label} <span className="n">{n}</span>
            </button>
          );
        })}
      </div>

      <div className="dash-filters">
        <button className={`filter-pill ${statusFilter === "all" ? "on" : ""}`}
          onClick={() => setStatusFilter("all")}>
          All <span className="n">{surveys?.length ?? 0}</span>
        </button>
        {Object.entries(STATUS_META).map(([key, m]) => {
          const n = surveys?.filter((x) => x.status === key).length ?? 0;
          if (n === 0 && statusFilter !== key) return null;
          return (
            <button key={key} className={`filter-pill ${statusFilter === key ? "on" : ""}`}
              title={m.hint} onClick={() => setStatusFilter(key)}>
              {m.label} <span className="n">{n}</span>
            </button>
          );
        })}
        <span className="grow" />
        {surveys && surveys.length > 0 && (
          <span className="muted dash-summary">
            {totals.surveys} survey{totals.surveys === 1 ? "" : "s"} · {totals.live} live ·{" "}
            {totals.responses.toLocaleString()} live responses
          </span>
        )}
      </div>

      {error && <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>{error}</div>}
      {warnings.map((w, i) => (
        <div key={i} className="chip warn" style={{ marginBottom: 8 }}>{w}</div>
      ))}

      {surveys === null && !error && (
        <>{[0, 1, 2].map((i) => <SurveyCardSkeleton key={i} />)}</>
      )}
      {surveys?.length === 0 && (
        <div className="empty" data-testid="dash-empty">
          <div className="empty-icon"><Icon name="layers" size={22} /></div>
          <h3>No surveys yet — create your first one.</h3>
          <p className="muted">Start from a blank survey or the Master Demo template; everything you program here can be tested, published and analysed.</p>
          <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> New survey</button>
        </div>
      )}
      {visible?.length === 0 && (surveys?.length ?? 0) > 0 && (
        <p className="muted">
          No surveys match this filter.{" "}
          <button className="btn small" onClick={() => {
            setSearch(""); setStatusFilter("all"); setResponseFilter("any");
          }}>Clear filters</button>
        </p>
      )}
      {visible?.map((s) => (
        <SurveyCard key={s.id} survey={s} stats={stats[s.id]} contributors={contributors}
          loading={statsLoading && !stats[s.id]}
          onOpen={() => (window.location.href = `/studio/${s.id}`)}
          onResponses={() => (window.location.href = `/studio/${s.id}?tab=data`)}
          onStatus={(status) => setStatus(s.id, status)}
          onDelete={() => { setDeleting(s); setConfirmText(""); }} />
      ))}
      </div>

      <aside className="dash-rail" aria-label="Workspace overview" data-testid="dash-rail">
        <section className="rail-card">
          <h2>Quick actions</h2>
          <div className="qa">
            <button className="qa-item" onClick={() => setCreating(true)} data-testid="qa-new">
              <span className="qa-ico"><Icon name="plus" size={17} /></span>
              <span><span className="qa-t">New survey</span><span className="qa-s">Blank or from a template</span></span>
            </button>
            <a className="qa-item" href="/analytics" data-testid="qa-analytics">
              <span className="qa-ico"><Icon name="analytics" size={17} /></span>
              <span><span className="qa-t">Data Analytics</span><span className="qa-s">Analyse, chart and report</span></span>
            </a>
            {latest && (
              <>
                <a className="qa-item" href={`/studio/${latest.id}?tab=data`} data-testid="qa-data">
                  <span className="qa-ico"><Icon name="clean" size={17} /></span>
                  <span><span className="qa-t">Data &amp; cleaning</span><span className="qa-s">{latest.code} · responses and quality</span></span>
                </a>
                <a className="qa-item" href={`/studio/${latest.id}?tab=quotas`} data-testid="qa-quotas">
                  <span className="qa-ico"><Icon name="quotas" size={17} /></span>
                  <span><span className="qa-t">Quotas</span><span className="qa-s">{latest.code} · fill and capacity</span></span>
                </a>
              </>
            )}
          </div>
        </section>

        {byStatus.length > 0 && (
          <section className="rail-card">
            <h2>Project status</h2>
            <div className="pf-bar" aria-hidden="true">
              {byStatus.map((r) => (
                <span key={r.key} className={`pf-seg ${r.meta.tone}`} style={{ flexGrow: r.n }} title={`${r.meta.label}: ${r.n}`} />
              ))}
            </div>
            <ul className="pf-list">
              {byStatus.map((r) => (
                <li key={r.key}>
                  <button className="pf-row" title={r.meta.hint}
                    onClick={() => { setOwnership("all"); setStatusFilter(r.key); }}>
                    <span className={`status-pill ${r.meta.tone}`}><span className="dot" />{r.meta.label}</span>
                    <span className="grow" />
                    <span className="pf-n">{r.n}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {activity && activity.length > 0 && (
          <section className="rail-card">
            <h2>Recent activity</h2>
            <ul className="act">
              {activity.map((e) => (
                <li key={e.id}>
                  <a className="act-row" href={`/studio/${e.survey.id}${e.kind === "response" ? "?tab=data" : ""}`}>
                    <span className={`act-ico ${e.kind}`}><Icon name={e.kind === "response" ? "data" : "questions"} size={14} /></span>
                    <span className="act-body">
                      <span className="act-t">{e.survey.title}</span>
                      <span className="act-s">
                        {e.kind === "response" ? "Last response" : "Programming updated"} · {relativeTime(e.at)}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </aside>
      </div>

      {deleting && (
        <div className="modal-back" onClick={() => setDeleting(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete “{deleting.title}”?</h2>
            <p className="muted" style={{ fontSize: 14 }}>
              This permanently deletes the survey project, <strong>all its versions, deployments,
              test sessions and collected responses</strong>. Live links stop working immediately.
              This cannot be undone — export the data first if you need it.
            </p>
            <label className="f"><span>Type the survey code <strong>{deleting.code}</strong> to confirm</span>
              <input className="input mono" autoFocus value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)} /></label>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setDeleting(null)}>Cancel</button>
              <button className="btn danger" disabled={confirmText !== deleting.code || deleteBusy}
                style={confirmText === deleting.code ? { borderColor: "var(--red)" } : undefined}
                onClick={async () => {
                  setDeleteBusy(true);
                  try {
                    const r = await fetch(`/api/surveys/${deleting.id}`, { method: "DELETE" });
                    const d = await r.json().catch(() => ({}));
                    if (!r.ok) setError(d.error ?? "delete failed");
                    setDeleting(null);
                    await load();
                  } finally {
                    setDeleteBusy(false);
                  }
                }}>
                {deleteBusy ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}

      {creating && (
        <div className="modal-back" onClick={() => setCreating(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>New survey</h2>
            <label className="f"><span>Title</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Customer Study 2026" /></label>
            <label className="f"><span>Survey code</span>
              <input className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="STUDY_001" /></label>
            <label className="f"><span>Start from</span>
              <select className="select" data-testid="new-survey-template" value={template} onChange={(e) => setTemplate(e.target.value)}>
                <option value="">Blank survey</option>
                {SURVEY_TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.name} — {t.description}</option>)}
              </select></label>
            <label className="f"><span>Theme</span>
              <select className="select" value={theme} onChange={(e) => setTheme(e.target.value)}>
                <option value="">Default</option>
                {THEME_PRESETS.map((t) => <option key={t.name} value={t.name}>{t.name} — {t.description}</option>)}
              </select></label>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn primary" onClick={create}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
