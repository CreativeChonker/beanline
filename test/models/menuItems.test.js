const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, migrate, resetDb } = require('../../testHelpers/db');
const shops = require('../../models/shops');
const categories = require('../../models/categories');
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

async function setupShop(slug = 'blue-bottle', name = 'Blue Bottle') {
  const shop = await shops.createShop(db, { name, slug });
  const coffee = await categories.createCategory(db, {
    shopId: shop.id, name: 'Coffee', tierNames: ['Small', 'Medium', 'Large'], drinkOptions: true,
  });
  return { shop, coffee };
}

test('createMenuItem creates an item scoped to the shop, available by default', async () => {
  const { shop, coffee } = await setupShop();
  const item = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Latte', price: 4.5, categoryId: coffee.id, note: 'Steamed milk' });
  assert.equal(item.shop_id, shop.id);
  assert.equal(item.name, 'Latte');
  assert.equal(item.available, true);
  assert.equal(item.price, 4.5);
  assert.equal(item.category, 'Coffee');
  assert.deepEqual(item.tier_names, ['Small', 'Medium', 'Large']);
  assert.equal(item.drink_options, true);
});

test('getMenuItemsForShop returns only that shop\'s items, ordered by category display_order', async () => {
  const { shop, coffee } = await setupShop();
  const { shop: shopB, coffee: coffeeB } = await setupShop('ritual', 'Ritual');
  const bakery = await categories.createCategory(db, { shopId: shop.id, name: 'Bakery', displayOrder: -1 });
  await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Muffin', price: 3.0, categoryId: bakery.id });
  await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Latte', price: 4.5, categoryId: coffee.id });
  await menuItems.createMenuItem(db, { shopId: shopB.id, name: 'Cortado', price: 4.0, categoryId: coffeeB.id });

  const items = await menuItems.getMenuItemsForShop(db, shop.id);
  assert.deepEqual(items.map((i) => i.name), ['Muffin', 'Latte']);
});

test('getMenuItemsForShop with availableOnly excludes unavailable items and archived categories', async () => {
  const { shop, coffee } = await setupShop();
  const item = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Latte', price: 4.5, categoryId: coffee.id });
  await menuItems.toggleAvailability(db, shop.id, item.id);

  assert.equal((await menuItems.getMenuItemsForShop(db, shop.id)).length, 1);
  assert.equal((await menuItems.getMenuItemsForShop(db, shop.id, { availableOnly: true })).length, 0);

  await menuItems.toggleAvailability(db, shop.id, item.id);
  assert.equal((await menuItems.getMenuItemsForShop(db, shop.id, { availableOnly: true })).length, 1);
  await categories.updateCategory(db, shop.id, coffee.id, {
    name: 'Coffee', tierNames: coffee.tier_names, drinkOptions: true, showWhenEmpty: false, archived: true, displayOrder: 0,
  });
  assert.equal((await menuItems.getMenuItemsForShop(db, shop.id, { availableOnly: true })).length, 0);
});

test('getMenuItemById returns null for an id belonging to a different shop', async () => {
  const { shop, coffee } = await setupShop();
  const { shop: shopB } = await setupShop('ritual', 'Ritual');
  const item = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Latte', price: 4.5, categoryId: coffee.id });

  const found = await menuItems.getMenuItemById(db, shop.id, item.id);
  assert.equal(found.name, 'Latte');
  assert.equal(await menuItems.getMenuItemById(db, shopB.id, item.id), null);
});

test('updateMenuItem updates fields (including category) and returns null cross-shop', async () => {
  const { shop, coffee } = await setupShop();
  const { shop: shopB } = await setupShop('ritual', 'Ritual');
  const cold = await categories.createCategory(db, { shopId: shop.id, name: 'Cold Drinks' });
  const item = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Latte', price: 4.5, categoryId: coffee.id });

  const updated = await menuItems.updateMenuItem(db, shop.id, item.id, { name: 'Iced Latte', price: 5.0, categoryId: cold.id, note: 'Over ice' });
  assert.equal(updated.name, 'Iced Latte');
  assert.equal(updated.price, 5.0);
  assert.equal(updated.category, 'Cold Drinks');

  const crossShopAttempt = await menuItems.updateMenuItem(db, shopB.id, item.id, { name: 'Hacked', price: 0.01, categoryId: coffee.id, note: '' });
  assert.equal(crossShopAttempt, null);
});

test('toggleAvailability flips the flag and returns null for a cross-shop id', async () => {
  const { shop, coffee } = await setupShop();
  const { shop: shopB } = await setupShop('ritual', 'Ritual');
  const item = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Latte', price: 4.5, categoryId: coffee.id });

  const toggled = await menuItems.toggleAvailability(db, shop.id, item.id);
  assert.equal(toggled.available, false);
  assert.equal(await menuItems.toggleAvailability(db, shopB.id, item.id), null);
});

test('deleteMenuItem removes the row and returns false for a cross-shop id', async () => {
  const { shop, coffee } = await setupShop();
  const { shop: shopB } = await setupShop('ritual', 'Ritual');
  const item = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Latte', price: 4.5, categoryId: coffee.id });

  assert.equal(await menuItems.deleteMenuItem(db, shopB.id, item.id), false);
  assert.equal(await menuItems.deleteMenuItem(db, shop.id, item.id), true);
  assert.equal(await menuItems.getMenuItemById(db, shop.id, item.id), null);
});

