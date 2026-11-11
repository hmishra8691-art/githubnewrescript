import type { SurveyDefinition } from "@rescript/schema";
import { planVendor, type AddVendorAction } from "./integrationActions.js";
import { VENDOR_OUTCOMES, VENDOR_OUTCOME_WORDS, vendorUrlsIn, type VendorOutcome, type VendorUrlInput } from "./vendorSetup.js";

/**
 * "ADD VENDOR ACME: <four links>" READ WITHOUT A MODEL (2026-11-11).
 *
 * Redirect links are exact strings; a language model asked to copy four of them can drop a character, and a
 * dropped character is a respondent the vendor never gets back. So a request that pastes a vendor's links is read
 * here — the links are taken from the text as written, classified by `readVendorUrls`, and become ONE `add_vendor`
 * action that the proposal previews and the researcher applies. Anything unclear is a question with the choices
 * that answer it; each choice is a sentence this same reader understands.
 */

export interface VendorRequest {
  kind: "actions" | "clarify";
  understood: string;
  action?: AddVendorAction;
  question?: string;
  choices: { label: string; text: string }[];
  detected: { what: string; value: string }[];
  warnings: string[];
}

const VENDOR_WORD = /\b(?:vendors?|suppliers?|sample (?:providers?|sources?|partners?|vendors?)|panel (?:providers?|partners?|vendors?))\b/i;
const SETUP_VERB = /\b(?:add|new|set ?up|configure|connect|create|onboard|integrate|update|change|replace)\b/i;
const NOT_A_NAME = /^(?:redirects?|links?|urls?|configuration|config|integration|with|these|those|the|a|an|new|for|to|and|is|has|here|are|below|following|its|their|four|4|sample|as|separate|entry|called|named|complete|completes?|screen\w*|quota\w*|quality\w*|terminat\w*)$/i;

