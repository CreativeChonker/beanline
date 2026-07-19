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

test('getShopById returns the shop including tagline and cover_photo_url', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const found = await shops.getShopById(db, shop.id);
  assert.equal(found.name, 'Blue Bottle');
  assert.equal(found.tagline, null);
  assert.equal(found.cover_photo_url, null);
});

test('getShopById returns null for an unknown id', async () => {
  const found = await shops.getShopById(db, 999999);
  assert.equal(found, null);
});

test('updateShopProfile sets tagline and cover_photo_url', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const updated = await shops.updateShopProfile(db, shop.id, { tagline: 'Cozy vibes', coverPhotoUrl: 'https://example.com/cover.jpg' });
  assert.equal(updated.tagline, 'Cozy vibes');
  assert.equal(updated.cover_photo_url, 'https://example.com/cover.jpg');
});

test('updateShopProfile with coverPhotoUrl null leaves the existing photo untouched', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  await shops.updateShopProfile(db, shop.id, { tagline: 'First', coverPhotoUrl: 'https://example.com/cover.jpg' });
  const updated = await shops.updateShopProfile(db, shop.id, { tagline: 'Second', coverPhotoUrl: null });
  assert.equal(updated.tagline, 'Second');
  assert.equal(updated.cover_photo_url, 'https://example.com/cover.jpg');
});

test('updateShopProfile can clear the tagline by passing null', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  await shops.updateShopProfile(db, shop.id, { tagline: 'First', coverPhotoUrl: null });
  const updated = await shops.updateShopProfile(db, shop.id, { tagline: null, coverPhotoUrl: null });
  assert.equal(updated.tagline, null);
});

test('getAllShops returns every shop ordered by name, including ones with no profile set', async () => {
  await shops.createShop(db, { name: 'Ritual', slug: 'ritual' });
  const blueBottle = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  await shops.updateShopProfile(db, blueBottle.id, { tagline: 'Cozy vibes', coverPhotoUrl: null });

  const all = await shops.getAllShops(db);
  assert.equal(all.length, 2);
  assert.equal(all[0].name, 'Blue Bottle');
  assert.equal(all[0].tagline, 'Cozy vibes');
  assert.equal(all[1].name, 'Ritual');
  assert.equal(all[1].tagline, null);
});

test('getShopById includes POS options defaulting to all-on and no category order', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const found = await shops.getShopById(db, shop.id);
  assert.equal(found.pos_show_size, true);
  assert.equal(found.pos_show_sugar, true);
  assert.equal(found.pos_show_temp, true);
  assert.equal(found.pos_show_note, true);
  assert.equal(found.category_order, null);
});

test('updatePosOptions turns individual fields off', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const updated = await shops.updatePosOptions(db, shop.id, {
    showSize: true, showSugar: false, showTemp: false, showNote: true,
  });
  assert.equal(updated.pos_show_size, true);
  assert.equal(updated.pos_show_sugar, false);
  assert.equal(updated.pos_show_temp, false);
  assert.equal(updated.pos_show_note, true);
});

test('updateCategoryOrder stores and returns the section ordering', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const updated = await shops.updateCategoryOrder(db, shop.id, ['Coffee', 'Tea', 'Food']);
  assert.deepEqual(updated.category_order, ['Coffee', 'Tea', 'Food']);
});
