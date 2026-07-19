const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db, migrate, resetDb } = require('../../testHelpers/db');
const shops = require('../../models/shops');
const menuItems = require('../../models/menuItems');

before(async () => { await migrate(); });
beforeEach(async () => { await resetDb(); });
after(async () => { await db.pool.end(); });

async function ownerAgent(app, slug = 'blue-bottle') {
  const agent = request.agent(app);
  await agent.post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug, ownerName: 'Alex Owner', email: `owner@${slug}.test`, password: 'hunter2',
  });
  return agent;
}

test('owner can save a new layout', async () => {
  const app = require('../../server');
  const agent = await ownerAgent(app);
  const shop = await db.query('SELECT id FROM shops WHERE slug = $1', ['blue-bottle']);
  const shopId = shop.rows[0].id;
  const a = await menuItems.createMenuItem(db, { shopId, name: 'Latte', price: 4.5, category: 'Coffee' });
  const b = await menuItems.createMenuItem(db, { shopId, name: 'Mocha', price: 5, category: 'Coffee' });

  const res = await agent.post('/pos/layout').send({
    categoryOrder: ['Signature', 'Coffee'],
    items: [
      { id: a.id, category: 'Signature', sortOrder: 0 },
      { id: b.id, category: 'Coffee', sortOrder: 0 },
    ],
  });
  assert.equal(res.status, 204);

  const shopRow = await shops.getShopById(db, shopId);
  assert.deepEqual(shopRow.category_order, ['Signature', 'Coffee']);
  const moved = await menuItems.getMenuItemById(db, shopId, a.id);
  assert.equal(moved.category, 'Signature');
});

test('staff cannot save a layout', async () => {
  const app = require('../../server');
  await ownerAgent(app);
  const shopRow = await db.query('SELECT invite_code FROM shops WHERE slug = $1', ['blue-bottle']);
  const staffAgent = request.agent(app);
  await staffAgent.post('/signup/staff').type('form').send({
    name: 'Jamie Staff', email: 'jamie@bluebottle.test', password: 'hunter2', inviteCode: shopRow.rows[0].invite_code,
  });
  const res = await staffAgent.post('/pos/layout').send({ categoryOrder: [], items: [] });
  assert.equal(res.status, 403);
});

test("a layout save cannot move another shop's items", async () => {
  const app = require('../../server');
  const agent = await ownerAgent(app);
  const other = await shops.createShop(db, { name: 'Other', slug: 'other-shop' });
  const foreign = await menuItems.createMenuItem(db, { shopId: other.id, name: 'Foreign', price: 9, category: 'X' });

  const res = await agent.post('/pos/layout').send({
    categoryOrder: [], items: [{ id: foreign.id, category: 'Stolen', sortOrder: 0 }],
  });
  assert.equal(res.status, 204);
  const untouched = await menuItems.getMenuItemById(db, other.id, foreign.id);
  assert.equal(untouched.category, 'X');
});

test('rejects malformed layout payloads', async () => {
  const app = require('../../server');
  const agent = await ownerAgent(app);
  const res = await agent.post('/pos/layout').send({ categoryOrder: 'nope', items: 'nope' });
  assert.equal(res.status, 400);
});
