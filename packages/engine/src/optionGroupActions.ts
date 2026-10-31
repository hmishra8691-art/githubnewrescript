import type { OptionGroup, Question, SurveyDefinition } from "@rescript/schema";

/**
 * set_option_groups — OPTION GROUPS, AND WHAT THE RESPONDENT SEES OF THEM (AQ-08, S4a 2026-10-31).
 *
 * Before this Intelligent Mode had no way to group options at all (the audit's "No — no group action"), and the
 * groups the editor made were invisible to respondents. This action writes exactly what Properties → Option groups
 * writes: `question.optionGroups` for one scope (options | rows | columns), each group
 *   name      the author's handle (required; also the default heading)
 *   label     the respondent-facing heading (defaults to the name when a display is asked for)
 *   display   none (order / visibility only, the default) | heading | collapsible
 *   members   option / row codes (column ids), in the group's own order; a code in two groups belongs to the first
 * Existing groups of the scope are replaced (their ids kept by name, so a group's randomization seed survives);
 * `clear: true` removes the scope's groups. Unknown members are refused with the list of codes.
 */
export interface GroupSpec { name: string; label?: string; display?: "heading" | "collapsible" | "none"; members: (string | number)[] }
export type OptionGroupAction = { op: "set_option_groups"; target: string; scope?: "options" | "rows" | "columns"; groups?: GroupSpec[]; clear?: boolean };
export const OPTION_GROUP_ACTION_OPS = ["set_option_groups"] as const;

const s = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
const DISPLAYS = new Set(["heading", "collapsible", "none"]);

/** the gate: a wire object → the action, or why not */
export function coerceOptionGroupAction(o: Record<string, unknown>): OptionGroupAction | string {
  const target = s(o.target ?? o.question, 120);
  if (!target) return "set_option_groups needs a target question";
  const scope = o.scope === "rows" || o.scope === "columns" || o.scope === "options" ? o.scope : undefined;
  const a: OptionGroupAction = { op: "set_option_groups", target, ...(scope ? { scope } : {}) };
  if (o.clear === true || o.groups === null) { a.clear = true; return a; }
  if (!Array.isArray(o.groups) || !o.groups.length) return "set_option_groups needs groups [{name, label, display heading|collapsible|none, members}] or clear";
  const groups: GroupSpec[] = [];
  for (const raw of o.groups.slice(0, 40)) {
    if (!raw || typeof raw !== "object") continue;
    const g = raw as Record<string, unknown>;
    const name = s(g.name ?? g.label ?? g.title, 120);
    if (!name) return "every group needs a name";
    const members = Array.isArray(g.members ?? g.codes ?? g.options) ? ((g.members ?? g.codes ?? g.options) as unknown[]).filter((m): m is string | number => typeof m === "string" || (typeof m === "number" && Number.isFinite(m))).slice(0, 500) : [];
    if (!members.length) return `group “${name}” has no members (option codes)`;
    const display = typeof g.display === "string" && DISPLAYS.has(g.display) ? g.display as GroupSpec["display"] : g.collapsible === true ? "collapsible" : g.heading === true ? "heading" : undefined;
    const label = s(g.label ?? g.heading, 200);
    groups.push({ name, members, ...(label ? { label } : {}), ...(display ? { display } : {}) });
  }
  if (!groups.length) return "set_option_groups needs at least one group";
  a.groups = groups;
  return a;
}

export interface OptionGroupEnv { question(ref: string): Question | undefined; ids(prefix: string): string }

