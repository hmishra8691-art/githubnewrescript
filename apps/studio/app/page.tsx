"use client";
import React from "react";
import { THEME_PRESETS } from "@/lib/defaults";
import { SURVEY_TEMPLATES, findSurveyTemplate } from "@rescript/templates";
import {
  SurveyCard, SurveyCardSkeleton, STATUS_META, relativeTime,
  type SurveyRow, type SurveyStats, type Contributor, type CardMeter,
} from "@/components/SurveyCard";
import { ProjectBudgetDialog } from "@/components/dashboard/ProjectBudgetDialog";
import { AddFundsDialog } from "@/components/dashboard/AddFundsDialog";
import { CloneProjectDialog } from "@/components/dashboard/CloneProjectDialog";
import { useSession } from "@/lib/useSession";
import { AppHeader, greeting } from "@/components/ui/AppHeader";
import { Icon } from "@/components/ui/Icon";
import { can, type ProjectRole } from "@rescript/access";
import { fmtMoney, LEVEL_CLASS, LEVEL_WORD } from "@/components/billing/shared";

type SortKey =
  | "updated" | "created" | "name_az" | "name_za"
  | "responses_desc" | "responses_asc" | "questions_desc" | "due"
  | "used_desc" | "used_asc" | "balance_asc" | "balance_desc";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "updated", label: "Recently updated" },
  { key: "created", label: "Recently created" },
  { key: "name_az", label: "Name A–Z" },
  { key: "name_za", label: "Name Z–A" },
  { key: "responses_desc", label: "Most responses" },
  { key: "responses_asc", label: "Fewest responses" },
  { key: "questions_desc", label: "Most questions" },
  { key: "due", label: "Due soonest" },
  /* the spending sorts: "which study is about to stop" is a question about
     money, and none of the sorts above can answer it */
  { key: "balance_asc", label: "Least left to spend" },
  { key: "balance_desc", label: "Most left to spend" },
  { key: "used_desc", label: "Most spent" },
  { key: "used_asc", label: "Least spent" },
];

/** The spending states a researcher filters by, in the words the cards use. */
type BalanceFilter = "all" | "healthy" | "low" | "critical" | "exhausted" | "frozen";
const BALANCE_FILTERS: { key: BalanceFilter; label: string }[] = [
  { key: "all", label: "Any spending" },
  { key: "healthy", label: "Healthy" },
  { key: "low", label: "Low balance" },
  { key: "critical", label: "Critical" },
  { key: "frozen", label: "At its limit" },
  { key: "exhausted", label: "Exhausted" },
];
const LEVEL_FILTER: Record<string, BalanceFilter> = { normal: "healthy", low: "low", critical: "critical", locked: "exhausted" };

