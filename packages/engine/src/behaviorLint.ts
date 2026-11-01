import type { SurveyDefinition } from "@rescript/schema";
import { BEHAVIOR_SOURCES, DEVICE_CLASSES } from "@rescript/schema";

/**
 * S4b (D15 / TE-11, LO-07) — CONDITIONS THAT READ WHAT IS NEVER THERE.
 *
 * The quality engine's `SYSTEM_*` metrics (SYSTEM_SPEEDER_SCORE, SYSTEM_DURATION_RATIO, …) are computed AFTER the
 * interview, by the quality engine, for its custom rules (`quality.customRules[].when`). Until S4b every condition
 * picker offered them, so a display / skip / quota / UX / punch condition could name one — and it was null for every
 * respondent, silently. The builder now offers them only in the custom-rule editor; this lint names the ones
 * already saved elsewhere, with the behaviour condition that fits when there is one (speeder → time_on_page).
 *
 * It also checks the behaviour sources themselves: an unknown `ref`, a device value that is not a device class.
 */
export interface BehaviorLintIssue { level: "error" | "warning"; path: string; message: string; questionId?: string; questionCode?: string }

/** the behaviour condition that measures what a SYSTEM_* metric approximates — or undefined when none does */
export function behaviorFor(systemName: string): string | undefined {
  const n = systemName.toUpperCase();
  if (/SPEEDER|DURATION|MEDIAN|TOTAL_DURATION/.test(n)) return "time_on_page (seconds on this page) or elapsed (seconds since the start)";
  if (/DEVICE|BROWSER|\bOS\b|_OS$/.test(n)) return "device (mobile | tablet | desktop)";
  if (/OUT_OF_FOCUS|TAB_SWITCH/.test(n)) return "time_on_page";
  return undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** every condition rule in `node`, with its dotted path */
function rulesIn(node: unknown, path: string, out: { rule: Record<string, unknown>; path: string }[], depth = 0): void {
  if (depth > 60 || node == null || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((x, i) => rulesIn(x, `${path}[${i}]`, out, depth + 1)); return; }
  const r = node as Record<string, unknown>;
  if (r.type === "rule" && isRecord(r.source)) out.push({ rule: r, path });
  for (const [k, v] of Object.entries(r)) if (v && typeof v === "object") rulesIn(v, path ? `${path}.${k}` : k, out, depth + 1);
}

const WHERE: [string, string][] = [
  ["questions", "question"], ["flow", "flow"], ["quotas", "quota"], ["ux", "UX"], ["displayRules", "display rule"],
  ["calculations", "calculation"], ["namedExpressions", "named expression"], ["listFills", "list fill"],
];

export function lintBehaviorConditions(def: SurveyDefinition): BehaviorLintIssue[] {
  const issues: BehaviorLintIssue[] = [];
  const d = def as unknown as Record<string, unknown>;
  for (const [key, word] of WHERE) {
    const found: { rule: Record<string, unknown>; path: string }[] = [];
    rulesIn(d[key], key, found);
    for (const { rule, path } of found) {
      const src = rule.source as { kind?: string; ref?: string; scope?: string };
      const qi = /^questions\[(\d+)\]/.exec(path);
      const q = qi ? def.questions[Number(qi[1])] : undefined;
      const at = q ? { questionId: q.id, questionCode: q.code } : {};
      if (typeof src.ref === "string" && /^SYSTEM_[A-Z0-9_]+$/.test(src.ref) && src.kind !== "behavior") {
        const fit = behaviorFor(src.ref);
        issues.push({ level: "warning", path, ...at,
          message: `${q ? `${q.code}: ` : ""}a ${word} condition reads ${src.ref}, a quality-engine metric computed only after the interview for custom quality rules — it is empty here for every respondent.${fit ? ` Use the behaviour condition ${fit} instead.` : " Move it to Quality → Custom rules."}` });
        continue;
      }
      if (src.kind !== "behavior") continue;
      if (!(BEHAVIOR_SOURCES as readonly string[]).includes(String(src.ref))) {
        issues.push({ level: "error", path, ...at, message: `${q ? `${q.code}: ` : ""}“${src.ref}” is not a behaviour value (${BEHAVIOR_SOURCES.join(", ")})` });
        continue;
      }
      if (src.ref === "device") {
        const vals = (Array.isArray(rule.value) ? rule.value : [rule.value]).filter((v) => v !== undefined && v !== null && v !== "");
        const bad = vals.filter((v) => !(DEVICE_CLASSES as readonly string[]).includes(String(v).toLowerCase()));
        if (bad.length) issues.push({ level: "warning", path, ...at, message: `${q ? `${q.code}: ` : ""}device is compared with ${bad.map((v) => `“${v}”`).join(", ")} — a device is ${DEVICE_CLASSES.join(", ")}` });
      }
    }
  }
  return issues;
}
