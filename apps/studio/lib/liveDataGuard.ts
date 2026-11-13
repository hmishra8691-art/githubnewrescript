import { protectCollectedData, type ProtectedItem } from "@rescript/engine";
import { SurveyDefinition } from "@rescript/schema";

/**
 * THE SERVER'S SIDE OF DELETION PROTECTION (2026-11-15, engine dataProtection.ts).
 *
 * The editor turns a deletion into a hide once a survey has live responses — but the editor is a client: a tab opened
 * before the first response arrived, an old build, or a direct API call would still send a definition with the
 * question gone. So the two routes that store a definition (the autosaved draft and a saved version) run the same
 * rule themselves before writing:
 *
 *   baseline 1   the version the LIVE link is serving — its questions and codes are what the stored answers mean
 *   baseline 2   what the row held before this write (the draft, or the current version)
 *
 * Anything that holds data in either and is missing from the incoming definition is put back hidden, and the list is
 * returned so the editor can say so. With no live responses nothing is read beyond one count and nothing changes.
 */
interface Db {
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function liveResponseTotal(db: Db, surveyId: string): Promise<number> {
  const count = async (softDelete: boolean): Promise<{ n: number | null; error: unknown }> => {
    let q = db.from("responses").select("id", { count: "exact", head: true }).eq("survey_id", surveyId).eq("is_test", false);
    if (softDelete) q = q.is("deleted_at", null);
    const { count: n, error } = await q;
    return { n: typeof n === "number" ? n : null, error };
  };
  let r = await count(true);
  /* a database from before the soft-delete migration has no `deleted_at` */
  if (r.error) r = await count(false);
  return r.n ?? 0;
}

export interface LiveDataGuardResult {
  definition: SurveyDefinition;
  kept: ProtectedItem[];
  liveResponses: number;
}

export async function guardLiveData(
  db: Db, surveyId: string, incoming: SurveyDefinition,
  /** what the row holds now, when the caller has already read it; `undefined` = read it here */
  preImage?: SurveyDefinition | null,
): Promise<LiveDataGuardResult> {
  let liveResponses = 0;
  try { liveResponses = await liveResponseTotal(db, surveyId); } catch { liveResponses = 0; }
  if (liveResponses <= 0) return { definition: incoming, kept: [], liveResponses };

  const baselines: SurveyDefinition[] = [];
  const parse = (raw: unknown) => { const p = SurveyDefinition.safeParse(raw); if (p.success) baselines.push(p.data); };
  try {
    const { data: deps } = await db.from("deployments").select("version_id").eq("survey_id", surveyId).eq("mode", "live").eq("active", true);
    for (const d of (deps ?? []) as { version_id: string }[]) {
      const { data: v } = await db.from("survey_versions").select("definition").eq("id", d.version_id).single();
      if (v?.definition) parse(v.definition);
    }
  } catch { /* the pre-image below still protects what the editor last held */ }
  if (preImage) baselines.push(preImage);
  else if (preImage === undefined) {
    try {
      const { data: cur } = await db.from("surveys").select("draft_definition, current_version_id").eq("id", surveyId).single();
      let raw: unknown = cur?.draft_definition ?? null;
      if (!raw && cur?.current_version_id) {
        const { data: v } = await db.from("survey_versions").select("definition").eq("id", cur.current_version_id).single();
        raw = v?.definition ?? null;
      }
      if (raw) parse(raw);
    } catch { /* nothing more to compare with */ }
  }

  let definition = incoming;
  const kept: ProtectedItem[] = [];
  for (const before of baselines) {
    const r = protectCollectedData(before, definition);
    if (r.changed || r.restored.length) { definition = r.def; kept.push(...r.restored); }
  }
  return { definition, kept, liveResponses };
}
