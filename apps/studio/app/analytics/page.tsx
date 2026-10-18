"use client";
import React from "react";
import { isProjectRole } from "@rescript/access";
import { analyticsPermissions } from "@/lib/analyticsAccess";
import { useSession } from "@/lib/useSession";
import { AnalyticsWorkspace, type WsTab } from "@/components/analytics/AnalyticsWorkspace";
import { resolveTab } from "@/components/analytics/navigation";
import { AppHeader } from "@/components/ui/AppHeader";

/**
 * /analytics — THE DATA ANALYTICS TAB (§1, §2). A top-level destination beside
 * the dashboard: pick a survey (any project the user holds a role on), then
 * the workspace. `?survey=<id>` deep-links from the Studio's left nav.
 */

interface SurveyRow { id: string; code: string; title: string; status: string; myRole: string; updated_at: string; version: string | null }

export default function AnalyticsPage() {
  const session = useSession({ redirectOnSignOut: true });
  const [surveys, setSurveys] = React.useState<SurveyRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [surveyId, setSurveyId] = React.useState<string>("");
  const [initialTab, setInitialTab] = React.useState<WsTab | undefined>(undefined);

  React.useEffect(() => {
    const u = new URL(window.location.href);
    setSurveyId(u.searchParams.get("survey") ?? "");
    const t = resolveTab(u.searchParams.get("tab")); if (t) setInitialTab(t);
    fetch("/api/surveys", { cache: "no-store" }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "Could not load surveys"); setSurveys(j.surveys ?? []); }).catch((e) => setError(e.message));
  }, []);
  React.useEffect(() => {
    if (!surveys?.length) return;
    if (!surveyId || !surveys.some((s) => s.id === surveyId)) { const first = surveys[0]; setSurveyId(first.id); }
  }, [surveys, surveyId]);
  React.useEffect(() => { if (!surveyId) return; const u = new URL(window.location.href); u.searchParams.set("survey", surveyId); window.history.replaceState(null, "", u.toString()); }, [surveyId]);

  const survey = surveys?.find((s) => s.id === surveyId);
  const role = survey && isProjectRole(survey.myRole) ? survey.myRole : null;
  /*
   * A CUSTOM member's capabilities are in the membership, not the role (the Apply audit,
   * 2026-10-17): asked with the bare role "custom", `can()` answers from its floor
   * (`project.read`) and the workspace — and its Apply — was never shown. The analytics
   * route answers with the membership's own capabilities; every fixed role reads the same
   * set either way, so it is only waited for when the role cannot answer alone.
   */
  /*
   * NEVER HANG ON THE ACCESS CHECK (2026-10-18): whatever the access request does — fails, answers
   * without capabilities, 404s on an older server, or takes too long — the page settles within 6 s on
   * the role-based answer it always gave (the server still enforces every capability). Only a custom
   * member waits at all, and only until the request settles.
   */
  const [access, setAccess] = React.useState<{ surveyId: string; capabilities: string[] | null } | null>(null);
  React.useEffect(() => {
    if (!survey) return;
    let live = true;
    const id = survey.id;
    const settle = (capabilities: string[] | null) => { if (live) setAccess((a) => (a && a.surveyId === id && a.capabilities ? a : { surveyId: id, capabilities })); };
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => { settle(null); ctl?.abort(); }, 6000);
    fetch(`/api/surveys/${id}/analytics/access`, { cache: "no-store", ...(ctl ? { signal: ctl.signal } : {}) })
      .then(async (r) => { const j = await r.json().catch(() => null) as { capabilities?: unknown } | null; settle(r.ok && Array.isArray(j?.capabilities) ? (j!.capabilities as unknown[]).filter((c): c is string => typeof c === "string") : null); })
      .catch(() => settle(null))
      .finally(() => clearTimeout(timer));
    return () => { live = false; clearTimeout(timer); ctl?.abort(); };
  }, [survey?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const settled = !!(access && survey && access.surveyId === survey.id);
  const caps = settled ? access!.capabilities : null;
  const perms = analyticsPermissions(role, caps, { settled });
  const { waiting, canRead } = perms;

  return (
    /*
     * `dash ax-page` capped this page at 1400px inside a 1440px container and
     * then, because `.ax-page` is also a printed report's page, wrapped the
     * whole thing in a second panel. `.ax-shell` is this page's own: fluid to
     * the viewport, and a flex column so the workspace fills the window
     * instead of ending halfway down it. The test id is unchanged.
     */
    <div className="ax-shell" data-testid="ax-page">
      <AppHeader active="analytics" user={session.state.kind === "signed_in" ? session.state.user : null} onSignOut={() => void session.signOut()}
        crumbs={survey ? <span className="crumbs"><a href="/">Projects</a><span className="sep">/</span><a href={`/studio/${survey.id}`}>{survey.title}</a><span className="sep">/</span><span className="here">Data Analytics</span></span> : undefined} />
      <div className="row" style={{ margin: "18px 0 16px", flexWrap: "wrap", gap: 14 }}>
        <label className="ax-field" style={{ minWidth: 340 }}><span>Survey</span>
          <select className="select" value={surveyId} onChange={(e) => setSurveyId(e.target.value)} data-testid="ax-survey">
            {(surveys ?? []).map((s) => <option key={s.id} value={s.id}>{s.title} ({s.code}){s.version ? ` · v${s.version}` : ""}</option>)}
          </select>
        </label>
        {survey && <span className="badge neutral" style={{ alignSelf: "flex-end", marginBottom: 6 }}>Your role: {survey.myRole}</span>}
        <span className="grow" />
        {survey && <span className="row" style={{ gap: 6, alignSelf: "flex-end" }}><a className="btn" href={`/studio/${survey.id}`}>Survey Programming</a><a className="btn" href={`/studio/${survey.id}?tab=data`}>Data</a></span>}
      </div>
      {error && <div className="ax-error">{error}</div>}
      {surveys && !surveys.length && <div className="card">You have no surveys yet. Create one from the <a href="/">dashboard</a>, collect responses, and come back to analyse them.</div>}
      {survey && waiting && <div className="card muted" data-testid="ax-access-loading">Checking your access to this project…</div>}
      {survey && !waiting && !canRead && <div className="card" data-testid="ax-no-access">Your role on “{survey.title}” ({survey.myRole}) does not include analytics access. Ask the project owner for a Viewer role or higher, or for Data Analytics access.</div>}
      {survey && !waiting && canRead && <AnalyticsWorkspace key={survey.id} surveyId={survey.id} surveyTitle={survey.title} canEdit={perms.canEdit} canEditPlan={perms.canEditPlan} canPublish={perms.canPublish} canExport={perms.canExport} initialTab={initialTab} />}
    </div>
  );
}
