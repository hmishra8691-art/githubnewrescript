"use client";
import React from "react";
import {
  ACCESS_MODULES, ACCESS_OPTIONS, ACCESS_PRESETS, CAPABILITY_LABEL, EXPIRY_OPTIONS, LEVEL_LABEL,
  copyAccess, describeExpiry, levelsOf, moduleCapabilities, normalizePermissions, permissionsFromGrant,
  previewAccess, resolveExpiry, searchPermissions, setModuleLevel, toggleCapability, capabilitySet,
  type AccessLevel, type AccessModuleId, type Capability, type CustomPermissions, type ExpiryOptionId,
  type MemberGrant, type ProjectRole,
} from "@rescript/access";

/**
 * THE ACCESS EDITOR — role, presets, copy-from, per-module permission cards,
 * permission search, expiry and the before-you-save preview. Used by the ONE
 * collaborators panel, for an invitation and for changing a collaborator.
 *
 * It decides nothing: levels, ticks, the preview and the search are all
 * `@rescript/access`, the same functions the server's guard asks — so what
 * the preview says a person may do is what the routes will let them do.
 */

export interface AccessDraft {
  role: string;
  permissions: CustomPermissions | null;
  expiry: { option: ExpiryOptionId; date: string };
}

export const emptyDraft = (role = "programmer"): AccessDraft => ({ role, permissions: null, expiry: { option: "none", date: "" } });

/** a member's current access as a draft — the expiry shown as a custom date */
export function draftFrom(m: { role: string; permissions?: unknown; expiresAt?: string | null }): AccessDraft {
  return {
    role: m.role,
    permissions: m.role === "custom" ? normalizePermissions(m.permissions) : null,
    expiry: m.expiresAt ? { option: "custom", date: m.expiresAt.slice(0, 10) } : { option: "none", date: "" },
  };
}

/** what the routes accept */
export function draftBody(d: AccessDraft) {
  return { role: d.role, ...(d.role === "custom" ? { permissions: d.permissions } : {}), expiry: d.expiry };
}

/** the draft as a membership, for the preview and the escalation check */
export function draftGrant(d: AccessDraft, now = Date.now()): MemberGrant & { expiryError?: string } {
  const r = resolveExpiry(d.expiry.option, d.expiry.date, now);
  return {
    role: d.role as ProjectRole,
    permissions: d.role === "custom" ? d.permissions : null,
    expiresAt: r.ok ? r.expiresAt : null,
    ...(r.ok ? {} : { expiryError: r.error }),
  };
}

/* ------------------------------------------------------------------ the access select */

