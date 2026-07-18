# Shop Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/welcome` placeholder with a real customer-facing browse feed of every shop on the platform (cover photo, name, tagline), and give owners a settings page to set their tagline and upload a cover photo.

**Architecture:** `shops` gains two nullable columns. A new `lib/storage.js` module talks to an S3-compatible object store (Cloudflare R2 in production, MinIO locally via Docker Compose — same pattern as using local Postgres to mirror Neon) and is the only thing that ever touches image bytes; the app itself only ever stores/reads a URL string. `models/shops.js` grows read/write functions for shop profiles. Two new routes: an owner-only settings page, and a rewritten `/welcome` that queries every shop instead of rendering a static message.

**Tech Stack:** Same as prior sub-projects — Node.js, Express, EJS, `pg` (raw SQL, no ORM), `node:test` + `supertest` against real Postgres, plus `@aws-sdk/client-s3` (S3-compatible storage client) and `multer` (multipart form parsing for file uploads) as new dependencies.

## Global Constraints

- `shops.tagline` and `shops.cover_photo_url` are both nullable — a shop with neither set still appears in the browse feed with just its name.
- The app never stores image bytes anywhere itself (not in Postgres, not on local disk) — only a URL string (`cover_photo_url`) pointing into object storage.
- The storage client (`lib/storage.js`) is the same code path in every environment; only the endpoint/credentials differ (R2 in production, MinIO locally via env vars) — no environment-specific branching in application code.
- Cover photo uploads accept only `image/jpeg`, `image/png`, `image/webp`, max 5MB, validated server-side — a rejected upload never clears the shop's existing photo.
- `/shop/settings` is owner-only (`requireAuth` + `requireRole('owner')`) — matches `/menu`'s access pattern. It has no `:id` in its URL (it always acts on `req.session.user.shopId`), so there's no crafted-id cross-shop vector to guard against here, unlike `/menu/:id`.
- No ORM — raw SQL via the `pg` driver.
- No delivery, no location/geo filtering, no ratings/reviews, no search on the feed — a plain, unfiltered, alphabetically-ordered list of every shop.
- Every new piece of logic gets a test before being wired into `server.js`.

---

## Task 1: `shops` schema for profile fields

**Files:**
- Modify: `db/schema.sql` (append ALTER statements after the `shops` table block)

**Interfaces:**
- Produces: `shops.tagline` (TEXT, nullable) and `shops.cover_photo_url` (TEXT, nullable). Consumed by Task 3 (model), Task 4 (owner settings), Task 5 (browse feed).

- [ ] **Step 1: Append the migration to `db/schema.sql`**

Add directly after the existing `CREATE TABLE IF NOT EXISTS shops (...)` block:

```sql
ALTER TABLE shops ADD COLUMN IF NOT EXISTS tagline TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS cover_photo_url TEXT;
```

- [ ] **Step 2: Run the migration and verify**

Run: `docker compose up -d` (ensure Postgres is running), then `npm run migrate`
Expected: `Migration complete.` with no errors.

Then run: `docker compose exec postgres psql -U postgres -d coffee_shop_dev -c "\d shops"`
Expected: `tagline` and `cover_photo_url` columns present, both nullable.

- [ ] **Step 3: Run the migration a second time to confirm idempotency**

Run: `npm run migrate` again.
Expected: `Migration complete.` again, no errors (`ADD COLUMN IF NOT EXISTS` is naturally idempotent).

- [ ] **Step 4: Commit**

```bash
git add db/schema.sql
git commit -m "feat: add tagline and cover_photo_url to shops"
```

---

## Task 2: Object storage — MinIO locally, S3-compatible client

**Files:**
- Modify: `docker-compose.yml` (add a MinIO service)
- Create: `lib/storage.js`
- Modify: `.env.example` (document the new `STORAGE_*` variables)
- Modify: `package.json` (add `@aws-sdk/client-s3`)
- Test: `test/lib/storage.test.js`

**Interfaces:**
- Produces: `uploadImage(buffer, key, contentType) → url` (Promise). Consumed by Task 4 (owner settings upload handler).

