import type { FlowNode, PanelConfig, PanelOutcome, PanelPresetId, SurveyDefinition } from "@rescript/schema";
import { PANEL_PRESETS, PANEL_OUTCOME_LABELS, capturePanelEntry, outcomeForSurveyEnd, panelConfigProblems, panelRedirect } from "./panels.js";

/**
 * SAMPLE VENDORS FROM THEIR FOUR REDIRECT LINKS (2026-11-11).
 *
 * A vendor is a panel config on `def.panels` (integrations.ts) — the same record the Panels tab, the runtime's
 * entry check and the reconciliation export already use. This file is what turns "here are the four links the
 * vendor sent me" into that record without the researcher touching Survey Flow, and what makes several vendors
 * live side by side:
 *
 *   readVendorUrls      four pasted links → which is complete / screen-out / quota full / quality termination, the
 *                       parameter that carries the respondent's id, the parameters that must be kept as written.
 *                       Evidence for each reading; anything it cannot tell is a QUESTION, never a guess.
 *   vendorKey           a code no other vendor on the study has (it travels as `rp=<code>` on the entry link)
 *   findVendor          is this one already configured? (adding and updating are different requests)
 *   vendorOf            which vendor a respondent came from, from the survey's own embedded data
 *   vendorExit          the redirect for THIS respondent's vendor at an end of the survey — the flow engine calls it
 *                       at every exit, so a vendor's links are used only for that vendor's respondents
 *   simulateVendorExits every vendor × every outcome, resolved the way the flow resolves it
 *   checkVendors        the validation a launch waits for
 *   vendorsUntouched    proof that adding one vendor changed no other vendor, no end and no quota action
 *
 * Nothing here does I/O or knows a secret. A vendor that signs its end links keeps using the runtime's signed
 * exit (`/api/panel/exit`), which opens the secret on the server.
 */

/** the four end links every vendor gives */
export const VENDOR_OUTCOMES = ["complete", "screenout", "quota_full", "terminate"] as const;
export type VendorOutcome = (typeof VENDOR_OUTCOMES)[number];
export const VENDOR_OUTCOME_WORDS: Record<VendorOutcome, string> = { complete: "Complete", screenout: "Screened out", quota_full: "Quota full", terminate: "Quality check / termination" };
/** the URL parameter that carries the vendor code on the entry link (panels.ts `capturePanelEntry`) */
export const VENDOR_SOURCE_PARAM = "rp";

export interface VendorUrlReading {
  /** as pasted */
  url: string;
  outcome: VendorOutcome | null;
  /** why: "labelled “Complete”", "the address says “quotafull”", "matches Dynata's rst=3" … */
  evidence: string;
  /** certain: a label, a preset match or an unambiguous word. inferred: the one outcome left for a “term” link */
  confidence: "certain" | "inferred" | "unknown";
  /** the link as a template: the respondent's id as {{pid}}, other placeholders by their own parameter name */
  template: string;
  /** the parameter that returns the respondent's id on this link (null: none found) */
  idParam: string | null;
  /** placeholders other than the id — captured from the entry link under the same name and sent back */
  kept: string[];
  /** parameters sent exactly as written (status codes, project ids) */
  fixed: { param: string; value: string }[];
}

export interface VendorReading {
  urls: VendorUrlReading[];
  redirects: Partial<Record<VendorOutcome, string>>;
  /** the parameter the respondent's id arrives in and is returned in */
  idParam: string | null;
  kept: string[];
  preset: PanelPresetId;
  /** what must be answered before anything can be configured — empty when the reading is complete */
  questions: string[];
  /** things worth saying that do not block */
  notes: string[];
  /** a name from the links' host, when the request gave none */
  hostName: string | null;
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const trimUrl = (u: string) => u.replace(/[),.;:!?]+$/, "");

/** a value that stands for something the vendor fills in: [ID], {{pid}}, %RID%, ${id}, <id>, XXXX, an empty value */
const PLACEHOLDER = /^(?:\[[^\]]*\]|\{\{?[^}]*\}?\}|<[^>]*>|%[^%&=]+%|\$\{[^}]*\}|\$[A-Za-z_]+\$?|x{3,}|#{2,}|_{3,})$/i;
const ID_NAME = /^(?:pid|rid|uid|psid|sid|tid|gid|id|resp(?:ondent)?_?id|panell?ist_?id|participant_?id|member_?id|user_?id|transaction_?id|token|guid|identifier|respondent|participant)$/i;
function isPlaceholder(param: string, value: string): boolean {
  if (value === "" || PLACEHOLDER.test(value)) return true;
  if (!/^[A-Za-z_]+$/.test(value)) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  return value === value.toUpperCase() && (norm(value) === norm(param) || ID_NAME.test(value));
}

