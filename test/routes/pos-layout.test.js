const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db, migrate, resetDb } = require('../../testHelpers/db');
const shops = require('../../models/shops');
const categories = require('../../models/categories');
const menuItems = require('../../models/menuItems');

before(async () => { await migrate(); });
beforeEach(async () => { await resetDb(); });
after(async () => { await db.pool.end(); });

async function ownerAgent(app, slug = 'blue-bottle') {
  const agent = request.agent(app);
  await agent.post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug, ownerName: 'Alex Owner', email: `owner@${slug}.test`, password: 'hunter2',
  });
  const shop = await db.query('SELECT id FROM shops WHERE slug = $1', [slug]);
  return { agent, shopId: shop.rows[0].id };
}

async function catId(shopId, name) {
  const row = await db.query('SELECT id FROM categories WHERE shop_id = $1 AND name = $2', [shopId, name]);
  return row.rows[0].id;
}

test('owner can save a new layout, reordering categories and moving items', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgent(app);
  const coffee = await catId(shopId, 'Coffee');
  const pastry = await catId(shopId, 'Pastry');
  const a = await menuItems.createMenuItem(db, { shopId, name: 'Cortado', price: 4.5, categoryId: coffee });

  const res = await agent.post('/pos/layout').send({
    categoryOrder: [pastry, coffee],
    items: [{ id: a.id, categoryId: pastry, sortOrder: 0 }],
  });
  assert.equal(res.status, 204);

  const cats = await categories.getCategoriesForShop(db, shopId);
  assert.deepEqual(cats.map((c) => c.name), ['Pastry', 'Coffee']);
  const moved = await menuItems.getMenuItemById(db, shopId, a.id);
  assert.equal(moved.category, 'Pastry');
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

test("a layout save cannot move another shop's items or use its categories", async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgent(app);
  const other = await shops.createShop(db, { name: 'Other', slug: 'other-shop' });
  const otherCat = await categories.createCategory(db, { shopId: other.id, name: 'X' });
  const foreign = await menuItems.createMenuItem(db, { shopId: other.id, name: 'Foreign', price: 9, categoryId: otherCat.id });
  const ownCoffee = await catId(shopId, 'Coffee');

  const res = await agent.post('/pos/layout').send({
    categoryOrder: [],
    items: [
      { id: foreign.id, categoryId: ownCoffee, sortOrder: 0 },
      { id: foreign.id, categoryId: otherCat.id, sortOrder: 0 },
    ],
  });
  assert.equal(res.status, 204);
  const untouched = await menuItems.getMenuItemById(db, other.id, foreign.id);
  assert.equal(untouched.category, 'X');

  // reordering someone else's category ids is a no-op
  await agent.post('/pos/layout').send({ categoryOrder: [otherCat.id], items: [] });
  const otherCats = await categories.getCategoriesForShop(db, other.id);
  assert.equal(otherCats[0].display_order, 0);
});

test('rejects malformed layout payloads', async () => {
  const app = require('../../server');
  const { agent } = await ownerAgent(app);
  const res = await agent.post('/pos/layout').send({ categoryOrder: 'nope', items: 'nope' });
  assert.equal(res.status, 400);
  const res2 = await agent.post('/pos/layout').send({ categoryOrder: ['Coffee'], items: [] });
  assert.equal(res2.status, 400);
});

test('rejects a layout with an out-of-range sortOrder', async () => {
  const app = require('../../server');
  const { agent, shopId } = await ownerAgent(app);
  const coffee = await catId(shopId, 'Coffee');
  const a = await menuItems.createMenuItem(db, { shopId, name: 'Cortado', price: 4.5, categoryId: coffee });

  const res = await agent.post('/pos/layout').send({
    categoryOrder: [coffee],
    items: [{ id: a.id, categoryId: coffee, sortOrder: 1e15 }],
  });
  assert.equal(res.status, 400);
});