/** The person's one wallet, as the page header shows it. */
interface WalletSummary {
  currency: string;
  balance: number;
  reserved: number;
  available: number;
  totalAdded: number;
  totalUsed: number;
  level: "normal" | "low" | "critical" | "locked";
  state: "active" | "read_only" | "suspended";
}

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
  const [balanceFilter, setBalanceFilter] = React.useState<BalanceFilter>("all");
  const [sort, setSort] = React.useState<SortKey>("updated");
  /* the wallet and the projects spending from it — loaded separately, so a
     workspace without billing still gets its projects */
  const [meters, setMeters] = React.useState<Record<string, CardMeter | null>>({});
  const [budgetable, setBudgetable] = React.useState<Record<string, boolean>>({});
  const [wallet, setWallet] = React.useState<WalletSummary | null>(null);
  const [metersLoading, setMetersLoading] = React.useState(true);
  const [billingOn, setBillingOn] = React.useState(false);
  const [budgeting, setBudgeting] = React.useState<SurveyRow | null>(null);
  const [addingFunds, setAddingFunds] = React.useState(false);
  const [cloning, setCloning] = React.useState<SurveyRow | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [code, setCode] = React.useState("");
  const [theme, setTheme] = React.useState<string>("");
  const [template, setTemplate] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<SurveyRow | null>(null);
  const [confirmText, setConfirmText] = React.useState("");
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  /*
   * Scoped to the modal, not the page-level `error` banner: a genuine delete
   * failure (wrong role, locked project, a 500) must stay visible right next
   * to the button the user just pressed. The modal only closes on a real
   * success or a confirmed already-deleted (404) — never on a failure, which
   * is the bug this fixes (the modal used to close and the list reload
   * unconditionally, so a refused delete looked identical to a real one).
   */
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

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
  /**
   * THE WALLETS, IN ONE REQUEST FOR THE WHOLE PAGE.
   *
   * Separate from the survey list on purpose. Billing is optional on an
   * installation and a wallet is additive information: if this call fails, or
   * the installation has no billing, every card still renders exactly as it
   * did before — the meter is simply not there. The alternative, folding it
   * into `/api/surveys`, would let a billing problem empty the dashboard.
   */
  const loadMeters = React.useCallback(async () => {
    try {
      const r = await fetch("/api/billing/projects");
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d?.ok) { setBillingOn(false); return; }
      const m: Record<string, CardMeter | null> = {};
      const bd: Record<string, boolean> = {};
      for (const p of d.projects ?? []) { m[p.id] = p.meter ?? null; bd[p.id] = !!p.canBudget; }
      setMeters(m); setBudgetable(bd); setWallet(d.wallet ?? null); setBillingOn(true);
    } catch { setBillingOn(false); } finally { setMetersLoading(false); }
  }, []);

  React.useEffect(() => {
    void load();
    void loadMeters();
  }, [load, loadMeters]);

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
      /* a project with no meter has no band to be in, so a spending filter
         excludes it rather than silently counting it healthy */
      if (balanceFilter !== "all") {
        const m = meters[s2.id];
        if (!m) return false;
        /* "at its limit" is about the PROJECT's own rule, which is a
           different question from how much money is left */
        if (balanceFilter === "frozen") { if (m.state !== "frozen") return false; }
        else if (m.state === "frozen" || LEVEL_FILTER[m.level] !== balanceFilter) return false;
      }
      if (!q) return true;
      return (
        s2.title.toLowerCase().includes(q) ||
        s2.code.toLowerCase().includes(q) ||
        s2.status.toLowerCase().includes(q) ||
        /*
         * §60 — the client and the project manager are searched too, because
         * "everything for ACME" is the second thing anybody types into a
         * project list and, until those fields existed, it could only work if
         * somebody had put the client's name in the title.
         */
        (s2.clientName ?? "").toLowerCase().includes(q) ||
        (s2.projectManager ?? "").toLowerCase().includes(q)
      );
    });
    const n = (id: string, k: keyof SurveyStats) => Number(stats[id]?.[k] ?? 0);
    const cash = (id: string, missing: number) => meters[id]?.allowance ?? missing;
    const spent = (id: string, missing: number) => meters[id]?.used ?? missing;
    rows = [...rows].sort((a, b) => {
      switch (sort) {
        case "created": return b.created_at.localeCompare(a.created_at);
        case "name_az": return a.title.localeCompare(b.title);
        case "name_za": return b.title.localeCompare(a.title);
        case "responses_desc": return n(b.id, "responseCount") - n(a.id, "responseCount");
        case "responses_asc": return n(a.id, "responseCount") - n(b.id, "responseCount");
        case "questions_desc": return n(b.id, "questionCount") - n(a.id, "questionCount");
        /*
         * Wallet sorts. A project with no wallet sorts LAST in every one of
         * them — it has no balance, and putting "unknown" at the top of
         * "lowest balance" would bury the project that is actually about to
         * stop, which is the only reason to sort this way.
         */
        case "balance_asc": return cash(a.id, Infinity) - cash(b.id, Infinity);
        case "balance_desc": return cash(b.id, -Infinity) - cash(a.id, -Infinity);
        case "used_desc": return spent(b.id, -Infinity) - spent(a.id, -Infinity);
        case "used_asc": return spent(a.id, Infinity) - spent(b.id, Infinity);
        /*
         * §60 — soonest first, and a project with no due date goes last
         * rather than first: an absent date is "not scheduled", and sorting it
         * to the top of a deadline list is the one arrangement that makes the
         * list useless.
         */
        case "due": {
          const da = a.dueDate ?? "9999-12-31";
          const dbb = b.dueDate ?? "9999-12-31";
          return da.localeCompare(dbb) || b.updated_at.localeCompare(a.updated_at);
        }
        case "updated":
        default: return b.updated_at.localeCompare(a.updated_at);
      }
    });
    return rows;
  }, [surveys, stats, meters, ownership, search, statusFilter, responseFilter, balanceFilter, sort]);

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

      {/*
        * ONE WALLET, ABOVE THE PROJECTS THAT SPEND IT.
        *
        * The balance belongs here and not on the cards, because there is one
        * of it: repeating it on every card would suggest each project had its
        * own, which is exactly the model this replaced. The cards below say
        * what each study has spent and what it may still take; this says what
        * there is.
        */}
      {billingOn && wallet && (
        <div className={`dash-wallet ${wallet.state === "read_only" ? "empty" : ""}`} data-testid="dash-wallet"
          data-level={wallet.level} data-state={wallet.state}>
          <div className="dw-main">
            <div className="dw-label">My wallet</div>
            <div className="dw-balance" data-testid="dash-wallet-balance">{fmtMoney(wallet.balance, wallet.currency)}</div>
            <div className="dw-sub muted">
              {fmtMoney(wallet.totalUsed, wallet.currency)} used of {fmtMoney(wallet.totalAdded, wallet.currency)} added
              {wallet.reserved > 0 ? ` · ${fmtMoney(wallet.reserved, wallet.currency)} held by work in progress` : ""}
            </div>
          </div>
          <div className="dw-side">
            <span className={`badge ${wallet.state === "suspended" ? "error" : LEVEL_CLASS[wallet.level]}`} data-testid="dash-wallet-level">
              {wallet.state === "suspended" ? "Suspended" : wallet.state === "read_only" ? "Empty" : LEVEL_WORD[wallet.level]}
            </span>
            <button className="btn small primary" data-testid="dash-add-funds" onClick={() => setAddingFunds(true)}>Add funds</button>
            <a className="btn small" href="/billing">My usage</a>
          </div>
          {wallet.state === "read_only" && (
            <div className="dw-note" data-testid="dash-wallet-empty">
              Your wallet is empty, so every project has stopped running billable work. Adding funds starts them again.
            </div>
          )}
        </div>
      )}

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
        {/* offered only where there are wallets to filter by */}
        {billingOn && (
          <select className="select" aria-label="Filter by wallet balance" data-testid="dash-balance-filter"
            value={balanceFilter} onChange={(e) => setBalanceFilter(e.target.value as BalanceFilter)}>
            {BALANCE_FILTERS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        )}
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
            setSearch(""); setStatusFilter("all"); setResponseFilter("any"); setBalanceFilter("all");
          }}>Clear filters</button>
        </p>
      )}
      {visible?.map((s) => (
        <SurveyCard key={s.id} survey={s} stats={stats[s.id]} contributors={contributors}
          loading={statsLoading && !stats[s.id]}
          onOpen={() => (window.location.href = `/studio/${s.id}`)}
          onResponses={() => (window.location.href = `/studio/${s.id}?tab=data`)}
          onStatus={(status) => setStatus(s.id, status)}
          onDelete={() => { setDeleting(s); setConfirmText(""); setDeleteError(null); }}
          meter={billingOn ? meters[s.id] ?? null : undefined}
          meterLoading={metersLoading}
          canBudget={!!budgetable[s.id]}
          onBudget={() => setBudgeting(s)}
          onClone={() => setCloning(s)}
          /*
           * project.delete is owner-only (packages/access/src/roles.ts) and
           * that's already enforced server-side — this is only a courtesy so
           * a role we KNOW can't delete doesn't walk through the whole
           * confirm flow to hit a permission error. Unknown role (legacy
           * rows without `myRole`) defaults to true, same fallback this file
           * already uses for `roleSource` — never take away something that
           * used to work over a missing field.
           */
          canDelete={s.myRole ? can(s.myRole as ProjectRole, "project.delete") : true} />
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
        <div className="modal-back" onClick={() => { if (!deleteBusy) setDeleting(null); }} data-testid="delete-modal">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete “{deleting.title}”?</h2>
            <p className="muted" style={{ fontSize: 14 }}>
              This permanently deletes the survey project, <strong>all its versions, deployments,
              test sessions and collected responses</strong>. Live links stop working immediately.
              This cannot be undone — export the data first if you need it.
            </p>
            <label className="f"><span>Type the survey code <strong>{deleting.code}</strong> to confirm</span>
              <input className="input mono" autoFocus value={confirmText} data-testid="delete-confirm-input"
                onChange={(e) => setConfirmText(e.target.value)} /></label>
            {deleteError && (
              <p className="card" data-testid="delete-error"
                style={{ borderColor: "var(--red)", color: "var(--red)", fontSize: 13.5 }}>
                {deleteError}
              </p>
            )}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn" disabled={deleteBusy} data-testid="delete-cancel-btn"
                onClick={() => setDeleting(null)}>Cancel</button>
              <button className="btn danger" data-testid="delete-confirm-btn"
                disabled={confirmText !== deleting.code || deleteBusy}
                style={confirmText === deleting.code ? { borderColor: "var(--red)" } : undefined}
                onClick={async () => {
                  setDeleteBusy(true);
                  setDeleteError(null);
                  try {
                    const r = await fetch(`/api/surveys/${deleting.id}`, { method: "DELETE" });
                    const d = await r.json().catch(() => ({}));
                    /*
                     * A 200 is a confirmed deletion; a 404 means it is
                     * already gone (someone else deleted it, or a retry
                     * after a prior success) — neither is a failure to
                     * report (req §23). Anything else is a REAL failure and
                     * must not be presented as success: the modal stays
                     * open, the list is not touched, and the exact reason
                     * the server gave is shown right here.
                     */
                    if (r.ok || r.status === 404) {
                      setDeleting(null);
                      setDeleteError(null);
                      await load();
                      return;
                    }
                    setDeleteError(
                      d.error ??
                        "We could not permanently delete this survey. No changes were applied. Please try again.",
                    );
                  } catch {
                    setDeleteError(
                      "We could not reach the server to delete this survey. No changes were applied. Please try again.",
                    );
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

      {/*
        * The spending limit, Add funds and Clone. All three reload the page's
        * data when they finish rather than patching a number into local
        * state: the server decides what a project may now spend, whether it
        * is frozen, and what the wallet holds.
        */}
      {budgeting && meters[budgeting.id] && (
        <ProjectBudgetDialog
          project={{ id: budgeting.id, title: budgeting.title, code: budgeting.code }}
          meter={{
            mode: meters[budgeting.id]!.mode,
            limit: meters[budgeting.id]!.limit,
            used: meters[budgeting.id]!.used,
            currency: meters[budgeting.id]!.currency,
            walletRemaining: meters[budgeting.id]!.walletRemaining,
            state: meters[budgeting.id]!.state,
          }}
          onClose={() => setBudgeting(null)}
          onSaved={() => { void loadMeters(); }}
        />
      )}
      {addingFunds && (
        <AddFundsDialog
          currency={wallet?.currency ?? "USD"}
          balance={wallet?.balance ?? 0}
          onClose={() => setAddingFunds(false)}
          onRequested={() => { void loadMeters(); }}
        />
      )}
      {cloning && (
        <CloneProjectDialog
          project={{ id: cloning.id, title: cloning.title, code: cloning.code }}
          onClose={() => setCloning(null)}
          onCloned={() => { void load(); void loadMeters(); }}
        />
      )}
    </div>
  );
}
