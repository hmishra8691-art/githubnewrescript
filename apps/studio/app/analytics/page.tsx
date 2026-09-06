"use client";
import React from "react";
import { can, isProjectRole } from "@rescript/access";
import { useSession } from "@/lib/useSession";
import { AnalyticsWorkspace, type WsTab } from "@/components/analytics/AnalyticsWorkspace";
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
    const t = u.searchParams.get("tab") as WsTab | null; if (t) setInitialTab(t);
    fetch("/api/surveys", { cache: "no-store" }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "Could not load surveys"); setSurveys(j.surveys ?? []); }).catch((e) => setError(e.message));
  }, []);
  React.useEffect(() => {
    if (!surveys?.length) return;
    if (!surveyId || !surveys.some((s) => s.id === surveyId)) { const first = surveys[0]; setSurveyId(first.id); }
  }, [surveys, surveyId]);
  React.useEffect(() => { if (!surveyId) return; const u = new URL(window.location.href); u.searchParams.set("survey", surveyId); window.history.replaceState(null, "", u.toString()); }, [surveyId]);

  const survey = surveys?.find((s) => s.id === surveyId);
  const role = survey && isProjectRole(survey.myRole) ? survey.myRole : null;
  const canRead = can(role, "analytics.read");

  return (
    <div className="dash ax-page" data-testid="ax-page">
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
      {survey && !canRead && <div className="card">Your role on “{survey.title}” ({survey.myRole}) does not include analytics access. Ask the project owner for a Viewer role or higher.</div>}
      {survey && canRead && <AnalyticsWorkspace key={survey.id} surveyId={survey.id} surveyTitle={survey.title} canEdit={can(role, "analytics.edit")} canPublish={can(role, "analytics.publish")} canExport={can(role, "analytics.export")} initialTab={initialTab} />}
    </div>
  );
}
