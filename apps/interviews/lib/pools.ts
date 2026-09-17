import "server-only";
import { supabaseAdmin } from "./admin";
import { readSelection } from "./candidate";

/**
 * Where a pool's draw configuration is written.
 *
 * `draw` lives on the pool row; `randomize` per pool and `randomizePools` for
 * the project live in `interview_projects.selection`. `readSelection` is the
 * other half — the reader the candidate path uses — so the two cannot drift.
 */

/** null means "all of them"; anything else is a whole number of questions to draw */
export function drawOf(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export async function setRandomize(projectId: string, poolId: string, randomize: boolean): Promise<void> {
  const db = supabaseAdmin();
  const { data: project } = await db.from("interview_projects").select("selection").eq("id", projectId).maybeSingle();
  const sel = readSelection(project?.selection);
  const pools = sel.pools.filter((p) => p.id !== poolId);
  pools.push({ id: poolId, draw: null, randomize });
  await db.from("interview_projects")
    .update({ selection: { pools, randomizePools: sel.randomizePools }, updated_at: new Date().toISOString() })
    .eq("id", projectId);
}

export async function setRandomizePools(projectId: string, randomizePools: boolean): Promise<void> {
  const db = supabaseAdmin();
  const { data: project } = await db.from("interview_projects").select("selection").eq("id", projectId).maybeSingle();
  const sel = readSelection(project?.selection);
  await db.from("interview_projects")
    .update({ selection: { pools: sel.pools, randomizePools }, updated_at: new Date().toISOString() })
    .eq("id", projectId);
}

export async function forgetPool(projectId: string, poolId: string): Promise<void> {
  const db = supabaseAdmin();
  const { data: project } = await db.from("interview_projects").select("selection").eq("id", projectId).maybeSingle();
  const sel = readSelection(project?.selection);
  await db.from("interview_projects")
    .update({ selection: { pools: sel.pools.filter((p) => p.id !== poolId), randomizePools: sel.randomizePools } })
    .eq("id", projectId);
}
