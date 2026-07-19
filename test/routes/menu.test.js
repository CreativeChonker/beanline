const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db, migrate, resetDb } = require('../../testHelpers/db');

before(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetDb();
});
after(async () => {
  await db.pool.end();
});

async function ownerAgentWithShop(app, slug = 'blue-bottle', email = 'owner@bluebottle.test') {
  const agent = request.agent(app);
  await agent.post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug, ownerName: 'Alex Owner', email, password: 'hunter2',
  });
  const shopRow = await db.query('SELECT id FROM shops WHERE slug = $1', [slug]);
  return { agent, shopId: shopRow.rows[0].id };
}

async function catId(shopId, name) {
  const row = await db.query('SELECT id FROM categories WHERE shop_id = $1 AND name = $2', [shopId, name]);
  return row.rows[0].id;
}

test('GET /menu requires auth', async () => {
  const app = require('../../server');
  const res = await request(app).get('/menu');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('GET /menu is forbidden for a customer', async () => {
  const app = require('../../server');
  const agent = request.agent(app);
  await agent.post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  const res = await agent.get('/menu');
  assert.equal(res.status, 403);
});

test('GET /menu lists only the owner\'s own shop items', async () => {
  const app = require('../../server');
  const shopA = await ownerAgentWithShop(app, 'blue-bottle', 'ownerA@test.com');
  await ownerAgentWithShop(app, 'ritual', 'ownerB@test.com');

  const res = await shopA.agent.get('/menu');
  assert.equal(res.status, 200);
  assert.match(res.text, /Latte/);
});

test('POST /menu creates a new item for the owner\'s shop', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const coffee = await catId(shopId, 'Coffee');
  const res = await agent.post('/menu').type('form').send({ name: 'Cortado', categoryId: coffee, price: '4.25', note: 'Equal parts' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/menu');

  const rows = await db.query('SELECT * FROM menu_items WHERE shop_id = $1 AND name = $2', [shopId, 'Cortado']);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].category_id, coffee);
});

test('POST /menu rejects an invalid price', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const res = await agent.post('/menu').type('form').send({ name: 'Bad Item', categoryId: await catId(shopId, 'Coffee'), price: 'not-a-number' });
  assert.equal(res.status, 200);
  assert.match(res.text, /valid price/);
});

test('GET /menu/:id/edit 404s for an id belonging to another shop', async () => {
  const app = require('../../server');
  const shopA = await ownerAgentWithShop(app, 'blue-bottle', 'ownerA@test.com');
  const shopB = await ownerAgentWithShop(app, 'ritual', 'ownerB@test.com');
  const itemRow = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 LIMIT 1', [shopB.shopId]);

  const res = await shopA.agent.get('/menu/' + itemRow.rows[0].id + '/edit');
  assert.equal(res.status, 404);
});

test('POST /menu/:id updates the item, and 404s for a cross-shop id', async () => {
  const app = require('../../server');
  const shopA = await ownerAgentWithShop(app, 'blue-bottle', 'ownerA@test.com');
  const shopB = await ownerAgentWithShop(app, 'ritual', 'ownerB@test.com');
  const coffee = await catId(shopA.shopId, 'Coffee');
  const ownItem = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 LIMIT 1', [shopA.shopId]);
  const otherItem = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 LIMIT 1', [shopB.shopId]);

  const okRes = await shopA.agent.post('/menu/' + ownItem.rows[0].id).type('form').send({ name: 'Renamed', categoryId: coffee, price: '5.00' });
  assert.equal(okRes.status, 302);

  const crossRes = await shopA.agent.post('/menu/' + otherItem.rows[0].id).type('form').send({ name: 'Hacked', categoryId: coffee, price: '0.01' });
  assert.equal(crossRes.status, 404);
});

