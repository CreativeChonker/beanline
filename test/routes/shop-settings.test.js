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

test('POST /shop/settings saves POS option toggles', async () => {
  const app = require('../../server');
  const agent = await ownerAgentWithShop(app);
  const res = await agent.post('/shop/settings')
    .field('tagline', 'Cozy')
    .field('posShowSize', 'on')
    .field('posShowNote', 'on');
  assert.equal(res.status, 200);

  const row = await db.query('SELECT pos_show_size, pos_show_sugar, pos_show_temp, pos_show_note FROM shops WHERE slug = $1', ['blue-bottle']);
  assert.deepEqual(row.rows[0], {
    pos_show_size: true, pos_show_sugar: false, pos_show_temp: false, pos_show_note: true,
  });
});

test('GET /shop/settings renders the POS option checkboxes', async () => {
  const app = require('../../server');
  const agent = await ownerAgentWithShop(app);
  const res = await agent.get('/shop/settings');
  assert.match(res.text, /name="posShowSize"/);
  assert.match(res.text, /name="posShowSugar"/);
  assert.match(res.text, /name="posShowTemp"/);
  assert.match(res.text, /name="posShowNote"/);
});
