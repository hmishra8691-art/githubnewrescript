import type { SurveyDefinition, VariableDef } from "@rescript/schema";
import { buildVariableDictionary } from "./variables.js";
import { flattenVariables } from "./flatten.js";

/**
 * R7 — READ EACH RESPONSE THROUGH THE VERSION IT WAS COLLECTED UNDER.
 *
 * Every export flattens every row against `current_version_id`. That is wrong
 * in a specific and expensive way, and the wrongness is invisible: two
 * exports of the same interviews either side of a version cut differ from
 * each other while both claim to be the same version.
 *
 * `responses.version_id` has been NOT NULL with a foreign key since migration
 * 0001. No export path has ever read it.
 *
 * What that costs, concretely:
 *
 *   · a matrix row deleted after fieldwork takes its column with it, so the
 *     answers collected under the old version are silently not delivered
 *   · relabelling an option rewrites history — last month's respondents are
 *     reported as having said the new thing
 *   · changing a code orphans every answer already collected against the old
 *     one
 *
 * ## THE COLUMN SET IS THE UNION
 *
 * When a study has responses under more than one version, the file carries
 * every column ANY of those versions declared, blank where a version did not
 * have it, and the dictionary records which versions each column existed in.
 *
 * The alternatives are worse in ways that are easy to miss. The current
 * version's columns alone drop data that was collected — the bug. The
 * intersection drops it from BOTH sides. One file per version moves the
 * merging to the client, where the mistakes become invisible to us.
 *
 * ## WHAT THE UNION CANNOT FIX, IT REPORTS
 *
 * Some differences are not a layout problem. If code 3 meant "Sometimes" in
 * v1 and "Often" in v2, no arrangement of columns makes a single 3 mean one
 * thing. The values are therefore left EXACTLY as collected — nothing here
 * rewrites a respondent's answer — and the disagreement is reported: in the
 * dictionary, in the value label itself, and in a conflict list the caller
 * can put in front of whoever is about to deliver the file.
 *
 * The one thing that is NOT done is the tempting one: quietly taking the
 * newest version's labels and moving on. That is the bug wearing a tidier
 * suit, and it is how 340 people who said "Sometimes" get reported as having
 * said "Often".
 */

/** One published version, with its parsed definition. */
export interface VersionedDefinition {
  /** `survey_versions.id` — what `responses.version_id` points at */
  versionId: string;
  /** the human version number, e.g. "2.0" — what a person reads */
  version: string;
  def: SurveyDefinition;
}

/** A column in the union, with the provenance the dictionary reports. */
export interface UnionVariable extends VariableDef {
  /** the version numbers that declared this column, newest first */
  versions: string[];
  /** true when at least one version in the study did NOT have it */
  partial: boolean;
}

/** One code that means different things in different versions. */
export interface CodeConflict {
  variable: string;
  code: string;
  /** version number → the label that version gave this code */
  byVersion: Record<string, string>;
}

/** One variable whose storage type is not the same in every version. */
export interface TypeConflict {
  variable: string;
  byVersion: Record<string, string>;
  /** the type the file actually uses — always the widest, never lossy */
  resolved: VariableDef["dataType"];
}

/** One question whose wording changed mid-field. Informational, not a fault. */
export interface TextChange {
  variable: string;
  byVersion: Record<string, string>;
}

export interface VersionConflicts {
  codes: CodeConflict[];
  types: TypeConflict[];
  text: TextChange[];
}

export interface UnionDictionary {
  variables: UnionVariable[];
  conflicts: VersionConflicts;
  /** the version numbers this dictionary spans, newest first */
  versions: string[];
  /** true when more than one version is present — the only case that differs from today */
  mixed: boolean;
}

/* ------------------------------------------------------------------ helpers */

/**
 * Newest first, by version number.
 *
 * Versions are "major.minor" strings. Sorting them as text puts 10.0 before
 * 2.0, which would make the NEWEST version the one whose labels lose — so
 * they are compared as numbers, with anything unparseable sorted last rather
 * than throwing.
 */
function byNewest(a: { version: string }, b: { version: string }): number {
  const parse = (v: string): [number, number] => {
    const m = /^(\d+)(?:\.(\d+))?/.exec(String(v).trim());
    return m ? [Number(m[1]), Number(m[2] ?? 0)] : [-1, -1];
  };
  const [am, an] = parse(a.version);
  const [bm, bn] = parse(b.version);
  return bm - am || bn - an;
}

