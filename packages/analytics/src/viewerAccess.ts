import type { AnalysisResult, ReportDefinition } from "./types.js";

/**
 * VIEWER ROLES AND ROW FILTERS ON A SHARED REPORT (Level 5 roadmap R3, 2026-11-22).
 *
 * A share link may carry rules saying which part of the data each viewer — a named person, or everyone at a domain
 * (a client team, a region's managers) — may see: everything, one of the report's viewer filters, or one of its
 * drill-down values. The server picks the viewer's rule from their SIGNED-IN email and sends only that frozen answer:
 * the other segments' numbers never leave, so there is nothing in the page to unhide. A viewer no rule names sees
 * nothing. Rules can only point at answers the published version froze (R2), so a rule never makes the server compute.
 *
 * Matching: an exact email first, then the longest matching domain; within one level, the first rule wins.
 * Browser-safe.
 */
export type ViewerScope = { kind: "all" } | { kind: "filter"; filterId: string } | { kind: "drill"; value: string | number };
export interface ViewerRule { id: string; label?: string; emails?: string[]; domains?: string[]; sees: ViewerScope }
export const MAX_VIEWER_RULES = 50;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/;

/** the rules as given, cleaned (lower-case addresses, duplicates out) and checked against what the published version froze */
export function checkViewerRules(raw: unknown, report: Pick<ReportDefinition, "viewerFilters" | "drillDown">): { rules: ViewerRule[]; problems: string[] } {
  const problems: string[] = [];
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_VIEWER_RULES) problems.push(`At most ${MAX_VIEWER_RULES} viewer rules; ${list.length} were given.`);
  const filters = new Set(report.viewerFilters ?? []);
  const drill = new Set((report.drillDown?.values ?? []).map((v) => String(v.value)));
  const rules: ViewerRule[] = [];
  list.slice(0, MAX_VIEWER_RULES).forEach((x, i) => {
    const r = (x ?? {}) as Partial<ViewerRule>;
    const name = r.label?.trim() || `Rule ${i + 1}`;
    const emails = [...new Set((r.emails ?? []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
    const domains = [...new Set((r.domains ?? []).map((d) => String(d).trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
    for (const e of emails) if (!EMAIL.test(e)) problems.push(`${name}: “${e}” is not an email address.`);
    for (const d of domains) if (!DOMAIN.test(d)) problems.push(`${name}: “${d}” is not a domain like client.com.`);
    if (!emails.length && !domains.length) problems.push(`${name}: say who it is for (emails or a domain).`);
    const s = r.sees as ViewerScope | undefined;
    if (!s || !["all", "filter", "drill"].includes(s.kind)) problems.push(`${name}: say what they see (everything, a filter or a drill-down value).`);
    else if (s.kind === "filter" && !filters.has(s.filterId)) problems.push(`${name}: that filter is not one of this report's viewer filters, so it was not computed when the report was published.`);
    else if (s.kind === "drill" && !drill.has(String(s.value))) problems.push(`${name}: “${String(s.value)}” is not one of this report's drill-down values.`);
    rules.push({ id: typeof r.id === "string" && r.id ? r.id.slice(0, 40) : `r${i + 1}`, ...(r.label?.trim() ? { label: r.label.trim().slice(0, 80) } : {}), ...(emails.length ? { emails } : {}), ...(domains.length ? { domains } : {}), sees: (s ?? { kind: "all" }) as ViewerScope });
  });
  return { rules, problems };
}

/** the rule that applies to a signed-in viewer, or why there is none */
export function ruleForViewer(rules: ViewerRule[], email: string | null | undefined): { rule: ViewerRule } | { denied: string } {
  const e = (email ?? "").trim().toLowerCase();
  if (!e) return { denied: "Sign in to see this report: what you can see depends on your account." };
  const exact = rules.find((r) => r.emails?.includes(e));
  if (exact) return { rule: exact };
  const domain = e.slice(e.lastIndexOf("@") + 1);
  const byDomain = rules
    .flatMap((r) => (r.domains ?? []).filter((d) => domain === d || domain.endsWith(`.${d}`)).map((d) => ({ r, len: d.length })))
    .sort((a, b) => b.len - a.len)[0];
  if (byDomain) return { rule: byDomain.r };
  return { denied: "This report has been shared with your account, but no part of its data has been opened to you. Ask the person who shared it." };
}

export interface FrozenAnswers {
  results: Record<string, AnalysisResult>;
  filters: { id: string; name: string }[];
  filterResults: Record<string, Record<string, AnalysisResult>> | null;
  drill: { label: string; values: { value: string | number; label: string }[]; results: Record<string, Record<string, AnalysisResult>> } | null;
}

/**
 * What the viewer under `rule` receives: for "all", everything frozen; otherwise ONLY their segment's answer, as the
 * report's main results, with no filter or drill choices (and so no other segment's numbers) in the payload.
 */
export function restrictToRule(all: FrozenAnswers, rule: ViewerRule): { view: FrozenAnswers & { scopeLabel: string | null } } | { missing: string } {
  const s = rule.sees;
  if (s.kind === "all") return { view: { ...all, scopeLabel: null } };
  if (s.kind === "filter") {
    const r = all.filterResults?.[s.filterId];
    if (!r) return { missing: "The part of this report opened to you was not in the published version. Ask the person who shared it to publish again." };
    return { view: { results: r, filters: [], filterResults: null, drill: null, scopeLabel: all.filters.find((f) => f.id === s.filterId)?.name ?? rule.label ?? "Your segment" } };
  }
  const r = all.drill?.results?.[String(s.value)];
  if (!r) return { missing: "The part of this report opened to you was not in the published version. Ask the person who shared it to publish again." };
  const v = all.drill!.values.find((x) => String(x.value) === String(s.value));
  return { view: { results: r, filters: [], filterResults: null, drill: null, scopeLabel: `${all.drill!.label}: ${v?.label ?? String(s.value)}` } };
}