- [ ] **Step 1: Add MinIO to `docker-compose.yml`**

Add a new service alongside the existing `postgres` service, and a new named volume:

```yaml
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - miniodata:/data
```

Add `miniodata:` under the top-level `volumes:` key, alongside the existing `pgdata:`.

- [ ] **Step 2: Start MinIO and verify it's reachable**

Run: `docker compose up -d`
Then run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9000/minio/health/live`
Expected: `200`.

- [ ] **Step 3: Document the new environment variables in `.env.example`**

Add below the existing `DATABASE_URL`/`TEST_DATABASE_URL` lines:

```
# Object storage for shop cover photos (S3-compatible). Locally this points at the
# MinIO container from docker-compose.yml. In production, point these at Cloudflare R2
# instead — same code, different endpoint/credentials.
STORAGE_ENDPOINT=http://localhost:9000
STORAGE_PUBLIC_URL_BASE=http://localhost:9000
STORAGE_BUCKET=coffee-shop-covers
STORAGE_ACCESS_KEY_ID=minioadmin
STORAGE_SECRET_ACCESS_KEY=minioadmin
STORAGE_REGION=auto
```

Add the same block to your local `.env` (gitignored, not committed).

- [ ] **Step 4: Write the failing test**

```js
// test/lib/storage.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../../lib/storage');

test('uploadImage stores a file in object storage and returns a URL that serves it back', async () => {
  const contents = 'fake image bytes ' + Date.now();
  const buffer = Buffer.from(contents);
  const url = await storage.uploadImage(buffer, `test/${Date.now()}.jpg`, 'image/jpeg');

  assert.match(url, /^http/);

  const res = await fetch(url);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(body, contents);
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test -- test/lib/storage.test.js`
Expected: FAIL — `Cannot find module '../../lib/storage'`.

- [ ] **Step 6: Install the dependency and write the implementation**

```bash
npm install @aws-sdk/client-s3
```

```js
// lib/storage.js
require('dotenv').config();
const { S3Client, PutObjectCommand, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  endpoint: process.env.STORAGE_ENDPOINT,
  region: process.env.STORAGE_REGION || 'auto',
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

const BUCKET = process.env.STORAGE_BUCKET;

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch (err) {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }
}

async function uploadImage(buffer, key, contentType) {
  await ensureBucket();
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return `${process.env.STORAGE_PUBLIC_URL_BASE}/${BUCKET}/${key}`;
}

module.exports = { uploadImage };
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test -- test/lib/storage.test.js`
Expected: PASS.

Then run the full suite: `npm test`
Expected: all prior tests (86) plus this 1 new test pass.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml lib/storage.js .env.example package.json package-lock.json test/lib/storage.test.js
git commit -m "feat: add S3-compatible object storage client (MinIO locally, R2 in production)"
```

---

## Task 3: Shop profile model functions

**Files:**
- Modify: `models/shops.js`
- Test: `test/models/shops.test.js`

**Interfaces:**
- Consumes: `.query`-shaped queryable.
- Produces: `getShopById(queryable, id) → shop | null`, `updateShopProfile(queryable, id, { tagline, coverPhotoUrl }) → shop | null`, `getAllShops(queryable) → shop[]` (ordered by name ascending). Every returned `shop` includes `{ id, name, slug, tagline, cover_photo_url }`. `updateShopProfile`'s `coverPhotoUrl` uses `COALESCE` against the existing column — passing `null` leaves the current photo untouched (the "no new upload" case); passing a URL replaces it. `tagline` is always set directly (not COALESCE) so an owner can intentionally clear it by submitting an empty value (the caller normalizes empty string to `null` before calling). Consumed by Task 4 (owner settings) and Task 5 (browse feed).

- [ ] **Step 1: Write the failing tests**

Add to `test/models/shops.test.js` (keep all existing tests in the file unchanged):

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `getShopById`, `updateShopProfile`, `getAllShops` don't exist yet.

- [ ] **Step 3: Update `models/shops.js`**

Add these three functions and update the exports (keep `createShop`, `getShopBySlug`, `getShopByInviteCode`, `SLUG_RE` exactly as they are):

```js
async function getShopById(queryable, id) {
  const result = await queryable.query(
    'SELECT id, name, slug, tagline, cover_photo_url FROM shops WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

async function updateShopProfile(queryable, id, { tagline, coverPhotoUrl }) {
  const result = await queryable.query(
    `UPDATE shops SET tagline = $1, cover_photo_url = COALESCE($2, cover_photo_url)
     WHERE id = $3
     RETURNING id, name, slug, tagline, cover_photo_url`,
    [tagline, coverPhotoUrl, id]
  );
  return result.rows[0] || null;
}

async function getAllShops(queryable) {
  const result = await queryable.query(
    'SELECT id, name, slug, tagline, cover_photo_url FROM shops ORDER BY name ASC'
  );
  return result.rows;
}

module.exports = { createShop, getShopBySlug, getShopByInviteCode, getShopById, updateShopProfile, getAllShops, SLUG_RE };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all 6 new tests pass, plus the full prior suite (87 tests: 86 + Task 2's 1) passes.

- [ ] **Step 5: Commit**

```bash
git add models/shops.js test/models/shops.test.js
git commit -m "feat: add shop profile read/write functions"
```

---

## Task 4: Owner shop settings page

**Files:**
- Create: `views/shop-settings.ejs`
- Modify: `views/dashboard.ejs`, `views/menu-edit.ejs`, `views/pos.ejs` (add "Settings" nav link to each sidebar)
- Modify: `server.js` (add `GET/POST /shop/settings`)
- Modify: `package.json` (add `multer`)
- Test: `test/routes/shop-settings.test.js`

**Interfaces:**
- Consumes: `models/shops.js` (`getShopById`, `updateShopProfile`), `lib/storage.js` (`uploadImage`).

- [ ] **Step 1: Write the failing tests**

```js
// test/routes/shop-settings.test.js
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

async function ownerAgentWithShop(app, slug = 'blue-bottle') {
  const agent = request.agent(app);
  await agent.post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug, ownerName: 'Alex Owner', email: 'alex@bluebottle.test', password: 'hunter2',
  });
  return agent;
}

