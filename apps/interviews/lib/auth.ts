import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { handoffStartUrl, normaliseOrigin } from "@rescript/access";
import { supabaseAdmin } from "./admin";

/**
 * WHO IS ASKING — THE SAME SESSION THE STUDIO ISSUED.
 *
 * Rescript Interviews does not have its own sign-in, its own cookie or its
 * own idea of a person, and the reason is worth stating plainly: a second
 * authentication system is a second place to get authentication wrong, and
 * the failure mode is not a bug report, it is an incident.
 *
 * So this reads the cookie the Studio's `authServer.ts` sets — an opaque
 * `user_sessions.id`, `httpOnly`, verified server-side on every request — and
 * asks the same database the same question. A session revoked in the Studio
 * is revoked here on the next request, because there is nothing cached and
 * nothing signed: the cookie is a pointer, and the row is the truth.
 *
 * The one thing this file does NOT share is the project model. A survey's
 * roles live in `project_members`; an interview project's live in
 * `interview_project_members`, because a REVIEWER — somebody who watches
 * recordings and assesses against requirements — has no survey equivalent,
 * and bolting it onto the survey vocabulary would mean a role that means one
 * thing in one product and nothing in the other.
 */

/** The same constant `apps/studio/lib/authServer.ts` writes. Do not rename one without the other. */
export const SESSION_COOKIE_NAME = "rescript_session";

/** Seconds a session may be idle before it stops authorizing. Matches the Studio's default. */
const STALE_SECONDS = 15 * 60;
const ABSOLUTE_SECONDS = 12 * 60 * 60;

export interface AuthedUser {
  userId: string;
  sessionId: string;
  customerId: string | null;
  email: string;
  fullName: string;
  isPlatformAdmin: boolean;
}

export type GuardFailure = { response: NextResponse };

export function isFailure<T>(v: T | GuardFailure): v is GuardFailure {
  return !!v && typeof v === "object" && "response" in (v as object);
}

function fail(status: number, error: string): GuardFailure {
  return { response: NextResponse.json({ error }, { status }) };
}

export function sessionIdFrom(req: NextRequest): string | null {
  const v = req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
  /* the Studio's own rule: anything shorter than a uuid is not one */
  return v && v.length >= 32 ? v : null;
}

/**
 * Write the session cookie on THIS origin.
 *
 * Every attribute matches `apps/studio/lib/authServer.ts` deliberately — same
 * name, `httpOnly`, `sameSite: lax`, `secure` in production, path `/` — so
 * that a person signed in through the handoff is in exactly the state the
 * Studio would have put them in, not a slightly different one that behaves
 * differently under a cross-site POST.
 *
 * Notably there is still NO `domain`. This cookie is host-only too; the
 * handoff is what crosses the origin, once, and nothing about it makes the
 * cookie itself travel.
 */
export function setSessionCookie(res: NextResponse, sessionId: string): void {
  res.cookies.set(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ABSOLUTE_SECONDS,
  });
}

/**
 * Where to send somebody who is not signed in.
 *
 * The Studio's `/api/auth/handoff` checks their session there — where the
 * cookie is valid — and redirects back to `/api/auth/callback` with a
 * single-use code. Pointing at `/login` instead is what the sign-in card used
 * to do, and it could not work: they would sign in on the Studio's origin and
 * return here still signed out.
 */
export function signInUrl(next = "/"): string | null {
  return handoffStartUrl(studioUrl(), publicOrigin(), next);
}

/**
 * Where Rescript Studio is.
 *
 * The same default `signInUrl` has always used, lifted out so the two callers
 * cannot drift: this is both where sign-in happens and where a signed-in person
 * goes to get back to their surveys. A person who arrives here through the
 * Studio's Interviews link and finds no way back has been handed a one-way
 * door, and the browser Back button is not a navigation design.
 *
 * No handoff is needed in this direction. The Studio is where the session was
 * minted, so its own cookie is already on that origin — this is a plain link.
 */
