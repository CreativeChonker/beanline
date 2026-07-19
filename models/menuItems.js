const ITEM_COLUMNS = `id, shop_id, name, price::float8 AS price, category, note, available,
  item_type, price_medium::float8 AS price_medium, price_large::float8 AS price_large, sort_order`;

async function createMenuItem(queryable, { shopId, name, price, category, note, itemType = 'drink', priceMedium = null, priceLarge = null }) {
  const result = await queryable.query(
    `INSERT INTO menu_items (shop_id, name, price, category, note, item_type, price_medium, price_large)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${ITEM_COLUMNS}`,
    [shopId, name, price, category, note || '', itemType, priceMedium, priceLarge]
  );
  return result.rows[0];
}

async function getMenuItemsForShop(queryable, shopId, { availableOnly = false } = {}) {
  const query = availableOnly
    ? `SELECT ${ITEM_COLUMNS} FROM menu_items WHERE shop_id = $1 AND available = true ORDER BY category, sort_order, name`
    : `SELECT ${ITEM_COLUMNS} FROM menu_items WHERE shop_id = $1 ORDER BY category, sort_order, name`;
  const result = await queryable.query(query, [shopId]);
  return result.rows;
}

async function getMenuItemById(queryable, shopId, id) {
  const result = await queryable.query(
    `SELECT ${ITEM_COLUMNS} FROM menu_items WHERE id = $1 AND shop_id = $2`,
    [id, shopId]
  );
  return result.rows[0] || null;
}

async function updateMenuItem(queryable, shopId, id, { name, price, category, note, itemType = 'drink', priceMedium = null, priceLarge = null }) {
  const result = await queryable.query(
    `UPDATE menu_items SET name = $1, price = $2, category = $3, note = $4,
       item_type = $5, price_medium = $6, price_large = $7
     WHERE id = $8 AND shop_id = $9
     RETURNING ${ITEM_COLUMNS}`,
    [name, price, category, note || '', itemType, priceMedium, priceLarge, id, shopId]
  );
  return result.rows[0] || null;
}

async function toggleAvailability(queryable, shopId, id) {
  const result = await queryable.query(
    `UPDATE menu_items SET available = NOT available
     WHERE id = $1 AND shop_id = $2
     RETURNING ${ITEM_COLUMNS}`,
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
  for (const { id, category, sortOrder } of items) {
    const result = await queryable.query(
      'UPDATE menu_items SET category = $1, sort_order = $2 WHERE id = $3 AND shop_id = $4',
      [category, sortOrder, id, shopId]
    );
    count += result.rowCount;
  }
  return count;
}

module.exports = { createMenuItem, getMenuItemsForShop, getMenuItemById, updateMenuItem, toggleAvailability, deleteMenuItem, updateLayout };
