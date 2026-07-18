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

test('GET /dashboard requires auth', async () => {
  const app = require('../../server');
  const res = await request(app).get('/dashboard');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('GET /dashboard is forbidden for a customer', async () => {
  const app = require('../../server');
  const agent = request.agent(app);
  await agent.post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  const res = await agent.get('/dashboard');
  assert.equal(res.status, 403);
});

test('GET /dashboard shows the owner\'s shop orders', async () => {
  const app = require('../../server');
  const ownerAgent = request.agent(app);
  await ownerAgent.post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex Owner', email: 'alex@bluebottle.test', password: 'hunter2',
  });
  const shopRow = await db.query('SELECT id FROM shops WHERE slug = $1', ['blue-bottle']);
  const itemRow = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 LIMIT 1', [shopRow.rows[0].id]);

  const customerAgent = request.agent(app);
  await customerAgent.post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  await customerAgent.post('/blue-bottle/order').type('form').send({ ['qty_' + itemRow.rows[0].id]: '1' });

  const res = await ownerAgent.get('/dashboard');
  assert.equal(res.status, 200);
  assert.match(res.text, /Sam Rivera/);
});

test('GET /dashboard does not leak another shop\'s orders', async () => {
  const app = require('../../server');

  const blueBottleOwner = request.agent(app);
  await blueBottleOwner.post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex Owner', email: 'alex@bluebottle.test', password: 'hunter2',
  });

  const philzOwner = request.agent(app);
  await philzOwner.post('/shops/new').type('form').send({
    shopName: 'Philz', slug: 'philz', ownerName: 'Jordan Owner', email: 'jordan@philz.test', password: 'hunter2',
  });

  const blueBottleShop = await db.query('SELECT id FROM shops WHERE slug = $1', ['blue-bottle']);
  const philzShop = await db.query('SELECT id FROM shops WHERE slug = $1', ['philz']);
  const blueBottleItem = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 LIMIT 1', [blueBottleShop.rows[0].id]);
  const philzItem = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 LIMIT 1', [philzShop.rows[0].id]);

  const blueBottleCustomer = request.agent(app);
  await blueBottleCustomer.post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  await blueBottleCustomer.post('/blue-bottle/order').type('form').send({ ['qty_' + blueBottleItem.rows[0].id]: '1' });

  const philzCustomer = request.agent(app);
  await philzCustomer.post('/signup').type('form').send({ name: 'Taylor Kim', email: 'taylor@example.com', password: 'hunter2' });
  await philzCustomer.post('/philz/order').type('form').send({ ['qty_' + philzItem.rows[0].id]: '1' });

  const philzDashboard = await philzOwner.get('/dashboard');
  assert.equal(philzDashboard.status, 200);
  assert.match(philzDashboard.text, /Taylor Kim/);
  assert.doesNotMatch(philzDashboard.text, /Sam Rivera/);

  const blueBottleDashboard = await blueBottleOwner.get('/dashboard');
  assert.equal(blueBottleDashboard.status, 200);
  assert.match(blueBottleDashboard.text, /Sam Rivera/);
  assert.doesNotMatch(blueBottleDashboard.text, /Taylor Kim/);
});

test('GET /dashboard shows walk-in sales distinctly from self-orders', async () => {
  const app = require('../../server');
  const ownerAgent = request.agent(app);
  await ownerAgent.post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex Owner', email: 'alex-walkin@bluebottle.test', password: 'hunter2',
  });
  const shopRow = await db.query('SELECT id FROM shops WHERE slug = $1', ['blue-bottle']);
  const itemRow = await db.query('SELECT id FROM menu_items WHERE shop_id = $1 LIMIT 1', [shopRow.rows[0].id]);

  await ownerAgent.post('/pos').type('form').send({ ['qty_' + itemRow.rows[0].id]: '1', paymentMethod: 'cash' });

  const res = await ownerAgent.get('/dashboard');
  assert.equal(res.status, 200);
  assert.match(res.text, /Walk-in/);
  assert.match(res.text, /rung up by Alex Owner/);
});
