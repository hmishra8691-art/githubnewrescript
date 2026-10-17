import {
  ACCESS_MODULES, CAPABILITIES, OWNER_ONLY, ROLE_DESCRIPTION, ROLE_LABEL,
  accessModule, advancedModuleOf, capabilitySet, isExpired, isProjectRole, levelsOf, moduleCapabilities,
  normalizePermissions, roleOf,
  type AccessLevel, type AccessModuleId, type AccessSubject, type Capability, type CustomPermissions,
  type MemberGrant, type ProjectRole,
} from "./roles.js";

/**
 * COLLABORATORS & ADVANCED ACCESS — everything the collaboration panel needs
 * that is not itself a rule: the words for each capability, the access levels
 * under the names researchers use, presets, the before-you-save preview, the
 * permission search, copying another collaborator's access, expiry, and what
 * changed between two grants.
 *
 * The RULES — which capability a level grants, what `can()` answers — live in
 * `roles.ts` and nowhere else. Everything here is derived from them, so the
 * preview cannot describe a grant differently from how the guard enforces it.
 */

/* ------------------------------------------------------------- words */

/** Each capability in plain words — the preview, the search and the advanced checkboxes. */
export const CAPABILITY_LABEL: Record<Capability, string> = {
  "project.read": "Open the project and read the questionnaire",
  "project.read_activity": "See the project's activity log",
  "project.read_members": "See who has access to the project",
  "responses.read": "View response data and data quality",
  "responses.export": "Export / download the response dataset",
  "survey.edit": "Edit questions, logic, flow, embedded data, quotas, translations and theme",
  "survey.save_version": "Save versions of the survey",
  "responses.manage": "Edit, delete, import and clean responses",
  "deploy.manage": "Publish, deploy and send to respondent lists",
  "comment.create": "Leave internal notes",
  "comment.resolve": "Resolve internal notes",
  "lock.acquire": "Enter edit mode",
  "lock.force_release": "Release another person's edit lock",
  "lock.request": "Ask the current editor for edit access",
  "project.share": "Invite collaborators",
  "project.manage_members": "Change collaborators' access and remove them",
  "project.transfer": "Transfer ownership",
  "project.delete": "Delete the project",
  "project.lock_settings": "Freeze the project and change its collaboration settings",
  "analytics.read": "View analyses, dashboards and reports",
  "analytics.edit": "Create and edit analyses, charts, dashboards and reports",
  "analytics.publish": "Publish reports and create share links",
  "analytics.export": "Download reports (PowerPoint / Excel)",
  "billing.read": "See this project's usage and spend",
  "billing.request_credits": "Request credits for this project",
  "billing.transfer": "Move this project's credits",
  "billing.set_budget": "Set this project's spending limit",
  "project.clone": "Clone the project",
  "responses.read_pii": "See respondent contact details (names, emails, IDs)",
  "fieldwork.read": "See fieldwork progress and live quota counts",
};

/** extra words a person might search with — "Export" must find every kind of export */
const KEYWORDS: Partial<Record<Capability, string>> = {
  "responses.export": "export download csv spss excel dataset data file",
  "analytics.export": "export download powerpoint pptx excel xlsx report file",
  "responses.read_pii": "pii personal email name contact privacy gdpr respondent",
  "responses.manage": "delete clean quality import edit responses data",
  "survey.edit": "questions logic flow embedded data quotas translation theme settings program",
  "deploy.manage": "publish deploy launch live link send distribution",
  "project.share": "invite add collaborator share",
  "project.manage_members": "permissions roles remove collaborators access",
  "project.lock_settings": "freeze settings security collaboration",
  "lock.force_release": "lock unlock release",
  "fieldwork.read": "fieldwork progress quotas counts field",
  "comment.create": "notes comments",
  "comment.resolve": "notes comments",
  "project.read_activity": "activity history log audit",
  "billing.read": "usage wallet spend billing cost",
  "billing.request_credits": "credits wallet billing",
  "survey.save_version": "version save",
  "analytics.publish": "share link publish report",
};

export const LEVEL_LABEL: Record<AccessLevel, string> = { none: "None", view: "View", edit: "Edit", manage: "Manage" };

/* ------------------------------------------------------------- access levels, as researchers name them */

