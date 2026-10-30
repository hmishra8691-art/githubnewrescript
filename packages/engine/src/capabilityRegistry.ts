import { variantRegistry, questionSettingField, UNIVERSAL_VALIDATIONS, type QuestionVariantDef } from "@rescript/schema";
import type { UX_SCRIPT_API, UX_SCRIPT_EVENTS } from "./ux.js";

/**
 * THE JAVASCRIPT CAPABILITY REGISTRY — layer 2 of the three (S2b, 2026-10-30; audit §6, D16/D18, AQ-16, IM-04/05).
 *
 * Layer 1 is the research capability registry (`capabilities.ts`: methodologies, question types, analysis). This is
 * the layer below it, the one Intelligent Mode consults before it writes a line of script: WHAT THE PLATFORM DOES
 * NATIVELY for a need, WHAT THE SCRIPT SANDBOX CAN DO, and WHAT IT CANNOT (each with the native route). It is DATA,
 * not prose, so it can be checked:
 *
 *   NATIVE_FEATURES       validation (kinds + severity), punch, calculation, default value, display / skip logic,
 *                         randomizer (rotate, exact balance), section navigation, timers, assessments, media, the
 *                         variants and their settings, logic scripts — each with the actions that reach it
 *   SANDBOX_API           every `rs.*` method with its effect (keyed by `UX_SCRIPT_API`: a method added there and not
 *                         here fails the type check and `capabilityRegistry.test.ts`)
 *   SANDBOX_EVENTS        every `rs.listen` event (keyed by `UX_SCRIPT_EVENTS`)
 *   SANDBOX_LIMITS        no network, no storage, no layout of its own, timers ≤ 60 s, the write scope rule
 *   NATIVE_ROUTES         what a script cannot do, and the native route — the uxScriptGuard refusals read their
 *                         route text from here, so a refusal and the guide can never disagree
 *   variantCatalogue()    the 173 variants: id, base type, one-line purpose, the settings an action may set (with
 *                         type and limits read from the question schema's own field)
 *
 *   nativeRouteFor(need)  the deterministic answer to "how is this done here?" — used by the gate's refusals and by
 *                         the script explanations (`scriptExplain.ts`)
 *   capabilityGuideText() / variantCatalogueText()  the compact renderings the copilot's guides carry
 *
 * Pure: no I/O, no model. Imports only the schema (and types from ux.ts), so the gate can import it without a cycle.
 */

/* ------------------------------------------------------------ what a script cannot do, and the native route */

export interface NativeRoute {
  id: string;
  /** what a request (or a refused script) says when it means this */
  need: RegExp;
  /** what the sandbox cannot do */
  cannot: string;
  /** the native way — the text the gate's refusal ends with */
  route: string;
  /** the actions the route names */
  actions: string[];
}

