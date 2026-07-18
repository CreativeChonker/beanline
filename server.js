require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./db');
const menu = require('./menu');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(express.urlencoded({ extended: true }));
const pgSession = require('connect-pg-simple')(session);

app.use(
  session({
    store: new pgSession({ pool: db.pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 },
  })
);

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.status(403).send('Forbidden: this page requires a ' + role + ' account.');
    }
    next();
  };
}

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role === 'staff') return res.redirect('/dashboard');
  return res.redirect('/order');
});

// --- Auth ---

app.get('/signup', (req, res) => {
  res.render('signup', { error: null });
});

app.post('/signup', (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !['customer', 'staff'].includes(role)) {
    return res.render('signup', { error: 'Please fill out all fields.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.render('signup', { error: 'An account with that email already exists.' });
  }
  const password_hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email, password_hash, role);
  req.session.user = { id: info.lastInsertRowid, name, email, role };
  res.redirect(role === 'staff' ? '/dashboard' : '/order');
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: 'Invalid email or password.' });
  }
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.redirect(user.role === 'staff' ? '/dashboard' : '/order');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// --- Customer ordering ---

app.get('/order', requireAuth, requireRole('customer'), (req, res) => {
  res.render('order', { menu, error: null });
});

app.post('/order', requireAuth, requireRole('customer'), async (req, res) => {
  const items = [];
  let total = 0;
  for (const item of menu) {
    const qty = parseInt(req.body['qty_' + item.id], 10) || 0;
    if (qty > 0) {
      items.push({ name: item.name, qty, price: item.price });
      total += qty * item.price;
    }
  }

  if (items.length === 0) {
    return res.render('order', { menu, error: 'Please select at least one item.' });
  }

  const itemsSummary = items.map((i) => `${i.name} x${i.qty}`).join(', ');
  const info = db
    .prepare('INSERT INTO orders (user_id, items_json, total) VALUES (?, ?, ?)')
    .run(req.session.user.id, JSON.stringify(items), total);

  const order = {
    order_id: info.lastInsertRowid,
    customer_name: req.session.user.name,
    customer_email: req.session.user.email,
    items: itemsSummary,
    lineItems: items,
    total: total.toFixed(2),
    created_at: new Date().toISOString(),
  };

  try {
    await fetch(process.env.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    });
  } catch (err) {
    console.error('Failed to notify n8n webhook:', err.message);
  }

  res.render('confirmation', { order });
});

// --- Staff dashboard ---

app.get('/dashboard', requireAuth, requireRole('staff'), (req, res) => {
  const orders = db
    .prepare(
      `SELECT orders.id, orders.items_json, orders.total, orders.status, orders.created_at,
              users.name AS customer_name, users.email AS customer_email
       FROM orders
       JOIN users ON users.id = orders.user_id
       ORDER BY orders.created_at DESC`
    )
    .all()
    .map((o) => ({ ...o, items: JSON.parse(o.items_json) }));

  res.render('dashboard', { orders });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Coffee shop app running at http://localhost:${PORT}`);
  });
}

module.exports = app;
