// test/smoke.test.js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db, migrate, resetDb } = require('../testHelpers/db');

before(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetDb();
});
after(async () => {
  await db.pool.end();
});

test('GET /login responds 200', async () => {
  const app = require('../server');
  const res = await request(app).get('/login');
  assert.equal(res.status, 200);
});
