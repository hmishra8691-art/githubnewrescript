"use client";
import React from "react";
import { Icon, type IconName } from "../ui/Icon";
import { useMode } from "./ModeContext";
import { buildMenuGroups, groupOfTab, fitGroups, menuKey, type MenuGroupDef, type MenuItemDef, type MenuKeyState } from "../../lib/menubar";
import { modeInfo } from "../../lib/programmingMode";

/**
 * THE MENUBAR — the Studio's tools, horizontally, revealed on demand.
 *
 *   Programming ▾   Research Tools ▾   Results ▾   Management ▾ │ Mode · 02 Grid ▾        Programming › Questions 160
 *
 * A menu opens on hover-intent (140 ms) or on click; while one is open,
 * moving across the bar switches menus with no delay, the way a desktop
 * application's menubar behaves; leaving the bar and its menu closes it
 * after a short grace, so a pointer that strays a few pixels does not
 * lose the menu. Escape closes and returns focus. ←/→ walk the groups,
 * ↓ opens, ↑/↓ walk the items — the WAI-ARIA menubar pattern.
 *
 * Only the open panel is in the DOM. A closed one is not merely hidden:
 * twenty-five tool names and their descriptions sitting in the tree would
 * shadow every `button:has-text("edit")` in the product (and in a hundred
 * browser suites) with an item nobody can see. The group button carries
 * its items' names in `data-nav-items`, so what a menu holds is knowable
 * without opening it. Nothing here overlaps the workspace except an open
 * menu, which is transient by construction.
 *
 * The groups and items come from `lib/menubar.ts`, which builds them
 * from the same `NAV` table the sidebar used. Tab switching goes through
 * the shell's guarded `setTab`, exactly as before.
 *
 * Responsive: the bar measures its group buttons and folds the ones that
 * do not fit, right to left, into "More"; when none fits, the one button
 * is "Menu" and the whole hierarchy sits inside it as sections.
 */

export interface MenuBarProps {
  nav: { key: string; label: string; group: string; icon: IconName }[];
  tab: string;
  setTab(tab: string): void;
  counts: Partial<Record<string, number>>;
  analyticsHref?: string;
}

const HOVER_OPEN_MS = 140;
const LEAVE_CLOSE_MS = 220;

