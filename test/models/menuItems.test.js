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

test('createMenuItem defaults to drink with no size prices and sort_order 0', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const item = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Latte', price: 4.5, category: 'Coffee' });
  assert.equal(item.item_type, 'drink');
  assert.equal(item.price_medium, null);
  assert.equal(item.price_large, null);
  assert.equal(item.sort_order, 0);
});

test('createMenuItem stores item type and per-size prices', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const item = await menuItems.createMenuItem(db, {
    shopId: shop.id, name: 'Latte', price: 4.5, category: 'Coffee',
    itemType: 'drink', priceMedium: 5.0, priceLarge: 5.5,
  });
  assert.equal(item.price_medium, 5.0);
  assert.equal(item.price_large, 5.5);

  const food = await menuItems.createMenuItem(db, {
    shopId: shop.id, name: 'Croissant', price: 3.0, category: 'Food', itemType: 'food',
  });
  assert.equal(food.item_type, 'food');
});

test('updateMenuItem updates type and size prices, and can clear a size', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const item = await menuItems.createMenuItem(db, {
    shopId: shop.id, name: 'Latte', price: 4.5, category: 'Coffee', priceMedium: 5.0, priceLarge: 5.5,
  });
  const updated = await menuItems.updateMenuItem(db, shop.id, item.id, {
    name: 'Latte', price: 4.5, category: 'Coffee', note: '',
    itemType: 'drink', priceMedium: 5.25, priceLarge: null,
  });
  assert.equal(updated.price_medium, 5.25);
  assert.equal(updated.price_large, null);
});

test('getMenuItemsForShop orders by category then sort_order then name', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const b = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'B-drink', price: 4, category: 'Coffee' });
  const a = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'A-drink', price: 4, category: 'Coffee' });
  await menuItems.updateLayout(db, shop.id, [
    { id: b.id, category: 'Coffee', sortOrder: 0 },
    { id: a.id, category: 'Coffee', sortOrder: 1 },
  ]);
  const items = await menuItems.getMenuItemsForShop(db, shop.id);
  assert.deepEqual(items.map((i) => i.name), ['B-drink', 'A-drink']);
});

test('updateLayout can move an item to another category and never touches another shop', async () => {
  const shopA = await shops.createShop(db, { name: 'Shop A', slug: 'shop-a' });
  const shopB = await shops.createShop(db, { name: 'Shop B', slug: 'shop-b' });
  const itemA = await menuItems.createMenuItem(db, { shopId: shopA.id, name: 'Latte', price: 4, category: 'Coffee' });
  const itemB = await menuItems.createMenuItem(db, { shopId: shopB.id, name: 'Mocha', price: 4, category: 'Coffee' });

  const count = await menuItems.updateLayout(db, shopA.id, [
    { id: itemA.id, category: 'Signature', sortOrder: 3 },
    { id: itemB.id, category: 'Hacked', sortOrder: 0 },
  ]);
  assert.equal(count, 1);

  const movedA = await menuItems.getMenuItemById(db, shopA.id, itemA.id);
  assert.equal(movedA.category, 'Signature');
  assert.equal(movedA.sort_order, 3);
  const untouchedB = await menuItems.getMenuItemById(db, shopB.id, itemB.id);
  assert.equal(untouchedB.category, 'Coffee');
});