export const NATIVE_ROUTES: readonly NativeRoute[] = [
  {
    id: "press_next", need: /\b(?:click|press|trigger)\w*\b[^.]{0,40}\b(?:next|back|continue|submit)\b|\bauto-?advance\b|\bmove on (?:by itself|automatically)\b|\bcannot press next\b/i,
    cannot: "press Next or Back (.click() on the page's buttons does nothing — the script runs on a mirror of the page)",
    route: `call rs.goToPage("<page id>") or rs.goToSection("<block>"); for a question that moves on by itself when time runs out use the timed question (update_question type "gamified.timed", settings {"timeLimitSeconds": 30, "onTimeout": "advance"}); to stop the respondent use validation (set_validation)`,
    actions: ["update_question", "set_validation"],
  },
  {
    id: "choose_answer", need: /\b(?:click|tick|check|select)\w*\b[^.]{0,30}\b(?:option|radio|checkbox|input)\b|\bcannot choose an answer\b|\bfill (?:in )?(?:the |an )?answer\b|\bprefill\b|\bpre-?select\b/i,
    cannot: "choose or fill in an answer through the page (.click() / .value / .checked on the mirror change nothing)",
    route: "A starting answer is set_default_value; an answer that follows another answer is a punch rule (add_punch); a value only code can know is rs.setAnswer into a hidden variable",
    actions: ["set_default_value", "add_punch"],
  },
  {
    id: "stop_respondent", need: /\bpreventDefault\b|\b(?:disable|block|stop)\w*\b[^.]{0,30}\b(?:next|continu\w*|submit\w*|respondent)\b|\bcannot stop the respondent\b/i,
    cannot: "stop the respondent (preventDefault and a disabled Next are only looks — the script sees the event after it happened)",
    route: "give the question validation (set_validation) with its message: the survey refuses Next, shows it, and the server checks it again",
    actions: ["set_validation"],
  },
  {
    id: "inject_css", need: /<style>|document\.head|\bcannot add a? ?<(?:style|link|script)|\bkeyframes?\b[^.]{0,30}\bscript\b/i,
    cannot: "add <style>, <link> or <script> elements or write to document.head (the survey drops them)",
    route: "For CSS use create_style (scoped to the question; @keyframes allowed there); for motion use create_animation (presets: fade-in, fade-up, pop, pulse, shake, bounce, glow…) or rs.animate(target, preset); a script may still set inline styles and transitions on its own elements (el.style.transition / el.style.opacity)",
    actions: ["create_style", "create_animation"],
  },
  {
    id: "show_image", need: /\b(?:show|display|add|insert)\w*\b[^.]{0,40}\b(?:image|picture|photo|logo|video|audio|clip)\b|\bcannot show an image\b|<img\b/i,
    cannot: "create an <img> / <video> or set a src (any address set from code is dropped on the page)",
    route: `Show it natively: a content question holding the image with display logic (create_question type "descriptive" with <img src="…"> after the question, then set_display_logic, e.g. "Q1 = 2"), or the option's own image`,
    actions: ["create_question", "set_display_logic"],
  },
  {
    id: "network", need: /\b(?:fetch|xmlhttprequest|ajax|websocket|api call|call (?:an?|our|the) (?:api|endpoint|server|webhook)|webhook|send (?:the )?(?:data|answers?) to)\b/i,
    cannot: "send anything off the page (no fetch, XMLHttpRequest, WebSocket, beacon, image pixel or form post)",
    route: "keep what the script works out in the survey — rs.setEmbedded / rs.setCalc / rs.setAnswer into a hidden variable — and it leaves with the response (exports, the panel redirect's embedded data: connect_panel)",
    actions: ["create_embedded", "connect_panel"],
  },
  {
    id: "storage", need: /\b(?:localStorage|sessionStorage|indexedDB|cookies?|remember (?:it|this|the value) (?:between|across|for later))\b/i,
    cannot: "use cookies, localStorage, sessionStorage or IndexedDB",
    route: "keep a value for the rest of the survey with rs.setEmbedded (create_embedded first) or rs.setAnswer into a hidden question; a value that follows from answers is a calculation (create_calculation)",
    actions: ["create_embedded", "create_calculation"],
  },
  {
    id: "polling", need: /\bsetInterval\b|\bpoll(?:ing|s)?\b|\bkeep checking\b|\bevery \d+\s*(?:ms|milliseconds?|seconds?)\b/i,
    cannot: "poll the page (setInterval is not available; a timer that looks elements up again and again is refused)",
    route: "react to the page with rs.listen(\"answer\" | \"change\" | \"select\" | \"page\" …); a countdown re-schedules itself with rs.after(ms, fn) (at most 60 s each) and updates its own element",
    actions: [],
  },
  {
    id: "long_timer", need: /\b(?:\d{3,}|[6-9]\d)\s*(?:s|sec|secs|seconds?)\b|\b(?:\d+)\s*(?:min|mins|minutes?)\b[^.]{0,30}\b(?:timer|countdown|limit)\b|\btime limit\b/i,
    cannot: "wait more than 60 s in one step (rs.after is capped at 60,000 ms)",
    route: `the timed question: update_question type "gamified.timed", settings {"timeLimitSeconds": 1–3600, "onTimeout": "lock" | "advance"}`,
    actions: ["update_question"],
  },
  {
    id: "layout", need: /\b(?:move|reorder|rearrange)\w*\b[^.]{0,30}\b(?:questions?|pages?|sections?)\b|\b(?:two|2|three|3) columns?\b|\bput (?:Q\w+|the questions?) (?:on|onto) (?:one|the same|a new) page\b/i,
    cannot: "move questions, pages or sections, or lay the page out (it may only style and show/hide what is there)",
    route: "move_question / page_break for the order and pages; update_question settings columnsLayout (1–4) for options in columns; create_style for spacing and widths",
    actions: ["move_question", "page_break", "update_question", "create_style"],
  },
  {
    id: "skip_terminate", need: /\b(?:terminate|screen out|disqualif\w*|end the survey|skip (?:to|over)|jump to)\b/i,
    cannot: "terminate or skip by hiding questions (hidden questions still count; a script cannot end the survey)",
    route: "add_skip (to a question, a block or \"end\" / terminate) or set_display_logic; rs.goToPage / rs.goToSection only move forward on the respondent's path",
    actions: ["add_skip", "set_display_logic"],
  },
  {
    id: "global_dom", need: /\bwindow\.|\bdocument\.cookie\b|\bparent\.|\btop\.|\bpostMessage\b|\bnavigator\./i,
    cannot: "reach the window, the parent page, cookies, the navigator or postMessage",
    route: "use the rs api (rs.getAnswer, rs.getEmbedded, rs.getQuestion …) and the survey's own document",
    actions: [],
  },
];