test('GET /shop/settings requires auth', async () => {
  const app = require('../../server');
  const res = await request(app).get('/shop/settings');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('GET /shop/settings is forbidden for staff', async () => {
  const app = require('../../server');
  const ownerAgent = await ownerAgentWithShop(app);
  const shopRow = await db.query('SELECT invite_code FROM shops WHERE slug = $1', ['blue-bottle']);
  const staffAgent = request.agent(app);
  await staffAgent.post('/signup/staff').type('form').send({
    name: 'Jamie Staff', email: 'jamie@bluebottle.test', password: 'hunter2', inviteCode: shopRow.rows[0].invite_code,
  });
  const res = await staffAgent.get('/shop/settings');
  assert.equal(res.status, 403);
});

test('POST /shop/settings updates the tagline with no photo', async () => {
  const app = require('../../server');
  const agent = await ownerAgentWithShop(app);
  const res = await agent.post('/shop/settings').field('tagline', 'Cozy third-wave vibes');
  assert.equal(res.status, 200);
  assert.match(res.text, /Cozy third-wave vibes/);

  const row = await db.query('SELECT tagline FROM shops WHERE slug = $1', ['blue-bottle']);
  assert.equal(row.rows[0].tagline, 'Cozy third-wave vibes');
});

test('POST /shop/settings with a cover photo upload stores it in object storage and saves the URL', async () => {
  const app = require('../../server');
  const agent = await ownerAgentWithShop(app);
  const res = await agent.post('/shop/settings')
    .field('tagline', 'Cozy vibes')
    .attach('coverPhoto', Buffer.from('fake jpeg bytes'), { filename: 'cover.jpg', contentType: 'image/jpeg' });
  assert.equal(res.status, 200);

  const row = await db.query('SELECT cover_photo_url FROM shops WHERE slug = $1', ['blue-bottle']);
  assert.match(row.rows[0].cover_photo_url, /^http/);

  const imageRes = await fetch(row.rows[0].cover_photo_url);
  assert.equal(imageRes.status, 200);
});

test('POST /shop/settings rejects a non-image file and does not touch the existing photo', async () => {
  const app = require('../../server');
  const agent = await ownerAgentWithShop(app);
  await agent.post('/shop/settings')
    .field('tagline', 'First')
    .attach('coverPhoto', Buffer.from('fake jpeg bytes'), { filename: 'cover.jpg', contentType: 'image/jpeg' });
  const before = await db.query('SELECT cover_photo_url FROM shops WHERE slug = $1', ['blue-bottle']);

  const res = await agent.post('/shop/settings')
    .field('tagline', 'Second')
    .attach('coverPhoto', Buffer.from('not an image'), { filename: 'notes.txt', contentType: 'text/plain' });
  assert.equal(res.status, 200);
  assert.match(res.text, /JPG, PNG, or WEBP/);

  const after = await db.query('SELECT cover_photo_url, tagline FROM shops WHERE slug = $1', ['blue-bottle']);
  assert.equal(after.rows[0].cover_photo_url, before.rows[0].cover_photo_url);
  assert.equal(after.rows[0].tagline, 'First');
});

test('POST /shop/settings with no new photo leaves the existing photo untouched', async () => {
  const app = require('../../server');
  const agent = await ownerAgentWithShop(app);
  await agent.post('/shop/settings')
    .field('tagline', 'First')
    .attach('coverPhoto', Buffer.from('fake jpeg bytes'), { filename: 'cover.jpg', contentType: 'image/jpeg' });
  const before = await db.query('SELECT cover_photo_url FROM shops WHERE slug = $1', ['blue-bottle']);

  await agent.post('/shop/settings').field('tagline', 'Second, no new photo');

  const after = await db.query('SELECT cover_photo_url, tagline FROM shops WHERE slug = $1', ['blue-bottle']);
  assert.equal(after.rows[0].cover_photo_url, before.rows[0].cover_photo_url);
  assert.equal(after.rows[0].tagline, 'Second, no new photo');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `/shop/settings` doesn't exist yet.

- [ ] **Step 3: Write the view**

```html
<!-- views/shop-settings.ejs -->
<!doctype html>
<html>
<head><title>Shop Settings · Coffee Shop</title><%- include('partials-head') %>
<style>
  .form-success {
    background: rgba(217,164,65,0.1); border: 1px solid rgba(217,164,65,0.35); color: var(--gold-deep);
    font-size: 13.5px; padding: 10px 12px; border-radius: 8px; margin-bottom: 16px;
  }
  .settings-panel { background: var(--parchment); border: 1px solid var(--line); border-radius: 12px; padding: 20px; max-width: 480px; }
</style>
</head>
<body>
  <div class="app-shell">
    <div class="app-sidebar">
      <div class="app-mark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 8h13a3 3 0 0 1 0 6h-1"/><path d="M4 8v7a4 4 0 0 0 4 4h5a4 4 0 0 0 4-4V8"/><path d="M8 2.5c0 1-1 1.2-1 2.2s1 1.2 1 2.2M12.5 2.5c0 1-1 1.2-1 2.2s1 1.2 1 2.2"/></svg>
        <span>Coffee Shop</span>
      </div>
      <a class="app-nav-item" href="/dashboard">Orders</a>
      <a class="app-nav-item" href="/menu">Menu</a>
      <a class="app-nav-item" href="/pos">POS</a>
      <a class="app-nav-item active" href="/shop/settings">Settings</a>
      <div class="app-sidebar-foot">
        <div class="who">Owner · <%= user.name %></div>
        <a href="/logout">Log out</a>
      </div>
    </div>

    <div class="app-main">
      <div class="app-topbar">
        <h1 style="font-size:26px;">Shop settings</h1>
      </div>
      <% if (error) { %><p class="order-error"><%= error %></p><% } %>
      <% if (typeof saved !== 'undefined' && saved) { %><p class="form-success">Saved.</p><% } %>

      <div class="settings-panel">
        <form method="POST" action="/shop/settings" enctype="multipart/form-data">
          <div class="field">
            <label for="tagline">Tagline</label>
            <input id="tagline" name="tagline" type="text" maxlength="140" value="<%= shop.tagline || '' %>" placeholder="Third-wave coffee, cozy vibes">
          </div>
          <div class="field">
            <label for="coverPhoto">Cover photo</label>
            <% if (shop.cover_photo_url) { %>
              <div style="margin-bottom:8px;">
                <img src="<%= shop.cover_photo_url %>" alt="" style="width:100%;max-width:320px;border-radius:10px;border:1px solid var(--line);display:block;">
              </div>
            <% } %>
            <input id="coverPhoto" name="coverPhoto" type="file" accept="image/jpeg,image/png,image/webp">
          </div>
          <button type="submit" class="btn btn-primary" style="margin-top:16px;">Save</button>
        </form>
      </div>
    </div>
  </div>
</body>
</html>
```

- [ ] **Step 4: Add "Settings" nav link to the three existing owner/staff views**

In `views/dashboard.ejs`, find:

```html
      <a class="app-nav-item active" href="/dashboard">Orders</a>
      <a class="app-nav-item" href="/menu">Menu</a>
      <a class="app-nav-item" href="/pos">POS</a>
```

Replace with:

```html
      <a class="app-nav-item active" href="/dashboard">Orders</a>
      <a class="app-nav-item" href="/menu">Menu</a>
      <a class="app-nav-item" href="/pos">POS</a>
      <a class="app-nav-item" href="/shop/settings">Settings</a>
```

In `views/menu-edit.ejs`, find:

```html
      <a class="app-nav-item" href="/dashboard">Orders</a>
      <a class="app-nav-item active" href="/menu">Menu</a>
      <a class="app-nav-item" href="/pos">POS</a>
```

Replace with:

```html
      <a class="app-nav-item" href="/dashboard">Orders</a>
      <a class="app-nav-item active" href="/menu">Menu</a>
      <a class="app-nav-item" href="/pos">POS</a>
      <a class="app-nav-item" href="/shop/settings">Settings</a>
```

In `views/pos.ejs`, find:

```html
      <a class="app-nav-item" href="/dashboard">Orders</a>
      <a class="app-nav-item" href="/menu">Menu</a>
      <a class="app-nav-item active" href="/pos">POS</a>
```

Replace with:

```html
      <a class="app-nav-item" href="/dashboard">Orders</a>
      <a class="app-nav-item" href="/menu">Menu</a>
      <a class="app-nav-item active" href="/pos">POS</a>
      <a class="app-nav-item" href="/shop/settings">Settings</a>
```

- [ ] **Step 5: Install `multer` and add the routes to `server.js`**

```bash
npm install multer
```

Add near the top, with the other requires:

```js
const multer = require('multer');
const storage = require('./lib/storage');
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });
```

Add the routes (placed with the other owner-facing routes, near `/menu`):

```js
app.get('/shop/settings', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const shop = await shops.getShopById(db, req.session.user.shopId);
    res.render('shop-settings', { shop, error: null });
  } catch (err) {
    next(err);
  }
});

app.post('/shop/settings', requireAuth, requireRole('owner'), (req, res, next) => {
  upload.single('coverPhoto')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const shop = await shops.getShopById(db, req.session.user.shopId).catch(() => null);
      const message = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 5MB.' : 'Upload failed.';
      return res.render('shop-settings', { shop, error: message });
    }

    const tagline = (req.body.tagline || '').trim() || null;

    try {
      let coverPhotoUrl = null;
      if (req.file) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(req.file.mimetype)) {
          const shop = await shops.getShopById(db, req.session.user.shopId);
          return res.render('shop-settings', { shop, error: 'Please upload a JPG, PNG, or WEBP image.' });
        }
        const ext = req.file.mimetype.split('/')[1];
        const key = `shops/${req.session.user.shopId}/cover-${Date.now()}.${ext}`;
        coverPhotoUrl = await storage.uploadImage(req.file.buffer, key, req.file.mimetype);
      }
      const updated = await shops.updateShopProfile(db, req.session.user.shopId, { tagline, coverPhotoUrl });
      res.render('shop-settings', { shop: updated, error: null, saved: true });
    } catch (err) {
      next(err);
    }
  });
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: all 6 tests in `shop-settings.test.js` pass, and the full suite still passes.

- [ ] **Step 7: Commit**

```bash
git add views/shop-settings.ejs views/dashboard.ejs views/menu-edit.ejs views/pos.ejs server.js package.json package-lock.json test/routes/shop-settings.test.js
git commit -m "feat: add owner shop settings page (tagline + cover photo upload)"
```

---

## Task 5: Customer browse feed

**Files:**
- Modify: `views/welcome.ejs` (full rewrite — static placeholder becomes a card feed)
- Modify: `server.js` (rewrite `GET /welcome`)
- Test: `test/routes/welcome.test.js`

**Interfaces:**
- Consumes: `models/shops.js` (`getAllShops`).

- [ ] **Step 1: Write the failing tests**

```js
// test/routes/welcome.test.js
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

async function loggedInCustomer(app) {
  const agent = request.agent(app);
  await agent.post('/signup').type('form').send({ name: 'Sam Rivera', email: 'sam@example.com', password: 'hunter2' });
  return agent;
}

test('GET /welcome shows every shop on the platform', async () => {
  const app = require('../../server');
  await request(app).post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex A', email: 'alex@a.test', password: 'hunter2',
  });
  await request(app).post('/shops/new').type('form').send({
    shopName: 'Ritual', slug: 'ritual', ownerName: 'Robin B', email: 'robin@b.test', password: 'hunter2',
  });

  const agent = await loggedInCustomer(app);
  const res = await agent.get('/welcome');
  assert.equal(res.status, 200);
  assert.match(res.text, /Blue Bottle/);
  assert.match(res.text, /Ritual/);
});

test('GET /welcome shows a shop with no tagline or photo without breaking', async () => {
  const app = require('../../server');
  await request(app).post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex A', email: 'alex@a.test', password: 'hunter2',
  });

  const agent = await loggedInCustomer(app);
  const res = await agent.get('/welcome');
  assert.equal(res.status, 200);
  assert.match(res.text, /Blue Bottle/);
});

