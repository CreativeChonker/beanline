const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, migrate, resetDb } = require('../../testHelpers/db');
const shops = require('../../models/shops');
const menuItems = require('../../models/menuItems');

before(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetDb();
});
after(async () => {
  await db.pool.end();
});

async function setupShop() {
  return shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
}

test('createMenuItem creates an item scoped to the shop, available by default', async () => {
  const shop = await setupShop();
  const item = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Latte', price: 4.5, category: 'Coffee', note: 'Steamed milk' });
  assert.equal(item.shop_id, shop.id);
  assert.equal(item.name, 'Latte');
  assert.equal(item.available, true);
  assert.equal(typeof item.price, 'number');
  assert.equal(item.price, 4.5);
});

test('getMenuItemsForShop returns only that shop\'s items, ordered by category then name', async () => {
  const shopA = await setupShop();
  const shopB = await shops.createShop(db, { name: 'Ritual', slug: 'ritual' });
  await menuItems.createMenuItem(db, { shopId: shopA.id, name: 'Muffin', price: 3.0, category: 'Bakery', note: '' });
  await menuItems.createMenuItem(db, { shopId: shopA.id, name: 'Latte', price: 4.5, category: 'Coffee', note: '' });
  await menuItems.createMenuItem(db, { shopId: shopB.id, name: 'Cortado', price: 4.0, category: 'Coffee', note: '' });

  const items = await menuItems.getMenuItemsForShop(db, shopA.id);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'Muffin');
  assert.equal(items[1].name, 'Latte');
});

test('getMenuItemsForShop with availableOnly excludes unavailable items', async () => {
  const shop = await setupShop();
  const item = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Latte', price: 4.5, category: 'Coffee', note: '' });
  await menuItems.toggleAvailability(db, shop.id, item.id);

  const allItems = await menuItems.getMenuItemsForShop(db, shop.id);
  const availableItems = await menuItems.getMenuItemsForShop(db, shop.id, { availableOnly: true });
  assert.equal(allItems.length, 1);
  assert.equal(availableItems.length, 0);
});

test('getMenuItemById returns null for an id belonging to a different shop', async () => {
  const shopA = await setupShop();
  const shopB = await shops.createShop(db, { name: 'Ritual', slug: 'ritual' });
  const item = await menuItems.createMenuItem(db, { shopId: shopA.id, name: 'Latte', price: 4.5, category: 'Coffee', note: '' });

  const found = await menuItems.getMenuItemById(db, shopA.id, item.id);
  const notFound = await menuItems.getMenuItemById(db, shopB.id, item.id);
  assert.equal(found.name, 'Latte');
  assert.equal(notFound, null);
});

test('updateMenuItem updates fields and returns null for a cross-shop id', async () => {
  const shopA = await setupShop();
  const shopB = await shops.createShop(db, { name: 'Ritual', slug: 'ritual' });
  const item = await menuItems.createMenuItem(db, { shopId: shopA.id, name: 'Latte', price: 4.5, category: 'Coffee', note: '' });

  const updated = await menuItems.updateMenuItem(db, shopA.id, item.id, { name: 'Iced Latte', price: 5.0, category: 'Cold Drinks', note: 'Over ice' });
  assert.equal(updated.name, 'Iced Latte');
  assert.equal(updated.price, 5.0);

  const crossShopAttempt = await menuItems.updateMenuItem(db, shopB.id, item.id, { name: 'Hacked', price: 0.01, category: 'x', note: '' });
  assert.equal(crossShopAttempt, null);
});

test('toggleAvailability flips the flag and returns null for a cross-shop id', async () => {
  const shopA = await setupShop();
  const shopB = await shops.createShop(db, { name: 'Ritual', slug: 'ritual' });
  const item = await menuItems.createMenuItem(db, { shopId: shopA.id, name: 'Latte', price: 4.5, category: 'Coffee', note: '' });

  const toggled = await menuItems.toggleAvailability(db, shopA.id, item.id);
  assert.equal(toggled.available, false);

  const crossShopAttempt = await menuItems.toggleAvailability(db, shopB.id, item.id);
  assert.equal(crossShopAttempt, null);
});

test('deleteMenuItem removes the row and returns false for a cross-shop id', async () => {
  const shopA = await setupShop();
  const shopB = await shops.createShop(db, { name: 'Ritual', slug: 'ritual' });
  const item = await menuItems.createMenuItem(db, { shopId: shopA.id, name: 'Latte', price: 4.5, category: 'Coffee', note: '' });

  const crossShopAttempt = await menuItems.deleteMenuItem(db, shopB.id, item.id);
  assert.equal(crossShopAttempt, false);

  const deleted = await menuItems.deleteMenuItem(db, shopA.id, item.id);
  assert.equal(deleted, true);
  const gone = await menuItems.getMenuItemById(db, shopA.id, item.id);
  assert.equal(gone, null);
});
