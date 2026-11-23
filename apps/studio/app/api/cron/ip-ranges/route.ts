import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { FREE_IP_SOURCES, parseIpRanges, operatorFeed, type IpRangeKind } from "@rescript/quality";
import { platformDb } from "@/lib/db";

/**
 * F2 — REFRESH THE PUBLISHED ADDRESS RANGES (daily; migration 0117).
 *
 * Downloads each free list (cloud and hosting networks, Tor exits — @rescript/quality FREE_IP_SOURCES), checks it
 * parsed to a plausible number of ranges, and swaps that source's rows in one transaction. A list that fails to
 * download, parses to too few ranges, or is refused by the database keeps its previous rows and records the error
 * on ip_range_sources — a bad download never empties the table the gateway reads.
 *
 * The licensed layer: IP_REPUTATION_FEED_URL (optionally with IP_REPUTATION_FEED_TOKEN, sent as a bearer token) is
 * a plain `cidr,kind` CSV — VPN and proxy ranges from whichever vendor is licensed — loaded as sources feed_<kind>.
 *
 * Authorised by CRON_SECRET like every other job.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FETCH_MS = 15_000;
const MISSING_0117 = "The address-range tables need migration 0117 (ip_ranges), which has not been applied to this database.";

function authorised(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(offered), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// the bearer token is checked in each handler's FIRST statement (the auth-guard audit's rule for a scheduler route)
export async function GET(req: Request) { if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 }); return run(); }
export async function POST(req: Request) { if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 }); return run(); }

async function download(url: string, headers: Record<string, string> = {}): Promise<string> {
  const r = await fetch(url, { headers: { "user-agent": "rescript-ip-ranges/1", ...headers }, signal: AbortSignal.timeout(FETCH_MS), cache: "no-store" });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.text();
}

async function run() {
  const db = platformDb();
  const results: { source: string; ranges?: number; skipped?: number; error?: string }[] = [];
  const fail = async (source: string, kind: IpRangeKind, provider: string, error: string) => {
    results.push({ source, error });
    await db.from("ip_range_sources").upsert({ source, kind, provider, last_error: error.slice(0, 500), checked_at: new Date().toISOString() }, { onConflict: "source" });
  };
  const store = async (source: string, kind: IpRangeKind, provider: string, cidrs: string[], skipped: number) => {
    const { data, error } = await db.rpc("rescript_ip_ranges_replace", { p_source: source, p_kind: kind, p_provider: provider, p_cidrs: cidrs });
    if (error) { await fail(source, kind, provider, error.message); return /ip_ranges|does not exist|schema cache/i.test(error.message); }
    results.push({ source, ranges: Number(data ?? cidrs.length), skipped });
    return false;
  };

  for (const src of FREE_IP_SOURCES) {
    try {
      const cidrs = new Set<string>();
      let skipped = 0;
      for (const url of src.urls) {
        const parsed = parseIpRanges(src.format, await download(url));
        for (const c of parsed.cidrs) cidrs.add(c);
        skipped += parsed.skipped;
      }
      if (cidrs.size < src.minRanges) { await fail(src.id, src.kind, src.provider, `only ${cidrs.size} ranges parsed (expected at least ${src.minRanges}) — the previous list is kept`); continue; }
      if (await store(src.id, src.kind, src.provider, [...cidrs], skipped)) return NextResponse.json({ error: MISSING_0117, results }, { status: 503 });
    } catch (e) {
      await fail(src.id, src.kind, src.provider, (e as Error).message).catch(() => {});
    }
  }

  const feedUrl = (process.env.IP_REPUTATION_FEED_URL ?? "").trim();
  if (/^https:\/\//i.test(feedUrl)) {
    try {
      const token = (process.env.IP_REPUTATION_FEED_TOKEN ?? "").trim();
      const feed = operatorFeed(await download(feedUrl, token ? { authorization: `Bearer ${token}` } : {}));
      for (const kind of Object.keys(feed.byKind) as IpRangeKind[]) {
        const cidrs = feed.byKind[kind];
        if (cidrs.length) await store(`feed_${kind}`, kind, "Licensed feed", cidrs, feed.skipped);
      }
    } catch (e) {
      results.push({ source: "feed", error: (e as Error).message });
    }
  }
  console.info("[rescript:ip-ranges]", JSON.stringify(results));
  return NextResponse.json({ ok: true, results });
}
