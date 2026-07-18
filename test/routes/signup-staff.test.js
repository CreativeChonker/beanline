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

test('GET /signup/staff responds 200', async () => {
  const app = require('../../server');
  const res = await request(app).get('/signup/staff');
  assert.equal(res.status, 200);
});

test('POST /signup/staff with a valid invite code creates staff and redirects to /dashboard', async () => {
  const app = require('../../server');
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });

  const res = await request(app).post('/signup/staff').type('form').send({
    name: 'Jamie Staff',
    email: 'jamie@example.com',
    password: 'hunter2',
    inviteCode: shop.invite_code,
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');

  const userRow = await db.query('SELECT * FROM users WHERE email = $1', ['jamie@example.com']);
  assert.equal(userRow.rows[0].role, 'staff');
  assert.equal(userRow.rows[0].shop_id, shop.id);
});

test('POST /signup/staff with an invalid invite code re-renders with an error', async () => {
  const app = require('../../server');
  const res = await request(app).post('/signup/staff').type('form').send({
    name: 'Jamie Staff',
    email: 'jamie2@example.com',
    password: 'hunter2',
    inviteCode: 'not-a-real-code',
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /Invalid invite code/);

  const userRow = await db.query('SELECT * FROM users WHERE email = $1', ['jamie2@example.com']);
  assert.equal(userRow.rows.length, 0);
});

test('POST /signup/staff with missing fields re-renders with an error', async () => {
  const app = require('../../server');
  const res = await request(app).post('/signup/staff').type('form').send({ name: 'Jamie Staff' });
  assert.equal(res.status, 200);
  assert.match(res.text, /fill out all fields/);
});