/**
 * The widest of two storage types.
 *
 * A column has ONE type in every file format worth delivering — .sav, .xpt
 * and .dta all declare it once — so a variable that was numeric in v1 and
 * text in v2 has to become one of them. Widening to text is the only choice
 * that loses nothing: every numeric value has a faithful text rendering, and
 * the reverse is not true. The narrowing would silently blank every answer
 * that did not parse as a number.
 */
function widen(a: VariableDef["dataType"], b: VariableDef["dataType"]): VariableDef["dataType"] {
  if (a === b) return a;
  return "text";
}

/** Dictionary entries by name, for one version. */
function dictionaryOf(v: VersionedDefinition): Map<string, VariableDef> {
  const out = new Map<string, VariableDef>();
  for (const d of buildVariableDictionary(v.def)) {
    /* first wins: `buildVariableDictionary` can emit a name twice (a
     * composite and its parts), and every exporter already takes the first */
    if (!out.has(d.name)) out.set(d.name, d);
  }
  return out;
}

/* ------------------------------------------------------------ the union */

export function buildUnionDictionary(input: VersionedDefinition[]): UnionDictionary {
  const versions = [...input].sort(byNewest);
  const dicts = versions.map((v) => ({ v, dict: dictionaryOf(v) }));

  const conflicts: VersionConflicts = { codes: [], types: [], text: [] };

  /*
   * ORDER: the newest version's dictionary is the spine, because that is the
   * order the researcher last chose and the order today's file already has.
   *
   * A column only an OLDER version had is inserted directly after whatever
   * preceded it THERE, rather than appended to the end. A question deleted
   * from the middle of the questionnaire belongs in the middle of the file:
   * pushing it to the end would make a delivered file where the column order
   * no longer resembles the questionnaire anyone actually ran, which is how a
   * researcher mis-reads a column as belonging to the next section.
   */
  const order: string[] = [];
  const seen = new Set<string>();
  for (const name of dicts[0]?.dict.keys() ?? []) { order.push(name); seen.add(name); }

  for (const { dict } of dicts.slice(1)) {
    const names = [...dict.keys()];
    names.forEach((name, i) => {
      if (seen.has(name)) return;
      seen.add(name);
      /* the nearest preceding column that the union already places */
      let anchor = -1;
      for (let back = i - 1; back >= 0; back--) {
        const at = order.indexOf(names[back]);
        if (at >= 0) { anchor = at; break; }
      }
      if (anchor >= 0) order.splice(anchor + 1, 0, name);
      else order.push(name);
    });
  }

  const variables: UnionVariable[] = [];
  for (const name of order) {
    const present = dicts.filter((d) => d.dict.has(name));
    const base = { ...(present[0].dict.get(name) as VariableDef) };

    /* ---------------------------------------------------- storage type */
    let dataType = base.dataType;
    const typesByVersion: Record<string, string> = {};
    for (const { v, dict } of present) {
      const d = dict.get(name)!;
      typesByVersion[v.version] = d.dataType;
      dataType = widen(dataType, d.dataType);
    }
    if (new Set(Object.values(typesByVersion)).size > 1) {
      conflicts.types.push({ variable: name, byVersion: typesByVersion, resolved: dataType });
    }

    /* ------------------------------------------------- codes and labels */
    const codes: (string | number)[] = [];
    const codeSeen = new Set<string>();
    /** code → version → label, so a disagreement is visible per code */
    const labelsByCode = new Map<string, Record<string, string>>();

    for (const { v, dict } of present) {
      const d = dict.get(name)!;
      for (const c of d.valueCodes ?? []) {
        const k = String(c);
        if (!codeSeen.has(k)) { codeSeen.add(k); codes.push(c); }
        const label = d.valueLabels?.[k];
        if (label != null) {
          const per = labelsByCode.get(k) ?? {};
          per[v.version] = String(label);
          labelsByCode.set(k, per);
        }
      }
    }

    const valueLabels: Record<string, string> = {};
    for (const [code, per] of labelsByCode) {
      const distinct = [...new Set(Object.values(per))];
      if (distinct.length === 1) {
        valueLabels[code] = distinct[0];
        continue;
      }
      /*
       * A CODE THAT MEANS TWO THINGS SAYS SO, IN THE LABEL.
       *
       * Every format can hold one label per code, so the choice is between a
       * label that is true for some rows and false for others, and a label
       * that names the disagreement. The second is uglier and it is the one
       * that cannot be tabulated by accident: a client who sees
       * `Often (v2.0) / Sometimes (v1.0)` asks a question, where a client who
       * sees `Often` simply reports it.
       *
       * The conflict is ALSO in `conflicts.codes` so the caller can put it in
       * front of whoever is delivering the file, rather than relying on
       * somebody reading the value labels.
       */
      const ordered = present.map((p) => p.v.version).filter((ver) => per[ver] != null);
      valueLabels[code] = ordered.map((ver) => `${per[ver]} (v${ver})`).join(" / ");
      conflicts.codes.push({ variable: name, code, byVersion: per });
    }

    /* ------------------------------------------------- question wording */
    const textByVersion: Record<string, string> = {};
    for (const { v, dict } of present) {
      const t = dict.get(name)!.questionText;
      if (t != null) textByVersion[v.version] = String(t);
    }
    if (new Set(Object.values(textByVersion)).size > 1) {
      conflicts.text.push({ variable: name, byVersion: textByVersion });
    }

    variables.push({
      ...base,
      dataType,
      valueCodes: codes,
      valueLabels,
      versions: present.map((p) => p.v.version),
      partial: present.length !== versions.length,
    });
  }

  return {
    variables,
    conflicts,
    versions: versions.map((v) => v.version),
    mixed: versions.length > 1,
  };
}

