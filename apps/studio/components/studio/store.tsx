"use client";
import React from "react";
import type { SurveyDefinition, Question } from "@rescript/schema";

/** Central studio state: the definition being edited + selection + dirty flag. */
export interface StudioState {
  def: SurveyDefinition;
  surveyDbId: string;
  currentVersionId: string | null;
  dirty: boolean;
  selectedQuestionId: string | null;
  /**
   * True once this survey has collected responses. Code re-sequencing rewrites
   * references across the definition, but it cannot rewrite data already
   * stored against the old codes — so once this is true, codes freeze.
   */
  hasResponses: boolean;
  update(mutator: (draft: SurveyDefinition) => void): void;
  /** switch the centre panel — lets one panel point at another */
  goToTab?(tab: string): void;
  setGoToTab(fn: (tab: string) => void): void;
  replace(def: SurveyDefinition): void;
  select(questionId: string | null): void;
  markSaved(versionId: string): void;
  toast(msg: string, kind?: "ok" | "err"): void;
}

const Ctx = React.createContext<StudioState | null>(null);
export const useStudio = () => {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useStudio outside provider");
  return v;
};

export function StudioProvider({
  initial, surveyDbId, versionId, children,
}: {
  initial: SurveyDefinition; surveyDbId: string; versionId: string | null; children: React.ReactNode;
}) {
  const [def, setDef] = React.useState<SurveyDefinition>(initial);
  const [dirty, setDirty] = React.useState(false);
  const [selectedQuestionId, setSelected] = React.useState<string | null>(null);
  const [currentVersionId, setVersionId] = React.useState<string | null>(versionId);
  const [toastMsg, setToastMsg] = React.useState<{ msg: string; kind: "ok" | "err" } | null>(null);
  const [hasResponses, setHasResponses] = React.useState(false);
  const goToTabRef = React.useRef<((tab: string) => void) | undefined>(undefined);
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // one cheap probe on mount; a survey with data must not have its codes moved
  React.useEffect(() => {
    let cancelled = false;
    if (surveyDbId === "sandbox") return;
    fetch(`/api/surveys/${surveyDbId}/responses?limit=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        const n = Array.isArray(d) ? d.length : (d.total ?? d.rows?.length ?? 0);
        setHasResponses(n > 0);
      })
      .catch(() => { /* offline / not deployed yet — treat as no data */ });
    return () => { cancelled = true; };
  }, [surveyDbId]);

  const value: StudioState = {
    def,
    surveyDbId,
    currentVersionId,
    dirty,
    selectedQuestionId,
    hasResponses,
    goToTab: (tab) => goToTabRef.current?.(tab),
    setGoToTab(fn) { goToTabRef.current = fn; },
    update(mutator) {
      setDef((prev) => {
        const draft = structuredClone(prev);
        mutator(draft);
        return draft;
      });
      setDirty(true);
    },
    replace(next) {
      setDef(next);
      setDirty(true);
    },
    select: setSelected,
    markSaved(vid) {
      setDirty(false);
      setVersionId(vid);
    },
    toast(msg, kind = "ok") {
      setToastMsg({ msg, kind });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToastMsg(null), 3500);
    },
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {toastMsg && <div className={`toast ${toastMsg.kind}`}>{toastMsg.msg}</div>}
    </Ctx.Provider>
  );
}

export function selectedQuestion(s: StudioState): Question | null {
  return s.def.questions.find((q) => q.id === s.selectedQuestionId) ?? null;
}

let seq = 0;
export const uid = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`;

/** All references usable in conditions / piping, for pickers. */
export function refOptions(def: SurveyDefinition): { value: string; label: string }[] {
  return [
    ...def.questions.map((q) => ({ value: q.id, label: `${q.code} — ${q.variableName}` })),
    ...def.calculations.map((c) => ({ value: c.targetVariable, label: `calc: ${c.targetVariable}` })),
    ...def.embeddedData.map((e) => ({ value: e.name, label: `embedded: ${e.name}` })),
  ];
}