test('createMenuItem defaults tier prices to null and sort_order 0', async () => {
  const { shop, coffee } = await setupShop();
  const item = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Latte', price: 4.5, categoryId: coffee.id });
  assert.equal(item.price_medium, null);
  assert.equal(item.price_large, null);
  assert.equal(item.sort_order, 0);
});

test('createMenuItem stores per-tier prices', async () => {
  const { shop, coffee } = await setupShop();
  const item = await menuItems.createMenuItem(db, {
    shopId: shop.id, name: 'Latte', price: 4.5, categoryId: coffee.id, priceMedium: 5.0, priceLarge: 5.5,
  });
  assert.equal(item.price_medium, 5.0);
  assert.equal(item.price_large, 5.5);
});

test('updateMenuItem updates tier prices and can clear one', async () => {
  const { shop, coffee } = await setupShop();
  const item = await menuItems.createMenuItem(db, {
    shopId: shop.id, name: 'Latte', price: 4.5, categoryId: coffee.id, priceMedium: 5.0, priceLarge: 5.5,
  });
  const updated = await menuItems.updateMenuItem(db, shop.id, item.id, {
    name: 'Latte', price: 4.5, categoryId: coffee.id, note: '', priceMedium: 5.25, priceLarge: null,
  });
  assert.equal(updated.price_medium, 5.25);
  assert.equal(updated.price_large, null);
});

test('getMenuItemsForShop orders by category then sort_order then name', async () => {
  const { shop, coffee } = await setupShop();
  const b = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'B-drink', price: 4, categoryId: coffee.id });
  const a = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'A-drink', price: 4, categoryId: coffee.id });
  await menuItems.updateLayout(db, shop.id, [
    { id: b.id, categoryId: coffee.id, sortOrder: 0 },
    { id: a.id, categoryId: coffee.id, sortOrder: 1 },
  ]);
  const items = await menuItems.getMenuItemsForShop(db, shop.id);
  assert.deepEqual(items.map((i) => i.name), ['B-drink', 'A-drink']);
});

test('updateLayout can move an item to another category but never across shops', async () => {
  const { shop, coffee } = await setupShop();
  const { shop: shopB, coffee: coffeeB } = await setupShop('shop-b', 'Shop B');
  const signature = await categories.createCategory(db, { shopId: shop.id, name: 'Signature' });
  const itemA = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Latte', price: 4, categoryId: coffee.id });
  const itemB = await menuItems.createMenuItem(db, { shopId: shopB.id, name: 'Mocha', price: 4, categoryId: coffeeB.id });

  const count = await menuItems.updateLayout(db, shop.id, [
    { id: itemA.id, categoryId: signature.id, sortOrder: 3 },
    { id: itemB.id, categoryId: signature.id, sortOrder: 0 }, // cross-shop item: refused
  ]);
  assert.equal(count, 1);

  const movedA = await menuItems.getMenuItemById(db, shop.id, itemA.id);
  assert.equal(movedA.category, 'Signature');
  assert.equal(movedA.sort_order, 3);
  const untouchedB = await menuItems.getMenuItemById(db, shopB.id, itemB.id);
  assert.equal(untouchedB.category, 'Coffee');

  // an item can't be assigned to a category from another shop either
  const crossCat = await menuItems.updateLayout(db, shopB.id, [
    { id: itemB.id, categoryId: signature.id, sortOrder: 0 },
  ]);
  assert.equal(crossCat, 0);
});

test('createMenuItem stores an image url and defaults to null', async () => {
  const { shop, coffee } = await setupShop();
  const plain = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Latte', price: 4.5, categoryId: coffee.id });
  assert.equal(plain.image_url, null);
  const pictured = await menuItems.createMenuItem(db, {
    shopId: shop.id, name: 'Mocha', price: 5, categoryId: coffee.id, imageUrl: 'http://img.test/mocha.jpg',
  });
  assert.equal(pictured.image_url, 'http://img.test/mocha.jpg');
});

test('setItemImage sets the photo, is shop-scoped, and updateMenuItem leaves it untouched', async () => {
  const { shop, coffee } = await setupShop();
  const { shop: shopB } = await setupShop('shop-b', 'Shop B');
  const item = await menuItems.createMenuItem(db, { shopId: shop.id, name: 'Latte', price: 4.5, categoryId: coffee.id });

  assert.equal(await menuItems.setItemImage(db, shopB.id, item.id, 'http://img.test/hacked.jpg'), null);

  const set = await menuItems.setItemImage(db, shop.id, item.id, 'http://img.test/latte.jpg');
  assert.equal(set.image_url, 'http://img.test/latte.jpg');

  const updated = await menuItems.updateMenuItem(db, shop.id, item.id, {
    name: 'Latte', price: 4.75, categoryId: coffee.id, note: '', priceMedium: null, priceLarge: null,
  });
  assert.equal(updated.image_url, 'http://img.test/latte.jpg');
});
