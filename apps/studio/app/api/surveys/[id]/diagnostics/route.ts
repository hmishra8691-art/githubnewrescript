import { NextRequest, NextResponse } from "next/server";
import { can, lockStatus, roleSourceNote, sessionStatus, type SessionRecord } from "@rescript/access";
import { supabaseService } from "@/lib/authServer";
import { isFailure, loadLock, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * SESSION AND PERSISTENCE DIAGNOSTICS (§27).
 *
 * The whole point of this endpoint is that the next report of "it did not
 * save" is answered in thirty seconds instead of becoming another
 * investigation. Every P0 in this round was diagnosed by hand, from the
 * database, by somebody who could write SQL — and three of the diagnoses
 * contradicted what the symptom looked like. This is that same query,
 * available to the person actually experiencing the problem.
 *
 * It answers, in one place, the questions that were each a separate mystery:
 *
 *   · is my session alive, and how long until it is not?
 *   · which session am I, and was an earlier one of mine displaced?
 *   · do I hold the edit lock, and if not, who does, and are they even here?
 *   · what revision is the server on, and what revision is my editor on?
 *   · when did a save last actually succeed?
 *   · why do I have the access I have — ownership, a share, or my workspace?
 *
 * WHAT IT DELIBERATELY DOES NOT CONTAIN. §27 says a debug view must not
 * expose sensitive secrets, so: no tokens (there are none to leak — Supabase's
 * are discarded at login), no service key, no password material, no IP
 * addresses or their hashes, no other user's email, and no survey content.
 * Names and user codes of collaborators are included because they are already
 * on screen in the presence list; everything else is timings and state.
 *
 * WHO CAN SEE IT. Anyone who can read the project, in development. In
 * production it additionally requires either a platform administrator or an
 * explicit `RESCRIPT_DIAGNOSTICS=1` on the deployment — so a customer can be
 * asked to turn it on for an afternoon while a problem is chased, and it is
 * off again afterwards without a code change.
 */
function diagnosticsEnabled(isPlatformAdmin: boolean): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  if (process.env.RESCRIPT_DIAGNOSTICS === "1") return true;
  return isPlatformAdmin;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;

  const { user, role, roleSource } = gate;
  if (!diagnosticsEnabled(user.isPlatformAdmin)) {
    return NextResponse.json(
      { error: "Diagnostics are not enabled on this deployment.", code: "diagnostics_disabled" },
      { status: 404 },
    );
  }

  const db = supabaseService();
  const now = Date.now();

  const [sessionRes, surveyRes, lock, mySessionsRes] = await Promise.all([
    db.from("user_sessions")
      .select("id, status, created_at, last_seen_at, expires_at, ended_at, ended_reason, device_label")
      .eq("id", user.sessionId).maybeSingle(),
    db.from("surveys")
      .select("id, code, revision, draft_updated_at, updated_at, current_version_id, locked, owner_id")
      .eq("id", params.id).maybeSingle(),
    loadLock(params.id),
    /*
     * Every session this account has had recently, so "I signed in on my
     * laptop and my desktop stopped working" is visible as the takeover it
     * was rather than as a mystery. Capped and ordered so this cannot become
     * an accidental full-table read.
     */
    db.from("user_sessions")
      .select("id, status, created_at, last_seen_at, ended_at, ended_reason, device_label")
      .eq("user_id", user.userId)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const s = sessionRes.data;
  const record: SessionRecord | null = s
    ? {
        sessionId: s.id, userId: user.userId,
        status: s.status as SessionRecord["status"],
        createdAt: s.created_at, lastSeenAt: s.last_seen_at,
        expiresAt: s.expires_at, deviceLabel: s.device_label,
      }
    : null;

  const sPolicy = user.policies.session;
  const lPolicy = user.policies.lock;
  const secondsSince = (iso: string | null | undefined) =>
    iso ? Math.round((now - Date.parse(iso)) / 1000) : null;

  const lockState = lockStatus(lock, lPolicy);
  const iHoldLock = !!lock && lock.lockedBySessionId === user.sessionId && lockState === "held";

  return NextResponse.json(
    {
      generatedAt: new Date(now).toISOString(),
      /*
       * Read this first when a save is being refused. It is the same three
       * conditions the gate checks, in the same order, so a false here is the
       * answer rather than the beginning of a search.
       */
      canSaveRightNow: {
        result: can(role, "survey.edit") && iHoldLock && !surveyRes.data?.locked,
        roleAllowsEditing: can(role, "survey.edit"),
        thisSessionHoldsTheLock: iHoldLock,
        projectFrozenByOwner: !!surveyRes.data?.locked,
      },
      session: record
        ? {
            id: record.sessionId,
            storedStatus: record.status,
            effectiveStatus: sessionStatus(record, sPolicy),
            device: record.deviceLabel,
            startedAt: record.createdAt,
            lastHeartbeatAt: record.lastSeenAt,
            secondsSinceHeartbeat: secondsSince(record.lastSeenAt),
            idleAfterSeconds: sPolicy.idleAfterSeconds,
            releasedAfterSeconds: sPolicy.staleAfterSeconds,
            absoluteLifetimeSeconds: sPolicy.absoluteLifetimeSeconds,
            expiresAt: record.expiresAt,
            endedAt: s?.ended_at ?? null,
            endedReason: s?.ended_reason ?? null,
          }
        : { id: user.sessionId, storedStatus: "missing", effectiveStatus: "expired" },
      /** every recent session for this account — a takeover is visible here */
      myRecentSessions: ((mySessionsRes.data ?? []) as {
        id: string; status: string; created_at: string; last_seen_at: string;
        ended_at: string | null; ended_reason: string | null; device_label: string | null;
      }[]).map((r) => ({
        id: r.id,
        isThisOne: r.id === user.sessionId,
        status: r.status,
        device: r.device_label,
        startedAt: r.created_at,
        lastHeartbeatAt: r.last_seen_at,
        endedAt: r.ended_at,
        endedReason: r.ended_reason,
      })),
      access: {
        role,
        roleSource,
        why: roleSourceNote(roleSource),
        viaPlatformAdmin: gate.viaAdmin,
        /** the workspace baseline, so "why can my colleague edit this" has an answer */
        workspaceDefaultRole: user.policies.workspace.defaultRole,
      },
      lock: {
        status: lockState,
        mine: iHoldLock,
        heldByUserCode: lock?.lockedByUserCode ?? null,
        heldByName: lock?.lockedByName ?? null,
        heldBySessionId: lock?.lockedBySessionId ?? null,
        /** P0-8: a lock is only as alive as the session behind it */
        holderSessionLive: lock?.holderSessionLive ?? null,
        acquiredAt: lock?.createdAt ?? null,
        lastHeartbeatAt: lock?.lastHeartbeatAt ?? null,
        secondsSinceHeartbeat: secondsSince(lock?.lastHeartbeatAt),
        takeableAfterSeconds: lPolicy.staleAfterSeconds,
        maxHoldSeconds: lPolicy.maxHoldSeconds,
        expiresAt: lock?.expiresAt ?? null,
      },
      persistence: {
        /*
         * The authoritative store, which is the whole answer to "where does
         * my work live". Not localStorage, not React state, not IndexedDB —
         * this row, with this revision.
         */
        surveyId: surveyRes.data?.id ?? null,
        code: surveyRes.data?.code ?? null,
        serverRevision: surveyRes.data?.revision ?? null,
        revisionGuardActive: surveyRes.data?.revision != null,
        lastDraftSaveAt: surveyRes.data?.draft_updated_at ?? null,
        secondsSinceLastDraftSave: secondsSince(surveyRes.data?.draft_updated_at),
        lastRowChangeAt: surveyRes.data?.updated_at ?? null,
        currentVersionId: surveyRes.data?.current_version_id ?? null,
        frozenByOwner: !!surveyRes.data?.locked,
      },
      /**
       * The client fills these in from its own state before showing the
       * panel. They are here so the shape is documented in one place: a
       * mismatch between `serverRevision` and the editor's revision is
       * precisely the stale-write condition, and seeing the two side by side
       * is the fastest way to recognise it.
       */
      clientShouldReport: ["editorRevision", "saveState", "unsavedChanges"],
    },
    { headers: { "cache-control": "no-store" } },
  );
}
