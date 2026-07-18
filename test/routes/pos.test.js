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

  const res = await agent.post('/pos').type('form').send({ ['qty_' + itemId]: '2', paymentMethod: 'cash' });
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
  const res = await agent.post('/pos').type('form').send({ paymentMethod: 'cash' });
  assert.equal(res.status, 200);
  assert.match(res.text, /select at least one item/);
});

test('POST /pos with a missing or invalid payment method re-renders with an error', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const itemRow = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 AND name = $2', [shopId, 'Latte']);
  const res = await agent.post('/pos').type('form').send({ ['qty_' + itemRow.rows[0].id]: '1', paymentMethod: 'bitcoin' });
  assert.equal(res.status, 200);
  assert.match(res.text, /payment method/);
});

test('POST /pos excludes unavailable items even if their id is submitted', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgentWithShop(app);
  const itemRow = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 AND name = $2', [shopId, 'Latte']);
  const itemId = itemRow.rows[0].id;
  await db.query('UPDATE menu_items SET available = false WHERE id = $1', [itemId]);

  const res = await agent.post('/pos').type('form').send({ ['qty_' + itemId]: '1', paymentMethod: 'cash' });
  assert.equal(res.status, 200);
  assert.match(res.text, /select at least one item/);
});