interface Parsed { base: string; pairs: { param: string; value: string }[]; host: string; path: string }
function parseLink(raw: string): Parsed | null {
  const noHash = raw.split("#")[0];
  const q = noHash.indexOf("?");
  const base = q >= 0 ? noHash.slice(0, q) : noHash;
  const m = /^https?:\/\/([^/]+)(\/.*)?$/i.exec(base);
  if (!m) return null;
  const pairs = q >= 0 ? noHash.slice(q + 1).split("&").filter(Boolean).map((p) => { const i = p.indexOf("="); return i < 0 ? { param: p, value: "" } : { param: p.slice(0, i), value: p.slice(i + 1) }; }) : [];
  return { base, pairs, host: m[1].toLowerCase(), path: m[2] ?? "/" };
}

const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

type Hit = { outcome: VendorOutcome | "term"; word: string };
/** the outcomes a link's own words point at (the host is not read: a vendor called "completeresearch" says nothing) */
function wordHits(p: Parsed): Hit[] {
  const text = `${p.path} ${p.pairs.filter((x) => !isPlaceholder(x.param, decode(x.value))).map((x) => `${x.param} ${decode(x.value)}`).join(" ")}`.toLowerCase();
  const hits: Hit[] = [];
  const find = (re: RegExp, outcome: VendorOutcome | "term") => { const m = re.exec(text); if (m) hits.push({ outcome, word: m[0] }); };
  find(/quality|security|fraud|speeder|duplicate|\bqc\b|\bqt\b|qterm|qualterm|badresp|invalid|reject/, "terminate");
  find(/over[\s_-]?quota|quota[\s_-]?full|quota|\bqf\b|\boq\b/, "quota_full");
  find(/screen[\s_-]?out|screened|screener|disqual\w*|not[\s_-]?qualif\w*|unqualif\w*|ineligible|\bdq\b|\bnq\b|\bso\b/, "screenout");
  if (!hits.some((h) => h.outcome === "screenout")) find(/complet\w*|success\w*|finish\w*|\bqualified\b|\bcomp\b/, "complete");
  find(/terminat\w*|\bterm\b/, "term");
  return hits;
}
/** one reading from the hits — a word every link shares (a folder called /complete/) says nothing about any of them */
function wordsOutcome(hits: Hit[], shared: Set<string>): { outcome: VendorOutcome | "term" | null; word: string } {
  const own = hits.filter((h) => !shared.has(h.outcome));
  const firm = own.filter((h) => h.outcome !== "term");
  if (firm.length === 1) return firm[0];
  if (!firm.length && own.length === 1) return own[0];
  return { outcome: null, word: own.map((h) => h.word).join(" / ") };
}

/** host + path + the fixed parameters: what makes one end link different from another */
const signature = (p: Parsed, idParam: string | null) => `${p.host}${p.path.replace(/\/+$/, "")}?${p.pairs.filter((x) => x.param !== idParam && !isPlaceholder(x.param, decode(x.value))).map((x) => `${x.param.toLowerCase()}=${decode(x.value).toLowerCase()}`).sort().join("&")}`;

/** a pasted link that is one of a known panel's documented end links (panels.ts presets) */
function presetOutcome(p: Parsed, idParam: string | null): { preset: PanelPresetId; outcome: VendorOutcome } | null {
  const sig = signature(p, idParam);
  for (const preset of Object.values(PANEL_PRESETS)) {
    for (const o of VENDOR_OUTCOMES) {
      const t = preset.base.redirects[o];
      if (!t || /\{\{\s*code\s*\}\}/.test(t)) continue;
      const tp = parseLink(t.replace(/\{\{\s*[A-Za-z_][\w.-]*\s*\}\}/g, "[X]"));
      if (tp && signature(tp, null) === sig) return { preset: preset.id, outcome: o };
    }
  }
  return null;
}
function presetOfHost(host: string): PanelPresetId {
  for (const preset of Object.values(PANEL_PRESETS)) {
    for (const t of Object.values(preset.base.redirects)) { const tp = t ? parseLink(t.replace(/\{\{[^}]*\}\}/g, "X")) : null; if (tp && tp.host === host) return preset.id; }
  }
  return "custom";
}

