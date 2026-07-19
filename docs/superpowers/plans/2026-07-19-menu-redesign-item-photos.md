# Menu Editor Redesign + Item Photos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the menu editor to the approved mockup — item photos, collapsible category sections, refined rows with an overflow menu, a richer add panel — plus a shared polished sidebar, with photos surfacing on the POS and customer order pages.

**Architecture:** `menu_items` gains a single nullable `image_url`; bytes go through the existing `lib/storage.js` (MinIO/R2) and only URLs touch Postgres. The repeated sidebar markup in five views is extracted to `views/partials-sidebar.ejs`. Menu form routes become multipart (existing shared `upload` multer instance) with insert-then-upload on create so keys can carry the real item id.

**Tech Stack:** Unchanged — Node/Express/EJS/pg, `node:test` + supertest against real Postgres + MinIO. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-19-menu-redesign-item-photos-design.md`.
- Accepted image types `image/jpeg`, `image/png`, `image/webp`; max 5MB (shared multer limit). UI copy: "JPG, PNG or WEBP up to 5MB".
- A rejected/failed upload never clears an existing photo and never discards the rest of the submitted form (re-render with values preserved + error).
- Storage keys: `shops/<shopId>/items/<itemId>-<timestamp>.<ext>`.
- No Reports/Customers nav links — nav shows only pages that exist.
- Photos are display-only on POS and order pages: zero behavior changes to sale/order/arrange logic.
- Design tokens come from `partials-head.ejs` (`--espresso`, `--parchment`, `--gold`, `--line`, `--ink-soft`, `--cherry`, fonts). New UI must use them, not new hex values (except neutral `#fff`/`#fffdf8` already in use).
- Existing suite (132 tests) stays green. Every new behavior gets a failing test first.
- Run tests: `npm test` or `npm test -- <file>`.

---

## Task 1: `image_url` column + model support

**Files:**
- Modify: `db/schema.sql` (append), `models/menuItems.js`
- Test: `test/models/menuItems.test.js` (append)

**Interfaces:**
- Produces (consumed by Tasks 2, 4, 5): every item row includes `image_url` (string|null). `createMenuItem` accepts optional `imageUrl` (default null). New `setItemImage(queryable, shopId, id, imageUrl) → updated row | null` (shop-scoped). `updateMenuItem` does NOT touch `image_url` (photo changes go through `setItemImage` only).

- [ ] **Step 1: Append to `db/schema.sql`**

```sql
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS image_url TEXT;
```

Run: `npm run migrate` → `Migration complete.` Run again → same (idempotent).

- [ ] **Step 2: Write the failing tests** (append to `test/models/menuItems.test.js`)

```js
test('createMenuItem stores an image url and defaults to null', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const plain = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Latte', price: 4.5, category: 'Coffee' });
  assert.equal(plain.image_url, null);
  const pictured = await menuItems.createMenuItem(db, {
    shopId: shop.id, name: 'Mocha', price: 5, category: 'Coffee', imageUrl: 'http://img.test/mocha.jpg',
  });
  assert.equal(pictured.image_url, 'http://img.test/mocha.jpg');
});

test('setItemImage sets the photo, is shop-scoped, and updateMenuItem leaves it untouched', async () => {
  const shopA = await shops.createShop(db, { name: 'Shop A', slug: 'shop-a' });
  const shopB = await shops.createShop(db, { name: 'Shop B', slug: 'shop-b' });
  const item = await menuItems.createMenuItem(db, { shopId: shopA.id, name: 'Latte', price: 4.5, category: 'Coffee' });

  const cross = await menuItems.setItemImage(db, shopB.id, item.id, 'http://img.test/hacked.jpg');
  assert.equal(cross, null);

  const set = await menuItems.setItemImage(db, shopA.id, item.id, 'http://img.test/latte.jpg');
  assert.equal(set.image_url, 'http://img.test/latte.jpg');

  const updated = await menuItems.updateMenuItem(db, shopA.id, item.id, {
    name: 'Latte', price: 4.75, category: 'Coffee', note: '', itemType: 'drink', priceMedium: null, priceLarge: null,
  });
  assert.equal(updated.image_url, 'http://img.test/latte.jpg');
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- test/models/menuItems.test.js`
Expected: FAIL — `image_url` undefined on rows, `setItemImage` not a function.

- [ ] **Step 4: Implement in `models/menuItems.js`**

Add `image_url` to `ITEM_COLUMNS`; extend `createMenuItem`; add `setItemImage`:

```js
const ITEM_COLUMNS = `id, shop_id, name, price::float8 AS price, category, note, available,
  item_type, price_medium::float8 AS price_medium, price_large::float8 AS price_large, sort_order, image_url`;

async function createMenuItem(queryable, { shopId, name, price, category, note, itemType = 'drink', priceMedium = null, priceLarge = null, imageUrl = null }) {
  const result = await queryable.query(
    `INSERT INTO menu_items (shop_id, name, price, category, note, item_type, price_medium, price_large, image_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${ITEM_COLUMNS}`,
    [shopId, name, price, category, note || '', itemType, priceMedium, priceLarge, imageUrl]
  );
  return result.rows[0];
}

async function setItemImage(queryable, shopId, id, imageUrl) {
  const result = await queryable.query(
    `UPDATE menu_items SET image_url = $1 WHERE id = $2 AND shop_id = $3 RETURNING ${ITEM_COLUMNS}`,
    [imageUrl, id, shopId]
  );
  return result.rows[0] || null;
}
```

`updateMenuItem` stays exactly as it is (no image_url in its SET list). Export `setItemImage`.

- [ ] **Step 5: Run tests** — `npm test` → 132 prior + 2 new green.

- [ ] **Step 6: Commit**

```bash
git add db/schema.sql models/menuItems.js test/models/menuItems.test.js
git commit -m "feat: menu items carry an image url"
```

---

## Task 2: Photo upload on the menu form routes

**Files:**
- Modify: `server.js` (`POST /menu`, `POST /menu/:id`, and their GET re-render calls)
- Test: `test/routes/menu.test.js` (append)

**Interfaces:**
- Consumes: Task 1 (`createMenuItem` imageUrl, `setItemImage`), `lib/storage.js` `uploadImage`, existing `upload` multer instance in server.js.
- Produces: both menu forms accept multipart with optional file field `itemImage`. Views receive `values` (object, `{}` by default) for re-fill on error — consumed by Task 4's views. Renders of `menu-edit` must now always pass `values`; renders of `menu-item-edit` are unchanged in shape (item fields refilled from `item`).

- [ ] **Step 1: Write the failing tests** (append to `test/routes/menu.test.js`; use the existing `ownerAgentWithShop` helper, names prefixed `Photo` to dodge the seeded menu)

```js
test('POST /menu with a photo stores it in object storage and saves the URL', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const res = await agent.post('/menu')
    .field('name', 'Photo Latte').field('category', 'Coffee').field('price', '4.50').field('itemType', 'drink')
    .attach('itemImage', Buffer.from('fake jpeg bytes'), { filename: 'latte.jpg', contentType: 'image/jpeg' });
  assert.equal(res.status, 302);

  const row = await db.query("SELECT image_url FROM menu_items WHERE shop_id = $1 AND name = 'Photo Latte'", [shopId]);
  assert.match(row.rows[0].image_url, /^http/);
  const imageRes = await fetch(row.rows[0].image_url);
  assert.equal(imageRes.status, 200);
});

test('POST /menu with a non-image file re-renders with the form values preserved and creates nothing', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const res = await agent.post('/menu')
    .field('name', 'Photo Latte').field('category', 'Coffee').field('price', '4.50').field('itemType', 'drink')
    .attach('itemImage', Buffer.from('not an image'), { filename: 'notes.txt', contentType: 'text/plain' });
  assert.equal(res.status, 200);
  assert.match(res.text, /JPG, PNG, or WEBP/);
  assert.match(res.text, /value="Photo Latte"/);

  const row = await db.query("SELECT COUNT(*)::int AS n FROM menu_items WHERE shop_id = $1 AND name = 'Photo Latte'", [shopId]);
  assert.equal(row.rows[0].n, 0);
});

test('POST /menu/:id with a bad file keeps the existing photo and the item unchanged', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  await agent.post('/menu')
    .field('name', 'Photo Mocha').field('category', 'Coffee').field('price', '5.00').field('itemType', 'drink')
    .attach('itemImage', Buffer.from('fake jpeg bytes'), { filename: 'mocha.jpg', contentType: 'image/jpeg' });
  const before = await db.query("SELECT id, image_url FROM menu_items WHERE shop_id = $1 AND name = 'Photo Mocha'", [shopId]);

  const res = await agent.post(`/menu/${before.rows[0].id}`)
    .field('name', 'Photo Mocha').field('category', 'Coffee').field('price', '5.25').field('itemType', 'drink')
    .attach('itemImage', Buffer.from('nope'), { filename: 'x.gif', contentType: 'image/gif' });
  assert.equal(res.status, 200);
  assert.match(res.text, /JPG, PNG, or WEBP/);

  const after = await db.query("SELECT image_url, price::float8 AS price FROM menu_items WHERE id = $1", [before.rows[0].id]);
  assert.equal(after.rows[0].image_url, before.rows[0].image_url);
  assert.equal(after.rows[0].price, 5.0);
});

test('POST /menu/:id with a new photo replaces the old URL', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  await agent.post('/menu')
    .field('name', 'Photo Flat').field('category', 'Coffee').field('price', '4.00').field('itemType', 'drink')
    .attach('itemImage', Buffer.from('v1'), { filename: 'a.png', contentType: 'image/png' });
  const before = await db.query("SELECT id, image_url FROM menu_items WHERE shop_id = $1 AND name = 'Photo Flat'", [shopId]);

  await agent.post(`/menu/${before.rows[0].id}`)
    .field('name', 'Photo Flat').field('category', 'Coffee').field('price', '4.00').field('itemType', 'drink')
    .attach('itemImage', Buffer.from('v2'), { filename: 'b.png', contentType: 'image/png' });
  const after = await db.query("SELECT image_url FROM menu_items WHERE id = $1", [before.rows[0].id]);
  assert.notEqual(after.rows[0].image_url, before.rows[0].image_url);
  assert.match(after.rows[0].image_url, /^http/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/routes/menu.test.js`
Expected: FAIL — multipart fields aren't parsed by urlencoded (name arrives empty → validation error), no image handling.

- [ ] **Step 3: Rework the two handlers in `server.js`**

Shared bits (place above the menu routes):

```js
const ITEM_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

async function uploadItemImage(shopId, itemId, file) {
  const ext = file.mimetype.split('/')[1];
  const key = `shops/${shopId}/items/${itemId}-${Date.now()}.${ext}`;
  return storage.uploadImage(file.buffer, key, file.mimetype);
}
```

`POST /menu` becomes:

```js
app.post('/menu', requireAuth, requireRole('owner'), (req, res, next) => {
  upload.single('itemImage')(req, res, async (uploadErr) => {
    const shopId = req.session.user.shopId;
    const rerender = async (error, values) => {
      const items = await menuItems.getMenuItemsForShop(db, shopId);
      res.render('menu-edit', { items, error, values: values || {} });
    };
    try {
      if (uploadErr) {
        const message = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 5MB.' : 'Upload failed.';
        return rerender(message, req.body);
      }
      const { name, category, price, note, itemType, priceMedium, priceLarge } = req.body;
      const parsedPrice = parseFloat(price);
      const type = itemType === 'food' ? 'food' : 'drink';
      const parseSize = (v) => {
        if (v === undefined || v === '') return null;
        const n = parseFloat(v);
        return Number.isNaN(n) || n <= 0 ? undefined : n;
      };
      const parsedMedium = parseSize(priceMedium);
      const parsedLarge = parseSize(priceLarge);
      if (!name || !category || !price || Number.isNaN(parsedPrice) || parsedPrice <= 0
          || parsedMedium === undefined || parsedLarge === undefined) {
        return rerender('Please provide a name, category, and a valid price.', req.body);
      }
      if (req.file && !ITEM_IMAGE_TYPES.includes(req.file.mimetype)) {
        return rerender('Please upload a JPG, PNG, or WEBP image.', req.body);
      }
      const item = await menuItems.createMenuItem(db, {
        shopId, name, category, price: parsedPrice, note: note || '',
        itemType: type, priceMedium: parsedMedium, priceLarge: parsedLarge,
      });
      if (req.file) {
        const url = await uploadItemImage(shopId, item.id, req.file);
        await menuItems.setItemImage(db, shopId, item.id, url);
      }
      res.redirect('/menu');
    } catch (err) {
      next(err);
    }
  });
});
```

`POST /menu/:id` becomes the same shape: `upload.single('itemImage')` wrapper; on `uploadErr` or validation failure re-render `menu-item-edit` with `{ item, error }` where `item` is fetched via `getMenuItemById` (404 if missing) — the edit form refills from `item`, so no `values` needed there; file-type check before any write; then `updateMenuItem(...)` (404 if null), and if `req.file`, `uploadItemImage` + `setItemImage`. Redirect `/menu`.

Also update `GET /menu`'s render and any other `res.render('menu-edit', ...)` call sites to include `values: {}`.

- [ ] **Step 4: Run tests** — the new tests pass except the `value="Photo Latte"` assertion, which needs Task 4's view refill. To keep this task self-contained, add the minimal refill NOW: in `views/menu-edit.ejs`'s add form, change the Name/Category/Price/Note inputs to include `value="<%= (values && values.name) || '' %>"` etc. (`values.category`, `values.price`, `values.priceMedium`, `values.priceLarge`, `values.note`), and default `<% values = typeof values === 'undefined' ? {} : values %>` at the top of the file. Task 4 rebuilds this form and must keep the refill.

Run: `npm test` → everything green.

- [ ] **Step 5: Commit**

```bash
git add server.js views/menu-edit.ejs test/routes/menu.test.js
git commit -m "feat: menu item photo uploads through object storage"
```

---

## Task 3: Shared sidebar partial

**Files:**
- Create: `views/partials-sidebar.ejs`
- Modify: `views/partials-head.ejs` (sidebar CSS additions), `views/dashboard.ejs`, `views/menu-edit.ejs`, `views/menu-item-edit.ejs`, `views/pos.ejs`, `views/shop-settings.ejs`, `server.js` (pass `shop` + `active` where missing)
- Test: `test/routes/sidebar.test.js` (create)

**Interfaces:**
- Produces: `<%- include('partials-sidebar', { active: 'menu' }) %>` — needs `shop` (with `.name`) and `user` (with `.name`, `.role`) in render locals. `active` ∈ `'orders' | 'menu' | 'pos' | 'settings'`.
- Consumes: `shops.getShopById` (routes that don't already load the shop must).

- [ ] **Step 1: Write the failing tests**

```js
// test/routes/sidebar.test.js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db, migrate, resetDb } = require('../../testHelpers/db');

before(async () => { await migrate(); });
beforeEach(async () => { await resetDb(); });
after(async () => { await db.pool.end(); });

async function ownerAgent(app) {
  const agent = request.agent(app);
  await agent.post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex Owner', email: 'alex@bb.test', password: 'hunter2',
  });
  return agent;
}

test('the sidebar shows the shop name, nav icons, and the user avatar on every app page', async () => {
  const app = require('../../server');
  const agent = await ownerAgent(app);
  for (const path of ['/dashboard', '/menu', '/pos', '/shop/settings']) {
    const res = await agent.get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.text, /class="app-shop-name">Blue Bottle</, path);
    assert.match(res.text, /class="app-avatar">A</, path);
    assert.match(res.text, /class="app-nav-icon"/, path);
  }
});

test('the sidebar has no Reports or Customers links', async () => {
  const app = require('../../server');
  const agent = await ownerAgent(app);
  const res = await agent.get('/dashboard');
  assert.doesNotMatch(res.text, />Reports</);
  assert.doesNotMatch(res.text, />Customers</);
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -- test/routes/sidebar.test.js` → FAIL (no `app-shop-name`).

- [ ] **Step 3: Create `views/partials-sidebar.ejs`**

```html
<% const roleLabel = { owner: 'Owner', staff: 'Staff', customer: 'Customer' }[user.role] || user.role; %>
<div class="app-sidebar">
  <div class="app-mark">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 8h13a3 3 0 0 1 0 6h-1"/><path d="M4 8v7a4 4 0 0 0 4 4h5a4 4 0 0 0 4-4V8"/><path d="M8 2.5c0 1-1 1.2-1 2.2s1 1.2 1 2.2M12.5 2.5c0 1-1 1.2-1 2.2s1 1.2 1 2.2"/></svg>
    <div>
      <span>Beanline</span>
      <div class="app-shop-name"><%= shop.name %></div>
    </div>
  </div>
  <a class="app-nav-item <%= active === 'orders' ? 'active' : '' %>" href="/dashboard">
    <svg class="app-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2"/><rect x="9" y="2.5" width="6" height="3.5" rx="1"/><path d="M9 11h6M9 15h4"/></svg>
    Orders</a>
  <% if (user.role === 'owner') { %>
  <a class="app-nav-item <%= active === 'menu' ? 'active' : '' %>" href="/menu">
    <svg class="app-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>
    Menu</a>
  <% } %>
  <a class="app-nav-item <%= active === 'pos' ? 'active' : '' %>" href="/pos">
    <svg class="app-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M7 21h10M12 17v4"/></svg>
    POS</a>
  <% if (user.role === 'owner') { %>
  <a class="app-nav-item <%= active === 'settings' ? 'active' : '' %>" href="/shop/settings">
    <svg class="app-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    Settings</a>
  <% } %>
  <div class="app-sidebar-foot">
    <div class="app-foot-user">
      <div class="app-avatar"><%= user.name.charAt(0).toUpperCase() %></div>
      <div>
        <div class="who"><%= roleLabel %> · <%= user.name %></div>
        <div class="app-foot-role"><%= user.role === 'owner' ? 'Administrator' : roleLabel %></div>
      </div>
    </div>
    <a class="app-logout" href="/logout">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/></svg>
      Log out</a>
  </div>
</div>
```

Note the Menu and Settings links render only for owners — this preserves current behavior (staff never had those links on their pages; verify against the current `dashboard.ejs`, which staff see: if it shows Menu/Settings to staff today, keep them unconditional instead and drop the `<% if %>` guards — match existing behavior exactly, don't change access).

- [ ] **Step 4: Add sidebar CSS to `partials-head.ejs`** (after the existing `.app-sidebar-foot a:hover` rule)

```css
  .app-mark .app-shop-name { font-size: 11px; color: var(--cream-ink-soft); font-family: var(--font-body); font-weight: 500; margin-top: 1px; }
  .app-nav-icon { width: 17px; height: 17px; flex-shrink: 0; }
  .app-foot-user { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .app-avatar {
    width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;
    background: var(--espresso-3); color: var(--cream-ink);
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 14px; font-family: var(--font-display);
  }
  .app-foot-role { font-size: 11.5px; color: var(--cream-ink-soft); margin-top: 1px; }
  .app-logout {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; padding: 9px 10px; border-radius: 8px;
    border: 1px solid var(--espresso-3); color: var(--cream-ink-soft);
    font-size: 13px; text-decoration: none;
  }
  .app-logout:hover { color: var(--gold); border-color: var(--gold); }
  .app-logout svg { width: 15px; height: 15px; }
```

- [ ] **Step 5: Swap the five views to the partial**

In each of `dashboard.ejs`, `menu-edit.ejs`, `menu-item-edit.ejs`, `pos.ejs`, `shop-settings.ejs`, replace the whole `<div class="app-sidebar"> ... </div>` block with:

```html
    <%- include('partials-sidebar', { active: 'orders' }) %>
```

using the right `active` value per page (`orders`, `menu`, `menu` for item-edit, `pos`, `settings`).

In `server.js`, make sure every route rendering those views passes `shop`:
- `GET /dashboard`: add `const shop = await shops.getShopById(db, req.session.user.shopId);` and include `shop` in the render locals.
- `GET /menu`, `POST /menu` re-renders, `GET /menu/:id/edit`, `POST /menu/:id` re-renders: same addition.
- `GET /pos`, `POST /pos` re-renders, `GET/POST /shop/settings`: already load `shop` — just confirm it's in locals everywhere the view renders (including error paths).

- [ ] **Step 6: Run tests** — `npm test` → sidebar tests pass, full suite green (watch for old tests asserting sidebar markup; update only string expectations that changed, never access rules).

- [ ] **Step 7: Commit**

```bash
git add views/partials-sidebar.ejs views/partials-head.ejs views/dashboard.ejs views/menu-edit.ejs views/menu-item-edit.ejs views/pos.ejs views/shop-settings.ejs server.js test/routes/sidebar.test.js
git commit -m "feat: shared polished sidebar with shop name, icons, and avatar footer"
```

---

## Task 4: Menu page redesign

**Files:**
- Modify: `views/menu-edit.ejs` (rewrite main content), `views/menu-item-edit.ejs` (photo UI)
- Test: `test/routes/menu.test.js` (append)

**Interfaces:**
- Consumes: rows with `image_url` (Task 1), `values` refill contract (Task 2), sidebar partial (Task 3).
- Produces: category `<select>` named `categorySelect` + hidden/text input mechanics that always submit a single `category` field.

- [ ] **Step 1: Write the failing tests** (append to `test/routes/menu.test.js`)

```js
test('GET /menu renders collapsible sections, thumbnails, and the category dropdown', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  await db.query("UPDATE menu_items SET image_url = 'http://img.test/x.jpg' WHERE shop_id = $1 AND name = 'Latte'", [shopId]);
  const res = await agent.get('/menu');
  assert.match(res.text, /class="menu-section-toggle"/);
  assert.match(res.text, /src="http:\/\/img.test\/x.jpg"/);
  assert.match(res.text, /class="menu-thumb-placeholder"/);
  assert.match(res.text, /<option value="Coffee">/);
  assert.match(res.text, /New category…/);
  assert.match(res.text, /id="add-item-btn"/);
});

test('the row overflow menu holds Remove and the row keeps Edit and Mark unavailable', async () => {
  const app = require('../../server');
  const { agent } = await ownerAgentWithShop(app);
  const res = await agent.get('/menu');
  assert.match(res.text, /class="overflow-menu"/);
  assert.match(res.text, /Mark unavailable/);
  assert.match(res.text, /Remove/);
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -- test/routes/menu.test.js` → FAIL.

- [ ] **Step 3: Rewrite `views/menu-edit.ejs` main content**

Keep `<%- include('partials-sidebar', { active: 'menu' }) %>` and the head include. Replace the page CSS and the `.app-main` content with:

```html
<style>
  .menu-topbar-actions { display: flex; align-items: center; gap: 12px; }
  .menu-sub { color: var(--ink-soft); font-size: 14px; margin: 4px 0 0; }
  .menu-section { background: #fff; border: 1px solid var(--line); border-radius: 14px; margin-bottom: 18px; overflow: hidden; }
  .menu-section-toggle {
    display: flex; align-items: center; gap: 10px; width: 100%;
    padding: 14px 18px; background: #fffdf8; border: none; border-bottom: 1px solid var(--line);
    font-family: var(--font-display); font-weight: 600; font-size: 16px; color: var(--ink);
    cursor: pointer; text-align: left;
  }
  .menu-section-toggle .cat-icon { width: 20px; height: 20px; color: var(--gold-deep); flex-shrink: 0; }
  .menu-section-toggle .count { margin-left: auto; font-family: var(--font-mono); font-size: 12px; font-weight: 400; color: var(--ink-soft); }
  .menu-section-toggle .chev { width: 16px; height: 16px; color: var(--ink-soft); transition: transform 0.2s ease; }
  .menu-section.collapsed .chev { transform: rotate(180deg); }
  .menu-section.collapsed .menu-rows { display: none; }
  .menu-section.collapsed .menu-section-toggle { border-bottom: none; }
  .menu-row { display: flex; align-items: center; gap: 14px; padding: 12px 18px; border-bottom: 1px solid var(--parchment-2); }
  .menu-row:last-child { border-bottom: none; }
  .menu-row.unavailable { opacity: 0.55; }
  .menu-thumb, .menu-thumb-placeholder {
    width: 48px; height: 48px; border-radius: 10px; flex-shrink: 0;
    border: 1px solid var(--line); object-fit: cover;
  }
  .menu-thumb-placeholder { display: flex; align-items: center; justify-content: center; background: var(--parchment); color: var(--line); }
  .menu-thumb-placeholder svg { width: 22px; height: 22px; }
  .menu-row-info { flex: 1; min-width: 0; }
  .menu-row-name { font-family: var(--font-display); font-weight: 600; font-size: 15px; }
  .menu-row-note { font-size: 12.5px; color: var(--ink-soft); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .status-pill { display: inline-block; flex-shrink: 0; font-size: 11.5px; font-weight: 600; padding: 3px 10px; border-radius: 999px; background: rgba(217,164,65,0.16); color: var(--gold-deep); }
  .status-pill.sold-out { background: rgba(156,59,44,0.08); color: var(--cherry-deep); }
  .menu-row-price { font-family: var(--font-mono); font-size: 14px; color: var(--gold-deep); font-weight: 500; white-space: nowrap; flex-shrink: 0; }
  .menu-row-actions { display: flex; gap: 6px; flex-shrink: 0; position: relative; }
  .menu-row-actions form { display: inline; }
  .btn-small { padding: 7px 13px; border-radius: 7px; font-size: 12.5px; font-weight: 600; cursor: pointer; border: 1px solid var(--line); background: #fff; color: var(--ink-soft); text-decoration: none; }
  .btn-small:hover { border-color: var(--gold); color: var(--gold-deep); }
  .overflow-wrap { position: relative; }
  .overflow-btn { width: 32px; }
  .overflow-menu {
    position: absolute; right: 0; top: calc(100% + 4px); z-index: 10; display: none;
    background: #fff; border: 1px solid var(--line); border-radius: 9px; padding: 4px;
    box-shadow: 0 12px 28px -12px rgba(0,0,0,0.35); min-width: 120px;
  }
  .overflow-wrap.open .overflow-menu { display: block; }
  .overflow-menu button { display: block; width: 100%; text-align: left; padding: 8px 10px; border: none; background: none; border-radius: 6px; font-size: 13px; color: var(--cherry-deep); cursor: pointer; }
  .overflow-menu button:hover { background: rgba(156,59,44,0.08); }
  .empty-state { padding: 60px 20px; text-align: center; color: var(--ink-soft); }
  .empty-state h3 { font-size: 18px; color: var(--ink); margin-bottom: 6px; }
  .add-item-panel { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 22px; }
  .add-item-panel h3 { display: flex; align-items: center; gap: 9px; margin-bottom: 16px; font-size: 17px; }
  .add-item-panel h3 svg { width: 19px; height: 19px; color: var(--gold-deep); }
  .add-item-form { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; align-items: end; }
  .add-item-form .field { margin: 0; }
  .add-item-form .span-2 { grid-column: span 2; }
  .upload-box {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border: 1.5px dashed var(--line); border-radius: 9px; background: var(--parchment); cursor: pointer;
    color: var(--ink-soft); font-size: 12.5px;
  }
  .upload-box:hover { border-color: var(--gold); color: var(--gold-deep); }
  .upload-box svg { width: 18px; height: 18px; flex-shrink: 0; }
  .upload-box input { display: none; }
  .upload-box .upload-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 900px) { .add-item-form { grid-template-columns: 1fr 1fr; } }
</style>
```

Body content inside `.app-main`:

```html
      <div class="app-topbar">
        <div>
          <h1 style="font-size:30px;">Menu</h1>
          <p class="menu-sub">Manage your menu items, prices, and availability.</p>
        </div>
        <div class="menu-topbar-actions">
          <a href="#add-item-panel" class="btn btn-primary" id="add-item-btn" style="width:auto;margin:0;padding:10px 16px;">+ Add New Item</a>
        </div>
      </div>
      <% if (error) { %><p class="order-error"><%= error %></p><% } %>

      <% if (items.length === 0) { %>
        <div class="empty-state"><h3>No items yet</h3><p>Add your first menu item below.</p></div>
      <% } else { %>
        <%
          const categories = [...new Set(items.map((i) => i.category))];
          const catIcon = (cat) => {
            const c = cat.toLowerCase();
            if (/bak|food|pastr|snack|bread|sandwich/.test(c)) return 'pastry';
            if (/tea|matcha/.test(c)) return 'leaf';
            return 'cup';
          };
        %>
        <% categories.forEach((cat) => { %>
          <% const catItems = items.filter((i) => i.category === cat); %>
          <div class="menu-section">
            <button type="button" class="menu-section-toggle">
              <% if (catIcon(cat) === 'pastry') { %>
                <svg class="cat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4c-5 0-9 5.5-9 9a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3c0-3.5-4-9-9-9z"/><path d="M8.5 9.5c1-1.5 2.2-2.3 3.5-2.3s2.5.8 3.5 2.3"/></svg>
              <% } else if (catIcon(cat) === 'leaf') { %>
                <svg class="cat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 4 13c0-5 4-9 9-9a7 7 0 0 1 7 7c0 5-4 9-9 9z"/><path d="M4 21c4-4 7-6 12-8"/></svg>
              <% } else { %>
                <svg class="cat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 8h13a3 3 0 0 1 0 6h-1"/><path d="M4 8v7a4 4 0 0 0 4 4h5a4 4 0 0 0 4-4V8"/></svg>
              <% } %>
              <%= cat %>
              <span class="count"><%= catItems.length %> item<%= catItems.length === 1 ? '' : 's' %></span>
              <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m18 15-6-6-6 6"/></svg>
            </button>
            <div class="menu-rows">
              <% catItems.forEach((item) => { %>
                <div class="menu-row <%= item.available ? '' : 'unavailable' %>">
                  <% if (item.image_url) { %>
                    <img class="menu-thumb" src="<%= item.image_url %>" alt="">
                  <% } else { %>
                    <div class="menu-thumb-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 8h13a3 3 0 0 1 0 6h-1"/><path d="M4 8v7a4 4 0 0 0 4 4h5a4 4 0 0 0 4-4V8"/></svg></div>
                  <% } %>
                  <div class="menu-row-info">
                    <div class="menu-row-name"><%= item.name %></div>
                    <% if (item.note) { %><div class="menu-row-note"><%= item.note %></div><% } %>
                  </div>
                  <span class="status-pill <%= item.available ? '' : 'sold-out' %>"><%= item.available ? 'Available' : 'Sold out' %></span>
                  <div class="menu-row-price">$<%= item.price.toFixed(2) %><% if (item.price_medium) { %> / $<%= item.price_medium.toFixed(2) %><% } %><% if (item.price_large) { %> / $<%= item.price_large.toFixed(2) %><% } %></div>
                  <div class="menu-row-actions">
                    <a class="btn-small" href="/menu/<%= item.id %>/edit">Edit</a>
                    <form method="POST" action="/menu/<%= item.id %>/toggle"><button type="submit" class="btn-small"><%= item.available ? 'Mark unavailable' : 'Restock' %></button></form>
                    <div class="overflow-wrap">
                      <button type="button" class="btn-small overflow-btn" aria-label="More actions">&#8943;</button>
                      <div class="overflow-menu">
                        <form method="POST" action="/menu/<%= item.id %>/delete"><button type="submit">Remove</button></form>
                      </div>
                    </div>
                  </div>
                </div>
              <% }) %>
            </div>
          </div>
        <% }) %>
      <% } %>

      <div class="add-item-panel" id="add-item-panel">
        <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 8h13a3 3 0 0 1 0 6h-1"/><path d="M4 8v7a4 4 0 0 0 4 4h5a4 4 0 0 0 4-4V8"/></svg> Add a New Item</h3>
        <% const cats = [...new Set(items.map((i) => i.category))]; %>
        <form method="POST" action="/menu" class="add-item-form" enctype="multipart/form-data">
          <div class="field span-2"><label for="name">Name</label><input id="name" name="name" type="text" required placeholder="Enter item name" value="<%= values.name || '' %>"></div>
          <div class="field"><label for="categorySelect">Category</label>
            <select id="categorySelect" name="category">
              <% cats.forEach((c) => { %><option value="<%= c %>" <%= values.category === c ? 'selected' : '' %>><%= c %></option><% }) %>
              <option value="__new__">New category…</option>
            </select>
            <input id="categoryNew" name="categoryNew" type="text" placeholder="New category name" style="display:none;margin-top:6px;" value="">
          </div>
          <div class="field"><label for="itemType">Type</label>
            <select id="itemType" name="itemType"><option value="drink" <%= values.itemType === 'drink' ? 'selected' : '' %>>Drink</option><option value="food" <%= values.itemType === 'food' ? 'selected' : '' %>>Food</option></select>
          </div>
          <div class="field"><label for="price">Price (S / Base)</label><input id="price" name="price" type="number" step="0.01" min="0.01" required placeholder="0.00" value="<%= values.price || '' %>"></div>
          <div class="field"><label for="priceMedium">Price M</label><input id="priceMedium" name="priceMedium" type="number" step="0.01" min="0.01" placeholder="0.00" value="<%= values.priceMedium || '' %>"></div>
          <div class="field"><label for="priceLarge">Price L</label><input id="priceLarge" name="priceLarge" type="number" step="0.01" min="0.01" placeholder="0.00" value="<%= values.priceLarge || '' %>"></div>
          <div class="field span-2"><label for="note">Note</label><input id="note" name="note" type="text" placeholder="Add a note (ingredients, description, etc.)" value="<%= values.note || '' %>"></div>
          <div class="field span-2"><label>Image</label>
            <label class="upload-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.6-4.6a1.5 1.5 0 0 0-2.1 0L5 20"/></svg>
              <span><span class="upload-name" id="upload-name">Upload Image</span><br>JPG, PNG or WEBP up to 5MB</span>
              <input id="itemImage" name="itemImage" type="file" accept="image/jpeg,image/png,image/webp">
            </label>
          </div>
          <button type="submit" class="btn btn-primary" style="margin:0;">Add Item</button>
        </form>
      </div>
```

Script (before `</body>`):

```html
  <script>
    document.querySelectorAll('.menu-section-toggle').forEach((btn) => {
      btn.addEventListener('click', () => btn.closest('.menu-section').classList.toggle('collapsed'));
    });
    document.querySelectorAll('.overflow-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wrap = btn.closest('.overflow-wrap');
        document.querySelectorAll('.overflow-wrap.open').forEach((w) => { if (w !== wrap) w.classList.remove('open'); });
        wrap.classList.toggle('open');
      });
    });
    document.addEventListener('click', () => document.querySelectorAll('.overflow-wrap.open').forEach((w) => w.classList.remove('open')));

    const catSelect = document.getElementById('categorySelect');
    const catNew = document.getElementById('categoryNew');
    if (catSelect) {
      catSelect.addEventListener('change', () => {
        const isNew = catSelect.value === '__new__';
        catNew.style.display = isNew ? '' : 'none';
        if (isNew) { catSelect.removeAttribute('name'); catNew.setAttribute('name', 'category'); catNew.focus(); }
        else { catSelect.setAttribute('name', 'category'); catNew.removeAttribute('name'); }
      });
    }

    const fileInput = document.getElementById('itemImage');
    if (fileInput) fileInput.addEventListener('change', () => {
      document.getElementById('upload-name').textContent = fileInput.files[0] ? fileInput.files[0].name : 'Upload Image';
    });

    const addBtn = document.getElementById('add-item-btn');
    if (addBtn) addBtn.addEventListener('click', () => setTimeout(() => document.getElementById('name').focus(), 300));
  </script>
```

Add `<% values = typeof values === 'undefined' ? {} : values %>` near the top of the template. Special case: if the shop has zero items, the category dropdown has only "New category…" — the script must run its change-swap on load when `catSelect.value === '__new__'` (call the handler once after binding).

- [ ] **Step 4: Photo UI on `views/menu-item-edit.ejs`**

Make the form `enctype="multipart/form-data"`; above the submit button add:

```html
          <div class="field"><label>Photo</label>
            <% if (item.image_url) { %>
              <img src="<%= item.image_url %>" alt="" style="width:96px;height:96px;object-fit:cover;border-radius:10px;border:1px solid var(--line);display:block;margin-bottom:8px;">
            <% } %>
            <input name="itemImage" type="file" accept="image/jpeg,image/png,image/webp">
            <div style="font-size:12px;color:var(--ink-soft);margin-top:4px;">JPG, PNG or WEBP up to 5MB<%= item.image_url ? ' — uploading replaces the current photo' : '' %></div>
          </div>
```

- [ ] **Step 5: Run tests** — `npm test` → new tests pass; fix any older menu-view assertions that referenced removed markup (only string expectations, e.g. the old always-visible Remove button; the overflow menu still contains "Remove" so `/Remove/` matches).

- [ ] **Step 6: Commit**

```bash
git add views/menu-edit.ejs views/menu-item-edit.ejs test/routes/menu.test.js
git commit -m "feat: redesigned menu editor with sections, thumbnails, and richer add panel"
```

---

## Task 5: Photos on POS cards and the customer order page

**Files:**
- Modify: `views/pos.ejs`, `views/order.ejs`
- Test: `test/routes/pos.test.js`, `test/routes/order.test.js` (append; if no order view test file exists, add the order assertions to the existing customer-order test file — find it with `ls test/routes`)

**Interfaces:**
- Consumes: `image_url` on menu rows (already flowing — both views receive `menu` from `getMenuItemsForShop`).

- [ ] **Step 1: Write the failing tests**

Append to `test/routes/pos.test.js`:

```js
test('GET /pos shows item photos on cards and placeholders without one', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  await db.query("UPDATE menu_items SET image_url = 'http://img.test/latte.jpg' WHERE shop_id = $1 AND name = 'Latte'", [shopId]);
  const res = await agent.get('/pos');
  assert.match(res.text, /class="menu-card-photo"[\s\S]*?src="http:\/\/img.test\/latte.jpg"/);
  assert.match(res.text, /menu-card-photo placeholder/);
});
```

Append to the customer order-page test file (same shape: create shop, set one item's `image_url`, sign up a customer, GET `/blue-bottle/order`, assert the URL appears and a placeholder class appears).

- [ ] **Step 2: Run to verify failure** — targeted files → FAIL.

- [ ] **Step 3: `views/pos.ejs` cards**

Add CSS:

```css
  .menu-card-photo { width: 100%; height: 84px; border-radius: 9px; margin-bottom: 10px; object-fit: cover; display: block; border: 1px solid var(--parchment-2); }
  .menu-card-photo.placeholder { display: flex; align-items: center; justify-content: center; background: var(--parchment); color: var(--line); border-style: dashed; }
  .menu-card-photo.placeholder svg { width: 26px; height: 26px; }
```

Inside each `.menu-card`, before `.menu-name`:

```html
                    <% if (item.image_url) { %>
                      <img class="menu-card-photo" src="<%= item.image_url %>" alt="">
                    <% } else { %>
                      <div class="menu-card-photo placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 8h13a3 3 0 0 1 0 6h-1"/><path d="M4 8v7a4 4 0 0 0 4 4h5a4 4 0 0 0 4-4V8"/></svg></div>
                    <% } %>
```

No changes to any data-attributes, click handlers, or arrange logic.

- [ ] **Step 4: `views/order.ejs` cards**

In each order card's `.menu-card-top`, replace the current `.menu-icon` block with the same conditional (`menu-card-photo` img or `menu-card-photo placeholder` div) and add matching CSS scoped to that view (`.menu-card-photo { width: 52px; height: 52px; border-radius: 10px; object-fit: cover; flex-shrink: 0; border: 1px solid var(--line); }` plus the placeholder variant with flex centering). Keep the qty stepper and all behavior untouched.

- [ ] **Step 5: Run tests** — `npm test` → full suite green.

- [ ] **Step 6: Commit**

```bash
git add views/pos.ejs views/order.ejs test/routes/pos.test.js test/routes/*.test.js
git commit -m "feat: show item photos on POS cards and the customer order page"
```

---

## Final check

- [ ] `npm test` — everything green, 0 failures.
- [ ] Smoke test: `npm start`; as owner add an item with a photo through the new panel (dropdown + New category…), collapse/expand a section, use the overflow Remove on a throwaway item, confirm the photo shows on the menu row, the POS card, and (as a customer) the order page; confirm the sidebar shows the shop name and avatar on all pages.

## Deviation note

The mockup's "Add New Item" opens nothing special — our button scrolls to the bottom panel (spec-approved). The mockup's "2MB" upload copy is superseded by the spec's 5MB shared limit.
