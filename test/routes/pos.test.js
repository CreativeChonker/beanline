const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db, migrate, resetDb } = require('../../testHelpers/db');
const shops = require('../../models/shops');
const categories = require('../../models/categories');
const menuItems = require('../../models/menuItems');

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

// Creates a shop (with its seeded starter menu, including Latte and Espresso) via the owner
// signup flow, then signs up a staff member for that shop through the invite-code flow and
// returns an agent authenticated as that staff member.
async function staffAgentWithMenu(app, slug = 'blue-bottle', ownerEmail = 'owner@bluebottle.test', staffEmail = 'staff@bluebottle.test') {
  const { shopId } = await ownerAgentWithShop(app, slug, ownerEmail);
  const shopRow = await db.query('SELECT invite_code FROM shops WHERE id = $1', [shopId]);
  const agent = request.agent(app);
  await agent.post('/signup/staff').type('form').send({
    name: 'Jamie Staff', email: staffEmail, password: 'hunter2', inviteCode: shopRow.rows[0].invite_code,
  });
  return { agent, shopId };
}

test('GET /pos requires auth', async () => {
  const app = require('../../server');
  const res = await request(app).get('/pos');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('GET /pos is forbidden for a customer', async () => {
  const app = require('../../server');
  const agent = request.agent(app);
  await agent.post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  const res = await agent.get('/pos');
  assert.equal(res.status, 403);
});

test('GET /pos renders the shop\'s available items for the owner', async () => {
  const app = require('../../server');
  const { agent } = await ownerAgentWithShop(app);
  const res = await agent.get('/pos');
  assert.equal(res.status, 200);
  assert.match(res.text, /Latte/);
});

test('POST /pos completes a walk-in sale with no customer, correct staff attribution and status', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const itemRow = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 AND name = $2', [shopId, 'Latte']);
  const itemId = itemRow.rows[0].id;

  const res = await agent.post('/pos').type('form').send({
    paymentMethod: 'cash',
    lines: JSON.stringify([{ itemId, qty: 2 }]),
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /Sale complete/);

  const orderRow = await db.query('SELECT user_id, staff_user_id, status, payment_method FROM orders WHERE shop_id = $1', [shopId]);
  assert.equal(orderRow.rows.length, 1);
  assert.equal(orderRow.rows[0].user_id, null);
  assert.ok(orderRow.rows[0].staff_user_id > 0);
  assert.equal(orderRow.rows[0].status, 'completed');
  assert.equal(orderRow.rows[0].payment_method, 'cash');
});

test('POST /pos with no items selected re-renders with an error', async () => {
  const app = require('../../server');
  const { agent } = await ownerAgentWithShop(app);
  const res = await agent.post('/pos').type('form').send({ paymentMethod: 'cash', lines: JSON.stringify([]) });
  assert.equal(res.status, 200);
  assert.match(res.text, /select at least one item/);
});

test('POST /pos with a missing or invalid payment method re-renders with an error', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const itemRow = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 AND name = $2', [shopId, 'Latte']);
  const res = await agent.post('/pos').type('form').send({
    paymentMethod: 'bitcoin',
    lines: JSON.stringify([{ itemId: itemRow.rows[0].id, qty: 1 }]),
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /payment method/);
});

test('POST /pos excludes unavailable items even if their id is submitted', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const itemRow = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 AND name = $2', [shopId, 'Latte']);
  const itemId = itemRow.rows[0].id;
  await db.query('UPDATE menu_items SET available = false WHERE id = $1', [itemId]);

  const res = await agent.post('/pos').type('form').send({
    paymentMethod: 'cash',
    lines: JSON.stringify([{ itemId, qty: 1 }]),
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /no longer available/i);

  const count = await db.query('SELECT COUNT(*)::int AS n FROM orders WHERE shop_id = $1', [shopId]);
  assert.equal(count.rows[0].n, 0);
});

test('POST /pos with customized lines snapshots tier pricing and stores customizations', async () => {
  const app = require('../../server');
  const { agent, shopId } = await staffAgentWithMenu(app);
  const latte = await db.query("SELECT id FROM menu_items WHERE shop_id = $1 AND name = 'Latte'", [shopId]);
  await db.query('UPDATE menu_items SET price_medium = 5.00, price_large = 5.50 WHERE id = $1', [latte.rows[0].id]);

  const res = await agent.post('/pos').type('form').send({
    paymentMethod: 'cash',
    lines: JSON.stringify([
      { itemId: latte.rows[0].id, qty: 1, tier: 2, sugar: 'none', temperature: 'iced', note: 'oat milk' },
      { itemId: latte.rows[0].id, qty: 2, tier: 0 },
    ]),
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /iced/);
  assert.match(res.text, /no sugar/);

  const order = await db.query('SELECT items_json, total::float8 AS total FROM orders WHERE shop_id = $1', [shopId]);
  const items = JSON.parse(order.rows[0].items_json);
  assert.equal(items[0].tier_label, 'Large');
  assert.equal(items[0].price, 5.5);
  assert.equal(items[0].note, 'oat milk');
  assert.equal(items[1].tier_label, 'Small');
  assert.equal(order.rows[0].total, 5.5 + 2 * 4.5);
});

test('POST /pos rejects a tier the item does not offer', async () => {
  const app = require('../../server');
  const { agent, shopId } = await staffAgentWithMenu(app);
  const espresso = await db.query("SELECT id FROM menu_items WHERE shop_id = $1 AND name = 'Espresso'", [shopId]);

  const res = await agent.post('/pos').type('form').send({
    paymentMethod: 'cash',
    lines: JSON.stringify([{ itemId: espresso.rows[0].id, qty: 1, tier: 2 }]),
  });
  assert.match(res.text, /does not come in that option/i);
  const count = await db.query('SELECT COUNT(*)::int AS n FROM orders WHERE shop_id = $1', [shopId]);
  assert.equal(count.rows[0].n, 0);
});

test("POST /pos still cannot ring up another shop's item id", async () => {
  const app = require('../../server');
  const { agent } = await staffAgentWithMenu(app);
  const otherShop = await shops.createShop(db, { name: 'Other', slug: 'other-shop' });
  const otherCat = await categories.createCategory(db, { shopId: otherShop.id, name: 'X' });
  const foreign = await menuItems.createMenuItem(db, { shopId: otherShop.id, name: 'Foreign', price: 9, categoryId: otherCat.id });

  const res = await agent.post('/pos').type('form').send({
    paymentMethod: 'cash',
    lines: JSON.stringify([{ itemId: foreign.id, qty: 1 }]),
  });
  assert.match(res.text, /no longer available/i);
});

test('GET /pos escapes item names in server-rendered card markup', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const coffee = await db.query("SELECT id FROM categories WHERE shop_id = $1 AND name = 'Coffee'", [shopId]);
  await menuItems.createMenuItem(db, {
    shopId, name: 'S\'mores <3 & "Latte"', price: 5, categoryId: coffee.rows[0].id,
  });
  const res = await agent.get('/pos');
  assert.equal(res.status, 200);
  assert.match(res.text, /S&#39;mores/);
  assert.match(res.text, /&lt;3/);
  assert.doesNotMatch(res.text, /<img/);
});

test('GET /pos renders category sections and hides pickers the shop disabled', async () => {
  const app = require('../../server');
  const { agent, shopId } = await staffAgentWithMenu(app);
  await db.query('UPDATE shops SET pos_show_sugar = false WHERE id = $1', [shopId]);
  const res = await agent.get('/pos');
  assert.match(res.text, /class="pos-section"/);
  assert.doesNotMatch(res.text, /data-picker="sugar"/);
  assert.match(res.text, /id="picker-tier"/);
});

test('GET /pos shows empty categories only when show_when_empty is set', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  await categories.createCategory(db, { shopId, name: 'Hidden Empty' });
  await categories.createCategory(db, { shopId, name: 'Visible Empty', showWhenEmpty: true });
  const res = await agent.get('/pos');
  assert.doesNotMatch(res.text, /Hidden Empty/);
  assert.match(res.text, /Visible Empty/);
});

test('GET /pos keeps cards text-only even when items have photos', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  await db.query("UPDATE menu_items SET image_url = 'http://img.test/latte.jpg' WHERE shop_id = $1 AND name = 'Latte'", [shopId]);
  const res = await agent.get('/pos');
  assert.doesNotMatch(res.text, /menu-card-photo/);
  assert.doesNotMatch(res.text, /img.test\/latte.jpg/);
});

test('POST /pos rings up a custom-tier category (Slice/Whole) with server-side pricing', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const cakes = await categories.createCategory(db, { shopId, name: 'Cakes', tierNames: ['Slice', 'Whole'] });
  const cake = await menuItems.createMenuItem(db, {
    shopId, name: 'Test Carrot Cake', price: 4.0, categoryId: cakes.id, priceMedium: 38.0,
  });

  const res = await agent.post('/pos').type('form').send({
    paymentMethod: 'cash',
    lines: JSON.stringify([
      { itemId: cake.id, qty: 2, tier: 0 },
      { itemId: cake.id, qty: 1, tier: 1, price: 0.01 },
    ]),
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /Whole/);

  const order = await db.query("SELECT items_json, total::float8 AS total FROM orders WHERE shop_id = $1 ORDER BY id DESC LIMIT 1", [shopId]);
  const items = JSON.parse(order.rows[0].items_json);
  assert.equal(items[0].tier_label, 'Slice');
  assert.equal(items[0].price, 4.0);
  assert.equal(items[1].tier_label, 'Whole');
  assert.equal(items[1].price, 38.0);
  assert.equal(order.rows[0].total, 46.0);
});

test('POST /pos rejects out-of-range and unpriced tiers', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const cakes = await categories.createCategory(db, { shopId, name: 'Cakes', tierNames: ['Slice', 'Whole'] });
  const sliceOnly = await menuItems.createMenuItem(db, {
    shopId, name: 'Test Brownie Cake', price: 3.5, categoryId: cakes.id,
  });

  const bad1 = await agent.post('/pos').type('form').send({
    paymentMethod: 'cash', lines: JSON.stringify([{ itemId: sliceOnly.id, qty: 1, tier: 2 }]),
  });
  assert.match(bad1.text, /does not come in that option/i);

  const bad2 = await agent.post('/pos').type('form').send({
    paymentMethod: 'cash', lines: JSON.stringify([{ itemId: sliceOnly.id, qty: 1, tier: 1 }]),
  });
  assert.match(bad2.text, /does not come in that option/i);

  const count = await db.query('SELECT COUNT(*)::int AS n FROM orders WHERE shop_id = $1', [shopId]);
  assert.equal(count.rows[0].n, 0);
});

test('GET /pos renders the generic tier picker and no hardcoded size markup', async () => {
  const app = require('../../server');
  const { agent } = await ownerAgentWithShop(app);
  const res = await agent.get('/pos');
  assert.match(res.text, /id="picker-tier"/);
  assert.doesNotMatch(res.text, /data-picker="cakesize"/);
  assert.doesNotMatch(res.text, /data-picker="size"/);
});
