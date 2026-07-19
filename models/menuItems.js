const ITEM_COLUMNS = `m.id, m.shop_id, m.name, m.price::float8 AS price, m.note, m.available,
  m.price_medium::float8 AS price_medium, m.price_large::float8 AS price_large, m.sort_order, m.image_url,
  m.category_id, c.name AS category, c.tier_names, c.drink_options, c.archived AS category_archived`;
const ITEM_JOIN = 'FROM menu_items m JOIN categories c ON c.id = m.category_id';

async function createMenuItem(queryable, { shopId, name, price, categoryId, note, priceMedium = null, priceLarge = null, imageUrl = null }) {
  const result = await queryable.query(
    `WITH inserted AS (
       INSERT INTO menu_items (shop_id, name, price, category_id, note, price_medium, price_large, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *
     ) SELECT ${ITEM_COLUMNS} FROM inserted m JOIN categories c ON c.id = m.category_id`,
    [shopId, name, price, categoryId, note || '', priceMedium, priceLarge, imageUrl]
  );
  return result.rows[0];
}

async function getMenuItemsForShop(queryable, shopId, { availableOnly = false } = {}) {
  const where = availableOnly ? 'AND m.available = true AND c.archived = false' : '';
  const result = await queryable.query(
    `SELECT ${ITEM_COLUMNS} ${ITEM_JOIN}
     WHERE m.shop_id = $1 ${where}
     ORDER BY c.display_order, c.name, m.sort_order, m.name`,
    [shopId]
  );
  return result.rows;
}

async function getMenuItemById(queryable, shopId, id) {
  const result = await queryable.query(
    `SELECT ${ITEM_COLUMNS} ${ITEM_JOIN} WHERE m.id = $1 AND m.shop_id = $2`,
    [id, shopId]
  );
  return result.rows[0] || null;
}

async function updateMenuItem(queryable, shopId, id, { name, price, categoryId, note, priceMedium = null, priceLarge = null }) {
  const result = await queryable.query(
    `WITH updated AS (
       UPDATE menu_items SET name = $1, price = $2, category_id = $3, note = $4,
         price_medium = $5, price_large = $6
       WHERE id = $7 AND shop_id = $8
       RETURNING *
     ) SELECT ${ITEM_COLUMNS} FROM updated m JOIN categories c ON c.id = m.category_id`,
    [name, price, categoryId, note || '', priceMedium, priceLarge, id, shopId]
  );
  return result.rows[0] || null;
}

async function toggleAvailability(queryable, shopId, id) {
  const result = await queryable.query(
    `WITH updated AS (
       UPDATE menu_items SET available = NOT available
       WHERE id = $1 AND shop_id = $2 RETURNING *
     ) SELECT ${ITEM_COLUMNS} FROM updated m JOIN categories c ON c.id = m.category_id`,
    [id, shopId]
  );
  return result.rows[0] || null;
}

async function deleteMenuItem(queryable, shopId, id) {
  const result = await queryable.query(
    'DELETE FROM menu_items WHERE id = $1 AND shop_id = $2 RETURNING id',
    [id, shopId]
  );
  return result.rows.length > 0;
}

async function updateLayout(queryable, shopId, items) {
  let count = 0;
  for (const { id, categoryId, sortOrder } of items) {
    const result = await queryable.query(
      `UPDATE menu_items SET category_id = $1, sort_order = $2
       WHERE id = $3 AND shop_id = $4
         AND EXISTS (SELECT 1 FROM categories WHERE id = $1 AND shop_id = $4)`,
      [categoryId, sortOrder, id, shopId]
    );
    count += result.rowCount;
  }
  return count;
}

async function setItemImage(queryable, shopId, id, imageUrl) {
  const result = await queryable.query(
    `WITH updated AS (
       UPDATE menu_items SET image_url = $1 WHERE id = $2 AND shop_id = $3 RETURNING *
     ) SELECT ${ITEM_COLUMNS} FROM updated m JOIN categories c ON c.id = m.category_id`,
    [imageUrl, id, shopId]
  );
  return result.rows[0] || null;
}

module.exports = { createMenuItem, getMenuItemsForShop, getMenuItemById, updateMenuItem, toggleAvailability, deleteMenuItem, updateLayout, setItemImage };
