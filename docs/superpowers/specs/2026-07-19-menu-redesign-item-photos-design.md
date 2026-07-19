# Menu Editor Redesign + Item Photos — Design

## Context

Sixth sub-project of the Beanline build, following POS customizations. The owner provided a
visual mockup of a redesigned menu editor: item photo thumbnails, collapsible category
sections with icons and counts, refined rows with a status pill and an overflow menu, a
richer add-item panel with a category dropdown and image upload, and a polished sidebar.

Scope decisions from brainstorming:

- **In scope:** the menu page redesign, item photos (stored via the existing object-storage
  pipeline), photos surfaced on the POS cards and the customer order page, and the sidebar
  polish across all app screens.
- **Out of scope:** the mockup's Reports and Customers pages (separate future sub-projects;
  their nav links are NOT added — nav only shows pages that exist). No behavior changes to
  ordering/POS logic beyond displaying photos.

## Data & storage

- `menu_items` gains one column: `image_url TEXT` (nullable). Migration is
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, idempotent.
- Image bytes go through `lib/storage.js` (MinIO locally, R2 in production) — the app
  stores only the URL, same rule as shop cover photos.
- Object keys: `shops/<shopId>/items/<itemId>-<timestamp>.<ext>` for edits; for creates
  (no item id yet) `shops/<shopId>/items/new-<timestamp>.<ext>` uploaded after the row is
  inserted, then the URL saved — implementation may insert first and upload second so the
  real id is available.
- Accepted types: `image/jpeg`, `image/png`, `image/webp`. Max size: **5MB** (shared
  multer limit with cover photos; the mockup's "2MB" label is superseded — UI copy says
  "JPG, PNG, or WEBP up to 5MB").
- A rejected or failed upload never clears an existing photo and never discards the rest
  of the submitted form (re-render with values preserved and an error message).
- `models/menuItems.js`: `ITEM_COLUMNS` gains `image_url`; `createMenuItem`/
  `updateMenuItem` accept an optional `imageUrl` (create) and a COALESCE-style update
  (edit: passing null leaves the existing photo untouched — same pattern as
  `updateShopProfile.coverPhotoUrl`). A new narrow helper `setItemImage(queryable,
  shopId, id, imageUrl)` is acceptable instead if it keeps the form handlers simpler.

## Add / Edit forms

Both `POST /menu` and `POST /menu/:id` become `multipart/form-data` (multer, field name
`itemImage`), preserving all existing field validation.

Add panel (bottom of the menu page, matching the mockup):

- Fields: Name · Category **dropdown** · Type (Drink/Food) · Price (S / Base) · Price M ·
  Price L · Note · image upload box ("Upload Image — JPG, PNG or WEBP up to 5MB") ·
  "Add Item" primary button.
- The Category dropdown lists the shop's existing categories plus a "New category…"
  option; choosing it reveals a text input. Submitted value is a single `category` string
  either way (a tiny inline script swaps which control feeds the field).
- The topbar gains a "+ Add New Item" button that scrolls to this panel and focuses the
  Name field. It is a scroll anchor, not a modal.

Edit page mirrors the same fields, pre-filled, showing the current photo with the upload
control beneath it.

## Menu page — sections and rows

- Items grouped into **collapsible category sections**: header row with a category icon,
  category name, item count ("2 items"), and a chevron. Collapse state is per-visit
  (client-side only, all sections open on load — no persistence).
- Category icons: a small built-in map from common category names (coffee/espresso/drinks
  → cup icon; bakery/food/pastry → pastry icon; tea → leaf icon) with a default cup icon
  for anything unmatched. Inline SVG, consistent with the app's existing icon style.
- Item rows, left to right:
  - 48px square photo thumbnail, rounded; neutral placeholder glyph block when
    `image_url` is null (no layout jump).
  - Name (display font) with the note underneath in muted text.
  - Status pill: "Available" (gold tint) / "Sold out" (cherry tint) — existing styles.
  - Price: base price, with ` / $M / $L` appended when size prices exist.
  - Actions: **Edit** button, **Mark unavailable**/**Restock** button, and a "⋯" overflow
    button whose small dropdown holds **Remove** (destructive action moved out of the
    always-visible row; still a POST form with the existing route).
- Empty state unchanged in behavior, restyled to match.

## Sidebar polish (all app screens using the sidebar)

Applies to dashboard, menu, POS, settings, and the menu-item edit page:

- Brand block: Beanline mark + the shop's actual name as a subtitle beneath it (shops are
  already loaded or trivially loadable in each route; pass `shop` where missing).
- Nav items get small inline SVG icons (Orders, Menu, POS, Settings). No Reports or
  Customers entries.
- Footer: avatar circle showing the user's first initial, name line ("Owner · Mike"
  pattern stays), role line, and a Log out button styled as in the mockup.

## Photos on POS and customer order page

- POS menu cards: thumbnail block above name/price (photo or placeholder — cards stay
  equal height). No behavior change to tap/customize/arrange logic; in arrange mode the
  image is part of the draggable card.
- Customer order page (`views/order.ejs`): item rows/cards show the thumbnail the same
  way. Display-only — no ordering behavior changes.

## Error handling

- Upload too large → multer error → re-render with "Image must be under 5MB.", form
  values preserved, existing photo untouched.
- Wrong file type → "Please upload a JPG, PNG, or WEBP image.", same preservation rules.
- Storage upload failure (network) → error surfaces through the normal error handler; the
  item row is not left half-created with a broken URL (create: insert-then-upload means a
  failed upload leaves a photo-less item and shows an error; acceptable and stated).

## Testing

`node:test` + supertest against real Postgres and MinIO, as everywhere else:

- Model: `image_url` persists and returns; null-leaves-untouched update semantics.
- Routes: create with photo stores URL and the URL serves from MinIO; edit replaces the
  photo; bad type rejected without clobbering photo or losing fields; create without
  photo works unchanged.
- Views: menu page shows thumbnails and the category dropdown options; POS page and
  customer order page include the image URL when set and render without one.
- Cross-shop: photo upload/edit routes remain owner-scoped to the session shop (existing
  guarantees; regression-locked by existing tests).
- Full existing suite (132) stays green.

## Out of scope

- Reports page, Customers page (and their nav links).
- Image resizing/cropping/thumbnailing server-side (browsers scale the thumbnail).
- Persisted collapse state, drag-reordering on the menu editor (POS arrange already
  covers layout).
- Any change to sale/order logic.