const LABELS: [RegExp, VendorOutcome | "term"][] = [
  [/quality|security|\bqc\b|fraud|data[\s-]?quality/i, "terminate"],
  [/over[\s-]?quota|quota/i, "quota_full"],
  [/screen|disqual|not[\s-]?qualif|\bdq\b/i, "screenout"],
  [/complet|success/i, "complete"],
  [/terminat|\bterm\b/i, "term"],
];
/** the words written just before a link ("Complete: https://…", "quota full link - https://…") */
function labelBefore(text: string): { outcome: VendorOutcome | "term"; label: string } | null {
  const tail = text.replace(/\s+/g, " ").slice(-80).replace(/[\s:=–—>-]+$/, "");
  /* the label is the last few words; anything up to "…with these links" / "…are below" is the sentence, not a label */
  const words = tail.split(/[.;,(:]/).pop()!.replace(/^.*\b(?:with|these|those|following|here|are|below|is|and|then)\b/i, "").trim().replace(/\s*\b(?:redirects?|links?|urls?|address(?:es)?)\b\s*$/i, "").trim();
  const last = words.split(/\s+/).filter(Boolean).slice(-4).join(" ");
  if (!last) return null;
  for (const [re, outcome] of LABELS) if (re.test(last)) return { outcome, label: last };
  return null;
}

/** "samplehub.io" → "Samplehub" */
function nameFromHost(host: string): string | null {
  const parts = host.replace(/:\d+$/, "").split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const twoPart = /^(?:co|com|org|net|ac|gov)$/.test(parts[parts.length - 2]) && parts.length > 2;
  const core = parts[parts.length - (twoPart ? 3 : 2)];
  return core ? core.charAt(0).toUpperCase() + core.slice(1) : null;
}

export interface VendorUrlInput { url: string; /** the outcome the researcher (or the model) named for it */ outcome?: VendorOutcome | null; label?: string }

/** the links in a piece of text, each with the outcome its label names (if it has one) */
export function vendorUrlsIn(text: string): VendorUrlInput[] {
  const out: VendorUrlInput[] = [];
  const s = String(text ?? "");
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    const lab = labelBefore(s.slice(last, m.index));
    out.push({ url, ...(lab && lab.outcome !== "term" ? { outcome: lab.outcome, label: lab.label } : lab ? { label: lab.label } : {}) });
    last = (m.index ?? 0) + m[0].length;
  }
  return out;
}

/**
 * Read a vendor's end links. Certain readings are stated with their evidence; anything else is a question for
 * the researcher — a link is never given an outcome because it was pasted second.
 */
