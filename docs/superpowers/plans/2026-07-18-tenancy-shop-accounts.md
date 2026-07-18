# Tenancy & Shop Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-shop coffee shop prototype into a multi-tenant foundation: shops as the tenant boundary, owner/staff/customer roles, shop-scoped orders, and slug-based customer routing — on Postgres instead of SQLite.

**Architecture:** Express + EJS stays as-is. Swap `better-sqlite3` for `pg` (raw SQL, no ORM) against a local Docker Postgres for dev/test and Neon for production later. Add a `models/` layer (shops, users, orders) that all routes go through, and a `middleware/auth.js` that enforces the one hard invariant: every staff-side query is scoped by `session.user.shopId`, never by client input.

**Tech Stack:** Node.js, Express, EJS, `pg`, `connect-pg-simple`, `bcrypt` (existing), `node:test` + `node:assert/strict` (built-in test runner) + `supertest` for HTTP-level tests, Docker Compose for local Postgres.

## Global Constraints

- Shop slug format: `^[a-z0-9-]+$` (lowercase letters, digits, hyphens only).
- `users.role` is one of `'owner' | 'staff' | 'customer'`; `shop_id` is `NULL` iff `role = 'customer'` — enforced by a database `CHECK` constraint, not just application code.
- Staff-side queries never take `shop_id` from a route param, query string, or form field — only from `session.user.shopId`.
- No ORM — raw SQL via the `pg` driver, matching the existing codebase's lightweight style.
- Fresh start: no migration of existing SQLite data. `data.db` and the old `better-sqlite3` dependency are retired.
- `menu.js` stays a single shared static file for all shops (menu management is a separate future sub-project) — do not add a `menu_items` table or per-shop menu logic here.
- Every new piece of logic (models, middleware, routes) gets a test before being wired into `server.js`.

---

## Task 1: Local Postgres via Docker Compose + environment config

**Files:**
- Create: `docker-compose.yml`
- Create: `db/init/01-create-databases.sql`
- Create: `.env.example`
- Modify: `.env` (add new variables locally — this file is gitignored, do not commit it)

**Interfaces:**
- Produces: a running Postgres server on `localhost:5432` with two databases, `coffee_shop_dev` and `coffee_shop_test`, both reachable via connection strings that later tasks read from `process.env.DATABASE_URL` / `process.env.TEST_DATABASE_URL`.

- [ ] **Step 1: Write the Docker Compose file**

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: postgres
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./db/init:/docker-entrypoint-initdb.d
volumes:
  pgdata:
```

- [ ] **Step 2: Write the database init script**

```sql
-- db/init/01-create-databases.sql
CREATE DATABASE coffee_shop_dev;
CREATE DATABASE coffee_shop_test;
```

- [ ] **Step 3: Start Postgres and verify both databases exist**

Run: `docker compose up -d`
Then run: `docker compose exec postgres psql -U postgres -c "\l"`
Expected: output lists `coffee_shop_dev` and `coffee_shop_test` alongside the default `postgres` database.

(If a `coffee_shop_dev`/`coffee_shop_test` don't appear because a stale volume already existed, run `docker compose down -v` then `docker compose up -d` again — the init script only runs on first volume creation.)

- [ ] **Step 4: Write `.env.example`**

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/coffee_shop_dev
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/coffee_shop_test
SESSION_SECRET=change-me
N8N_WEBHOOK_URL=
PORT=3000
```

- [ ] **Step 5: Add the same variables to your local `.env`**

Open `.env` and make sure it contains `DATABASE_URL` and `TEST_DATABASE_URL` pointing at the two databases above, alongside the existing `SESSION_SECRET`/`N8N_WEBHOOK_URL`/`PORT` entries. `.env` is gitignored — this step edits your local copy only.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml db/init/01-create-databases.sql .env.example
git commit -m "chore: add local Postgres via Docker Compose"
```

---

## Task 2: Database schema, migration script, and pg connection wrapper

**Files:**
- Create: `db/schema.sql`
- Create: `db/migrate.js`
- Modify: `db.js` (full rewrite, `better-sqlite3` → `pg`)
- Modify: `package.json` (remove `better-sqlite3`, add `pg`, add `migrate` script)

**Interfaces:**
- Consumes: `DATABASE_URL` from `process.env` (Task 1).
- Produces: `db.js` exports `{ query(text, params), pool, withTransaction(fn) }`. Every later task's models and middleware import this module as `db` and call `db.query(...)` or `db.withTransaction(async (client) => { ...client.query(...)... })`.

- [ ] **Step 1: Write the schema**

```sql
-- db/schema.sql
CREATE TABLE IF NOT EXISTS shops (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  invite_code TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'customer')),
  shop_id INTEGER REFERENCES shops(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shop_id_matches_role CHECK (
    (role = 'customer' AND shop_id IS NULL) OR
    (role IN ('owner', 'staff') AND shop_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  items_json TEXT NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_shop_id_idx ON orders(shop_id);
CREATE INDEX IF NOT EXISTS users_shop_id_idx ON users(shop_id);
```

- [ ] **Step 2: Write the migration runner**

```js
// db/migrate.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.end();
  console.log('Migration complete.');
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Rewrite `db.js`**

```js
// db.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  withTransaction,
};
```

- [ ] **Step 4: Swap dependencies**

```bash
npm uninstall better-sqlite3
npm install pg
```

- [ ] **Step 5: Add the migrate script to `package.json`**

In the `"scripts"` block, add:

```json
"migrate": "node db/migrate.js"
```

- [ ] **Step 6: Run the migration against the dev database and verify**

Run: `npm run migrate`
Expected: prints `Migration complete.` with no errors.

Then run: `docker compose exec postgres psql -U postgres -d coffee_shop_dev -c "\dt"`
Expected: lists `shops`, `users`, `orders`.

- [ ] **Step 7: Commit**

```bash
git add db/schema.sql db/migrate.js db.js package.json package-lock.json
git commit -m "feat: switch database layer from SQLite to Postgres"
```

---

## Task 3: Test infrastructure

**Files:**
- Create: `testHelpers/setup.js`
- Create: `testHelpers/db.js`
- Modify: `package.json` (add `supertest` devDependency, add `test` script)
- Modify: `server.js:155-157` (guard `app.listen` behind `require.main === module`, export `app`)

**Interfaces:**
- Consumes: `db.js` (Task 2) — `db.query`, `db.pool`.
- Produces: `testHelpers/db.js` exports `{ db, migrate(), resetDb() }`, used by every test file in Tasks 4-15. `server.js` exports the Express `app` for `supertest` to wrap, used by every route test in Tasks 9-15.

- [ ] **Step 1: Write the env-override preload script**

```js
// testHelpers/setup.js
require('dotenv').config();
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
```

- [ ] **Step 2: Write the test DB helper**

```js
// testHelpers/db.js
const fs = require('fs');
const path = require('path');
const db = require('../db');

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  await db.query(schema);
}

async function resetDb() {
  await db.query('TRUNCATE orders, users, shops RESTART IDENTITY CASCADE');
}

module.exports = { db, migrate, resetDb };
```

- [ ] **Step 3: Install supertest and add the test script**

```bash
npm install --save-dev supertest
```

In `package.json` `"scripts"`, add:

```json
"test": "node --require ./testHelpers/setup.js --test"
```

- [ ] **Step 4: Guard `app.listen` and export `app` in `server.js`**

Find the current end of `server.js`:

```js
app.listen(PORT, () => {
  console.log(`Coffee shop app running at http://localhost:${PORT}`);
});
```

Replace with:

```js
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Coffee shop app running at http://localhost:${PORT}`);
  });
}