const ROUTE_BY_ID = new Map(NATIVE_ROUTES.map((r) => [r.id, r]));
/** one route's text, by id — what uxScriptGuard's refusals end with */
export function nativeRoute(id: string): string {
  const r = ROUTE_BY_ID.get(id);
  if (!r) throw new Error(`no native route "${id}"`);
  return r.route;
}

/* ------------------------------------------------------------ native features */

export interface NativeFeature {
  id: string;
  name: string;
  /** what a request says when it needs this */
  need: RegExp;
  /** the actions that reach it (every one is in SURVEY_ACTION_OPS — checked by the test) */
  actions: string[];
  /** one line: what it does, its options and limits */
  summary: string;
}

/** every validation kind any variant offers, plus the universal four */
export function validationKinds(): string[] {
  const all = new Set<string>(UNIVERSAL_VALIDATIONS);
  for (const v of variantRegistry.all()) for (const k of v.validations) all.add(k);
  return [...all].sort();
}

export const NATIVE_FEATURES: readonly NativeFeature[] = [
  { id: "validation", name: "Validation", need: /\bvalidat\w*|\berror message\b|\bwarn(?:ing)?\b|\bmust be\b|\bat least\b|\bat most\b|\bmin(?:imum)?\b|\bmax(?:imum)?\b|\brequired\b|\bformat\b|\bexceeds?\b/i, actions: ["set_validation"],
    summary: `set_validation rules {kind, value, when, check, message, severity}: kinds ${"%KINDS%"}; severity "warning" shows the message and lets the respondent continue (soft), absent = blocking; the server re-checks every blocking rule` },
  { id: "punch", name: "Punch (auto-code)", need: /\bpunch\w*|\bauto-?(?:select|code|punch)\w*|\bcode (?:\w+ )?as\b|\bset (?:\w+ )?to \d|\bwhen\b[^.]{0,40}\bselect(?:ed)?\b[^.]{0,20}\bselect\b/i, actions: ["add_punch", "remove_punches"],
    summary: "add_punch {target, when, action select|deselect|set_value|clear, codes|value|expression, mode if|else_if|else, recompute once|always}: an answer that follows other answers — on hidden variables too" },
  { id: "calculation", name: "Calculation", need: /\bcalculat\w*|\bcompute\w*|\bsum of\b|\btotal of\b|\baverage\b|\bscore\b|\bderived?\b|\bcount (?:of|how many)\b/i, actions: ["create_calculation"],
    summary: "create_calculation {name, expression, dataType numeric|text|boolean}: the calc language (arithmetic, if(), count(), sum(), answers by code) — recomputed on every change" },
  { id: "default_value", name: "Default value / prefill", need: /\bdefault\b|\bprefill\w*|\bpre-?populat\w*|\bstart(?:ing)? (?:answer|value)\b|\burl param\w*/i, actions: ["set_default_value", "create_embedded"],
    summary: "set_default_value {target, value} — a constant or a piped \"{{name}}\" of a question, variable or embedded field (create_embedded source \"url\" for a URL parameter)" },
  { id: "display_logic", name: "Display logic", need: /\b(?:show|hide|display)\w*\b[^.]{0,40}\b(?:when|if|only|unless)\b|\bdisplay logic\b|\bvisible if\b/i, actions: ["set_display_logic", "update_option"],
    summary: "set_display_logic {target, expression} for a question; update_option visibleIf for one option; any nesting (AND / OR / NOT, counts, contains)" },
  { id: "skip_logic", name: "Skip / terminate", need: /\bskip\w*|\bterminat\w*|\bscreen out\b|\bjump\b|\bend the survey\b|\bdisqualif\w*/i, actions: ["add_skip", "clear_skips"],
    summary: "add_skip {from, when, to} — to a question, a block or end/terminate; clear_skips" },
  { id: "randomizer", name: "Randomizer", need: /\brandomi[sz]\w*|\bshuffle\w*|\brotat\w*|\bequally\b|\bevenly\b|\bbalanc\w*|\blatin square\b|\bshow (?:only )?\d+ of\b/i, actions: ["create_randomizer", "set_option_randomization", "update_question"],
    summary: "set_option_randomization {target, method shuffle|rotate|reverse_half} (rotate = each option in each position equally often); create_randomizer {blocks, show} with even presentation (exact balance: least-filled claim)" },
  { id: "section_navigation", name: "Section navigation", need: /\bsection nav\w*|\bnavigat\w*|\btable of contents\b|\bjump between sections\b|\bunanswered\b|\bprogress\b/i, actions: ["set_navigation"],
    summary: "set_navigation {sectionNav off|visited|free, position top|side}: a built-in section navigator that highlights unanswered questions" },
  { id: "timers", name: "Timers", need: /\btimers?\b|\bcountdown\b|\btime limit\b|\btimed\b|\bseconds?\b/i, actions: ["update_question"],
    summary: "update_question type \"gamified.timed\" settings {timeLimitSeconds 1–3600, onTimeout lock|advance} (single choice); a visible countdown on another type is a behaviour script ticking with rs.after (≤ 60 s per step)" },
  { id: "assessments", name: "Assessments", need: /\bquiz\w*|\bexam\w*|\btest scor\w*|\banswer key\b|\bcorrect answer\b|\bmarks?\b|\bgrad(?:e|ing)\b|\bpass mark\b/i, actions: ["set_answer_key", "set_assessment"],
    summary: "set_answer_key {target, correct, points} and set_assessment {passMark, feedback …}: scored tests computed by the engine, never written by a script" },
  { id: "variants", name: "Question variants and their settings", need: /\bvariant\b|\bslider\b|\bnps\b|\bhotspot\b|\bheat ?map\b|\bswipe\b|\bcard sort\w*|\bdrag\w*|\branking\b|\bmap\b|\bsignature\b|\bannotat\w*|\bstar rating\b|\bmatrix\b/i, actions: ["create_question", "update_question"],
    summary: "create_question / update_question with type = a variant id and settings = the keys that variant declares (see the variant catalogue)" },
  { id: "embedded", name: "Embedded data / hidden variables", need: /\bembedded\b|\bhidden (?:variable|question|field)\b|\burl param\w*|\bpanel id\b/i, actions: ["create_embedded", "update_embedded", "remove_embedded"],
    summary: "create_embedded {name, source url|static|panel|expression, value}: a value that travels with the response" },
  { id: "loops", name: "Loops", need: /\bloop\w*|\brepeat (?:for|the questions)\b|\bfor each\b/i, actions: ["create_loop"],
    summary: "create_loop {from, to, over | items, loopVar}: the same questions asked for each item" },
  { id: "popups", name: "Popups and messages", need: /\bpop-?ups?\b|\bmodal\b|\btool-?tips?\b|\bmessage when\b/i, actions: ["create_behavior"],
    summary: "create_behavior effect show_popup / show_message on select_option (closes by itself), or rs.popup / rs.closePopup in a script" },
];

