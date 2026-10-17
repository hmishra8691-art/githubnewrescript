"use client";
import React from "react";
import { AppHeader } from "@/components/ui/AppHeader";
import { Icon, type IconName } from "@/components/ui/Icon";
import { useSession } from "@/lib/useSession";
import { STATUS_META, relativeTime } from "@/components/SurveyCard";
import { fmtMoney } from "@/components/billing/shared";
import type { ModuleStatus } from "@/lib/projectOverview";
import { CollaboratorsButton } from "@/components/studio/CollaboratorsPanel";

/**
 * THE PROJECT OVERVIEW (dashboard brief §2) — the page a project opens on.
 * Login → Projects → this → the tool the researcher chooses. It is a control
 * panel, not a dashboard: what the project is, which parts of it are set up
 * (from what is saved, never inferred), what it has spent, what happened
 * last, and a door into every module. One request (`/api/surveys/{id}/overview`).
 */
interface Overview {
  project: { id: string; code: string; title: string; status: string; version: string | null; revision: number | null; draftSavedAt: string | null; updatedAt: string; createdAt: string; locked: boolean; role: string | null; accessLabel?: string; capabilities?: string[]; accessExpiresAt?: string | null; accessExpiryText?: string | null; clientName: string | null; projectManager: string | null; fieldworkFrom: string | null; fieldworkTo: string | null; dueDate: string | null; languages: number; sourceLanguage: string };
  counts: { questions: number; pages: number; responses: number | null; live: number | null; test: number | null; complete: number | null; lastResponseAt: string | null };
  modules: ModuleStatus[];
  summary: { configured: number; total: number; attention: ModuleStatus[] };
  spend: { currency: string; used: number; limit: number | null; allowance: number; mode: string; level: string; state: string; events: number; walletRemaining: number } | null;
  activity: { id: string; text: string; category: string; at: string; actorName: string | null }[];
  warnings: string[];
}

const STATE_WORD: Record<ModuleStatus["state"], string> = { configured: "Configured", incomplete: "Incomplete", not_configured: "Not set up", needs_attention: "Needs attention" };

/** the modules a researcher reaches from here, in the order the work happens; each is a Studio tab */
/* `needs`: the capability that module's own routes require to READ (packages/access) — a member without it sees the tile disabled, and the route answers 403 anyway */
const MODULES: { key: string; label: string; tab: string; icon: IconName; blurb: string; needs: string }[] = [
  { key: "programming", label: "Programming", tab: "questions", icon: "questions", blurb: "Questions, logic, flow — Studio, Intelligent, Flow and Grid modes", needs: "project.read" },
  { key: "quotas", label: "Quotas", tab: "quotas", icon: "quotas", blurb: "Cells, limits and fills", needs: "project.read" },
  { key: "collection", label: "Versions & Deploy", tab: "versions", icon: "versions", blurb: "Save a version, deploy test and live links", needs: "project.read" },
  { key: "data", label: "Data", tab: "data", icon: "data", blurb: "Responses, quality, exports", needs: "responses.read" },
  { key: "fieldwork", label: "Fieldwork", tab: "fieldwork", icon: "clean", blurb: "Sample sources, timeline, cost", needs: "fieldwork.read" },
  { key: "analytics", label: "Data Analytics", tab: "analytics", icon: "analytics", blurb: "Analyses, dashboards, reports", needs: "analytics.read" },
  { key: "languages", label: "Translation", tab: "localization", icon: "share", blurb: "Languages and translations", needs: "project.read" },
  { key: "settings", label: "Survey Settings", tab: "settings", icon: "settings", blurb: "Research design, brief, enforcement", needs: "project.read" },
  { key: "project", label: "Project", tab: "project", icon: "home", blurb: "Client, manager, dates, access", needs: "project.read" },
  { key: "usage", label: "Usage & Wallet", tab: "usage", icon: "chart", blurb: "This project's spend and its limit", needs: "billing.read" },
];

