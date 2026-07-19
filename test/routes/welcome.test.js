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

test('GET /welcome shows every shop on the platform', async () => {
  const app = require('../../server');
  await request(app).post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex A', email: 'alex@a.test', password: 'hunter2',
  });
  await request(app).post('/shops/new').type('form').send({
    shopName: 'Ritual', slug: 'ritual', ownerName: 'Robin B', email: 'robin@b.test', password: 'hunter2',
  });

  const agent = await loggedInCustomer(app);
  const res = await agent.get('/welcome');
  assert.equal(res.status, 200);
  assert.match(res.text, /Blue Bottle/);
  assert.match(res.text, /Ritual/);
});

test('GET /welcome shows a shop with no tagline or photo without breaking', async () => {
  const app = require('../../server');
  await request(app).post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex A', email: 'alex@a.test', password: 'hunter2',
  });

  const agent = await loggedInCustomer(app);
  const res = await agent.get('/welcome');
  assert.equal(res.status, 200);
  assert.match(res.text, /Blue Bottle/);
});

test('GET /welcome links each shop card to its real order page', async () => {
  const app = require('../../server');
  await request(app).post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex A', email: 'alex@a.test', password: 'hunter2',
  });

  const agent = await loggedInCustomer(app);
  const res = await agent.get('/welcome');
  assert.match(res.text, /href="\/blue-bottle\/order"/);
});

test('GET /welcome shows an empty state when there are no shops yet', async () => {
  const app = require('../../server');
  const agent = await loggedInCustomer(app);
  const res = await agent.get('/welcome');
  assert.equal(res.status, 200);
  assert.match(res.text, /No shops yet/);
});
