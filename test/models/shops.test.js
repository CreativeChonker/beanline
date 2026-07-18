// test/models/shops.test.js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
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

test('createShop creates a shop with a generated invite code', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  assert.equal(shop.name, 'Blue Bottle');
  assert.equal(shop.slug, 'blue-bottle');
  assert.ok(shop.invite_code.length > 0);
});

test('createShop rejects an invalid slug', async () => {
  await assert.rejects(
    () => shops.createShop(db, { name: 'Bad Shop', slug: 'Not A Slug!' }),
    /INVALID_SLUG/
  );
});

test('createShop rejects a duplicate slug', async () => {
  await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  await assert.rejects(
    () => shops.createShop(db, { name: 'Other Shop', slug: 'blue-bottle' }),
    (err) => err.code === '23505'
  );
});

test('getShopBySlug returns null for an unknown slug', async () => {
  const shop = await shops.getShopBySlug(db, 'does-not-exist');
  assert.equal(shop, null);
});

test('getShopBySlug returns the shop for a known slug', async () => {
  await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const shop = await shops.getShopBySlug(db, 'blue-bottle');
  assert.equal(shop.name, 'Blue Bottle');
});

test('getShopByInviteCode returns the matching shop', async () => {
  const created = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const shop = await shops.getShopByInviteCode(db, created.invite_code);
  assert.equal(shop.slug, 'blue-bottle');
});

test('getShopByInviteCode returns null for an unknown code', async () => {
  const shop = await shops.getShopByInviteCode(db, 'nonexistent-code');
  assert.equal(shop, null);
});
