import type { Question } from "@rescript/schema";

type Axis = "options" | "rows" | "columns";

/**
 * Which axes a question shuffles, read from its one `randomization` setting —
 * the same one Properties → Randomization edits, so a builder toggle ("Randomize
 * Images", "Randomize Buckets", "Randomize cards") and the panel can never
 * disagree.
 */
export function randomAxes(r: Question["randomization"]): Axis[] {
  if (!r?.enabled || r.method === "none") return [];
  return r.scopes?.length ? [...r.scopes] : [r.scope ?? "options"];
}

/**
 * Turn one axis on or off, keeping everything else the setting holds (rules,
 * groups, "show only N"). The first remaining axis stays the primary `scope`.
 */
export function toggleRandomAxis(r: Question["randomization"], axis: Axis, on: boolean): Question["randomization"] {
  const cur = randomAxes(r);
  const next = on ? [...new Set([...cur, axis])] : cur.filter((a) => a !== axis);
  if (!next.length) return r ? { ...r, enabled: false } : undefined;
  return {
    ...(r ?? {}),
    enabled: true,
    method: r?.method && r.method !== "none" ? r.method : "shuffle",
    scope: next.includes(r?.scope as Axis) ? r!.scope : next[0],
    scopes: next.length > 1 ? next : undefined,
  } as Question["randomization"];
}
