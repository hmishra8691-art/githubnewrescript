# Rescript Design System

The visual layer of Rescript Studio: one token set, one type ramp, one spacing
scale and one family of primitives, applied to every module through the class
names the modules already used. This document is the reference for anyone
adding or restyling a screen.

The redesign is presentation-only. No business logic, survey programming logic,
backend route, database structure, API or workflow was changed; every existing
handler, `data-testid` and navigation item is still in place and the full
browser test corpus (Studio authoring, flow, logic, masking, list fill, loops,
quotas, response data, quality, collaboration, session, dashboard, analytics,
master demo) runs unchanged against the new UI.

---

## 1. Where the styles live

| File | Role |
|---|---|
| `apps/studio/app/design-system.css` | Tokens, base typography, shared primitives (buttons, inputs, chips, badges, alerts, cards, tables, modals, toasts, tooltips, skeletons), the IDE shell (top bar, grouped sidebar, centre, properties panel), the product header, dashboard hero and metric tiles. Imported first. |
| `apps/studio/app/globals.css` | Module CSS (condition builder, survey flow, list fill, loops, quota dashboard, data/quality panels, versions, collaborators, auth screens, analytics `.ax-*` …). Reads the tokens through the legacy aliases. |
| `apps/studio/components/ui/Icon.tsx` | The single icon set (`<Icon name="…" size={18} />`), 24-unit grid, 1.75 stroke, `currentColor`. |
| `apps/studio/components/ui/AppHeader.tsx` | The top-level product header shared by the Dashboard, Data Analytics and the account pages (brand, primary destinations, breadcrumbs, account area with name / user code / Online / Profile / Security / Projects / Sign out). |
| `apps/studio/app/layout.tsx` | Loads Inter + JetBrains Mono as a plain `<link … display=swap>`; the tokens carry a complete system fallback, so nothing about the build or the app depends on the font host. |

`design-system.css` defines the new `--c-*` tokens **and re-declares the legacy
names** (`--bg --panel --panel2 --border --text --subtle --accent --accent2
--green --red --amber --tint`) as aliases of them. That is what lets 1 500
lines of module CSS pick up the new palette without a rewrite — and it is the
rule going forward: new CSS should use `--c-*` tokens; legacy names keep
working but should not be extended.

---

## 2. Tokens

### Colour

| Token | Value | Use |
|---|---|---|
| `--c-bg` | `#f5f7fb` | App canvas (very light cool gray) |
| `--c-surface` | `#ffffff` | Cards, panels, editors |
| `--c-surface-2` | `#f0f3f9` | Hovers, secondary fills, table heads |
| `--c-surface-3` | `#e6ebf4` | Pressed / strong fills |
| `--c-border` / `--c-border-strong` | `#dde3ee` / `#c7d0df` | Hairlines / emphasised borders and hover |
| `--c-text` | `#131a2b` | Deep charcoal — headings and body |
| `--c-text-2` / `-3` / `-4` | `#3d4760` / `#6b7690` / `#98a2b8` | Secondary body / metadata / placeholders |
| `--c-primary` (+ `-600 -700 -100 -50`) | `#4f46e5` Electric Indigo | Primary actions, active states, links |
| `--c-secondary` (+ `-600 -100 -50`) | `#06b6d4` Cyan | Secondary accents, gradient end |
| `--grad-brand` | indigo → violet → cyan, 135° | Brand mark, hero title, metric tile bar **only** |
| `--grad-primary` | subtle vertical indigo | Primary button |
| `--c-success / -warning / -error / -info` | each with `-bg -bd -fg` | Badges, alerts, status pills, validation |

The theme is light only. Gradients are used sparingly (brand mark, hero
heading, primary button, metric tile bar, auth backdrop washes) and never as
panel backgrounds.

### Typography

Inter (UI) and JetBrains Mono (codes, variables, expressions), each with a
full system fallback stack.

