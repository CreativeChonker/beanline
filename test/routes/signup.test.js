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

test('GET /signup responds 200 and has no role picker', async () => {
  const app = require('../../server');
  const res = await request(app).get('/signup');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /name="role"/);
});

test('POST /signup creates a customer with no shop_id and redirects to /welcome', async () => {
  const app = require('../../server');
  const res = await request(app).post('/signup').type('form').send({
    name: 'Sam Rivera',
    email: 'sam@example.com',
    password: 'hunter2',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/welcome');

  const userRow = await db.query('SELECT * FROM users WHERE email = $1', ['sam@example.com']);
  assert.equal(userRow.rows[0].role, 'customer');
  assert.equal(userRow.rows[0].shop_id, null);
});

test('POST /signup rejects a duplicate email', async () => {
  const app = require('../../server');
  await request(app).post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  const res = await request(app).post('/signup').type('form').send({ name: 'Other Sam', email: 'sam@example.com', password: 'hunter2' });
  assert.equal(res.status, 200);
  assert.match(res.text, /already exists/);
});

test('POST /signup with missing fields re-renders with an error', async () => {
  const app = require('../../server');
  const res = await request(app).post('/signup').type('form').send({ name: 'Sam Rivera' });
  assert.equal(res.status, 200);
  assert.match(res.text, /fill out all fields/);
});
