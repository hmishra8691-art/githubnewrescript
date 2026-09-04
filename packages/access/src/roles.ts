/**
 * PROJECT AUTHORIZATION — roles and capabilities.
 *
 * The requirement is emphatic that authentication, authorization, session and
 * edit lock are four different questions and must not collapse into one
 * boolean. This file answers exactly one of them:
 *
 *     "What is this user allowed to do with this project?"
 *
 * and it answers it with a CAPABILITY, never with a role comparison. Code
 * asks `can(role, "survey.edit")`, never `role === "editor" || role ===
 * "owner"` — because the second form has to be found and corrected in twenty
 * places every time a role is added, and one of them always gets missed.
 * Adding a role here is adding a row to a table.
 *
 * Pure and dependency-free: the same module decides the answer in an API
 * route, in the Studio's UI, and in the tests. There is no second copy of
 * these rules in SQL — the database asks a function that reads the stored
 * role, and the capability meaning lives here.
 */

/**
 * Project roles, in the order the requirement lists them (§11).
 *
 * `owner` is not in this list as a grantable role: exactly one owner exists
 * per project and it is a column on the project, not a membership row (§12).
 * It appears here because every capability question about the owner has to be
 * answerable.
 */
export const PROJECT_ROLES = [
  "owner",
  "editor",
  "programmer",
  "reviewer",
  "viewer",
  "test_user",
  "deployment_manager",
] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** The roles a person can actually be granted when sharing (owner is transferred, not granted). */
export const GRANTABLE_ROLES: ProjectRole[] = PROJECT_ROLES.filter((r) => r !== "owner") as ProjectRole[];

export const ROLE_LABEL: Record<ProjectRole, string> = {
  owner: "Owner",
  editor: "Editor",
  programmer: "Programmer",
  reviewer: "Reviewer",
  viewer: "Viewer",
  test_user: "Test user",
  deployment_manager: "Deployment manager",
};

export const ROLE_DESCRIPTION: Record<ProjectRole, string> = {
  owner: "Full control, including sharing, permissions and ownership transfer.",
  editor: "Can change the survey and its settings, and manage deployment.",
  programmer: "Can change questions, logic, variables, flow, quotas and scripts.",
  reviewer: "Can read everything and leave internal comments, but cannot change the survey.",
  viewer: "Read-only.",
  test_user: "Can open the test runtime and comment, but cannot change anything.",
  deployment_manager: "Can publish and manage deployment without changing the programming.",
};

/**
 * Every distinct permission decision the platform makes.
 *
 * A capability is named after the action, not the screen, so a new panel that
 * edits quotas needs no new capability — it needs `survey.edit`.
 */
