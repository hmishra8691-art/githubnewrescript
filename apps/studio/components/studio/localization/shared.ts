"use client";
import React from "react";
import type { Localization, SurveyDefinition } from "@rescript/schema";
import { effectiveLocalization } from "@rescript/engine";
import { useStudio } from "../store";

/**
 * Shared plumbing for the Translation & Localization tab: one way to read
 * the survey's localization object with defaults filled, one way to write it
 * back through the Studio's undoable `update`, and the signed-in person's
 * name for `updatedBy` (the sandbox has no session — "you").
 */

export function useLocalization() {
  const s = useStudio();
  const loc = React.useMemo(() => effectiveLocalization(s.def), [s.def]);
  const setLoc = React.useCallback((next: Localization | ((cur: Localization) => Localization)) => {
    s.update((d) => {
      const cur = effectiveLocalization(d as SurveyDefinition);
      d.localization = typeof next === "function" ? next(cur) : next;
    });
  }, [s]);
  return { s, loc, setLoc };
}

let cachedName: string | null | undefined;
export function useEditorName(): string {
  const [name, setName] = React.useState<string>(cachedName ?? "you");
  React.useEffect(() => {
    if (cachedName !== undefined) return;
    let alive = true;
    fetch("/api/auth/me", { cache: "no-store" }).then(async (r) => {
      if (!r.ok) { cachedName = null; return; }
      const j = await r.json().catch(() => ({})) as { user?: { name?: string; email?: string }; name?: string; email?: string };
      cachedName = j.user?.name ?? j.user?.email ?? j.name ?? j.email ?? null;
      if (alive && cachedName) setName(cachedName);
    }).catch(() => { cachedName = null; });
    return () => { alive = false; };
  }, []);
  return name;
}

export const STATUS_LABEL: Record<string, string> = {
  not_translated: "Not translated", ai: "Machine translated", edited: "Manually edited", reviewed: "Reviewed", approved: "Approved", outdated: "Outdated",
};
export const STATUS_COLOR: Record<string, string> = {
  not_translated: "#94a3b8", ai: "#7c3aed", edited: "#0369a1", reviewed: "#b45309", approved: "#15803d", outdated: "#b91c1c",
};

/** the project a translation request belongs to — it decides whose provider (the project's choice, else the person's own, else the platform's) */
export const withSurvey = (path: string, surveyDbId: unknown) => (typeof surveyDbId === "string" && surveyDbId ? `${path}?surveyId=${encodeURIComponent(surveyDbId)}` : path);

export interface ProviderStatus {
  provider: { id: string | null; name: string; connected: boolean; via?: "user" | "platform"; refused?: { code: string; message: string } };
  candidates: { google: boolean; ai: boolean; fake: boolean };
  cache: { backend: "database" | "memory" };
  pinned: string | null;
}

/** The translation provider the server has — Google, the AI model, the fake one, or none. Never the key. */
export function useProviderStatus(): { status: ProviderStatus | null; loading: boolean; reload(): void } {
  const studio = useStudio();
  const surveyDbId = studio.surveyDbId;
  const [status, setStatus] = React.useState<ProviderStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(withSurvey("/api/translation/status", surveyDbId), { cache: "no-store" }).then(async (r) => {
      const j = await r.json().catch(() => null) as ProviderStatus | null;
      if (alive) setStatus(j && j.provider ? j : { provider: { id: null, name: "None", connected: false }, candidates: { google: false, ai: false, fake: false }, cache: { backend: "memory" }, pinned: null });
    }).catch(() => { if (alive) setStatus({ provider: { id: null, name: "None", connected: false }, candidates: { google: false, ai: false, fake: false }, cache: { backend: "memory" }, pinned: null }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tick, surveyDbId]);
  return { status, loading, reload: () => setTick((t) => t + 1) };
}

export const PROVIDER_NAMES: Record<string, string> = { google: "Google Cloud Translation", llm: "AI language model", fake: "Fake provider (testing)", deepl: "DeepL (your own key)", azure: "Microsoft Azure Translator (your own key)", "llm-own": "Your AI model" };

export const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");

/** Download a Blob as a file from the browser. */
export function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
