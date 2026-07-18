const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db, migrate, resetDb } = require('../../testHelpers/db');
const shops = require('../../models/shops');

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

test('GET /:shopSlug/order 404s for an unknown shop', async () => {
  const app = require('../../server');
  const agent = await loggedInCustomer(app);
  const res = await agent.get('/does-not-exist/order');
  assert.equal(res.status, 404);
});

test('GET /:shopSlug/order requires auth', async () => {
  const app = require('../../server');
  await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const res = await request(app).get('/blue-bottle/order');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('GET /:shopSlug/order renders the menu for a logged-in customer', async () => {
  const app = require('../../server');
  await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const agent = await loggedInCustomer(app);
  const res = await agent.get('/blue-bottle/order');
  assert.equal(res.status, 200);
  assert.match(res.text, /action="\/blue-bottle\/order"/);
});

test('POST /:shopSlug/order creates an order scoped to that shop', async () => {
  const app = require('../../server');
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const agent = await loggedInCustomer(app);

  const menu = require('../../menu');
  const firstItem = menu[0];

  const res = await agent.post('/blue-bottle/order').type('form').send({ ['qty_' + firstItem.id]: '2' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Order received/);

  const orderRow = await db.query('SELECT * FROM orders WHERE shop_id = $1', [shop.id]);
  assert.equal(orderRow.rows.length, 1);
});

test('POST /:shopSlug/order with no items selected re-renders with an error', async () => {
  const app = require('../../server');
  await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const agent = await loggedInCustomer(app);
  const res = await agent.post('/blue-bottle/order').type('form').send({});
  assert.equal(res.status, 200);
  assert.match(res.text, /select at least one item/);
});
