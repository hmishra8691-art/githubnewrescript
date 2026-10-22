import { NextRequest, NextResponse } from "next/server";
import { QualStudy } from "@rescript/schema";
import { interviewCounts, launchProblems, moderationOf, type InterviewSummary } from "@rescript/engine";
import { sandboxStore } from "@/lib/aiInterview/runtimeDeps";
import { planFor } from "@/lib/aiInterview/service";

export const dynamic = "force-dynamic";

/**
 * THE STUDIO SANDBOX'S AI INTERVIEWS — a runtime with NO database and the FAKE provider keeps launched
 * studies and their interviews in memory (memoryStore.ts), so an unsaved project and the browser suite
 * can run the whole path: launch → link → interviews → live view → transcripts into the sandbox's
 * coding workspace. Refused (403) everywhere else: a real installation's studies live in 0069 and are
 * read by the Studio's own routes with the member's access checked. Nothing here is real or costs
 * anything; the observer key (returned once, at launch) is what the sandbox reads with.
 *
 *   { action: "launch", guide, title, guideLanguage }   → { linkToken, testToken, observerKey }
 *   { action: "list", observerKey }                     → the live view (counts, quotas, interviews)
 *   { action: "interview", observerKey, id }            → one interview's turns (live transcript)
 *   { action: "end" | "exclude" | "include", observerKey, id, reason? }
 *   { action: "status", observerKey, status: live | paused | closed }
 */
export async function POST(req: NextRequest) {
  const store = sandboxStore();
  if (!store) return NextResponse.json({ error: "the sandbox's AI interviews exist only on a runtime with no database and the fake provider" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");
  if (action === "launch") {
    const g = QualStudy.safeParse(body.guide);
    if (!g.success) return NextResponse.json({ error: "send the interview guide (qualStudy)" }, { status: 400 });
    const check = launchProblems(g.data);
    if (check.blocking.length) return NextResponse.json({ error: check.blocking[0], blocking: check.blocking }, { status: 400 });
    const { study, observerKey } = store.launch(g.data, { title: String(body.title ?? g.data.title ?? "AI interviews"), guideLanguage: typeof body.guideLanguage === "string" ? body.guideLanguage : "en" });
    return NextResponse.json({ ok: true, studyId: study.id, linkToken: study.linkToken, testToken: study.testToken, observerKey, warnings: check.warnings });
  }
  const study = store.studyForObserver(String(body.observerKey ?? ""));
  if (!study) return NextResponse.json({ error: "unknown study" }, { status: 404 });
  const id = String(body.id ?? "");
  if (action === "status") {
    const st = body.status === "paused" || body.status === "closed" || body.status === "live" ? body.status : null;
    if (!st) return NextResponse.json({ error: "status is live, paused or closed" }, { status: 400 });
    store.setStudyStatus(study.id, st);
  } else if (action === "end") {
    if (!store.endSession(id)) return NextResponse.json({ error: "that interview is not in progress" }, { status: 409 });
  } else if (action === "exclude" || action === "include") {
    if (!store.excludeSession(id, action === "exclude", typeof body.reason === "string" ? body.reason.slice(0, 300) : undefined)) return NextResponse.json({ error: "no such interview" }, { status: 404 });
  } else if (action !== "list" && action !== "interview") return NextResponse.json({ error: "unknown action" }, { status: 400 });

  const sessions = store.sessionsOf(study.id);
  if (action === "interview") {
    const s = sessions.find((x) => x.id === id);
    if (!s) return NextResponse.json({ error: "no such interview" }, { status: 404 });
    return NextResponse.json({ ok: true, id: s.id, participant: `P${s.participantNumber}`, status: s.status, turns: s.turns.map((t) => ({ seq: t.seq, speaker: t.speaker, text: t.text, originalText: t.originalText ?? null, translation: t.translation ?? null, at: t.offsetMs, decision: t.decision ?? null })), flags: s.flags, transcript: s.qual?.transcript ?? null }, { headers: { "cache-control": "no-store" } });
  }
  const rows: InterviewSummary[] = sessions.map((s) => ({
    id: s.id, participant: `P${s.participantNumber}`, segment: s.segment, mode: s.mode, language: s.language, status: s.status, excluded: s.excluded, isTest: s.isTest,
    flags: s.flags, turns: s.turnsCount, costUsd: s.costUsd, startedAt: new Date(s.startedAt).toISOString(), lastActivityAt: new Date(s.lastActivity).toISOString(),
    minutes: Math.round(((s.completedAt ?? s.lastActivity) - s.startedAt) / 6000) / 10, covered: s.state?.covered ?? [], qualTranscriptId: s.qual ? `mem-qt-${s.id}` : null,
  }));
  const cfg = moderationOf(study.guide);
  const plan = planFor(study);
  return NextResponse.json({
    ok: true,
    study: { id: study.id, title: study.title, status: study.status, linkToken: study.linkToken, testToken: study.testToken, spentUsd: study.spentUsd, objectives: plan.objectives, modes: cfg.modes, languages: plan.languages },
    ...interviewCounts(rows, cfg),
    interviews: rows,
    /* the finished transcripts, for the sandbox's coding workspace (a saved project's are written to its tables) */
    transcripts: sessions.filter((s) => s.qual && !s.excluded).map((s) => ({ id: s.id, title: s.qual!.title, transcript: s.qual!.transcript })),
  }, { headers: { "cache-control": "no-store" } });
}