/**
 * The access levels the collaboration panel offers, under the names the
 * requirement uses, each MAPPED onto a stored role. Nothing here creates a
 * rule: "Full Access" is the `editor` row, "View Only" is the `viewer` row.
 * The three older roles that have no name in the requirement stay offered
 * (as "More roles"), because members hold them today.
 */
export interface AccessOption {
  id: string;
  label: string;
  role: ProjectRole;
  description: string;
  group: "primary" | "more";
}

export const ACCESS_OPTIONS: AccessOption[] = [
  { id: "project_admin", label: "Project Admin", role: "project_admin", group: "primary", description: ROLE_DESCRIPTION.project_admin },
  { id: "full", label: "Full Access", role: "editor", group: "primary", description: "Edits the survey, manages data and deployment, runs analysis and invites colleagues — no administration of other people's access." },
  { id: "edit", label: "Edit Access", role: "programmer", group: "primary", description: "Edits the survey (questions, logic, flow, quotas, scripts) and saves versions; reads and exports data; cannot deploy or change data." },
  { id: "view", label: "View Only", role: "viewer", group: "primary", description: "Reads the survey, the response data in the Studio and the analytics — no exports, no changes." },
  { id: "view_data", label: "View Only with Data", role: "viewer_data", group: "primary", description: ROLE_DESCRIPTION.viewer_data },
  { id: "vendor", label: "Vendor Access", role: "vendor", group: "primary", description: ROLE_DESCRIPTION.vendor },
  { id: "interview", label: "Interview Only", role: "interviewer", group: "primary", description: ROLE_DESCRIPTION.interviewer },
  { id: "custom", label: "Custom", role: "custom", group: "primary", description: "Choose a level for each module, and fine-tune individual permissions." },
  { id: "reviewer", label: "Reviewer", role: "reviewer", group: "more", description: ROLE_DESCRIPTION.reviewer },
  { id: "test_user", label: "Test user", role: "test_user", group: "more", description: ROLE_DESCRIPTION.test_user },
  { id: "deployment_manager", label: "Deployment manager", role: "deployment_manager", group: "more", description: ROLE_DESCRIPTION.deployment_manager },
];

/** The researcher-facing name of a stored role ("Full Access" for `editor`). */
export function accessLabel(role: string | null | undefined): string {
  if (!role) return "No access";
  if (role === "owner") return "Owner";
  return ACCESS_OPTIONS.find((o) => o.role === role)?.label ?? ROLE_LABEL[role as ProjectRole] ?? role;
}

/* ------------------------------------------------------------- module levels of any grant */

/** Every module's level in a custom grant, defaults filled in. */
export function moduleLevels(permissions: unknown): Record<AccessModuleId, AccessLevel> {
  const p = normalizePermissions(permissions);
  return Object.fromEntries(ACCESS_MODULES.map((m) => [m.id, p.modules[m.id] ?? m.defaultLevel])) as Record<AccessModuleId, AccessLevel>;
}

/**
 * The closest per-module picture of ANY grant — what the cards show when a
 * fixed role is turned into a starting point for Custom. For each module, the
 * highest level whose capabilities the grant holds in full, plus the ticked /
 * unticked advanced capabilities that make the custom grant reproduce the
 * fixed one as closely as the modules can express.
 */
export function permissionsFromGrant(subject: AccessSubject): CustomPermissions {
  const role = roleOf(subject);
  if (role === "custom" && subject && typeof subject === "object") return normalizePermissions(subject.permissions);
  const have = capabilitySet(role);
  const modules: Partial<Record<AccessModuleId, AccessLevel>> = {};
  const add: Capability[] = [];
  const remove: Capability[] = [];
  for (const m of ACCESS_MODULES) {
    let best: AccessLevel = m.allowsNone ? "none" : levelsOf(m.id)[0];
    for (const l of levelsOf(m.id)) {
      if (l === "none") continue;
      if (moduleCapabilities(m.id, l).every((c) => have.has(c))) best = l;
    }
    /* a module with any of its advanced powers held needs at least its first level, or `add` is ignored */
    if (best === "none" && m.advanced.some((c) => have.has(c))) best = levelsOf(m.id).find((l) => l !== "none") ?? best;
    modules[m.id] = best;
    const atLevel = new Set(moduleCapabilities(m.id, best));
    for (const c of m.advanced) {
      if (have.has(c) && !atLevel.has(c)) add.push(c);
      if (!have.has(c) && atLevel.has(c)) remove.push(c);
    }
  }
  return normalizePermissions({ v: 1, modules, add, remove });
}

