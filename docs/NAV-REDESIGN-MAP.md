# Studio navigation redesign — map of what exists (2026-09-25)

*Made before touching the shell, as the brief asks: "map the existing navigation and functionality so nothing is accidentally lost."*

## Measured, 1440 × 900, Questions tab, Q1 selected

| region | width | share |
|---|---|---|
| left nav (`.leftnav`) | 216 px | 15 % |
| centre (`.center`) | 834 px | 58 % |
| properties (`.rightpanel`) | 390 px | 27 % |
| top bar (`.topbar`) | 58 px tall; **overflows** at this width (Export · Data · Save version are clipped off the right edge) |

The two complaints in the brief are both visible in `before-studio.png`: the sidebar takes 15 % of every width, and the top bar's actions run off screen at a common laptop width because the mode selector, ⌘K and seven buttons share one row with the title.

## Every navigation target (Studio.tsx `NAV`), by group

| group | tab key | label | count badge | editing tab |
|---|---|---|---|---|
| Programming | `questions` | Questions | questions | yes |
| | `settings` | Survey Settings | | yes |
| | `flow` | Survey Flow | | yes |
| | `logic` | Logic | | yes |
| | `variables` | Variables | | yes |
| | `calculations` | Calculations | calculations | yes |
| | `quotas` | Quotas | quotas | yes |
| | `listfill` | List Fill | listFills | yes |
| Research tools | `designs` | Design Generators | designs | yes |
| | `branding` | Branding | | yes |
| | `assets` | Assets | | yes |
| | `localization` | Translation | | yes |
| | `scripts` | Scripts | scripts | yes |
| | `tests` | Tests | | **no** (reviewer, no lock) |
| Results | `data` | Data | | no |
| | *(link)* | Data Analytics → `/analytics?survey=…` (`data-testid="nav-analytics"`) | | — |
| | `fieldwork` | Fieldwork | | no |
| Management | `project` | Project | | no |
| | `usage` | Usage & Wallet | | no |
| | `distribution` | Distribution | | |
| | `versions` | Versions & Deploy | | no |
| | `json` | JSON | | |
| | `collaborators` | Collaborators | | no |
| | `notes` | Internal notes | | no |
| | `activity` | Activity | | no |

Tab switching goes through `setTabGuarded` → `s.canLeaveTab()` (a panel with an open inline edit may refuse). The palette's Navigate group (`navigationCommands(tabs)`) and `CollabBar.onOpenPanel`, `WalletBadge.onOpen`, the Data button and the save-blocker's "Open the logic checks" all call `setTab` directly. None of that changes.

## The top bar today

Logo · project context (title, code, version/rev, Live badge) · SaveIndicator · **ModeSelector cluster** (01–05, Split menu, Focus, ⓘ chooser) · spacer · ⌘K · Preview · Test Survey · Variables .xlsx · Export · WalletBadge · Data · Account · Save version.

Below it, optional bars: save-blocker, ReadOnlyBar, publish-bar, session-ended lockbar, CollabBar. `.ide` is a grid of `58px 1fr` rows, so the bars land in implicit rows.

## The mode cluster (Phase 5)

`data-testid`: `mode-selector`, `mode-<id>` (×5, `.mode-option`, `data-mode`, `data-available`, `.active`, `.paired`), `mode-cluster`, `split-toggle`, `split-menu`, `split-<id>`, `split-off`, `focus-mode-toggle`, `open-chooser`. Commands: `mode.<id>`, `split.<id>`, `split.off`, `mode.choose`, `view.toggleFocus` (⌘⇧F).

## What the browser suites touch (107 suites; 52 use the nav)

| selector | uses | meaning |
|---|---|---|
| `page.click(".leftnav >> text=X")` / template form | 96 | go to tab X |
| `page.waitForSelector(".leftnav")` | 25 | the shell is up |
| `.leftnav .nav-item.active` | 17 | which tab is active (text, count digits stripped) |
| `.leftnav .nav-item` (`$$eval`) | 6 | the list of tab labels / a count badge |
| `.leftnav .nav-item:has-text('X')` | 4 | go to tab X |
| `[data-testid="mode-<id>"]` clicks | ~25 (mode suites) | switch mode |
| `[data-testid="nav-analytics"]` href | 1 | the analytics link exists |
| `.qcard, .leftnav, .topbar …` closest() | Studio.tsx click-outside | a click on chrome never deselects |

Migration rule: a tab is opened by *hovering its group, then clicking the item* (`scripts/lib/nav.mjs: openTab`); a mode by *hovering Mode, then clicking the item* (`switchMode`). `.leftnav .nav-item.active` becomes the menubar's "where am I" crumb (`.menubar-here`), which carries the same text. Menu panels stay in the DOM when closed (`hidden`), so `$$eval` listings keep working.

## Decisions

- **Two rows on top**: row 1 = identity and actions (title, save state, ⌘K, Preview, Test, Export, Data, Save); row 2 = the menubar (Programming · Research Tools · Results · Management · Mode) with the "where am I" crumb on the right. 58 + 36 px; the sidebar's 216 px of width goes to the workspace.
- **Menus open on hover-intent (140 ms) or click, switch on hover while one is open, close on leave (220 ms grace), Escape, or a choice.** Full keyboard: ←/→ between groups, ↓ opens, ↑/↓ within, Home/End, Enter, Esc. Items carry a one-line description — the "tool preview".
- **Nothing floats over the workspace except an open menu**, which closes the moment the pointer leaves it or a tool is chosen.
- **Mode is a menu** (brief §3) whose button shows the current environment (`Mode · 02 Grid`); Split, Focus and the chooser live inside it.
- **Overflow**: groups that do not fit fold, right-to-left, into a `More` group; under 900 px the whole bar is one `Menu` button opening the full hierarchy.
- **Focus in Studio mode** (brief §8): the menubar auto-hides (a hairline you hover to reveal), unselected question cards go quiet.
- **Nothing removed**: every `NAV` entry, every top-bar action, every mode command, the analytics link and the counts move as they are.