export function MenuBar({ nav, tab, setTab, counts, analyticsHref }: MenuBarProps) {
  const mode = useMode();
  const groups = React.useMemo(() => buildMenuGroups(nav, { analyticsHref }), [nav, analyticsHref]);
  const iconOf = React.useMemo(() => new Map(nav.map((n) => [n.key, n.icon])), [nav]);
  const here = groupOfTab(groups, tab);

  /* ------------------------------------------------------------ open state */
  const [open, setOpen] = React.useState<string | null>(null);
  const [kb, setKb] = React.useState<MenuKeyState>({ open: -1, item: -1 });
  const openTimer = React.useRef<number | null>(null);
  const closeTimer = React.useRef<number | null>(null);
  const clearTimers = () => {
    if (openTimer.current) { window.clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  const openNow = React.useCallback((key: string) => { clearTimers(); setOpen(key); }, []);
  const closeAll = React.useCallback(() => { clearTimers(); setOpen(null); setKb({ open: -1, item: -1 }); }, []);
  React.useEffect(() => () => clearTimers(), []);

  // Escape anywhere and a click anywhere outside close an open menu
  const rootRef = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) closeAll(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { closeAll(); } };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", onDown, true); window.removeEventListener("keydown", onKey); };
  }, [open, closeAll]);

  const onGroupEnter = (key: string) => {
    clearTimers();
    if (open) { if (open !== key) setOpen(key); return; }
    openTimer.current = window.setTimeout(() => setOpen(key), HOVER_OPEN_MS);
  };
  const onGroupLeave = () => { if (openTimer.current) { window.clearTimeout(openTimer.current); openTimer.current = null; } };
  const onBarLeave = () => { clearTimers(); if (open) closeTimer.current = window.setTimeout(() => { setOpen(null); setKb({ open: -1, item: -1 }); }, LEAVE_CLOSE_MS); };
  const onBarEnter = () => { if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; } };
  const onGroupClick = (key: string) => { if (open === key) closeAll(); else openNow(key); };

  /* ------------------------------------------------------------ overflow */
  const groupsRef = React.useRef<HTMLDivElement>(null);
  const measureRef = React.useRef<HTMLDivElement>(null);
  const [visible, setVisible] = React.useState(groups.length);
  const [overflow, setOverflow] = React.useState(false);
  React.useEffect(() => {
    const host = groupsRef.current, probe = measureRef.current;
    if (!host || !probe) return;
    const measure = () => {
      const widths = [...probe.querySelectorAll<HTMLElement>("[data-measure-group]")].map((el) => el.offsetWidth + 2);
      const fixed = [...host.querySelectorAll<HTMLElement>("[data-fixed]")].reduce((a, el) => a + el.offsetWidth + 2, 0);
      const more = probe.querySelector<HTMLElement>("[data-measure-more]")?.offsetWidth ?? 72;
      const r = fitGroups(widths, host.clientWidth - fixed - 8, more + 2);
      setVisible(r.visible); setOverflow(r.overflow);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [groups]);
  const shown = groups.slice(0, visible);
  const folded = groups.slice(visible);

  /* ------------------------------------------------------------ keyboard */
  const allKeys = React.useMemo(() => [...shown.map((g) => g.key), ...(folded.length ? ["more"] : []), "mode"], [shown, folded.length]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>("[data-group-button]");
    const item = target.closest<HTMLElement>("[role^=menuitem]");
    const focusedGroup = btn ? allKeys.indexOf(btn.dataset.groupButton!) : item ? allKeys.indexOf(open ?? "") : -1;
    if (focusedGroup < 0 && !open) return;
    const openIndex = open ? allKeys.indexOf(open) : -1;
    const panel = open ? rootRef.current?.querySelector<HTMLElement>(`[data-menu-panel="${open}"]`) : null;
    const items = panel ? [...panel.querySelectorAll<HTMLElement>("[role^=menuitem]:not([disabled])")] : [];
    const cur = item ? items.indexOf(item) : -1;
    const next = menuKey({ open: openIndex, item: cur }, e.key, allKeys.length, items.length, focusedGroup >= 0 ? focusedGroup : openIndex);
    if (!next) return;
    e.preventDefault();
    if (next.focus !== undefined && next.focus >= 0) {
      rootRef.current?.querySelector<HTMLElement>(`[data-group-button="${allKeys[next.focus]}"]`)?.focus();
    }
    if (next.open < 0) { closeAll(); return; }
    const key = allKeys[next.open];
    openNow(key);
    setKb(next);
  };
  // after a keyboard change, put focus on the item the state names
  React.useEffect(() => {
    if (!open || kb.open < 0 || kb.item < 0) return;
    const panel = rootRef.current?.querySelector<HTMLElement>(`[data-menu-panel="${open}"]`);
    const items = panel ? [...panel.querySelectorAll<HTMLElement>("[role^=menuitem]:not([disabled])")] : [];
    items[Math.min(kb.item, items.length - 1)]?.focus();
  }, [kb, open]);

  const choose = (key: string) => { closeAll(); setTab(key); };

  /* ------------------------------------------------------------ render */
  const renderItems = (g: MenuGroupDef) => g.items.map((it) => <ToolItem key={it.key} item={it} active={it.key === tab} count={it.countKey ? counts[it.countKey] : undefined} icon={iconOf.get(it.key) ?? "layers"} onChoose={choose} />);
  const tokens = (g: MenuGroupDef) => g.items.map((i) => i.label.replace(/\s+/g, "_")).join(" ");
  const keys = (g: MenuGroupDef) => g.items.map((i) => i.key).join(" ");
  const modeLabel = modeInfo(mode?.mode ?? "studio");
  const splitLabel = mode?.split ? modeInfo(mode.split) : null;

  return (
    <nav className={`menubar${open ? " is-open" : ""}`} aria-label="Studio tools" data-testid="menubar" ref={rootRef} onPointerLeave={onBarLeave} onPointerEnter={onBarEnter} onKeyDown={onKeyDown}>
      {/* an off-screen copy of every group button, for measuring the fold */}
      <div className="menubar-measure" aria-hidden="true" ref={measureRef}>
        {groups.map((g) => <span key={g.key} className="menubar-btn" data-measure-group>{g.label}<Icon name="chevron-down" size={12} /></span>)}
        <span className="menubar-btn" data-measure-more>More<Icon name="chevron-down" size={12} /></span>
      </div>

      <div className="menubar-groups" role="menubar" ref={groupsRef}>
        {shown.map((g) => (
          <Group key={g.key} id={g.key} label={g.label} active={here?.key === g.key} open={open === g.key} items={tokens(g)} itemKeys={keys(g)}
            onEnter={onGroupEnter} onLeave={onGroupLeave} onClick={onGroupClick}>
            <div className="menubar-grid">{renderItems(g)}</div>
          </Group>
        ))}
        {folded.length > 0 && (
          <Group id="more" label={shown.length ? "More" : "Menu"} active={!!here && folded.some((g) => g.key === here.key)} open={open === "more"} items={folded.map(tokens).join(" ")} itemKeys={folded.map(keys).join(" ")}
            onEnter={onGroupEnter} onLeave={onGroupLeave} onClick={onGroupClick}>
            <div className="menubar-sections">
              {folded.map((g) => (
                <section key={g.key} className="menubar-section" aria-label={g.label}>
                  <div className="menubar-section-title">{g.label}</div>
                  <div className="menubar-grid">{renderItems(g)}</div>
                </section>
              ))}
            </div>
          </Group>
        )}
        <span className="menubar-sep" data-fixed aria-hidden="true" />
        <Group id="mode" label="Mode" active={false} open={open === "mode"} fixed items={mode?.modes.map((m) => m.label).join(" ") ?? ""}
          onEnter={onGroupEnter} onLeave={onGroupLeave} onClick={onGroupClick}
          detail={<><span className="mode-index">0{modeLabel.index}</span><span className="menubar-btn-detail">{modeLabel.label}{splitLabel ? ` + ${splitLabel.label}` : ""}</span></>}
          testId="mode-cluster">
          <ModeMenu onDone={closeAll} />
        </Group>
      </div>

      {/* WHERE AM I — the group and tool on screen, and the environment when it matters */}
      <div className="menubar-here" data-testid="where-am-i" data-tab={tab} data-mode={mode?.mode ?? "studio"} title="Where you are">
        {here && <><span className="here-group">{here.label}</span><span className="here-sep" aria-hidden="true">›</span></>}
        <span className="here-tab">{groups.flatMap((g) => g.items).find((i) => i.key === tab)?.label ?? tab}</span>
        {counts[tab] != null && <span className="nav-count">{counts[tab]}</span>}
        {tab === "questions" && mode && (
          <span className="here-mode" data-testid="here-mode"><span className="mode-index">0{modeLabel.index}</span>{modeLabel.label}{splitLabel ? <span className="here-split"> + {splitLabel.label}</span> : null}{mode.focus && <span className="here-focus" title="Focus mode">· focus</span>}</span>
        )}
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------- a group */

function Group({ id, label, active, open, items, itemKeys, fixed, detail, testId, onEnter, onLeave, onClick, children }: {
  id: string; label: string; active: boolean; open: boolean; items: string; itemKeys?: string; fixed?: boolean; detail?: React.ReactNode; testId?: string;
  onEnter(key: string): void; onLeave(): void; onClick(key: string): void; children: React.ReactNode;
}) {
  return (
    <div className={`menubar-group${open ? " open" : ""}${active ? " here" : ""}`} data-testid={testId ?? `menu-${id}`} {...(fixed ? { "data-fixed": "1" } : {})}
      onPointerEnter={() => onEnter(id)} onPointerLeave={onLeave}>
      <button
        type="button" className="menubar-btn" role="menuitem" aria-haspopup="menu" aria-expanded={open}
        data-group-button={id} data-nav-items={items} data-nav-keys={itemKeys} data-testid={`menu-button-${id}`}
        onClick={() => onClick(id)}
      >
        <span className="menubar-btn-label">{label}</span>
        {detail}
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="menubar-menu" role="menu" aria-label={label} data-menu-panel={id} data-testid={`menu-panel-${id}`}>
          {children}
        </div>
      )}
    </div>
  );
}

function ToolItem({ item, active, count, icon, onChoose }: { item: MenuItemDef; active: boolean; count?: number; icon: IconName; onChoose(key: string): void }) {
  const body = (
    <>
      <span className="nav-ico"><Icon name={icon} size={16} /></span>
      <span className="nav-body">
        <span className="nav-label">{item.label}{count != null && <span className="nav-count">{count}</span>}</span>
        <span className="nav-desc">{item.description}</span>
      </span>
    </>
  );
  if (item.href) {
    return <a className="nav-item" role="menuitem" tabIndex={-1} href={item.href} data-testid={item.key === "analytics" ? "nav-analytics" : `nav-${item.key}`} title={`Open ${item.label}`}>{body}</a>;
  }
  return (
    <button type="button" className={`nav-item${active ? " active" : ""}`} role="menuitem" tabIndex={-1} aria-current={active ? "page" : undefined}
      data-testid={`nav-${item.key}`} data-tab={item.key} onClick={() => onChoose(item.key)}>
      {body}
    </button>
  );
}

/* ---------------------------------------------------------- the Mode menu */

/**
 * The Mode menu: the five environments as a radio group (the Phase 5
 * selector's test ids kept), then Split, Focus and the chooser — the
 * same view-level switches, reached the same way as every other tool.
 */
function ModeMenu({ onDone }: { onDone(): void }) {
  const m = useMode();
  if (!m) return null;
  return (
    <div className="menubar-sections mode-menu">
      <section className="menubar-section" aria-label="Environment">
        <div className="menubar-section-title">Environment</div>
        <div className="mode-selector" role="group" aria-label="Programming mode" data-testid="mode-selector">
          {m.modes.map((info) => {
            const active = m.mode === info.id;
            const paired = m.split === info.id;
            return (
              <button
                key={info.id} type="button" role="menuitemradio" aria-checked={active} tabIndex={-1}
                className={`nav-item mode-option${active ? " active" : ""}${paired ? " paired" : ""}${info.available ? "" : " soon"}`}
                data-testid={`mode-${info.id}`} data-mode={info.id} data-available={info.available ? "1" : "0"} disabled={!info.available}
                title={info.available ? `${info.label} — ${info.tagline}. ${info.audience}${paired ? " (open in the split)" : ""}` : `${info.label} — ${info.tagline}. Coming soon.`}
                onClick={() => { m.setMode(info.id); onDone(); }}
              >
                <span className="mode-index">0{info.index}</span>
                <span className="nav-body"><span className="nav-label mode-name">{info.label}{paired && <span className="nav-count">split</span>}</span><span className="nav-desc">{info.tagline}</span></span>
              </button>
            );
          })}
        </div>
      </section>
      <section className="menubar-section" aria-label="View" data-testid="split-menu">
        <div className="menubar-section-title">Split with{!m.splitAllowed && <span className="menubar-section-note"> — needs a wider window</span>}</div>
        <div className="mode-selector">
          {m.modes.filter((x) => x.available && x.id !== m.mode).map((x) => (
            <button key={x.id} type="button" role="menuitemradio" aria-checked={m.split === x.id} tabIndex={-1} disabled={!m.splitAllowed}
              className={`nav-item mode-option compact${m.split === x.id ? " active" : ""}`} data-testid={`split-${x.id}`}
              onClick={() => { m.setSplit(m.split === x.id ? null : x.id); onDone(); }}>
              <span className="mode-index">0{x.index}</span><span className="nav-body"><span className="nav-label">{x.label}</span></span>
            </button>
          ))}
          {m.split && (
            <button type="button" role="menuitem" tabIndex={-1} className="nav-item mode-option compact off" data-testid="split-off" onClick={() => { m.setSplit(null); onDone(); }}>
              <span className="nav-ico"><Icon name="close" size={13} /></span><span className="nav-body"><span className="nav-label">Close split</span></span>
            </button>
          )}
        </div>
        <div className="mode-selector">
          <button type="button" role="menuitemcheckbox" aria-checked={m.focus} tabIndex={-1} className={`nav-item mode-option compact${m.focus ? " active" : ""}`} data-testid="focus-mode-toggle"
            title="Focus (⌘⇧F): the menubar tucks away and only what you selected — and what it depends on — stays lit"
            onClick={() => { m.setFocus(!m.focus); onDone(); }}>
            <span className="nav-ico"><Icon name="sparkle" size={14} /></span><span className="nav-body"><span className="nav-label">Focus{m.focus && <span className="nav-count">on</span>}</span><span className="nav-desc">Hide everything but the work in hand · ⌘⇧F</span></span>
          </button>
          <button type="button" role="menuitem" tabIndex={-1} className="nav-item mode-option compact" data-testid="open-chooser" onClick={() => { onDone(); m.openChooser(); }}>
            <span className="nav-ico"><Icon name="info" size={14} /></span><span className="nav-body"><span className="nav-label">Choose how to program…</span><span className="nav-desc">The five environments, explained</span></span>
          </button>
        </div>
      </section>
    </div>
  );
}
