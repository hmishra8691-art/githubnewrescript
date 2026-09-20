import { SurveyDefinition } from "@rescript/schema";
import {
  buildUnionDictionary, conflictCount, describeConflicts,
  type UnionDictionary, type VersionedDefinition,
} from "@rescript/engine";
import { getCachedVersionDefinition } from "@rescript/quality/server";
import type { VersionedSource } from "@rescript/exporters";

/**
 * R7, the route's half — RESOLVE THE VERSIONS A SET OF RESPONSES SPANS.
 *
 * The export loaded one definition (`current_version_id`) and read every row
 * through it. This loads the definition each response was ACTUALLY collected
 * under, from the `version_id` the row has carried since migration 0001 and
 * that no export path has ever read.
 *
 * The cost is bounded and small: a study has a handful of versions however
 * many responses it has, `getCachedVersionDefinition` already memoises by
 * version id across the process, and the per-row work is unchanged — the
 * same `flattenVariables` call, against a different definition.
 */

export interface ResolvedVersions {
  /** every version the responses span, with its parsed definition */
  versions: VersionedDefinition[];
  /** the union column list and the conflicts between versions */
  union: UnionDictionary;
  /**
   * The definition and version number for one response, BY SESSION ID.
   *
   * Session id rather than row position, and that is not fussiness. The
   * export applies a dataset filter partway through and rebuilds its row
   * list from the survivors, so a positional index taken before the filter
   * points at a different response afterwards — every row after the first
   * excluded one would be read through its neighbour's questionnaire. That
   * is a subtler version of the very bug this module exists to remove, and
   * it would look like nothing at all in the output.
   */
  forSession: (sessionId: string) => { def: SurveyDefinition; version: string };
  /**
   * A positional `VersionedSource` for one specific list of rows — built
   * from that list, so it is correct for it whatever filtering produced it.
   */
  sourceFor: (rows: { session_id: string }[]) => VersionedSource;
  /**
   * Rows that could not be placed, with the reason. Never silent: a response
   * read through the wrong questionnaire is the defect this exists to remove,
   * so when it cannot be avoided the file says which rows and why.
   */
  unplaced: { sessionId: string; reason: string }[];
  /** one sentence per conflict, for a warning header on the delivery */
  warnings: string[];
}

export interface ExportRowRef {
  session_id: string;
  version_id?: string | null;
}

/**
 * Load every version these rows span.
 *
 * `currentDef`/`currentVersionId` are the fallback, used only for a row whose
 * own version cannot be read — a version row deleted by hand, or a stored
 * definition that no longer parses against the schema. Those rows still
 * export. Dropping them would discard real fieldwork to avoid admitting an
 * inconsistency, which is the worse of the two failures by a wide margin.
 */
export async function resolveExportVersions(
  db: any,
  rows: ExportRowRef[],
  current: { versionId: string; version: string; def: SurveyDefinition },
  /*
   * The loader is injectable for one reason: this function decides what the
   * delivered file contains, and a decision that can only be exercised
   * through a live Supabase client is a decision nothing tests. The default
   * is the real, memoising loader; a test passes its own.
   */
  loadDefinition: (db: any, versionId: string) => Promise<SurveyDefinition | null> = getCachedVersionDefinition,
): Promise<ResolvedVersions> {
  const wanted = [...new Set(rows.map((r) => r.version_id).filter((v): v is string => !!v))];

  /* the version NUMBERS, which is what a person reads and what gets stamped */
  const numbers = new Map<string, string>();
  if (wanted.length) {
    const { data } = await db.from("survey_versions").select("id, version").in("id", wanted);
    for (const v of (data ?? []) as { id: string; version: string }[]) numbers.set(v.id, String(v.version));
  }
  numbers.set(current.versionId, current.version);

  const versions: VersionedDefinition[] = [];
  const byId = new Map<string, VersionedDefinition>();
  const add = (versionId: string, version: string, def: SurveyDefinition) => {
    if (byId.has(versionId)) return;
    const entry = { versionId, version, def };
    byId.set(versionId, entry);
    versions.push(entry);
  };

  for (const id of wanted) {
    const def = await loadDefinition(db, id);
    if (def) add(id, numbers.get(id) ?? "?", def);
  }
  /*
   * The current version joins the union even when no response was collected
   * under it. A study that has just been re-versioned and not yet re-fielded
   * would otherwise export a file whose columns change the moment the first
   * new interview lands — the client's script breaks mid-fieldwork, on a day
   * when nothing they can see has changed.
   */
  add(current.versionId, current.version, current.def);

  const union = buildUnionDictionary(versions);

  const unplaced: { sessionId: string; reason: string }[] = [];
  const perRow: SurveyDefinition[] = rows.map((r) => {
    const own = r.version_id ? byId.get(r.version_id) : undefined;
    if (own) return own.def;
    unplaced.push({
      sessionId: r.session_id,
      reason: r.version_id
        ? `version ${r.version_id} could not be read; exported against v${current.version}`
        : `no version recorded; exported against v${current.version}`,
    });
    return current.def;
  });
  const perRowVersion: string[] = rows.map((r) => {
    const own = r.version_id ? byId.get(r.version_id) : undefined;
    return own?.version ?? current.version;
  });

  const warnings = describeConflicts(union.conflicts);
  if (unplaced.length) {
    warnings.push(
      `${unplaced.length} response${unplaced.length === 1 ? "" : "s"} could not be matched to the version `
      + `${unplaced.length === 1 ? "it was" : "they were"} collected under and ${unplaced.length === 1 ? "was" : "were"} `
      + `read through v${current.version} instead.`,
    );
  }

  const bySession = new Map<string, { def: SurveyDefinition; version: string }>();
  rows.forEach((r, i) => {
    bySession.set(r.session_id, { def: perRow[i], version: perRowVersion[i] });
  });
  const forSession = (sessionId: string) =>
    bySession.get(sessionId) ?? { def: current.def, version: current.version };

  return {
    versions,
    union,
    forSession,
    sourceFor: (list) => ({
      dictionary: union.variables,
      defFor: (i: number) => forSession(list[i]?.session_id ?? "").def,
    }),
    unplaced,
    warnings,
  };
}

/** Is there anything the person delivering this file needs to be told? */
export function exportHasWarnings(r: ResolvedVersions): boolean {
  return r.warnings.length > 0 || conflictCount(r.union.conflicts) > 0;
}
