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
  /*
   * Collaborators & advanced access (2026-10-17). APPENDED, never inserted:
   * every role above keeps its row and its meaning, so a stored `editor`
   * means exactly what it meant yesterday. These four cover the access levels
   * the old seven did not (docs/COLLABORATORS-ACCESS-2026-10-17.md §3), and
   * `custom` is a membership whose capabilities come from its stored
   * per-module permissions rather than from a fixed row.
   */
  "project_admin",
  "viewer_data",
  "vendor",
  "interviewer",
  "custom",
] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** The roles a person can actually be granted when sharing (owner is transferred, not granted). */
export const GRANTABLE_ROLES: ProjectRole[] = PROJECT_ROLES.filter((r) => r !== "owner") as ProjectRole[];

/**
 * The roles a WORKSPACE BASELINE may be (`access_settings.workspace.defaultRole`).
 * Exactly the six `rescript_workspace_default_role` (0009) accepts — a baseline
 * is a fixed row, so `custom` (which needs stored permissions) can never be
 * one, and the newer roles stay explicit-share-only until the SQL list says
 * otherwise. Two lists that must agree, so the test pins them together.
 */
export const BASELINE_ROLES: ProjectRole[] = ["editor", "programmer", "reviewer", "viewer", "test_user", "deployment_manager"];

export const ROLE_LABEL: Record<ProjectRole, string> = {
  owner: "Owner",
  editor: "Editor",
  programmer: "Programmer",
  reviewer: "Reviewer",
  viewer: "Viewer",
  test_user: "Test user",
  deployment_manager: "Deployment manager",
  project_admin: "Project admin",
  viewer_data: "Viewer with data",
  vendor: "Vendor",
  interviewer: "Interviewer",
  custom: "Custom access",
};

