import { variantCatalogue, variantCatalogueText } from "@rescript/engine";

/**
 * THE VARIANT CATALOGUE GUIDE (S2b item 2, 2026-10-30; audit D16, AQ-16, IM-04).
 *
 * The copilot's system prompt is at its cap and names a handful of question types; the 173 variants, their purpose
 * and the settings an action may set live in the engine's capability registry (`capabilityRegistry.ts`). This guide
 * is rendered from it, and only when a turn needs it: the sentence names an interaction (hotspot, swipe, quiz,
 * map, video, heatmap, card, slider, NPS, timer, annotation, signature …) or the selected question is one of the
 * interactive variants. Then it carries the named families in full (id, base type, purpose, settings with type and
 * limits) and a one-line index of the rest — never the whole 34k-character catalogue.
 *
 * `guideSelect.ts` re-exports the selection; `copilotUserPrompt` adds the text.
 */

/** the words that name an interaction → the variant families that implement it */
export const INTERACTION_WORDS: readonly [RegExp, readonly string[]][] = [
  [/\bhot-?spots?\b|\bheat-?maps?\b|\bclick (?:on|in) (?:the |an )?(?:image|picture|area)\b|\bregions? of (?:the|an) image\b/i, ["hotspot"]],
  [/\bswip\w*|\btinder\b|\bgesture\b/i, ["swipe"]],
  [/\bquiz\w*|\bgamif\w*|\btimers?\b|\bcountdown\b|\btimed\b|\breaction time\b|\bpoints per\b/i, ["gamified"]],
  [/\bmaps?\b|\blocation\b|\bgeo\w*|\bpin (?:on|the)\b|\baddress\b/i, ["location"]],
  [/\bvideos?\b|\baudio\b|\bclips?\b|\bwatch\w*|\btimeline\b/i, ["media", "qualitative"]],
  [/\bcards?\b|\bcard sort\w*/i, ["card", "swipe"]],
  [/\bsliders?\b|\bscale\b|\bstar(?:s| rating)\b|\bemoji\b|\bhearts?\b|\brating\b/i, ["slider", "single_select"]],
  [/\bnps\b|\bnet promoter\b/i, ["single_select"]],
  [/\bannotat\w*|\bdraw\w*|\bpen\b|\bhighlight (?:on|the) image\b/i, ["image", "hotspot"]],
  [/\bsignatures?\b|\buploads?\b|\bfile\b|\bphoto upload\b/i, ["upload"]],
  [/\bdrag\w*|\bdrop\b|\bsort\w*\b/i, ["dragdrop", "ranking"]],
  [/\brank\w*/i, ["ranking"]],
  [/\bcarousel\b/i, ["carousel"]],
  [/\bdate\b|\bcalendar\b|\btime ?slots?\b|\bdate picker\b/i, ["datetime"]],
  [/\bmatri(?:x|ces)\b|\bgrids?\b/i, ["matrix"]],
  [/\bconstant sum\b|\ballocat\w*|\bdistribute \d+\b/i, ["allocation"]],
  [/\bcompar\w*|\bpairwise\b|\bhead[- ]to[- ]head\b/i, ["comparison"]],
  [/\bchat\w*|\bconversational\b/i, ["conversational"]],
  [/\battention check\b|\bimplicit\b|\bexperiment\w*|\ba\/b\b/i, ["experimental"]],
  [/\bimages?\b|\bpictures?\b|\bphotos?\b|\blogos?\b|\bstimul\w*|\bpack ?shots?\b/i, ["image", "content"]],
  [/\binteractive\b|\binteraction\b|\bwidget\b/i, ["hotspot", "swipe", "dragdrop", "card"]],
];

/** families whose variants ARE interactions — a selected question of one of these sends the guide by itself */
const INTERACTIVE_FAMILIES = new Set(["hotspot", "swipe", "gamified", "location", "media", "qualitative", "card", "slider", "image", "upload", "dragdrop", "ranking", "carousel", "datetime", "allocation", "comparison", "conversational", "experimental"]);

/** the variant families a request (and the selected question's variant) names; [] = no guide */
export function variantFamiliesNamed(message: string, selectedVariant?: string | null): string[] {
  const text = String(message ?? "").slice(0, 4000);
  const out = new Set<string>();
  for (const [re, fams] of INTERACTION_WORDS) if (re.test(text)) for (const f of fams) out.add(f);
  // a variant named by its id ("gamified.timed") or its family's own key
  for (const m of text.matchAll(/\b([a-z_]+)\.[a-z_]+\b/g)) if (variantCatalogue().some((v) => v.family === m[1])) out.add(m[1]);
  const sel = selectedVariant ? variantCatalogue().find((v) => v.id === selectedVariant) : undefined;
  if (sel && (INTERACTIVE_FAMILIES.has(sel.family) || out.size)) out.add(sel.family);
  return [...out].slice(0, 6);
}

/** the guide for those families: the rules, their variants in full, and an index of every other family */
export function variantGuide(families: readonly string[]): string {
  const all = variantCatalogue();
  const fams = [...new Set(all.map((v) => v.family))];
  const named = families.filter((f) => fams.includes(f));
  const lines = [
    `QUESTION VARIANTS (from the capability registry) — create_question / update_question take "type": <variant id> and "settings": {<key>: value} with ONLY the keys listed for that variant (type and limits shown; every variant also takes validationPosition above|below). An undeclared key is refused with the variant's list. The stimulus (image / video / audio, alt text, watch-to-continue) and option images are set_question_media, not settings: {"op":"set_question_media","target":"Q3","items":[{"url":"https://…","alt":"…"}],"requireComplete":true (media variants only),"options":[{"option":1,"imageUrl":"https://…"}]} — https or /api/media/… only. Prefer a variant's own setting to a script.`,
    variantCatalogueText({ families: named }).replace(/; validationPosition:enum above\|below\]/g, "]").replace(/ \[validationPosition:enum above\|below\]/g, ""),
    `OTHER FAMILIES (ids only): ${fams.filter((f) => !named.includes(f)).map((f) => `${f}: ${all.filter((v) => v.family === f).map((v) => v.id.slice(f.length + 1)).join(" ")}`).join(" · ")}`,
  ];
  return lines.join("\n");
}

/** the guide text a turn needs, or null when the request names no interaction */
export function variantGuideFor(message: string, selectedVariant?: string | null): string | null {
  const f = variantFamiliesNamed(message, selectedVariant);
  return f.length ? variantGuide(f) : null;
}
