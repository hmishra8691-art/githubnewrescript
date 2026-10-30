import type { Option, Question, SurveyDefinition } from "@rescript/schema";
import { variantRegistry } from "@rescript/schema";
import { resolveMediaUrl } from "./media.js";
import { safeHttpsUrl } from "./aiInterviewStudy.js";

/**
 * set_question_media — A QUESTION'S STIMULUS AND ITS OPTION IMAGES (S2b item 3, 2026-10-30; audit D16, AQ-05, MM2-16).
 *
 * Before this, Intelligent Mode could not put an image or a video on a question: a script cannot (the sandbox drops
 * <img>/<video> and every src — uxScriptGuard), and no action wrote `settings.mediaItems` or an option's `imageUrl`.
 * The model either wrote a refused script or HTML in the wording. This action writes exactly what the editor's media
 * panel writes:
 *
 *   items            settings.mediaItems [{id, url, alt, title}] and settings.mediaUrl = the first (every reader of the
 *                    single URL still sees one — schema), at most 10
 *   layout           settings.mediaLayout horizontal | vertical
 *   altText / decorative   settings.accessibility (what a screen reader says for the stimulus)
 *   requireComplete  watch-to-continue: only where the schema and runtime enforce it — the media variants (the
 *                    rating stays disabled / the engine refuses Next until the clip has finished); refused elsewhere
 *                    with the route (update_question type "media.video_rating" first)
 *   options          an option's imageUrl / imageAlt (OptionSpec image); null removes it
 *   clear            removes the stimulus (items, URL, layout, requireComplete)
 *
 * URLS: https (no credentials, no private host — `safeHttpsUrl`, the external-URL rule) or the survey's media library
 * (`/api/media/<id>…`), and the URL must be one the renderers can show (`resolveMediaUrl` — the same rule the editor
 * uses: a known video provider, a direct image / video, never javascript: or a non-image data:). Anything else is
 * refused with the reason. A piped address (`{{ImageURL}}`) is set in the editor, not by this action.
 */

export interface MediaItemSpec { url: string; alt?: string; title?: string }
export interface OptionImageSpec { option: string | number; imageUrl: string | null; imageAlt?: string }
export type MediaAction = {
  op: "set_question_media"; target: string;
  items?: MediaItemSpec[]; layout?: "horizontal" | "vertical"; altText?: string; decorative?: boolean;
  requireComplete?: boolean; options?: OptionImageSpec[]; clear?: boolean;
};
export const MEDIA_ACTION_OPS = ["set_question_media"] as const;

const s = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
const b = (v: unknown) => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined);

/** the gate: a wire object → the action, or why not */
export function coerceMediaAction(o: Record<string, unknown>): MediaAction | string {
  const target = s(o.target ?? o.question, 120);
  if (!target) return "set_question_media needs a target question";
  const rawItems = Array.isArray(o.items) ? o.items : Array.isArray(o.media) ? o.media : s(o.url ?? o.image ?? o.video ?? o.audio, 2000) ? [{ url: o.url ?? o.image ?? o.video ?? o.audio, alt: o.alt }] : undefined;
  const items = rawItems?.slice(0, 10).map((x) => (typeof x === "string" ? { url: x } : x && typeof x === "object" ? x as Record<string, unknown> : {})).map((x) => ({ url: s((x as Record<string, unknown>).url ?? (x as Record<string, unknown>).src, 2000) ?? "", ...(s((x as Record<string, unknown>).alt, 300) !== undefined ? { alt: s((x as Record<string, unknown>).alt, 300)! } : {}), ...(s((x as Record<string, unknown>).title, 160) ? { title: s((x as Record<string, unknown>).title, 160)! } : {}) })).filter((x) => x.url);
  const options = Array.isArray(o.options) ? o.options.slice(0, 60).map((x) => x && typeof x === "object" ? x as Record<string, unknown> : {}).map((x) => {
    const option = typeof x.option === "number" || typeof x.option === "string" ? x.option : typeof x.code === "number" || typeof x.code === "string" ? x.code : undefined;
    const url = x.imageUrl === null || x.image === null ? null : s(x.imageUrl ?? x.image ?? x.url, 2000);
    return option === undefined || url === undefined ? null : { option, imageUrl: url, ...(s(x.imageAlt ?? x.alt, 300) ? { imageAlt: s(x.imageAlt ?? x.alt, 300)! } : {}) };
  }).filter((x): x is OptionImageSpec => !!x) : undefined;
  const layout = o.layout === "horizontal" || o.layout === "vertical" ? o.layout : undefined;
  const a: MediaAction = { op: "set_question_media", target };
  if (items?.length) a.items = items;
  if (layout) a.layout = layout;
  if (s(o.altText, 300) !== undefined) a.altText = s(o.altText, 300);
  if (b(o.decorative) !== undefined) a.decorative = b(o.decorative);
  const rc = b(o.requireComplete ?? o.watchToContinue ?? o.forcedExposure);
  if (rc !== undefined) a.requireComplete = rc;
  if (options?.length) a.options = options;
  if (b(o.clear) === true || o.items === null || o.url === null) a.clear = true;
  return Object.keys(a).length > 2 ? a : "set_question_media changes nothing — give items (url, alt), options (option, imageUrl), requireComplete or clear";
}