/* --------------------------------------------------------- flattening */

/** Enough of a stored response for this module: which version, and the state. */
export interface VersionedRow<S> {
  /** `responses.version_id` */
  versionId: string | null | undefined;
  state: S;
}

export interface FlattenedRow {
  /** the union's columns, blank where this row's version did not have one */
  values: Record<string, unknown>;
  /** the version number this row was actually read through */
  version: string;
  /**
   * Set when the row's own version could not be resolved and a fallback was
   * used. Never silent: a row read through the wrong definition is exactly
   * the defect this module exists to remove, so if it has to happen the
   * caller is told which rows and why.
   */
  fallback?: string;
}

/**
 * Flatten each row against ITS OWN version, then project onto the union.
 *
 * `missing` is what a column gets when the row's version did not declare it.
 * It is `undefined` rather than "" so that every exporter's own empty-cell
 * rendering applies unchanged — a blank in CSV, a system-missing in SPSS,
 * an empty cell in Excel — instead of this module inventing an empty string
 * that a statistical package would read as a real answer.
 */
export function flattenVersioned<S>(
  union: UnionDictionary,
  versions: VersionedDefinition[],
  rows: VersionedRow<S>[],
  opts: { fallbackVersionId?: string | null; mediaBaseUrl?: string | null } = {},
): FlattenedRow[] {
  const byId = new Map(versions.map((v) => [v.versionId, v]));
  const names = union.variables.map((v) => v.name);
  const fallback = opts.fallbackVersionId ? byId.get(opts.fallbackVersionId) : undefined;
  const newest = [...versions].sort(byNewest)[0];

  return rows.map((row) => {
    const own = row.versionId ? byId.get(row.versionId) : undefined;
    const use = own ?? fallback ?? newest;
    if (!use) return { values: {}, version: "", fallback: "no version definition was available at all" };

    const flat = flattenVariables(use.def, row.state as never, { mediaBaseUrl: opts.mediaBaseUrl });
    const values: Record<string, unknown> = {};
    for (const n of names) {
      if (n in flat) values[n] = flat[n];
      /* else: left absent, so the exporter renders its own idea of missing */
    }
    return {
      values,
      version: use.version,
      ...(own ? {} : {
        fallback: row.versionId
          ? `this response names version ${row.versionId}, which no longer exists; it was read through v${use.version}`
          : `this response records no version; it was read through v${use.version}`,
      }),
    };
  });
}

/* ------------------------------------------------------------- reporting */

/** How many separate problems the caller should warn about. */
export function conflictCount(c: VersionConflicts): number {
  return c.codes.length + c.types.length;
}

/**
 * One sentence per conflict, for a warning banner or an export note.
 *
 * Question WORDING changes are deliberately not in here. A reworded question
 * is a normal thing to do mid-field and a researcher who did it knows; it
 * belongs in the dictionary, not in a warning that would cry wolf and make
 * the code conflicts — which are not normal — easier to skip past.
 */
export function describeConflicts(c: VersionConflicts): string[] {
  const out: string[] = [];
  for (const t of c.types) {
    out.push(
      `${t.variable} is ${Object.entries(t.byVersion).map(([v, ty]) => `${ty} in v${v}`).join(" and ")}. `
      + `The file stores it as ${t.resolved}, which holds every value collected.`,
    );
  }
  for (const k of c.codes) {
    out.push(
      `${k.variable} code ${k.code} does not mean the same thing in every version: `
      + `${Object.entries(k.byVersion).map(([v, l]) => `v${v} “${l}”`).join(", ")}. `
      + `The values are as collected — they have not been changed.`,
    );
  }
  return out;
}