export const ROLE_DESCRIPTION: Record<ProjectRole, string> = {
  owner: "Full control, including sharing, permissions and ownership transfer.",
  editor: "Can change the survey and its settings, and manage deployment.",
  programmer: "Can change questions, logic, variables, flow, quotas and scripts.",
  reviewer: "Can read everything and leave internal comments, but cannot change the survey.",
  viewer: "Read-only.",
  test_user: "Can open the test runtime and comment, but cannot change anything.",
  deployment_manager: "Can publish and manage deployment without changing the programming.",
  project_admin: "Everything an editor can do, plus managing collaborators, their permissions and the project's settings — without owning it (cannot transfer, delete or set the budget).",
  viewer_data: "Read-only, plus downloading the dataset and seeing respondent contact details.",
  vendor: "Sample vendor: can open the survey and follow fieldwork progress — no response data, no editing.",
  interviewer: "Can open the survey to administer interviews and follow fieldwork progress — no response data, no editing.",
  custom: "Access chosen module by module.",
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

  /* analytics & reporting (§29): computed over response data, never a second copy of it */
  "analytics.read",           // open the Data Analytics workspace, run analyses, view saved charts / reports
  "analytics.edit",           // save, modify and delete analyses, charts, segments, filters, reports, dashboards, themes
  "analytics.publish",        // publish a report version, create / revoke share links
  "analytics.export",         // generate PowerPoint / Excel downloads

  /* metered usage & wallet (billing brief): reading the project's meter is part of running the project; asking for credits is an owner/editor act */
  "billing.read",             // open the project's Usage / Meter section: wallet, usage, forecast
  "billing.request_credits",  // submit a credit request for the project
  /*
   * Move this project's unused credits somewhere else. Owner-only, and
   * deliberately not given to an editor: an editor changes the survey, an
   * owner decides what the project's budget is for. A person's OWN wallet
   * needs no capability at all — it is theirs.
   */
  "billing.transfer",
  /*
   * Set how much of the owner's wallet THIS project may consume, and freeze
   * or release it on that basis. Owner-only for the same reason as the
   * transfer above: an editor programs the survey, the owner decides what
   * the money is for. It moves nothing — a budget is permission against a
   * wallet, not a pot inside the project.
   */
  "billing.set_budget",
  /*
   * Copy this project's programming into a NEW project. Read-shaped in what
   * it discloses — the copier could already open every question — but a
   * creation act in what it does, so it sits with the roles that build
   * surveys rather than with the ones that only look at them: a reviewer
   * being able to read a study is not a reason for them to be able to put
   * another project in the workspace's list.
   */
  "project.clone",

  /*
   * Collaborators & advanced access (2026-10-17). Two finer splits of
   * `responses.read`, so a custom membership can be denied one without the
   * other. EVERY role that held `responses.read` before holds both, so no
   * existing member loses anything (pinned by the backward-compatibility
   * test): the split only matters for the new roles and for custom access.
   */
  "responses.read_pii",       // respondent contact details: the respondent list's names, emails and external ids
  "fieldwork.read",           // fieldwork progress and live quota counts — aggregates, never a response
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
/** the 2026-10-17 split of `responses.read` — given to exactly the roles that held it */
const READS_SPLIT: Capability[] = ["responses.read_pii", "fieldwork.read"];

const GRANTS: Record<ProjectRole, Capability[]> = {
  owner: [...CAPABILITIES],

  editor: [
    "project.read", "project.read_activity", "project.read_members",
    "responses.read", "responses.export", "responses.manage", ...READS_SPLIT,
    "survey.edit", "survey.save_version",
    "deploy.manage",
    "comment.create", "comment.resolve",
    "lock.acquire", "lock.request",
    "project.share",
    "analytics.read", "analytics.edit", "analytics.publish", "analytics.export",
    "billing.read", "billing.request_credits",
    "project.clone",
  ],

  programmer: [
    "project.read", "project.read_activity", "project.read_members",
    "responses.read", "responses.export", ...READS_SPLIT,
    "survey.edit", "survey.save_version",
    "comment.create", "comment.resolve",
    "lock.acquire", "lock.request",
    "analytics.read", "analytics.edit", "analytics.export",
    "billing.read",
    "project.clone",
  ],

  reviewer: [
    "project.read", "project.read_activity", "project.read_members",
    "responses.read", "responses.export", ...READS_SPLIT,
    "comment.create", "comment.resolve",
    "lock.request",
    "analytics.read", "analytics.export",
    "billing.read",
  ],

  viewer: [
    "project.read", "project.read_members",
    "responses.read", ...READS_SPLIT,
    "analytics.read",
  ],

  test_user: [
    "project.read", "project.read_members",
    "comment.create",
    "lock.request",
  ],

  deployment_manager: [
    "project.read", "project.read_activity", "project.read_members",
    "responses.read", "responses.export", ...READS_SPLIT,
    "deploy.manage",
    "comment.create",
    "lock.request",
    "analytics.read", "analytics.export",
    "billing.read",
  ],

  /*
   * "Project Admin": runs the project without owning it. An editor plus the
   * administration an owner used to hold alone — collaborators and their
   * permissions, the freeze / collaboration settings, unsticking a lock.
   * NOT the four that ownership means: transfer, delete, and the two money
   * decisions (moving credits, setting the budget).
   */
  project_admin: [
    "project.read", "project.read_activity", "project.read_members",
    "responses.read", "responses.export", "responses.manage", ...READS_SPLIT,
    "survey.edit", "survey.save_version",
    "deploy.manage",
    "comment.create", "comment.resolve",
    "lock.acquire", "lock.request", "lock.force_release",
    "project.share", "project.manage_members", "project.lock_settings",
    "analytics.read", "analytics.edit", "analytics.publish", "analytics.export",
    "billing.read", "billing.request_credits",
    "project.clone",
  ],

  /* "View Only with Data": a viewer who may also take the dataset away and see who the respondents are */
  viewer_data: [
    "project.read", "project.read_members",
    "responses.read", "responses.export", ...READS_SPLIT,
    "analytics.read", "analytics.export",
  ],

  /* "Vendor Access": the questionnaire and how fieldwork is going — never a response, never a person */
  vendor: [
    "project.read",
    "fieldwork.read",
  ],

  /* "Interview Only": opens the survey to administer it and follows progress; may leave a note */
  interviewer: [
    "project.read",
    "fieldwork.read",
    "comment.create",
  ],

  /*
   * "Custom": the FLOOR only. A custom membership's real capabilities come
   * from its stored per-module permissions (`customCapabilities`); a custom
   * row whose permissions are missing or unreadable can open the project and
   * nothing more — it fails closed, not open.
   */
  custom: [
    "project.read",
  ],
};

const GRANT_SETS: Record<ProjectRole, Set<Capability>> = Object.fromEntries(
  PROJECT_ROLES.map((r) => [r, new Set(GRANTS[r])]),
) as Record<ProjectRole, Set<Capability>>;

/** Is this a role name the platform knows? Anything else is treated as no access. */
export function isProjectRole(v: unknown): v is ProjectRole {
  return typeof v === "string" && (PROJECT_ROLES as readonly string[]).includes(v);
}

export function isCapability(v: unknown): v is Capability {
  return typeof v === "string" && (CAPABILITIES as readonly string[]).includes(v);
}

/* ================================================== custom, per-module access */

/**
 * CUSTOM ACCESS — one level per module, translated into the SAME capabilities
 * every route already asks for. There is no second rulebook: a module level is
 * a named bundle of rows from `CAPABILITIES`, and `can()` answers a custom
 * member exactly as it answers a fixed role — from a set of capabilities.
 *
 * The modules are the platform's real ones (the Project Overview's grid),
 * grouped where the platform cannot tell them apart: questions, logic, flow,
 * embedded data, quota definitions, translations, theme and survey settings
 * are ONE stored survey document saved through ONE guarded route, so they are
 * one module — offering "Translation: Edit, Logic: None" would be a promise
 * no route could keep.
 */
export const ACCESS_LEVELS = ["none", "view", "edit", "manage"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ACCESS_MODULE_IDS = [
  "programming", "deployment", "fieldwork", "data", "analytics", "collaboration", "usage", "admin",
] as const;
export type AccessModuleId = (typeof ACCESS_MODULE_IDS)[number];

export interface AccessModuleSpec {
  id: AccessModuleId;
  label: string;
  /** which Overview modules / document modules this one stands for */
  covers: string[];
  description: string;
  /** what each level ADDS to the one below it; a level that is absent is not offered */
  levels: Partial<Record<Exclude<AccessLevel, "none">, Capability[]>>;
  /** whether "None" is offered (the questionnaire can never be hidden — see programming) */
  allowsNone: boolean;
  /** the default level when a custom grant does not mention the module */
  defaultLevel: AccessLevel;
  /** capabilities that can be ticked or unticked one by one when the card is expanded */
  advanced: Capability[];
}

export const ACCESS_MODULES: AccessModuleSpec[] = [
  {
    id: "programming", label: "Survey Programming",
    covers: ["Programming", "Quotas (definitions)", "Translation", "Survey Settings", "Theme"],
    description: "Questions, logic, flow, embedded data, quota definitions, translations, theme and survey settings — one survey document.",
    /*
     * No "None": every other module is labelled by the questionnaire (data
     * columns, report variables, fieldwork quotas), so a collaborator who may
     * see anything at all reads the questionnaire. `project.read` is the
     * floor of every membership.
     */
    allowsNone: false,
    defaultLevel: "view",
    levels: {
      view: ["project.read", "lock.request"],
      edit: ["survey.edit", "lock.acquire"],
      manage: ["survey.save_version", "project.clone"],
    },
    advanced: ["survey.edit", "survey.save_version", "project.clone"],
  },
  {
    id: "deployment", label: "Versions & Deploy",
    covers: ["Versions & Deploy"],
    description: "Publishing test and live links, activating versions, sending to respondent lists.",
    allowsNone: false,
    defaultLevel: "view",
    /* seeing the versions and the links is part of reading the project; deploying is the separate act */
    levels: { view: [], manage: ["deploy.manage"] },
    advanced: ["deploy.manage"],
  },
  {
    id: "fieldwork", label: "Fieldwork",
    covers: ["Fieldwork", "Quotas (live counts)"],
    description: "Fieldwork progress over time and live quota counts — aggregates only, never a response.",
    allowsNone: true,
    defaultLevel: "none",
    levels: { view: ["fieldwork.read"] },
    advanced: ["fieldwork.read"],
  },
  {
    id: "data", label: "Data",
    covers: ["Data", "Response Summary", "Data quality"],
    description: "Response data and its quality checks. Exports and respondent contact details are separate permissions.",
    allowsNone: true,
    defaultLevel: "none",
    levels: {
      view: ["responses.read"],
      edit: ["responses.manage"],
      manage: ["responses.export", "responses.read_pii"],
    },
    advanced: ["responses.manage", "responses.export", "responses.read_pii"],
  },
  {
    id: "analytics", label: "Data Analytics & Reports",
    covers: ["Data Analytics", "Reporting / Crosstabs", "Research Dashboard"],
    description: "Analyses, crosstabs, dashboards and reports. Computed results only — never the raw responses, contact details or the dataset.",
    allowsNone: true,
    defaultLevel: "none",
    levels: {
      view: ["analytics.read"],
      edit: ["analytics.edit"],
      manage: ["analytics.publish", "analytics.export"],
    },
    advanced: ["analytics.edit", "analytics.publish", "analytics.export"],
  },
  {
    id: "collaboration", label: "Notes & Activity",
    covers: ["Other: internal notes", "Activity log"],
    description: "Internal notes on the survey and the project's activity log.",
    allowsNone: true,
    defaultLevel: "none",
    levels: {
      view: ["project.read_activity"],
      edit: ["comment.create", "comment.resolve"],
    },
    advanced: ["project.read_activity", "comment.create", "comment.resolve"],
  },
  {
    id: "usage", label: "Usage & Wallet",
    covers: ["Usage & Wallet"],
    description: "This project's spend. Moving credits and setting the budget stay with the owner.",
    allowsNone: true,
    defaultLevel: "none",
    levels: { view: ["billing.read"], edit: ["billing.request_credits"] },
    advanced: ["billing.request_credits"],
  },
  {
    id: "admin", label: "Project Administration",
    covers: ["Project", "Collaborators"],
    description: "Seeing who has access. Inviting people, changing access, project settings and releasing locks are separate permissions that no level grants on its own.",
    allowsNone: true,
    defaultLevel: "none",
    /*
     * "Manage" is deliberately NOT offered here. Every other module's Manage
     * is about that module's work; administration is about who may do the
     * work, and the requirement is explicit that no level implies inviting,
     * security changes, transfer or deletion. Those are ticked one by one.
     */
    levels: { view: ["project.read_members"] },
    advanced: ["project.share", "project.manage_members", "project.lock_settings", "lock.force_release"],
  },
];

const MODULE_BY_ID = new Map(ACCESS_MODULES.map((m) => [m.id, m]));
export const accessModule = (id: AccessModuleId) => MODULE_BY_ID.get(id)!;

/** The levels a module offers, in order — what the segmented control renders. */
export function levelsOf(id: AccessModuleId): AccessLevel[] {
  const m = MODULE_BY_ID.get(id);
  if (!m) return [];
  return ACCESS_LEVELS.filter((l) => (l === "none" ? m.allowsNone : !!m.levels[l]));
}

/** The capabilities a module grants at a level — cumulative. */
export function moduleCapabilities(id: AccessModuleId, level: AccessLevel): Capability[] {
  const m = MODULE_BY_ID.get(id);
  if (!m || level === "none") return [];
  const out: Capability[] = [];
  for (const l of ["view", "edit", "manage"] as const) {
    out.push(...(m.levels[l] ?? []));
    if (l === level) break;
  }
  return out;
}

/**
 * NEVER CUSTOMISABLE. Ownership is a column, not a permission: what makes
 * someone the owner — handing the project on, deleting it, and deciding what
 * its money is for — cannot be ticked onto anybody.
 */
export const OWNER_ONLY: Capability[] = ["project.transfer", "project.delete", "billing.transfer", "billing.set_budget"];

/** The stored shape of `project_members.permissions` (and `project_invitations.permissions`). */
export interface CustomPermissions {
  v: 1;
  modules: Partial<Record<AccessModuleId, AccessLevel>>;
  /** an advanced capability ticked on top of its module's level */
  add?: Capability[];
  /** an advanced capability unticked from its module's level */
  remove?: Capability[];
}

const ADVANCED_MODULE = new Map<Capability, AccessModuleId>();
for (const m of ACCESS_MODULES) for (const c of m.advanced) ADVANCED_MODULE.set(c, m.id);
/** which module's card an advanced capability is ticked on */
export const advancedModuleOf = (c: Capability) => ADVANCED_MODULE.get(c) ?? null;

/**
 * Read stored permissions — from the database, a request body, anywhere.
 *
 * Unknown modules, unknown levels and unknown capabilities are DROPPED, never
 * passed through: a typo in a request must not become a grant. A level a
 * module does not offer falls back to the module's default, and a module that
 * is not mentioned gets its default. Anything that is not an object at all
 * reads as "every module at its default" — the floor.
 */
export function normalizePermissions(raw: unknown): CustomPermissions {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const mods = src.modules && typeof src.modules === "object" && !Array.isArray(src.modules)
    ? (src.modules as Record<string, unknown>) : {};
  const modules: Partial<Record<AccessModuleId, AccessLevel>> = {};
  for (const m of ACCESS_MODULES) {
    const asked = mods[m.id];
    modules[m.id] = typeof asked === "string" && (levelsOf(m.id) as string[]).includes(asked)
      ? (asked as AccessLevel) : m.defaultLevel;
  }
  const caps = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).filter((c): c is Capability =>
    isCapability(c) && ADVANCED_MODULE.has(c)))].sort();
  const add = caps(src.add).filter((c) => modules[ADVANCED_MODULE.get(c)!] !== "none");
  const remove = caps(src.remove).filter((c) => !add.includes(c));
  const out: CustomPermissions = { v: 1, modules };
  if (add.length) out.add = add;
  if (remove.length) out.remove = remove;
  return out;
}

