"use client";
import React from "react";
import { THEME_PRESETS } from "@/lib/defaults";
import {
  SurveyCard, SurveyCardSkeleton, STATUS_META,
  type SurveyRow, type SurveyStats, type Contributor,
} from "@/components/SurveyCard";
import { useSession } from "@/lib/useSession";

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
    const body: Record<string, unknown> = { title: title || "Untitled survey", code: code || undefined };
    if (preset) {
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
    return {
      surveys: surveys?.length ?? 0,
      live: surveys?.filter((x) => x.status === "live").length ?? 0,
      responses: list.reduce((a, b) => a + (b.liveResponseCount ?? 0), 0),
    };
  }, [surveys, stats, ownership]);

  return (
    <div className="dash">
      <div className="row" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <h1><span className="logo-mark">R</span> Rescript Studio</h1>
          <p className="muted" style={{ marginTop: -4 }}>
            {session.state.kind === "signed_in"
              ? <>Welcome, {session.state.user.name.split(" ")[0]} — your User ID is <span className="mono">{session.state.user.userCode}</span></>
              : "Professional survey programming & runtime platform."}
          </p>
        </div>
        <span className="grow" />
        {session.state.kind === "signed_in" && (
          <div className="row" style={{ gap: 6 }} data-testid="dash-account">
            {!!session.state.user.unread && (
              <a className="btn small" href="/profile" title="You have unread notifications">
                {session.state.user.unread} new
              </a>
            )}
            <a className="btn small" href="/profile">Profile</a>
            <a className="btn small" href="/security">Security</a>
            {session.state.user.isPlatformAdmin && <a className="btn small" href="/admin">Administration</a>}
            <button className="btn small" data-testid="dash-signout" onClick={() => void session.signOut()}>Sign out</button>
          </div>
        )}
      </div>

      <div className="dash-toolbar">
        <button className="btn primary" onClick={() => setCreating(true)}>+ New survey</button>
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
      {surveys?.length === 0 && <p className="muted">No surveys yet — create your first one.</p>}
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

      {deleting && (
        <div className="modal-back" onClick={() => setDeleting(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete “{deleting.title}”?</h2>
            <p className="muted" style={{ fontSize: 13 }}>
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
            <label className="f"><span>Template / theme</span>
              <select className="select" value={theme} onChange={(e) => setTheme(e.target.value)}>
                <option value="">Blank</option>
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
