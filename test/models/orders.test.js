const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, migrate, resetDb } = require('../../testHelpers/db');
const shops = require('../../models/shops');
const users = require('../../models/users');
const orders = require('../../models/orders');

before(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetDb();
});
after(async () => {
  await db.pool.end();
});

async function setupShopAndCustomer() {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const customer = await users.createCustomer(db, { name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  return { shop, customer };
}

test('createOrder stores items as JSON and returns id + created_at', async () => {
  const { shop, customer } = await setupShopAndCustomer();
  const items = [{ name: 'Latte', qty: 2, price: 4.5 }];
  const order = await orders.createOrder(db, { userId: customer.id, shopId: shop.id, items, total: 9.0 });
  assert.ok(order.id > 0);
  assert.ok(order.created_at);
});

test('getOrdersForShop returns only that shop\'s orders, newest first', async () => {
  const { shop, customer } = await setupShopAndCustomer();
  const otherShop = await shops.createShop(db, { name: 'Ritual', slug: 'ritual' });

  await orders.createOrder(db, { userId: customer.id, shopId: shop.id, items: [{ name: 'Drip', qty: 1, price: 3 }], total: 3 });
  await orders.createOrder(db, { userId: customer.id, shopId: shop.id, items: [{ name: 'Cortado', qty: 1, price: 4 }], total: 4 });
  await orders.createOrder(db, { userId: customer.id, shopId: otherShop.id, items: [{ name: 'Mocha', qty: 1, price: 5 }], total: 5 });

  const shopOrders = await orders.getOrdersForShop(db, shop.id);
  assert.equal(shopOrders.length, 2);
  assert.equal(shopOrders[0].items[0].name, 'Cortado');
  assert.equal(shopOrders[1].items[0].name, 'Drip');
  assert.equal(shopOrders[0].customer_name, 'Sam Rivera');
});

test('getOrdersForShop returns an empty array when the shop has no orders', async () => {
  const { shop } = await setupShopAndCustomer();
  const shopOrders = await orders.getOrdersForShop(db, shop.id);
  assert.deepEqual(shopOrders, []);
});