function nameIn(text: string): string | undefined {
  const m = /\b(?:vendor|supplier|provider|partner)s?\s+(?:(?:called|named|is)\s+)?["“']?([A-Za-z0-9][A-Za-z0-9 .&'_-]{0,48})/i.exec(text.replace(/https?:\/\/\S+/gi, " \u0001 "));
  if (!m) return undefined;
  const words: string[] = [];
  for (const w of m[1].split(/\s+/)) {
    if (!w || w === "\u0001" || NOT_A_NAME.test(w.replace(/[^A-Za-z0-9]/g, ""))) break;
    words.push(w);
    if (/[:,;]$/.test(w)) break;
  }
  const name = words.join(" ").replace(/["”'.,:;-]+$/, "").trim();
  return name.length >= 2 ? name.slice(0, 60) : undefined;
}

/** the request as one sentence this reader reads back exactly: every link labelled */
function sentence(verb: string, name: string, urls: { url: string; outcome: VendorOutcome }[]): string {
  return `${verb} ${name}: ${urls.map((u) => `${VENDOR_OUTCOME_WORDS[u.outcome].toLowerCase()}: ${u.url}`).join(" ")}`;
}

/** null when the sentence is not about setting up a vendor from its links */
export function interpretVendorRequest(def: SurveyDefinition, text: string): VendorRequest | null {
  const raw = String(text ?? "");
  const urls: VendorUrlInput[] = vendorUrlsIn(raw);
  const aboutVendor = VENDOR_WORD.test(raw);
  if (!urls.length) {
    if (!(aboutVendor && SETUP_VERB.test(raw)) || raw.length > 200 || /\?\s*$/.test(raw.trim()) || /^(?:how|what|why|which|can|does|do|is|are)\b/i.test(raw.trim())) return null;
    const name = nameIn(raw);
    return { kind: "clarify", understood: `Set up ${name ? `the vendor ${name}` : "a sample vendor"}.`, question: `Paste the four redirect links ${name ?? "the vendor"} gave you — complete, screened out, quota full, and quality check / termination. I will work out which is which, give the vendor its own code, and show you everything before anything is applied.`, choices: [], detected: name ? [{ what: "vendor", value: name }] : [], warnings: [] };
  }
  if (!aboutVendor && !/\bredirects?\b|\bend ?links?\b/i.test(raw) && urls.length < 3) return null;
  const name = nameIn(raw);
  const update = /\b(?:update|change|replace|edit|modify|correct)\b/i.test(raw.replace(/https?:\/\/\S+/gi, ""));
  const separate = /\b(?:separate|another|second|additional)\b[^.]{0,30}\b(?:vendor|supplier|entry)\b|\bas a new (?:vendor|entry)\b|\bkeep both\b/i.test(raw);
  const idp = /\b(?:id|respondent id) param(?:eter)?\s*(?:is|=|:)?\s*([A-Za-z_][A-Za-z0-9_.-]{0,59})/i.exec(raw)?.[1];
  const action: AddVendorAction = { op: "add_vendor", urls, ...(name ? { name } : {}), ...(idp ? { idParam: idp } : {}), ...(separate ? { mode: "new" as const } : update ? { mode: "update" as const } : {}) };
  const plan = planVendor(def, action);
  const detected = [
    ...(plan.label ? [{ what: "vendor", value: plan.label }] : []),
    ...plan.reading.urls.filter((u) => u.outcome).map((u) => ({ what: VENDOR_OUTCOME_WORDS[u.outcome!].toLowerCase(), value: `${u.url} — ${u.evidence}` })),
    ...(plan.reading.idParam ? [{ what: "respondent id", value: plan.reading.idParam }] : []),
  ];
  if (plan.ok && plan.panel) {
    return {
      kind: "actions", action, choices: [], detected: [...detected, { what: "vendor code", value: plan.key }], warnings: [],
      understood: plan.kind === "update"
        ? `Update the vendor ${plan.label} (code ${plan.key}) with these links. Only this vendor changes${plan.others.length ? `; ${plan.others.map((o) => o.label).join(", ")} stay${plan.others.length === 1 ? "s" : ""} as ${plan.others.length === 1 ? "it is" : "they are"}` : ""}.`
        : `Add ${plan.label} as a new vendor with its own code, ${plan.key}${plan.others.length ? ` — separate from ${plan.others.map((o) => o.label).join(", ")}, which ${plan.others.length === 1 ? "is" : "are"} not changed` : ""}. Review the links below, then apply.`,
    };
  }
  /* a question — with the answers that can be given in one click */
  const choices: { label: string; text: string }[] = [];
  const label = plan.label || name || "this vendor";
  if (plan.existing) {
    const all = VENDOR_OUTCOMES.map((o) => ({ outcome: o, url: plan.reading.urls.find((u) => u.outcome === o)?.url })).filter((x): x is { outcome: VendorOutcome; url: string } => !!x.url);
    choices.push({ label: `Update ${plan.existing.label} (${plan.existing.key})`, text: sentence("update vendor", plan.existing.key, all) });
    choices.push({ label: "Add as a separate vendor", text: sentence("add a separate vendor", plan.existing.label, all) });
  } else if (plan.reading.urls.length === 4 && plan.reading.urls.some((u) => !u.outcome)) {
    /* the links that ARE known keep their outcome; the rest take the outcomes left, in the order pasted */
    const left = VENDOR_OUTCOMES.filter((o) => !plan.reading.urls.some((u) => u.outcome === o));
    const unknown = plan.reading.urls.filter((u) => !u.outcome);
    if (left.length === unknown.length && left.length > 1) {
      let i = 0;
      const order = plan.reading.urls.map((u) => ({ url: u.url, outcome: u.outcome ?? left[i++] }));
      choices.push({ label: `In the order pasted: ${unknown.map((_, k) => VENDOR_OUTCOME_WORDS[left[k]].toLowerCase()).join(", ")}`, text: sentence("add vendor", label, order) });
    } else if (left.length === 1 && unknown.length === 1) {
      choices.push({ label: `It is the ${VENDOR_OUTCOME_WORDS[left[0]].toLowerCase()} link`, text: sentence("add vendor", label, plan.reading.urls.map((u) => ({ url: u.url, outcome: u.outcome ?? left[0] }))) });
    }
  }
  return { kind: "clarify", understood: `Set up the vendor ${label} from ${urls.length} link${urls.length === 1 ? "" : "s"}.`, question: plan.question ?? "I could not read these links.", choices, detected, warnings: [] };
}