/**
 * What a custom grant may do. Deterministic and closed:
 *
 *   floor (`project.read`)
 *   ∪ each module's capabilities at its level
 *   ∪ advanced capabilities ticked on a module that is not None
 *   − advanced capabilities unticked
 *   then the dependencies a route would refuse anyway: editing needs the
 *   edit lock, so `lock.acquire` follows `survey.edit` (and cutting a
 *   version needs the lock, so it needs `survey.edit`)
 *   − the owner-only four, always
 */
export function customCapabilities(raw: unknown): Set<Capability> {
  const p = normalizePermissions(raw);
  const out = new Set<Capability>(GRANTS.custom);
  for (const m of ACCESS_MODULES) for (const c of moduleCapabilities(m.id, p.modules[m.id] ?? m.defaultLevel)) out.add(c);
  for (const c of p.add ?? []) out.add(c);
  for (const c of p.remove ?? []) out.delete(c);
  if (out.has("survey.edit")) out.add("lock.acquire"); else { out.delete("lock.acquire"); out.delete("survey.save_version"); }
  for (const c of OWNER_ONLY) out.delete(c);
  return out;
}

/* ================================================== memberships, with expiry */

/**
 * A MEMBERSHIP, not just a role: the role, the stored per-module permissions
 * (read only when the role is `custom`; a fixed role means its table row and
 * nothing else) and when the access ends.
 */
