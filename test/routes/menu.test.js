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
  const res = await agent.post('/menu').type('form').send({ name: 'Cortado', category: 'Coffee', price: '4.25', note: 'Equal parts' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/menu');

  const rows = await db.query('SELECT * FROM menu_items WHERE shop_id = $1 AND name = $2', [shopId, 'Cortado']);
  assert.equal(rows.rows.length, 1);
});

test('POST /menu rejects an invalid price', async () => {
  const app = require('../../server');
  const { agent } = await ownerAgentWithShop(app);
  const res = await agent.post('/menu').type('form').send({ name: 'Bad Item', category: 'Coffee', price: 'not-a-number' });
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
  const ownItem = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 LIMIT 1', [shopA.shopId]);
  const otherItem = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 LIMIT 1', [shopB.shopId]);

  const okRes = await shopA.agent.post('/menu/' + ownItem.rows[0].id).type('form').send({ name: 'Renamed', category: 'Coffee', price: '5.00' });
  assert.equal(okRes.status, 302);

  const crossRes = await shopA.agent.post('/menu/' + otherItem.rows[0].id).type('form').send({ name: 'Hacked', category: 'x', price: '0.01' });
  assert.equal(crossRes.status, 404);
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
