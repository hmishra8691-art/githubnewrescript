import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { getCachedVersionDefinition } from "@rescript/quality/server";

/**
 * THE CACHEABLE HALF OF THE RESPONDENT RUNTIME (P0-1: Fast Origin Transfer).
 *
 * A published version's definition is frozen the moment it is cut (the
 * database trigger from migration 0012) and can never change under its own
 * id — a content change always produces a NEW version, and therefore a new
 * `versionId`. That makes it exactly the kind of content Vercel's CDN should
 * serve without ever coming back to this function: `max-age=31536000,
 * immutable` is safe forever, because there is no invalidation problem to
 * solve. There is nothing here a respondent could not already see — the
 * survey page already sends this same version id to the browser
 * (`sessionBoot.versionDbId`) and, until this route existed, embedded this
 * exact JSON inline in its own always-dynamic response.
 *
 * Before this route, `apps/runtime/app/s/[client]/[study]/page.tsx` embedded
 * the full definition in a `force-dynamic` server component, so every single
 * respondent hit re-transferred the whole survey JSON from Vercel's compute
 * straight through to the edge with no caching anywhere — the dominant
 * driver of Fast Origin Transfer for this platform, since respondent volume
 * dwarfs admin volume. Moving the definition to its own cacheable-by-id GET
 * lets the CDN answer every hit after the first one per version, for free.
 *
 * Deliberately NOT used for a TEST link's build (`loadTestBuild`): a draft
 * changes on every autosave, so caching it by id would serve stale content
 * the moment the programmer typed another character. Only the immutable,
 * published VERSION path is served this way.
 */
export async function GET(_req: NextRequest, { params }: { params: { versionId: string } }) {
  if (!/^[0-9a-f-]{36}$/i.test(params.versionId)) {
    return NextResponse.json({ error: "not found" }, { status: 404, headers: { "cache-control": "no-store" } });
  }

  const db = supabaseAdmin();
  const definition = await getCachedVersionDefinition(db, params.versionId);
  if (!definition) {
    // Not "unknown forever" — a version id that doesn't resolve today could
    // in principle be a migration/ordering hiccup, so this specific miss is
    // NOT cached, only successful, immutable hits are.
    return NextResponse.json({ error: "not found" }, { status: 404, headers: { "cache-control": "no-store" } });
  }

  return NextResponse.json(definition, {
    headers: { "cache-control": "public, max-age=31536000, immutable" },
  });
}