/* ------------------------------------------------------------ the sandbox */

type ApiMethod = (typeof UX_SCRIPT_API)[number];
type ApiEvent = (typeof UX_SCRIPT_EVENTS)[number];

/** every rs method and its effect — a method added to UX_SCRIPT_API and not here is a type error and a failed test */
export const SANDBOX_API: Record<ApiMethod, { effect: string; write?: boolean }> = {
  listen: { effect: "rs.listen(event, target?, fn) — run fn on an event (see the events)" },
  getAnswer: { effect: "read an answer by code / variable" },
  getQuestion: { effect: "a question's card element (by code)" },
  getBlock: { effect: "a block's element" },
  getPage: { effect: "the page element" },
  addClass: { effect: "add a CSS class to a target" },
  removeClass: { effect: "remove a CSS class" },
  toggleClass: { effect: "toggle a CSS class" },
  animate: { effect: "play a motion preset (fade-in, pop, pulse, shake …)" },
  setStyle: { effect: "set inline styles on a target" },
  clearStyle: { effect: "clear the inline styles it set" },
  show: { effect: "show a target (look only — a hidden question still counts)" },
  hide: { effect: "hide a target (look only — not display logic)" },
  showMessage: { effect: "show a message under a target" },
  hideMessage: { effect: "remove that message" },
  scrollTo: { effect: "scroll to a target" },
  focus: { effect: "focus a target" },
  after: { effect: "rs.after(ms, fn) — run fn later, at most 60,000 ms" },
  log: { effect: "write to the preview's script log" },
  popup: { effect: "open the survey's own popup (title, placement center|anchored|top|inline)" },
  closePopup: { effect: "close the survey's popup" },
  goToPage: { effect: "ask to move to a page (the engine's navigation rule decides)" },
  goToSection: { effect: "ask to move to a block / section" },
  getEmbedded: { effect: "read an embedded field" },
  getCalc: { effect: "read a calculated variable" },
  setAnswer: { effect: "REQUEST an answer write — checked like the respondent's own input, within the write scope", write: true },
  setEmbedded: { effect: "REQUEST an embedded-field write", write: true },
  setCalc: { effect: "REQUEST a calculated-variable write (refused when its expression recomputes it)", write: true },
  flag: { effect: "REQUEST a session flag", write: true },
  error: { effect: "inside a \"validate\" handler: stop Next with this message" },
};