/**
 * Set one module's level from the segmented control. Ticks and unticks on
 * THAT module are reset — a new level is a new starting point — and the
 * other modules are left exactly as they were.
 */
export function setModuleLevel(permissions: unknown, id: AccessModuleId, level: AccessLevel): CustomPermissions {
  const p = normalizePermissions(permissions);
  if (!(levelsOf(id) as string[]).includes(level)) return p;
  const mine = new Set(accessModule(id).advanced);
  return normalizePermissions({
    v: 1,
    modules: { ...p.modules, [id]: level },
    add: (p.add ?? []).filter((c) => !mine.has(c)),
    remove: (p.remove ?? []).filter((c) => !mine.has(c)),
  });
}

/** Tick or untick one advanced permission. Ticking on a module at None raises it to its first level. */
export function toggleCapability(permissions: unknown, capability: Capability, on: boolean): CustomPermissions {
  const p = normalizePermissions(permissions);
  const id = advancedModuleOf(capability);
  if (!id) return p;
  const modules = { ...p.modules };
  if (on && modules[id] === "none") modules[id] = levelsOf(id).find((l) => l !== "none") ?? "view";
  const atLevel = moduleCapabilities(id, modules[id] ?? "none").includes(capability);
  const add = new Set(p.add ?? []);
  const remove = new Set(p.remove ?? []);
  add.delete(capability); remove.delete(capability);
  if (on && !atLevel) add.add(capability);
  if (!on && atLevel) remove.add(capability);
  return normalizePermissions({ v: 1, modules, add: [...add], remove: [...remove] });
}

/* ------------------------------------------------------------- presets */

/**
 * PRESETS — editable starting points, not roles. Choosing one fills the
 * module cards; the member is stored as `custom` with whatever the cards say
 * when they press Send, so a preset changing in a later release changes
 * nobody's existing access.
 */
export interface AccessPreset { id: string; label: string; description: string; permissions: CustomPermissions }

export const ACCESS_PRESETS: AccessPreset[] = [
  {
    id: "survey_programmer", label: "Survey Programmer",
    description: "Programs and versions the survey; reads data and reports; no deployment, no exports, no contact details.",
    permissions: normalizePermissions({ v: 1, modules: {
      programming: "manage", deployment: "view", fieldwork: "view", data: "view", analytics: "view",
      collaboration: "edit", usage: "view", admin: "view",
    } }),
  },
  {
    id: "data_analyst", label: "Data Analyst",
    description: "Reads the survey; cleans and exports data; builds and publishes reports — without respondent contact details.",
    permissions: normalizePermissions({ v: 1, modules: {
      programming: "view", deployment: "view", fieldwork: "view", data: "manage", analytics: "manage",
      collaboration: "edit", usage: "none", admin: "view",
    }, remove: ["responses.read_pii"] }),
  },
  {
    id: "external_vendor", label: "External Vendor",
    description: "Sees the questionnaire and fieldwork progress only — no response data, reports or team list.",
    permissions: normalizePermissions({ v: 1, modules: {
      programming: "view", deployment: "view", fieldwork: "view", data: "none", analytics: "none",
      collaboration: "none", usage: "none", admin: "none",
    } }),
  },
  {
    id: "client_stakeholder", label: "Client / Stakeholder",
    description: "Reads the questionnaire and the reports and can leave notes — no raw data, exports or contact details.",
    permissions: normalizePermissions({ v: 1, modules: {
      programming: "view", deployment: "view", fieldwork: "view", data: "none", analytics: "view",
      collaboration: "edit", usage: "none", admin: "none",
    } }),
  },
];

export const presetById = (id: string) => ACCESS_PRESETS.find((p) => p.id === id) ?? null;

/* ------------------------------------------------------------- preview */

export interface AccessPreview {
  allowed: { module: string; items: string[] }[];
  restricted: string[];
  /** a one-line headline: "Custom access · 9 of 30 permissions" */
  summary: string;
}

/**
 * What a grant allows and what it does not, in words — shown before saving.
 * Built from `capabilitySet`, the same function `can()` uses, so the preview
 * is the enforcement and not a description of it.
 */