export function readVendorUrls(input: VendorUrlInput[], opts: { idParam?: string | null } = {}): VendorReading {
  const questions: string[] = [];
  const notes: string[] = [];
  const urls: VendorUrlReading[] = [];
  let preset: PanelPresetId = "custom";
  const hosts = new Set<string>();
  const allHits = input.map((i) => { const p = parseLink(i.url.trim()); return p ? wordHits(p) : []; });
  const shared = new Set<string>(allHits.length > 1 ? (["complete", "screenout", "quota_full", "terminate", "term"] as const).filter((o) => allHits.every((h) => h.some((x) => x.outcome === o))) : []);

  for (const item of input) {
    const raw = item.url.trim();
    const p = parseLink(raw);
    if (!p) { questions.push(`“${raw.slice(0, 80)}” is not a web address — please paste the link again.`); continue; }
    if (!/^https:\/\//i.test(raw)) { questions.push(`${raw.slice(0, 80)} is not an https link. Respondents are only sent to https addresses — ask the vendor for the https version.`); continue; }
    hosts.add(p.host);
    const holders = p.pairs.filter((x) => isPlaceholder(x.param, decode(x.value)));
    const idPair = holders.find((x) => ID_NAME.test(x.param)) ?? holders[0] ?? null;
    let template: string;
    let idParam: string | null = idPair?.param ?? null;
    const kept = holders.filter((x) => x !== idPair).map((x) => x.param);
    if (idPair) {
      template = `${p.base}?${p.pairs.map((x) => (x === idPair ? `${x.param}={{pid}}` : holders.includes(x) ? `${x.param}={{${x.param}}}` : `${x.param}=${x.value}`)).join("&")}`;
    } else {
      /* the id as a path segment: …/complete/[RID] */
      const seg = /(\[[^\]/]+\]|\{\{?[^}/]+\}?\}|%[A-Za-z_]+%)/.exec(p.path);
      template = seg ? raw.replace(seg[0], "{{pid}}") : raw;
      if (seg) idParam = seg[0].replace(/[^A-Za-z0-9_]/g, "") || "pid";
    }
    const fixed = p.pairs.filter((x) => !holders.includes(x)).map((x) => ({ param: x.param, value: decode(x.value) }));
    const known = presetOutcome(p, idPair?.param ?? null);
    if (known) preset = known.preset; else if (preset === "custom") preset = presetOfHost(p.host);
    const said = wordsOutcome(wordHits(p), shared);
    let outcome: VendorOutcome | null = null, evidence = "", confidence: VendorUrlReading["confidence"] = "unknown";
    if (item.outcome) { outcome = item.outcome; evidence = item.label ? `labelled “${item.label}”` : "as you named it"; confidence = "certain"; }
    else if (known) { outcome = known.outcome; evidence = `one of ${PANEL_PRESETS[known.preset].label}'s documented end links`; confidence = "certain"; }
    else if (said.outcome && said.outcome !== "term") { outcome = said.outcome; evidence = `the address says “${said.word}”`; confidence = "certain"; }
    else if (said.outcome === "term" || item.label) evidence = `term:${said.word || item.label}`;
    else if (said.word) evidence = `mixed:${said.word}`;
    urls.push({ url: raw, outcome, evidence, confidence, template, idParam, kept, fixed });
  }

  /* a “term” link is a screen-out or a quality termination: it is whichever of the two no other link claims */
  for (const u of urls.filter((x) => !x.outcome && x.evidence.startsWith("term:"))) {
    const word = u.evidence.slice(5);
    const free = (["screenout", "terminate"] as const).filter((o) => !urls.some((x) => x.outcome === o));
    const others = urls.filter((x) => x !== u && !x.outcome).length;
    if (free.length === 1 && !others) { u.outcome = free[0]; u.confidence = "inferred"; u.evidence = `it says “${word}”, and the ${VENDOR_OUTCOME_WORDS[free[0] === "screenout" ? "terminate" : "screenout"].toLowerCase()} link is another one`; }
    else u.evidence = `it says “${word}”, which could be a screen-out or a quality termination`;
  }
  for (const u of urls) if (!u.outcome && u.evidence.startsWith("mixed:")) u.evidence = `the address mentions ${u.evidence.slice(6)}`;

  /* duplicates and conflicts */
  const seen = new Map<string, number>();
  urls.forEach((u, i) => { const k = u.url.toLowerCase(); if (seen.has(k)) questions.push(`Link ${i + 1} is the same address as link ${seen.get(k)! + 1}. Each outcome normally has its own link — is that intended, and which outcome is each for?`); else seen.set(k, i); });
  for (const o of VENDOR_OUTCOMES) {
    const same = urls.filter((u) => u.outcome === o);
    if (same.length > 1 && new Set(same.map((u) => u.url.toLowerCase())).size > 1) questions.push(`${same.length} links read as “${VENDOR_OUTCOME_WORDS[o]}” (${same.map((u) => u.url.slice(0, 70)).join(" and ")}). Which one is it?`);
  }
  const unknown = urls.filter((u) => !u.outcome);
  if (unknown.length) questions.push(`I cannot tell what ${unknown.length === 1 ? "this link is" : "these links are"} for: ${unknown.map((u) => `${u.url.slice(0, 90)}${u.evidence ? ` (${u.evidence})` : ""}`).join("; ")}. Tell me the outcome of each: complete, screened out, quota full, or quality check / termination.`);
  const redirects: Partial<Record<VendorOutcome, string>> = {};
  for (const u of urls) if (u.outcome && !redirects[u.outcome]) redirects[u.outcome] = u.template;
  const missing = VENDOR_OUTCOMES.filter((o) => !redirects[o]);
  if (missing.length && !unknown.length && urls.length) questions.push(`There is no ${missing.map((o) => VENDOR_OUTCOME_WORDS[o].toLowerCase()).join(", no ")} link. Paste ${missing.length === 1 ? "it" : "them"}, or say which of the other links to use for ${missing.length === 1 ? "it" : "them"}.`);
  if (!urls.length && !questions.length) questions.push("Paste the vendor's four redirect links: complete, screened out, quota full, and quality check / termination.");

  /* the respondent's id */
  const ids = [...new Set(urls.map((u) => u.idParam).filter((x): x is string => !!x))];
  const idParam = opts.idParam?.trim() || urls.find((u) => u.outcome === "complete")?.idParam || ids[0] || null;
  const codeOnly = preset === "prolific" || preset === "mturk" || preset === "cloudresearch";
  if (!idParam && urls.length && !codeOnly) questions.push("None of the links has a place for the respondent's id (something like rid=[ID]). Without it the vendor cannot tell who finished. Which parameter should carry the id — or does this vendor not need one?");
  else if (!codeOnly) {
    const without = urls.filter((u) => u.outcome && !u.idParam);
    if (without.length) notes.push(`${without.map((u) => VENDOR_OUTCOME_WORDS[u.outcome!]).join(", ")}: this link has no place for the respondent's id, so it is sent as written.`);
    if (ids.length > 1) notes.push(`The links return the id under different names (${ids.join(", ")}); each is filled as its own link writes it.`);
  }
  if (hosts.size > 1) notes.push(`The links point at ${hosts.size} different sites (${[...hosts].join(", ")}) — check they are all this vendor's.`);
  const kept = [...new Set(urls.flatMap((u) => u.kept))];
  return { urls, redirects, idParam, kept, preset, questions, notes, hostName: hosts.size ? nameFromHost([...hosts][0]) : null };
}

