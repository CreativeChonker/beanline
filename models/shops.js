// models/shops.js
const crypto = require('crypto');

const SLUG_RE = /^[a-z0-9-]+$/;

const SHOP_COLUMNS = `id, name, slug, tagline, cover_photo_url,
  pos_show_size, pos_show_sugar, pos_show_temp, pos_show_note, category_order`;

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

async function getShopById(queryable, id) {
  const result = await queryable.query(
    `SELECT ${SHOP_COLUMNS} FROM shops WHERE id = $1`,
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

async function updatePosOptions(queryable, id, { showSize, showSugar, showTemp, showNote }) {
  const result = await queryable.query(
    `UPDATE shops SET pos_show_size = $1, pos_show_sugar = $2, pos_show_temp = $3, pos_show_note = $4
     WHERE id = $5 RETURNING ${SHOP_COLUMNS}`,
    [showSize, showSugar, showTemp, showNote, id]
  );
  return result.rows[0] || null;
}

async function updateCategoryOrder(queryable, id, categories) {
  const result = await queryable.query(
    `UPDATE shops SET category_order = $1 WHERE id = $2 RETURNING ${SHOP_COLUMNS}`,
    [categories, id]
  );
  return result.rows[0] || null;
}

module.exports = { createShop, getShopBySlug, getShopByInviteCode, getShopById, updateShopProfile, getAllShops, updatePosOptions, updateCategoryOrder, SLUG_RE };