export function previewAccess(subject: AccessSubject, now?: number): AccessPreview {
  const have = capabilitySet(subject, now);
  const seen = new Set<Capability>();
  const allowed: AccessPreview["allowed"] = [];
  const groupOf = (m: (typeof ACCESS_MODULES)[number]) => {
    const caps = new Set<Capability>([...m.advanced]);
    for (const l of ["view", "edit", "manage"] as const) for (const c of m.levels[l] ?? []) caps.add(c);
    return [...caps];
  };
  for (const m of ACCESS_MODULES) {
    const items = groupOf(m).filter((c) => have.has(c) && !seen.has(c) && c !== "lock.acquire" && c !== "lock.request");
    for (const c of groupOf(m)) seen.add(c);
    if (items.length) allowed.push({ module: m.label, items: items.map((c) => CAPABILITY_LABEL[c]) });
  }
  const restricted = CAPABILITIES
    .filter((c) => !have.has(c) && c !== "lock.acquire" && c !== "lock.request")
    .map((c) => CAPABILITY_LABEL[c] + (OWNER_ONLY.includes(c) ? " (owner only)" : ""));
  const role = roleOf(subject);
  const counted = CAPABILITIES.filter((c) => c !== "lock.acquire" && c !== "lock.request");
  const n = counted.filter((c) => have.has(c)).length;
  const expired = isExpired(subject, now);
  return {
    allowed, restricted,
    summary: expired ? "Access expired — nothing is allowed" : `${accessLabel(role)} · ${n} of ${counted.length} permissions`,
  };
}

/* ------------------------------------------------------------- search */

export interface PermissionHit { module: AccessModuleId; moduleLabel: string; capability: Capability; label: string }

/**
 * "Export" finds every export, across modules. Every word must match the
 * permission's label, its keywords or its module's name.
 */