/** why a URL cannot be a question's media, or null */
export function mediaUrlProblem(url: string): string | null {
  const u = url.trim();
  if (/\{\{/.test(u)) return `“${u.slice(0, 80)}” is a piped address — set a piped media address in the editor (Properties → Media); this action takes a fixed https address or the survey's media library`;
  if (/^\/api\/media\/[A-Za-z0-9_-]{4,}(?:\/[^\s"'<>\\]*)?$/.test(u)) return null;
  if (!/^https:\/\//i.test(u)) return `“${u.slice(0, 80)}” is not allowed — media must be an https address or the survey's media library (/api/media/…)`;
  if (!safeHttpsUrl(u)) return `“${u.slice(0, 80)}” is not allowed — no credentials in the address and no private or local hosts`;
  const r = resolveMediaUrl(u);
  if (r.kind === "unsupported") return `“${u.slice(0, 80)}” cannot be shown: ${r.reason ?? "unsupported media"}`;
  return null;
}

class MediaError extends Error {}
const fail = (m: string): never => { throw new MediaError(m); };

/** watch-to-continue is enforced on these variants (renderer media.tsx gate + engine validate.ts) */
export function supportsRequireComplete(q: Pick<Question, "variant" | "type">): boolean {
  const v = q.variant ? variantRegistry.get(q.variant) : undefined;
  return !!v && v.family === "media" && v.capabilities.length >= 0 && !/audio_recording|video_prompt_voice/.test(v.id);
}

export interface MediaEnv { question(ref: string): Question | undefined; ids(prefix: string): string }

export function applyMediaAction(def: SurveyDefinition, a: MediaAction, env: MediaEnv): { description: string; destructive?: string; warnings: string[]; touched: string[] } {
  void def;
  const q = env.question(a.target) ?? fail(`there is no question “${a.target}”`);
  const st = q.settings as Record<string, unknown> & Question["settings"];
  const done: string[] = [], lossy: string[] = [], warnings: string[] = [];
  if (a.clear) {
    const had = (st.mediaItems?.length ?? 0) || (st.mediaUrl ? 1 : 0);
    delete st.mediaItems; delete st.mediaUrl; delete st.mediaLayout;
    if (st.requireComplete) delete st.requireComplete;
    if (had) { done.push("stimulus removed"); lossy.push(`removes ${had} media item${had === 1 ? "" : "s"} from ${q.code}`); }
  }
  if (a.items?.length) {
    for (const it of a.items) { const why = mediaUrlProblem(it.url); if (why) fail(`${q.code}: ${why}`); }
    if (st.mediaItems?.length || st.mediaUrl) lossy.push(`replaces the media of ${q.code}`);
    st.mediaItems = a.items.map((it) => ({ id: env.ids("med"), url: it.url.trim(), ...(it.alt !== undefined ? { alt: it.alt } : {}), ...(it.title ? { title: it.title } : {}) }));
    st.mediaUrl = st.mediaItems[0].url;
    const kinds = a.items.map((it) => (it.url.startsWith("/api/media/") ? "library item" : resolveMediaUrl(it.url).kind));
    done.push(`stimulus: ${a.items.length === 1 ? kinds[0] : `${a.items.length} items (${kinds.join(", ")})`}`);
    if (a.items.some((it) => it.alt === undefined) && a.altText === undefined && !a.decorative) warnings.push(`${q.code}: a media item has no alt text — screen readers will read the question text instead; give alt for a stimulus that carries meaning`);
  }
  if (a.layout) { st.mediaLayout = a.layout; done.push(`layout ${a.layout}`); }
  if (a.altText !== undefined || a.decorative !== undefined) {
    st.accessibility = { ...(st.accessibility ?? {}), ...(a.altText !== undefined ? { altText: a.altText } : {}), ...(a.decorative !== undefined ? { decorative: a.decorative } : {}) };
    done.push(a.decorative ? "decorative (announced as nothing)" : `alt text “${(a.altText ?? "").slice(0, 40)}”`);
  }
  if (a.requireComplete !== undefined) {
    if (a.requireComplete && !supportsRequireComplete(q)) fail(`${q.code}: watch-to-continue exists on the media variants only (media.video_rating, media.watch_time, media.video_timeline) — the runtime holds Next there until the clip has finished; make it one first (update_question type "media.video_rating")`);
    st.requireComplete = a.requireComplete;
    done.push(a.requireComplete ? "must be watched to the end before answering" : "watch-to-continue off");
  }
  if (a.options?.length) {
    const opts = (q.options ?? []) as Option[];
    if (!opts.length) fail(`${q.code} has no options to give images`);
    for (const spec of a.options) {
      const o = opts.find((x) => String(x.code) === String(spec.option)) ?? opts.find((x) => x.label.trim().toLowerCase() === String(spec.option).trim().toLowerCase()) ?? fail(`${q.code} has no option “${spec.option}” (options: ${opts.slice(0, 12).map((x) => x.code).join(", ")})`);
      if (spec.imageUrl === null) { if (o.imageUrl) { delete o.imageUrl; delete o.imageAlt; done.push(`option ${o.code} image removed`); } continue; }
      const why = mediaUrlProblem(spec.imageUrl); if (why) fail(`${q.code} option ${o.code}: ${why}`);
      if (spec.imageUrl.startsWith("https://") && resolveMediaUrl(spec.imageUrl).kind !== "image") fail(`${q.code} option ${o.code}: an option's picture must be an image (this address is a ${resolveMediaUrl(spec.imageUrl).kind})`);
      o.imageUrl = spec.imageUrl.trim();
      if (spec.imageAlt !== undefined) o.imageAlt = spec.imageAlt;
      done.push(`option ${o.code} image`);
    }
    const v = q.variant ? variantRegistry.get(q.variant) : undefined;
    if (v && !v.capabilities.includes("images")) warnings.push(`${q.code} (${v.name}) does not draw option images — an image variant shows them (update_question type "image.choice" or "single_select.cards")`);
  }
  if (!done.length) fail(`the media of ${q.code} is already as asked`);
  return { description: `${q.code}: ${done.join(", ")}`, ...(lossy.length ? { destructive: lossy.join("; ") } : {}), warnings, touched: [q.id] };
}

export function describeMediaAction(a: MediaAction): string {
  if (a.clear && !a.items?.length) return `Remove the media of ${a.target}`;
  const what = [a.items?.length ? `${a.items.length === 1 ? "a stimulus" : `${a.items.length} media items`}` : "", a.options?.length ? "option images" : "", a.requireComplete ? "watch-to-continue" : ""].filter(Boolean).join(", ");
  return `Set the media of ${a.target}${what ? ` (${what})` : ""}`;
}