/* ------------------------------------------------------------ codes and names */

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "vendor";

/** a vendor code no vendor on the study has: the name as a slug, numbered when taken */
export function vendorKey(def: Pick<SurveyDefinition, "panels">, name: string): string {
  const taken = new Set((def.panels ?? []).map((p) => p.key));
  const base = slug(name);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

const endSig = (template: string): string | null => { const p = parseLink(String(template ?? "").replace(/\{\{[^}]*\}\}/g, "X")); return p ? `${p.host}${p.path.replace(/\/+$/, "")}` : null; };

/** the vendor already on the study that this request is about: by code, by name, or by the same end links */
export function findVendor(def: Pick<SurveyDefinition, "panels">, q: { key?: string | null; name?: string | null; redirects?: Partial<Record<VendorOutcome, string>> }): PanelConfig | null {
  const panels = def.panels ?? [];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (q.key) { const hit = panels.find((p) => p.key === q.key!.toLowerCase()); if (hit) return hit; }
  if (q.name) { const n = norm(q.name); const hit = n ? panels.find((p) => norm(p.label) === n || norm(p.key) === n) : undefined; if (hit) return hit; }
  const complete = q.redirects?.complete;
  if (complete) { const hit = panels.find((p) => p.redirects.complete && p.redirects.complete.replace(/\s+/g, "") === complete.replace(/\s+/g, "")); if (hit) return hit; }
  return null;
}

/* ------------------------------------------------------------ whose respondent is this */

const forSurvey = (def: Pick<SurveyDefinition, "panels">): PanelConfig[] => (def.panels ?? []).filter((p) => p.targets.includes("survey"));

/**
 * The vendor a respondent came from — by the vendor code on the link (`rp`), else by a vendor's id parameter being
 * present. Unlike the entry check, one configured vendor is NOT assumed for somebody who carries neither: a
 * colleague opening the plain link is not that vendor's respondent.
 */
export function vendorOf(def: Pick<SurveyDefinition, "panels">, embedded: Record<string, unknown> | null | undefined): { panel: PanelConfig; pid: string; captured: Record<string, string> } | null {
  const panels = forSurvey(def);
  if (!panels.length || !embedded) return null;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(embedded)) if (v != null && v !== "") params[k] = String(v);
  const rp = params[VENDOR_SOURCE_PARAM]?.toLowerCase();
  if (!(rp && panels.some((p) => p.key === rp)) && !panels.some((p) => params[p.idParam] !== undefined)) return null;
  const got = capturePanelEntry(panels, params, "survey");
  if (!got.panel) return null;
  if (!got.ok) return { panel: got.panel, pid: "", captured: {} };
  return { panel: got.panel, pid: got.pid, captured: got.captured };
}