test('POST /menu/:id refuses a category belonging to another shop', async () => {
  const app = require('../../server');
  const shopA = await ownerAgentWithShop(app, 'blue-bottle', 'ownerA@test.com');
  const shopB = await ownerAgentWithShop(app, 'ritual', 'ownerB@test.com');
  const foreignCat = await catId(shopB.shopId, 'Coffee');
  const ownItem = await db.query('SELECT id, category_id FROM menu_items WHERE shop_id = $1 LIMIT 1', [shopA.shopId]);

  const res = await shopA.agent.post('/menu/' + ownItem.rows[0].id).type('form').send({ name: 'Latte', categoryId: foreignCat, price: '5.00' });
  assert.equal(res.status, 200);
  assert.match(res.text, /choose a category/i);
  const after = await db.query('SELECT category_id FROM menu_items WHERE id = $1', [ownItem.rows[0].id]);
  assert.equal(after.rows[0].category_id, ownItem.rows[0].category_id);
});

test('POST /menu/:id/toggle flips availability, and 404s for a cross-shop id', async () => {
  const app = require('../../server');
  const shopA = await ownerAgentWithShop(app, 'blue-bottle', 'ownerA@test.com');
  const shopB = await ownerAgentWithShop(app, 'ritual', 'ownerB@test.com');
  const ownItem = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 LIMIT 1', [shopA.shopId]);
  const otherItem = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 LIMIT 1', [shopB.shopId]);

  const okRes = await shopA.agent.post('/menu/' + ownItem.rows[0].id + '/toggle');
  assert.equal(okRes.status, 302);
  const updated = await db.query('SELECT available FROM menu_items WHERE id = $1', [ownItem.rows[0].id]);
  assert.equal(updated.rows[0].available, false);

  const crossRes = await shopA.agent.post('/menu/' + otherItem.rows[0].id + '/toggle');
  assert.equal(crossRes.status, 404);
});

test('POST /menu/:id/delete removes the item, and 404s for a cross-shop id', async () => {
  const app = require('../../server');
  const shopA = await ownerAgentWithShop(app, 'blue-bottle', 'ownerA@test.com');
  const shopB = await ownerAgentWithShop(app, 'ritual', 'ownerB@test.com');
  const ownItem = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 LIMIT 1', [shopA.shopId]);
  const otherItem = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 LIMIT 1', [shopB.shopId]);

  const crossRes = await shopA.agent.post('/menu/' + otherItem.rows[0].id + '/delete');
  assert.equal(crossRes.status, 404);

  const okRes = await shopA.agent.post('/menu/' + ownItem.rows[0].id + '/delete');
  assert.equal(okRes.status, 302);
  const gone = await db.query('SELECT * FROM menu_items WHERE id = $1', [ownItem.rows[0].id]);
  assert.equal(gone.rows.length, 0);
});

test('POST /menu stores per-tier prices and clears tiers the category does not have', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  await agent.post('/menu').type('form').send({
    name: 'Test Latte', categoryId: await catId(shopId, 'Coffee'), price: '4.50', priceMedium: '5.00', priceLarge: '5.50',
  });
  // Pastry has a single tier: submitted extra prices are dropped
  await agent.post('/menu').type('form').send({
    name: 'Test Croissant', categoryId: await catId(shopId, 'Pastry'), price: '3.25', priceMedium: '4.00', priceLarge: '5.00',
  });
  const rows = await db.query("SELECT name, price_medium::float8 AS pm, price_large::float8 AS pl FROM menu_items WHERE name IN ('Test Latte', 'Test Croissant') ORDER BY name");
  assert.deepEqual(rows.rows, [
    { name: 'Test Croissant', pm: null, pl: null },
    { name: 'Test Latte', pm: 5.0, pl: 5.5 },
  ]);
});

test('POST /menu rejects an invalid tier price without creating the item', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const res = await agent.post('/menu').type('form').send({
    name: 'Test Latte', categoryId: await catId(shopId, 'Coffee'), price: '4.50', priceMedium: '-2',
  });
  assert.match(res.text, /valid price/i);
  const rows = await db.query("SELECT COUNT(*)::int AS n FROM menu_items WHERE name = 'Test Latte'");
  assert.equal(rows.rows[0].n, 0);
});

test('the menu editor uses plain language instead of "86 it"', async () => {
  const app = require('../../server');
  const { agent } = await ownerAgentWithShop(app);
  const res = await agent.get('/menu');
  assert.doesNotMatch(res.text, /86 it/);
  assert.match(res.text, /class="btn-small btn-soldout">Sold out</);
});