| Token | Size | Where |
|---|---|---|
| `--fs-display` | 34px | Dashboard hero title |
| `--fs-h1` | 28px | Page titles (`h1`, `.acct-head h1`) |
| `--fs-h2` | 22px | Section headings (`h2`) |
| `--fs-h3` | 18px | Subheadings (`h3`) |
| `--fs-body` / `--fs-body-lg` | 15 / 16px | Body |
| `--fs-small` | 13.5px | Supporting text |
| `--fs-caption` | 12.5px | Eyebrow labels, metadata |

Body line-height is 1.55; headings 1.2 with slight negative tracking. The
whole small ramp was moved up one step (old 10→11.5, 11→12.5, 12→13, 13→14,
14→14.5) in both the module CSS and the inline `fontSize` props so nothing in
the product sits below ~11px.

### Spacing, radii, elevation, motion

* Spacing on a 4-pt grid: `--sp-1 … --sp-12` (4 … 48px).
* Radii: `--r-sm 6` `--r-md 10` `--r-lg 14` `--r-xl 18` `--r-pill`.
* Shadows: `--sh-1` (hairline), `--sh-2` (raised), `--sh-3` (floating: menus, modals, toasts), `--sh-focus` (3px indigo ring).
* Motion: `--dur-1 120ms`, `--dur-2 180ms`, `--dur-3 260ms`, `--ease`. Honoured by `prefers-reduced-motion`. Hover effects change colour, border and shadow — never `transform` on containers that hold dropdown menus (a transform creates a stacking context and traps the menu behind the next card).
* Shell: `--topbar-h 58px`, `--sidebar-w 240px`, `--rightpanel-w 440px` (216/390 under 1500px, 200/340 under 1180px).

---

## 3. Primitives

All keep their historical class names, so existing markup is restyled in place.

**Buttons** — `.btn` (secondary, white), `.btn.primary` (indigo gradient, glow shadow), `.btn.danger` (red text; red wash on hover), `.btn.ghost` / `.btn.tertiary` (borderless), sizes `.small` (30px) / default (38px) / `.large` (44px), `:disabled`, `.loading` (spinner). Focus uses the shared ring.

**Inputs** — `.input`, `.select` (custom chevron), `textarea.ta`, `textarea.code`; 38px default, `.small` 32px; hover border, indigo focus ring; checkboxes / radios / ranges use `accent-color`. Labels: `label.f > span`, `.flabel`, `.eyebrow` (uppercase caption).

**Feedback** — `.badge` (`.neutral .success .warning .error`), `.chip`, `.alert` (`.info .success .warning .error`), `.toast` (dark, `.ok` / `.err`), `.tip[data-tip]` tooltip, `.sk` skeleton shimmer, `.empty` + `.empty-icon` empty state, `.btn.loading`.

**Containers** — `.card` (`.selectable`, `.selected`), `.modal-back` / `.modal` (fade + pop-in), `.menu` / `.menu-item` / `.menu-sep` (floating, 12px radius), `table.grid` (sticky uppercase heads, indigo-50 row hover, `.table-wrap` for horizontal scroll), `.opt-row`.

**Icons** — `Icon` names cover every navigation item and common actions (`plus play flask download export search user bell chevron-down check warning info close grid share shield logout chart table layers …`). Icons never replace text; they sit beside it at 16–18px.

---

## 4. Shell

**Studio (`.ide`)** — top bar with brand mark, project context (`.ctx`: title, mono code, `v{version} · rev N`, live badge) always visible, the unsaved-changes chip, and the same actions as before (Preview, Test Survey, Variables .xlsx, Export, Data, Account, Save version) now with icons. The grid column is `minmax(0,1fr)` so a long title truncates instead of widening the page.

**Sidebar (`.leftnav`)** — the same 17 tabs in the same order, now grouped under eyebrow labels *Programming* (Questions, Survey Settings, Survey Flow, Logic, Variables, Calculations, Quotas, List Fill), *Research tools* (Design Generators, Branding, Scripts), *Results* (Data, Data Analytics link) and *Management* (Versions & Deploy, JSON, Collaborators, Internal notes, Activity). Active item: indigo-50 fill, 3px indigo indicator, indigo icon, count pill. Group labels deliberately avoid repeating any item's text so `text=` selectors in the test suites still resolve to the item.

