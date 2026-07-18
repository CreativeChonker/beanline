// test/routes/shops.test.js
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

test('GET /shops/new responds 200', async () => {
  const app = require('../../server');
  const res = await request(app).get('/shops/new');
  assert.equal(res.status, 200);
});

test('POST /shops/new creates a shop and owner, logs in, redirects to /dashboard', async () => {
  const app = require('../../server');
  const res = await request(app).post('/shops/new').type('form').send({
    shopName: 'Blue Bottle',
    slug: 'blue-bottle',
    ownerName: 'Alex Owner',
    email: 'alex@bluebottle.test',
    password: 'hunter2',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');

  const shopRow = await db.query('SELECT * FROM shops WHERE slug = $1', ['blue-bottle']);
  assert.equal(shopRow.rows.length, 1);
  const userRow = await db.query('SELECT * FROM users WHERE email = $1', ['alex@bluebottle.test']);
  assert.equal(userRow.rows[0].role, 'owner');
  assert.equal(userRow.rows[0].shop_id, shopRow.rows[0].id);
});

test('POST /shops/new rejects an invalid slug with a re-rendered form', async () => {
  const app = require('../../server');
  const res = await request(app).post('/shops/new').type('form').send({
    shopName: 'Bad Shop',
    slug: 'Not A Slug!',
    ownerName: 'Alex Owner',
    email: 'alex2@bluebottle.test',
    password: 'hunter2',
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /lowercase letters, numbers, and hyphens/);
});

test('POST /shops/new rejects a duplicate slug', async () => {
  const app = require('../../server');
  await request(app).post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex Owner', email: 'alex3@bluebottle.test', password: 'hunter2',
  });
  const res = await request(app).post('/shops/new').type('form').send({
    shopName: 'Copycat', slug: 'blue-bottle', ownerName: 'Robin Copy', email: 'robin@copycat.test', password: 'hunter2',
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /already taken/);
});

test('POST /shops/new with missing fields re-renders the form with an error', async () => {
  const app = require('../../server');
  const res = await request(app).post('/shops/new').type('form').send({ shopName: 'Blue Bottle' });
  assert.equal(res.status, 200);
  assert.match(res.text, /fill out all fields/);
});

test('POST /shops/new seeds a starter menu for the new shop', async () => {
  const app = require('../../server');
  await request(app).post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex Owner', email: 'alex-seed@bluebottle.test', password: 'hunter2',
  });
  const shopRow = await db.query('SELECT id FROM shops WHERE slug = $1', ['blue-bottle']);
  const items = await db.query('SELECT * FROM menu_items WHERE shop_id = $1', [shopRow.rows[0].id]);
  assert.equal(items.rows.length, 6);
  assert.ok(items.rows.every((i) => i.available === true));
});