export const SANDBOX_EVENTS: Record<ApiEvent, string> = {
  answer: "an answer changed (the target's, or any)",
  change: "an input changed",
  select: "an option was selected",
  deselect: "an option was deselected",
  click: "the target was clicked",
  hover: "the pointer entered the target",
  page: "the page opened",
  complete: "the survey was completed",
  validate: "Next was pressed and built-in validation passed — rs.error(message) stops Next",
  submit: "the page is being left (after validation)",
};

export const SANDBOX_LIMITS: readonly string[] = [
  "no network: fetch, XMLHttpRequest, WebSocket, beacons, image pixels and form posts are refused",
  "no storage: cookies, localStorage, sessionStorage, IndexedDB",
  "no layout of its own: it styles, shows and hides what is on the page; it cannot add <style>/<script>/<img>, move questions or change pages",
  "timers: rs.after only, at most 60 s per call (no setInterval); loops are bounded at run time",
  "writes are requests (rs.setAnswer / setEmbedded / setCalc / flag) the engine decides: hidden, calculated and embedded targets from any script; any question the respondent is not looking at; a question-scoped script also its own question — never another question on screen",
  "runs on a mirror of the page in a sandboxed frame: .click(), .value =, preventDefault on the real page do nothing",
];

/* ------------------------------------------------------------ the variants and their settings */

