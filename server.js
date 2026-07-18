require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./db');
const menu = require('./menu');
const shops = require('./models/shops');
const users = require('./models/users');
const orders = require('./models/orders');
const menuItems = require('./models/menuItems');
const seedMenu = require('./db/seed-menu');
const { requireAuth, requireRole, loadShopBySlug } = require('./middleware/auth');

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

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  return res.redirect(req.session.user.role === 'customer' ? '/welcome' : '/dashboard');
});

// --- Auth ---

app.get('/shops/new', (req, res) => {
  res.render('shop-new', { error: null });
});

app.post('/shops/new', async (req, res, next) => {
  const { shopName, slug, ownerName, email, password } = req.body;
  if (!shopName || !slug || !ownerName || !email || !password) {
    return res.render('shop-new', { error: 'Please fill out all fields.' });
  }
  try {
    const result = await db.withTransaction(async (client) => {
      const shop = await shops.createShop(client, { name: shopName, slug });
      const owner = await users.createOwner(client, { name: ownerName, email, password, shopId: shop.id });
      for (const item of seedMenu) {
        await menuItems.createMenuItem(client, { shopId: shop.id, ...item });
      }
      return { shop, owner };
    });
    req.session.user = {
      id: result.owner.id,
      name: result.owner.name,
      email: result.owner.email,
      role: result.owner.role,
      shopId: result.shop.id,
    };
    res.redirect('/dashboard');
  } catch (err) {
    if (err.message === 'INVALID_SLUG') {
      return res.render('shop-new', { error: 'Shop URL can only contain lowercase letters, numbers, and hyphens.' });
    }
    if (err.code === '23505') {
      return res.render('shop-new', { error: 'That shop URL or email is already taken.' });
    }
    next(err);
  }
});

app.get('/signup/staff', (req, res) => {
  res.render('signup-staff', { error: null });
});

app.post('/signup/staff', async (req, res, next) => {
  const { name, email, password, inviteCode } = req.body;
  if (!name || !email || !password || !inviteCode) {
    return res.render('signup-staff', { error: 'Please fill out all fields.' });
  }
  try {
    const shop = await shops.getShopByInviteCode(db, inviteCode);
    if (!shop) {
      return res.render('signup-staff', { error: 'Invalid invite code.' });
    }
    const user = await users.createStaff(db, { name, email, password, shopId: shop.id });
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, shopId: shop.id };
    res.redirect('/dashboard');
  } catch (err) {
    if (err.code === '23505') {
      return res.render('signup-staff', { error: 'An account with that email already exists.' });
    }
    next(err);
  }
});

app.get('/signup', (req, res) => {
  res.render('signup', { error: null });
});

app.post('/signup', async (req, res, next) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.render('signup', { error: 'Please fill out all fields.' });
  }
  try {
    const user = await users.createCustomer(db, { name, email, password });
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, shopId: null };
    res.redirect('/welcome');
  } catch (err) {
    if (err.code === '23505') {
      return res.render('signup', { error: 'An account with that email already exists.' });
    }
    next(err);
  }
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res, next) => {
  const { email, password } = req.body;
  try {
    const user = await users.getUserByEmail(db, email);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.render('login', { error: 'Invalid email or password.' });
    }
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, shopId: user.shop_id };
    return res.redirect(user.role === 'customer' ? '/welcome' : '/dashboard');
  } catch (err) {
    next(err);
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// --- Customer ordering ---

app.get('/welcome', requireAuth, requireRole('customer'), (req, res) => {
  res.render('welcome');
});

app.get('/:shopSlug/order', requireAuth, requireRole('customer'), loadShopBySlug, (req, res) => {
  res.render('order', { menu, error: null, shop: req.shop });
});

app.post('/:shopSlug/order', requireAuth, requireRole('customer'), loadShopBySlug, async (req, res, next) => {
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
    return res.render('order', { menu, error: 'Please select at least one item.', shop: req.shop });
  }

  try {
    const created = await orders.createOrder(db, {
      userId: req.session.user.id,
      shopId: req.shop.id,
      items,
      total,
    });

    const order = {
      order_id: created.id,
      customer_name: req.session.user.name,
      customer_email: req.session.user.email,
      items: items.map((i) => `${i.name} x${i.qty}`).join(', '),
      lineItems: items,
      total: total.toFixed(2),
      created_at: created.created_at,
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

    res.render('confirmation', { order, shop: req.shop });
  } catch (err) {
    next(err);
  }
});

// --- Staff dashboard ---

app.get('/dashboard', requireAuth, requireRole('owner', 'staff'), async (req, res, next) => {
  try {
    const shopOrders = await orders.getOrdersForShop(db, req.session.user.shopId);
    res.render('dashboard', { orders: shopOrders });
  } catch (err) {
    next(err);
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Coffee shop app running at http://localhost:${PORT}`);
  });
}

module.exports = app;