**Properties panel (`.rightpanel`)** — 440px, own scroll, `overflow-x: hidden`, slightly denser inputs (36px / 14px).

**Product header (`.apph`)** — used on the Dashboard, Data Analytics and the account pages: brand, *Projects* / *Data Analytics*, optional breadcrumbs (`.crumbs`), account area (unread bell, Profile, Security, Administration for admins, visible Sign out, avatar pill opening a menu with name, user code, *● Online*, Profile / Security & sessions / Projects / Administration / Sign out).

**Dashboard** — greeting eyebrow (`Good morning, Ana · USR-…`), gradient page title, then a full-width band of six metric tiles (Projects, Live, Live responses, Test responses, Completes, Questions) with skeletons while loading. Below it `.dash-body` is a two-column grid: `.dash-main` carries the existing toolbar, ownership and status pills and survey cards; `.dash-rail` (316px, sticky, `.rail-card`) carries Quick actions (`.qa-*`), Project status (`.pf-*`, a proportional bar plus per-status counts that set the status filter) and Recent activity (`.act-*`, edits and last responses interleaved). Every rail number is derived from the rows and statistics the page has already loaded — no second request, nothing that is not also true on a card. The rail narrows at 1300px and drops below the list at 1080px; the metric band goes 3-up at 900px and 2-up at 620px.

**Account pages** — `AccountHeader` renders the product header, then an *Account* eyebrow, 28px title, an identity pill (avatar, name, code, Online) and underline tabs (Profile / Security / Administration · Back to projects · Sign out).

**Auth** — 460px card on a canvas with faint indigo / cyan radial washes, brand mark before the eyebrow, 26px title, 44px inputs and a 46px primary button.

**Analytics** — same `.ax-*` workspace, 14px tab labels; the default report theme palette now leads with indigo and cyan (`DEFAULT_THEME` in `@rescript/analytics`). Saved themes are untouched.

---

## 5. Conventions for new UI

1. Use tokens, never raw hex, in new CSS; prefer `--c-*` over the legacy aliases.
2. Reach for an existing primitive before writing a new class; if a module needs its own class, put it in `globals.css` under its module banner.
3. Keep `data-testid`s and visible labels stable when restyling; the test suites select by them.
4. Fonts below 12.5px are reserved for eyebrow labels and dense metadata.
5. Interactive states: hover (surface-2 / border-strong), focus-visible (ring), active (translateY(1px) on buttons only), disabled (`.5` opacity).
6. No dark theme, no decorative gradients on panels, no animation longer than 260ms.

---

## 6. Review tooling

`node scripts/ui-shots.mjs [outDir]` captures the login, dashboard, every major Studio panel with the Master Demo loaded, the properties panel with a condition builder open, Data → Quality / Manage, the analytics home / result / reports, the profile page, and the runtime testing toolbar scrolled deep into a survey (desktop and mobile frames). Dev servers on 3000 / 3001. Compare an output directory against a previous run when changing shared styles.

---

## 7. The runtime testing toolbar

Preview and Test Survey run the real runtime with a slim toolbar on top: mode,
build, page position, the Desktop / Tablet / Mobile switch and Debug. A
programmer scrolling into a long survey must keep all of it, so the toolbar is
`position: sticky` — and it is one member of a **sticky stack**:

| custom property | set by | meaning |
|---|---|---|
| `--rs-stack-top` | the preview page (measured banner height) | how far down the toolbar sticks |
| `--rs-toolbar-h` | the Runner (measured toolbar height) | how much room the toolbar occupies |

Both are measured with a `ResizeObserver` rather than hard-coded, because both
rows wrap on a narrow window. `--rs-stack-top` is what stops the toolbar from
sliding *underneath* the preview banner (they both used to stick at `top: 0`,
and the banner's higher z-index won — which is how the device and Debug
buttons disappeared on scroll). `--rs-toolbar-h` keeps the sticky inspector and
the framed device previews sized to the space below the toolbar, so nothing
hides beneath it and the framed previews no longer make the page scroll on top
of their own internal scroll.

Anything else placed above the Runner should publish its height as
`--rs-stack-top` the same way.
