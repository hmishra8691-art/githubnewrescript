"use client";
import React from "react";
import { can, isProjectRole } from "@rescript/access";
import { useSession } from "@/lib/useSession";
import { AnalyticsWorkspace, type WsTab } from "@/components/analytics/AnalyticsWorkspace";

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
      <div className="row" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <h1><span className="logo-mark">R</span> Rescript Studio <span className="muted" style={{ fontWeight: 400, fontSize: 16 }}>/ Data Analytics</span></h1>
        </div>
        <span className="grow" />
        <div className="row" style={{ gap: 6 }}>
          <a className="btn small" href="/">Dashboard</a>
          {survey && <a className="btn small" href={`/studio/${survey.id}`}>Survey Programming</a>}
          {survey && <a className="btn small" href={`/studio/${survey.id}?tab=data`}>Data</a>}
          <a className="btn small" href="/profile">Profile</a>
          {session.state.kind === "signed_in" && <button className="btn small" onClick={() => void session.signOut()}>Sign out</button>}
        </div>
      </div>
      <div className="row" style={{ margin: "10px 0 14px", flexWrap: "wrap" }}>
        <label className="ax-field" style={{ minWidth: 320 }}><span>Survey</span>
          <select className="select" value={surveyId} onChange={(e) => setSurveyId(e.target.value)} data-testid="ax-survey">
            {(surveys ?? []).map((s) => <option key={s.id} value={s.id}>{s.title} ({s.code}){s.version ? ` · v${s.version}` : ""}</option>)}
          </select>
        </label>
        {survey && <span className="muted" style={{ fontSize: 12 }}>Your role: {survey.myRole}</span>}
      </div>
      {error && <div className="ax-error">{error}</div>}
      {surveys && !surveys.length && <div className="card">You have no surveys yet. Create one from the <a href="/">dashboard</a>, collect responses, and come back to analyse them.</div>}
      {survey && !canRead && <div className="card">Your role on “{survey.title}” ({survey.myRole}) does not include analytics access. Ask the project owner for a Viewer role or higher.</div>}
      {survey && canRead && <AnalyticsWorkspace key={survey.id} surveyId={survey.id} surveyTitle={survey.title} canEdit={can(role, "analytics.edit")} canPublish={can(role, "analytics.publish")} canExport={can(role, "analytics.export")} initialTab={initialTab} />}
    </div>
  );
}
