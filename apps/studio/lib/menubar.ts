/**
 * THE MENUBAR MODEL — what the top navigation shows, and how it behaves.
 *
 * The Studio's tools were a vertical sidebar: four groups, twenty-five
 * items, permanently on screen, 216 px of every window. The redesign moves
 * them into a horizontal menubar whose groups open on hover or click —
 * "top navigation = what I can do; workspace = what I am doing". This
 * module is the part with no DOM in it: which items belong to which
 * group, the one-line description each item shows as its preview, which
 * groups fit in a given width, and the keyboard rules. `MenuBar.tsx`
 * renders it; `menubar.test.ts` pins it.
 *
 * Nothing is invented here. The items are the Studio's `NAV` entries,
 * grouped exactly as the sidebar grouped them; the descriptions say what
 * each existing panel does.
 */

export interface MenuItemDef {
  /** the Studio tab key, or a href for a link item */
  key: string;
  label: string;
  /** one line: what this tool does — the menu's preview */
  description: string;
  /** an external workspace rather than a tab */
  href?: string;
  /** the count badge, by the store's counts key */
  countKey?: string;
}

export interface MenuGroupDef {
  key: string;
  label: string;
  /** the `NAV.group` string whose entries belong here */
  navGroup?: string;
  items: MenuItemDef[];
}

/** what each panel is for, one line each — shown under the item */
export const TAB_DESCRIPTIONS: Record<string, string> = {
  questions: "Write, order and edit every question",
  settings: "Title, languages, behaviour and defaults",
  flow: "Pages, blocks, branches, loops and ends",
  logic: "Display rules, skips, checks and lint",
  variables: "Every variable the export will carry",
  calculations: "Derived values from the calc DSL",
  quotas: "Cells, targets and what happens when full",
  listfill: "Allocated lists — concepts, cells, pools",
  designs: "Conjoint, MaxDiff and other designs",
  branding: "Look, voice and the AI interviewer",
  assets: "Images, video and audio the survey uses",
  localization: "Every language version of the survey",
  scripts: "Custom JavaScript at the moments you choose",
  tests: "Recorded paths that must keep working",
  data: "Test and live responses, row by row",
  fieldwork: "Suppliers, quotas and completes in the field",
  project: "Deadlines, freeze, the study's own settings",
  usage: "What the project has spent, and its wallet",
  distribution: "Links, invitations and reminders",
  versions: "Immutable versions and the live link",
  json: "The definition itself, editable",
  collaborators: "Who can edit, and the edit lock",
  notes: "Notes for the team, not respondents",
  activity: "Who changed what, and when",
  analytics: "Charts, crosstabs and dashboards",
};

export interface NavEntry { key: string; label: string; group: string }

/**
 * Build the groups from the Studio's NAV table. The order of groups and of
 * items inside them is the sidebar's; the Data Analytics link sits in
 * Results where the sidebar had it, right after Data.
 */
export function buildMenuGroups(nav: NavEntry[], opts: { analyticsHref?: string } = {}): MenuGroupDef[] {
  const order: { key: string; label: string; navGroup: string }[] = [
    { key: "programming", label: "Programming", navGroup: "Programming" },
    { key: "research", label: "Research Tools", navGroup: "Research tools" },
    { key: "results", label: "Results", navGroup: "Results" },
    { key: "management", label: "Management", navGroup: "Management" },
  ];
  const groups = order.map((g) => ({
    key: g.key, label: g.label, navGroup: g.navGroup,
    items: nav.filter((n) => n.group === g.navGroup).map<MenuItemDef>((n) => ({
      key: n.key, label: n.label, description: TAB_DESCRIPTIONS[n.key] ?? "", countKey: n.key,
    })),
  }));
  // anything NAV grows that these four do not name still gets a home
  const known = new Set(order.map((g) => g.navGroup));
  for (const n of nav) {
    if (known.has(n.group)) continue;
    let g = groups.find((x) => x.navGroup === n.group);
    if (!g) { g = { key: n.group.toLowerCase().replace(/\W+/g, "-"), label: n.group, navGroup: n.group, items: [] }; groups.push(g); }
    g.items.push({ key: n.key, label: n.label, description: TAB_DESCRIPTIONS[n.key] ?? "", countKey: n.key });
  }
  if (opts.analyticsHref) {
    const results = groups.find((g) => g.key === "results");
    if (results) {
      const at = results.items.findIndex((i) => i.key === "data") + 1;
      results.items.splice(at || results.items.length, 0, { key: "analytics", label: "Data Analytics", description: TAB_DESCRIPTIONS.analytics, href: opts.analyticsHref });
    }
  }
  return groups;
}

/** the group a tab belongs to — for the "where am I" crumb and the active group */
export function groupOfTab(groups: MenuGroupDef[], tab: string): MenuGroupDef | null {
  return groups.find((g) => g.items.some((i) => i.key === tab)) ?? null;
}

/* ------------------------------------------------------------ overflow */

/**
 * Which groups fit. Buttons fold from the RIGHT into a "More" group when
 * the bar is narrower than the sum of their widths; the "More" button's
 * own width is reserved as soon as anything folds. `widths` are measured
 * by the component (a group's button is as wide as its label), so this is
 * arithmetic, not guessing, and it is the same arithmetic for a 4K screen
 * and a tablet.
 */
export function fitGroups(widths: number[], available: number, moreWidth: number): { visible: number; overflow: boolean } {
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= available) return { visible: widths.length, overflow: false };
  let used = moreWidth;
  let n = 0;
  for (const w of widths) {
    if (used + w > available) break;
    used += w; n++;
  }
  return { visible: n, overflow: true };
}

/* ------------------------------------------------------------ keyboard */

export interface MenuKeyState {
  /** index of the open group, or -1 */
  open: number;
  /** focused item inside the open group, or -1 for the group button */
  item: number;
  /** move keyboard focus to this group's button (menus closed) */
  focus?: number;
}

/**
 * Menubar keyboard rules (WAI-ARIA menubar pattern, the parts that apply):
 * ←/→ move between groups, and switch an open menu; ↓ (or Enter/Space on a
 * closed group) opens and lands on the first item; ↑/↓ move inside; Home/
 * End jump; Escape closes and returns to the button. `null` means "not a
 * key we handle — let it through".
 */
export function menuKey(state: MenuKeyState, key: string, groupCount: number, itemCount: number, focusedGroup: number): MenuKeyState | null {
  const wrap = (i: number, n: number) => (n <= 0 ? -1 : ((i % n) + n) % n);
  const isOpen = state.open >= 0;
  const last = Math.max(0, itemCount - 1);
  switch (key) {
    case "ArrowRight": { const g = wrap(focusedGroup + 1, groupCount); return isOpen ? { open: g, item: 0 } : { open: -1, item: -1, focus: g }; }
    case "ArrowLeft": { const g = wrap(focusedGroup - 1, groupCount); return isOpen ? { open: g, item: 0 } : { open: -1, item: -1, focus: g }; }
    case "ArrowDown": return isOpen ? { open: state.open, item: wrap(state.item + 1, itemCount) } : { open: focusedGroup, item: 0 };
    case "ArrowUp": return isOpen ? { open: state.open, item: wrap(state.item - 1, itemCount) } : { open: focusedGroup, item: last };
    case "Home": return isOpen ? { open: state.open, item: 0 } : null;
    case "End": return isOpen ? { open: state.open, item: last } : null;
    case "Enter":
    case " ": return isOpen ? null : { open: focusedGroup, item: 0 };
    case "Escape": return isOpen ? { open: -1, item: -1, focus: state.open } : null;
    default: return null;
  }
}
