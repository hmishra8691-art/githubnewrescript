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
  /** responses read through the working draft because the saved version they are stamped with lacks their questions */
  draftRead: number;
  /** answer keys that no version and no draft defines — reported, never silently dropped */
  undefinedKeys: string[];
}

export interface ExportRowRef {
  session_id: string;
  version_id?: string | null;
  /** the stored answers — read only for their KEYS, to see whether the row's version can describe them */
  answers?: Record<string, unknown> | null;
}

/** the label a draft-read row and the draft's columns carry */
export const DRAFT_VERSION_ID = "draft";

/**
 * The question an answer key belongs to: `q5`, `q5@3` (a loop iteration), `q5__other__97` (an Other-specify box) and
 * the like all belong to `q5`.
 */
export function answerQuestionId(key: string): string {
  return key.split("@")[0].split("__")[0];
}

/** the answered keys of a row that its definition has no question for */
function orphanKeys(answers: Record<string, unknown> | null | undefined, ids: Set<string>): string[] {
  if (!answers) return [];
  return Object.keys(answers).filter((k) => !ids.has(answerQuestionId(k)));
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
  /**
   * The working draft, when it may differ from the saved versions (2026-11-10).
   *
   * THE DEFECT THIS CLOSES: a download with eight columns and no questions. Simulated respondents and imported files
   * were validated against the DRAFT and stamped with the saved version's id; when the draft was ahead of that
   * version — a questionnaire built and never saved as a version — the export read each row through a version that
   * had none of its questions, and every answer left the file without a word. A row whose answers its own version
   * cannot describe, and the draft can, is read through the draft, the draft's questions join the columns, and the
   * file says so. Answers that nothing defines are counted and named in the warnings. No answer disappears silently.
   */
  draft?: SurveyDefinition | null,
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

  /* which rows hold answers their own version cannot describe — and can the draft? */
  const idsOf = new Map<SurveyDefinition, Set<string>>();
  const ids = (d: SurveyDefinition) => { let s = idsOf.get(d); if (!s) { s = new Set(d.questions.map((q) => q.id)); idsOf.set(d, s); } return s; };
  const ownDef = (r: ExportRowRef) => (r.version_id ? byId.get(r.version_id)?.def : undefined) ?? current.def;
  const draftRows = new Set<string>();
  const undefinedKeys = new Set<string>();
  for (const r of rows) {
    const orphans = orphanKeys(r.answers, ids(ownDef(r)));
    if (!orphans.length) continue;
    const stillOrphan = draft ? orphanKeys(r.answers, ids(draft)) : orphans;
    /* the draft must explain MORE of this row than its own version does — otherwise the stamp stands */
    if (draft && stillOrphan.length < orphans.length) { draftRows.add(r.session_id); for (const k of stillOrphan) undefinedKeys.add(answerQuestionId(k)); }
    else for (const k of orphans) undefinedKeys.add(answerQuestionId(k));
  }
  const draftLabel = `${current.version} + draft`;
  if (draft && draftRows.size) add(DRAFT_VERSION_ID, draftLabel, draft);

  const union = buildUnionDictionary(versions);

  const unplaced: { sessionId: string; reason: string }[] = [];
  const perRow: SurveyDefinition[] = rows.map((r) => {
    if (draft && draftRows.has(r.session_id)) return draft;
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
    if (draft && draftRows.has(r.session_id)) return draftLabel;
    const own = r.version_id ? byId.get(r.version_id) : undefined;
    return own?.version ?? current.version;
  });

  const warnings = describeConflicts(union.conflicts);
  if (draftRows.size) {
    warnings.push(
      `${draftRows.size} response${draftRows.size === 1 ? " holds" : "s hold"} answers to questions that are in the working draft and not in the saved version `
      + `(they were stored from the draft, by a simulation or an import). ${draftRows.size === 1 ? "It is" : "They are"} exported through the draft so no answer is left out. `
      + `Save a version to make the draft the questionnaire of record.`,
    );
  }
  if (undefinedKeys.size) {
    const names = [...undefinedKeys].sort();
    warnings.push(
      `Answers are stored under ${names.length} question id${names.length === 1 ? "" : "s"} that no saved version${draft ? " and no draft" : ""} defines `
      + `(${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}) — the question was deleted before any version kept it. `
      + `Those answers have no column in this file; they remain in the stored responses.`,
    );
  }
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
    draftRead: draftRows.size,
    undefinedKeys: [...undefinedKeys].sort(),
  };
}

/** Is there anything the person delivering this file needs to be told? */
export function exportHasWarnings(r: ResolvedVersions): boolean {
  return r.warnings.length > 0 || conflictCount(r.union.conflicts) > 0;
}