/**
 * The settings an action may set on a question of a variant (S2b item 2): the keys the variant declares in the
 * registry (`defaults.settings`), the keys its capabilities imply, its family's own presentation keys, and the
 * universal ones. Keys another action owns (hidden → update_question hidden, defaultValue → set_default_value,
 * expression → create_calculation, the stimulus → set_question_media, a design → the methods actions) are not
 * settings here.
 */
const OWNED_ELSEWHERE = new Set(["hidden", "readOnly", "defaultValue", "expression", "designRef", "versionBalance", "adaptive", "mediaUrl", "mediaItems", "mediaDisplay", "imageUrl", "interviewVideo", "videos", "accessibility", "mapCenter", "swipeDirections", "scalePointLabels"]);
const UNIVERSAL_SETTINGS = ["validationPosition"];
const CAPABILITY_SETTINGS: Record<string, string[]> = {
  layout_columns: ["columnsLayout"],
  min_max_selections: ["minSelections", "maxSelections"],
  numeric_bounds: ["minValue", "maxValue", "step"],
  sum: ["sumTarget", "sumUnit"],
  search: ["optionSearch"],
  other_specify: ["otherSpecifyOptional"],
  speech_input: ["speechInput", "speechLang"],
  geo_settings: ["geoMode", "mapZoom", "allowGeolocation", "radiusMinM", "radiusMaxM", "radiusDefaultM"],
};
const FAMILY_SETTINGS: Record<string, string[]> = {
  text: ["placeholder"],
  numeric: ["decimalPlaces", "numberSign", "placeholder"],
  swipe: ["swipeButtons", "swipeResponse", "cardImagePosition", "cardAspect", "cardSize"],
  card: ["cardImagePosition", "cardAspect", "cardSize", "cardAlign"],
  carousel: ["cardImagePosition", "cardAspect"],
  datetime: ["minDate", "maxDate", "dateFormat", "minYear", "maxYear"],
  upload: ["minFiles", "maxTotalMb", "maxFiles", "maxSizeMb", "accept"],
  media: ["playerControls", "allowFullscreen", "allowVolume", "allowComment", "commentPrompt", "requireComplete"],
  hotspot: ["multiRegion", "maxSelections"],
  image: ["maxSelections"],
  conversational: ["chatDelayMs"],
  gamified: ["showFeedback", "pointsPerCorrect"],
  maxdiff: ["showItemLabels"],
  conjoint: ["showItemLabels"],
  content: ["mediaLayout"],
};
/** bounds the schema field itself does not state */
export const SETTING_BOUNDS: Record<string, [number, number]> = {
  timeLimitSeconds: [1, 3600], columnsLayout: [1, 4], minSelections: [0, 1000], maxSelections: [0, 1000], step: [0, 1_000_000],
  maxFiles: [1, 50], minFiles: [0, 50], maxSizeMb: [1, 500], maxTotalMb: [1, 2000], minRepeats: [0, 200], maxRepeats: [1, 200],
  pointsPerCorrect: [0, 1000], chatDelayMs: [0, 10_000], decimalPlaces: [0, 10], mapZoom: [1, 20], penWidth: [1, 40],
  maxRetakes: [0, 20], minAnswerSeconds: [0, 3600], maxAnswerSeconds: [1, 3600], radiusMinM: [0, 1_000_000], radiusMaxM: [0, 1_000_000], radiusDefaultM: [0, 1_000_000],
};

export interface SettingSpec { key: string; type: string; limits?: string }