/** an address that is some vendor's end link (or the runtime's signed exit) — the only redirects a vendor exit replaces */
export function isVendorLink(def: Pick<SurveyDefinition, "panels">, url: string | null | undefined): PanelConfig | "exit" | null {
  const u = String(url ?? "").trim();
  if (!u) return null;
  if (/\/api\/panel\/exit\b/.test(u)) return "exit";
  const sig = endSig(u);
  if (!sig) return null;
  for (const p of def.panels ?? []) for (const t of Object.values(p.redirects)) if (t && endSig(t) === sig) return p;
  return null;
}

export interface VendorExit { url: string | undefined; vendor: string | null; outcome: PanelOutcome | null; /** what happened, for the test console */ why: string }

/**
 * THE REDIRECT AT AN END OF THE SURVEY, FOR THIS RESPONDENT'S VENDOR.
 *
 * `current` is what the survey itself says at this exit (an end's redirect, a quota's over-quota link, nothing).
 *   · nobody's vendor respondent     → `current`, untouched: everyone else leaves exactly as before
 *   · `current` is the signed exit   → `current`: the server reads the respondent's entry and signs
 *   · otherwise                      → this vendor's link for the outcome, with this respondent's id. A vendor that
 *     signs is sent through the signed exit. A vendor with no link for the outcome keeps `current` only if it is
 *     the survey's own or this vendor's — never another vendor's link.
 *
 * Called for ends, quota exits and terminating skip rules. A redirect ELEMENT in the flow, or a skip rule that
 * jumps to an address, is the survey's own routing and is not an exit: the flow does not call this for those.
 */
export function vendorExit(def: Pick<SurveyDefinition, "panels">, state: { embedded: Record<string, unknown>; sessionId?: string }, status: string | null | undefined, current?: string | null): VendorExit {
  const cur = current?.trim() ? current : undefined;
  const who = vendorOf(def, state.embedded);
  if (!who) return { url: cur, vendor: null, outcome: null, why: "not a vendor's respondent" };
  const outcome = outcomeForSurveyEnd(status);
  if (!outcome) return { url: cur, vendor: who.panel.key, outcome: null, why: "not an end" };
  const owner = isVendorLink(def, cur);
  if (owner === "exit") return { url: cur, vendor: who.panel.key, outcome, why: "the signed exit resolves the vendor on the server" };
  if (who.panel.signing.algorithm !== "none" && state.sessionId) return { url: `/api/panel/exit?r=${encodeURIComponent(state.sessionId)}`, vendor: who.panel.key, outcome, why: `${who.panel.label} signs its end links: sent through the signed exit` };
  const r = panelRedirect(who.panel, outcome, { pid: who.pid || null, captured: who.captured });
  if (r.url) return { url: r.url, vendor: who.panel.key, outcome, why: `${who.panel.label}'s ${PANEL_OUTCOME_LABELS[outcome].toLowerCase()} link` };
  /* this vendor has no usable link here: its respondent is never sent to another vendor's */
  const foreign = !!owner && owner.key !== who.panel.key;
  return { url: foreign ? undefined : cur, vendor: who.panel.key, outcome, why: r.problems[0] ?? `${who.panel.label} has no ${PANEL_OUTCOME_LABELS[outcome].toLowerCase()} link` };
}

/* ------------------------------------------------------------ what gets configured */

/** the embedded fields a vendor's respondents are recognised and sent back by */
export function vendorFields(p: Pick<PanelConfig, "idParam" | "params">): string[] {
  return [...new Set([VENDOR_SOURCE_PARAM, p.idParam, ...p.params.map((x) => x.param)])];
}

/** the parameters the vendor adds to the survey link: the vendor code, then the vendor's own macro for each value */
export function vendorLinkQuery(p: Pick<PanelConfig, "key" | "idParam" | "params" | "preset">): string {
  const macros = (PANEL_PRESETS[p.preset] ?? PANEL_PRESETS.custom).macros;
  return [`${VENDOR_SOURCE_PARAM}=${encodeURIComponent(p.key)}`, ...[p.idParam, ...p.params.map((x) => x.param)].map((n) => `${encodeURIComponent(n)}=${macros[n] ?? `[${n.toUpperCase()}]`}`)].join("&");
}
export const vendorLink = (base: string, p: Pick<PanelConfig, "key" | "idParam" | "params" | "preset">): string => `${base}${base.includes("?") ? "&" : "?"}${vendorLinkQuery(p)}`;