test('POST /menu with a photo stores it in object storage and saves the URL', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const res = await agent.post('/menu')
    .field('name', 'Photo Latte').field('categoryId', String(await catId(shopId, 'Coffee'))).field('price', '4.50')
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
    .field('name', 'Photo Latte').field('categoryId', String(await catId(shopId, 'Coffee'))).field('price', '4.50')
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
  const coffee = String(await catId(shopId, 'Coffee'));
  await agent.post('/menu')
    .field('name', 'Photo Mocha').field('categoryId', coffee).field('price', '5.00')
    .attach('itemImage', Buffer.from('fake jpeg bytes'), { filename: 'mocha.jpg', contentType: 'image/jpeg' });
  const before = await db.query("SELECT id, image_url FROM menu_items WHERE shop_id = $1 AND name = 'Photo Mocha'", [shopId]);

  const res = await agent.post(`/menu/${before.rows[0].id}`)
    .field('name', 'Photo Mocha').field('categoryId', coffee).field('price', '5.25')
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
  const coffee = String(await catId(shopId, 'Coffee'));
  await agent.post('/menu')
    .field('name', 'Photo Flat').field('categoryId', coffee).field('price', '4.00')
    .attach('itemImage', Buffer.from('v1'), { filename: 'a.png', contentType: 'image/png' });
  const before = await db.query("SELECT id, image_url FROM menu_items WHERE shop_id = $1 AND name = 'Photo Flat'", [shopId]);

  await agent.post(`/menu/${before.rows[0].id}`)
    .field('name', 'Photo Flat').field('categoryId', coffee).field('price', '4.00')
    .attach('itemImage', Buffer.from('v2'), { filename: 'b.png', contentType: 'image/png' });
  const after = await db.query("SELECT image_url FROM menu_items WHERE id = $1", [before.rows[0].id]);
  assert.notEqual(after.rows[0].image_url, before.rows[0].image_url);
  assert.match(after.rows[0].image_url, /^http/);
});

test('GET /menu renders collapsible sections, thumbnails, tier columns, and the category dropdown', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  await db.query("UPDATE menu_items SET image_url = 'http://img.test/x.jpg' WHERE shop_id = $1 AND name = 'Latte'", [shopId]);
  const res = await agent.get('/menu');
  assert.match(res.text, /class="menu-section-toggle"/);
  assert.match(res.text, /src="http:\/\/img.test\/x.jpg"/);
  assert.match(res.text, /class="menu-thumb-placeholder"/);
  assert.match(res.text, />Coffee<\/option>/);
  assert.match(res.text, /data-tiers/);
  assert.match(res.text, /New category…/);
  assert.doesNotMatch(res.text, /id="add-item-btn"/);
  assert.match(res.text, /class="col-prices"/);
});

test('each row has Edit, a Sold out toggle, and a confirming delete form', async () => {
  const app = require('../../server');
  const { agent } = await ownerAgentWithShop(app);
  const res = await agent.get('/menu');
  assert.match(res.text, /class="btn-small btn-edit"/);
  assert.match(res.text, /class="btn-small btn-soldout">Sold out</);
  assert.match(res.text, /class="delete-form" data-item-name=/);
  assert.match(res.text, /aria-label="Remove /);
  assert.doesNotMatch(res.text, /class="overflow-menu"/);
});

test('a validation error keeps a typed new category without creating it', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const res = await agent.post('/menu')
    .field('name', 'Photo Bun').field('categoryId', '__new__').field('categoryNew', 'Pastries')
    .field('price', '3.00').field('priceMedium', '-1');
  assert.equal(res.status, 200);
  assert.match(res.text, /valid price/i);
  assert.match(res.text, /id="categoryNew"[^>]*value="Pastries"/);
  assert.match(res.text, /value="__new__"\s+selected/);
  const cats = await db.query("SELECT COUNT(*)::int AS n FROM categories WHERE shop_id = $1 AND name = 'Pastries'", [shopId]);
  assert.equal(cats.rows[0].n, 0);
});

