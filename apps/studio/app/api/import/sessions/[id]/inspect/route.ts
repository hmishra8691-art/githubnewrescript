import { NextRequest, NextResponse } from "next/server";
import type { CanonicalSurvey, CFlow } from "@rescript/import";
import { callerFrom, canSee, notFound } from "@/lib/import/sessionAccess";
import { importSessionStore } from "@/lib/import/sessionsServer";
import { isFailure, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE SOURCE OF ONE IMPORTED ELEMENT (I7 inspector): `?source=<source id>` → the element as the reader understood
 * the source (a question with its options, logic, skips, custom code and notes; or a flow element), plus the
 * issues about it. The browser shows it beside the reconstructed Rescript element it already holds. Read-only.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const store = importSessionStore();
  const s = await store.get(params.id).catch(() => null);
  if (isFailure(authed) && !(s && s.customerId === null)) return authed.response;
  const caller = callerFrom(authed, !!s && s.customerId === null);
  if ("response" in caller) return caller.response;
  if (!s || !canSee(s, caller)) return notFound();
  const c = s.canonical as CanonicalSurvey | null;
  if (!c) return NextResponse.json({ error: "This import's reconstructed model was not kept." }, { status: 410 });
  const source = (req.nextUrl.searchParams.get("source") ?? "").slice(0, 200);
  const question = c.questions.find((q) => q.sourceId === source);
  let flow: CFlow | null = null;
  const walk = (fs: CFlow[]) => { for (const f of fs) { if (f.sourceId === source) { flow = f; return; } if ("children" in f) walk(f.children); } };
  if (!question) walk(c.flow);
  if (!question && !flow) return NextResponse.json({ error: `No element ${source} in this import.` }, { status: 404 });
  const issues = c.issues.filter((i) => i.refs?.includes(source) || i.location.startsWith(source)).slice(0, 50);
  /* a flow element's children are listed by id only — the inspector is about this element */
  const shallow = flow ? JSON.parse(JSON.stringify(flow, (k, v) => (k === "children" && Array.isArray(v) ? v.map((x: { t: string; sourceId: string }) => `${x.t}:${x.sourceId}`) : v))) : null;
  return NextResponse.json({ kind: question ? "question" : "flow", source: question ?? shallow, issues });
}
