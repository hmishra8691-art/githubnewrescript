import type { SurveyDefinition } from "@rescript/schema";
import type { LogicIssue } from "./lintLogic.js";
import { runQualityCheck, type QualityCheckResult } from "./qualityCheck.js";
import { buildVariableDictionary } from "./variables.js";
import { objectKey, type ObjectKey } from "./dependencyIndex.js";

/**
 * PER-OBJECT HEALTH — the thing a status dot needs.
 *
 * The survey lint already finds every problem; `runQualityCheck` groups them
 * by AREA (logic, flow, variables …) because that is how the publish gate
 * reports them. A programming environment needs them grouped the other way:
 * by the OBJECT they are about, so Q14 can carry a red dot, the branch after
 * page 4 an amber one, and clicking either opens exactly those issues.
 *
 * This re-groups the same issues. It runs no new checks — a badge that
 * disagreed with the publish gate would be worse than no badge — and it
 * attributes each issue with the most specific key it can:
 *
 *   · `objectKey` on the issue, when the lint set one (flow nodes, named rules);
 *   · otherwise `questionId`, which is nearly every logic issue;
 *   · a duplicate-variable problem names the variable, so it lands on every
 *     question that produces that variable — both halves of the collision;
 *   · anything else stays in `unattributed`, where the Logic panel already
 *     shows it. Nothing is dropped.
 */

export type StatusLevel = "ok" | "warning" | "error";

export interface ObjectStatus {
  key: ObjectKey;
  level: StatusLevel;
  issues: LogicIssue[];
}

export interface ObjectStatusMap {
  /** every object that has at least one issue */
  byKey: Map<ObjectKey, ObjectStatus>;
  /** issues nothing could be pinned on — survey-level, deployment, unknowns */
  unattributed: LogicIssue[];
  /** the quality result the map was built from, so callers need not run it twice */
  quality: QualityCheckResult;
  /** the status for any key; healthy when nothing is recorded */
  statusOf(key: ObjectKey): ObjectStatus;
  /** the worst level across a set of keys — a block's dot is its worst question's */
  worstOf(keys: Iterable<ObjectKey>): StatusLevel;
}

const RANK: Record<StatusLevel, number> = { ok: 0, warning: 1, error: 2 };

export function worseOf(a: StatusLevel, b: StatusLevel): StatusLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

/** `Duplicate variable "AGE" …` → AGE */
function quotedName(message: string): string | null {
  const m = /variable(?: override)? "([^"]+)"/i.exec(message);
  return m ? m[1] : null;
}

export function objectStatus(def: SurveyDefinition, quality: QualityCheckResult = runQualityCheck(def)): ObjectStatusMap {
  const byKey = new Map<ObjectKey, ObjectStatus>();
  const unattributed: LogicIssue[] = [];

  /* variable name → every question that writes it; built lazily, most surveys never need it */
  let producers: Map<string, Set<string>> | null = null;
  const producersOf = (name: string): Set<string> => {
    if (!producers) {
      producers = new Map();
      for (const v of buildVariableDictionary(def)) {
        if (!v.questionId) continue;
        (producers.get(v.name) ?? producers.set(v.name, new Set()).get(v.name)!).add(v.questionId);
      }
    }
    return producers.get(name) ?? new Set();
  };

  const record = (key: ObjectKey, issue: LogicIssue): void => {
    const cur = byKey.get(key) ?? { key, level: "ok" as StatusLevel, issues: [] };
    cur.issues.push(issue);
    cur.level = worseOf(cur.level, issue.level);
    byKey.set(key, cur);
  };

  for (const area of quality.areas) {
    for (const issue of area.issues) {
      if (issue.objectKey) { record(issue.objectKey, issue); continue; }
      if (issue.questionId) { record(objectKey("question", issue.questionId), issue); continue; }
      if (area.key === "variables") {
        const name = quotedName(issue.message);
        const owners = name ? producersOf(name) : new Set<string>();
        if (owners.size) { for (const qid of owners) record(objectKey("question", qid), issue); continue; }
      }
      unattributed.push(issue);
    }
  }

  return {
    byKey,
    unattributed,
    quality,
    statusOf: (key) => byKey.get(key) ?? { key, level: "ok", issues: [] },
    worstOf: (keys) => {
      let worst: StatusLevel = "ok";
      for (const k of keys) {
        worst = worseOf(worst, byKey.get(k)?.level ?? "ok");
        if (worst === "error") break;
      }
      return worst;
    },
  };
}
