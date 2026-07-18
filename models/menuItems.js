async function createMenuItem(queryable, { shopId, name, price, category, note }) {
  const result = await queryable.query(
    `INSERT INTO menu_items (shop_id, name, price, category, note)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, shop_id, name, price::float8 AS price, category, note, available`,
    [shopId, name, price, category, note || '']
  );
  return result.rows[0];
}

async function getMenuItemsForShop(queryable, shopId, { availableOnly = false } = {}) {
  const query = availableOnly
    ? `SELECT id, shop_id, name, price::float8 AS price, category, note, available
       FROM menu_items WHERE shop_id = $1 AND available = true ORDER BY category, name`
    : `SELECT id, shop_id, name, price::float8 AS price, category, note, available
       FROM menu_items WHERE shop_id = $1 ORDER BY category, name`;
  const result = await queryable.query(query, [shopId]);
  return result.rows;
}

async function getMenuItemById(queryable, shopId, id) {
  const result = await queryable.query(
    `SELECT id, shop_id, name, price::float8 AS price, category, note, available
     FROM menu_items WHERE id = $1 AND shop_id = $2`,
    [id, shopId]
  );
  return result.rows[0] || null;
}

async function updateMenuItem(queryable, shopId, id, { name, price, category, note }) {
  const result = await queryable.query(
    `UPDATE menu_items SET name = $1, price = $2, category = $3, note = $4
     WHERE id = $5 AND shop_id = $6
     RETURNING id, shop_id, name, price::float8 AS price, category, note, available`,
    [name, price, category, note || '', id, shopId]
  );
  return result.rows[0] || null;
}

async function toggleAvailability(queryable, shopId, id) {
  const result = await queryable.query(
    `UPDATE menu_items SET available = NOT available
     WHERE id = $1 AND shop_id = $2
     RETURNING id, shop_id, name, price::float8 AS price, category, note, available`,
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

module.exports = { createMenuItem, getMenuItemsForShop, getMenuItemById, updateMenuItem, toggleAvailability, deleteMenuItem };
