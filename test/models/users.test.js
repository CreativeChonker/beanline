// test/models/users.test.js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, migrate, resetDb } = require('../../testHelpers/db');
const shops = require('../../models/shops');
const users = require('../../models/users');

before(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetDb();
});
after(async () => {
  await db.pool.end();
});

test('createCustomer creates a customer with no shop_id', async () => {
  const user = await users.createCustomer(db, { name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  assert.equal(user.role, 'customer');
  assert.equal(user.shop_id, null);
  assert.equal(user.password_hash, undefined);
});

test('createOwner creates an owner scoped to a shop', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const user = await users.createOwner(db, { name: 'Alex Owner', email: 'alex@example.com', password: 'hunter2', shopId: shop.id });
  assert.equal(user.role, 'owner');
  assert.equal(user.shop_id, shop.id);
});

test('createStaff creates a staff account scoped to a shop', async () => {
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const user = await users.createStaff(db, { name: 'Jamie Staff', email: 'jamie@example.com', password: 'hunter2', shopId: shop.id });
  assert.equal(user.role, 'staff');
  assert.equal(user.shop_id, shop.id);
});

test('createCustomer rejects a duplicate email', async () => {
  await users.createCustomer(db, { name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  await assert.rejects(
    () => users.createCustomer(db, { name: 'Other Sam', email: 'sam@example.com', password: 'hunter2' }),
    (err) => err.code === '23505'
  );
});

test('getUserByEmail returns the full row including password_hash', async () => {
  await users.createCustomer(db, { name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  const user = await users.getUserByEmail(db, 'sam@example.com');
  assert.equal(user.email, 'sam@example.com');
  assert.ok(user.password_hash.length > 0);
});

test('getUserByEmail returns null for an unknown email', async () => {
  const user = await users.getUserByEmail(db, 'nobody@example.com');
  assert.equal(user, null);
});