module.exports = app;
```

- [ ] **Step 5: Write a smoke test to verify the harness works end-to-end**

```js
// test/smoke.test.js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db, migrate, resetDb } = require('../testHelpers/db');

before(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetDb();
});
after(async () => {
  await db.pool.end();
});

test('GET /login responds 200', async () => {
  const app = require('../server');
  const res = await request(app).get('/login');
  assert.equal(res.status, 200);
});
```

- [ ] **Step 6: Run the test and verify it passes**

Run: `npm test`
Expected: `# pass 1`, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add testHelpers test/smoke.test.js server.js package.json package-lock.json
git commit -m "test: add node:test + supertest harness against real Postgres"
```

---

## Task 4: Shops model

**Files:**
- Create: `models/shops.js`
- Test: `test/models/shops.test.js`

**Interfaces:**
- Consumes: any object with `.query(text, params)` — either `db` (Task 2) or a transaction `client` from `db.withTransaction`.
- Produces: `createShop(queryable, { name, slug }) → { id, name, slug, invite_code }` (throws `Error('INVALID_SLUG')` for a bad slug, retries once internally on invite-code collision, rethrows on slug/email collision), `getShopBySlug(queryable, slug) → shop | null`, `getShopByInviteCode(queryable, inviteCode) → shop | null`, and the exported `SLUG_RE` regex. Consumed by Task 7 (middleware), Task 9 (shop creation route), Task 10 (staff join route), Task 13 (order routes).

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../models/shops'`.

- [ ] **Step 3: Write the implementation**

```js
// models/shops.js
const crypto = require('crypto');

const SLUG_RE = /^[a-z0-9-]+$/;

function generateInviteCode() {
  return crypto.randomBytes(6).toString('hex');
}

async function createShop(queryable, { name, slug }, attempt = 0) {
  if (!SLUG_RE.test(slug)) {
    throw new Error('INVALID_SLUG');
  }
  const inviteCode = generateInviteCode();
  try {
    const result = await queryable.query(
      'INSERT INTO shops (name, slug, invite_code) VALUES ($1, $2, $3) RETURNING id, name, slug, invite_code',
      [name, slug, inviteCode]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'shops_invite_code_key' && attempt < 3) {
      return createShop(queryable, { name, slug }, attempt + 1);
    }
    throw err;
  }
}

async function getShopBySlug(queryable, slug) {
  const result = await queryable.query('SELECT id, name, slug, invite_code FROM shops WHERE slug = $1', [slug]);
  return result.rows[0] || null;
}

async function getShopByInviteCode(queryable, inviteCode) {
  const result = await queryable.query('SELECT id, name, slug, invite_code FROM shops WHERE invite_code = $1', [inviteCode]);
  return result.rows[0] || null;
}

module.exports = { createShop, getShopBySlug, getShopByInviteCode, SLUG_RE };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all 7 tests in `shops.test.js` pass (plus the smoke test from Task 3).

- [ ] **Step 5: Commit**

```bash
git add models/shops.js test/models/shops.test.js
git commit -m "feat: add shops model"
```

---

## Task 5: Users model

**Files:**
- Create: `models/users.js`
- Test: `test/models/users.test.js`

**Interfaces:**
- Consumes: `bcrypt` (existing dependency), any `.query`-shaped queryable.
- Produces: `createOwner(queryable, { name, email, password, shopId }) → user`, `createStaff(queryable, { name, email, password, shopId }) → user`, `createCustomer(queryable, { name, email, password }) → user`, `getUserByEmail(queryable, email) → userWithHash | null`. Every returned `user` (except `getUserByEmail`) has shape `{ id, name, email, role, shop_id }` — no `password_hash`. Consumed by Tasks 9-12 (auth routes).

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../models/users'`.

- [ ] **Step 3: Write the implementation**

