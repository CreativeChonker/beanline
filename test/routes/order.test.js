// test/routes/order.test.js
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

async function loggedInCustomer(app) {
  const agent = request.agent(app);
  await agent.post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  return agent;
}

async function createShopWithMenu(app) {
  await request(app).post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex Owner', email: 'alex@bluebottle.test', password: 'hunter2',
  });
  const shopRow = await db.query('SELECT id, slug FROM shops WHERE slug = $1', ['blue-bottle']);
  return shopRow.rows[0];
}

test('GET /:shopSlug/order 404s for an unknown shop', async () => {
  const app = require('../../server');
  const agent = await loggedInCustomer(app);
  const res = await agent.get('/does-not-exist/order');
  assert.equal(res.status, 404);
});

test('GET /:shopSlug/order requires auth', async () => {
  const app = require('../../server');
  await createShopWithMenu(app);
  const res = await request(app).get('/blue-bottle/order');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('GET /:shopSlug/order renders the shop\'s own menu for a logged-in customer', async () => {
  const app = require('../../server');
  await createShopWithMenu(app);
  const agent = await loggedInCustomer(app);
  const res = await agent.get('/blue-bottle/order');
  assert.equal(res.status, 200);
  assert.match(res.text, /action="\/blue-bottle\/order"/);
  assert.match(res.text, /Latte/);
});

test('GET /:shopSlug/order shows an empty-menu state when the shop has no available items', async () => {
  const app = require('../../server');
  const shop = await createShopWithMenu(app);
  await db.query('UPDATE menu_items SET available = false WHERE shop_id = $1', [shop.id]);
  const agent = await loggedInCustomer(app);
  const res = await agent.get('/blue-bottle/order');
  assert.equal(res.status, 200);
  assert.match(res.text, /hasn't added anything/);
});

test('POST /:shopSlug/order creates an order scoped to that shop, using the shop\'s own menu item ids', async () => {
  const app = require('../../server');
  const shop = await createShopWithMenu(app);
  const agent = await loggedInCustomer(app);
  const itemRow = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 AND name = $2', [shop.id, 'Latte']);
  const itemId = itemRow.rows[0].id;

  const res = await agent.post('/blue-bottle/order').type('form').send({ ['qty_' + itemId]: '2' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Order received/);

  const orderRow = await db.query('SELECT * FROM orders WHERE shop_id = $1', [shop.id]);
  assert.equal(orderRow.rows.length, 1);
});

test('POST /:shopSlug/order excludes unavailable items even if their id is submitted', async () => {
  const app = require('../../server');
  const shop = await createShopWithMenu(app);
  const agent = await loggedInCustomer(app);
  const itemRow = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 AND name = $2', [shop.id, 'Latte']);
  const itemId = itemRow.rows[0].id;
  await db.query('UPDATE menu_items SET available = false WHERE id = $1', [itemId]);

  const res = await agent.post('/blue-bottle/order').type('form').send({ ['qty_' + itemId]: '2' });
  assert.equal(res.status, 200);
  assert.match(res.text, /select at least one item/);
});

test('POST /:shopSlug/order with no items selected re-renders with an error', async () => {
  const app = require('../../server');
  await createShopWithMenu(app);
  const agent = await loggedInCustomer(app);
  const res = await agent.post('/blue-bottle/order').type('form').send({});
  assert.equal(res.status, 200);
  assert.match(res.text, /select at least one item/);
});