function walk(nodes: FlowNode[], fn: (n: FlowNode) => void): void {
  for (const n of nodes) {
    fn(n);
    const k = n as { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] };
    if (k.children) walk(k.children, fn);
    if (k.branches) for (const b of k.branches) walk(b.children, fn);
    if (k.otherwise) walk(k.otherwise, fn);
  }
}
const declaredFields = (def: Pick<SurveyDefinition, "flow">): Set<string> => { const out = new Set<string>(); walk(def.flow as FlowNode[], (n) => { if (n.type === "embedded_data") for (const f of n.fields) if (f.name) out.add(f.name); }); return out; };

/**
 * Capture a vendor's parameters as URL embedded data, in the vendor's own flow element. Only ADDS: a field that is
 * already declared anywhere is left as it is, and no other element is touched. Returns the names it added.
 */
export function declareVendorFields(def: SurveyDefinition, p: PanelConfig): string[] {
  const have = declaredFields(def);
  const missing = vendorFields(p).filter((n) => !have.has(n));
  if (!missing.length) return [];
  const id = `ed_vendor_${p.key.replace(/[^a-z0-9]/g, "_")}`;
  const own = (def.flow as FlowNode[]).find((n) => n.id === id);
  const fields = missing.map((name) => ({ name, source: "url" as const }));
  if (own && own.type === "embedded_data") own.fields.push(...fields);
  else (def.flow as FlowNode[]).unshift({ type: "embedded_data", id, title: `Vendor ${p.label} (${p.key})`, fields });
  return missing;
}

/* ------------------------------------------------------------ proof and tests */

/** everything adding a vendor must leave exactly as it was: the other vendors, every end, every quota action */
export function vendorFingerprint(def: SurveyDefinition, except?: string): string {
  const ends: unknown[] = [];
  walk(def.flow as FlowNode[], (n) => {
    if (n.type === "end") ends.push([n.id, n.status, n.redirectUrl ?? null]);
    else if (n.type === "redirect") ends.push([n.id, (n as { url?: string }).url ?? null]);
    else if (n.type === "quota_check") ends.push([n.id, n.onFull]);
    else if (n.type === "embedded_data" && n.id !== `ed_vendor_${(except ?? "").replace(/[^a-z0-9]/g, "_")}`) ends.push([n.id, n.fields]);
  });
  return JSON.stringify({
    panels: (def.panels ?? []).filter((p) => p.key !== except),
    ends,
    quotas: def.quotas.map((q) => [q.id, q.onFull]),
    skips: def.questions.map((q) => [q.id, q.skipLogic]),
  });
}
/** null when nothing else changed; otherwise what did */
export function vendorsUntouched(before: SurveyDefinition, after: SurveyDefinition, key: string): string | null {
  if (vendorFingerprint(before, key) === vendorFingerprint(after, key)) return null;
  const b = new Map((before.panels ?? []).filter((p) => p.key !== key).map((p) => [p.key, JSON.stringify(p)]));
  for (const p of (after.panels ?? []).filter((x) => x.key !== key)) if (b.get(p.key) !== JSON.stringify(p)) return `the vendor ${p.label} (${p.key}) would change`;
  if ((after.panels ?? []).filter((p) => p.key !== key).length !== b.size) return "another vendor would be removed";
  return "an end, a quota action, a skip rule or another element's embedded data would change";
}

export interface VendorSimulation { vendor: string; label: string; outcome: VendorOutcome; url: string | null; ok: boolean; problem?: string }

const END_STATUS: Record<VendorOutcome, string> = { complete: "complete", screenout: "screened", quota_full: "quota_full", terminate: "terminated" };

