async function createOrder(queryable, { userId, shopId, items, total }) {
  const result = await queryable.query(
    'INSERT INTO orders (user_id, shop_id, items_json, total) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
    [userId, shopId, JSON.stringify(items), total]
  );
  return result.rows[0];
}

async function getOrdersForShop(queryable, shopId) {
  const result = await queryable.query(
    `SELECT orders.id, orders.items_json, orders.total::float8 AS total, orders.status, orders.created_at,
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
