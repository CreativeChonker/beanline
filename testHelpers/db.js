const fs = require('fs');
const path = require('path');
const db = require('../db');

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  await db.query(schema);
}

async function resetDb() {
  await db.query('TRUNCATE orders, users, shops RESTART IDENTITY CASCADE');
}

module.exports = { db, migrate, resetDb };
