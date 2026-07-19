const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db, migrate, resetDb } = require('../../testHelpers/db');

before(async () => { await migrate(); });
beforeEach(async () => { await resetDb(); });
after(async () => { await db.pool.end(); });

async function ownerAgent(app) {
  const agent = request.agent(app);
  await agent.post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex Owner', email: 'alex@bb.test', password: 'hunter2',
  });
  return agent;
}

test('the sidebar shows the shop name, nav icons, and the user avatar on every app page', async () => {
  const app = require('../../server');
  const agent = await ownerAgent(app);
  for (const path of ['/dashboard', '/menu', '/pos', '/shop/settings']) {
    const res = await agent.get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.text, /class="app-shop-name">Blue Bottle</, path);
    assert.match(res.text, /class="app-avatar">A</, path);
    assert.match(res.text, /class="app-nav-icon"/, path);
  }
});

test('the sidebar has no Reports or Customers links', async () => {
  const app = require('../../server');
  const agent = await ownerAgent(app);
  const res = await agent.get('/dashboard');
  assert.doesNotMatch(res.text, />Reports</);
  assert.doesNotMatch(res.text, />Customers</);
});
