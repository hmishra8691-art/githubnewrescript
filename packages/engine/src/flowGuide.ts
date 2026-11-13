import type { SurveyDefinition, FlowNode } from "@rescript/schema";
import { validateRedirectUrl } from "./redirect.js";

/**
 * FLOW ELEMENTS, IN A RESEARCHER'S WORDS (2026-11-13) — the loop's treatment (loopGuide.ts), for the other elements
 * of the survey flow.
 *
 * A randomizer, a quota check, an end point, a redirect, a set of saved values and a branch each opened on their
 * controls and left the researcher to work out what the element would do. `flowNodePlainSummary` says it in one
 * sentence; `flowNodeChecks` says what is unfinished or wrong, with what to do about it. Both only READ the node —
 * nothing here changes what is stored or how the survey runs.
 */
export interface FlowCheck { level: "problem" | "warning" | "tip"; message: string }

type Of<T extends FlowNode["type"]> = Extract<FlowNode, { type: T }>;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[]): string => xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const emptyCondition = (c: unknown): boolean => {
  if (!c) return true;
  const g = c as { type?: string; children?: unknown[] };
  return g.type === "group" && (g.children ?? []).length === 0;
};
/** the engine's own link check (redirect.ts), so a link that starts with a saved value is not called wrong here */
const linkOk = (def: SurveyDefinition, url: string | undefined): boolean => validateRedirectUrl(url ?? "", def).ok;
const hostOf = (url: string): string | null => {
  const m = /^https?:\/\/([^/?#\s]+)/i.exec(url.trim());
  return m && m[1] ? m[1] : null;
};

export const END_STATUS_WORDS: Record<Of<"end">["status"], string> = {
  complete: "a completed interview", screened: "screened out (not eligible)", quota_full: "quota full", terminated: "terminated",
};
export const QUOTA_FULL_WORDS: Record<Of<"quota_check">["onFull"]["kind"], string> = {
  terminate: "the survey ends for them, counted as quota full",
  redirect: "they are sent to your link",
  flag: "they continue, marked as over quota",
  continue: "they continue as normal",
};
const SOURCE_WORDS: Record<string, string> = { url: "from the survey link", panel: "from the panel", static: "a fixed value", expression: "calculated" };

/** one sentence saying what this element does; null for the elements that explain themselves (blocks, groups, loops) */
export function flowNodePlainSummary(def: SurveyDefinition, node: FlowNode): string | null {
  switch (node.type) {
    case "randomizer": {
      const n = node.children.length;
      if (n === 0) return "Nothing is inside this randomizer yet.";
      const design = node.order === "latin_square" || node.order === "williams";
      const some = node.show != null && node.show < n;
      const what = some ? `Each respondent sees ${node.show} of the ${n} parts inside` : `Each respondent sees all ${plural(n, "part")} inside`;
      const how = design ? ", in a balanced order — every part appears in every position equally often"
        : node.evenPresentation ? (some ? ", chosen so every part is shown equally often" : ", in a rotating order so every part comes first equally often")
        : some ? ", picked at random" : ", in a different order each time";
      return `${what}${how}.${emptyCondition(node.visibleIf) ? "" : " It only runs when its condition is met."}`;
    }
    case "quota_check": {
      const names = node.quotaIds.map((id) => def.quotas.find((q) => q.id === id)?.name).filter((x): x is string => !!x);
      if (!names.length) return "No quota is chosen yet, so this check does nothing.";
      return `When ${list(names.map((x) => `“${x}”`))} ${names.length === 1 ? "is" : "are"} full, ${QUOTA_FULL_WORDS[node.onFull.kind]}.${emptyCondition(node.when) ? "" : " It is only checked when its condition is met."}`;
    }
    case "end": {
      const after = hostOf(node.redirectUrl ?? "");
      return `The survey ends here as ${END_STATUS_WORDS[node.status]}${node.message?.trim() ? ", showing your message" : ""}${node.redirectUrl?.trim() ? `, then the respondent is sent to ${after ?? "your link"}` : ""}.`;
    }
    case "redirect": {
      const host = hostOf(node.url);
      if (!host && linkOk(def, node.url)) return `Sends the respondent to a link held in a saved value${emptyCondition(node.when) ? "" : ", only when its condition is met"}.`;
      return host ? `Sends the respondent to ${host}${node.newWindow ? " in a new window" : ""}${emptyCondition(node.when) ? "" : ", only when its condition is met"}.` : "No link is set yet.";
    }
    case "embedded_data": {
      const named = node.fields.filter((f) => f.name.trim());
      if (!named.length) return "Saves hidden values with each response — none is set up yet.";
      const shown = named.slice(0, 4).map((f) => `${f.name} (${SOURCE_WORDS[f.source] ?? f.source})`);
      return `Saves ${plural(named.length, "hidden value")} with each response: ${list(shown)}${named.length > 4 ? ` and ${named.length - 4} more` : ""}.`;
    }
    case "branch": {
      const k = node.branches.length;
      return `Sends respondents down ${k === 1 ? "this path" : `one of ${k} paths`} when ${k === 1 ? "its" : "a path’s"} condition is met; everyone else ${(node.otherwise ?? []).length ? "takes the “otherwise” path" : "carries straight on"}.`;
    }
    default: return null;
  }
}

/** what is unfinished or wrong in this element, in plain words, with what to do */
export function flowNodeChecks(def: SurveyDefinition, node: FlowNode): FlowCheck[] {
  const out: FlowCheck[] = [];
  switch (node.type) {
    case "randomizer": {
      const n = node.children.length;
      if (n < 2) out.push({ level: "problem", message: n === 0 ? "Put at least two blocks or groups inside — drag them onto this card or use + Add element." : "Only one part is inside, so there is nothing to shuffle. Add at least one more." });
      if (node.show != null && n > 0 && node.show > n) out.push({ level: "warning", message: `It is set to show ${node.show}, but only ${n} ${n === 1 ? "part is" : "parts are"} inside — every part will be shown.` });
      if (node.show != null && node.show < 1) out.push({ level: "problem", message: "“Show” must be at least 1, or left empty to show everything." });
      break;
    }
    case "quota_check": {
      if (!def.quotas.length) out.push({ level: "problem", message: "This survey has no quotas yet. Create one in the Quotas tab, then choose it here." });
      else if (!node.quotaIds.length) out.push({ level: "problem", message: "Choose which quota to check." });
      const missing = node.quotaIds.filter((id) => !def.quotas.some((q) => q.id === id));
      if (missing.length) out.push({ level: "problem", message: `${plural(missing.length, "quota")} chosen here no longer ${missing.length === 1 ? "exists" : "exist"}. Choose again.` });
      if (node.onFull.kind === "redirect" && !linkOk(def, node.onFull.url)) out.push({ level: "problem", message: "Add the link respondents are sent to when the quota is full (it must start with https://)." });
      break;
    }
    case "end": {
      if (node.redirectUrl?.trim() && !linkOk(def, node.redirectUrl)) out.push({ level: "problem", message: `The link to send respondents to is not usable yet: ${validateRedirectUrl(node.redirectUrl, def).error ?? "check it"}.` });
      break;
    }
    case "redirect": {
      if (!linkOk(def, node.url)) out.push({ level: "problem", message: "Add the full link to send respondents to, starting with https://." });
      else out.push({ level: "tip", message: "The interview stops here: anything placed after this element is not asked." });
      break;
    }
    case "embedded_data": {
      const blank = node.fields.filter((f) => !f.name.trim()).length;
      if (blank) out.push({ level: "problem", message: `${plural(blank, "value")} ${blank === 1 ? "has" : "have"} no name yet. Give each one a name, or remove it.` });
      const seen = new Map<string, number>();
      for (const f of node.fields) if (f.name.trim()) seen.set(f.name.trim().toLowerCase(), (seen.get(f.name.trim().toLowerCase()) ?? 0) + 1);
      const dup = node.fields.map((f) => f.name.trim()).filter((nm, i, a) => nm && (seen.get(nm.toLowerCase()) ?? 0) > 1 && a.indexOf(nm) === i);
      if (dup.length) out.push({ level: "warning", message: `${list(dup)} ${dup.length === 1 ? "is" : "are"} named more than once here — the last one wins.` });
      break;
    }
    case "branch": {
      node.branches.forEach((b, i) => {
        const name = b.label?.trim() ? `“${b.label.trim()}”` : `Path ${i + 1}`;
        if (emptyCondition(b.when)) out.push({ level: "warning", message: `${name} has no condition yet, so every respondent takes it${i < node.branches.length - 1 ? " and the paths after it are never reached" : ""}.` });
        else if (!b.children.length) out.push({ level: "tip", message: `${name} is empty: respondents who match it skip to whatever follows this branch.` });
      });
      break;
    }
    default: break;
  }
  return out;
}