export interface MemberGrant {
  role: ProjectRole | null;
  permissions?: unknown;
  /** ISO timestamp; null or absent = no expiry. Never applies to the owner. */
  expiresAt?: string | null;
}

/** Everything `can()` accepts: a bare role (every existing caller) or a membership. */
export type AccessSubject = ProjectRole | MemberGrant | null | undefined;

export function roleOf(subject: AccessSubject): ProjectRole | null {
  if (!subject) return null;
  const r = typeof subject === "string" ? subject : subject.role;
  return isProjectRole(r) ? r : null;
}

/** Has this membership's access ended? A bare role and the owner never expire. */
export function isExpired(subject: AccessSubject, now: number = Date.now()): boolean {
  if (!subject || typeof subject === "string" || subject.role === "owner" || !subject.expiresAt) return false;
  const t = Date.parse(subject.expiresAt);
  /* an unreadable date closes the door: a grant whose end cannot be read is treated as ended */
  return !Number.isFinite(t) || t <= now;
}

const EMPTY: ReadonlySet<Capability> = new Set();

/** The full capability set of a subject at a moment. */
export function capabilitySet(subject: AccessSubject, now: number = Date.now()): ReadonlySet<Capability> {
  const role = roleOf(subject);
  if (!role) return EMPTY;
  if (isExpired(subject, now)) return EMPTY;
  if (role === "custom" && subject && typeof subject === "object") return customCapabilities(subject.permissions);
  return GRANT_SETS[role];
}

