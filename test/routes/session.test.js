// test/routes/session.test.js
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

test('session persists across requests via the session table', async () => {
  const app = require('../../server');
  const agent = request.agent(app);

  await agent.post('/signup').type('form').send({
    name: 'Sam Rivera',
    email: 'sam@example.com',
    password: 'hunter2',
  });

  const sessionRows = await db.query('SELECT count(*) FROM session');
  assert.ok(Number(sessionRows.rows[0].count) >= 1);

  const res = await agent.get('/welcome');
  assert.equal(res.status, 200);
});
