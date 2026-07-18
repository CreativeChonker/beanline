# Menu Management — Design

## Context

This is the second sub-project in the multi-tenant coffee shop SaaS rebuild, following
[Tenancy & Shop Accounts](2026-07-18-tenancy-shop-accounts-design.md), which is complete
and merged. That sub-project deliberately kept `menu.js` as a single shared static file
for all shops, deferring per-shop menus. This sub-project replaces that placeholder: each
shop gets its own editable menu, managed by its owner.

## Goals

- Let a shop owner add, edit, and remove their own menu items.
- Let an owner mark an item temporarily unavailable ("86'd") without deleting it, so its
  price/description survive a restock.
- Give new shops a working starter menu at signup instead of a blank editor.
- Make `/:shopSlug/order` (the customer-facing ordering page) read from the shop's own
  menu instead of the shared static file.

## Non-goals

- Staff editing the menu — owner-only, matching the owner/staff split from the tenancy
  sub-project.
- Photo/image uploads for menu items — text-only fields, as today.
- Category management as its own entity (no separate `categories` table, no per-category
  ordering/icons beyond what free text supports).
- Any change to POS, payments, or order placement logic beyond swapping the menu data
  source.

## Data model

```
menu_items
  id            INTEGER PRIMARY KEY
  shop_id       INTEGER NOT NULL REFERENCES shops(id)
  name          TEXT NOT NULL
  price         NUMERIC(10,2) NOT NULL
  category      TEXT NOT NULL           -- free text, owner-defined (e.g. "Coffee", "Pastries")
  note          TEXT NOT NULL DEFAULT ''
  available     BOOLEAN NOT NULL DEFAULT true
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
```

`price` uses `NUMERIC(10,2)` (not `REAL`), consistent with the `orders.total` fix applied
at the end of the tenancy sub-project — money is never stored as binary float in this
codebase.

An index on `shop_id` (`CREATE INDEX ON menu_items(shop_id)`) supports the two query
patterns: an owner's full menu (all items, `/menu`) and a customer's orderable menu
(`available = true` items, `/:shopSlug/order`).

No foreign key or dedicated table for `category` — it's a plain text column on
`menu_items`. Distinct category values for a shop are derived with
`SELECT DISTINCT category FROM menu_items WHERE shop_id = $1`, not stored separately.

## Routes

All owner-only, scoped via `session.user.shopId` — no shop slug in the URL, matching the
existing `/dashboard` pattern (an owner only ever manages their own shop).

- `GET /menu` — renders the owner's full menu (including unavailable items) with
  inline edit/delete/toggle controls and an "add item" form.
- `POST /menu` — creates a new item for the owner's shop.
- `POST /menu/:id` — updates an existing item's name/price/category/note. 404s if `:id`
  doesn't belong to the owner's shop (never trusts the client-supplied id alone — always
  filters by `shop_id = session.user.shopId` in the same query).
- `POST /menu/:id/toggle` — flips `available` true/false.
- `POST /menu/:id/delete` — removes the item.

`requireAuth` + `requireRole('owner')` gates all five routes — staff hitting `/menu`
directly get 403, matching the "owner only" decision.

## Customer-facing change

`GET /:shopSlug/order` and `POST /:shopSlug/order` (from the tenancy sub-project) swap
their `menu` source: instead of `require('./menu')` (the shared static file), they query
`SELECT * FROM menu_items WHERE shop_id = $1 AND available = true ORDER BY category, name`
for `req.shop.id`. The order form's category pills (`All`, plus whatever categories exist)
become dynamic — built from the distinct `category` values actually present in that shop's
available items, rather than the hardcoded `Coffee`/`Bakery` pills in today's markup.

If a shop has zero available items (a brand-new, not-yet-configured shop, or one that
deleted everything), the order page shows an empty-menu state rather than crashing —
"This shop hasn't added anything to their menu yet."

## Seeding new shops

`POST /shops/new` (from the tenancy sub-project) already creates a shop and its owner in
one `db.withTransaction` call. This sub-project extends that same transaction to also
insert a handful of starter `menu_items` rows for the new shop, reusing the current
static `menu.js` content (Latte, Cappuccino, Americano, Espresso, Croissant, Muffin) as
the seed data. The static `menu.js` file itself is retired from the ordering path — its
content moves into a seed-data module (`db/seed-menu.js`) consumed only at shop-creation
time, not read by any request-serving route anymore.

New owners land on `/dashboard` after signup (unchanged), and now have a working `/menu`
screen with editable starter items rather than nothing.

## Edge cases

- Deleting a menu item that has already been ordered: orders store their line items as a
  JSON snapshot (`items_json`) at order time, not a live reference to `menu_items`, so
  deleting or editing an item never changes historical order records. No cascading
  delete/update concern.
- Price validation: reject non-positive prices and non-numeric input with a form error,
  same style as existing form validation (e.g. shop slug validation).
- Category free text: no validation beyond non-empty — an owner can create as many or as
  few categories as they want, including typos that produce near-duplicate categories
  (e.g. "Coffee" vs "coffee"). Accepted as a known limitation; a category-management
  screen with autocomplete/normalization is a future enhancement, not required now.
- `POST /menu/:id` and `/menu/:id/toggle` and `/menu/:id/delete` on an `:id` belonging to
  a different shop (or a non-existent id) — treated identically to "not found": 404,
  never a silent no-op or an error that leaks whether the id exists elsewhere.

## Testing focus

- Owner of shop A cannot edit, toggle, or delete shop B's menu items via crafted `:id`
  values — the cross-shop isolation invariant, same as the tenancy sub-project's core
  concern, now applied to a new resource type.
- Staff (non-owner) hitting any `/menu` route gets 403.
- A customer's `/:shopSlug/order` page only ever shows `available = true` items for that
  specific shop, never another shop's items and never unavailable items.
- New shop signup produces a non-empty starter menu, editable immediately.
- Deleting/editing a menu item does not alter any existing order's stored line items.