test('GET /welcome links each shop card to its real order page', async () => {
  const app = require('../../server');
  await request(app).post('/shops/new').type('form').send({
    shopName: 'Blue Bottle', slug: 'blue-bottle', ownerName: 'Alex A', email: 'alex@a.test', password: 'hunter2',
  });

  const agent = await loggedInCustomer(app);
  const res = await agent.get('/welcome');
  assert.match(res.text, /href="\/blue-bottle\/order"/);
});

test('GET /welcome shows an empty state when there are no shops yet', async () => {
  const app = require('../../server');
  const agent = await loggedInCustomer(app);
  const res = await agent.get('/welcome');
  assert.equal(res.status, 200);
  assert.match(res.text, /No shops yet/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `/welcome` still renders the static placeholder message, none of the assertions about shop names/links/empty-state match.

- [ ] **Step 3: Rewrite `views/welcome.ejs`**

Replace the entire file:

```html
<!doctype html>
<html>
<head><title>Coffee Shops · Coffee Shop</title><%- include('partials-head') %>
<style>
  .browse-shell { min-height: 100vh; background: var(--parchment); padding: 32px 20px; }
  .browse-header { max-width: 640px; margin: 0 auto 24px; display: flex; align-items: center; justify-content: space-between; }
  .browse-header .mark { display: flex; align-items: center; gap: 9px; color: var(--ink); }
  .browse-header .mark svg { width: 24px; height: 24px; color: var(--gold-deep); }
  .browse-header .mark span { font-family: var(--font-display); font-size: 18px; font-weight: 600; }
  .browse-header a { color: var(--ink-soft); font-size: 13px; text-decoration: none; }
  .shop-feed { max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
  .shop-card {
    display: block; background: #fff; border: 1px solid var(--line); border-radius: 14px;
    overflow: hidden; text-decoration: none; color: inherit;
    opacity: 0; animation: rise 0.35s ease forwards;
  }
  .shop-card:nth-child(1) { animation-delay: 0.02s; }
  .shop-card:nth-child(2) { animation-delay: 0.06s; }
  .shop-card:nth-child(3) { animation-delay: 0.10s; }
  .shop-card:nth-child(4) { animation-delay: 0.14s; }
  .shop-card:hover { border-color: var(--gold); }
  .shop-card-photo { width: 100%; height: 160px; background: var(--parchment-2); display: flex; align-items: center; justify-content: center; color: var(--cherry); }
  .shop-card-photo img { width: 100%; height: 100%; object-fit: cover; }
  .shop-card-body { padding: 16px 18px; }
  .shop-card-name { font-family: var(--font-display); font-weight: 600; font-size: 17px; }
  .shop-card-tagline { color: var(--ink-soft); font-size: 13.5px; margin-top: 4px; }
  .empty-state { padding: 60px 20px; text-align: center; color: var(--ink-soft); }
  .empty-state h3 { font-size: 18px; color: var(--ink); margin-bottom: 6px; }
</style>
</head>
<body>
  <div class="browse-shell">
    <div class="browse-header">
      <div class="mark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 8h13a3 3 0 0 1 0 6h-1"/><path d="M4 8v7a4 4 0 0 0 4 4h5a4 4 0 0 0 4-4V8"/><path d="M8 2.5c0 1-1 1.2-1 2.2s1 1.2 1 2.2M12.5 2.5c0 1-1 1.2-1 2.2s1 1.2 1 2.2"/></svg>
        <span>Coffee Shops</span>
      </div>
      <a href="/logout">Log out</a>
    </div>
    <% if (shops.length === 0) { %>
      <div class="empty-state">
        <h3>No shops yet</h3>
        <p>Check back soon — new coffee shops are joining all the time.</p>
      </div>
    <% } else { %>
      <div class="shop-feed">
        <% shops.forEach(shop => { %>
          <a class="shop-card" href="/<%= shop.slug %>/order">
            <div class="shop-card-photo">
              <% if (shop.cover_photo_url) { %>
                <img src="<%= shop.cover_photo_url %>" alt="">
              <% } else { %>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" width="36" height="36"><path d="M4 8h13a3 3 0 0 1 0 6h-1"/><path d="M4 8v7a4 4 0 0 0 4 4h5a4 4 0 0 0 4-4V8"/></svg>
              <% } %>
            </div>
            <div class="shop-card-body">
              <div class="shop-card-name"><%= shop.name %></div>
              <% if (shop.tagline) { %><div class="shop-card-tagline"><%= shop.tagline %></div><% } %>
            </div>
          </a>
        <% }) %>
      </div>
    <% } %>
  </div>
</body>
</html>
```

- [ ] **Step 4: Rewrite `GET /welcome` in `server.js`**

Find:

```js
app.get('/welcome', requireAuth, requireRole('customer'), (req, res) => {
  res.render('welcome');
});
```

Replace with:

```js
app.get('/welcome', requireAuth, requireRole('customer'), async (req, res, next) => {
  try {
    const allShops = await shops.getAllShops(db);
    res.render('welcome', { shops: allShops });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: all 4 tests in `welcome.test.js` pass, and the FULL suite (all tasks of this sub-project plus everything before it) passes with 0 failures.

- [ ] **Step 6: Commit**

```bash
git add views/welcome.ejs server.js test/routes/welcome.test.js
git commit -m "feat: replace welcome placeholder with a real shop browse feed"
```

---

## Final check

After Task 5, run the full suite one more time and confirm nothing regressed:

Run: `npm test`
Expected: every test file passes, 0 failures.

Then smoke-test manually: `npm start`, log in as an owner, visit `/shop/settings`, set a tagline and upload a real image, confirm it displays. Then sign up/log in as a customer, visit `/welcome`, confirm the shop appears with its photo and tagline, and tapping it lands on that shop's real order page.
