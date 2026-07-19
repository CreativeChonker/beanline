# Menu Page Polish — Design

Owner-requested polish, approved 2026-07-20. CSS/markup only; no route, data, or behavior
changes; existing 145 tests stay green.

1. **Sticky sidebar (app-wide).** `.app-sidebar` becomes `position: sticky; top: 0;
   height: 100vh; overflow-y: auto` inside the flex `.app-shell`, so it stays fixed while
   the main column scrolls — on every page using the shell.

2. **Green/red availability pills.** New palette tokens `--green: #3e7d4f` and
   `--green-deep: #2f6b40` in `partials-head.ejs` (muted sage to fit the warm theme).
   Menu editor pills: Available = soft green background + `--green-deep` text;
   Sold out = cherry red, slightly stronger tint than today. Dashboard's gold order-status
   pill is untouched.

3. **Two-column menu layout.** `views/menu-edit.ejs` main content becomes a flex row:
   left = category sections (`flex: 1`), right = Add-a-New-Item panel at 400px fixed
   width, `position: sticky; top: 24px`, its own `max-height`/scroll if taller than the
   viewport; form fields reflow to a 2-column grid inside the narrow panel. Below 1100px
   the layout stacks (panel after sections) as today. The topbar "+ Add New Item" button
   keeps its focus-Name behavior (anchor scroll is a no-op on desktop since the panel is
   always visible).

Verification: full suite + visual pass in the running app (scroll behavior, pill colors,
sticky panel, narrow-viewport fallback).