export function AccessSelect({
  value, onChange, roles, testId, label = "Access", disabled, refusal,
}: {
  value: string;
  onChange: (role: string) => void;
  /** the grantable role values the server offered (older servers: the six original ones) */
  roles: string[];
  testId: string;
  label?: string;
  disabled?: boolean;
  /** why a role cannot be granted by this person, or null */
  refusal?: (role: string) => string | null;
}) {
  const offered = ACCESS_OPTIONS.filter((o) => roles.includes(o.role));
  const extra = roles.filter((r) => !ACCESS_OPTIONS.some((o) => o.role === r));
  const group = (g: "primary" | "more") => offered.filter((o) => o.group === g).map((o) => {
    const why = refusal?.(o.role) ?? null;
    return <option key={o.role} value={o.role} disabled={!!why} title={why ?? o.description}>{o.label}{why ? " — not yours to grant" : ""}</option>;
  });
  return (
    <select className="select ax-access-select" aria-label={label} value={value} data-testid={testId} disabled={disabled}
      onChange={(e) => onChange(e.target.value)}>
      <optgroup label="Access level">{group("primary")}</optgroup>
      {offered.some((o) => o.group === "more") && <optgroup label="More roles">{group("more")}</optgroup>}
      {extra.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
    </select>
  );
}

/* ------------------------------------------------------------------ the editor */

export function AccessEditor({
  draft, onChange, collaborators = [], idPrefix, showPresets = true,
}: {
  draft: AccessDraft;
  onChange: (d: AccessDraft) => void;
  /** people whose access can be copied */
  collaborators?: { userId: string; name: string; role: string; permissions?: unknown; isOwner?: boolean }[];
  idPrefix: string;
  showPresets?: boolean;
}) {
  const [preset, setPreset] = React.useState<string | null>(null);
  const setPermissions = (p: CustomPermissions) => onChange({ ...draft, role: "custom", permissions: p });

  return (
    <div className="ax-editor" data-testid="access-editor">
      {showPresets && (
        <div className="ax-start">
          <span className="ax-start-label">Start from</span>
          <div className="ax-presets" role="group" aria-label="Presets">
            {ACCESS_PRESETS.map((p) => (
              <button key={p.id} type="button" className={`chip ax-preset ${preset === p.id ? "on" : ""}`} title={p.description}
                data-testid={`preset-${p.id}`} aria-pressed={preset === p.id}
                onClick={() => { setPreset(p.id); onChange({ ...draft, role: "custom", permissions: p.permissions }); }}>
                {p.label}
              </button>
            ))}
          </div>
          {collaborators.length > 0 && (
            <select className="select ax-copy" aria-label="Copy permissions from a collaborator" data-testid="copy-from" value=""
              onChange={(e) => {
                const from = collaborators.find((c) => c.userId === e.target.value);
                const copied = from && copyAccess({ role: from.isOwner ? "owner" : from.role, permissions: from.permissions });
                if (copied) { setPreset(null); onChange({ ...draft, role: copied.role, permissions: copied.permissions }); }
              }}>
              <option value="">Copy from…</option>
              {collaborators.map((c) => <option key={c.userId} value={c.userId}>{c.name}</option>)}
            </select>
          )}
        </div>
      )}

      {draft.role === "custom" && draft.permissions ? (
        <ModuleCards permissions={draft.permissions} onChange={(p) => { setPreset(null); setPermissions(p); }} idPrefix={idPrefix} />
      ) : (
        <button type="button" className="btn small ax-customize" data-testid="access-customize"
          onClick={() => onChange({ ...draft, role: "custom", permissions: permissionsFromGrant(draft.role as ProjectRole) })}>
          Customize module by module…
        </button>
      )}

      <ExpiryPicker value={draft.expiry} onChange={(expiry) => onChange({ ...draft, expiry })} idPrefix={idPrefix} />
    </div>
  );
}

/* ------------------------------------------------------------------ module cards */

function ModuleCards({ permissions, onChange, idPrefix }: { permissions: CustomPermissions; onChange: (p: CustomPermissions) => void; idPrefix: string }) {
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const hits = React.useMemo(() => searchPermissions(q), [q]);
  const hitCaps = new Set(hits.map((h) => h.capability));
  const hitModules = new Set(hits.map((h) => h.module));
  const have = capabilitySet({ role: "custom", permissions });
  const searching = q.trim().length > 0;

  return (
    <div className="ax-cards">
      <div className="ax-search">
        <input className="input" type="search" placeholder="Search permissions — e.g. export, PII, invite" value={q}
          aria-label="Search permissions" data-testid="perm-search" onChange={(e) => setQ(e.target.value)} />
        {searching && (
          <span className="muted ax-search-count" data-testid="perm-search-count" aria-live="polite">
            {hits.length} permission{hits.length === 1 ? "" : "s"} in {hitModules.size} module{hitModules.size === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {ACCESS_MODULES.filter((m) => !searching || hitModules.has(m.id)).map((m) => {
        const level = permissions.modules[m.id] ?? m.defaultLevel;
        const expanded = searching || !!open[m.id];
        const levels = levelsOf(m.id);
        const atLevel = new Set(moduleCapabilities(m.id, level));
        return (
          <section key={m.id} className={`ax-card ${expanded ? "open" : ""}`} data-testid="perm-card" data-module={m.id} data-level={level}>
            <div className="ax-card-head">
              <button type="button" className="ax-card-title" aria-expanded={expanded} aria-controls={`${idPrefix}-${m.id}-adv`}
                data-testid="perm-expand" onClick={() => setOpen((o) => ({ ...o, [m.id]: !o[m.id] }))}>
                <span className="ax-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                <span className="ax-card-name">{m.label}</span>
              </button>
              <Segmented id={`${idPrefix}-${m.id}`} label={`${m.label} access level`} levels={levels} value={level}
                onChange={(l) => onChange(setModuleLevel(permissions, m.id, l))} />
            </div>
            <p className="ax-card-desc muted">{m.description}</p>
            {expanded && (
              <div className="ax-adv" id={`${idPrefix}-${m.id}-adv`}>
                {m.advanced.map((c) => {
                  const on = have.has(c);
                  const fromLevel = atLevel.has(c);
                  return (
                    <label key={c} className={`ax-cap ${searching && hitCaps.has(c) ? "hit" : ""}`} data-testid="perm-cap" data-cap={c}>
                      <input type="checkbox" checked={on} onChange={(e) => onChange(toggleCapability(permissions, c, e.target.checked))} />
                      <span>{CAPABILITY_LABEL[c]}</span>
                      {fromLevel && on && <span className="ax-from muted">from {LEVEL_LABEL[level]}</span>}
                    </label>
                  );
                })}
                {searching && hits.filter((h) => h.module === m.id && !m.advanced.includes(h.capability)).map((h) => (
                  <div key={h.capability} className="ax-cap hit ax-cap-level" data-testid="perm-cap" data-cap={h.capability}>
                    <span aria-hidden="true">{have.has(h.capability) ? "✓" : "–"}</span>
                    <span>{h.label}</span>
                    <span className="ax-from muted">set by the level</span>
                  </div>
                ))}
                {m.id === "admin" && (
                  <p className="muted ax-note">No level grants these: each is ticked on purpose. Transferring and deleting the project stay with the owner.</p>
                )}
              </div>
            )}
          </section>
        );
      })}
      {searching && hits.length === 0 && <p className="muted" data-testid="perm-search-empty">No permission matches “{q}”.</p>}
    </div>
  );
}

/** One level per module, radio-like: arrow keys move, Space/Enter picks. */
function Segmented({ id, label, levels, value, onChange }: { id: string; label: string; levels: AccessLevel[]; value: AccessLevel; onChange: (l: AccessLevel) => void }) {
  const all: AccessLevel[] = ["none", "view", "edit", "manage"];
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (dir: 1 | -1) => {
    const i = levels.indexOf(value);
    const next = levels[(i + dir + levels.length) % levels.length];
    onChange(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="ax-seg" role="radiogroup" aria-label={label} id={id}>
      {all.map((l) => {
        const offered = levels.includes(l);
        const on = value === l;
        return (
          <button key={l} type="button" role="radio" aria-checked={on} disabled={!offered}
            ref={(el) => { refs.current[l] = el; }}
            tabIndex={on ? 0 : -1} className={`ax-seg-btn ${on ? "on" : ""}`} data-testid={`level-${l}`}
            title={offered ? undefined : "This module has no such level"}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
              if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
            }}
            onClick={() => offered && onChange(l)}>
            {LEVEL_LABEL[l]}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ expiry */

export function ExpiryPicker({ value, onChange, idPrefix }: { value: AccessDraft["expiry"]; onChange: (v: AccessDraft["expiry"]) => void; idPrefix: string }) {
  const resolved = resolveExpiry(value.option, value.date);
  return (
    <fieldset className="ax-expiry" data-testid="expiry-picker">
      <legend>Access expires</legend>
      <div className="ax-expiry-opts" role="radiogroup" aria-label="Access expires">
        {EXPIRY_OPTIONS.map((o) => (
          <label key={o.id} className={`chip ax-exp ${value.option === o.id ? "on" : ""}`}>
            <input type="radio" name={`${idPrefix}-expiry`} value={o.id} checked={value.option === o.id} data-testid={`expiry-${o.id}`}
              onChange={() => onChange({ option: o.id, date: o.id === "custom" ? value.date || new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10) : value.date })} />
            {o.label}
          </label>
        ))}
        {value.option === "custom" && (
          <input type="date" className="input ax-date" aria-label="Expiry date" data-testid="expiry-date" value={value.date}
            min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}
            onChange={(e) => onChange({ option: "custom", date: e.target.value })} />
        )}
      </div>
      <span className={`ax-expiry-text ${resolved.ok ? "muted" : "err"}`} data-testid="expiry-text" aria-live="polite">
        {resolved.ok ? (resolved.expiresAt ? `${describeExpiry(resolved.expiresAt)} — access ends automatically` : "Access does not expire") : resolved.error}
      </span>
    </fieldset>
  );
}

/* ------------------------------------------------------------------ preview */

export function AccessPreviewBox({ draft, refusal, changes }: { draft: AccessDraft; refusal?: string | null; changes?: string[] }) {
  const grant = draftGrant(draft);
  const p = previewAccess({ role: grant.role, permissions: grant.permissions, expiresAt: null });
  const [all, setAll] = React.useState(false);
  return (
    <div className="ax-preview" data-testid="access-preview" aria-live="polite">
      <div className="ax-preview-head">
        <strong data-testid="preview-summary">{p.summary}</strong>
        <span className="muted">{grant.expiresAt ? describeExpiry(grant.expiresAt) : "No expiry"}</span>
      </div>
      {changes && changes.length > 0 && (
        <ul className="ax-changes" data-testid="preview-changes">{changes.map((c) => <li key={c}>{c}</li>)}</ul>
      )}
      <div className="ax-preview-cols">
        <div data-testid="preview-allowed">
          <div className="ax-preview-label ok">Allowed</div>
          {p.allowed.length === 0 && <p className="muted">Nothing beyond opening the project.</p>}
          {p.allowed.map((g) => (
            <div key={g.module} className="ax-preview-group">
              <div className="ax-preview-mod">{g.module}</div>
              <ul>{g.items.map((i) => <li key={i}>{i}</li>)}</ul>
            </div>
          ))}
        </div>
        <div data-testid="preview-restricted">
          <div className="ax-preview-label no">Restricted</div>
          <ul>{(all ? p.restricted : p.restricted.slice(0, 8)).map((i) => <li key={i}>{i}</li>)}</ul>
          {p.restricted.length > 8 && (
            <button type="button" className="btn small" onClick={() => setAll((a) => !a)}>{all ? "Show fewer" : `Show all ${p.restricted.length}`}</button>
          )}
        </div>
      </div>
      {grant.expiryError && <p className="ax-refusal" role="alert">{grant.expiryError}</p>}
      {refusal && <p className="ax-refusal" role="alert" data-testid="preview-refusal">{refusal}</p>}
    </div>
  );
}

/* the module a capability belongs to, for callers that want to deep-link a card */
export const moduleOfCapability = (c: Capability): AccessModuleId | null =>
  ACCESS_MODULES.find((m) => m.advanced.includes(c) || Object.values(m.levels).some((l) => l?.includes(c)))?.id ?? null;
