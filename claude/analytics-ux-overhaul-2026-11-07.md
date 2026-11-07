# Analytics Studio UX overhaul (2026-11-07) — patch 0090

| Requirement | What changed |
|---|---|
| Tables: no dropdown | Explore → Tables is a card grid of every saved analysis with a table (preview, kind, n, find box, "Show more"). Clicking a card makes it the active table (outlined, `aria-current`), shown full width above the grid with sort, row filter, table switcher, Expand, Edit definition, Excel. The old select is gone; saved-analysis behaviour is unchanged. |
| Segments | Result charts: segments are toggle chips (All respondents + each segment, × on selected); two or more selected render side by side as small multiples instead of replacing each other. Builder: a "Selected" tray lists every chosen segment (including inline copies of segments since deleted) with remove buttons. |
| Overlaps | `.ar-pane-head` is a minimum height that wraps (all IDE panes), not a fixed 38 px. Architect side panes are capped by viewport width (`min(px, 24vw / 26vw)`), view switches and the summary wrap, the objective has its own line. Combined stacks by the workspace pane's width (container query), not the window's. |
| Tables preview vs edit | One scroller per table (no `axa-work` / `axa-combined-table` nesting). Preview = sized ProTable + "Expand table". Expand opens `TableDialog` (all tables as tabs, heat / counts / dense / decimals, Edit in builder, Escape closes). |
| Properties | New "Tables" section: each table with "Open large", and "+ New table" (rows × columns from the survey's variables → saved crosstab / frequency analysis). |
| Heatmap | Correlation with a single pair no longer shows an empty "No data to chart" heatmap. |

New shared component: `apps/studio/components/analytics/TableViews.tsx` (TablePreview, TableFormatBar, TableDialog).

## Verification
Typecheck (22 workspaces), studio tests 1170/0, `pnpm audit:code` clean, studio `next build` clean.
`scripts/analytics-test.mjs` was stale since Analytics M1 (five places → four); its nav map and home assertion
are updated, the Architect catalogue is mocked, and new checks cover the table cards, the dialog, and
pane-head overlap at 1280 and 1024 px. 93 checks pass up to §10, which still waits on `/sandbox` (unrelated, pre-existing).
