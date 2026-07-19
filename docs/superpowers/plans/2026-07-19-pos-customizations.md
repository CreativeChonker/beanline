# POS Customizations & Arrangeable Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the POS standard drink customizations (size / sugar / hot-iced / note) with per-shop field toggles and per-item size pricing, plus an owner-draggable card layout grouped by category.

**Architecture:** `menu_items` gains type/size-price/sort columns and `shops` gains POS-config columns. A new pure module `lib/posLines.js` parses, validates, and prices the POS form's JSON lines server-side — it is the only place customization rules live. The POS view is rewritten around category sections and a right-column customization panel; an owner-only arrange mode persists layout via `POST /pos/layout`.

**Tech Stack:** Same as all prior sub-projects — Node.js, Express, EJS, `pg` (raw SQL), `node:test` + supertest against real Postgres. No new dependencies (drag & drop is native HTML5).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-19-pos-customizations-design.md`.
- Enums (exact strings): size `'small'|'medium'|'large'`; sugar `'none'|'less'|'normal'|'extra'`; temperature `'hot'|'iced'`. Note: trimmed, max 140 chars.
- `menu_items.price` is the Small/base price. `price_medium`/`price_large` NULL ⇒ that size doesn't exist for the item. Server always recomputes prices from the DB — client prices are never trusted.
- All new columns nullable or defaulted; existing orders and old-style sales must keep working (full existing suite stays green).
- Cross-shop rules unchanged: a sale or layout write may only ever touch the session shop's rows.
- POS only — do not touch the customer order page (`views/order.ejs`, `/:shopSlug/order` routes).
- Rename the menu editor's "86 it" button to "Mark unavailable".
- Every new behavior gets a failing test before implementation. Run tests with `npm test` (or `npm test -- <file>` for one file).

---

## Task 1: Schema migration

**Files:**
- Modify: `db/schema.sql` (append at end)

**Interfaces:**
- Produces columns consumed by Tasks 2-3: `menu_items.item_type` (TEXT NOT NULL DEFAULT 'drink'), `menu_items.price_medium` / `price_large` (NUMERIC(10,2) nullable), `menu_items.sort_order` (INTEGER NOT NULL DEFAULT 0), `shops.pos_show_size` / `pos_show_sugar` / `pos_show_temp` / `pos_show_note` (BOOLEAN NOT NULL DEFAULT true), `shops.category_order` (TEXT[] nullable).

- [ ] **Step 1: Append to `db/schema.sql`**

```sql
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS item_type TEXT NOT NULL DEFAULT 'drink';
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS price_medium NUMERIC(10,2);
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS price_large NUMERIC(10,2);
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_item_type_check'
  ) THEN
    ALTER TABLE menu_items ADD CONSTRAINT menu_items_item_type_check
      CHECK (item_type IN ('drink', 'food'));
  END IF;
END $$;

ALTER TABLE shops ADD COLUMN IF NOT EXISTS pos_show_size BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS pos_show_sugar BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS pos_show_temp BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS pos_show_note BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS category_order TEXT[];
```

- [ ] **Step 2: Run the migration and verify**

Run: `npm run migrate`
Expected: `Migration complete.`

Run: `docker compose exec -T postgres psql -U postgres -d coffee_shop_dev -c "\d menu_items" -c "\d shops"`
Expected: all new columns present with the defaults above.

- [ ] **Step 3: Run it again to confirm idempotency**

Run: `npm run migrate`
Expected: `Migration complete.`, no errors.

- [ ] **Step 4: Commit**

```bash
git add db/schema.sql
git commit -m "feat: add POS customization columns to menu_items and shops"
```

---

## Task 2: `menuItems` model — types, size prices, sort order, layout writes

**Files:**
- Modify: `models/menuItems.js`
- Test: `test/models/menuItems.test.js` (append; keep existing tests unchanged)

**Interfaces:**
- Consumes: Task 1 columns.
- Produces (consumed by Tasks 5, 7, 8): every returned item row now includes `item_type`, `price_medium` (float or null), `price_large` (float or null), `sort_order`. `createMenuItem(queryable, { shopId, name, price, category, note, itemType = 'drink', priceMedium = null, priceLarge = null })`. `updateMenuItem(queryable, shopId, id, { name, price, category, note, itemType, priceMedium, priceLarge })`. `getMenuItemsForShop` now orders by `category, sort_order, name`. New: `updateLayout(queryable, shopId, items)` where `items = [{ id, category, sortOrder }]` → updates only rows belonging to `shopId`, returns count of rows updated.

- [ ] **Step 1: Write the failing tests**

Append to `test/models/menuItems.test.js`:

```js
test('createMenuItem defaults to drink with no size prices and sort_order 0', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const item = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Latte', price: 4.5, category: 'Coffee' });
  assert.equal(item.item_type, 'drink');
  assert.equal(item.price_medium, null);
  assert.equal(item.price_large, null);
  assert.equal(item.sort_order, 0);
});

test('createMenuItem stores item type and per-size prices', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const item = await menuItems.createMenuItem(db, {
    shopId: shop.id, name: 'Latte', price: 4.5, category: 'Coffee',
    itemType: 'drink', priceMedium: 5.0, priceLarge: 5.5,
  });
  assert.equal(item.price_medium, 5.0);
  assert.equal(item.price_large, 5.5);

  const food = await menuItems.createMenuItem(db, {
    shopId: shop.id, name: 'Croissant', price: 3.0, category: 'Food', itemType: 'food',
  });
  assert.equal(food.item_type, 'food');
});

test('updateMenuItem updates type and size prices, and can clear a size', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const item = await menuItems.createMenuItem(db, {
    shopId: shop.id, name: 'Latte', price: 4.5, category: 'Coffee', priceMedium: 5.0, priceLarge: 5.5,
  });
  const updated = await menuItems.updateMenuItem(db, shop.id, item.id, {
    name: 'Latte', price: 4.5, category: 'Coffee', note: '',
    itemType: 'drink', priceMedium: 5.25, priceLarge: null,
  });
  assert.equal(updated.price_medium, 5.25);
  assert.equal(updated.price_large, null);
});

test('getMenuItemsForShop orders by category then sort_order then name', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const b = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'B-drink', price: 4, category: 'Coffee' });
  const a = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'A-drink', price: 4, category: 'Coffee' });
  await menuItems.updateLayout(db, shop.id, [
    { id: b.id, category: 'Coffee', sortOrder: 0 },
    { id: a.id, category: 'Coffee', sortOrder: 1 },
  ]);
  const items = await menuItems.getMenuItemsForShop(db, shop.id);
  assert.deepEqual(items.map((i) => i.name), ['B-drink', 'A-drink']);
});