/** every vendor × every outcome, resolved exactly as the flow resolves it for a respondent of that vendor */
export function simulateVendorExits(def: SurveyDefinition, opts: { pid?: string; only?: string } = {}): VendorSimulation[] {
  const pid = opts.pid ?? "TEST12345";
  const out: VendorSimulation[] = [];
  const ends: Record<string, string | undefined> = {};
  walk(def.flow as FlowNode[], (n) => { if (n.type === "end" && ends[n.status] === undefined) ends[n.status] = n.redirectUrl; });
  const panels = forSurvey(def);
  for (const p of panels.filter((x) => !opts.only || x.key === opts.only)) {
    const embedded: Record<string, string> = { [VENDOR_SOURCE_PARAM]: p.key, [p.idParam]: pid };
    for (const k of p.params) embedded[k.param] = `${k.param.toUpperCase()}1`;
    for (const o of VENDOR_OUTCOMES) {
      const r = vendorExit(def, { embedded }, END_STATUS[o], ends[END_STATUS[o]]);
      const owner = r.url ? isVendorLink(def, r.url) : null;
      const ownSigs = new Set(Object.values(p.redirects).map((t) => (t ? endSig(t) : null)));
      const foreign = owner && owner !== "exit" && !ownSigs.has(endSig(r.url!)) ? owner : null;
      const carriesId = !r.url || owner === "exit" || !/\{\{\s*pid\s*\}\}/.test(p.redirects[o] ?? "") || r.url.includes(encodeURIComponent(pid));
      const problem = !r.url ? `no redirect (${r.why})` : r.vendor !== p.key ? `recognised as ${r.vendor ?? "nobody's"}` : !owner ? `the survey's own redirect is used (${r.why})` : foreign ? `goes to ${foreign.label}'s link` : !carriesId ? "the respondent's id is not on the link" : undefined;
      out.push({ vendor: p.key, label: p.label, outcome: o, url: r.url ?? null, ok: !problem, ...(problem ? { problem } : {}) });
    }
  }
  return out;
}

export interface VendorCheck { id: string; label: string; ok: boolean; detail: string }

/** the checks a vendor setup must pass before the study is launched */
export function checkVendors(def: SurveyDefinition, opts: { only?: string } = {}): { ok: boolean; checks: VendorCheck[]; simulations: VendorSimulation[] } {
  const panels = forSurvey(def);
  const scope = panels.filter((p) => !opts.only || p.key === opts.only);
  const checks: VendorCheck[] = [];
  const add = (id: string, label: string, bad: string[], good: string) => checks.push({ id, label, ok: !bad.length, detail: bad.length ? bad.join("; ") : good });
  const keys = (def.panels ?? []).map((p) => p.key);
  add("codes", "Every vendor has its own code", keys.filter((k, i) => keys.indexOf(k) !== i).map((k) => `the code ${k} is used twice`), `${keys.length} vendor code${keys.length === 1 ? "" : "s"}: ${keys.join(", ") || "none"}`);
  add("mapped", "All four outcomes have a redirect", scope.flatMap((p) => VENDOR_OUTCOMES.filter((o) => !p.redirects[o]?.trim() && !(p.showCode && p.codes[o])).map((o) => `${p.label}: no ${VENDOR_OUTCOME_WORDS[o].toLowerCase()} link`)), "complete, screened out, quota full and quality check / termination");
  add("links", "The redirect links are usable", scope.flatMap((p) => panelConfigProblems(p).filter((x) => !/completion code|no complete link/.test(x)).map((x) => `${p.label}: ${x}`)), "https, public, and only values the survey captures");
  const have = declaredFields(def);
  add("fields", "The vendor code and respondent id are captured", scope.flatMap((p) => vendorFields(p).filter((n) => !have.has(n)).map((n) => `${p.label}: ${n} is not captured from the link`)), "captured as URL embedded data");
  const simulations = simulateVendorExits(def, opts);
  add("routing", "Each outcome sends each vendor's respondents to that vendor's own link", simulations.filter((s) => !s.ok).map((s) => `${s.label}, ${VENDOR_OUTCOME_WORDS[s.outcome].toLowerCase()}: ${s.problem ?? "not this vendor's link"}`), `${simulations.length} simulated exits, each to its own vendor`);
  const shared = scope.flatMap((p) => panels.filter((x) => x.key !== p.key && x.idParam === p.idParam).map((x) => `${p.label} and ${x.label} both use ${p.idParam}`));
  add("entry", "A respondent's vendor is unambiguous", [], shared.length ? `${[...new Set(shared)].join("; ")} — told apart by ${VENDOR_SOURCE_PARAM}=<code> on each vendor's link` : `by ${VENDOR_SOURCE_PARAM}=<code>, or the vendor's own id parameter`);
  return { ok: checks.every((c) => c.ok), checks, simulations };
}
