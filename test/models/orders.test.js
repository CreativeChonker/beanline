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

test('createOrder supports a POS sale: staffUserId set, userId omitted, custom status and payment method', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const staff = await users.createStaff(db, { name: 'Jamie Staff', email: 'jamie@example.com', password: 'hunter2', shopId: shop.id });
  const items = [{ name: 'Latte', qty: 1, price: 4.5 }];

  const order = await orders.createOrder(db, {
    staffUserId: staff.id,
    shopId: shop.id,
    items,
    total: 4.5,
    status: 'completed',
    paymentMethod: 'cash',
  });
  assert.ok(order.id > 0);

  const row = await db.query('SELECT user_id, staff_user_id, status, payment_method FROM orders WHERE id = $1', [order.id]);
  assert.equal(row.rows[0].user_id, null);
  assert.equal(row.rows[0].staff_user_id, staff.id);
  assert.equal(row.rows[0].status, 'completed');
  assert.equal(row.rows[0].payment_method, 'cash');
});

test('getOrdersForShop returns staff_name for POS sales and customer_name for self-orders in the same list', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const customer = await users.createCustomer(db, { name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  const staff = await users.createStaff(db, { name: 'Jamie Staff', email: 'jamie@example.com', password: 'hunter2', shopId: shop.id });

  await orders.createOrder(db, { userId: customer.id, shopId: shop.id, items: [{ name: 'Latte', qty: 1, price: 4.5 }], total: 4.5 });
  await orders.createOrder(db, { staffUserId: staff.id, shopId: shop.id, items: [{ name: 'Muffin', qty: 1, price: 3 }], total: 3, status: 'completed', paymentMethod: 'card' });

  const rows = await orders.getOrdersForShop(db, shop.id);
  assert.equal(rows.length, 2);
  const selfOrder = rows.find((r) => r.customer_name !== null);
  const posSale = rows.find((r) => r.staff_name !== null);
  assert.equal(selfOrder.customer_name, 'Sam Rivera');
  assert.equal(selfOrder.staff_name, null);
  assert.equal(posSale.staff_name, 'Jamie Staff');
  assert.equal(posSale.customer_name, null);
});

test('the database rejects an order with both user_id and staff_user_id set', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const customer = await users.createCustomer(db, { name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  const staff = await users.createStaff(db, { name: 'Jamie Staff', email: 'jamie@example.com', password: 'hunter2', shopId: shop.id });

  await assert.rejects(
    () => db.query(
      'INSERT INTO orders (user_id, staff_user_id, shop_id, items_json, total) VALUES ($1, $2, $3, $4, $5)',
      [customer.id, staff.id, shop.id, '[]', 1]
    ),
    (err) => err.code === '23514'
  );
});

test('the database rejects an order with neither user_id nor staff_user_id set', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });

  await assert.rejects(
    () => db.query(
      'INSERT INTO orders (user_id, staff_user_id, shop_id, items_json, total) VALUES ($1, $2, $3, $4, $5)',
      [null, null, shop.id, '[]', 1]
    ),
    (err) => err.code === '23514'
  );
});
