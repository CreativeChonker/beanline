// models/categories.js
const CATEGORY_COLUMNS = 'id, shop_id, name, display_order, archived, show_when_empty, tier_names, drink_options';

async function getCategoriesForShop(queryable, shopId, { includeArchived = true } = {}) {
  const where = includeArchived ? '' : 'AND archived = false';
  const result = await queryable.query(
    `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE shop_id = $1 ${where} ORDER BY display_order, name`,
    [shopId]
  );
  return result.rows;
}

async function getCategoryById(queryable, shopId, id) {
  const result = await queryable.query(
    `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE id = $1 AND shop_id = $2`,
    [id, shopId]
  );
  return result.rows[0] || null;
}

async function createCategory(queryable, { shopId, name, tierNames = ['Price'], drinkOptions = false, displayOrder = null, showWhenEmpty = false }) {
  const result = await queryable.query(
    `INSERT INTO categories (shop_id, name, tier_names, drink_options, show_when_empty, display_order)
     VALUES ($1, $2, $3, $4, $5,
       COALESCE($6, (SELECT COALESCE(MAX(display_order), -1) + 1 FROM categories WHERE shop_id = $1)))
     RETURNING ${CATEGORY_COLUMNS}`,
    [shopId, name, tierNames, drinkOptions, showWhenEmpty, displayOrder]
  );
  return result.rows[0];
}

async function updateCategory(queryable, shopId, id, { name, tierNames, drinkOptions, showWhenEmpty, archived, displayOrder }) {
  const result = await queryable.query(
    `UPDATE categories SET name = $1, tier_names = $2, drink_options = $3,
       show_when_empty = $4, archived = $5, display_order = $6
     WHERE id = $7 AND shop_id = $8 RETURNING ${CATEGORY_COLUMNS}`,
    [name, tierNames, drinkOptions, showWhenEmpty, archived, displayOrder, id, shopId]
  );
  return result.rows[0] || null;
}

// Delete only when no items reference it; returns false otherwise.
async function deleteCategory(queryable, shopId, id) {
  const inUse = await queryable.query('SELECT 1 FROM menu_items WHERE category_id = $1 LIMIT 1', [id]);
  if (inUse.rows.length > 0) return false;
  const result = await queryable.query('DELETE FROM categories WHERE id = $1 AND shop_id = $2 RETURNING id', [id, shopId]);
  return result.rows.length > 0;
}

async function updateDisplayOrder(queryable, shopId, orderedIds) {
  let count = 0;
  for (let i = 0; i < orderedIds.length; i++) {
    const result = await queryable.query(
      'UPDATE categories SET display_order = $1 WHERE id = $2 AND shop_id = $3',
      [i, orderedIds[i], shopId]
    );
    count += result.rowCount;
  }
  return count;
}

module.exports = { getCategoriesForShop, getCategoryById, createCategory, updateCategory, deleteCategory, updateDisplayOrder };