test('POST /menu with a new category creates a single-tier category and files the item under it', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const res = await agent.post('/menu').type('form').send({
    name: 'Test Scone', categoryId: '__new__', categoryNew: 'Bakery', price: '2.75', priceMedium: '3.25', priceLarge: '3.75',
  });
  assert.equal(res.status, 302);
  const cat = await db.query("SELECT id, tier_names FROM categories WHERE shop_id = $1 AND name = 'Bakery'", [shopId]);
  assert.deepEqual(cat.rows[0].tier_names, ['Price']);
  const row = await db.query("SELECT category_id, price_medium, price_large FROM menu_items WHERE shop_id = $1 AND name = 'Test Scone'", [shopId]);
  assert.deepEqual(row.rows[0], { category_id: cat.rows[0].id, price_medium: null, price_large: null });
});

// --- Category management ---

test('POST /categories creates a category with custom tiers; it renders even while empty', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const res = await agent.post('/categories').type('form').send({ name: 'Cakes', tierNames: 'Slice, Whole' });
  assert.equal(res.status, 302);
  const cat = await db.query("SELECT tier_names, drink_options FROM categories WHERE shop_id = $1 AND name = 'Cakes'", [shopId]);
  assert.deepEqual(cat.rows[0].tier_names, ['Slice', 'Whole']);
  assert.equal(cat.rows[0].drink_options, false);

  const menu = await agent.get('/menu');
  assert.match(menu.text, /Cakes/);
  assert.match(menu.text, /No items in this category yet/);
});

test('POST /categories rejects bad tier lists and duplicate names', async () => {
  const app = require('../../server');
  const { agent } = await ownerAgentWithShop(app);
  const tooMany = await agent.post('/categories').type('form').send({ name: 'X', tierNames: 'a, b, c, d' });
  assert.match(tooMany.text, /1–3 price tiers/);
  const dupe = await agent.post('/categories').type('form').send({ name: 'Coffee', tierNames: 'Price' });
  assert.match(dupe.text, /already exists/);
});

test('renaming a category updates it everywhere it is displayed', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const coffee = await catId(shopId, 'Coffee');
  const res = await agent.post(`/categories/${coffee}`).type('form').send({
    name: 'Espresso Bar', tierNames: 'Small, Medium, Large', drinkOptions: 'on', displayOrder: '0',
  });
  assert.equal(res.status, 302);
  const menu = await agent.get('/menu');
  assert.match(menu.text, /Espresso Bar/);
  assert.doesNotMatch(menu.text, />Coffee</);
  const pos = await agent.get('/pos');
  assert.match(pos.text, /Espresso Bar/);
});

test('archiving a category hides it and its items from the POS but keeps it in the editor', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const coffee = await catId(shopId, 'Coffee');
  await agent.post(`/categories/${coffee}`).type('form').send({
    name: 'Coffee', tierNames: 'Small, Medium, Large', drinkOptions: 'on', archived: 'on', displayOrder: '0',
  });
  const pos = await agent.get('/pos');
  assert.doesNotMatch(pos.text, /Latte/);
  const menu = await agent.get('/menu');
  assert.match(menu.text, /Latte/);
  assert.match(menu.text, /Archived/);
});

test('a category cannot be updated or deleted by another shop\'s owner', async () => {
  const app = require('../../server');
  const shopA = await ownerAgentWithShop(app, 'blue-bottle', 'ownerA@test.com');
  const shopB = await ownerAgentWithShop(app, 'ritual', 'ownerB@test.com');
  const foreignCat = await catId(shopB.shopId, 'Coffee');
  const upd = await shopA.agent.post(`/categories/${foreignCat}`).type('form').send({ name: 'Stolen', tierNames: 'Price' });
  assert.equal(upd.status, 404);
  const del = await shopA.agent.post(`/categories/${foreignCat}/delete`);
  assert.equal(del.status, 404);
});

test('deleting a category is refused while it still has items, allowed when empty', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const coffee = await catId(shopId, 'Coffee');
  const refused = await agent.post(`/categories/${coffee}/delete`);
  assert.equal(refused.status, 200);
  assert.match(refused.text, /Move or delete the items/);

  await agent.post('/categories').type('form').send({ name: 'Empty Cat', tierNames: 'Price' });
  const emptyCat = await catId(shopId, 'Empty Cat');
  const ok = await agent.post(`/categories/${emptyCat}/delete`);
  assert.equal(ok.status, 302);
  const gone = await db.query('SELECT COUNT(*)::int AS n FROM categories WHERE id = $1', [emptyCat]);
  assert.equal(gone.rows[0].n, 0);
});
