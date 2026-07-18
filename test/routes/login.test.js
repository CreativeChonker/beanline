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

test('customer login redirects to /welcome', async () => {
  const app = require('../../server');
  await request(app).post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  const res = await request(app).post('/login').type('form').send({ email: 'sam@example.com', password: 'hunter2' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/welcome');
});

test('owner login redirects to /dashboard', async () => {
  const app = require('../../server');
  await request(app).post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex Owner', email: 'alex@bluebottle.test', password: 'hunter2',
  });
  const res = await request(app).post('/login').type('form').send({ email: 'alex@bluebottle.test', password: 'hunter2' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');
});

test('login with wrong password re-renders with an error', async () => {
  const app = require('../../server');
  await request(app).post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  const res = await request(app).post('/login').type('form').send({ email: 'sam@example.com', password: 'wrong' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Invalid email or password/);
});

test('GET /welcome requires auth', async () => {
  const app = require('../../server');
  const res = await request(app).get('/welcome');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('logged-in customer can view /welcome', async () => {
  const app = require('../../server');
  const agent = request.agent(app);
  await agent.post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  const res = await agent.get('/welcome');
  assert.equal(res.status, 200);
});