test('updateLayout can move an item to another category and never touches another shop', async () => {
  const shopA = await shops.createShop(db, { name: 'Shop A', slug: 'shop-a' });
  const shopB = await shops.createShop(db, { name: 'Shop B', slug: 'shop-b' });
  const itemA = await menuItems.createMenuItem(db, { shopId: shopA.id, name: 'Latte', price: 4, category: 'Coffee' });
  const itemB = await menuItems.createMenuItem(db, { shopId: shopB.id, name: 'Mocha', price: 4, category: 'Coffee' });

  const count = await menuItems.updateLayout(db, shopA.id, [
    { id: itemA.id, category: 'Signature', sortOrder: 3 },
    { id: itemB.id, category: 'Hacked', sortOrder: 0 },
  ]);
  assert.equal(count, 1);

  const movedA = await menuItems.getMenuItemById(db, shopA.id, itemA.id);
  assert.equal(movedA.category, 'Signature');
  assert.equal(movedA.sort_order, 3);
  const untouchedB = await menuItems.getMenuItemById(db, shopB.id, itemB.id);
  assert.equal(untouchedB.category, 'Coffee');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/models/menuItems.test.js`
Expected: FAIL — `item_type` undefined on returned rows, `updateLayout` is not a function.

- [ ] **Step 3: Implement in `models/menuItems.js`**

Replace the file's functions with (keep the module structure; `RETURNING`/`SELECT` lists change everywhere):

```js
const ITEM_COLUMNS = `id, shop_id, name, price::float8 AS price, category, note, available,
  item_type, price_medium::float8 AS price_medium, price_large::float8 AS price_large, sort_order`;

async function createMenuItem(queryable, { shopId, name, price, category, note, itemType = 'drink', priceMedium = null, priceLarge = null }) {
  const result = await queryable.query(
    `INSERT INTO menu_items (shop_id, name, price, category, note, item_type, price_medium, price_large)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${ITEM_COLUMNS}`,
    [shopId, name, price, category, note || '', itemType, priceMedium, priceLarge]
  );
  return result.rows[0];
}

async function getMenuItemsForShop(queryable, shopId, { availableOnly = false } = {}) {
  const query = availableOnly
    ? `SELECT ${ITEM_COLUMNS} FROM menu_items WHERE shop_id = $1 AND available = true ORDER BY category, sort_order, name`
    : `SELECT ${ITEM_COLUMNS} FROM menu_items WHERE shop_id = $1 ORDER BY category, sort_order, name`;
  const result = await queryable.query(query, [shopId]);
  return result.rows;
}

async function getMenuItemById(queryable, shopId, id) {
  const result = await queryable.query(
    `SELECT ${ITEM_COLUMNS} FROM menu_items WHERE id = $1 AND shop_id = $2`,
    [id, shopId]
  );
  return result.rows[0] || null;
}

async function updateMenuItem(queryable, shopId, id, { name, price, category, note, itemType = 'drink', priceMedium = null, priceLarge = null }) {
  const result = await queryable.query(
    `UPDATE menu_items SET name = $1, price = $2, category = $3, note = $4,
       item_type = $5, price_medium = $6, price_large = $7
     WHERE id = $8 AND shop_id = $9
     RETURNING ${ITEM_COLUMNS}`,
    [name, price, category, note || '', itemType, priceMedium, priceLarge, id, shopId]
  );
  return result.rows[0] || null;
}

async function updateLayout(queryable, shopId, items) {
  let count = 0;
  for (const { id, category, sortOrder } of items) {
    const result = await queryable.query(
      'UPDATE menu_items SET category = $1, sort_order = $2 WHERE id = $3 AND shop_id = $4',
      [category, sortOrder, id, shopId]
    );
    count += result.rowCount;
  }
  return count;
}
```

`toggleAvailability` keeps its query but its `RETURNING` list becomes `RETURNING ${ITEM_COLUMNS}`. `deleteMenuItem` is unchanged. Export: add `updateLayout` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: new tests pass, full suite green (103 prior + 5 new).

- [ ] **Step 5: Commit**

```bash
git add models/menuItems.js test/models/menuItems.test.js
git commit -m "feat: menu items carry type, size prices, and layout position"
```

---

## Task 3: `shops` model — POS options and category order

**Files:**
- Modify: `models/shops.js`
- Test: `test/models/shops.test.js` (append)

**Interfaces:**
- Consumes: Task 1 columns.
- Produces (consumed by Tasks 6, 7, 8): `getShopById` rows now also include `pos_show_size`, `pos_show_sugar`, `pos_show_temp`, `pos_show_note` (booleans) and `category_order` (array or null). New: `updatePosOptions(queryable, id, { showSize, showSugar, showTemp, showNote })` → updated shop row or null. New: `updateCategoryOrder(queryable, id, categories)` (array of strings) → updated shop row or null.

- [ ] **Step 1: Write the failing tests**

Append to `test/models/shops.test.js`:

```js
test('getShopById includes POS options defaulting to all-on and no category order', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const found = await shops.getShopById(db, shop.id);
  assert.equal(found.pos_show_size, true);
  assert.equal(found.pos_show_sugar, true);
  assert.equal(found.pos_show_temp, true);
  assert.equal(found.pos_show_note, true);
  assert.equal(found.category_order, null);
});

test('updatePosOptions turns individual fields off', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const updated = await shops.updatePosOptions(db, shop.id, {
    showSize: true, showSugar: false, showTemp: false, showNote: true,
  });
  assert.equal(updated.pos_show_size, true);
  assert.equal(updated.pos_show_sugar, false);
  assert.equal(updated.pos_show_temp, false);
  assert.equal(updated.pos_show_note, true);
});