export function studioUrl(): string {
  const raw = (process.env.NEXT_PUBLIC_STUDIO_URL ?? "").trim() || "https://rescriptstudio.vercel.app";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

/**
 * This app's own origin, as the Studio must be told it.
 *
 * It has to be the deployed public origin rather than whatever host the
 * request arrived on, because the code is bound to this exact string at both
 * ends: minted for it, redeemed against it. A Vercel preview URL reaching the
 * Studio under its own hostname would mint a code it could never spend, which
 * is the correct outcome and a confusing one, so `INTERVIEWS_PUBLIC_URL` is
 * the single place that decides.
 */
export function publicOrigin(): string {
  return normaliseOrigin(process.env.INTERVIEWS_PUBLIC_URL) ?? "";
}

/**
 * The person behind a session id, or a response saying why not.
 *
 * The status codes are the Studio's, deliberately, because the two apps are
 * one product to whoever is signed in and a 401 from one and a 403 from the
 * other for the same reason is how a login loop starts.
 *
 *   401 no session, or one that has ended
 *   403 the account is disabled
 *   503 we could not check — the cookie is KEPT, because signing somebody out
 *       because the database hiccuped is the worst possible response to a
 *       database hiccup
 */
export async function userForSession(sessionId: string | null): Promise<AuthedUser | GuardFailure> {
  if (!sessionId) return fail(401, "Not signed in.");
  const db = supabaseAdmin();

  const { data, error } = await db.rpc("rescript_touch_session", {
    p_session: sessionId,
    p_stale_seconds: STALE_SECONDS,
    p_absolute_seconds: ABSOLUTE_SECONDS,
  });
  if (error) return fail(503, "We could not check your session. Please try again.");

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || row.status !== "active") {
    const res = NextResponse.json({ error: "Your session has ended. Please sign in again." }, { status: 401 });
    /* a dead session's cookie is cleared, or every page load redirects to a
       login that redirects back — the loop the Studio's failAndSignOut fixed */
    res.cookies.set(SESSION_COOKIE_NAME, "", { path: "/", maxAge: 0, httpOnly: true });
    return { response: res };
  }

  const { data: profile, error: perr } = await db
    .from("profiles")
    .select("id, customer_id, email, full_name, role, status")
    .eq("id", row.user_id)
    .maybeSingle();
  if (perr) return fail(503, "We could not check your account. Please try again.");
  if (!profile) return fail(401, "Your account could not be found.");
  if (profile.status !== "active") return fail(403, "This account has been disabled.");

  return {
    userId: profile.id,
    sessionId,
    customerId: profile.customer_id ?? null,
    email: profile.email ?? "",
    fullName: profile.full_name ?? "",
    isPlatformAdmin: profile.role === "platform_admin",
  };
}

export async function requireUser(req: NextRequest): Promise<AuthedUser | GuardFailure> {
  return userForSession(sessionIdFrom(req));
}

/* ------------------------------------------------------ project access */

export const INTERVIEW_ROLES = ["manager", "interviewer", "reviewer", "viewer"] as const;
export type InterviewRole = (typeof INTERVIEW_ROLES)[number];

/**
 * WHAT EACH ROLE MAY DO.
 *
 * Mirrors `packages/access`'s shape — a capability list per role, one `can`
 * — rather than importing its grants, because the capabilities are genuinely
 * different. `interview.review` has no survey equivalent, and `survey.edit`
 * has no meaning here.
 *
 * The important line is `media.read`. Watching a candidate's recording is a
 * separate capability from seeing that the interview exists, so a `viewer`
 * can follow progress on a hiring project without being able to play anyone's
 * video. That distinction is the difference between a dashboard a whole team
 * can see and a privacy incident.
 */
export const INTERVIEW_CAPABILITIES = [
  "project.read",
  "project.edit",
  "project.delete",
  "project.manage_members",
  "questions.edit",
  "requirements.edit",
  "candidates.read",
  "candidates.invite",
  "candidates.delete",
  "media.read",
  "media.download",
  "transcript.read",
  "analysis.read",
  "analysis.run",
  "review.write",
  "billing.read",
  "billing.set_budget",
  "retention.manage",
  /*
   * Who a person IS beyond their display name — an email address. Split from
   * `candidates.read` because a `viewer` follows progress and a `reviewer`
   * assesses answers, and neither needs to be able to email the respondent.
   * The roster and the participant lists strip the address without it.
   */
  "identity.read",
] as const;
export type InterviewCapability = (typeof INTERVIEW_CAPABILITIES)[number];

const GRANTS: Record<InterviewRole, InterviewCapability[]> = {
  /* the person who set the project up, or somebody they trust with it */
  manager: [...INTERVIEW_CAPABILITIES],
  /* runs the hiring: invites people, edits the bank, reads everything */
  interviewer: [
    "project.read", "project.edit", "questions.edit", "requirements.edit",
    "candidates.read", "candidates.invite", "media.read", "media.download",
    "transcript.read", "analysis.read", "analysis.run", "review.write", "billing.read",
    "identity.read",
  ],
  /* watches and assesses; changes nothing about the project itself */
  reviewer: [
    "project.read", "candidates.read", "media.read",
    "transcript.read", "analysis.read", "review.write",
  ],
  /* follows progress. Deliberately CANNOT play a recording. */
  viewer: ["project.read", "candidates.read", "analysis.read"],
};

