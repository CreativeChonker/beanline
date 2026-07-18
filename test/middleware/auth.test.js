// test/middleware/auth.test.js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, migrate, resetDb } = require('../../testHelpers/db');
const shops = require('../../models/shops');
const { requireAuth, requireRole, loadShopBySlug } = require('../../middleware/auth');

before(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetDb();
});
after(async () => {
  await db.pool.end();
});

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    redirectedTo: null,
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    redirect(url) { this.redirectedTo = url; return this; },
  };
}

test('requireAuth redirects to /login when no session user', () => {
  const req = { session: {} };
  const res = fakeRes();
  let nextCalled = false;
  requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(res.redirectedTo, '/login');
  assert.equal(nextCalled, false);
});

test('requireAuth calls next when session user exists', () => {
  const req = { session: { user: { id: 1 } } };
  const res = fakeRes();
  let nextCalled = false;
  requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('requireRole allows a listed role through', () => {
  const req = { session: { user: { role: 'owner' } } };
  const res = fakeRes();
  let nextCalled = false;
  requireRole('owner', 'staff')(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('requireRole rejects an unlisted role with 403', () => {
  const req = { session: { user: { role: 'customer' } } };
  const res = fakeRes();
  let nextCalled = false;
  requireRole('owner', 'staff')(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('loadShopBySlug sets req.shop for a known slug', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const req = { params: { shopSlug: 'blue-bottle' } };
  const res = fakeRes();
  let nextCalled = false;
  await loadShopBySlug(req, res, () => { nextCalled = true; });
  assert.equal(req.shop.id, shop.id);
  assert.equal(nextCalled, true);
});

test('loadShopBySlug responds 404 for an unknown slug', async () => {
  const req = { params: { shopSlug: 'does-not-exist' } };
  const res = fakeRes();
  let nextCalled = false;
  await loadShopBySlug(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 404);
  assert.equal(nextCalled, false);
});