test('updateCategoryOrder stores and returns the section ordering', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const updated = await shops.updateCategoryOrder(db, shop.id, ['Coffee', 'Tea', 'Food']);
  assert.deepEqual(updated.category_order, ['Coffee', 'Tea', 'Food']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/models/shops.test.js`
Expected: FAIL — `pos_show_size` undefined, new functions missing.

- [ ] **Step 3: Implement in `models/shops.js`**

Define a shared column list and use it in `getShopById` (leave `getAllShops` and `updateShopProfile` on their existing narrower list — the browse feed doesn't need POS config):

```js
const SHOP_COLUMNS = `id, name, slug, tagline, cover_photo_url,
  pos_show_size, pos_show_sugar, pos_show_temp, pos_show_note, category_order`;

async function getShopById(queryable, id) {
  const result = await queryable.query(
    `SELECT ${SHOP_COLUMNS} FROM shops WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function updatePosOptions(queryable, id, { showSize, showSugar, showTemp, showNote }) {
  const result = await queryable.query(
    `UPDATE shops SET pos_show_size = $1, pos_show_sugar = $2, pos_show_temp = $3, pos_show_note = $4
     WHERE id = $5 RETURNING ${SHOP_COLUMNS}`,
    [showSize, showSugar, showTemp, showNote, id]
  );
  return result.rows[0] || null;
}

async function updateCategoryOrder(queryable, id, categories) {
  const result = await queryable.query(
    `UPDATE shops SET category_order = $1 WHERE id = $2 RETURNING ${SHOP_COLUMNS}`,
    [categories, id]
  );
  return result.rows[0] || null;
}
```

Add `updatePosOptions` and `updateCategoryOrder` to `module.exports`.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: full suite green.

- [ ] **Step 5: Commit**

```bash
git add models/shops.js test/models/shops.test.js
git commit -m "feat: shops carry POS field toggles and category order"
```

---

## Task 4: `lib/posLines.js` — parse, validate, price, and format sale lines

**Files:**
- Create: `lib/posLines.js`
- Test: `test/lib/posLines.test.js`

**Interfaces:**
- Consumes: item rows shaped as Task 2 returns them (`id`, `name`, `price`, `price_medium`, `price_large`, `item_type`).
- Produces (consumed by Task 7): `parseAndPriceLines(rawJson, availableItems) → { lines, total }` on success or `{ error: string }` on any violation. Each output line: `{ name, qty, price }` plus `size`/`sugar`/`temperature`/`note` only when set. `formatLineDetails(line) → string` — `''` for a plain line; otherwise e.g. `M · iced · no sugar · "oat milk"` (size letter S/M/L; temperature only when `iced`; sugar unless `normal`; note in quotes). Constants `SIZES`, `SUGARS`, `TEMPS` exported.

- [ ] **Step 1: Write the failing tests**

```js
// test/lib/posLines.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAndPriceLines, formatLineDetails } = require('../../lib/posLines');

const latte = { id: 1, name: 'Latte', price: 4.5, price_medium: 5.0, price_large: 5.5, item_type: 'drink' };
const espresso = { id: 2, name: 'Espresso', price: 3.0, price_medium: null, price_large: null, item_type: 'drink' };
const croissant = { id: 3, name: 'Croissant', price: 3.25, price_medium: null, price_large: null, item_type: 'food' };
const menu = [latte, espresso, croissant];

test('prices a plain line from the base price', () => {
  const result = parseAndPriceLines(JSON.stringify([{ itemId: 2, qty: 2 }]), menu);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.lines, [{ name: 'Espresso', qty: 2, price: 3.0 }]);
  assert.equal(result.total, 6.0);
});

test('prices medium and large from the item size columns, never the client', () => {
  const result = parseAndPriceLines(JSON.stringify([
    { itemId: 1, qty: 1, size: 'medium', price: 0.01 },
    { itemId: 1, qty: 1, size: 'large' },
  ]), menu);
  assert.equal(result.lines[0].price, 5.0);
  assert.equal(result.lines[1].price, 5.5);
  assert.equal(result.total, 10.5);
});

test('keeps customization fields on the line', () => {
  const result = parseAndPriceLines(JSON.stringify([
    { itemId: 1, qty: 1, size: 'small', sugar: 'none', temperature: 'iced', note: '  oat milk  ' },
  ]), menu);
  assert.deepEqual(result.lines[0], {
    name: 'Latte', qty: 1, price: 4.5, size: 'small', sugar: 'none', temperature: 'iced', note: 'oat milk',
  });
});

test('rejects a size the item does not offer', () => {
  const result = parseAndPriceLines(JSON.stringify([{ itemId: 2, qty: 1, size: 'large' }]), menu);
  assert.match(result.error, /size/i);
});

test('rejects unknown items, bad enums, bad qty, oversized notes, and bad JSON', () => {
  assert.ok(parseAndPriceLines(JSON.stringify([{ itemId: 999, qty: 1 }]), menu).error);
  assert.ok(parseAndPriceLines(JSON.stringify([{ itemId: 1, qty: 1, sugar: 'heaps' }]), menu).error);
  assert.ok(parseAndPriceLines(JSON.stringify([{ itemId: 1, qty: 1, temperature: 'lukewarm' }]), menu).error);
  assert.ok(parseAndPriceLines(JSON.stringify([{ itemId: 1, qty: 0 }]), menu).error);
  assert.ok(parseAndPriceLines(JSON.stringify([{ itemId: 1, qty: 1, note: 'x'.repeat(141) }]), menu).error);
  assert.ok(parseAndPriceLines('not json', menu).error);
  assert.ok(parseAndPriceLines(JSON.stringify([]), menu).error);
  assert.ok(parseAndPriceLines(JSON.stringify({ itemId: 1 }), menu).error);
});

test('formatLineDetails renders the compact combo', () => {
  assert.equal(formatLineDetails({ name: 'Espresso', qty: 1, price: 3 }), '');
  assert.equal(
    formatLineDetails({ name: 'Latte', qty: 1, price: 5, size: 'medium', sugar: 'none', temperature: 'iced', note: 'oat milk' }),
    'M · iced · no sugar · "oat milk"'
  );
  assert.equal(
    formatLineDetails({ name: 'Latte', qty: 1, price: 4.5, size: 'small', sugar: 'normal', temperature: 'hot' }),
    'S'
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/lib/posLines.test.js`
Expected: FAIL — `Cannot find module '../../lib/posLines'`.

- [ ] **Step 3: Implement `lib/posLines.js`**

```js
const SIZES = ['small', 'medium', 'large'];
const SUGARS = ['none', 'less', 'normal', 'extra'];
const TEMPS = ['hot', 'iced'];

const SIZE_LETTER = { small: 'S', medium: 'M', large: 'L' };
const SUGAR_LABEL = { none: 'no sugar', less: 'less sugar', extra: 'extra sugar' };

function sizePrice(item, size) {
  if (!size || size === 'small') return item.price;
  const price = size === 'medium' ? item.price_medium : item.price_large;
  return price === null ? undefined : price;
}

function parseAndPriceLines(rawJson, availableItems) {
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { error: 'Could not read the sale. Please try again.' };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { error: 'Please select at least one item.' };
  }

  const byId = new Map(availableItems.map((i) => [i.id, i]));
  const lines = [];
  let total = 0;

  for (const raw of parsed) {
    const item = byId.get(Number(raw.itemId));
    if (!item) return { error: 'One of the items is no longer available.' };

    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) return { error: 'Invalid quantity.' };

    const line = { name: item.name, qty, price: undefined };

    if (raw.size !== undefined && raw.size !== null && raw.size !== '') {
      if (!SIZES.includes(raw.size)) return { error: 'Invalid size.' };
      line.size = raw.size;
    }
    const price = sizePrice(item, line.size);
    if (price === undefined) return { error: `${item.name} does not come in that size.` };
    line.price = price;

    if (raw.sugar !== undefined && raw.sugar !== null && raw.sugar !== '') {
      if (!SUGARS.includes(raw.sugar)) return { error: 'Invalid sugar level.' };
      line.sugar = raw.sugar;
    }
    if (raw.temperature !== undefined && raw.temperature !== null && raw.temperature !== '') {
      if (!TEMPS.includes(raw.temperature)) return { error: 'Invalid temperature.' };
      line.temperature = raw.temperature;
    }
    if (typeof raw.note === 'string' && raw.note.trim() !== '') {
      const note = raw.note.trim();
      if (note.length > 140) return { error: 'Notes must be 140 characters or fewer.' };
      line.note = note;
    }

    lines.push(line);
    total += price * qty;
  }

  return { lines, total: Math.round(total * 100) / 100 };
}

function formatLineDetails(line) {
  const parts = [];
  if (line.size) parts.push(SIZE_LETTER[line.size]);
  if (line.temperature === 'iced') parts.push('iced');
  if (line.sugar && line.sugar !== 'normal') parts.push(SUGAR_LABEL[line.sugar]);
  if (line.note) parts.push(`"${line.note}"`);
  return parts.join(' · ');
}

module.exports = { parseAndPriceLines, formatLineDetails, SIZES, SUGARS, TEMPS };
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: full suite green.

- [ ] **Step 5: Commit**

```bash
git add lib/posLines.js test/lib/posLines.test.js
git commit -m "feat: add POS line parsing, validation, pricing, and display formatting"
```

---

## Task 5: Menu editor — item type, size prices, plain-language button

**Files:**
- Modify: `server.js` (`POST /menu` and `POST /menu/:id` handlers), `views/menu-edit.ejs`, `views/menu-item-edit.ejs`
- Test: `test/routes/menu.test.js` (append)

**Interfaces:**
- Consumes: Task 2's `createMenuItem`/`updateMenuItem` signatures.
- Produces: form fields `itemType` (`drink`|`food`), `priceMedium`, `priceLarge` (optional) on both menu forms.

- [ ] **Step 1: Write the failing tests**

Append to `test/routes/menu.test.js` (reuse that file's existing owner-agent helper):

```js
test('POST /menu creates a food item and a drink with size prices', async () => {
  const app = require('../../server');
  const agent = await ownerAgent(app);
  await agent.post('/menu').type('form').send({
    name: 'Latte', category: 'Coffee', price: '4.50', itemType: 'drink', priceMedium: '5.00', priceLarge: '5.50',
  });
  await agent.post('/menu').type('form').send({
    name: 'Croissant', category: 'Food', price: '3.25', itemType: 'food',
  });
  const rows = await db.query("SELECT name, item_type, price_medium::float8 AS pm, price_large::float8 AS pl FROM menu_items ORDER BY name");
  assert.deepEqual(rows.rows, [
    { name: 'Croissant', item_type: 'food', pm: null, pl: null },
    { name: 'Latte', item_type: 'drink', pm: 5.0, pl: 5.5 },
  ]);
});

test('POST /menu rejects an invalid size price without creating the item', async () => {
  const app = require('../../server');
  const agent = await ownerAgent(app);
  const res = await agent.post('/menu').type('form').send({
    name: 'Latte', category: 'Coffee', price: '4.50', itemType: 'drink', priceMedium: '-2',
  });
  assert.match(res.text, /valid price/i);
  const rows = await db.query('SELECT COUNT(*)::int AS n FROM menu_items');
  assert.equal(rows.rows[0].n, 0);
});

test('the menu editor uses plain language instead of "86 it"', async () => {
  const app = require('../../server');
  const agent = await ownerAgent(app);
  await agent.post('/menu').type('form').send({ name: 'Latte', category: 'Coffee', price: '4.50', itemType: 'drink' });
  const res = await agent.get('/menu');
  assert.doesNotMatch(res.text, /86 it/);
  assert.match(res.text, /Mark unavailable/);
});
```

(If `test/routes/menu.test.js` names its helper differently, use that file's existing helper name — do not create a second helper.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/routes/menu.test.js`
Expected: FAIL — `item_type` is `'drink'` for the croissant (no form support yet), "86 it" still present.

- [ ] **Step 3: Update the two `POST` handlers in `server.js`**

In both `POST /menu` and `POST /menu/:id`, replace the body parsing and validation block with:

```js
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
```

…keeping each handler's existing error re-render behind that condition (the message "Please provide a name, category, and a valid price." already matches the test's `/valid price/i`). Then pass the new values through:

```js
    await menuItems.createMenuItem(db, { shopId: req.session.user.shopId, name, category, price: parsedPrice, note: note || '', itemType: type, priceMedium: parsedMedium, priceLarge: parsedLarge });
```

and in the update handler:

```js
    const updated = await menuItems.updateMenuItem(db, req.session.user.shopId, req.params.id, { name, category, price: parsedPrice, note: note || '', itemType: type, priceMedium: parsedMedium, priceLarge: parsedLarge });
```

- [ ] **Step 4: Update the views**

`views/menu-edit.ejs` — in the add-item form, relabel price and add three fields before the submit button (and change the grid to fit):

```html
        <form method="POST" action="/menu" class="add-item-form">
          <div class="field"><label for="name">Name</label><input id="name" name="name" type="text" required></div>
          <div class="field"><label for="category">Category</label><input id="category" name="category" type="text" required></div>
          <div class="field"><label for="itemType">Type</label>
            <select id="itemType" name="itemType"><option value="drink">Drink</option><option value="food">Food</option></select>
          </div>
          <div class="field"><label for="price">Price (S / base)</label><input id="price" name="price" type="number" step="0.01" min="0.01" required></div>
          <div class="field"><label for="priceMedium">Price M</label><input id="priceMedium" name="priceMedium" type="number" step="0.01" min="0.01"></div>
          <div class="field"><label for="priceLarge">Price L</label><input id="priceLarge" name="priceLarge" type="number" step="0.01" min="0.01"></div>
          <div class="field"><label for="note">Note</label><input id="note" name="note" type="text"></div>
          <button type="submit" class="btn btn-primary" style="margin-top:0;">Add</button>
        </form>
```

Change `.add-item-form`'s CSS to `grid-template-columns: repeat(4, 1fr) auto;` (rows wrap naturally). Style `select` like the existing inputs if `partials-head` doesn't already.

In the same file, the toggle button (line ~95): replace `'86 it'` with `'Mark unavailable'`. Also show size prices on the row — replace the price div with:

```html
                  <div class="menu-row-price">$<%= item.price.toFixed(2) %><% if (item.price_medium) { %> / $<%= item.price_medium.toFixed(2) %><% } %><% if (item.price_large) { %> / $<%= item.price_large.toFixed(2) %><% } %></div>
```

`views/menu-item-edit.ejs` — mirror the same three fields in the edit form, pre-filled:

```html
          <div class="field"><label for="itemType">Type</label>
            <select id="itemType" name="itemType">
              <option value="drink" <%= item.item_type === 'drink' ? 'selected' : '' %>>Drink</option>
              <option value="food" <%= item.item_type === 'food' ? 'selected' : '' %>>Food</option>
            </select>
          </div>
          <div class="field"><label for="priceMedium">Price M (blank = no Medium)</label>
            <input id="priceMedium" name="priceMedium" type="number" step="0.01" min="0.01" value="<%= item.price_medium ?? '' %>"></div>
          <div class="field"><label for="priceLarge">Price L (blank = no Large)</label>
            <input id="priceLarge" name="priceLarge" type="number" step="0.01" min="0.01" value="<%= item.price_large ?? '' %>"></div>
```

and relabel its existing price field "Price (S / base)".

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: full suite green.

- [ ] **Step 6: Commit**

```bash
git add server.js views/menu-edit.ejs views/menu-item-edit.ejs test/routes/menu.test.js
git commit -m "feat: menu editor supports item type and per-size prices"
```

---

## Task 6: Shop settings — POS options toggles

**Files:**
- Modify: `server.js` (`POST /shop/settings`), `views/shop-settings.ejs`
- Test: `test/routes/shop-settings.test.js` (append)

**Interfaces:**
- Consumes: Task 3's `updatePosOptions`.
- Produces: checkbox fields `posShowSize`, `posShowSugar`, `posShowTemp`, `posShowNote` on the settings form (checkbox present = on).

- [ ] **Step 1: Write the failing tests**

Append to `test/routes/shop-settings.test.js`:

```js
test('POST /shop/settings saves POS option toggles', async () => {
  const app = require('../../server');
  const agent = await ownerAgentWithShop(app);
  const res = await agent.post('/shop/settings')
    .field('tagline', 'Cozy')
    .field('posShowSize', 'on')
    .field('posShowNote', 'on');
  assert.equal(res.status, 200);

  const row = await db.query('SELECT pos_show_size, pos_show_sugar, pos_show_temp, pos_show_note FROM shops WHERE slug = $1', ['blue-bottle']);
  assert.deepEqual(row.rows[0], {
    pos_show_size: true, pos_show_sugar: false, pos_show_temp: false, pos_show_note: true,
  });
});

test('GET /shop/settings renders the POS option checkboxes', async () => {
  const app = require('../../server');
  const agent = await ownerAgentWithShop(app);
  const res = await agent.get('/shop/settings');
  assert.match(res.text, /name="posShowSize"/);
  assert.match(res.text, /name="posShowSugar"/);
  assert.match(res.text, /name="posShowTemp"/);
  assert.match(res.text, /name="posShowNote"/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/routes/shop-settings.test.js`
Expected: FAIL — checkboxes not rendered, toggles not saved.

- [ ] **Step 3: Implement**

`server.js` — in `POST /shop/settings`, after the `updateShopProfile` call succeeds, add:

```js
      const withOptions = await shops.updatePosOptions(db, req.session.user.shopId, {
        showSize: req.body.posShowSize === 'on',
        showSugar: req.body.posShowSugar === 'on',
        showTemp: req.body.posShowTemp === 'on',
        showNote: req.body.posShowNote === 'on',
      });
      res.render('shop-settings', { shop: withOptions, error: null, saved: true });
```

(replacing the existing `res.render('shop-settings', { shop: updated, ... })` line).

`views/shop-settings.ejs` — inside the form, after the cover photo field and before the Save button:

```html
          <div class="field" style="margin-top:16px;">
            <label>POS options — which fields staff see at the register</label>
            <label style="display:block;font-weight:400;margin-top:6px;"><input type="checkbox" name="posShowSize" <%= shop.pos_show_size ? 'checked' : '' %>> Cup size (S/M/L)</label>
            <label style="display:block;font-weight:400;"><input type="checkbox" name="posShowSugar" <%= shop.pos_show_sugar ? 'checked' : '' %>> Sugar level</label>
            <label style="display:block;font-weight:400;"><input type="checkbox" name="posShowTemp" <%= shop.pos_show_temp ? 'checked' : '' %>> Hot / Iced</label>
            <label style="display:block;font-weight:400;"><input type="checkbox" name="posShowNote" <%= shop.pos_show_note ? 'checked' : '' %>> Free-text note</label>
          </div>
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: full suite green (the pre-existing settings tests still pass — they don't assert on POS flags).

- [ ] **Step 5: Commit**

```bash
git add server.js views/shop-settings.ejs test/routes/shop-settings.test.js
git commit -m "feat: per-shop toggles for POS customization fields"
```

---

## Task 7: POS — sectioned grid, customization panel, JSON-lines sale

**Files:**
- Modify: `server.js` (`GET /pos`, `POST /pos`), `views/pos.ejs` (rewrite), `views/pos-receipt.ejs`, `views/dashboard.ejs`
- Test: `test/routes/pos.test.js` (append)

**Interfaces:**
- Consumes: `posLines.parseAndPriceLines` / `formatLineDetails` (Task 4), `shops.getShopById` POS flags (Task 3), item rows with sizes (Task 2).
- Produces: `POST /pos` accepts `lines` (JSON string, array of `{ itemId, qty, size?, sugar?, temperature?, note? }`) + `paymentMethod`. The old `qty_<id>` fields are gone. Views receive `formatLineDetails` as `formatLine`.

- [ ] **Step 1: Write the failing tests**

Append to `test/routes/pos.test.js` (reuse its existing staff/owner agent helper):

```js
test('POST /pos with customized lines snapshots size pricing and stores customizations', async () => {
  const app = require('../../server');
  const { agent, shopId } = await staffAgentWithMenu(app);
  const latte = await db.query("SELECT id FROM menu_items WHERE shop_id = $1 AND name = 'Latte'", [shopId]);
  await db.query('UPDATE menu_items SET price_medium = 5.00, price_large = 5.50 WHERE id = $1', [latte.rows[0].id]);

  const res = await agent.post('/pos').type('form').send({
    paymentMethod: 'cash',
    lines: JSON.stringify([
      { itemId: latte.rows[0].id, qty: 1, size: 'large', sugar: 'none', temperature: 'iced', note: 'oat milk' },
      { itemId: latte.rows[0].id, qty: 2, size: 'small' },
    ]),
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /iced/);
  assert.match(res.text, /no sugar/);

  const order = await db.query('SELECT items_json, total::float8 AS total FROM orders WHERE shop_id = $1', [shopId]);
  const items = JSON.parse(order.rows[0].items_json);
  assert.equal(items[0].size, 'large');
  assert.equal(items[0].price, 5.5);
  assert.equal(items[0].note, 'oat milk');
  assert.equal(items[1].size, 'small');
  assert.equal(order.rows[0].total, 5.5 + 2 * 4.5);
});

test('POST /pos rejects a size the item does not offer', async () => {
  const app = require('../../server');
  const { agent, shopId } = await staffAgentWithMenu(app);
  const espresso = await db.query("SELECT id FROM menu_items WHERE shop_id = $1 AND name = 'Espresso'", [shopId]);

  const res = await agent.post('/pos').type('form').send({
    paymentMethod: 'cash',
    lines: JSON.stringify([{ itemId: espresso.rows[0].id, qty: 1, size: 'large' }]),
  });
  assert.match(res.text, /does not come in that size/i);
  const count = await db.query('SELECT COUNT(*)::int AS n FROM orders WHERE shop_id = $1', [shopId]);
  assert.equal(count.rows[0].n, 0);
});

test("POST /pos still cannot ring up another shop's item id", async () => {
  const app = require('../../server');
  const { agent } = await staffAgentWithMenu(app);
  const otherShop = await shops.createShop(db, { name: 'Other', slug: 'other-shop' });
  const foreign = await menuItems.createMenuItem(db, { shopId: otherShop.id, name: 'Foreign', price: 9, category: 'X' });

  const res = await agent.post('/pos').type('form').send({
    paymentMethod: 'cash',
    lines: JSON.stringify([{ itemId: foreign.id, qty: 1 }]),
  });
  assert.match(res.text, /no longer available/i);
});

test('GET /pos renders category sections and hides pickers the shop disabled', async () => {
  const app = require('../../server');
  const { agent, shopId } = await staffAgentWithMenu(app);
  await db.query('UPDATE shops SET pos_show_sugar = false WHERE id = $1', [shopId]);
  const res = await agent.get('/pos');
  assert.match(res.text, /class="pos-section"/);
  assert.doesNotMatch(res.text, /data-picker="sugar"/);
  assert.match(res.text, /data-picker="size"/);
});
```

(Adapt the helper name to what `test/routes/pos.test.js` already defines; the helper must create a shop whose menu includes a Latte at 4.50 and an Espresso at 3.00 — extend the existing helper's seed if needed, keeping prior tests green. Add `const shops = require('../../models/shops');` and `const menuItems = require('../../models/menuItems');` requires if not present.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/routes/pos.test.js`
Expected: FAIL — `lines` field ignored (old handler reads `qty_<id>`), no sections markup.

- [ ] **Step 3: Rewrite the two handlers in `server.js`**

Add near the other requires: `const posLines = require('./lib/posLines');`

```js
app.get('/pos', requireAuth, requireRole('owner', 'staff'), async (req, res, next) => {
  try {
    const [items, shop] = await Promise.all([
      menuItems.getMenuItemsForShop(db, req.session.user.shopId, { availableOnly: true }),
      shops.getShopById(db, req.session.user.shopId),
    ]);
    res.render('pos', { menu: items, shop, error: null, formatLine: posLines.formatLineDetails });
  } catch (err) {
    next(err);
  }
});

app.post('/pos', requireAuth, requireRole('owner', 'staff'), async (req, res, next) => {
  const { paymentMethod } = req.body;
  try {
    const [availableItems, shop] = await Promise.all([
      menuItems.getMenuItemsForShop(db, req.session.user.shopId, { availableOnly: true }),
      shops.getShopById(db, req.session.user.shopId),
    ]);
    const rerender = (error) => res.render('pos', { menu: availableItems, shop, error, formatLine: posLines.formatLineDetails });

    const parsed = posLines.parseAndPriceLines(req.body.lines || '', availableItems);
    if (parsed.error) return rerender(parsed.error);
    if (!['cash', 'card'].includes(paymentMethod)) return rerender('Please choose a payment method.');

    const created = await orders.createOrder(db, {
      staffUserId: req.session.user.id,
      shopId: req.session.user.shopId,
      items: parsed.lines,
      total: parsed.total,
      status: 'completed',
      paymentMethod,
    });

    res.render('pos-receipt', {
      sale: {
        order_id: created.id,
        staff_name: req.session.user.name,
        lineItems: parsed.lines,
        total: parsed.total.toFixed(2),
        payment_method: paymentMethod,
        created_at: created.created_at,
      },
      formatLine: posLines.formatLineDetails,
    });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Rewrite `views/pos.ejs`**

Keep the existing shell/sidebar/bill CSS; replace the category pills + flat grid with sections, add the customization panel, and rewrite the script. Full body/script replacement:

```html
      <% if (menu.length === 0) { %>
        <div class="empty-state">
          <h3>No items yet</h3>
          <p>This shop hasn't added anything to their menu yet.</p>
        </div>
      <% } else { %>
      <%
        const cats = [...new Set(menu.map((i) => i.category))];
        const order = shop.category_order || [];
        cats.sort((a, b) => {
          const ia = order.indexOf(a), ib = order.indexOf(b);
          if (ia !== -1 && ib !== -1) return ia - ib;
          if (ia !== -1) return -1;
          if (ib !== -1) return 1;
          return a.localeCompare(b);
        });
      %>
      <div class="content">
        <div class="menu-sections" id="menu-sections">
          <% cats.forEach((cat) => { %>
            <div class="pos-section" data-category="<%= cat %>">
              <h3 class="pos-section-head"><%= cat %></h3>
              <div class="menu-grid">
                <% menu.filter((i) => i.category === cat).forEach((item) => { %>
                  <div class="menu-card" data-id="<%= item.id %>" data-item-name="<%= item.name %>"
                    data-type="<%= item.item_type %>" data-price="<%= item.price %>"
                    data-price-medium="<%= item.price_medium ?? '' %>" data-price-large="<%= item.price_large ?? '' %>">
                    <div class="menu-name"><%= item.name %></div>
                    <div class="menu-price">$<%= item.price.toFixed(2) %><% if (item.price_medium || item.price_large) { %><span class="menu-price-plus">+</span><% } %></div>
                  </div>
                <% }) %>
              </div>
            </div>
          <% }) %>
        </div>

        <div class="bill-panel">
          <div class="customize-panel" id="customize-panel" hidden>
            <div class="customize-name" id="customize-name"></div>
            <% if (shop.pos_show_size) { %>
              <div class="picker" data-picker="size" id="picker-size">
                <button type="button" data-value="small">S</button>
                <button type="button" data-value="medium">M</button>
                <button type="button" data-value="large">L</button>
              </div>
            <% } %>
            <% if (shop.pos_show_temp) { %>
              <div class="picker" data-picker="temp" id="picker-temp">
                <button type="button" data-value="hot">Hot</button>
                <button type="button" data-value="iced">Iced</button>
              </div>
            <% } %>
            <% if (shop.pos_show_sugar) { %>
              <div class="picker" data-picker="sugar" id="picker-sugar">
                <button type="button" data-value="none">No sugar</button>
                <button type="button" data-value="less">Less</button>
                <button type="button" data-value="normal">Normal</button>
                <button type="button" data-value="extra">Extra</button>
              </div>
            <% } %>
            <% if (shop.pos_show_note) { %>
              <input type="text" class="customize-note" id="customize-note" maxlength="140" placeholder="Note (oat milk, extra hot…)">
            <% } %>
            <button type="button" class="btn btn-primary customize-add" id="customize-add">Add to sale</button>
          </div>

          <div class="receipt">
            <h2>Current sale</h2>
            <div id="bill-list"><p class="bill-empty">Tap an item to add it.</p></div>
          </div>
          <div class="bill-totals-wrap">
            <div class="bill-totals">
              <div class="row"><span>Items</span><span id="bill-count">0</span></div>
              <div class="row total"><span>Total</span><span id="bill-total">$0.00</span></div>
            </div>
            <div class="payment-row">
              <div class="payment-choice" data-method="cash">Cash</div>
              <div class="payment-choice" data-method="card">Card</div>
            </div>
            <form method="POST" action="/pos" id="pos-form">
              <input type="hidden" name="lines" id="lines-input">
              <input type="hidden" name="paymentMethod" id="payment-method-input">
              <button type="submit" class="process-btn" id="process-btn" disabled>Complete sale</button>
            </form>
          </div>
        </div>
      </div>
      <% } %>
```

Add CSS (alongside the existing styles):

```css
  .menu-sections { flex: 1; display: flex; flex-direction: column; gap: 22px; }
  .pos-section-head { font-size: 14px; letter-spacing: 0.02em; color: var(--ink-soft); margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  .menu-price-plus { color: var(--ink-soft); margin-left: 2px; }
  .customize-panel { background: #fff; border: 1px solid var(--gold); border-radius: 12px; padding: 14px; margin-bottom: 14px; }
  .customize-name { font-family: var(--font-display); font-weight: 600; font-size: 15px; margin-bottom: 10px; }
  .picker { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
  .picker button { flex: 1; padding: 8px 6px; border-radius: 7px; border: 1px solid var(--line); background: #fff; font-size: 12px; font-weight: 600; color: var(--ink-soft); cursor: pointer; white-space: nowrap; }
  .picker button.selected { border-color: var(--espresso); background: var(--espresso); color: var(--gold); }
  .picker button:disabled { opacity: 0.35; cursor: not-allowed; }
  .customize-note { width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 7px; font-size: 12.5px; margin-bottom: 10px; }
  .customize-add { width: 100%; }
  .bill-item .line-details { display: block; font-size: 11px; color: var(--ink-soft); }
```

Replace the whole `<script>` with:

```html
  <script>
    const cart = []; // [{ itemId, name, qty, price, size, sugar, temperature, note }]
    let selectedPayment = null;
    let pending = null; // item awaiting customization

    const SHOW = {
      size: <%= shop.pos_show_size %>,
      sugar: <%= shop.pos_show_sugar %>,
      temp: <%= shop.pos_show_temp %>,
      note: <%= shop.pos_show_note %>,
    };

    function itemSizePrice(card, size) {
      if (size === 'medium') return card.dataset.priceMedium ? parseFloat(card.dataset.priceMedium) : null;
      if (size === 'large') return card.dataset.priceLarge ? parseFloat(card.dataset.priceLarge) : null;
      return parseFloat(card.dataset.price);
    }

    function lineKey(l) { return [l.itemId, l.size || '', l.sugar || '', l.temperature || '', l.note || ''].join('|'); }

    function addLine(line) {
      const key = lineKey(line);
      const existing = cart.find((l) => lineKey(l) === key);
      if (existing) existing.qty += line.qty; else cart.push(line);
      renderBill();
    }

    function pickerValue(id) {
      const el = document.getElementById(id);
      if (!el) return undefined;
      const sel = el.querySelector('button.selected');
      return sel ? sel.dataset.value : undefined;
    }

    function selectDefault(id, value) {
      const el = document.getElementById(id);
      if (!el) return;
      el.querySelectorAll('button').forEach((b) => b.classList.toggle('selected', b.dataset.value === value));
    }

    document.querySelectorAll('.picker').forEach((p) => {
      p.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn || btn.disabled) return;
        p.querySelectorAll('button').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });

    const panel = document.getElementById('customize-panel');

    document.querySelectorAll('.menu-card').forEach((card) => {
      card.addEventListener('click', () => {
        if (document.body.classList.contains('arranging')) return;
        const isDrink = card.dataset.type === 'drink';
        const hasPickers = isDrink && (SHOW.size || SHOW.sugar || SHOW.temp || SHOW.note);
        if (!hasPickers) {
          addLine({ itemId: Number(card.dataset.id), name: card.dataset.itemName, qty: 1, price: parseFloat(card.dataset.price) });
          card.classList.add('just-added');
          setTimeout(() => card.classList.remove('just-added'), 400);
          return;
        }
        pending = card;
        panel.hidden = false;
        document.getElementById('customize-name').textContent = card.dataset.itemName;
        const sizePicker = document.getElementById('picker-size');
        if (sizePicker) {
          sizePicker.querySelectorAll('button').forEach((b) => {
            b.disabled = itemSizePrice(card, b.dataset.value) === null;
          });
          const singleSize = !card.dataset.priceMedium && !card.dataset.priceLarge;
          sizePicker.style.display = singleSize ? 'none' : '';
          selectDefault('picker-size', 'small');
        }
        selectDefault('picker-sugar', 'normal');
        selectDefault('picker-temp', 'hot');
        const note = document.getElementById('customize-note');
        if (note) note.value = '';
      });
    });

    document.getElementById('customize-add')?.addEventListener('click', () => {
      if (!pending) return;
      const size = (SHOW.size && pending.dataset.priceMedium) || (SHOW.size && pending.dataset.priceLarge) ? pickerValue('picker-size') : undefined;
      const line = {
        itemId: Number(pending.dataset.id),
        name: pending.dataset.itemName,
        qty: 1,
        price: itemSizePrice(pending, size),
        size,
        sugar: pickerValue('picker-sugar'),
        temperature: pickerValue('picker-temp'),
      };
      const note = document.getElementById('customize-note');
      if (note && note.value.trim()) line.note = note.value.trim();
      addLine(line);
      panel.hidden = true;
      pending = null;
    });

    document.querySelectorAll('.payment-choice').forEach((choice) => {
      choice.addEventListener('click', () => {
        document.querySelectorAll('.payment-choice').forEach((c) => c.classList.remove('selected'));
        choice.classList.add('selected');
        selectedPayment = choice.dataset.method;
        document.getElementById('payment-method-input').value = selectedPayment;
        updateProcessButton();
      });
    });

    function removeLine(index) { cart.splice(index, 1); renderBill(); }

    function updateProcessButton() {
      document.getElementById('process-btn').disabled = !(cart.length > 0 && selectedPayment);
    }

    const SIZE_LETTER = { small: 'S', medium: 'M', large: 'L' };
    const SUGAR_LABEL = { none: 'no sugar', less: 'less sugar', extra: 'extra sugar' };
    function detailText(l) {
      const parts = [];
      if (l.size) parts.push(SIZE_LETTER[l.size]);
      if (l.temperature === 'iced') parts.push('iced');
      if (l.sugar && l.sugar !== 'normal') parts.push(SUGAR_LABEL[l.sugar]);
      if (l.note) parts.push('"' + l.note + '"');
      return parts.join(' · ');
    }

    function renderBill() {
      const billList = document.getElementById('bill-list');
      if (cart.length === 0) {
        billList.innerHTML = '<p class="bill-empty">Tap an item to add it.</p>';
        document.getElementById('bill-count').textContent = '0';
        document.getElementById('bill-total').textContent = '$0.00';
        document.getElementById('lines-input').value = '';
        updateProcessButton();
        return;
      }
      let total = 0, count = 0;
      billList.innerHTML = cart.map((l, i) => {
        total += l.price * l.qty;
        count += l.qty;
        const details = detailText(l);
        return '<div class="receipt-line bill-item">'
          + '<span class="qty-name">' + l.name + ' &times;' + l.qty
          + (details ? '<span class="line-details">' + details.replace(/</g, '&lt;') + '</span>' : '')
          + '</span><span class="dots"></span>'
          + '<span>$' + (l.price * l.qty).toFixed(2) + '</span>'
          + '<button type="button" class="remove" onclick="removeLine(' + i + ')">remove</button></div>';
      }).join('');
      document.getElementById('lines-input').value = JSON.stringify(
        cart.map(({ itemId, qty, size, sugar, temperature, note }) => ({ itemId, qty, size, sugar, temperature, note }))
      );
      document.getElementById('bill-count').textContent = count;
      document.getElementById('bill-total').textContent = '$' + total.toFixed(2);
      updateProcessButton();
    }
  </script>
```

- [ ] **Step 5: Show customizations on receipt and dashboard**

`views/pos-receipt.ejs` — the line loop becomes:

```html
          <% sale.lineItems.forEach(item => { %>
            <% const details = formatLine(item); %>
            <div class="receipt-line">
              <span><%= item.name %> &times;<%= item.qty %><% if (details) { %><span style="display:block;font-size:11px;color:var(--ink-soft);"><%= details %></span><% } %></span>
              <span class="dots"></span>
              <span>$<%= (item.price * item.qty).toFixed(2) %></span>
            </div>
          <% }) %>
```

`views/dashboard.ejs` — the items cell becomes:

```html
                  <td><%= o.items.map(i => `${i.name} ×${i.qty}${formatLine(i) ? ` (${formatLine(i)})` : ''}`).join(', ') %></td>
```

and `GET /dashboard` in `server.js` passes the formatter:

```js
    res.render('dashboard', { orders: shopOrders, formatLine: posLines.formatLineDetails });
```

- [ ] **Step 6: Run tests, fix any old POS tests**

Run: `npm test`
Expected: the new tests pass. Any pre-existing POS tests that submit `qty_<id>` fields now fail — rewrite those submissions to the `lines` JSON format, preserving each test's intent (same items, same expected totals/assertions). Do not delete assertions.

- [ ] **Step 7: Commit**

```bash
git add server.js views/pos.ejs views/pos-receipt.ejs views/dashboard.ejs test/routes/pos.test.js
git commit -m "feat: POS customization panel, sectioned grid, and JSON-line sales"
```

---

## Task 8: Owner arrange mode — drag & drop layout

**Files:**
- Modify: `server.js` (add `POST /pos/layout`), `views/pos.ejs` (arrange toggle + DnD script)
- Test: `test/routes/pos-layout.test.js` (create)

**Interfaces:**
- Consumes: `menuItems.updateLayout` (Task 2), `shops.updateCategoryOrder` (Task 3).
- Produces: `POST /pos/layout` (owner-only), JSON body `{ categoryOrder: string[], items: [{ id, category, sortOrder }] }` → `204`. Staff → `403`.

- [ ] **Step 1: Write the failing tests**

```js
// test/routes/pos-layout.test.js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db, migrate, resetDb } = require('../../testHelpers/db');
const shops = require('../../models/shops');
const menuItems = require('../../models/menuItems');

before(async () => { await migrate(); });
beforeEach(async () => { await resetDb(); });
after(async () => { await db.pool.end(); });

async function ownerAgent(app, slug = 'blue-bottle') {
  const agent = request.agent(app);
  await agent.post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug, ownerName: 'Alex Owner', email: `owner@${slug}.test`, password: 'hunter2',
  });
  return agent;
}

test('owner can save a new layout', async () => {
  const app = require('../../server');
  const agent = await ownerAgent(app);
  const shop = await db.query('SELECT id FROM shops WHERE slug = $1', ['blue-bottle']);
  const shopId = shop.rows[0].id;
  const a = await menuItems.createMenuItem(db, { shopId, name: 'Latte', price: 4.5, category: 'Coffee' });
  const b = await menuItems.createMenuItem(db, { shopId, name: 'Mocha', price: 5, category: 'Coffee' });

  const res = await agent.post('/pos/layout').send({
    categoryOrder: ['Signature', 'Coffee'],
    items: [
      { id: a.id, category: 'Signature', sortOrder: 0 },
      { id: b.id, category: 'Coffee', sortOrder: 0 },
    ],
  });
  assert.equal(res.status, 204);

  const shopRow = await shops.getShopById(db, shopId);
  assert.deepEqual(shopRow.category_order, ['Signature', 'Coffee']);
  const moved = await menuItems.getMenuItemById(db, shopId, a.id);
  assert.equal(moved.category, 'Signature');
});

test('staff cannot save a layout', async () => {
  const app = require('../../server');
  await ownerAgent(app);
  const shopRow = await db.query('SELECT invite_code FROM shops WHERE slug = $1', ['blue-bottle']);
  const staffAgent = request.agent(app);
  await staffAgent.post('/signup/staff').type('form').send({
    name: 'Jamie Staff', email: 'jamie@bluebottle.test', password: 'hunter2', inviteCode: shopRow.rows[0].invite_code,
  });
  const res = await staffAgent.post('/pos/layout').send({ categoryOrder: [], items: [] });
  assert.equal(res.status, 403);
});

test("a layout save cannot move another shop's items", async () => {
  const app = require('../../server');
  const agent = await ownerAgent(app);
  const other = await shops.createShop(db, { name: 'Other', slug: 'other-shop' });
  const foreign = await menuItems.createMenuItem(db, { shopId: other.id, name: 'Foreign', price: 9, category: 'X' });

  const res = await agent.post('/pos/layout').send({
    categoryOrder: [], items: [{ id: foreign.id, category: 'Stolen', sortOrder: 0 }],
  });
  assert.equal(res.status, 204);
  const untouched = await menuItems.getMenuItemById(db, other.id, foreign.id);
  assert.equal(untouched.category, 'X');
});

test('rejects malformed layout payloads', async () => {
  const app = require('../../server');
  const agent = await ownerAgent(app);
  const res = await agent.post('/pos/layout').send({ categoryOrder: 'nope', items: 'nope' });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/routes/pos-layout.test.js`
Expected: FAIL — 404 on `/pos/layout`.

- [ ] **Step 3: Add the route to `server.js`**

The app needs a JSON body parser for this route. Next to the existing `app.use(express.urlencoded(...))` add (if not already present): `app.use(express.json());`

```js
app.post('/pos/layout', requireAuth, requireRole('owner'), async (req, res, next) => {
  const { categoryOrder, items } = req.body;
  if (!Array.isArray(categoryOrder) || !Array.isArray(items)
      || !categoryOrder.every((c) => typeof c === 'string')
      || !items.every((i) => i && Number.isInteger(Number(i.id)) && typeof i.category === 'string' && Number.isInteger(Number(i.sortOrder)))) {
    return res.status(400).send('Invalid layout.');
  }
  try {
    await menuItems.updateLayout(db, req.session.user.shopId, items.map((i) => ({
      id: Number(i.id), category: i.category, sortOrder: Number(i.sortOrder),
    })));
    await shops.updateCategoryOrder(db, req.session.user.shopId, categoryOrder);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Add arrange mode to `views/pos.ejs`**

Topbar (owner only) — replace the `<div class="app-topbar">` block:

```html
      <div class="app-topbar">
        <h1 style="font-size:26px;">New sale</h1>
        <% if (user.role === 'owner' && menu.length > 0) { %>
          <button type="button" class="btn-small" id="arrange-toggle">Arrange</button>
        <% } %>
      </div>
```

Add CSS:

```css
  .app-topbar { display: flex; align-items: center; justify-content: space-between; }
  body.arranging .menu-card { cursor: grab; border-style: dashed; }
  body.arranging .menu-card.dragging { opacity: 0.4; }
  body.arranging .pos-section-head { cursor: grab; }
  body.arranging .pos-section.drag-over .menu-grid { outline: 2px dashed var(--gold); outline-offset: 4px; border-radius: 10px; }
  #arrange-toggle.on { background: var(--espresso); color: var(--gold); border-color: var(--espresso); }
```

Append to the script (inside the same `<script>` tag):

```js
    const arrangeToggle = document.getElementById('arrange-toggle');
    if (arrangeToggle) {
      let dragCard = null;

      arrangeToggle.addEventListener('click', () => {
        const on = document.body.classList.toggle('arranging');
        arrangeToggle.classList.toggle('on', on);
        arrangeToggle.textContent = on ? 'Done' : 'Arrange';
        document.querySelectorAll('.menu-card').forEach((c) => { c.draggable = on; });
        if (!on) saveLayout();
      });

      document.querySelectorAll('.menu-card').forEach((card) => {
        card.addEventListener('dragstart', () => { dragCard = card; card.classList.add('dragging'); });
        card.addEventListener('dragend', () => { card.classList.remove('dragging'); dragCard = null; });
        card.addEventListener('dragover', (e) => {
          if (!dragCard || dragCard === card) return;
          e.preventDefault();
          const rect = card.getBoundingClientRect();
          const after = (e.clientX - rect.left) > rect.width / 2;
          card.parentNode.insertBefore(dragCard, after ? card.nextSibling : card);
        });
      });

      document.querySelectorAll('.pos-section').forEach((section) => {
        const grid = section.querySelector('.menu-grid');
        section.addEventListener('dragover', (e) => {
          if (!dragCard) return;
          e.preventDefault();
          section.classList.add('drag-over');
          if (!grid.contains(dragCard) && e.target.closest('.menu-grid') === grid && !e.target.closest('.menu-card')) {
            grid.appendChild(dragCard);
          }
        });
        section.addEventListener('dragleave', () => section.classList.remove('drag-over'));
        section.addEventListener('drop', (e) => { e.preventDefault(); section.classList.remove('drag-over'); });
      });

      function saveLayout() {
        const categoryOrder = [...document.querySelectorAll('.pos-section')].map((s) => s.dataset.category);
        const items = [];
        document.querySelectorAll('.pos-section').forEach((section) => {
          [...section.querySelectorAll('.menu-card')].forEach((card, i) => {
            items.push({ id: Number(card.dataset.id), category: section.dataset.category, sortOrder: i });
          });
        });
        fetch('/pos/layout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ categoryOrder, items }),
        });
      }
    }
```

(Section-header reordering rides on card moves: moving all of a category's cards effectively reorders it; full header dragging is covered by `categoryOrder` being read from current DOM order, and headers themselves aren't draggable in v1 — the spec's "drag section headers" is satisfied by this save shape if headers are made draggable later without server changes. Keep it minimal.)

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: full suite green.

- [ ] **Step 6: Commit**

```bash
git add server.js views/pos.ejs test/routes/pos-layout.test.js
git commit -m "feat: owner-only POS arrange mode with persisted layout"
```

---

## Final check

- [ ] Run `npm test` — every file green, no skips.
- [ ] Smoke test: `npm start`; as owner add a drink with M/L prices, arrange cards, ring up an iced large with no sugar and a note; verify the receipt line, the dashboard line, and that a shop with toggles off hides those pickers.

## Deviation note (from spec)

The spec says section headers themselves are draggable. Task 8 ships card-level dragging plus category ordering derived from DOM order; header dragging is a UI affordance that can be added later without any server change. If the user wants literal header dragging in v1, extend Task 8's script.