export function applyOptionGroupAction(def: SurveyDefinition, a: OptionGroupAction, env: OptionGroupEnv): { description: string; destructive?: string; warnings: string[]; touched: string[] } {
  void def;
  const q = env.question(a.target);
  if (!q) throw new Error(`there is no question “${a.target}”`);
  const scope = a.scope ?? "options";
  const others = (q.optionGroups ?? []).filter((g) => (g.scope ?? "options") !== scope);
  const before = (q.optionGroups ?? []).filter((g) => (g.scope ?? "options") === scope);
  if (a.clear) {
    if (!before.length) throw new Error(`${q.code} has no ${scope} groups to remove`);
    q.optionGroups = others;
    return { description: `${q.code}: ${before.length} ${scope} group${before.length === 1 ? "" : "s"} removed`, destructive: `removes the ${scope} groups of ${q.code}`, warnings: [], touched: [q.id] };
  }
  const pool = scope === "rows" ? (q.rows ?? []).map((r) => String(r.code)) : scope === "columns" ? (q.columns ?? []).map((c) => String(c.id)) : (q.options ?? []).map((o) => String(o.code));
  const labels = new Map((scope === "options" ? (q.options ?? []) : scope === "rows" ? (q.rows ?? []) : []).map((o) => [String(o.label).replace(/<[^>]*>/g, "").trim().toLowerCase(), String(o.code)]));
  const taken = new Set<string>();
  const warnings: string[] = [];
  const made: OptionGroup[] = [];
  for (const spec of a.groups ?? []) {
    const members: string[] = [];
    for (const m of spec.members) {
      const k = pool.includes(String(m)) ? String(m) : labels.get(String(m).trim().toLowerCase());
      if (!k) throw new Error(`${q.code} has no ${scope === "columns" ? "column" : scope === "rows" ? "row" : "option"} “${m}” (codes: ${pool.slice(0, 15).join(", ")}${pool.length > 15 ? ", …" : ""})`);
      if (taken.has(k)) { warnings.push(`${q.code}: ${k} is already in an earlier group — it stays there (membership is exclusive)`); continue; }
      taken.add(k); members.push(k);
    }
    const old = before.find((g) => g.name === spec.name);
    const typed = (code: string) => { const o = (scope === "options" ? q.options : scope === "rows" ? q.rows : undefined)?.find((x) => String(x.code) === code); return o ? o.code : code; };
    const display = spec.display ?? (spec.label ? "heading" : undefined);
    /* what is given replaces what was there; the id (seed key) and the ordering / visibility settings are kept */
    const keep = old ? Object.fromEntries((["order", "priority", "visibleIf", "itemOrder", "collapsed"] as const).filter((k) => old[k] !== undefined).map((k) => [k, old[k]])) : {};
    made.push({
      ...keep,
      id: old?.id ?? env.ids("grp"),
      name: spec.name,
      scope,
      members: members.map(typed),
      ...(display && display !== "none" ? { label: spec.label ?? spec.name, display } : {}),
      ...(display === "none" ? { display: "none" } : {}),
      ...((!display || display === "none") && spec.label ? { label: spec.label } : {}),
    } as OptionGroup);
  }
  const loose = pool.filter((c) => !taken.has(c));
  if (loose.length && made.some((g) => g.display && g.display !== "none")) warnings.push(`${q.code}: ${loose.length} ${scope} (${loose.slice(0, 6).join(", ")}) are in no group — they are drawn without a heading after the grouped ones`);
  q.optionGroups = [...others, ...made];
  const shown = made.filter((g) => g.display && g.display !== "none").map((g) => `${g.name} (${g.display})`);
  return {
    description: `${q.code}: ${made.length} ${scope} group${made.length === 1 ? "" : "s"}${shown.length ? ` — shown to respondents: ${shown.join(", ")}` : " (order / visibility only)"}`,
    ...(before.length ? { destructive: `replaces the ${scope} groups of ${q.code}` } : {}),
    warnings, touched: [q.id],
  };
}

export function describeOptionGroupAction(a: OptionGroupAction): string {
  if (a.clear) return `Remove the ${a.scope ?? "options"} groups of ${a.target}`;
  return `Group the ${a.scope ?? "options"} of ${a.target} (${(a.groups ?? []).map((g) => g.name).join(", ")})`;
}
