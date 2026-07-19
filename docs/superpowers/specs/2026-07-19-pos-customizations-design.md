# POS Customizations & Arrangeable Menu — Design

## Context

This is the fifth sub-project in the multi-tenant Beanline build, following shop discovery.
The POS today is a flat tap-to-add grid with a bill panel: no sizes, no drink options, no
control over card placement. This sub-project makes the register fit a real coffee business:
standard drink customizations (size, sugar, hot/iced, note), per-shop control over which of
those appear, per-item size pricing, and an owner-arranged card layout grouped by category.

Decisions made during brainstorming:

- **No new role.** Owner already covers "admin" — menu editing, settings, POS all included.
- **Structured model, not a modifier engine.** The customization set is fixed and standard
  (size, sugar, temperature, note). Shops toggle fields off, not invent new ones. A generic
  modifier engine (Square/Toast style) is explicitly out of scope; nothing here blocks
  migrating to one later.
- **POS only.** The customer self-order page is untouched in this sub-project.
- **Per-item size pricing.** Each drink can carry its own Medium/Large prices; the existing
  `price` column is the Small/base price.
- Rename the menu editor's "86 it" button to "Mark unavailable" (restaurant slang confused
  the owner; plain language wins).

## Data model

### `menu_items` — new columns

| Column | Type | Meaning |
|---|---|---|
| `item_type` | TEXT NOT NULL DEFAULT 'drink', CHECK in ('drink','food') | Drinks get customization pickers; food gets only the note field |
| `price_medium` | NUMERIC, nullable | Medium price. NULL = this item has no Medium size |
| `price_large` | NUMERIC, nullable | Large price. NULL = no Large size |
| `sort_order` | INTEGER NOT NULL DEFAULT 0 | Position within its category section on the POS grid |

Existing `price` is reinterpreted as the Small/base price. An item with both size prices
NULL is single-size: the POS shows no size picker for it even when sizes are enabled.

### `shops` — new columns

| Column | Type | Meaning |
|---|---|---|
| `pos_show_size` | BOOLEAN NOT NULL DEFAULT true | Show the size picker at this shop's register |
| `pos_show_sugar` | BOOLEAN NOT NULL DEFAULT true | Show sugar level |
| `pos_show_temp` | BOOLEAN NOT NULL DEFAULT true | Show hot/iced |
| `pos_show_note` | BOOLEAN NOT NULL DEFAULT true | Show the free-text note field |
| `category_order` | TEXT[], nullable | Saved ordering of category sections. NULL = alphabetical |

### Order lines — extended `items_json` shape

Orders have no line-item table; lines live in `orders.items_json` (a JSON array). Each
line gains optional fields alongside the existing `{ name, qty, price }`:

| Field | Values | Meaning |
|---|---|---|
| `size` | 'small' \| 'medium' \| 'large' | Absent for food, single-size items, or shops with sizes off |
| `sugar` | 'none' \| 'less' \| 'normal' \| 'extra' | |
| `temperature` | 'hot' \| 'iced' | |
| `note` | free text | Trimmed, max 140 chars |

The line's `price` (already the per-unit price snapshot) records the size-correct price
at time of sale — Medium and Large sales snapshot `price_medium`/`price_large`. The server
validates every field against these enums before saving; values are never stored
unvalidated just because the container is JSON.

All new fields are optional, so existing order rows and old receipts render unchanged.
The only schema migration is `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on `menu_items`
and `shops`, idempotent like all prior migrations.

## Shop settings — POS options section

`/shop/settings` gains a "POS options" panel: four checkboxes (size, sugar, hot/iced,
note) posted with the existing settings form. Owner-only, same route, same access rules.
Each shop's toggles affect only that shop's register.

## Menu editor changes

- Each item row/form gets an **item type** selector (Drink / Food).
- Drink items show two extra price inputs: **Medium** and **Large**, optional, validated
  like the existing price (positive, two decimals) when present. The existing price field
  is relabeled "Price (Small / base)".
- "86 it" button text becomes **"Mark unavailable"**; "Restock" stays.

## POS flow

### Grid

Items render grouped into **category sections** — a header per category, cards beneath,
sections ordered by `shops.category_order` (alphabetical fallback), cards ordered by
`sort_order`. Category filter pills are replaced by the sections themselves (scrolling a
one-page grid beats filtering for register speed).

### Adding an item

- **Food item** (or drink at a shop with all pickers off): tap → straight into the bill,
  as today. If notes are enabled, the bill line gets a small "note" affordance.
- **Drink**: tap → customization panel appears at the top of the right column, above the
  bill: item name, size buttons showing each size's real price (only sizes the item has),
  sugar level buttons, hot/iced buttons, note input — each only if the shop has it enabled.
  Defaults preselected: smallest available size, normal sugar, hot, empty note. "Add to
  sale" commits the line; tapping another card switches the panel to that item.
- Bill lines display the combo compactly: `Latte · M · iced · no sugar · "oat milk"`.
  Lines with identical item + size + sugar + temperature + note merge into one line with
  quantity; any difference makes a separate line.

### Submission

The current `qty_<id>` form fields can't carry per-line customizations. The POS form
switches to a single hidden field containing a JSON array of lines:
`[{ itemId, qty, size, sugar, temperature, note }]`. The server parses, validates every
value against the allowed enums and the item's actual sizes, recomputes prices
server-side from the database (never trusting client prices), and rejects the sale if
any line references another shop's item — preserving the existing cross-shop guarantees.

## Drag arrangement (owner only)

- The POS topbar gets an **"Arrange"** toggle, rendered only for owners.
- In arrange mode, tap-to-sell is disabled; cards become draggable (HTML5 drag & drop —
  no library). Dragging a card reorders it within its section or moves it to another
  section (which updates the item's `category`). Dragging a section header reorders
  sections.
- Every drop autosaves via `POST /pos/layout` (owner-only) carrying the new
  `category_order` and per-item `{ id, category, sort_order }`. The server updates only
  items belonging to the owner's shop.
- Staff see the saved arrangement; they never see the Arrange toggle, and `POST
  /pos/layout` rejects staff with 403.

## Receipts & dashboard

- `pos-receipt` and the dashboard's order lines show each line's customizations in the
  same compact format, so a barista can make the drink from the ticket.
- The n8n webhook payload's line items include the new fields.

## Error handling

- Malformed lines JSON → re-render POS with a generic error, sale not created.
- Line referencing an unknown/cross-shop/unavailable item → sale rejected (existing rule).
- Size not offered by the item, or a customization value outside its enum → sale rejected.
- Layout save with an item id not in the owner's shop → that item ignored; others applied.

## Testing

Same discipline as prior sub-projects — `node:test` + supertest against real Postgres:

- Model tests: size pricing snapshot, customization columns persisted, layout updates.
- Route tests: POS sale with customizations end-to-end; validation rejections (bad enum,
  size the item doesn't have, cross-shop item id); settings toggles round-trip; layout
  save as owner works, as staff 403s, cross-shop layout writes can't touch another shop.
- Existing suite must stay green: old-style sales (no customizations) still work, old
  orders still render.

## Out of scope

- Customer self-order customizations (next sub-project candidate).
- Generic modifier engine / custom modifier creation.
- Reporting on customizations.
- Touch-screen drag polish beyond standard HTML5 DnD.
