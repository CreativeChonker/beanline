async function createOrder(queryable, { userId = null, staffUserId = null, shopId, items, total, status = 'received', paymentMethod = null }) {
  const result = await queryable.query(
    `INSERT INTO orders (user_id, staff_user_id, shop_id, items_json, total, status, payment_method)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [userId, staffUserId, shopId, JSON.stringify(items), total, status, paymentMethod]
  );
  return result.rows[0];
}

async function getOrdersForShop(queryable, shopId) {
  const result = await queryable.query(
    `SELECT orders.id, orders.items_json, orders.total::float8 AS total, orders.status, orders.created_at,
            orders.payment_method,
            customer.name AS customer_name, customer.email AS customer_email,
            staff.name AS staff_name
     FROM orders
     LEFT JOIN users customer ON customer.id = orders.user_id
     LEFT JOIN users staff ON staff.id = orders.staff_user_id
     WHERE orders.shop_id = $1
     ORDER BY orders.created_at DESC`,
    [shopId]
  );
  return result.rows.map((o) => ({ ...o, items: JSON.parse(o.items_json) }));
}

module.exports = { createOrder, getOrdersForShop };