```js
// models/users.js
const bcrypt = require('bcrypt');

async function createUser(queryable, { name, email, password, role, shopId }) {
  const passwordHash = bcrypt.hashSync(password, 10);
  const result = await queryable.query(
    'INSERT INTO users (name, email, password_hash, role, shop_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, role, shop_id',
    [name, email, passwordHash, role, shopId ?? null]
  );
  return result.rows[0];
}

function createOwner(queryable, { name, email, password, shopId }) {
  return createUser(queryable, { name, email, password, role: 'owner', shopId });
}

function createStaff(queryable, { name, email, password, shopId }) {
  return createUser(queryable, { name, email, password, role: 'staff', shopId });
}

function createCustomer(queryable, { name, email, password }) {
  return createUser(queryable, { name, email, password, role: 'customer', shopId: null });
}

async function getUserByEmail(queryable, email) {
  const result = await queryable.query('SELECT * FROM users WHERE email = $1', [email]);
  return result.rows[0] || null;
}

module.exports = { createOwner, createStaff, createCustomer, getUserByEmail };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all 6 tests in `users.test.js` pass.

- [ ] **Step 5: Commit**

```bash
git add models/users.js test/models/users.test.js
git commit -m "feat: add users model with owner/staff/customer creation"
```

---

## Task 6: Orders model

**Files:**
- Create: `models/orders.js`
- Test: `test/models/orders.test.js`

**Interfaces:**
- Consumes: `.query`-shaped queryable.
- Produces: `createOrder(queryable, { userId, shopId, items, total }) → { id, created_at }`, `getOrdersForShop(queryable, shopId) → order[]` where each order has `{ id, items, total, status, created_at, customer_name, customer_email }` (`items` is the parsed array, not the raw JSON string). Consumed by Task 13 (order routes) and Task 14 (dashboard route).

- [ ] **Step 1: Write the failing tests**

```js
// test/models/orders.test.js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../models/orders'`.

- [ ] **Step 3: Write the implementation**

```js
// models/orders.js
async function createOrder(queryable, { userId, shopId, items, total }) {
  const result = await queryable.query(
    'INSERT INTO orders (user_id, shop_id, items_json, total) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
    [userId, shopId, JSON.stringify(items), total]
  );
  return result.rows[0];
}

async function getOrdersForShop(queryable, shopId) {
  const result = await queryable.query(
    `SELECT orders.id, orders.items_json, orders.total, orders.status, orders.created_at,
            users.name AS customer_name, users.email AS customer_email
     FROM orders
     JOIN users ON users.id = orders.user_id
     WHERE orders.shop_id = $1
     ORDER BY orders.created_at DESC`,
    [shopId]
  );
  return result.rows.map((o) => ({ ...o, items: JSON.parse(o.items_json) }));
}

module.exports = { createOrder, getOrdersForShop };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all 3 tests in `orders.test.js` pass.

- [ ] **Step 5: Commit**

```bash
git add models/orders.js test/models/orders.test.js
git commit -m "feat: add shop-scoped orders model"
```

---

## Task 7: Auth middleware

**Files:**
- Create: `middleware/auth.js`
- Test: `test/middleware/auth.test.js`

**Interfaces:**
- Consumes: `models/shops.js` (`getShopBySlug`), `db.js`.
- Produces: `requireAuth(req, res, next)`, `requireRole(...roles)(req, res, next)`, `loadShopBySlug(req, res, next)` (reads `req.params.shopSlug`, sets `req.shop`, 404s if not found). Consumed by every route task (9-14).

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../middleware/auth'`.

- [ ] **Step 3: Write the implementation**

```js
// middleware/auth.js
const db = require('../db');
const shops = require('../models/shops');

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).send('Forbidden: this page requires a ' + roles.join(' or ') + ' account.');
    }
    next();
  };
}

async function loadShopBySlug(req, res, next) {
  try {
    const shop = await shops.getShopBySlug(db, req.params.shopSlug);
    if (!shop) return res.status(404).send('Shop not found.');
    req.shop = shop;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth, requireRole, loadShopBySlug };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all 6 tests in `auth.test.js` pass.

- [ ] **Step 5: Commit**

```bash
git add middleware/auth.js test/middleware/auth.test.js
git commit -m "feat: add auth middleware with multi-role support and shop-by-slug loading"
```

---

## Task 8: Session store swap to Postgres

**Files:**
- Modify: `server.js:1-21` (session config)
- Modify: `package.json` (add `connect-pg-simple`)
- Test: `test/routes/session.test.js`

**Interfaces:**
- Consumes: `db.pool` (Task 2).
- Produces: sessions persisted in a `session` table in Postgres instead of in-memory, so they survive process restarts and work with more than one server instance.

- [ ] **Step 1: Write the failing test**

```js
// test/routes/session.test.js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db, migrate, resetDb } = require('../../testHelpers/db');

before(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetDb();
});
after(async () => {
  await db.pool.end();
});

test('session persists across requests via the session table', async () => {
  const app = require('../../server');
  const agent = request.agent(app);

  await agent.post('/signup').type('form').send({
    name: 'Sam Rivera',
    email: 'sam@example.com',
    password: 'hunter2',
  });

  const sessionRows = await db.query('SELECT count(*) FROM session');
  assert.ok(Number(sessionRows.rows[0].count) >= 1);

  const res = await agent.get('/welcome');
  assert.equal(res.status, 200);
});
```

(This test depends on `/signup` and `/welcome` existing — implemented in Tasks 11-12. If run before those tasks, it will fail on `res.status` not the session table check. That's expected; this test is here to lock in session behavior once those routes exist. Skip running it standalone until after Task 12, or run the full suite at the end of Task 12 to confirm it passes.)

- [ ] **Step 2: Install `connect-pg-simple`**

```bash
npm install connect-pg-simple
```

- [ ] **Step 3: Update the session config in `server.js`**

Find:

```js
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 },
  })
);
```

Replace with:

```js
const pgSession = require('connect-pg-simple')(session);