export function ProjectOverview({ surveyDbId }: { surveyDbId: string }) {
  const session = useSession();
  const [data, setData] = React.useState<Overview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    try {
      const r = await fetch(`/api/surveys/${surveyDbId}/overview`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) { setError(j.error ?? r.statusText); return; }
      setData(j as Overview); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [surveyDbId]);
  React.useEffect(() => { void load(); }, [load]);
  /* "analytics" opens Data Analytics; "analytics:<tab>" opens one of its tabs (the Analysis plan row) */
  const href = (tab: string) => (tab === "analytics" ? `/analytics?survey=${surveyDbId}` : tab.startsWith("analytics:") ? `/analytics?survey=${surveyDbId}&tab=${tab.slice(10)}` : `/studio/${surveyDbId}?tab=${tab}`);
  const p = data?.project;
  const meta = p ? STATUS_META[p.status] ?? { label: p.status, tone: "draft", hint: "" } : null;
  const num = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString());
  /* an older server sends no capability list: offer everything, as before — the routes decide either way */
  const allowed = (cap: string) => !p?.capabilities || p.capabilities.includes(cap);

  return (
    <div className="dash po" data-testid="project-overview" data-loaded={data ? "true" : "false"}>
      <AppHeader active="dashboard" user={session.state.kind === "signed_in" ? session.state.user : null} onSignOut={() => void session.signOut()}
        crumbs={<span className="crumbs"><a href="/">Projects</a><span className="sep">/</span><span className="here" data-testid="po-crumb">{p?.title ?? "…"}</span></span>} />

      {error && <p className="iq-error" data-testid="po-error"><Icon name="warning" size={12} /> {error} <button className="btn small" onClick={() => void load()}>Retry</button></p>}

      <section className="po-head" data-testid="po-head">
        <div className="po-title">
          <h1>{p?.title ?? <span className="sk sk-line" />}</h1>
          {p && <span className="survey-code mono">{p.code}</span>}
          {meta && <span className={`status-pill ${meta.tone}`} title={meta.hint} data-testid="po-status"><span className="dot" />{meta.label}</span>}
          {p?.locked && <span className="chip" title="Frozen by the owner">Frozen</span>}
        </div>
        {p && (
          <div className="po-meta muted" data-testid="po-meta">
            {p.version ? `v${p.version}` : "no saved version"}{p.revision != null ? ` · rev ${p.revision}` : ""}
            {p.draftSavedAt ? ` · draft saved ${relativeTime(p.draftSavedAt)}` : ""}
            {p.clientName ? ` · ${p.clientName}` : ""}{p.projectManager ? ` · ${p.projectManager}` : ""}{p.dueDate ? ` · due ${p.dueDate}` : ""}
            {p.role ? ` · you are ${p.accessLabel ?? p.role}` : ""}
            {p.accessExpiryText ? <span data-testid="po-access-expiry"> · your access: {p.accessExpiryText.toLowerCase()}</span> : null}
          </div>
        )}
        <div className="po-actions">
          <a className="btn primary" href={href("questions")} data-testid="po-open-programming"><Icon name="questions" size={15} /> Open programming</a>
          {/* who is on this project, and "+ Invite" — both open the ONE collaborators panel */}
          <CollaboratorsButton surveyId={surveyDbId} title={p?.title} />
          {allowed("responses.read")
            ? <a className="btn" href={href("data")} data-testid="po-open-data"><Icon name="data" size={15} /> Data</a>
            : <span className="btn" aria-disabled="true" data-testid="po-open-data" data-denied="true" title="Your access does not include response data">Data</span>}
          <a className="btn" href="/" data-testid="po-back">← All projects</a>
        </div>
      </section>

      <div className="po-grid">
        <section className="card po-card" data-testid="po-info">
          <h3>Project information</h3>
          <dl className="po-facts">
            <div><dt>Questions</dt><dd data-testid="po-questions">{data ? num(data.counts.questions) : "—"}<span className="muted"> on {data ? num(data.counts.pages) : "—"} pages</span></dd></div>
            <div><dt>Live responses</dt><dd data-testid="po-live">{data ? num(data.counts.live) : "—"}</dd></div>
            <div><dt>Test responses</dt><dd data-testid="po-test">{data ? num(data.counts.test) : "—"}</dd></div>
            <div><dt>Completed</dt><dd data-testid="po-complete">{data ? num(data.counts.complete) : "—"}</dd></div>
            <div><dt>Last response</dt><dd>{data?.counts.lastResponseAt ? relativeTime(data.counts.lastResponseAt) : "none yet"}</dd></div>
            <div><dt>Fieldwork</dt><dd>{p?.fieldworkFrom || p?.fieldworkTo ? `${p?.fieldworkFrom ?? "—"} → ${p?.fieldworkTo ?? "—"}` : "not scheduled"}</dd></div>
            <div><dt>Languages</dt><dd>{p ? (p.languages ? `${p.sourceLanguage} + ${p.languages}` : p.sourceLanguage) : "—"}</dd></div>
            <div><dt>Updated</dt><dd>{p ? relativeTime(p.updatedAt) : "—"}</dd></div>
          </dl>
        </section>

        <section className="card po-card" data-testid="po-spend">
          <h3>Project utilization</h3>
          {data && !data.spend && <p className="muted" data-testid="po-spend-none">Usage metering is not available on this Studio.</p>}
          {data?.spend && (
            <>
              <div className="po-spend-main">
                <span className="po-spend-v" data-testid="po-spend-used">{fmtMoney(data.spend.used, data.spend.currency)}</span>
                <span className="muted">spent by this project{data.spend.events ? ` · ${data.spend.events} billable operations` : ""}</span>
              </div>
              <div className="muted po-spend-sub" data-testid="po-spend-sub">
                {data.spend.limit == null ? `No project limit — it spends from the owner's wallet (${fmtMoney(data.spend.walletRemaining, data.spend.currency)} left there)` : `Project limit ${fmtMoney(data.spend.limit, data.spend.currency)} · ${fmtMoney(data.spend.allowance, data.spend.currency)} left of it`}
                {data.spend.state === "frozen" ? " · stopped at its limit" : data.spend.state === "read_only" ? " · stopped: the wallet is empty" : ""}
              </div>
              <a className="btn small" href={href("usage")} data-testid="po-spend-open">Usage & Wallet</a>
            </>
          )}
          {!data && <span className="sk sk-line" />}
        </section>

        <section className="card po-card po-wide" data-testid="po-config">
          <h3>Configuration &amp; setup {data && <span className="muted" data-testid="po-config-summary">· {data.summary.configured} of {data.summary.total} configured</span>}</h3>
          {data?.summary.attention.length ? <p className="iq-warning" data-testid="po-attention"><Icon name="warning" size={12} /> Needs attention: {data.summary.attention.map((m) => m.label).join(", ")}</p> : null}
          <ul className="po-modules">
            {(data?.modules ?? []).map((m) => (
              <li key={m.key} data-testid="po-module" data-key={m.key} data-state={m.state}>
                <a href={href(m.tab)} className="po-module-row">
                  <span className={`po-state ${m.state}`}>{STATE_WORD[m.state]}</span>
                  <span className="po-module-label">{m.label}{m.count != null ? <span className="nav-count">{m.count}</span> : null}</span>
                  <span className="po-module-detail muted">{m.detail}</span>
                  <Icon name="chevron-right" size={14} />
                </a>
              </li>
            ))}
            {!data && [1, 2, 3, 4].map((i) => <li key={i}><span className="sk sk-line" /></li>)}
          </ul>
        </section>

        <section className="card po-card po-wide" data-testid="po-nav">
          <h3>Modules</h3>
          <div className="po-nav">
            {MODULES.map((m) => allowed(m.needs) ? (
              <a key={m.key} href={href(m.tab)} className="po-nav-item" data-testid={`po-nav-${m.key}`}>
                <Icon name={m.icon} size={18} />
                <span className="po-nav-label">{m.label}</span>
                <span className="po-nav-blurb muted">{m.blurb}</span>
              </a>
            ) : (
              <span key={m.key} className="po-nav-item" aria-disabled="true" data-denied="true" data-testid={`po-nav-${m.key}`} style={{ opacity: 0.5, cursor: "not-allowed" }}
                title="Your access to this project does not include this module">
                <Icon name={m.icon} size={18} />
                <span className="po-nav-label">{m.label}</span>
                <span className="po-nav-blurb muted">No access</span>
              </span>
            ))}
          </div>
        </section>

        <section className="card po-card po-wide" data-testid="po-activity">
          <h3>Recent activity</h3>
          {data && !data.activity.length && <p className="muted" data-testid="po-activity-empty">Nothing recorded yet.</p>}
          <ul className="po-activity">
            {(data?.activity ?? []).map((e) => (
              <li key={e.id} data-testid="po-activity-row" data-category={e.category}>
                <span className="muted po-when" title={e.at}>{relativeTime(e.at)}</span>
                <span>{e.text}{e.actorName ? <span className="muted"> — {e.actorName}</span> : null}</span>
              </li>
            ))}
          </ul>
          {data && data.activity.length > 0 && <a className="btn small" href={href("activity")} data-testid="po-activity-all">All activity</a>}
        </section>
      </div>
      {data?.warnings.length ? <p className="muted po-warnings" data-testid="po-warnings">Some facts could not be read: {data.warnings.join("; ")}</p> : null}
    </div>
  );
}