/** a schema field described in a few words: its type and the limits it states */
function describeField(key: string): SettingSpec | null {
  let f = questionSettingField(key) as unknown as { _def: Record<string, unknown> } | undefined;
  if (!f) return null;
  for (let i = 0; i < 6 && f && (f._def.innerType || (f._def.typeName === "ZodEffects" && f._def.schema)); i++) f = (f._def.innerType ?? f._def.schema) as typeof f;
  const def = f!._def as { typeName?: string; values?: unknown; checks?: { kind: string; value?: number }[]; options?: { _def: { typeName?: string; values?: unknown } }[]; type?: { _def: { typeName?: string; values?: unknown } } };
  const tn = String(def.typeName ?? "").replace(/^Zod/, "").toLowerCase();
  const b = SETTING_BOUNDS[key];
  if (tn === "number") {
    const min = def.checks?.find((c) => c.kind === "min")?.value, max = def.checks?.find((c) => c.kind === "max")?.value;
    const int = def.checks?.some((c) => c.kind === "int");
    const lo = b ? b[0] : min, hi = b ? b[1] : max;
    return { key, type: int ? "integer" : "number", ...(lo !== undefined || hi !== undefined ? { limits: `${lo ?? "…"}–${hi ?? "…"}` } : {}) };
  }
  if (tn === "enum") return { key, type: "enum", limits: (def.values as string[]).join("|") };
  if (tn === "array") {
    const inner = def.type?._def;
    return { key, type: "list", ...(inner?.typeName === "ZodEnum" ? { limits: (inner.values as string[]).join("|") } : {}) };
  }
  if (tn === "union") return { key, type: "value", limits: (def.options ?? []).map((o) => (o._def.typeName === "ZodEnum" ? (o._def.values as string[]).join("|") : String(o._def.typeName ?? "").replace(/^Zod/, "").toLowerCase())).join(" or ") };
  return { key, type: tn || "value" };
}

/** the settings an action may set on a question of this variant (none for an unknown variant: universal only) */
export function settableSettings(variantId: string | null | undefined): string[] {
  const v = variantId ? variantRegistry.get(variantId) : undefined;
  const keys = new Set<string>();
  if (v) {
    for (const k of Object.keys((v.defaults as { settings?: Record<string, unknown> } | undefined)?.settings ?? {})) keys.add(k);
    for (const c of v.capabilities) for (const k of CAPABILITY_SETTINGS[c] ?? []) keys.add(k);
    for (const k of FAMILY_SETTINGS[v.family] ?? []) keys.add(k);
  }
  for (const k of UNIVERSAL_SETTINGS) keys.add(k);
  return [...keys].filter((k) => !OWNED_ELSEWHERE.has(k) && questionSettingField(k));
}

/**
 * ONE SETTING, CHECKED (the gate's rule for update_question / create_question settings): the key must be settable on
 * this variant, the value must fit the schema's own field and the registry's bounds. Returns the reason, or null.
 */
export function settingProblem(variantId: string | null | undefined, key: string, value: unknown): string | null {
  const allowed = settableSettings(variantId);
  if (!allowed.includes(key)) return `has no setting ${key} an action can set — its settings are ${allowed.join(", ")}`;
  const v = variantId ? variantRegistry.get(variantId) : undefined;
  const declared = (v?.defaults as { settings?: Record<string, unknown> } | undefined)?.settings?.[key];
  if (typeof declared === "number" && typeof value !== "number") return `${key} must be a number`;
  if (typeof declared === "boolean" && typeof value !== "boolean") return `${key} must be true or false`;
  const b = SETTING_BOUNDS[key];
  if (b && typeof value === "number" && (value < b[0] || value > b[1])) return `${key} must be between ${b[0]} and ${b[1]}`;
  const field = questionSettingField(key);
  if (field && !field.safeParse(value).success) {
    const d = describeField(key);
    return `${JSON.stringify(value)} is not a valid ${key}${d ? ` (${d.type}${d.limits ? ` ${d.limits}` : ""})` : ""}`;
  }
  return null;
}

export interface VariantEntry { id: string; family: string; baseType: string; name: string; purpose: string; settings: SettingSpec[] }

const firstSentence = (s: string) => { const t = s.replace(/\s+/g, " ").trim(); const m = t.match(/^(.{20,140}?[.!?])(?:\s|$)/); return (m ? m[1] : t.slice(0, 140)).replace(/\.$/, ""); };

