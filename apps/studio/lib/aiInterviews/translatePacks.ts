import type { AiLanguagePack, QualStudy } from "@rescript/schema";
import { buildLanguagePack, languagePackStatus, packSourceItems } from "@rescript/engine";

/**
 * AI INTERVIEWS: THE STUDY LANGUAGES' WORDING, MADE IN THE STUDIO (G1 2026-10-22). Each language without a
 * built-in or current pack is machine-translated through the Studio's metered translation door
 * (`/api/ai/translate`: the project's translation provider — Google Cloud Translation, the AI model or the
 * user's own; cached; placeholders such as {name} kept verbatim) — the guide's questions, probes, consent,
 * screener and closing; the moderator's wording and the page's labels only when not built in. What the
 * researcher already EDITED is kept unless its source changed. The result is written to the guide (and sent
 * with the launch, so the snapshot has it).
 */

export interface PackRun { packs: Record<string, AiLanguagePack>; errors: { language: string; message: string }[] }
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export async function translatePacks(study: QualStudy, languages: string[], o: { guideLanguage: string; surveyId: string; title?: string; force?: boolean; fetchImpl?: Fetch }): Promise<PackRun> {
  const out: PackRun = { packs: {}, errors: [] };
  const f = o.fetchImpl ?? ((u, i) => fetch(u, i));
  for (const lang of languages) {
    const status = languagePackStatus(study, lang, o.guideLanguage);
    const old = study.aiModeration?.translations?.[lang];
    const items = packSourceItems(study, lang);
    const keep: Record<string, string> = {};
    if (old && !o.force && !status.stale) {
      for (const [k, v] of Object.entries(old.texts ?? {})) keep[k] = v;
      for (const [k, v] of Object.entries(old.words ?? {})) keep[`w:${k}`] = v;
      for (const [k, v] of Object.entries(old.ui ?? {})) keep[`ui:${k}`] = v;
    }
    const todo = items.filter((i) => !keep[i.key]);
    const got: Record<string, string> = { ...keep };
    let provider: string | undefined;
    for (let i = 0; i < todo.length; i += 90) {
      const chunk = todo.slice(i, i + 90);
      try {
        const r = await f("/api/ai/translate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: o.surveyId, items: chunk.map((x) => ({ key: x.key, text: x.text, kind: x.kind })), sourceLanguage: o.guideLanguage, targetLanguage: lang, context: o.title ?? "AI-moderated interview" }) });
        const j = (await r.json().catch(() => ({}))) as { translations?: Record<string, string>; provider?: string; error?: { message?: string } | string };
        Object.assign(got, j.translations ?? {});
        provider ??= j.provider;
        if (!r.ok || j.error) { out.errors.push({ language: lang, message: typeof j.error === "string" ? j.error : j.error?.message ?? `translation failed (${r.status})` }); if (!Object.keys(j.translations ?? {}).length) break; }
      } catch (e) { out.errors.push({ language: lang, message: (e as Error).message }); break; }
    }
    if (Object.keys(got).length) out.packs[lang] = { ...buildLanguagePack(study, lang, got, { provider, at: new Date().toISOString(), source: old?.source === "edited" && !status.stale ? "edited" : "machine" }) };
  }
  return out;
}