export function can(role: InterviewRole | null | undefined, capability: InterviewCapability): boolean {
  return !!role && GRANTS[role].includes(capability);
}

export function capabilitiesOf(role: InterviewRole | null): InterviewCapability[] {
  return role ? [...GRANTS[role]] : [];
}

export interface ProjectContext {
  user: AuthedUser;
  projectId: string;
  role: InterviewRole;
  /** `owner` · `member` · `workspace` — where the role came from, for the UI to explain. */
  source: "owner" | "member" | "workspace";
  project: {
    id: string;
    customer_id: string;
    owner_id: string | null;
    code: string;
    name: string;
    status: string;
    settings: Record<string, unknown>;
    retention_days: number | null;
    retention_scope: Record<string, boolean>;
    max_recording_seconds: number | null;
    max_storage_bytes: number | null;
    max_transcription_seconds: number | null;
    max_ai_analyses: number | null;
  };
}

/**
 * The workspace baseline.
 *
 * Everyone in the same workspace can SEE a project — which is what makes a
 * shared hiring pipeline usable — and can do nothing else to it. Anything
 * more needs a row in `interview_project_members`. The survey product made
 * the same choice with `WorkspaceAccessPolicy`; the difference is that this
 * baseline is `viewer` rather than `editor`, because an interview holds a
 * named person's recorded answers and the default should be the careful one.
 */
const WORKSPACE_BASELINE: InterviewRole = "viewer";

export async function requireProject(
  req: NextRequest, projectId: string, capability: InterviewCapability,
): Promise<ProjectContext | GuardFailure> {
  const user = await requireUser(req);
  if (isFailure(user)) return user;
  return requireProjectFor(user, projectId, capability);
}

export async function requireProjectFor(
  user: AuthedUser, projectId: string, capability: InterviewCapability,
): Promise<ProjectContext | GuardFailure> {
  const db = supabaseAdmin();
  const { data: project, error } = await db
    .from("interview_projects")
    .select("id, customer_id, owner_id, code, name, status, settings, retention_days, retention_scope, max_recording_seconds, max_storage_bytes, max_transcription_seconds, max_ai_analyses, deleted_at")
    .eq("id", projectId)
    .maybeSingle();
  if (error) return fail(503, "We could not check that project. Please try again.");
  /*
   * 404 for "not yours", exactly as the Studio does. Distinguishing "does not
   * exist" from "exists and you may not see it" tells an outsider which
   * project ids are real, which is a small leak that costs nothing to close.
   */
  if (!project || project.deleted_at) return fail(404, "That project does not exist.");

  let role: InterviewRole | null = null;
  let source: ProjectContext["source"] = "workspace";

  if (project.owner_id && project.owner_id === user.userId) {
    role = "manager";
    source = "owner";
  } else {
    const { data: member } = await db
      .from("interview_project_members")
      .select("role")
      .eq("project_id", projectId)
      .eq("user_id", user.userId)
      .maybeSingle();
    if (member?.role && (INTERVIEW_ROLES as readonly string[]).includes(member.role)) {
      role = member.role as InterviewRole;
      source = "member";
    } else if (user.customerId && user.customerId === project.customer_id) {
      role = WORKSPACE_BASELINE;
      source = "workspace";
    }
  }

  if (!role) return fail(404, "That project does not exist.");
  if (!can(role, capability)) {
    return fail(403, `Your role on this project (${role}) does not allow that.`);
  }

  const { deleted_at: _deleted, ...rest } = project as Record<string, unknown> & { deleted_at: unknown };
  return { user, projectId, role, source, project: rest as ProjectContext["project"] };
}

/** For a server component: the same decision, without a NextRequest. */
export type PageGate =
  | { ok: true; ctx: ProjectContext }
  | { ok: false; kind: "signed_out" | "unknown" | "forbidden"; message: string };

export async function projectPageGate(
  sessionId: string | null, projectId: string, capability: InterviewCapability,
): Promise<PageGate> {
  const user = await userForSession(sessionId);
  if (isFailure(user)) {
    const status = user.response.status;
    if (status === 401) return { ok: false, kind: "signed_out", message: "Please sign in." };
    return { ok: false, kind: "forbidden", message: "You cannot open this project." };
  }
  const ctx = await requireProjectFor(user, projectId, capability);
  if (isFailure(ctx)) {
    const status = ctx.response.status;
    return {
      ok: false,
      kind: status === 404 ? "unknown" : "forbidden",
      message: status === 404 ? "That project does not exist." : "You cannot open this project.",
    };
  }
  return { ok: true, ctx };
}