export const CAPABILITIES = [
  /* reading */
  "project.read",             // open the project at all; see questions, logic, flow, quotas, branding, versions
  "project.read_activity",    // see the project's activity log
  "project.read_members",     // see who the collaborators are
  "responses.read",           // see collected response data and quality
  "responses.export",         // download the dataset

  /* writing the survey */
  "survey.edit",              // change ANY part of the definition (needs the edit lock too)
  "survey.save_version",      // cut an immutable version
  "responses.manage",         // edit, delete, restore, import response data

  /* deployment */
  "deploy.manage",            // publish, activate, change deployment settings

  /* collaboration */
  "comment.create",           // leave an internal note
  "comment.resolve",          // mark a thread resolved
  "lock.acquire",             // enter edit mode
  "lock.force_release",       // take the lock away from someone else
  "lock.request",             // ask the current editor for it

  /* administration of the project itself */
  "project.share",            // add or invite a collaborator
  "project.manage_members",   // change roles, remove collaborators
  "project.transfer",         // hand ownership to someone else
  "project.delete",
  "project.lock_settings",    // freeze the project, change its collaboration settings
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * The grant table. One row per role; everything else in the platform reads
 * this rather than restating it.
 *
 * Note what `programmer` deliberately does NOT have: `deploy.manage`. That
 * separation is the whole point of the role existing — §11 asks for a
 * programmer who edits the survey and a deployment manager who ships it, and
 * they are not the same person in a professional research team.
 */
const GRANTS: Record<ProjectRole, Capability[]> = {
  owner: [...CAPABILITIES],

  editor: [
    "project.read", "project.read_activity", "project.read_members",
    "responses.read", "responses.export", "responses.manage",
    "survey.edit", "survey.save_version",
    "deploy.manage",
    "comment.create", "comment.resolve",
    "lock.acquire", "lock.request",
    "project.share",
  ],

  programmer: [
    "project.read", "project.read_activity", "project.read_members",
    "responses.read", "responses.export",
    "survey.edit", "survey.save_version",
    "comment.create", "comment.resolve",
    "lock.acquire", "lock.request",
  ],

  reviewer: [
    "project.read", "project.read_activity", "project.read_members",
    "responses.read", "responses.export",
    "comment.create", "comment.resolve",
    "lock.request",
  ],

  viewer: [
    "project.read", "project.read_members",
    "responses.read",
  ],

  test_user: [
    "project.read", "project.read_members",
    "comment.create",
    "lock.request",
  ],

  deployment_manager: [
    "project.read", "project.read_activity", "project.read_members",
    "responses.read", "responses.export",
    "deploy.manage",
    "comment.create",
    "lock.request",
  ],
};

const GRANT_SETS: Record<ProjectRole, Set<Capability>> = Object.fromEntries(
  PROJECT_ROLES.map((r) => [r, new Set(GRANTS[r])]),
) as Record<ProjectRole, Set<Capability>>;

/** Is this a role name the platform knows? Anything else is treated as no access. */
export function isProjectRole(v: unknown): v is ProjectRole {
  return typeof v === "string" && (PROJECT_ROLES as readonly string[]).includes(v);
}

/**
 * THE authorization question. `null` role means "not a member" and can never
 * do anything — absence of a membership is not a weak role, it is no access.
 */
export function can(role: ProjectRole | null | undefined, capability: Capability): boolean {
  if (!role || !isProjectRole(role)) return false;
  return GRANT_SETS[role].has(capability);
}

/** Everything a role may do — what the UI uses to decide what to render. */
export function capabilitiesOf(role: ProjectRole | null | undefined): Capability[] {
  if (!role || !isProjectRole(role)) return [];
  return [...GRANT_SETS[role]];
}

/**
 * A platform administrator's reach.
 *
 * Deliberately NOT "owner of everything". An admin manages accounts,
 * sessions and stuck locks — the operational duties §9 and §30 describe — and
 * can read a project to do that job. Rewriting someone's survey is not an
 * operational duty, so `survey.edit` is not on this list: an admin who needs
 * to edit adds themselves as a collaborator, and that share is audited like
 * any other.
 */
const ADMIN_CAPABILITIES: Capability[] = [
  "project.read", "project.read_activity", "project.read_members",
  "lock.force_release",
  "project.share", "project.manage_members", "project.transfer",
  "project.lock_settings",
];
const ADMIN_SET = new Set(ADMIN_CAPABILITIES);

export interface Actor {
  userId: string;
  /** the account's own organization; projects outside it are invisible unless shared */
  customerId: string | null;
  isPlatformAdmin: boolean;
}

/**
 * The effective decision for one actor on one project: their membership role,
 * optionally widened by platform-admin duties.
 *
 * Returned as a record rather than a boolean so a caller can report WHY —
 * "you are a reviewer here" reads very differently from "you have no access
 * to this project", and the UI needs to say the right one.
 */
export interface AccessDecision {
  allowed: boolean;
  role: ProjectRole | null;
  /** true when the capability came from platform-admin duties, not membership */
  viaAdmin: boolean;
  /** owner / explicit share / workspace baseline — what the UI explains */
  source: RoleSource;
  reason:
    | "owner"
    | "member"
    | "workspace"
    | "platform_admin"
    | "not_a_member"
    | "insufficient_role";
}

export function decideAccess(
  actor: Actor,
  role: ProjectRole | null,
  capability: Capability,
  /**
   * Where `role` came from. Optional so every existing caller keeps working:
   * without it the decision is inferred from the role alone, exactly as
   * before. Callers that resolved the role through `resolveProjectRole` pass
   * the source so a refusal can say "your workspace's default role is viewer"
   * rather than the much less useful "your role is viewer".
   */
  source?: RoleSource,
): AccessDecision {
  const src: RoleSource = source ?? (role === "owner" ? "owner" : role ? "member" : "none");
  if (role && can(role, capability)) {
    return {
      allowed: true, role, viaAdmin: false, source: src,
      reason: src === "workspace" ? "workspace" : role === "owner" ? "owner" : "member",
    };
  }
  if (actor.isPlatformAdmin && ADMIN_SET.has(capability)) {
    return { allowed: true, role, viaAdmin: true, source: src, reason: "platform_admin" };
  }
  return {
    allowed: false,
    role,
    viaAdmin: false,
    source: src,
    reason: role ? "insufficient_role" : "not_a_member",
  };
}

/* ------------------------------------------------------------ where a role came from */

/**
 * WORKSPACE MEMBERSHIP AS A BASELINE ROLE — the fix for P0-1 and P0-5.
 *
 * The original model recognised exactly two ways to hold a role: own the
 * project, or have somebody add you to it. Everything else was "not a member",
 * which answers 404 — indistinguishable, deliberately, from a project that
 * does not exist.
 *
 * That is correct between organizations and was catastrophic inside one. The
 * Studio used to list projects by workspace, so colleagues in the same
 * organization saw each other's work by default. When this layer shipped, the
 * rule silently became "explicit share or nothing", `project_members` was
 * empty, and three programmers sharing one workspace each woke up able to see
 * only the one or two projects they personally owned. To them, their saved
 * work had disappeared — and a 404 is a very convincing impression of deleted
 * data. Nothing had been deleted. The question being asked had changed.
 *
 * So there is now a third source. Being in a project's workspace grants a
 * baseline role, configurable per workspace, and `null` restores the strict
 * explicit-share-only behaviour for an installation that wants it.
 *
 * Three things this deliberately does NOT do:
 *
 *   · it never crosses a workspace boundary — cross-organization isolation
 *     was never the bug and is not relaxed by a single line here;
 *   · it never overrides an explicit membership row, in either direction. An
 *     owner who demotes a colleague to `viewer` has made a decision, and a
 *     baseline that quietly promoted them back to `editor` would make the
 *     share dialog a lie;
 *   · it never grants ownership. Ownership is a column on the project.
 */
export type RoleSource = "owner" | "member" | "workspace" | "none";

export interface WorkspaceAccessPolicy {
  /**
   * What a workspace colleague gets on a project nobody has explicitly shared
   * with them. `null` means nothing at all — strict, explicit-share-only.
   *
   * The default is `editor` because that is the closest honest reconstruction
   * of what these users had before this layer existed: everyone in the
   * installation could open and change everything. `editor` is already a
   * reduction from that (it withholds `project.transfer`, `project.delete`,
   * `project.manage_members` and `lock.force_release`, which stay with the
   * owner), and a workspace that wants a tighter floor can say so.
   */
  defaultRole: ProjectRole | null;
}

export const DEFAULT_WORKSPACE_ACCESS: WorkspaceAccessPolicy = {
  defaultRole: "editor",
};

export function workspaceAccessPolicy(
  overrides?: Partial<WorkspaceAccessPolicy> | null,
): WorkspaceAccessPolicy {
  const p = { ...DEFAULT_WORKSPACE_ACCESS };
  if (!overrides) return p;
  if ("defaultRole" in overrides) {
    const v = overrides.defaultRole;
    // `owner` is never grantable this way, and an unrecognised string must
    // close the door rather than open it
    if (v === null) p.defaultRole = null;
    else if (isProjectRole(v) && v !== "owner") p.defaultRole = v;
    else p.defaultRole = null;
  }
  return p;
}

/**
 * The one statement of role precedence. SQL implements the same order inside
 * `rescript_project_role`; this is the readable copy the tests pin, and the
 * one the Studio uses to explain to a user WHY they have the access they have.
 */
export function resolveProjectRole(args: {
  isOwner: boolean;
  memberRole: ProjectRole | null;
  /** is the actor in the same workspace as the project? */
  sameWorkspace: boolean;
  workspace: WorkspaceAccessPolicy;
}): { role: ProjectRole | null; source: RoleSource } {
  if (args.isOwner) return { role: "owner", source: "owner" };
  if (args.memberRole && isProjectRole(args.memberRole)) {
    return { role: args.memberRole, source: "member" };
  }
  if (args.sameWorkspace && args.workspace.defaultRole) {
    return { role: args.workspace.defaultRole, source: "workspace" };
  }
  return { role: null, source: "none" };
}

/** How the UI explains where someone's access came from. */
export function roleSourceNote(source: RoleSource, workspaceName?: string | null): string | null {
  switch (source) {
    case "owner": return "You own this project.";
    case "member": return "This project was shared with you.";
    case "workspace":
      return workspaceName
        ? `You have this access because you are a member of ${workspaceName}.`
        : "You have this access because you are a member of this workspace.";
    case "none": return null;
  }
}

/** Roles that can hold the edit lock — the shortlist the UI offers "Edit" to. */
export const EDITING_ROLES: ProjectRole[] = PROJECT_ROLES.filter((r) => can(r, "survey.edit"));

/**
 * A role's headline: what the collaborator panel says beside a name, and what
 * the read-only banner uses to explain why editing is unavailable.
 */
export function roleSummary(role: ProjectRole | null): string {
  if (!role) return "No access to this project";
  return ROLE_DESCRIPTION[role];
}
