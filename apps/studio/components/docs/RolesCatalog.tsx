import { PROJECT_ROLES, ROLE_DESCRIPTION, ROLE_LABEL, can, type Capability } from "@rescript/access";

/**
 * EVERY PROJECT ROLE AND WHAT IT MAY DO (Developer Docs phase 3): drawn at render time from @rescript/access — the
 * same module that decides every permission in the API routes and the Studio — so this table cannot drift from what
 * the platform enforces. `custom` takes its capabilities module by module, so it has no fixed row of ticks.
 */
const COLUMNS: { cap: Capability; label: string }[] = [
  { cap: "project.read", label: "Open the project" },
  { cap: "survey.edit", label: "Edit the survey" },
  { cap: "survey.save_version", label: "Save a version" },
  { cap: "deploy.manage", label: "Publish / deploy" },
  { cap: "responses.read", label: "See responses" },
  { cap: "responses.export", label: "Download data" },
  { cap: "comment.create", label: "Comment" },
  { cap: "project.manage_members", label: "Manage collaborators" },
  { cap: "project.transfer", label: "Transfer / delete" },
];

export function RolesCatalog() {
  return (
    <div className="docs-catalog" data-testid="docs-roles">
      <p className="docs-catalog-note">{PROJECT_ROLES.length} roles — generated from the platform&apos;s access rules when this page is opened.</p>
      <div className="docs-catalog-scroll">
        <table>
          <thead><tr><th>Role</th><th>What it is for</th>{COLUMNS.map((c) => <th key={c.cap} className="docs-roles-cap">{c.label}</th>)}</tr></thead>
          <tbody>{PROJECT_ROLES.map((r) => (
            <tr key={r} data-testid={`docs-role-${r}`}>
              <td><b>{ROLE_LABEL[r]}</b></td>
              <td>{ROLE_DESCRIPTION[r]}</td>
              {COLUMNS.map((c) => <td key={c.cap} className="docs-roles-cell">{r === "custom" ? "chosen" : can(r, c.cap) ? "✓" : "—"}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