export function searchPermissions(query: string): PermissionHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: PermissionHit[] = [];
  for (const m of ACCESS_MODULES) {
    const caps = new Set<Capability>(m.advanced);
    for (const l of ["view", "edit", "manage"] as const) for (const c of m.levels[l] ?? []) caps.add(c);
    for (const c of caps) {
      if (c === "lock.acquire" || c === "lock.request") continue;
      const hay = `${CAPABILITY_LABEL[c]} ${KEYWORDS[c] ?? ""} ${m.label} ${m.covers.join(" ")}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) hits.push({ module: m.id, moduleLabel: m.label, capability: c, label: CAPABILITY_LABEL[c] });
    }
  }
  return hits;
}

/* ------------------------------------------------------------- copy */

/**
 * Copy another collaborator's access as the starting point for this one: the
 * role and (for custom) the permissions. NOT the expiry — when a contractor's
 * access ends is about that contractor.
 */
export function copyAccess(from: { role: string | null; permissions?: unknown }): { role: ProjectRole; permissions: CustomPermissions | null } | null {
  if (!isProjectRole(from.role) || from.role === "owner") {
    /* the owner's access is not a grant; copying it yields the closest grantable one */
    if (from.role === "owner") return { role: "project_admin", permissions: null };
    return null;
  }
  return { role: from.role, permissions: from.role === "custom" ? normalizePermissions(from.permissions) : null };
}

/* ------------------------------------------------------------- granting without escalating */

/**
 * NOBODY GRANTS WHAT THEY DO NOT HOLD. A project admin may give a colleague
 * Full Access, but not Project Admin's power over the owner's decisions they
 * were never given; an editor who may invite may invite as anything up to an
 * editor. Owners hold everything, so this never stops them.
 *
 * Returns the capabilities the target would get that the granter lacks; an
 * empty list means the grant is allowed.
 */
export function escalation(granter: AccessSubject, target: MemberGrant, now?: number): Capability[] {
  const mine = capabilitySet(granter, now);
  const theirs = capabilitySet({ role: target.role, permissions: target.permissions }, now);
  return CAPABILITIES.filter((c) => theirs.has(c) && !mine.has(c));
}

/* ------------------------------------------------------------- expiry */

export const EXPIRY_OPTIONS = [
  { id: "none", label: "No expiry", days: null },
  { id: "1d", label: "1 day", days: 1 },
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "custom", label: "Custom date", days: null },
] as const;
export type ExpiryOptionId = (typeof EXPIRY_OPTIONS)[number]["id"];

/** the furthest a grant may be set to end — a decade is a typo, not a plan */
export const MAX_EXPIRY_DAYS = 3 * 365;

/**
 * Turn the expiry picker into a timestamp, or explain why not.
 * `customDate` is `YYYY-MM-DD` (end of that day, UTC) or an ISO timestamp.
 */
export function resolveExpiry(
  option: string | null | undefined,
  customDate: string | null | undefined,
  now: number = Date.now(),
): { ok: true; expiresAt: string | null } | { ok: false; error: string } {
  const id = option ?? "none";
  if (id === "none") return { ok: true, expiresAt: null };
  const preset = EXPIRY_OPTIONS.find((o) => o.id === id);
  if (preset && preset.days) return { ok: true, expiresAt: new Date(now + preset.days * 86_400_000).toISOString() };
  if (id !== "custom") return { ok: false, error: "Choose when this access should end." };
  return validateExpiry(customDate, now);
}

/** Validate a stored or submitted expiry: must be in the future and within MAX_EXPIRY_DAYS. */
export function validateExpiry(
  value: string | null | undefined,
  now: number = Date.now(),
): { ok: true; expiresAt: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined || value === "") return { ok: true, expiresAt: null };
  const raw = String(value).trim();
  const t = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? Date.parse(`${raw}T23:59:59.000Z`) : Date.parse(raw);
  if (!Number.isFinite(t)) return { ok: false, error: "That is not a date." };
  if (t <= now) return { ok: false, error: "The expiry date must be in the future." };
  if (t > now + MAX_EXPIRY_DAYS * 86_400_000) return { ok: false, error: `Access can be granted for at most ${MAX_EXPIRY_DAYS / 365} years at a time.` };
  return { ok: true, expiresAt: new Date(t).toISOString() };
}

/** "Expires in 6 days" / "Expired 2 days ago" / "No expiry" */
export function describeExpiry(expiresAt: string | null | undefined, now: number = Date.now()): string {
  if (!expiresAt) return "No expiry";
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return "Expired";
  const day = 86_400_000;
  const date = new Date(t).toISOString().slice(0, 10);
  if (t <= now) {
    const ago = Math.floor((now - t) / day);
    return ago <= 0 ? `Expired today (${date})` : `Expired ${ago} day${ago === 1 ? "" : "s"} ago (${date})`;
  }
  const left = (t - now) / day;
  if (left < 1) return `Expires in ${Math.max(1, Math.round(left * 24))} hour${Math.round(left * 24) === 1 ? "" : "s"} (${date})`;
  const d = Math.ceil(left);
  return `Expires in ${d} day${d === 1 ? "" : "s"} (${date})`;
}

/* ------------------------------------------------------------- what changed */

/**
 * The difference between two grants in words, for the activity history and
 * the "you are about to change" line: role, each module's level, each
 * advanced permission, and the expiry.
 */
export function diffAccess(before: MemberGrant | null, after: MemberGrant | null): string[] {
  const out: string[] = [];
  const br = before?.role ?? null;
  const ar = after?.role ?? null;
  if (br !== ar) out.push(`Access: ${accessLabel(br)} → ${accessLabel(ar)}`);
  if (br === "custom" || ar === "custom") {
    const bl = br === "custom" ? moduleLevels(before?.permissions) : null;
    const al = ar === "custom" ? moduleLevels(after?.permissions) : null;
    if (bl && al) {
      for (const m of ACCESS_MODULES) {
        if (bl[m.id] !== al[m.id]) out.push(`${m.label}: ${LEVEL_LABEL[bl[m.id]]} → ${LEVEL_LABEL[al[m.id]]}`);
      }
    }
  }
  const bc = capabilitySet(before ? { role: before.role, permissions: before.permissions } : null);
  const ac = capabilitySet(after ? { role: after.role, permissions: after.permissions } : null);
  if (br === ar && br === "custom") {
    for (const c of CAPABILITIES) {
      if (c === "lock.acquire" || c === "lock.request") continue;
      if (bc.has(c) && !ac.has(c)) out.push(`Removed: ${CAPABILITY_LABEL[c]}`);
      if (!bc.has(c) && ac.has(c)) out.push(`Added: ${CAPABILITY_LABEL[c]}`);
    }
  }
  const be = before?.expiresAt ?? null;
  const ae = after?.expiresAt ?? null;
  if ((be ?? "") !== (ae ?? "")) out.push(`Expiry: ${be ? be.slice(0, 10) : "none"} → ${ae ? ae.slice(0, 10) : "none"}`);
  return out;
}
