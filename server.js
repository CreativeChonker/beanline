require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./db');
const shops = require('./models/shops');
const users = require('./models/users');
const orders = require('./models/orders');
const menuItems = require('./models/menuItems');
const seedMenu = require('./db/seed-menu');
const { requireAuth, requireRole, loadShopBySlug } = require('./middleware/auth');
const multer = require('multer');
const storage = require('./lib/storage');
const posLines = require('./lib/posLines');
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
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

app.get('/welcome', requireAuth, requireRole('customer'), async (req, res, next) => {
  try {
    const allShops = await shops.getAllShops(db);
    res.render('welcome', { shops: allShops });
  } catch (err) {
    next(err);
  }
});

app.get('/:shopSlug/order', requireAuth, requireRole('customer'), loadShopBySlug, async (req, res, next) => {
  try {
    const items = await menuItems.getMenuItemsForShop(db, req.shop.id, { availableOnly: true });
    res.render('order', { menu: items, error: null, shop: req.shop });
  } catch (err) {
    next(err);
  }
});

app.post('/:shopSlug/order', requireAuth, requireRole('customer'), loadShopBySlug, async (req, res, next) => {
  try {
    const availableItems = await menuItems.getMenuItemsForShop(db, req.shop.id, { availableOnly: true });
    const items = [];
    let total = 0;
    for (const item of availableItems) {
      const qty = parseInt(req.body['qty_' + item.id], 10) || 0;
      if (qty > 0) {
        items.push({ name: item.name, qty, price: item.price });
        total += qty * item.price;
      }
    }

    if (items.length === 0) {
      return res.render('order', { menu: availableItems, error: 'Please select at least one item.', shop: req.shop });
    }

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

    if (process.env.N8N_WEBHOOK_URL) {
      try {
        await fetch(process.env.N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(order),
        });
      } catch (err) {
        console.error('Failed to notify n8n webhook:', err.message);
      }
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
    res.render('dashboard', { orders: shopOrders, formatLine: posLines.formatLineDetails });
  } catch (err) {
    next(err);
  }
});

app.get('/pos', requireAuth, requireRole('owner', 'staff'), async (req, res, next) => {
  try {
    const [items, shop] = await Promise.all([
      menuItems.getMenuItemsForShop(db, req.session.user.shopId, { availableOnly: true }),
      shops.getShopById(db, req.session.user.shopId),
    ]);
    res.render('pos', { menu: items, shop, error: null, formatLine: posLines.formatLineDetails });
  } catch (err) {
    next(err);
  }
});

