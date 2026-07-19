const fs = require('fs');
const path = require('path');
const db = require('../db');

async function assertTestDatabase() {
  const result = await db.query('SELECT current_database() AS name');
  const name = result.rows[0].name;
  if (!name.includes('test')) {
    throw new Error(
      `Refusing to run tests against non-test database "${name}". ` +
      'Run tests via "npm test" so testHelpers/setup.js points DATABASE_URL at TEST_DATABASE_URL.'
    );
  }
}

async function migrate() {
  await assertTestDatabase();
  const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  await db.query(schema);
}

async function resetDb() {
  await assertTestDatabase();
  await db.query('TRUNCATE orders, users, shops RESTART IDENTITY CASCADE');
}

module.exports = { db, migrate, resetDb };