/**
 * THE authorization question. `null` role means "not a member" and can never
 * do anything — absence of a membership is not a weak role, it is no access.
 *
 * Accepts a bare role exactly as before, or a membership (`MemberGrant`): a
 * custom membership answers from its permissions, and an expired one answers
 * no to everything. One function, one capability table — the guard, the UI
 * and the tests all ask it.
 */
export function can(role: AccessSubject, capability: Capability, now?: number): boolean {
  return capabilitySet(role, now).has(capability);
}

/** Everything a role (or membership) may do — what the UI uses to decide what to render. */
export function capabilitiesOf(role: AccessSubject, now?: number): Capability[] {
  const set = capabilitySet(role, now);
  /* in table order, so two calls never disagree on order */
  return CAPABILITIES.filter((c) => set.has(c));
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
    | "insufficient_role"
    /* a membership whose `expiresAt` has passed: it answers no to everything, and says why */
    | "access_expired";
}

export function decideAccess(
  actor: Actor,
  /** a bare role (every existing caller) or a membership with permissions and expiry */
  subject: AccessSubject,
  capability: Capability,
  /**
   * Where `role` came from. Optional so every existing caller keeps working:
   * without it the decision is inferred from the role alone, exactly as
   * before. Callers that resolved the role through `resolveProjectRole` pass
   * the source so a refusal can say "your workspace's default role is viewer"
   * rather than the much less useful "your role is viewer".
   */
  source?: RoleSource,
  now?: number,
): AccessDecision {
  const role = roleOf(subject);
  const src: RoleSource = source ?? (role === "owner" ? "owner" : role ? "member" : "none");
  if (role && can(subject, capability, now)) {
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
    reason: !role ? "not_a_member" : isExpired(subject, now) ? "access_expired" : "insufficient_role",
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
    /* exactly the list the SQL accepts (BASELINE_ROLES) — never owner, never custom */
    else if (isProjectRole(v) && BASELINE_ROLES.includes(v)) p.defaultRole = v;
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