app.post('/pos', requireAuth, requireRole('owner', 'staff'), async (req, res, next) => {
  const { paymentMethod } = req.body;
  try {
    const [availableItems, shop] = await Promise.all([
      menuItems.getMenuItemsForShop(db, req.session.user.shopId, { availableOnly: true }),
      shops.getShopById(db, req.session.user.shopId),
    ]);
    const rerender = (error) => res.render('pos', { menu: availableItems, shop, error, formatLine: posLines.formatLineDetails });

    const parsed = posLines.parseAndPriceLines(req.body.lines || '', availableItems);
    if (parsed.error) return rerender(parsed.error);
    if (!['cash', 'card'].includes(paymentMethod)) return rerender('Please choose a payment method.');

    const created = await orders.createOrder(db, {
      staffUserId: req.session.user.id,
      shopId: req.session.user.shopId,
      items: parsed.lines,
      total: parsed.total,
      status: 'completed',
      paymentMethod,
    });

    res.render('pos-receipt', {
      sale: {
        order_id: created.id,
        staff_name: req.session.user.name,
        lineItems: parsed.lines,
        total: parsed.total.toFixed(2),
        payment_method: paymentMethod,
        created_at: created.created_at,
      },
      formatLine: posLines.formatLineDetails,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/pos/layout', requireAuth, requireRole('owner'), async (req, res, next) => {
  const { categoryOrder, items } = req.body;
  if (!Array.isArray(categoryOrder) || !Array.isArray(items)
      || !categoryOrder.every((c) => typeof c === 'string')
      || !items.every((i) => i && Number.isInteger(Number(i.id)) && typeof i.category === 'string' && Number.isInteger(Number(i.sortOrder)))) {
    return res.status(400).send('Invalid layout.');
  }
  try {
    await menuItems.updateLayout(db, req.session.user.shopId, items.map((i) => ({
      id: Number(i.id), category: i.category, sortOrder: Number(i.sortOrder),
    })));
    await shops.updateCategoryOrder(db, req.session.user.shopId, categoryOrder);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- Owner menu editor ---

app.get('/menu', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const items = await menuItems.getMenuItemsForShop(db, req.session.user.shopId);
    res.render('menu-edit', { items, error: null });
  } catch (err) {
    next(err);
  }
});

app.post('/menu', requireAuth, requireRole('owner'), async (req, res, next) => {
  const { name, category, price, note, itemType, priceMedium, priceLarge } = req.body;
  const parsedPrice = parseFloat(price);
  const type = itemType === 'food' ? 'food' : 'drink';
  const parseSize = (v) => {
    if (v === undefined || v === '') return null;
    const n = parseFloat(v);
    return Number.isNaN(n) || n <= 0 ? undefined : n;
  };
  const parsedMedium = parseSize(priceMedium);
  const parsedLarge = parseSize(priceLarge);
  if (!name || !category || !price || Number.isNaN(parsedPrice) || parsedPrice <= 0
      || parsedMedium === undefined || parsedLarge === undefined) {
    const items = await menuItems.getMenuItemsForShop(db, req.session.user.shopId);
    return res.render('menu-edit', { items, error: 'Please provide a name, category, and a valid price.' });
  }
  try {
    await menuItems.createMenuItem(db, { shopId: req.session.user.shopId, name, category, price: parsedPrice, note: note || '', itemType: type, priceMedium: parsedMedium, priceLarge: parsedLarge });
    res.redirect('/menu');
  } catch (err) {
    next(err);
  }
});

app.get('/menu/:id/edit', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const item = await menuItems.getMenuItemById(db, req.session.user.shopId, req.params.id);
    if (!item) return res.status(404).send('Item not found.');
    res.render('menu-item-edit', { item, error: null });
  } catch (err) {
    next(err);
  }
});

app.post('/menu/:id', requireAuth, requireRole('owner'), async (req, res, next) => {
  const { name, category, price, note, itemType, priceMedium, priceLarge } = req.body;
  const parsedPrice = parseFloat(price);
  const type = itemType === 'food' ? 'food' : 'drink';
  const parseSize = (v) => {
    if (v === undefined || v === '') return null;
    const n = parseFloat(v);
    return Number.isNaN(n) || n <= 0 ? undefined : n;
  };
  const parsedMedium = parseSize(priceMedium);
  const parsedLarge = parseSize(priceLarge);
  if (!name || !category || !price || Number.isNaN(parsedPrice) || parsedPrice <= 0
      || parsedMedium === undefined || parsedLarge === undefined) {
    const item = await menuItems.getMenuItemById(db, req.session.user.shopId, req.params.id);
    if (!item) return res.status(404).send('Item not found.');
    return res.render('menu-item-edit', { item, error: 'Please provide a name, category, and a valid price.' });
  }
  try {
    const updated = await menuItems.updateMenuItem(db, req.session.user.shopId, req.params.id, { name, category, price: parsedPrice, note: note || '', itemType: type, priceMedium: parsedMedium, priceLarge: parsedLarge });
    if (!updated) return res.status(404).send('Item not found.');
    res.redirect('/menu');
  } catch (err) {
    next(err);
  }
});

app.post('/menu/:id/toggle', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const updated = await menuItems.toggleAvailability(db, req.session.user.shopId, req.params.id);
    if (!updated) return res.status(404).send('Item not found.');
    res.redirect('/menu');
  } catch (err) {
    next(err);
  }
});

app.post('/menu/:id/delete', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const deleted = await menuItems.deleteMenuItem(db, req.session.user.shopId, req.params.id);
    if (!deleted) return res.status(404).send('Item not found.');
    res.redirect('/menu');
  } catch (err) {
    next(err);
  }
});

app.get('/shop/settings', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const shop = await shops.getShopById(db, req.session.user.shopId);
    res.render('shop-settings', { shop, error: null });
  } catch (err) {
    next(err);
  }
});

app.post('/shop/settings', requireAuth, requireRole('owner'), (req, res, next) => {
  upload.single('coverPhoto')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const shop = await shops.getShopById(db, req.session.user.shopId).catch(() => null);
      const message = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 5MB.' : 'Upload failed.';
      return res.render('shop-settings', { shop, error: message });
    }

    const tagline = (req.body.tagline || '').trim() || null;

    try {
      let coverPhotoUrl = null;
      if (req.file) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(req.file.mimetype)) {
          const shop = await shops.getShopById(db, req.session.user.shopId);
          return res.render('shop-settings', { shop, error: 'Please upload a JPG, PNG, or WEBP image.' });
        }
        const ext = req.file.mimetype.split('/')[1];
        const key = `shops/${req.session.user.shopId}/cover-${Date.now()}.${ext}`;
        coverPhotoUrl = await storage.uploadImage(req.file.buffer, key, req.file.mimetype);
      }
      const updated = await shops.updateShopProfile(db, req.session.user.shopId, { tagline, coverPhotoUrl });
      const withOptions = await shops.updatePosOptions(db, req.session.user.shopId, {
        showSize: req.body.posShowSize === 'on',
        showSugar: req.body.posShowSugar === 'on',
        showTemp: req.body.posShowTemp === 'on',
        showNote: req.body.posShowNote === 'on',
      });
      res.render('shop-settings', { shop: withOptions, error: null, saved: true });
    } catch (err) {
      next(err);
    }
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Beanline running at http://localhost:${PORT}`);
  });
}

module.exports = app;