app.use(
  session({
    store: new pgSession({ pool: db.pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 },
  })
);
```

- [ ] **Step 4: Run the smoke test to confirm the app still boots correctly**

Run: `npm test`
Expected: `smoke.test.js` still passes (the `session.test.js` test above will only fully pass after Task 12 — that's expected here).

- [ ] **Step 5: Commit**

```bash
git add server.js package.json package-lock.json test/routes/session.test.js
git commit -m "feat: store sessions in Postgres via connect-pg-simple"
```

---

## Task 9: Shop creation flow

**Files:**
- Create: `views/shop-new.ejs`
- Modify: `server.js` (add `GET/POST /shops/new`)
- Test: `test/routes/shops.test.js`

**Interfaces:**
- Consumes: `models/shops.js`, `models/users.js`, `db.withTransaction`.
- Produces: a working shop-signup flow. `session.user` shape from here on: `{ id, name, email, role, shopId }`.

- [ ] **Step 1: Write the failing tests**

```js
// test/routes/shops.test.js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db, migrate, resetDb } = require('../../testHelpers/db');

before(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetDb();
});
after(async () => {
  await db.pool.end();
});

test('GET /shops/new responds 200', async () => {
  const app = require('../../server');
  const res = await request(app).get('/shops/new');
  assert.equal(res.status, 200);
});

