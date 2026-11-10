"use client";
import React from "react";
import { useSession } from "@/lib/useSession";
import { AppHeader } from "@/components/ui/AppHeader";
import { HelpAssistant } from "@/components/help/HelpAssistant";

/**
 * /help — THE HELP TAB in the main navigation (2026-11-09). The same assistant as the Studio's Help drawer, outside a
 * project. AI-written answers are billed to a project, so the user picks one (only projects they may read are
 * listed); "Guides only" answers from the knowledge base without AI and costs nothing.
 */
interface SurveyRow { id: string; title: string; code: string }

export default function HelpPage() {
  const session = useSession({ redirectOnSignOut: true });
  const [surveys, setSurveys] = React.useState<SurveyRow[]>([]);
  const [billTo, setBillTo] = React.useState<string>("");
  React.useEffect(() => {
    fetch("/api/surveys", { cache: "no-store" }).then(async (r) => { const j = await r.json(); if (r.ok) setSurveys(j.surveys ?? []); }).catch(() => {});
    try { const saved = window.localStorage.getItem("rescript.help.billTo"); if (saved) setBillTo(saved); } catch { /* storage unavailable */ }
  }, []);
  const choose = (v: string) => { setBillTo(v); try { window.localStorage.setItem("rescript.help.billTo", v); } catch { /* storage unavailable */ } };
  const valid = surveys.some((s) => s.id === billTo) ? billTo : "";
  return (
    <div className="hx-page">
      <AppHeader active="help" user={session.state.kind === "signed_in" ? session.state.user : null} onSignOut={() => void session.signOut()} />
      <div className="hx-page-bar">
        <label className="hx-bill" title="Help answers from the guides first, at no charge. AI writes an answer only when the guides cover a question weakly, a problem persists, or you press Ask the AI — charged like other AI requests to the project you choose. Guides only: never AI, never a charge.">
          <span>AI answers billed to</span>
          <select value={valid} onChange={(e) => choose(e.target.value)} data-testid="help-bill-to">
            <option value="">Guides only (no AI, no charge)</option>
            {surveys.map((s) => <option key={s.id} value={s.id}>{s.title || s.code}</option>)}
          </select>
        </label>
      </div>
      <HelpAssistant surface="platform" surveyId={valid || null} />
    </div>
  );
}
