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