test('POST /shops/new creates a shop and owner, logs in, redirects to /dashboard', async () => {
  const app = require('../../server');
  const res = await request(app).post('/shops/new').type('form').send({
    shopName: 'Blue Bottle',
    slug: 'blue-bottle',
    ownerName: 'Alex Owner',
    email: 'alex@bluebottle.test',
    password: 'hunter2',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');

  const shopRow = await db.query('SELECT * FROM shops WHERE slug = $1', ['blue-bottle']);
  assert.equal(shopRow.rows.length, 1);
  const userRow = await db.query('SELECT * FROM users WHERE email = $1', ['alex@bluebottle.test']);
  assert.equal(userRow.rows[0].role, 'owner');
  assert.equal(userRow.rows[0].shop_id, shopRow.rows[0].id);
});

test('POST /shops/new rejects an invalid slug with a re-rendered form', async () => {
  const app = require('../../server');
  const res = await request(app).post('/shops/new').type('form').send({
    shopName: 'Bad Shop',
    slug: 'Not A Slug!',
    ownerName: 'Alex Owner',
    email: 'alex2@bluebottle.test',
    password: 'hunter2',
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /lowercase letters, numbers, and hyphens/);
});

test('POST /shops/new rejects a duplicate slug', async () => {
  const app = require('../../server');
  await request(app).post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex Owner', email: 'alex3@bluebottle.test', password: 'hunter2',
  });
  const res = await request(app).post('/shops/new').type('form').send({
    shopName: 'Copycat', slug: 'blue-bottle', ownerName: 'Robin Copy', email: 'robin@copycat.test', password: 'hunter2',
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /already taken/);
});

test('POST /shops/new with missing fields re-renders the form with an error', async () => {
  const app = require('../../server');
  const res = await request(app).post('/shops/new').type('form').send({ shopName: 'Blue Bottle' });
  assert.equal(res.status, 200);
  assert.match(res.text, /fill out all fields/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — no `/shops/new` route exists yet (404s, or the earlier tests can't find matching text).

- [ ] **Step 3: Write the view**

```html
<!-- views/shop-new.ejs -->
<!doctype html>
<html>
<head><title>Create Your Shop · Coffee Shop</title><%- include('partials-head') %></head>
<body>
  <div class="auth-shell">
    <div class="auth-card">
      <div class="auth-mark enter">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 8h13a3 3 0 0 1 0 6h-1"/><path d="M4 8v7a4 4 0 0 0 4 4h5a4 4 0 0 0 4-4V8"/><path d="M8 2.5c0 1-1 1.2-1 2.2s1 1.2 1 2.2M12.5 2.5c0 1-1 1.2-1 2.2s1 1.2 1 2.2"/></svg>
        <span>Coffee Shop</span>
      </div>
      <div class="panel enter enter-1">
        <h2>Create your shop</h2>
        <p class="sub">Set up your shop's workspace and your owner account.</p>
        <% if (error) { %><p class="form-error"><%= error %></p><% } %>
        <form method="POST" action="/shops/new">
          <div class="field">
            <label for="shopName">Shop name</label>
            <input id="shopName" type="text" name="shopName" required>
          </div>
          <div class="field">
            <label for="slug">Shop URL</label>
            <input id="slug" type="text" name="slug" placeholder="blue-bottle" pattern="[a-z0-9-]+" required>
          </div>
          <div class="field">
            <label for="ownerName">Your name</label>
            <input id="ownerName" type="text" name="ownerName" autocomplete="name" required>
          </div>
          <div class="field">
            <label for="email">Email</label>
            <input id="email" type="email" name="email" autocomplete="email" required>
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" type="password" name="password" autocomplete="new-password" required>
          </div>
          <button type="submit" class="btn btn-primary">Create shop</button>
        </form>
      </div>
      <p class="panel-foot enter enter-2">Joining an existing shop? <a href="/signup/staff">Use your invite code</a></p>
    </div>
  </div>
</body>
</html>
```

- [ ] **Step 4: Add the route to `server.js`**

Add near the top, with the other requires:

```js
const shops = require('./models/shops');
const users = require('./models/users');
```

Add the routes (placed with the other auth routes):

```js
app.get('/shops/new', (req, res) => {
  res.render('shop-new', { error: null });
});

app.post('/shops/new', async (req, res, next) => {
  const { shopName, slug, ownerName, email, password } = req.body;
  if (!shopName || !slug || !ownerName || !email || !password) {
    return res.render('shop-new', { error: 'Please fill out all fields.' });
  }
  try {
    const result = await db.withTransaction(async (client) => {
      const shop = await shops.createShop(client, { name: shopName, slug });
      const owner = await users.createOwner(client, { name: ownerName, email, password, shopId: shop.id });
      return { shop, owner };
    });
    req.session.user = {
      id: result.owner.id,
      name: result.owner.name,
      email: result.owner.email,
      role: result.owner.role,
      shopId: result.shop.id,
    };
    res.redirect('/dashboard');
  } catch (err) {
    if (err.message === 'INVALID_SLUG') {
      return res.render('shop-new', { error: 'Shop URL can only contain lowercase letters, numbers, and hyphens.' });
    }
    if (err.code === '23505') {
      return res.render('shop-new', { error: 'That shop URL or email is already taken.' });
    }
    next(err);
  }
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: all 5 tests in `shops.test.js` (routes) pass. (`/dashboard` doesn't exist yet as a shop-filtered route until Task 14 — the redirect target doesn't need to resolve for these tests, only `res.headers.location` is checked.)

- [ ] **Step 6: Commit**

```bash
git add views/shop-new.ejs server.js test/routes/shops.test.js
git commit -m "feat: add shop creation flow"
```

---

## Task 10: Staff join-by-invite-code flow

**Files:**
- Create: `views/signup-staff.ejs`
- Modify: `server.js` (add `GET/POST /signup/staff`)
- Test: `test/routes/signup-staff.test.js`

**Interfaces:**
- Consumes: `models/shops.js` (`getShopByInviteCode`), `models/users.js` (`createStaff`).

- [ ] **Step 1: Write the failing tests**

```js
// test/routes/signup-staff.test.js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
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

test('GET /signup/staff responds 200', async () => {
  const app = require('../../server');
  const res = await request(app).get('/signup/staff');
  assert.equal(res.status, 200);
});

test('POST /signup/staff with a valid invite code creates staff and redirects to /dashboard', async () => {
  const app = require('../../server');
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });

  const res = await request(app).post('/signup/staff').type('form').send({
    name: 'Jamie Staff',
    email: 'jamie@example.com',
    password: 'hunter2',
    inviteCode: shop.invite_code,
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');

  const userRow = await db.query('SELECT * FROM users WHERE email = $1', ['jamie@example.com']);
  assert.equal(userRow.rows[0].role, 'staff');
  assert.equal(userRow.rows[0].shop_id, shop.id);
});

test('POST /signup/staff with an invalid invite code re-renders with an error', async () => {
  const app = require('../../server');
  const res = await request(app).post('/signup/staff').type('form').send({
    name: 'Jamie Staff',
    email: 'jamie2@example.com',
    password: 'hunter2',
    inviteCode: 'not-a-real-code',
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /Invalid invite code/);
});

test('POST /signup/staff with missing fields re-renders with an error', async () => {
  const app = require('../../server');
  const res = await request(app).post('/signup/staff').type('form').send({ name: 'Jamie Staff' });
  assert.equal(res.status, 200);
  assert.match(res.text, /fill out all fields/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — no `/signup/staff` route exists yet.

- [ ] **Step 3: Write the view**

```html
<!-- views/signup-staff.ejs -->
<!doctype html>
<html>
<head><title>Join Your Shop · Coffee Shop</title><%- include('partials-head') %></head>
<body>
  <div class="auth-shell">
    <div class="auth-card">
      <div class="auth-mark enter">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 8h13a3 3 0 0 1 0 6h-1"/><path d="M4 8v7a4 4 0 0 0 4 4h5a4 4 0 0 0 4-4V8"/><path d="M8 2.5c0 1-1 1.2-1 2.2s1 1.2 1 2.2M12.5 2.5c0 1-1 1.2-1 2.2s1 1.2 1 2.2"/></svg>
        <span>Coffee Shop</span>
      </div>
      <div class="panel enter enter-1">
        <h2>Join your shop</h2>
        <p class="sub">Enter the invite code your shop owner gave you.</p>
        <% if (error) { %><p class="form-error"><%= error %></p><% } %>
        <form method="POST" action="/signup/staff">
          <div class="field">
            <label for="name">Name</label>
            <input id="name" type="text" name="name" autocomplete="name" required>
          </div>
          <div class="field">
            <label for="email">Email</label>
            <input id="email" type="email" name="email" autocomplete="email" required>
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" type="password" name="password" autocomplete="new-password" required>
          </div>
          <div class="field">
            <label for="inviteCode">Invite code</label>
            <input id="inviteCode" type="text" name="inviteCode" required>
          </div>
          <button type="submit" class="btn btn-primary">Join shop</button>
        </form>
      </div>
      <p class="panel-foot enter enter-2">Starting a new shop instead? <a href="/shops/new">Create one</a></p>
    </div>
  </div>
</body>
</html>
```

- [ ] **Step 4: Add the route to `server.js`**

```js
app.get('/signup/staff', (req, res) => {
  res.render('signup-staff', { error: null });
});

app.post('/signup/staff', async (req, res, next) => {
  const { name, email, password, inviteCode } = req.body;
  if (!name || !email || !password || !inviteCode) {
    return res.render('signup-staff', { error: 'Please fill out all fields.' });
  }
  try {
    const shop = await shops.getShopByInviteCode(db, inviteCode);
    if (!shop) {
      return res.render('signup-staff', { error: 'Invalid invite code.' });
    }
    const user = await users.createStaff(db, { name, email, password, shopId: shop.id });
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, shopId: shop.id };
    res.redirect('/dashboard');
  } catch (err) {
    if (err.code === '23505') {
      return res.render('signup-staff', { error: 'An account with that email already exists.' });
    }
    next(err);
  }
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: all 4 tests in `signup-staff.test.js` pass.

- [ ] **Step 6: Commit**

```bash
git add views/signup-staff.ejs server.js test/routes/signup-staff.test.js
git commit -m "feat: add staff join-by-invite-code flow"
```

---

## Task 11: Customer signup simplification

**Files:**
- Modify: `views/signup.ejs` (remove the role picker)
- Modify: `server.js` (rewrite `POST /signup`)
- Test: `test/routes/signup.test.js`

**Interfaces:**
- Consumes: `models/users.js` (`createCustomer`).

- [ ] **Step 1: Write the failing tests**

```js
// test/routes/signup.test.js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db, migrate, resetDb } = require('../../testHelpers/db');

before(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetDb();
});
after(async () => {
  await db.pool.end();
});

test('GET /signup responds 200 and has no role picker', async () => {
  const app = require('../../server');
  const res = await request(app).get('/signup');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /name="role"/);
});

test('POST /signup creates a customer with no shop_id and redirects to /welcome', async () => {
  const app = require('../../server');
  const res = await request(app).post('/signup').type('form').send({
    name: 'Sam Rivera',
    email: 'sam@example.com',
    password: 'hunter2',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/welcome');

  const userRow = await db.query('SELECT * FROM users WHERE email = $1', ['sam@example.com']);
  assert.equal(userRow.rows[0].role, 'customer');
  assert.equal(userRow.rows[0].shop_id, null);
});

test('POST /signup rejects a duplicate email', async () => {
  const app = require('../../server');
  await request(app).post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  const res = await request(app).post('/signup').type('form').send({ name: 'Other Sam', email: 'sam@example.com', password: 'hunter2' });
  assert.equal(res.status, 200);
  assert.match(res.text, /already exists/);
});

test('POST /signup with missing fields re-renders with an error', async () => {
  const app = require('../../server');
  const res = await request(app).post('/signup').type('form').send({ name: 'Sam Rivera' });
  assert.equal(res.status, 200);
  assert.match(res.text, /fill out all fields/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `/signup` still has the old role picker and redirects to `/order`, not `/welcome`.

- [ ] **Step 3: Update the view**

In `views/signup.ejs`, remove the role field block:

```html
          <div class="field">
            <label for="role">I am a</label>
            <select id="role" name="role">
              <option value="customer">Customer</option>
              <option value="staff">Staff</option>
            </select>
          </div>
```

Add below the existing "Already have an account?" line:

```html
      <p class="panel-foot">Own a coffee shop? <a href="/shops/new">Create your shop</a> · Joining as staff? <a href="/signup/staff">Use your invite code</a></p>
```

- [ ] **Step 4: Rewrite `POST /signup` in `server.js`**

Find the existing `app.post('/signup', ...)` handler and replace it entirely:

```js
app.post('/signup', async (req, res, next) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.render('signup', { error: 'Please fill out all fields.' });
  }
  try {
    const user = await users.createCustomer(db, { name, email, password });
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, shopId: null };
    res.redirect('/welcome');
  } catch (err) {
    if (err.code === '23505') {
      return res.render('signup', { error: 'An account with that email already exists.' });
    }
    next(err);
  }
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: all 4 tests in `signup.test.js` pass. (`/welcome` doesn't exist until Task 12 — only `res.headers.location` is checked here, so this passes regardless.)

- [ ] **Step 6: Commit**

```bash
git add views/signup.ejs server.js test/routes/signup.test.js
git commit -m "feat: simplify customer signup to a global, shop-less account"
```

---

## Task 12: Login redirect logic + customer landing placeholder

**Files:**
- Create: `views/welcome.ejs`
- Modify: `server.js` (rewrite `POST /login`, `GET /`, add `GET /welcome`)
- Test: `test/routes/login.test.js`

**Interfaces:**
- Consumes: `models/users.js` (`getUserByEmail`).
- Produces: the full three-way role redirect (`owner`/`staff` → `/dashboard`, `customer` → `/welcome`).

- [ ] **Step 1: Write the failing tests**

```js
// test/routes/login.test.js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db, migrate, resetDb } = require('../../testHelpers/db');

before(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetDb();
});
after(async () => {
  await db.pool.end();
});

test('customer login redirects to /welcome', async () => {
  const app = require('../../server');
  await request(app).post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  const res = await request(app).post('/login').type('form').send({ email: 'sam@example.com', password: 'hunter2' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/welcome');
});

test('owner login redirects to /dashboard', async () => {
  const app = require('../../server');
  await request(app).post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex Owner', email: 'alex@bluebottle.test', password: 'hunter2',
  });
  const res = await request(app).post('/login').type('form').send({ email: 'alex@bluebottle.test', password: 'hunter2' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');
});

test('login with wrong password re-renders with an error', async () => {
  const app = require('../../server');
  await request(app).post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  const res = await request(app).post('/login').type('form').send({ email: 'sam@example.com', password: 'wrong' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Invalid email or password/);
});

test('GET /welcome requires auth', async () => {
  const app = require('../../server');
  const res = await request(app).get('/welcome');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('logged-in customer can view /welcome', async () => {
  const app = require('../../server');
  const agent = request.agent(app);
  await agent.post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  const res = await agent.get('/welcome');
  assert.equal(res.status, 200);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `/welcome` doesn't exist, login still redirects based on the old `staff`/`customer` role split.

- [ ] **Step 3: Write the placeholder view**

```html
<!-- views/welcome.ejs -->
<!doctype html>
<html>
<head><title>Welcome · Coffee Shop</title><%- include('partials-head') %></head>
<body>
  <div class="auth-shell">
    <div class="auth-card">
      <div class="auth-mark enter">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 8h13a3 3 0 0 1 0 6h-1"/><path d="M4 8v7a4 4 0 0 0 4 4h5a4 4 0 0 0 4-4V8"/><path d="M8 2.5c0 1-1 1.2-1 2.2s1 1.2 1 2.2M12.5 2.5c0 1-1 1.2-1 2.2s1 1.2 1 2.2"/></svg>
        <span>Coffee Shop</span>
      </div>
      <div class="panel enter enter-1">
        <h2>Welcome, <%= user.name %></h2>
        <p class="sub">Have a link from a shop? Open it to start an order. Otherwise, ask your favorite shop for their ordering link.</p>
      </div>
      <p class="panel-foot enter enter-2"><a href="/logout">Log out</a></p>
    </div>
  </div>
</body>
</html>
```

- [ ] **Step 4: Rewrite `POST /login` and `GET /` in `server.js`**

Find the existing `app.post('/login', ...)` handler and replace it entirely:

```js
app.post('/login', async (req, res, next) => {
  const { email, password } = req.body;
  try {
    const user = await users.getUserByEmail(db, email);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.render('login', { error: 'Invalid email or password.' });
    }
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, shopId: user.shop_id };
    return res.redirect(user.role === 'customer' ? '/welcome' : '/dashboard');
  } catch (err) {
    next(err);
  }
});
```

Find the existing `app.get('/', ...)` handler and replace it entirely:

```js
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  return res.redirect(req.session.user.role === 'customer' ? '/welcome' : '/dashboard');
});
```

Add the new route, alongside the other customer routes:

```js
app.get('/welcome', requireAuth, requireRole('customer'), (req, res) => {
  res.render('welcome');
});
```

- [ ] **Step 5: Run the full test suite to verify everything passes, including the deferred session test from Task 8**

Run: `npm test`
Expected: all tests pass, including `test/routes/session.test.js` from Task 8 (now that `/signup` and `/welcome` both exist).

- [ ] **Step 6: Commit**

```bash
git add views/welcome.ejs server.js test/routes/login.test.js
git commit -m "feat: role-based login redirect and customer landing placeholder"
```

---

## Task 13: Shop-scoped ordering routes

**Files:**
- Modify: `server.js` (rewrite `GET/POST /order` → `GET/POST /:shopSlug/order`)
- Modify: `views/order.ejs:129,193` (nav link and form action need the shop slug)
- Modify: `views/confirmation.ejs:76` (link back to ordering needs the shop slug)
- Test: `test/routes/order.test.js`

**Interfaces:**
- Consumes: `middleware/auth.js` (`requireAuth`, `requireRole`, `loadShopBySlug`), `models/orders.js` (`createOrder`).

- [ ] **Step 1: Write the failing tests**

```js
// test/routes/order.test.js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
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

async function loggedInCustomer(app) {
  const agent = request.agent(app);
  await agent.post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  return agent;
}

test('GET /:shopSlug/order 404s for an unknown shop', async () => {
  const app = require('../../server');
  const agent = await loggedInCustomer(app);
  const res = await agent.get('/does-not-exist/order');
  assert.equal(res.status, 404);
});

test('GET /:shopSlug/order requires auth', async () => {
  const app = require('../../server');
  await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const res = await request(app).get('/blue-bottle/order');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('GET /:shopSlug/order renders the menu for a logged-in customer', async () => {
  const app = require('../../server');
  await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const agent = await loggedInCustomer(app);
  const res = await agent.get('/blue-bottle/order');
  assert.equal(res.status, 200);
  assert.match(res.text, /action="\/blue-bottle\/order"/);
});

test('POST /:shopSlug/order creates an order scoped to that shop', async () => {
  const app = require('../../server');
  const shop = await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const agent = await loggedInCustomer(app);

  const menu = require('../../menu');
  const firstItem = menu[0];

  const res = await agent.post('/blue-bottle/order').type('form').send({ ['qty_' + firstItem.id]: '2' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Order received/);

  const orderRow = await db.query('SELECT * FROM orders WHERE shop_id = $1', [shop.id]);
  assert.equal(orderRow.rows.length, 1);
});

test('POST /:shopSlug/order with no items selected re-renders with an error', async () => {
  const app = require('../../server');
  await shops.createShop(db, { name: 'Blue Bottle', slug: 'blue-bottle' });
  const agent = await loggedInCustomer(app);
  const res = await agent.post('/blue-bottle/order').type('form').send({});
  assert.equal(res.status, 200);
  assert.match(res.text, /select at least one item/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `/order` (no slug) is still the route, `/blue-bottle/order` 404s or behaves incorrectly.

- [ ] **Step 3: Update `views/order.ejs`**

Find:

```html
      <a class="app-nav-item active" href="/order">Menu</a>
```

Replace with:

```html
      <a class="app-nav-item active" href="/<%= shop.slug %>/order">Menu</a>
```

Find:

```html
            <form method="POST" action="/order" id="order-form">
```

Replace with:

```html
            <form method="POST" action="/<%= shop.slug %>/order" id="order-form">
```

- [ ] **Step 4: Update `views/confirmation.ejs`**

Find:

```html
      <a href="/order" class="confirm-again enter enter-2">Place another order &rarr;</a>
```

Replace with:

```html
      <a href="/<%= shop.slug %>/order" class="confirm-again enter enter-2">Place another order &rarr;</a>
```

- [ ] **Step 5: Rewrite the order routes in `server.js`**

Add near the top, with the other requires:

```js
const orders = require('./models/orders');
const { requireAuth, requireRole, loadShopBySlug } = require('./middleware/auth');
```

Remove the old local `requireAuth`/`requireRole` function definitions from `server.js` — they're now imported from `middleware/auth.js`.

Find the existing `app.get('/order', ...)` and `app.post('/order', ...)` handlers and replace both entirely:

```js
app.get('/:shopSlug/order', requireAuth, requireRole('customer'), loadShopBySlug, (req, res) => {
  res.render('order', { menu, error: null, shop: req.shop });
});

app.post('/:shopSlug/order', requireAuth, requireRole('customer'), loadShopBySlug, async (req, res, next) => {
  const items = [];
  let total = 0;
  for (const item of menu) {
    const qty = parseInt(req.body['qty_' + item.id], 10) || 0;
    if (qty > 0) {
      items.push({ name: item.name, qty, price: item.price });
      total += qty * item.price;
    }
  }

  if (items.length === 0) {
    return res.render('order', { menu, error: 'Please select at least one item.', shop: req.shop });
  }

  try {
    const created = await orders.createOrder(db, {
      userId: req.session.user.id,
      shopId: req.shop.id,
      items,
      total,
    });

    const order = {
      order_id: created.id,
      customer_name: req.session.user.name,
      customer_email: req.session.user.email,
      items: items.map((i) => `${i.name} x${i.qty}`).join(', '),
      lineItems: items,
      total: total.toFixed(2),
      created_at: created.created_at,
    };

    try {
      await fetch(process.env.N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(order),
      });
    } catch (err) {
      console.error('Failed to notify n8n webhook:', err.message);
    }

    res.render('confirmation', { order, shop: req.shop });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: all 5 tests in `order.test.js` pass, and the full suite still passes.

- [ ] **Step 7: Commit**

```bash
git add server.js views/order.ejs views/confirmation.ejs test/routes/order.test.js
git commit -m "feat: make ordering shop-scoped via slug-based routing"
```

---

## Task 14: Shop-filtered dashboard

**Files:**
- Modify: `server.js` (rewrite `GET /dashboard`)
- Test: `test/routes/dashboard.test.js`

**Interfaces:**
- Consumes: `models/orders.js` (`getOrdersForShop`).

- [ ] **Step 1: Write the failing tests**

```js
// test/routes/dashboard.test.js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db, migrate, resetDb } = require('../../testHelpers/db');

before(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetDb();
});
after(async () => {
  await db.pool.end();
});

test('GET /dashboard requires auth', async () => {
  const app = require('../../server');
  const res = await request(app).get('/dashboard');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('GET /dashboard is forbidden for a customer', async () => {
  const app = require('../../server');
  const agent = request.agent(app);
  await agent.post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  const res = await agent.get('/dashboard');
  assert.equal(res.status, 403);
});

test('GET /dashboard shows the owner\'s shop orders', async () => {
  const app = require('../../server');
  const ownerAgent = request.agent(app);
  await ownerAgent.post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex Owner', email: 'alex@bluebottle.test', password: 'hunter2',
  });

  const customerAgent = request.agent(app);
  await customerAgent.post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  const menu = require('../../menu');
  await customerAgent.post('/blue-bottle/order').type('form').send({ ['qty_' + menu[0].id]: '1' });

  const res = await ownerAgent.get('/dashboard');
  assert.equal(res.status, 200);
  assert.match(res.text, /Sam Rivera/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `/dashboard` still queries all orders globally, not filtered by `shop_id`.

- [ ] **Step 3: Rewrite `GET /dashboard` in `server.js`**

Find the existing `app.get('/dashboard', ...)` handler and replace it entirely:

```js
app.get('/dashboard', requireAuth, requireRole('owner', 'staff'), async (req, res, next) => {
  try {
    const shopOrders = await orders.getOrdersForShop(db, req.session.user.shopId);
    res.render('dashboard', { orders: shopOrders });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all 3 tests in `dashboard.test.js` pass.

- [ ] **Step 5: Commit**

```bash
git add server.js test/routes/dashboard.test.js
git commit -m "feat: filter dashboard orders by the staff session's shop"
```

---

## Task 15: Cross-shop isolation test

**Files:**
- Test: `test/routes/isolation.test.js`

**Interfaces:**
- Consumes: everything from Tasks 9-14. No new production code — this task exists purely to lock in the spec's core security invariant with an explicit, dedicated test, per the spec's Testing Focus section.

- [ ] **Step 1: Write the isolation test**

```js
// test/routes/isolation.test.js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db, migrate, resetDb } = require('../../testHelpers/db');

before(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetDb();
});
after(async () => {
  await db.pool.end();
});

test('staff of shop A cannot see shop B\'s orders on their own dashboard', async () => {
  const app = require('../../server');
  const menu = require('../../menu');

  const ownerA = request.agent(app);
  await ownerA.post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex A', email: 'alex@a.test', password: 'hunter2',
  });

  const ownerB = request.agent(app);
  await ownerB.post('/shops/new').type('form').send({
    shopName: 'Ritual', slug: 'ritual', ownerName: 'Robin B', email: 'robin@b.test', password: 'hunter2',
  });

  const customer = request.agent(app);
  await customer.post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  await customer.post('/ritual/order').type('form').send({ ['qty_' + menu[0].id]: '1' });

  const dashboardA = await ownerA.get('/dashboard');
  assert.equal(dashboardA.status, 200);
  assert.doesNotMatch(dashboardA.text, /Sam Rivera/);

  const dashboardB = await ownerB.get('/dashboard');
  assert.equal(dashboardB.status, 200);
  assert.match(dashboardB.text, /Sam Rivera/);
});

test('a customer can order from two different shops with one account', async () => {
  const app = require('../../server');
  const menu = require('../../menu');

  await request(app).post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex A', email: 'alex@a.test', password: 'hunter2',
  });
  await request(app).post('/shops/new').type('form').send({
    shopName: 'Ritual', slug: 'ritual', ownerName: 'Robin B', email: 'robin@b.test', password: 'hunter2',
  });

  const customer = request.agent(app);
  await customer.post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });

  const resA = await customer.post('/blue-bottle/order').type('form').send({ ['qty_' + menu[0].id]: '1' });
  const resB = await customer.post('/ritual/order').type('form').send({ ['qty_' + menu[0].id]: '1' });
  assert.match(resA.text, /Order received/);
  assert.match(resB.text, /Order received/);

  const orderCount = await db.query('SELECT count(*) FROM orders WHERE user_id = (SELECT id FROM users WHERE email = $1)', ['sam@example.com']);
  assert.equal(Number(orderCount.rows[0].count), 2);
});
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npm test`
Expected: both tests pass, and the full suite (all tasks) passes with 0 failures.

- [ ] **Step 3: Commit**

```bash
git add test/routes/isolation.test.js
git commit -m "test: lock in cross-shop data isolation as an explicit regression test"
```

---

## Final check

After Task 15, run the full suite one more time and confirm nothing regressed:

Run: `npm test`
Expected: every test file passes, 0 failures.

Then smoke-test manually: `npm start`, visit `http://localhost:3000/shops/new`, create a shop, create a staff account via its invite code (`http://localhost:3000/signup/staff`), sign up a customer, place an order at `http://localhost:3000/<your-slug>/order`, and confirm it shows up on the owner's `/dashboard` but not on a second shop's dashboard.
