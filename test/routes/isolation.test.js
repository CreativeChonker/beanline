// test/routes/isolation.test.js
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

test('staff of shop A cannot see shop B\'s orders on their own dashboard', async () => {
  const app = require('../../server');
  const menu = require('../../menu');

  const ownerA = request.agent(app);
  await ownerA.post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex A', email: 'alex@a.test', password: 'hunter2',
  });

  const ownerB = request.agent(app);
  await ownerB.post('/shops/new').type('form').send({
    shopName: 'Ritual', slug: 'ritual', ownerName: 'Robin B', email: 'robin@b.test', password: 'hunter2',
  });

  const customer = request.agent(app);
  await customer.post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  await customer.post('/ritual/order').type('form').send({ ['qty_' + menu[0].id]: '1' });

  const dashboardA = await ownerA.get('/dashboard');
  assert.equal(dashboardA.status, 200);
  assert.doesNotMatch(dashboardA.text, /Sam Rivera/);

  const dashboardB = await ownerB.get('/dashboard');
  assert.equal(dashboardB.status, 200);
  assert.match(dashboardB.text, /Sam Rivera/);
});

test('a customer can order from two different shops with one account', async () => {
  const app = require('../../server');
  const menu = require('../../menu');

  await request(app).post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex A', email: 'alex@a.test', password: 'hunter2',
  });
  await request(app).post('/shops/new').type('form').send({
    shopName: 'Ritual', slug: 'ritual', ownerName: 'Robin B', email: 'robin@b.test', password: 'hunter2',
  });

  const customer = request.agent(app);
  await customer.post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });

  const resA = await customer.post('/blue-bottle/order').type('form').send({ ['qty_' + menu[0].id]: '1' });
  const resB = await customer.post('/ritual/order').type('form').send({ ['qty_' + menu[0].id]: '1' });
  assert.match(resA.text, /Order received/);
  assert.match(resB.text, /Order received/);

  const orderCount = await db.query('SELECT count(*) FROM orders WHERE user_id = (SELECT id FROM users WHERE email = $1)', ['sam@example.com']);
  assert.equal(Number(orderCount.rows[0].count), 2);
});