/** every registered variant: id, base type, one-line purpose and the settings an action may set (type, limits) */
export function variantCatalogue(): VariantEntry[] {
  return variantRegistry.all().map((v: QuestionVariantDef) => ({
    id: v.id, family: v.family, baseType: v.baseType, name: v.name, purpose: firstSentence(v.description),
    settings: settableSettings(v.id).map((k) => describeField(k) ?? { key: k, type: "value" }),
  }));
}

/* ------------------------------------------------------------ the answer to "how is this done here?" */

export interface RouteAnswer {
  /** "native" = a native feature does it; "cannot" = a script cannot, and this is the native route */
  kind: "native" | "cannot";
  id: string;
  /** the sentence to show / append */
  route: string;
  actions: string[];
}

/**
 * THE NATIVE ROUTE FOR A NEED — deterministic: a sentence (a request, or a script refusal's text) → what does it
 * natively. A "cannot" route wins over a feature (a refusal that says "a script cannot press Next" gets the press
 * route, not "timers"). null when nothing matches.
 */
export function nativeRouteFor(need: string): RouteAnswer | null {
  const text = String(need ?? "").slice(0, 2000);
  if (!text.trim()) return null;
  const r = NATIVE_ROUTES.find((x) => x.need.test(text));
  if (r) return { kind: "cannot", id: r.id, route: `A script cannot ${r.cannot}. ${r.route.charAt(0).toUpperCase()}${r.route.slice(1)}.`, actions: r.actions };
  const f = NATIVE_FEATURES.find((x) => x.need.test(text));
  if (f) return { kind: "native", id: f.id, route: `${f.name} is native: ${featureSummary(f)}.`, actions: f.actions };
  return null;
}

const featureSummary = (f: NativeFeature) => f.summary.replace("%KINDS%", validationKinds().join(", "));

/* ------------------------------------------------------------ the renderings the guides carry */

/** the compact layer-2 text: native first, the sandbox's api, events and limits, and the routes for what it cannot */
export function capabilityGuideText(): string {
  const lines: string[] = [];
  lines.push("NATIVE FIRST — these need no script:");
  for (const f of NATIVE_FEATURES) lines.push(`- ${f.name}: ${featureSummary(f)}`);
  lines.push(`SCRIPT SANDBOX (behaviour scripts, rs.*): ${Object.entries(SANDBOX_API).map(([k, v]) => `rs.${k}${v.write ? " (write request)" : ""}`).join(", ")}.`);
  lines.push(`Events: ${Object.entries(SANDBOX_EVENTS).map(([k, v]) => `"${k}" ${v}`).join("; ")}.`);
  lines.push(`Limits: ${SANDBOX_LIMITS.join("; ")}.`);
  lines.push("A SCRIPT CANNOT — and the native route:");
  for (const r of NATIVE_ROUTES) lines.push(`- ${r.cannot} → ${r.route}`);
  return lines.join("\n");
}

/** the variant catalogue as guide text: one line per variant — id (base) purpose [settings] — optionally only some families */
export function variantCatalogueText(opts: { families?: readonly string[]; max?: number } = {}): string {
  const fam = opts.families?.length ? new Set(opts.families) : null;
  const rows = variantCatalogue().filter((v) => !fam || fam.has(v.family));
  const out = rows.slice(0, opts.max ?? rows.length).map((v) => `${v.id} (${v.baseType}) ${v.purpose}${v.settings.length ? ` [${v.settings.map((s) => `${s.key}:${s.type}${s.limits ? ` ${s.limits}` : ""}`).join("; ")}]` : ""}`);
  return out.join("\n");
}

/** the whole layer as one object (for tests, the docs and an explain card) */
export function jsCapabilityRegistry() {
  return { features: NATIVE_FEATURES, api: SANDBOX_API, events: SANDBOX_EVENTS, limits: SANDBOX_LIMITS, routes: NATIVE_ROUTES, variants: variantCatalogue(), validationKinds: validationKinds() };
}
